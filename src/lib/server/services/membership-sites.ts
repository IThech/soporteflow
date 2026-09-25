import { and, asc, eq, sql } from 'drizzle-orm';
import { memberships, membershipSites, organizations, sites } from '../db/schema';
import { IncidentServiceError, lockActiveSite, type IncidentDatabase } from './incidents';

/**
 * Operational site membership ("this membership normally works at this site").
 * It is descriptive only: it NEVER feeds authorizeAction, role_assignments, queues, routing or
 * incident visibility. "All sites" is organization-level authorization, not one row per site.
 */
export interface MembershipSiteRecord {
	siteId: string;
	siteName: string;
	/** Current state of the site itself; an association can outlive a deactivated site. */
	siteActive: boolean;
	/** State of the association. */
	active: boolean;
	createdAt: Date;
	updatedAt: Date;
}

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateIds(ids: Record<string, unknown>): void {
	for (const [name, value] of Object.entries(ids)) {
		if (typeof value !== 'string' || !uuidRegex.test(value)) {
			throw new IncidentServiceError('INVALID_INPUT', `${name} must be a valid UUID`);
		}
	}
}

async function assertOperationalOrganization(
	tx: IncidentDatabase,
	organizationId: string
): Promise<void> {
	const [org] = await tx
		.select({ status: organizations.status })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	if (!org) {
		throw new IncidentServiceError('ORGANIZATION_NOT_FOUND', 'Organization does not exist');
	}
	if (org.status !== 'active') {
		throw new IncidentServiceError(
			'ORGANIZATION_NOT_OPERATIONAL',
			`Organization is not operational (status: '${org.status}')`
		);
	}
}

/** Tenant-scoped membership lookup; cross-tenant and missing memberships are indistinguishable. */
async function findMembership(
	tx: IncidentDatabase,
	organizationId: string,
	membershipId: string,
	lock: boolean
): Promise<{ active: boolean }> {
	const query = tx
		.select({ active: memberships.active })
		.from(memberships)
		.where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)))
		.limit(1);
	const [membership] = await (lock ? query.for('share') : query);
	if (!membership) {
		throw new IncidentServiceError('MEMBERSHIP_NOT_FOUND', 'Membership not found');
	}
	return membership;
}

async function readAssociation(
	tx: IncidentDatabase,
	organizationId: string,
	membershipId: string,
	siteId: string
): Promise<MembershipSiteRecord> {
	const [row] = await tx
		.select({
			siteId: membershipSites.siteId,
			siteName: sites.name,
			siteActive: sites.active,
			active: membershipSites.active,
			createdAt: membershipSites.createdAt,
			updatedAt: membershipSites.updatedAt
		})
		.from(membershipSites)
		.innerJoin(
			sites,
			and(
				eq(sites.id, membershipSites.siteId),
				eq(sites.organizationId, membershipSites.organizationId)
			)
		)
		.where(
			and(
				eq(membershipSites.organizationId, organizationId),
				eq(membershipSites.membershipId, membershipId),
				eq(membershipSites.siteId, siteId)
			)
		)
		.limit(1);
	if (!row) {
		throw new IncidentServiceError('MEMBERSHIP_SITE_NOT_FOUND', 'Membership site not found');
	}
	return row;
}

async function inTransaction<T>(
	dbOrTx: IncidentDatabase,
	execute: (tx: IncidentDatabase) => Promise<T>
): Promise<T> {
	if ('transaction' in dbOrTx && typeof dbOrTx.transaction === 'function') {
		return await dbOrTx.transaction(async (tx) => execute(tx));
	}
	return await execute(dbOrTx);
}

/**
 * Lists the site associations of a membership (active and inactive, for administration).
 * Pass { activeOnly: true } to keep only active associations to active sites.
 * Deterministic ordering: site name ASC, site id ASC.
 */
export async function listMembershipSites(
	db: IncidentDatabase,
	organizationId: string,
	membershipId: string,
	options: { activeOnly?: boolean } = {}
): Promise<MembershipSiteRecord[]> {
	validateIds({ organizationId, membershipId });
	await findMembership(db, organizationId, membershipId, false);
	const conditions = [
		eq(membershipSites.organizationId, organizationId),
		eq(membershipSites.membershipId, membershipId)
	];
	if (options.activeOnly === true) {
		conditions.push(eq(membershipSites.active, true), eq(sites.active, true));
	}
	return db
		.select({
			siteId: membershipSites.siteId,
			siteName: sites.name,
			siteActive: sites.active,
			active: membershipSites.active,
			createdAt: membershipSites.createdAt,
			updatedAt: membershipSites.updatedAt
		})
		.from(membershipSites)
		.innerJoin(
			sites,
			and(
				eq(sites.id, membershipSites.siteId),
				eq(sites.organizationId, membershipSites.organizationId)
			)
		)
		.where(and(...conditions))
		.orderBy(asc(sites.name), asc(membershipSites.siteId));
}

/**
 * Associates a membership with a site, or reactivates an existing inactive association.
 * Idempotent for an already active association (the row, including updatedAt, is unchanged).
 * Requires an operational organization, an active membership and an active site of the same
 * tenant. The site is locked FOR SHARE (see lockActiveSite) so it cannot be deactivated
 * concurrently; the atomic upsert on (membership_id, site_id) makes concurrent calls safe.
 */
export async function assignMembershipSite(
	dbOrTx: IncidentDatabase,
	organizationId: string,
	membershipId: string,
	siteId: string
): Promise<MembershipSiteRecord> {
	validateIds({ organizationId, membershipId, siteId });
	return inTransaction(dbOrTx, async (tx) => {
		await assertOperationalOrganization(tx, organizationId);
		const membership = await findMembership(tx, organizationId, membershipId, true);
		if (!membership.active) {
			throw new IncidentServiceError('MEMBERSHIP_INACTIVE', 'Membership is inactive');
		}
		await lockActiveSite(tx, organizationId, siteId);
		await tx
			.insert(membershipSites)
			.values({ organizationId, membershipId, siteId, active: true })
			.onConflictDoUpdate({
				target: [membershipSites.membershipId, membershipSites.siteId],
				set: {
					active: true,
					updatedAt: sql`CASE WHEN ${membershipSites.active} THEN ${membershipSites.updatedAt} ELSE now() END`
				}
			});
		return readAssociation(tx, organizationId, membershipId, siteId);
	});
}

/**
 * Activates or deactivates an existing association. Deactivation never deletes and is allowed
 * even if the site or membership became inactive; reactivation follows the same rules as
 * assignMembershipSite (active membership and active site).
 */
export async function setMembershipSiteActive(
	dbOrTx: IncidentDatabase,
	organizationId: string,
	membershipId: string,
	siteId: string,
	active: boolean
): Promise<MembershipSiteRecord> {
	validateIds({ organizationId, membershipId, siteId });
	if (typeof active !== 'boolean') {
		throw new IncidentServiceError('INVALID_INPUT', 'active must be a boolean');
	}
	return inTransaction(dbOrTx, async (tx) => {
		await assertOperationalOrganization(tx, organizationId);
		const membership = await findMembership(tx, organizationId, membershipId, true);
		if (active) {
			if (!membership.active) {
				throw new IncidentServiceError('MEMBERSHIP_INACTIVE', 'Membership is inactive');
			}
			await lockActiveSite(tx, organizationId, siteId);
		}
		const [updated] = await tx
			.update(membershipSites)
			.set({ active, updatedAt: new Date() })
			.where(
				and(
					eq(membershipSites.organizationId, organizationId),
					eq(membershipSites.membershipId, membershipId),
					eq(membershipSites.siteId, siteId)
				)
			)
			.returning({ siteId: membershipSites.siteId });
		if (!updated) {
			throw new IncidentServiceError('MEMBERSHIP_SITE_NOT_FOUND', 'Membership site not found');
		}
		return readAssociation(tx, organizationId, membershipId, siteId);
	});
}

import { and, asc, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { organizations, sites } from '../db/schema';
import { IncidentServiceError } from './incidents';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SiteDatabase = PgDatabase<any, any>;

/** Site DTO: organizationId is implied by the tenant-scoped query and never returned. */
export interface SiteRecord {
	id: string;
	name: string;
	active: boolean;
	createdAt: Date;
	updatedAt: Date;
}

export const SITE_NAME_MIN_LENGTH = 2;
export const SITE_NAME_MAX_LENGTH = 255;

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(value: unknown): value is string {
	return typeof value === 'string' && uuidRegex.test(value);
}

const siteColumns = {
	id: sites.id,
	name: sites.name,
	active: sites.active,
	createdAt: sites.createdAt,
	updatedAt: sites.updatedAt
};

/** Display form stored in the database: trimmed, inner whitespace collapsed to one space. */
export function canonicalSiteName(name: string): string {
	return name.trim().replace(/\s+/g, ' ');
}

/** Comparison key mirroring sites_org_normalized_name_unique_idx (case and spacing insensitive). */
export function normalizeSiteName(name: string): string {
	return canonicalSiteName(name).toLowerCase();
}

function validateName(name: unknown): string {
	if (typeof name !== 'string') {
		throw new IncidentServiceError('INVALID_INPUT', 'name must be a string');
	}
	const canonical = canonicalSiteName(name);
	if (canonical.length < SITE_NAME_MIN_LENGTH) {
		throw new IncidentServiceError(
			'INVALID_INPUT',
			`name must have at least ${SITE_NAME_MIN_LENGTH} characters`
		);
	}
	if (canonical.length > SITE_NAME_MAX_LENGTH) {
		throw new IncidentServiceError(
			'INVALID_INPUT',
			`name must not exceed ${SITE_NAME_MAX_LENGTH} characters`
		);
	}
	if (canonical.includes('\u0000')) {
		throw new IncidentServiceError('INVALID_INPUT', 'name contains invalid characters');
	}
	return canonical;
}

function validateIds(organizationId: unknown, siteId?: unknown): void {
	if (!isValidUuid(organizationId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'organizationId must be a valid UUID');
	}
	if (siteId !== undefined && !isValidUuid(siteId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'siteId must be a valid UUID');
	}
}

function siteNotFound(): IncidentServiceError {
	return new IncidentServiceError('SITE_NOT_FOUND', 'Site not found');
}

/** Maps the database unique violation to a domain error; the constraint is the source of truth. */
function isDuplicateNameViolation(error: unknown): boolean {
	const candidates = [error, (error as { cause?: unknown })?.cause];
	return candidates.some((candidate) => {
		const { code, constraint, constraint_name } = (candidate ?? {}) as Record<string, unknown>;
		const name = constraint ?? constraint_name;
		return (
			code === '23505' &&
			(name === undefined ||
				name === 'sites_org_normalized_name_unique_idx' ||
				name === 'sites_org_name_unique')
		);
	});
}

async function assertOperationalOrganization(
	tx: SiteDatabase,
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

async function inTransaction<T>(
	dbOrTx: SiteDatabase,
	execute: (tx: SiteDatabase) => Promise<T>
): Promise<T> {
	try {
		if ('transaction' in dbOrTx && typeof dbOrTx.transaction === 'function') {
			return await dbOrTx.transaction(async (tx) => execute(tx));
		}
		return await execute(dbOrTx);
	} catch (error) {
		if (error instanceof IncidentServiceError) throw error;
		if (isDuplicateNameViolation(error)) {
			throw new IncidentServiceError(
				'SITE_NAME_DUPLICATE',
				'A site with this name already exists in the organization'
			);
		}
		throw error;
	}
}

/**
 * Lists the sites of one organization, including inactive ones for management.
 * Pass { activeOnly: true } to list only sites selectable for new associations.
 * Deterministic ordering: name ASC, id ASC.
 */
export async function listSites(
	db: SiteDatabase,
	organizationId: string,
	options: { activeOnly?: boolean } = {}
): Promise<SiteRecord[]> {
	validateIds(organizationId);
	const conditions = [eq(sites.organizationId, organizationId)];
	if (options.activeOnly === true) conditions.push(eq(sites.active, true));
	return db
		.select(siteColumns)
		.from(sites)
		.where(and(...conditions))
		.orderBy(asc(sites.name), asc(sites.id));
}

/**
 * Creates an active site. Duplicate names (case and spacing insensitive) within the same
 * organization are rejected by the unique index, which also covers concurrent creations.
 */
export async function createSite(
	dbOrTx: SiteDatabase,
	organizationId: string,
	input: { name: unknown }
): Promise<SiteRecord> {
	validateIds(organizationId);
	const name = validateName(input?.name);
	return inTransaction(dbOrTx, async (tx) => {
		await assertOperationalOrganization(tx, organizationId);
		const [site] = await tx
			.insert(sites)
			.values({ organizationId, name, active: true })
			.returning(siteColumns);
		return site;
	});
}

/** Renames a site of the organization. Does not change its active state. */
export async function updateSite(
	dbOrTx: SiteDatabase,
	organizationId: string,
	siteId: string,
	input: { name: unknown }
): Promise<SiteRecord> {
	validateIds(organizationId, siteId);
	const name = validateName(input?.name);
	return inTransaction(dbOrTx, async (tx) => {
		await assertOperationalOrganization(tx, organizationId);
		const [site] = await tx
			.update(sites)
			.set({ name, updatedAt: new Date() })
			.where(and(eq(sites.id, siteId), eq(sites.organizationId, organizationId)))
			.returning(siteColumns);
		if (!site) throw siteNotFound();
		return site;
	});
}

/**
 * Activates or deactivates a site. Deactivation never deletes: historical incidents keep
 * pointing to the site, while new associations reject inactive sites.
 */
export async function setSiteActive(
	dbOrTx: SiteDatabase,
	organizationId: string,
	siteId: string,
	active: boolean
): Promise<SiteRecord> {
	validateIds(organizationId, siteId);
	if (typeof active !== 'boolean') {
		throw new IncidentServiceError('INVALID_INPUT', 'active must be a boolean');
	}
	return inTransaction(dbOrTx, async (tx) => {
		await assertOperationalOrganization(tx, organizationId);
		const [site] = await tx
			.update(sites)
			.set({ active, updatedAt: new Date() })
			.where(and(eq(sites.id, siteId), eq(sites.organizationId, organizationId)))
			.returning(siteColumns);
		if (!site) throw siteNotFound();
		return site;
	});
}

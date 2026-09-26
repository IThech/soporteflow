import { and, asc, eq, inArray } from 'drizzle-orm';
import {
	memberships,
	roleAssignments,
	rolePermissions,
	roles,
	userEmails,
	users
} from '../db/schema';
import { PERMISSION_IDS, type PermissionId } from '../auth/permissions';
import { IncidentServiceError, type IncidentDatabase } from './incidents';
import {
	assertAdministratorRemains,
	assertDelegable,
	assertOperationalOrganization,
	countTenantAdministrators
} from './roles';

/**
 * Membership administration (5.4R-C). Only organization-scoped role assignments are read and
 * managed here: scoped (department/team/site/personal) assignments are not authorizable over HTTP
 * yet and are never shown, created or removed by these services.
 */

/** Assigned role metadata. Assigned is not effective: inactive roles are listed with active=false. */
export interface MembershipRoleRecord {
	id: string;
	code: string;
	name: string;
	active: boolean;
	isCustom: boolean;
}

/** Explicit allowlist: no credentials, sessions, auth-provider data or secondary emails. */
export interface MembershipRecord {
	id: string;
	user: {
		id: string;
		name: string;
		/** Primary contact email, or null when the identity has none. */
		email: string | null;
		active: boolean;
	};
	active: boolean;
	roles: MembershipRoleRecord[];
}

export interface RoleAssignmentResult {
	membershipId: string;
	role: MembershipRoleRecord;
	/** false when the role was already assigned (idempotent, nothing written). */
	created: boolean;
}

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: unknown, name: string): asserts value is string {
	if (typeof value !== 'string' || !uuidRegex.test(value)) {
		throw new IncidentServiceError('INVALID_INPUT', `${name} must be a valid UUID`);
	}
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

const membershipRoleColumns = {
	id: roles.id,
	code: roles.code,
	name: roles.name,
	active: roles.active,
	isCustom: roles.isCustom
};

/** One query for the organization-scoped roles of many memberships (no N+1). */
async function rolesByMembership(
	db: IncidentDatabase,
	organizationId: string,
	membershipIds: string[]
): Promise<Map<string, MembershipRoleRecord[]>> {
	const result = new Map<string, MembershipRoleRecord[]>();
	if (membershipIds.length === 0) return result;
	const rows = await db
		.select({ membershipId: roleAssignments.membershipId, ...membershipRoleColumns })
		.from(roleAssignments)
		.innerJoin(
			roles,
			and(
				eq(roles.id, roleAssignments.roleId),
				eq(roles.organizationId, roleAssignments.organizationId)
			)
		)
		.where(
			and(
				eq(roleAssignments.organizationId, organizationId),
				inArray(roleAssignments.membershipId, membershipIds),
				eq(roleAssignments.scopeType, 'organization')
			)
		)
		.orderBy(asc(roles.code), asc(roles.id));
	for (const { membershipId, ...role } of rows) {
		const list = result.get(membershipId) ?? [];
		list.push(role);
		result.set(membershipId, list);
	}
	return result;
}

async function selectMemberships(
	db: IncidentDatabase,
	organizationId: string,
	membershipId?: string
): Promise<MembershipRecord[]> {
	const rows = await db
		.select({
			id: memberships.id,
			active: memberships.active,
			userId: users.id,
			userName: users.name,
			userActive: users.active,
			email: userEmails.email
		})
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.leftJoin(userEmails, and(eq(userEmails.userId, users.id), eq(userEmails.isPrimary, true)))
		.where(
			and(
				eq(memberships.organizationId, organizationId),
				membershipId === undefined ? undefined : eq(memberships.id, membershipId)
			)
		)
		.orderBy(asc(users.name), asc(memberships.id));
	const assigned = await rolesByMembership(
		db,
		organizationId,
		rows.map((row) => row.id)
	);
	return rows.map((row) => ({
		id: row.id,
		user: { id: row.userId, name: row.userName, email: row.email ?? null, active: row.userActive },
		active: row.active,
		roles: assigned.get(row.id) ?? []
	}));
}

/**
 * All memberships of the organization (active and inactive, for administration), ordered by user
 * name then membership id, each with its organization-scoped assigned roles. Three queries total.
 * The caller must authorize memberships:view.
 */
export async function listOrganizationMemberships(
	db: IncidentDatabase,
	organizationId: string
): Promise<MembershipRecord[]> {
	assertUuid(organizationId, 'organizationId');
	return selectMemberships(db, organizationId);
}

/** A membership of another tenant behaves exactly like a missing one (MEMBERSHIP_NOT_FOUND). */
export async function getOrganizationMembership(
	db: IncidentDatabase,
	organizationId: string,
	membershipId: string
): Promise<MembershipRecord> {
	assertUuid(organizationId, 'organizationId');
	assertUuid(membershipId, 'membershipId');
	const [membership] = await selectMemberships(db, organizationId, membershipId);
	if (!membership) throw new IncidentServiceError('MEMBERSHIP_NOT_FOUND', 'Membership not found');
	return membership;
}

async function lockMembership(tx: IncidentDatabase, organizationId: string, membershipId: string) {
	const [membership] = await tx
		.select({ id: memberships.id, active: memberships.active, userId: memberships.userId })
		.from(memberships)
		.where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)))
		.limit(1)
		.for('update');
	if (!membership) throw new IncidentServiceError('MEMBERSHIP_NOT_FOUND', 'Membership not found');
	return membership;
}

async function lockRole(tx: IncidentDatabase, organizationId: string, roleId: string) {
	const [role] = await tx
		.select(membershipRoleColumns)
		.from(roles)
		.where(and(eq(roles.id, roleId), eq(roles.organizationId, organizationId)))
		.limit(1)
		.for('share');
	if (!role) throw new IncidentServiceError('ROLE_NOT_FOUND', 'Role not found');
	return role;
}

async function rolePermissionIds(tx: IncidentDatabase, roleId: string): Promise<string[]> {
	return (
		await tx
			.select({ permissionId: rolePermissions.permissionId })
			.from(rolePermissions)
			.where(eq(rolePermissions.roleId, roleId))
			.for('share')
	).map((row) => row.permissionId);
}

async function findAssignment(
	tx: IncidentDatabase,
	organizationId: string,
	membershipId: string,
	roleId: string
) {
	const [assignment] = await tx
		.select({ id: roleAssignments.id })
		.from(roleAssignments)
		.where(
			and(
				eq(roleAssignments.organizationId, organizationId),
				eq(roleAssignments.membershipId, membershipId),
				eq(roleAssignments.roleId, roleId),
				eq(roleAssignments.scopeType, 'organization')
			)
		)
		.limit(1)
		.for('update');
	return assignment;
}

/**
 * Assigns an organization-scoped role to a membership in one transaction. The caller must
 * authorize roles:assign and pass the actor's effective permissions.
 * - membership and role must belong to organizationId (otherwise *_NOT_FOUND, no enumeration);
 * - inactive membership or inactive user: MEMBERSHIP_INACTIVE; inactive role: ROLE_INACTIVE;
 * - monotonic delegation over every permission of the role (system or custom alike; a role with
 *   non-canonical permissions is never delegable): PERMISSION_NOT_DELEGABLE;
 * - already assigned: idempotent success with created=false, no duplicate row.
 * Authorization never looks at role codes or names.
 */
export async function assignRoleToMembership(
	dbOrTx: IncidentDatabase,
	organizationId: string,
	membershipId: string,
	roleId: string,
	actorPermissions: readonly PermissionId[]
): Promise<RoleAssignmentResult> {
	assertUuid(organizationId, 'organizationId');
	assertUuid(membershipId, 'membershipId');
	assertUuid(roleId, 'roleId');
	return inTransaction(dbOrTx, async (tx) => {
		await assertOperationalOrganization(tx, organizationId, 'update');
		const membership = await lockMembership(tx, organizationId, membershipId);
		const role = await lockRole(tx, organizationId, roleId);
		const [user] = await tx
			.select({ active: users.active })
			.from(users)
			.where(eq(users.id, membership.userId))
			.limit(1)
			.for('share');
		if (!membership.active || !user?.active)
			throw new IncidentServiceError('MEMBERSHIP_INACTIVE', 'Membership is not active');
		if (!role.active) throw new IncidentServiceError('ROLE_INACTIVE', 'Role is not active');
		assertDelegable(actorPermissions, await rolePermissionIds(tx, roleId));
		if (await findAssignment(tx, organizationId, membershipId, roleId)) {
			return { membershipId, role, created: false };
		}
		await tx
			.insert(roleAssignments)
			.values({ organizationId, membershipId, roleId, scopeType: 'organization' });
		return { membershipId, role, created: true };
	});
}

/**
 * Revokes one organization-scoped role assignment in one transaction. The caller must authorize
 * roles:assign and pass the actor's effective permissions.
 * - membership/role of another tenant or missing: *_NOT_FOUND; not assigned:
 *   ROLE_ASSIGNMENT_NOT_FOUND;
 * - inactive membership or role can still be cleaned up;
 * - the actor must control the role: every canonical permission it grants must be held by the
 *   actor (a lower actor cannot revoke a superior role): PERMISSION_NOT_DELEGABLE;
 * - last-admin protection: LAST_ADMIN_REQUIRED if the tenant would lose its last administrator;
 * - only that assignment row is deleted; role, membership and other assignments stay intact.
 */
export async function revokeRoleFromMembership(
	dbOrTx: IncidentDatabase,
	organizationId: string,
	membershipId: string,
	roleId: string,
	actorPermissions: readonly PermissionId[]
): Promise<void> {
	assertUuid(organizationId, 'organizationId');
	assertUuid(membershipId, 'membershipId');
	assertUuid(roleId, 'roleId');
	await inTransaction(dbOrTx, async (tx) => {
		await assertOperationalOrganization(tx, organizationId, 'update');
		await lockMembership(tx, organizationId, membershipId);
		await lockRole(tx, organizationId, roleId);
		const canonical = new Set<string>(PERMISSION_IDS);
		assertDelegable(
			actorPermissions,
			(await rolePermissionIds(tx, roleId)).filter((id) => canonical.has(id))
		);
		const assignment = await findAssignment(tx, organizationId, membershipId, roleId);
		if (!assignment)
			throw new IncidentServiceError('ROLE_ASSIGNMENT_NOT_FOUND', 'Role assignment not found');
		const administratorsBefore = await countTenantAdministrators(tx, organizationId);
		await tx
			.delete(roleAssignments)
			.where(
				and(
					eq(roleAssignments.id, assignment.id),
					eq(roleAssignments.organizationId, organizationId)
				)
			);
		await assertAdministratorRemains(tx, organizationId, administratorsBefore);
	});
}

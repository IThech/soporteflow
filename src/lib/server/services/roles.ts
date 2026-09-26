import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
	memberships,
	organizations,
	permissions as permissionsTable,
	roleAssignments,
	rolePermissions,
	roles,
	roleTemplatePermissions,
	roleTemplates,
	users
} from '../db/schema';
import { ROLE_TEMPLATES } from '../auth/role-templates';
import {
	PERMISSION_CATALOG,
	PERMISSION_IDS,
	type PermissionId,
	type PermissionScopeType
} from '../auth/permissions';
import { IncidentServiceError, type IncidentDatabase } from './incidents';

/** Minimal role DTO (organizationId is implied by the call). */
export interface OrganizationRoleRecord {
	id: string;
	code: string;
	name: string;
	templateId: string | null;
	isCustom: boolean;
	active: boolean;
}

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const roleColumns = {
	id: roles.id,
	code: roles.code,
	name: roles.name,
	templateId: roles.templateId,
	isCustom: roles.isCustom,
	active: roles.active
};

const CANONICAL_TEMPLATE_IDS: string[] = ROLE_TEMPLATES.map((template) => template.id);

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
 * Idempotently instantiates the canonical base roles (organization_admin, technician) of one
 * organization from the active canonical role templates, in a single transaction:
 * - creates a missing role as a system role (is_custom = false, template_id set);
 * - reuses an existing role only when it is a system role of the same template;
 * - raises ROLE_CODE_CONFLICT for a custom / foreign role using a canonical code (never adopts it);
 * - copies missing template permissions into the role and never removes any role permission;
 * - skips inactive templates (existing roles are left untouched);
 * - never creates role_assignments: no one gains access through this call.
 * Concurrency: UNIQUE (organization_id, code) + ON CONFLICT DO NOTHING + re-read FOR UPDATE, and
 * UNIQUE (role_id, permission_id) + ON CONFLICT DO NOTHING (multi-connection race still to be
 * exercised on PostgreSQL staging, 5.4W).
 */
export async function ensureOrganizationRoles(
	dbOrTx: IncidentDatabase,
	organizationId: string
): Promise<{ roles: OrganizationRoleRecord[] }> {
	if (typeof organizationId !== 'string' || !uuidRegex.test(organizationId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'organizationId must be a valid UUID');
	}
	return inTransaction(dbOrTx, async (tx) => {
		const [org] = await tx
			.select({ status: organizations.status })
			.from(organizations)
			.where(eq(organizations.id, organizationId))
			.limit(1)
			.for('share');
		if (!org) {
			throw new IncidentServiceError('ORGANIZATION_NOT_FOUND', 'Organization does not exist');
		}
		if (org.status !== 'active') {
			throw new IncidentServiceError(
				'ORGANIZATION_NOT_OPERATIONAL',
				`Organization is not operational (status: '${org.status}')`
			);
		}

		const templates = await tx
			.select({
				id: roleTemplates.id,
				code: roleTemplates.code,
				name: roleTemplates.name,
				description: roleTemplates.description,
				active: roleTemplates.active
			})
			.from(roleTemplates)
			.where(inArray(roleTemplates.id, CANONICAL_TEMPLATE_IDS))
			.orderBy(asc(roleTemplates.id));
		if (templates.length !== CANONICAL_TEMPLATE_IDS.length) {
			throw new IncidentServiceError(
				'ROLE_TEMPLATE_NOT_FOUND',
				'Canonical role templates are missing (migration 0012 not applied)'
			);
		}

		for (const template of templates) {
			if (!template.active) continue;
			await tx
				.insert(roles)
				.values({
					organizationId,
					name: template.name,
					code: template.code,
					description: template.description,
					templateId: template.id,
					isCustom: false,
					active: true
				})
				.onConflictDoNothing({ target: [roles.organizationId, roles.code] });
			const [role] = await tx
				.select(roleColumns)
				.from(roles)
				.where(and(eq(roles.organizationId, organizationId), eq(roles.code, template.code)))
				.limit(1)
				.for('update');
			if (!role || role.isCustom || role.templateId !== template.id) {
				throw new IncidentServiceError(
					'ROLE_CODE_CONFLICT',
					`A non-canonical role already uses the code '${template.code}' in this organization`
				);
			}
			const permissionRows = await tx
				.select({ permissionId: roleTemplatePermissions.permissionId })
				.from(roleTemplatePermissions)
				.where(eq(roleTemplatePermissions.roleTemplateId, template.id));
			if (permissionRows.length > 0) {
				await tx
					.insert(rolePermissions)
					.values(
						permissionRows.map((row) => ({ roleId: role.id, permissionId: row.permissionId }))
					)
					.onConflictDoNothing({ target: [rolePermissions.roleId, rolePermissions.permissionId] });
			}
		}

		const baseRoles = await tx
			.select(roleColumns)
			.from(roles)
			.where(
				and(
					eq(roles.organizationId, organizationId),
					inArray(roles.templateId, CANONICAL_TEMPLATE_IDS)
				)
			)
			.orderBy(asc(roles.code));
		return { roles: baseRoles.filter((role) => !role.isCustom) };
	});
}

// =============================================================================
// Read model for role administration (5.4R-A)
// =============================================================================

/** Canonical permission as exposed to administration (no createdAt / internal data). */
export interface CanonicalPermissionRecord {
	id: PermissionId;
	name: string;
	description: string;
	category: string;
	allowedScopeTypes: PermissionScopeType[];
}

/** Role as exposed to administration. permissions are the role's real role_permissions. */
export interface AdminRoleRecord {
	id: string;
	code: string;
	name: string;
	description: string | null;
	templateId: string | null;
	isCustom: boolean;
	active: boolean;
	permissions: PermissionId[];
}

const adminRoleColumns = {
	...roleColumns,
	description: roles.description
};

/** Canonical catalog only (never platform:* or unknown rows), in catalog order. */
export function listCanonicalPermissions(): CanonicalPermissionRecord[] {
	return PERMISSION_CATALOG.map((permission) => ({
		id: permission.id,
		name: permission.name,
		description: permission.description,
		category: permission.category,
		allowedScopeTypes: [...permission.allowedScopeTypes]
	}));
}

function assertUuid(value: unknown, name: string): asserts value is string {
	if (typeof value !== 'string' || !uuidRegex.test(value)) {
		throw new IncidentServiceError('INVALID_INPUT', `${name} must be a valid UUID`);
	}
}

/**
 * Real permissions of the given roles, read from role_permissions (never from the template),
 * restricted to canonical ids and ordered as the catalog. One query for all roles.
 */
async function permissionsByRole(
	db: IncidentDatabase,
	roleIds: string[]
): Promise<Map<string, PermissionId[]>> {
	const byRole = new Map<string, Set<string>>(roleIds.map((id) => [id, new Set<string>()]));
	if (roleIds.length > 0) {
		const rows = await db
			.select({ roleId: rolePermissions.roleId, permissionId: rolePermissions.permissionId })
			.from(rolePermissions)
			.where(inArray(rolePermissions.roleId, roleIds));
		for (const row of rows) byRole.get(row.roleId)?.add(row.permissionId);
	}
	return new Map(
		[...byRole].map(([roleId, granted]) => [roleId, PERMISSION_IDS.filter((id) => granted.has(id))])
	);
}

/**
 * Lists the roles of one organization for administration: system and custom roles, active and
 * inactive (an inactive role keeps its configuration but grants nothing at runtime) unless
 * activeOnly is set. Ordered by code ASC, id ASC. Authorization (roles:view) is the caller's job.
 */
export async function listOrganizationRoles(
	db: IncidentDatabase,
	organizationId: string,
	options: { activeOnly?: boolean } = {}
): Promise<AdminRoleRecord[]> {
	assertUuid(organizationId, 'organizationId');
	const conditions = [eq(roles.organizationId, organizationId)];
	if (options.activeOnly === true) conditions.push(eq(roles.active, true));
	const rows = await db
		.select(adminRoleColumns)
		.from(roles)
		.where(and(...conditions))
		.orderBy(asc(roles.code), asc(roles.id));
	const permissions = await permissionsByRole(
		db,
		rows.map((row) => row.id)
	);
	return rows.map((row) => ({ ...row, permissions: permissions.get(row.id) ?? [] }));
}

/**
 * One role of the organization. Always looked up by id AND organization: a role of another
 * tenant and a missing role are indistinguishable (ROLE_NOT_FOUND).
 */
export async function getOrganizationRole(
	db: IncidentDatabase,
	organizationId: string,
	roleId: string
): Promise<AdminRoleRecord> {
	assertUuid(organizationId, 'organizationId');
	assertUuid(roleId, 'roleId');
	const [row] = await db
		.select(adminRoleColumns)
		.from(roles)
		.where(and(eq(roles.id, roleId), eq(roles.organizationId, organizationId)))
		.limit(1);
	if (!row) throw new IncidentServiceError('ROLE_NOT_FOUND', 'Role not found');
	const permissions = await permissionsByRole(db, [row.id]);
	return { ...row, permissions: permissions.get(row.id) ?? [] };
}

// =============================================================================
// Custom role mutations (5.4R-B)
// =============================================================================

export interface CreateCustomRoleInput {
	name: unknown;
	code: unknown;
	description?: unknown;
	permissions: unknown;
}

export interface UpdateCustomRoleInput {
	name?: unknown;
	description?: unknown;
	permissions?: unknown;
	active?: unknown;
}

export const ROLE_CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const ROLE_CODE_MIN_LENGTH = 3;
export const ROLE_CODE_MAX_LENGTH = 50;
export const ROLE_NAME_MAX_LENGTH = 100;
export const ROLE_DESCRIPTION_MAX_LENGTH = 1000;
/** Codes reserved for canonical system roles (current and future templates). */
export const RESERVED_ROLE_CODES: readonly string[] = ROLE_TEMPLATES.map(
	(template) => template.code
);

function invalid(message: string): IncidentServiceError {
	return new IncidentServiceError('INVALID_INPUT', message);
}

function validateRoleName(name: unknown): string {
	if (typeof name !== 'string') throw invalid('name must be a string');
	const trimmed = name.trim();
	if (trimmed.length === 0) throw invalid('name must not be empty');
	if (trimmed.length > ROLE_NAME_MAX_LENGTH)
		throw invalid(`name must not exceed ${ROLE_NAME_MAX_LENGTH} characters`);
	if (trimmed.includes('\u0000')) throw invalid('name contains invalid characters');
	return trimmed;
}

/** Plain text (never trusted markup). Empty or whitespace-only becomes null. */
function validateRoleDescription(description: unknown): string | null {
	if (description === null) return null;
	if (typeof description !== 'string') throw invalid('description must be a string or null');
	const trimmed = description.trim();
	if (trimmed.length > ROLE_DESCRIPTION_MAX_LENGTH)
		throw invalid(`description must not exceed ${ROLE_DESCRIPTION_MAX_LENGTH} characters`);
	if (trimmed.includes('\u0000')) throw invalid('description contains invalid characters');
	return trimmed.length === 0 ? null : trimmed;
}

/** Closed snake_case code; validated and rejected, never silently normalized. */
function validateRoleCode(code: unknown): string {
	if (
		typeof code !== 'string' ||
		code.length < ROLE_CODE_MIN_LENGTH ||
		code.length > ROLE_CODE_MAX_LENGTH ||
		!ROLE_CODE_PATTERN.test(code)
	) {
		throw invalid('code must be lowercase snake_case (3-50 characters)');
	}
	if (RESERVED_ROLE_CODES.includes(code)) {
		throw new IncidentServiceError('ROLE_CODE_CONFLICT', 'This role code is reserved');
	}
	return code;
}

/**
 * Canonical, organization-scoped permission ids only (no platform:*, unknown or
 * granular-only ids), without duplicates. Returned in catalog order.
 */
function validateRolePermissions(permissions: unknown): PermissionId[] {
	if (!Array.isArray(permissions)) throw invalid('permissions must be an array');
	if (new Set(permissions).size !== permissions.length) throw invalid('duplicate permissions');
	const requested = new Set<string>();
	for (const permission of permissions) {
		const definition = PERMISSION_CATALOG.find((entry) => entry.id === permission);
		if (
			!definition ||
			!(definition.allowedScopeTypes as readonly string[]).includes('organization')
		)
			throw invalid('permissions must be canonical organization-scoped permission ids');
		requested.add(definition.id);
	}
	return PERMISSION_IDS.filter((id) => requested.has(id));
}

/**
 * Monotonic delegation (single implementation for role mutations and role assignment): the actor
 * can only grant, or control, permissions it effectively holds right now in this organization
 * (resolved before the mutation, so editing or assigning one's own role cannot escalate).
 * Non-canonical ids are never in actorPermissions, so they are never delegable.
 */
export function assertDelegable(
	actorPermissions: readonly PermissionId[],
	permissions: readonly string[]
) {
	const held = new Set<string>(actorPermissions);
	if (permissions.some((permission) => !held.has(permission))) {
		throw new IncidentServiceError(
			'PERMISSION_NOT_DELEGABLE',
			'Cannot grant permissions the actor does not hold'
		);
	}
}

function isRoleCodeViolation(error: unknown): boolean {
	const candidates = [error, (error as { cause?: unknown })?.cause];
	return candidates.some((candidate) => {
		const { code, constraint, constraint_name } = (candidate ?? {}) as Record<string, unknown>;
		const name = constraint ?? constraint_name;
		return code === '23505' && (name === undefined || name === 'roles_org_code_unique');
	});
}

/**
 * Checks the organization exists and is active. Mutations that can change who administers the
 * tenant lock the row FOR UPDATE so they are serialized per organization (last-admin guard).
 */
export async function assertOperationalOrganization(
	tx: IncidentDatabase,
	organizationId: string,
	lock: 'share' | 'update' = 'share'
) {
	const [org] = await tx
		.select({ status: organizations.status })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1)
		.for(lock);
	if (!org) throw new IncidentServiceError('ORGANIZATION_NOT_FOUND', 'Organization does not exist');
	if (org.status !== 'active')
		throw new IncidentServiceError(
			'ORGANIZATION_NOT_OPERATIONAL',
			`Organization is not operational (status: '${org.status}')`
		);
}

async function mapRoleCodeConflict<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (!(error instanceof IncidentServiceError) && isRoleCodeViolation(error)) {
			throw new IncidentServiceError(
				'ROLE_CODE_CONFLICT',
				'A role with this code already exists in the organization'
			);
		}
		throw error;
	}
}

/**
 * Creates an active custom role (is_custom = true, template_id = null) and its permissions in one
 * transaction. The caller must authorize roles:manage and pass the actor's effective permissions;
 * every requested permission must be delegable. Codes are unique per organization and canonical
 * system codes are reserved.
 */
export async function createCustomRole(
	dbOrTx: IncidentDatabase,
	organizationId: string,
	actorPermissions: readonly PermissionId[],
	input: CreateCustomRoleInput
): Promise<AdminRoleRecord> {
	assertUuid(organizationId, 'organizationId');
	if (!input || typeof input !== 'object') throw invalid('invalid role input');
	const name = validateRoleName(input.name);
	const code = validateRoleCode(input.code);
	const description =
		input.description === undefined ? null : validateRoleDescription(input.description);
	const permissions = validateRolePermissions(input.permissions);
	assertDelegable(actorPermissions, permissions);
	return mapRoleCodeConflict(() =>
		inTransaction(dbOrTx, async (tx) => {
			await assertOperationalOrganization(tx, organizationId);
			const [role] = await tx
				.insert(roles)
				.values({
					organizationId,
					name,
					code,
					description,
					templateId: null,
					isCustom: true,
					active: true
				})
				.returning({ id: roles.id });
			if (permissions.length > 0) {
				await tx
					.insert(rolePermissions)
					.values(permissions.map((permissionId) => ({ roleId: role.id, permissionId })));
			}
			return getOrganizationRole(tx, organizationId, role.id);
		})
	);
}

/**
 * Partially updates a custom role (name, description, permissions, active) in one transaction.
 * - System roles (is_custom = false or template_id set) are immutable: SYSTEM_ROLE_IMMUTABLE.
 * - code, template_id and is_custom are never changed.
 * - permissions replaces the role's canonical permission set atomically; if the role holds any
 *   non-canonical (legacy/unknown) permission, a permissions change is refused
 *   (ROLE_HAS_UNKNOWN_PERMISSIONS) so those grants are never silently lost.
 * - Delegation: the actor must hold every permission the role currently grants (cannot manage a
 *   role above its own level, including reactivating or trimming it) and every new permission.
 * - The role row is locked FOR UPDATE; assignments are never touched, so changes apply to every
 *   member immediately.
 */
export async function updateCustomRole(
	dbOrTx: IncidentDatabase,
	organizationId: string,
	roleId: string,
	actorPermissions: readonly PermissionId[],
	input: UpdateCustomRoleInput
): Promise<AdminRoleRecord> {
	assertUuid(organizationId, 'organizationId');
	assertUuid(roleId, 'roleId');
	if (
		!input ||
		typeof input !== 'object' ||
		(input.name === undefined &&
			input.description === undefined &&
			input.permissions === undefined &&
			input.active === undefined)
	) {
		throw invalid('at least one of name, description, permissions or active is required');
	}
	const name = input.name === undefined ? undefined : validateRoleName(input.name);
	const description =
		input.description === undefined ? undefined : validateRoleDescription(input.description);
	const permissions =
		input.permissions === undefined ? undefined : validateRolePermissions(input.permissions);
	if (input.active !== undefined && typeof input.active !== 'boolean')
		throw invalid('active must be a boolean');
	const active = input.active as boolean | undefined;

	return inTransaction(dbOrTx, async (tx) => {
		await assertOperationalOrganization(tx, organizationId, 'update');
		const administratorsBefore = await countTenantAdministrators(tx, organizationId);
		const [role] = await tx
			.select({ id: roles.id, isCustom: roles.isCustom, templateId: roles.templateId })
			.from(roles)
			.where(and(eq(roles.id, roleId), eq(roles.organizationId, organizationId)))
			.limit(1)
			.for('update');
		if (!role) throw new IncidentServiceError('ROLE_NOT_FOUND', 'Role not found');
		if (!role.isCustom || role.templateId !== null) {
			throw new IncidentServiceError('SYSTEM_ROLE_IMMUTABLE', 'System roles cannot be modified');
		}
		const current = (
			await tx
				.select({ permissionId: rolePermissions.permissionId })
				.from(rolePermissions)
				.where(eq(rolePermissions.roleId, roleId))
		).map((row) => row.permissionId);
		const canonicalIds = new Set<string>(PERMISSION_IDS);
		if (permissions !== undefined && current.some((id) => !canonicalIds.has(id))) {
			throw new IncidentServiceError(
				'ROLE_HAS_UNKNOWN_PERMISSIONS',
				'Role holds non-canonical permissions; its permission set cannot be replaced'
			);
		}
		assertDelegable(
			actorPermissions,
			current.filter((id) => canonicalIds.has(id))
		);
		if (permissions !== undefined) assertDelegable(actorPermissions, permissions);

		const changes: { name?: string; description?: string | null; active?: boolean } = {};
		if (name !== undefined) changes.name = name;
		if (description !== undefined) changes.description = description;
		if (active !== undefined) changes.active = active;
		if (Object.keys(changes).length > 0) {
			await tx
				.update(roles)
				.set({ ...changes, updatedAt: new Date() })
				.where(and(eq(roles.id, roleId), eq(roles.organizationId, organizationId)));
		}
		if (permissions !== undefined) {
			const target = new Set<string>(permissions);
			const removed = current.filter((id) => canonicalIds.has(id) && !target.has(id));
			if (removed.length > 0) {
				await tx
					.delete(rolePermissions)
					.where(
						and(eq(rolePermissions.roleId, roleId), inArray(rolePermissions.permissionId, removed))
					);
			}
			if (permissions.length > 0) {
				await tx
					.insert(rolePermissions)
					.values(permissions.map((permissionId) => ({ roleId, permissionId })))
					.onConflictDoNothing({ target: [rolePermissions.roleId, rolePermissions.permissionId] });
			}
			if (Object.keys(changes).length === 0) {
				await tx
					.update(roles)
					.set({ updatedAt: new Date() })
					.where(and(eq(roles.id, roleId), eq(roles.organizationId, organizationId)));
			}
		}
		await assertAdministratorRemains(tx, organizationId, administratorsBefore);
		return getOrganizationRole(tx, organizationId, roleId);
	});
}

// =============================================================================
// Tenant administrator guard (5.4R-C/D)
// =============================================================================

const ADMIN_TEMPLATE = ROLE_TEMPLATES.find((template) => template.id === 'tpl_organization_admin')!;

/**
 * Permission set that defines a full tenant administrator: the canonical permissions of this
 * organization's organization_admin system role (live role_permissions, so a divergent tenant is
 * measured against its own admin role), or the canonical template when the tenant has none.
 */
async function tenantAdministratorPermissions(
	tx: IncidentDatabase,
	organizationId: string
): Promise<string[]> {
	const rows = await tx
		.select({ permissionId: rolePermissions.permissionId })
		.from(roles)
		.innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
		.where(
			and(
				eq(roles.organizationId, organizationId),
				eq(roles.templateId, ADMIN_TEMPLATE.id),
				eq(roles.isCustom, false)
			)
		);
	const held = new Set(rows.map((row) => row.permissionId));
	const live = PERMISSION_IDS.filter((id) => held.has(id));
	return live.length > 0 ? live : [...ADMIN_TEMPLATE.permissionIds];
}

/**
 * Number of memberships that can fully administer the tenant right now: active user, active
 * membership, and organization-scoped assignments of active roles that together grant every
 * tenant-administrator permission (same rules as runtime authorization; any role, system or
 * custom, counts). One aggregate query, no N+1.
 */
export async function countTenantAdministrators(
	tx: IncidentDatabase,
	organizationId: string
): Promise<number> {
	const required = await tenantAdministratorPermissions(tx, organizationId);
	const rows = await tx
		.select({ membershipId: memberships.id })
		.from(memberships)
		.innerJoin(users, and(eq(users.id, memberships.userId), eq(users.active, true)))
		.innerJoin(
			roleAssignments,
			and(
				eq(roleAssignments.membershipId, memberships.id),
				eq(roleAssignments.organizationId, memberships.organizationId),
				eq(roleAssignments.scopeType, 'organization')
			)
		)
		.innerJoin(
			roles,
			and(
				eq(roles.id, roleAssignments.roleId),
				eq(roles.organizationId, roleAssignments.organizationId),
				eq(roles.active, true)
			)
		)
		.innerJoin(
			rolePermissions,
			and(eq(rolePermissions.roleId, roles.id), inArray(rolePermissions.permissionId, required))
		)
		.innerJoin(
			permissionsTable,
			and(
				eq(permissionsTable.id, rolePermissions.permissionId),
				sql`'organization' = ANY(${permissionsTable.allowedScopeTypes})`
			)
		)
		.where(and(eq(memberships.organizationId, organizationId), eq(memberships.active, true)))
		.groupBy(memberships.id)
		.having(sql`count(distinct ${rolePermissions.permissionId}) = ${required.length}`);
	return rows.length;
}

/**
 * Last-admin protection: a mutation may not take a tenant that had at least one full
 * administrator down to zero. Called after the mutation inside the same transaction, so a
 * violation rolls it back. The caller must hold the organization row FOR UPDATE.
 */
export async function assertAdministratorRemains(
	tx: IncidentDatabase,
	organizationId: string,
	administratorsBefore: number
): Promise<void> {
	if (administratorsBefore === 0) return;
	if ((await countTenantAdministrators(tx, organizationId)) === 0) {
		throw new IncidentServiceError(
			'LAST_ADMIN_REQUIRED',
			'The organization must keep at least one administrator'
		);
	}
}

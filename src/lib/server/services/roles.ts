import { and, asc, eq, inArray } from 'drizzle-orm';
import {
	organizations,
	rolePermissions,
	roles,
	roleTemplatePermissions,
	roleTemplates
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

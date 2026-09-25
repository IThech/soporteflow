import { and, asc, eq, inArray } from 'drizzle-orm';
import {
	organizations,
	rolePermissions,
	roles,
	roleTemplatePermissions,
	roleTemplates
} from '../db/schema';
import { ROLE_TEMPLATES } from '../auth/role-templates';
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

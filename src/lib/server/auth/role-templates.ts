import type { PermissionId } from './permissions';

/**
 * Canonical system role templates (5.4Q-C). Global blueprints: they never authorize anything
 * by themselves. ensureOrganizationRoles / migration 0012 copy them into tenant-local roles
 * (roles.is_custom = false, roles.template_id set) and physically copy their permissions into
 * role_permissions. Runtime authorization only follows
 * membership -> role_assignment -> role -> role_permission -> permission.
 *
 * Customer (incidents:view_requested) is intentionally absent until 5.4S.
 * Template ids and codes are permanent contracts; changing a template's permissions requires an
 * explicit migration (there is no automatic template -> role synchronization).
 */
export interface RoleTemplateDefinition {
	readonly id: string;
	readonly code: string;
	readonly name: string;
	readonly description: string;
	readonly permissionIds: readonly PermissionId[];
}

export const ROLE_TEMPLATES = [
	{
		id: 'tpl_organization_admin',
		code: 'organization_admin',
		name: 'Administrador de organización',
		description:
			'Rol de administración operativa completa del tenant con las capabilities Core actualmente disponibles.',
		permissionIds: [
			'incidents:view_all',
			'incidents:create',
			'incidents:edit',
			'incidents:assign',
			'incidents:add_comment',
			'incidents:view_internal_notes',
			'incidents:add_internal_note',
			'sites:view',
			'sites:manage',
			'categories:view',
			'categories:manage',
			'teams:view',
			'identities:create',
			'memberships:create',
			'roles:assign',
			'roles:view',
			'roles:manage',
			'memberships:view'
		]
	},
	{
		id: 'tpl_technician',
		code: 'technician',
		name: 'Técnico de soporte',
		description: 'Rol operativo para atención y gestión de incidencias.',
		// view_all (not view_own): support works on shared and unassigned queues.
		permissionIds: [
			'incidents:view_all',
			'incidents:create',
			'incidents:edit',
			'incidents:assign',
			'incidents:add_comment',
			'incidents:view_internal_notes',
			'incidents:add_internal_note',
			'sites:view',
			'categories:view',
			'teams:view'
		]
	}
] as const satisfies readonly RoleTemplateDefinition[];

export type RoleTemplateId = (typeof ROLE_TEMPLATES)[number]['id'];
export type RoleTemplateCode = (typeof ROLE_TEMPLATES)[number]['code'];

import type { PermissionId } from './permissions';

/**
 * Canonical system role templates (5.4Q-C). Global blueprints: they never authorize anything
 * by themselves. ensureOrganizationRoles / migrations 0012 and 0015 copy them into tenant-local
 * roles (roles.is_custom = false, roles.template_id set) and physically copy their permissions
 * into role_permissions. Runtime authorization only follows
 * membership -> role_assignment -> role -> role_permission -> permission.
 *
 * Customer (5.4S-A) receives incidents:view_requested, which has no authorization effect until
 * incident access consumes it (5.4S-B). organization_admin also holds it: it adds no visibility
 * (view_all already covers every incident) but monotonic delegation requires the actor to hold
 * every permission of a role it assigns or invites with, so without it no admin could ever grant
 * the Customer role. Technician does not receive it.
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
			'memberships:view',
			'invitations:create',
			'invitations:view',
			'invitations:revoke',
			'incidents:view_requested',
			'sla:view',
			'sla:manage',
			'sla:assign'
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
			'teams:view',
			// 5.4T-A: technicians need the operational SLA targets, never their configuration.
			'sla:view',
			// 5.4T-B: technicians may choose/change an incident's SLA among existing policies.
			'sla:assign'
		]
	},
	{
		id: 'tpl_customer',
		code: 'customer',
		name: 'Cliente',
		description: 'Rol para clientes externos y solicitantes de asistencia técnica.',
		// Requester only: no view_all/view_own, edit, assign, internal notes or administration.
		permissionIds: [
			'incidents:create',
			'incidents:view_requested',
			'incidents:add_comment',
			'sites:view',
			'categories:view'
		]
	}
] as const satisfies readonly RoleTemplateDefinition[];

export type RoleTemplateId = (typeof ROLE_TEMPLATES)[number]['id'];
export type RoleTemplateCode = (typeof ROLE_TEMPLATES)[number]['code'];

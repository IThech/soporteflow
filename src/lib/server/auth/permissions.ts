/**
 * Canonical permission catalog of the Core backend (5.4Q-B).
 *
 * Terminology: a Permission is an atomic authorizable capability; a Role is a collection of
 * permissions; a Scope is where a role assignment applies. This file is the single source of
 * permission ids known by server code. Migration 0011 seeds exactly these rows (tests keep the
 * migration and this catalog in parity); inserting them grants nothing to anyone.
 *
 * allowedScopeTypes is deliberately ['organization'] for every entry: HTTP routes never pass a
 * resource to authorizeAction and provisioning requires organization scope, so granular scopes
 * (site/team/department/personal) are not enabled until a route actually consumes them.
 * platform:* permissions are excluded here and ignored by authorization.ts by design.
 * Ids are permanent contracts: never rename or reuse one.
 */

export type PermissionScopeType = 'organization' | 'department' | 'team' | 'site' | 'personal';

export interface PermissionDefinition {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly category: string;
	readonly allowedScopeTypes: readonly PermissionScopeType[];
}

const ORGANIZATION_ONLY = ['organization'] as const;

export const PERMISSION_CATALOG = [
	// Incidents
	{
		id: 'incidents:create',
		name: 'Crear incidencias',
		description: 'Crear incidencias en la organización.',
		category: 'incidents',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	{
		id: 'incidents:view_all',
		name: 'Ver todas las incidencias',
		description: 'Consultar cualquier incidencia de la organización.',
		category: 'incidents',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	{
		id: 'incidents:view_own',
		name: 'Ver incidencias asignadas',
		description: 'Consultar solo las incidencias asignadas al propio usuario.',
		category: 'incidents',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	// 5.4S: requester access (incidents whose clientUserId is the principal). Catalogued in 5.4S-A;
	// it has no authorization effect until incident access consumes it (5.4S-B).
	{
		id: 'incidents:view_requested',
		name: 'Ver incidencias solicitadas',
		description: 'Consultar solo las incidencias en las que el propio usuario es el solicitante.',
		category: 'incidents',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	{
		id: 'incidents:edit',
		name: 'Editar incidencias',
		description:
			'Cambiar estado, prioridad, nivel de soporte, sede y categoría de incidencias accesibles.',
		category: 'incidents',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	{
		id: 'incidents:assign',
		name: 'Asignar incidencias',
		description: 'Asignar o reasignar equipo y técnico de incidencias accesibles.',
		category: 'incidents',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	{
		id: 'incidents:add_comment',
		name: 'Añadir comentarios',
		description: 'Publicar comentarios públicos en incidencias accesibles.',
		category: 'incidents',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	{
		id: 'incidents:view_internal_notes',
		name: 'Ver notas internas',
		description: 'Consultar las notas internas de las incidencias.',
		category: 'incidents',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	{
		id: 'incidents:add_internal_note',
		name: 'Añadir notas internas',
		description: 'Añadir notas internas a las incidencias.',
		category: 'incidents',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	// Sites
	{
		id: 'sites:view',
		name: 'Ver sedes',
		description: 'Consultar el catálogo de sedes de la organización.',
		category: 'sites',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	{
		id: 'sites:manage',
		name: 'Gestionar sedes',
		description: 'Crear, renombrar, activar y desactivar sedes.',
		category: 'sites',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	// Categories
	{
		id: 'categories:view',
		name: 'Ver categorías',
		description: 'Consultar el catálogo de categorías de la organización.',
		category: 'categories',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	{
		id: 'categories:manage',
		name: 'Gestionar categorías',
		description: 'Crear, editar, activar y desactivar categorías.',
		category: 'categories',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	// Teams
	{
		id: 'teams:view',
		name: 'Ver equipos',
		description: 'Consultar los equipos activos de la organización.',
		category: 'teams',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	// Provisioning (server-side only, no HTTP endpoint)
	{
		id: 'identities:create',
		name: 'Crear identidades',
		description: 'Aprovisionar nuevas identidades de usuario.',
		category: 'provisioning',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	{
		id: 'memberships:create',
		name: 'Crear membresías',
		description: 'Vincular identidades existentes a la organización.',
		category: 'provisioning',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	{
		id: 'roles:assign',
		name: 'Asignar roles',
		description: 'Asignar roles de la organización a membresías.',
		category: 'provisioning',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	// Role administration (5.4R)
	{
		id: 'roles:view',
		name: 'Ver roles',
		description: 'Consultar los roles de la organización y el catálogo de permisos.',
		category: 'roles',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	{
		id: 'roles:manage',
		name: 'Gestionar roles',
		description: 'Crear y modificar roles personalizados de la organización (5.4R-B/C).',
		category: 'roles',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	// Membership administration (5.4R-C). Assignment/revocation uses roles:assign.
	{
		id: 'memberships:view',
		name: 'Ver membresías',
		description: 'Consultar los miembros de la organización y sus roles asignados.',
		category: 'memberships',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	// Invitations (5.4S). Catalogued in 5.4S-A; no endpoint consumes them yet (5.4S-C).
	{
		id: 'invitations:create',
		name: 'Crear invitaciones',
		description: 'Invitar a personas a unirse a la organización con un rol.',
		category: 'invitations',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	{
		id: 'invitations:view',
		name: 'Ver invitaciones',
		description: 'Consultar las invitaciones de la organización.',
		category: 'invitations',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	{
		id: 'invitations:revoke',
		name: 'Revocar invitaciones',
		description: 'Cancelar invitaciones pendientes de la organización.',
		category: 'invitations',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	// SLA (5.4T-A): policy configuration only; incident deadlines arrive in 5.4T-B.
	{
		id: 'sla:view',
		name: 'Ver políticas SLA',
		description: 'Consultar las políticas SLA de la organización.',
		category: 'sla',
		allowedScopeTypes: ORGANIZATION_ONLY
	},
	{
		id: 'sla:manage',
		name: 'Gestionar políticas SLA',
		description: 'Crear, modificar, activar y desactivar políticas SLA de la organización.',
		category: 'sla',
		allowedScopeTypes: ORGANIZATION_ONLY
	}
] as const satisfies readonly PermissionDefinition[];

/** Canonical permission id. Server code should only authorize ids from the catalog. */
export type PermissionId = (typeof PERMISSION_CATALOG)[number]['id'];

export const PERMISSION_IDS: readonly PermissionId[] = PERMISSION_CATALOG.map(
	(permission) => permission.id
);

const PERMISSION_ID_SET: ReadonlySet<string> = new Set(PERMISSION_IDS);

export function isPermissionId(value: unknown): value is PermissionId {
	return typeof value === 'string' && PERMISSION_ID_SET.has(value);
}

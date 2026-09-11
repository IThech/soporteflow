import type { Permission } from '$lib/auth/permissions';
import { hasPermission } from '$lib/auth/permissions';
import type { AppUser } from '$lib/types/user';

export type SettingsSectionId =
	| 'users'
	| 'locations'
	| 'support_levels'
	| 'teams'
	| 'categories'
	| 'reassignment_reasons'
	| 'sla_policies';

export type SettingsGroupId = 'organization' | 'support' | 'incidents';

export interface SettingsSectionDefinition {
	id: SettingsSectionId;
	groupId: SettingsGroupId;
	label: string;
	description: string;
	status: 'active' | 'coming_soon';
	requiredPermission: Permission;
}

export interface SettingsGroupDefinition {
	id: SettingsGroupId;
	label: string;
	description: string;
	sections: SettingsSectionDefinition[];
}

export const SETTINGS_GROUPS: readonly SettingsGroupDefinition[] = [
	{
		id: 'organization',
		label: 'Organización',
		description: 'Estructura organizativa, usuarios y sedes',
		sections: [
			{
				id: 'users',
				groupId: 'organization',
				label: 'Usuarios',
				description: 'Gestión de técnicos, administradores y clientes de la organización.',
				status: 'active',
				requiredPermission: 'users:manage'
			},
			{
				id: 'locations',
				groupId: 'organization',
				label: 'Sedes y ubicaciones',
				description: 'Sedes físicas, delegaciones y áreas de atención de soporte.',
				status: 'coming_soon',
				requiredPermission: 'organization:manage'
			}
		]
	},
	{
		id: 'support',
		label: 'Soporte',
		description: 'Niveles operativos y especialización',
		sections: [
			{
				id: 'support_levels',
				groupId: 'support',
				label: 'Niveles de soporte',
				description: 'Configuración y jerarquía operativa para los niveles de atención técnica.',
				status: 'active',
				requiredPermission: 'organization:manage'
			},
			{
				id: 'teams',
				groupId: 'support',
				label: 'Equipos',
				description: 'Equipos de soporte técnico y distribución organizativa de carga.',
				status: 'active',
				requiredPermission: 'organization:manage'
			}
		]
	},
	{
		id: 'incidents',
		label: 'Incidencias',
		description: 'Clasificación, derivación y acuerdos de servicio',
		sections: [
			{
				id: 'categories',
				groupId: 'incidents',
				label: 'Categorías',
				description: 'Catálogo de categorías para clasificar incidencias.',
				status: 'active',
				requiredPermission: 'categories:manage'
			},
			{
				id: 'reassignment_reasons',
				groupId: 'incidents',
				label: 'Motivos de reasignación',
				description: 'Motivos normalizados para reasignar y derivar incidencias.',
				status: 'active',
				requiredPermission: 'organization:manage'
			},
			{
				id: 'sla_policies',
				groupId: 'incidents',
				label: 'Políticas SLA',
				description: 'Tiempos de respuesta y resolución comprometidos por prioridad y categoría.',
				status: 'active',
				requiredPermission: 'sla:manage'
			}
		]
	}
] as const;

/**
 * Returns all sections the user has permission to manage.
 * By default includes only active sections for access gating,
 * but allows inspecting permitted upcoming sections as well.
 */
export function getPermittedSettingsSections(
	user: AppUser | null | undefined,
	options: { includeComingSoon?: boolean } = {}
): SettingsSectionDefinition[] {
	if (!user?.active) return [];
	const allSections = SETTINGS_GROUPS.flatMap((group) => group.sections);
	return allSections.filter((section) => {
		if (!options.includeComingSoon && section.status !== 'active') return false;
		return hasPermission(user, section.requiredPermission);
	});
}

/**
 * General principle: A user can access Settings if they have permission to manage
 * at least one of the available sections.
 * Automatically accommodates newly registered sections in SETTINGS_GROUPS without hardcoding.
 */
export function canAccessSettings(user: AppUser | null | undefined): boolean {
	return getPermittedSettingsSections(user, { includeComingSoon: false }).length > 0;
}

/**
 * Checks whether a user has permission to manage a specific settings section.
 */
export function canManageSettingsSection(
	user: AppUser | null | undefined,
	sectionId: SettingsSectionId
): boolean {
	if (!user?.active) return false;
	const section = SETTINGS_GROUPS.flatMap((g) => g.sections).find((s) => s.id === sectionId);
	if (!section) return false;
	return hasPermission(user, section.requiredPermission);
}

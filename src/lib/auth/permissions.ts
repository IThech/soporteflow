import type { AppUser, UserRole } from '$lib/types/user';

export type Permission =
	| 'platform:manage'
	| 'organization:manage'
	| 'users:manage'
	| 'categories:manage'
	| 'sla:manage'
	| 'incidents:view_all'
	| 'incidents:view_own'
	| 'incidents:create'
	| 'incidents:edit'
	| 'incidents:assign'
	| 'incidents:delete'
	| 'incidents:classify'
	| 'incidents:override_priority'
	| 'incidents:view_internal_notes'
	| 'incidents:add_internal_note';

export const rolePermissions: Record<UserRole, readonly Permission[]> = {
	platform_admin: [
		'platform:manage',
		'organization:manage',
		'users:manage',
		'categories:manage',
		'sla:manage',
		'incidents:view_all',
		'incidents:view_internal_notes',
		'incidents:add_internal_note',
		'incidents:view_own',
		'incidents:create',
		'incidents:edit',
		'incidents:assign',
		'incidents:delete',
		'incidents:classify',
		'incidents:override_priority'
	],
	organization_admin: [
		'organization:manage',
		'users:manage',
		'categories:manage',
		'sla:manage',
		'incidents:view_all',
		'incidents:view_internal_notes',
		'incidents:add_internal_note',
		'incidents:create',
		'incidents:edit',
		'incidents:assign',
		'incidents:delete',
		'incidents:classify',
		'incidents:override_priority'
	],
	technician: [
		'incidents:view_all',
		'incidents:view_internal_notes',
		'incidents:add_internal_note',
		'incidents:create',
		'incidents:edit',
		'incidents:assign',
		'incidents:classify'
	],
	client: ['incidents:view_own', 'incidents:create']
};

export function hasPermission(user: AppUser | null | undefined, permission: Permission): boolean {
	return !!user?.active && rolePermissions[user.role].includes(permission);
}

export function canAccessOrganization(
	user: AppUser | null | undefined,
	organizationId: string
): boolean {
	if (!user?.active) return false;
	if (user.role === 'platform_admin') return true;

	return user.organizationId === organizationId;
}

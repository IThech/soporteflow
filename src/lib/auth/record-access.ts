import { canAccessOrganization, hasPermission, type Permission } from './permissions';
import { demoOrganization } from '$lib/data/organizations';
import type { AppUser } from '$lib/types/user';
import type { Incident } from '$lib/types/incident';

// The original single-organization demo belongs to Nodhouses. Never infer
// ownership from the selected session, and never persist this legacy fallback.
export function canAccessRecord(user: AppUser, record: { organizationId?: string }): boolean {
	return canAccessOrganization(user, record.organizationId ?? demoOrganization.id);
}

export function canViewIncident(user: AppUser, incident: Incident): boolean {
	return (
		canAccessRecord(user, incident) &&
		(hasPermission(user, 'incidents:view_all') ||
			(hasPermission(user, 'incidents:view_own') && incident.clientUserId === user.id))
	);
}

export function canActOnIncident(
	user: AppUser,
	incident: Incident,
	permission: Permission
): boolean {
	return canViewIncident(user, incident) && hasPermission(user, permission);
}

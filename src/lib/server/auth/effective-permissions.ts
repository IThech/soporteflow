import {
	resolveOrganizationPermissions,
	verifyOrganizationMembership,
	type PermissionGrant
} from './authorization';
import { PERMISSION_IDS, type PermissionId } from './permissions';

/**
 * Canonical organization-scoped capabilities from a set of grants, in catalog order. Shared by
 * resolveEffectivePermissions and the in-transaction re-validation (transactional-authorization).
 */
export function organizationScopedPermissions(list: readonly PermissionGrant[]): PermissionId[] {
	const granted = new Set(
		list.filter((grant) => grant.scope === 'organization').map((grant) => grant.permissionId)
	);
	return PERMISSION_IDS.filter((permissionId) => granted.has(permissionId));
}

/**
 * Effective capabilities of the authenticated principal in one organization (5.4Q-D).
 *
 * Built on the same primitives as authorizeAction, so the rules are identical:
 * - active user, active membership and active organization (verifyOrganizationMembership);
 * - grants come only from role_permissions of active roles reached through role_assignments
 *   (never role_template_permissions, role codes or role names);
 * - allowed_scope_types is respected and platform:* is excluded upstream.
 * On top of that, capabilities are restricted to what HTTP can actually authorize today:
 * organization-scoped grants of canonical catalog ids only (site/team/department/personal
 * grants and unknown/non-canonical ids are never exposed). Unique, in catalog order. No cache.
 *
 * Returns null when the organization is not accessible to the principal (callers must not
 * distinguish missing, foreign or suspended organizations), and [] when accessible without grants.
 */
export async function resolveEffectivePermissions(
	headers: Headers,
	organizationId: string
): Promise<PermissionId[] | null> {
	const membership = await verifyOrganizationMembership(headers, organizationId);
	if (!membership) return null;
	return organizationScopedPermissions(
		await resolveOrganizationPermissions(headers, organizationId)
	);
}

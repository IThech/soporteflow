import { json } from '@sveltejs/kit';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import { IncidentServiceError } from '$lib/server/services/incidents';
import type { AdminRoleRecord } from '$lib/server/services/roles';

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { 'Cache-Control': 'private, no-store' };

export function failure(status: number, code: string, message: string) {
	return json({ error: { code, message } }, { status, headers: noStore });
}

export function success(body: unknown, status = 200) {
	return json(body, { status, headers: noStore });
}

/** Rejects unknown or repeated query parameters. */
export function onlyKeys(params: URLSearchParams, allowed: string[]): boolean {
	for (const key of params.keys()) {
		if (!allowed.includes(key) || params.getAll(key).length !== 1) return false;
	}
	return true;
}

/**
 * Session + roles:view on the requested organization. Authorization is by capability only,
 * never by role code or name. Returns a Response on failure, null when allowed.
 */
export async function requireRolesView(
	headers: Headers,
	organizationId: string
): Promise<Response | null> {
	const principal = await resolvePrincipal(headers);
	if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
	if (!(await authorizeAction(headers, { organizationId, permissionId: 'roles:view' })))
		return failure(403, 'FORBIDDEN', 'Permission denied.');
	return null;
}

/** Explicit allowlist: never organizationId, assignments or template permissions. */
export function toRoleDto(role: AdminRoleRecord) {
	return {
		id: role.id,
		code: role.code,
		name: role.name,
		description: role.description,
		templateId: role.templateId,
		isCustom: role.isCustom,
		active: role.active,
		permissions: [...role.permissions]
	};
}

/** Maps service errors to stable client messages; never forwards driver or SQL details. */
export function roleServiceFailure(error: unknown) {
	if (error instanceof IncidentServiceError) {
		if (error.code === 'INVALID_INPUT') return failure(400, 'INVALID_INPUT', 'Invalid request.');
		if (error.code === 'ROLE_NOT_FOUND') return failure(404, 'ROLE_NOT_FOUND', 'Role not found.');
	}
	return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
}

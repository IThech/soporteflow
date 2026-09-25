import { json } from '@sveltejs/kit';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import { IncidentServiceError } from '$lib/server/services/incidents';
import { resolveEffectivePermissions } from '$lib/server/auth/effective-permissions';
import type { PermissionId } from '$lib/server/auth/permissions';
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
	return requireRolesPermission(headers, organizationId, 'roles:view');
}

async function requireRolesPermission(
	headers: Headers,
	organizationId: string,
	permissionId: 'roles:view' | 'roles:manage'
): Promise<Response | null> {
	const principal = await resolvePrincipal(headers);
	if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
	if (!(await authorizeAction(headers, { organizationId, permissionId })))
		return failure(403, 'FORBIDDEN', 'Permission denied.');
	return null;
}

/**
 * Session + roles:manage on the organization, then the actor's real effective permissions there
 * (used for monotonic delegation; never assumed from the role code). Resolved before the mutation,
 * so a change to the actor's own role cannot widen what it may grant in the same request.
 */
export async function requireRolesManage(
	headers: Headers,
	organizationId: string
): Promise<{ denied: Response } | { actorPermissions: PermissionId[] }> {
	const denied = await requireRolesPermission(headers, organizationId, 'roles:manage');
	if (denied) return { denied };
	const actorPermissions = await resolveEffectivePermissions(headers, organizationId);
	if (!actorPermissions) return { denied: failure(403, 'FORBIDDEN', 'Permission denied.') };
	return { actorPermissions };
}

/**
 * Strict JSON object body: must be application/json, a plain object, and contain only allowed keys.
 * Returns null on any violation (the caller answers 400 without echoing the payload).
 */
export async function readJsonObject(
	request: Request,
	allowed: readonly string[]
): Promise<Record<string, unknown> | null> {
	const contentType = request.headers.get('content-type') ?? '';
	if (!/^application\/json\s*(;|$)/i.test(contentType)) return null;
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return null;
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
	if (Object.keys(body).some((key) => !allowed.includes(key))) return null;
	return body as Record<string, unknown>;
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
		if (error.code === 'ROLE_CODE_CONFLICT')
			return failure(409, 'ROLE_CODE_CONFLICT', 'Role code is already in use.');
		if (error.code === 'SYSTEM_ROLE_IMMUTABLE')
			return failure(409, 'SYSTEM_ROLE_IMMUTABLE', 'System roles cannot be modified.');
		if (error.code === 'ROLE_HAS_UNKNOWN_PERMISSIONS')
			return failure(409, 'ROLE_HAS_UNKNOWN_PERMISSIONS', 'Role permissions cannot be replaced.');
		if (error.code === 'PERMISSION_NOT_DELEGABLE')
			return failure(403, 'PERMISSION_NOT_DELEGABLE', 'Permission cannot be delegated.');
		if (error.code === 'ORGANIZATION_NOT_FOUND' || error.code === 'ORGANIZATION_NOT_OPERATIONAL')
			return failure(403, 'FORBIDDEN', 'Permission denied.');
	}
	return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
}

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
	return requireCapability(headers, organizationId, 'roles:view');
}

/**
 * Session (401) + one capability on the organization (403). A missing, foreign or suspended
 * organization is indistinguishable (403). Shared by role and membership administration.
 */
export async function requireCapability(
	headers: Headers,
	organizationId: string,
	permissionId: PermissionId
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
	return requireDelegatingActor(headers, organizationId, 'roles:manage');
}

/** requireCapability + the actor's effective permissions for monotonic delegation. */
export async function requireDelegatingActor(
	headers: Headers,
	organizationId: string,
	permissionId: PermissionId
): Promise<{ denied: Response } | { actorPermissions: PermissionId[] }> {
	const denied = await requireCapability(headers, organizationId, permissionId);
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

/**
 * Maps role and membership administration service errors to stable client messages; never
 * forwards driver or SQL details. Wrong-tenant or missing resources are 404; an inaccessible
 * organization is 403.
 */
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
		if (error.code === 'MEMBERSHIP_NOT_FOUND')
			return failure(404, 'MEMBERSHIP_NOT_FOUND', 'Membership not found.');
		if (error.code === 'ROLE_ASSIGNMENT_NOT_FOUND')
			return failure(404, 'ROLE_ASSIGNMENT_NOT_FOUND', 'Role assignment not found.');
		if (error.code === 'MEMBERSHIP_INACTIVE')
			return failure(409, 'MEMBERSHIP_INACTIVE', 'Membership is not active.');
		if (error.code === 'ROLE_INACTIVE') return failure(409, 'ROLE_INACTIVE', 'Role is not active.');
		if (error.code === 'LAST_ADMIN_REQUIRED')
			return failure(
				409,
				'LAST_ADMIN_REQUIRED',
				'The organization must keep at least one administrator.'
			);
		if (error.code === 'PERMISSION_NOT_DELEGABLE')
			return failure(403, 'PERMISSION_NOT_DELEGABLE', 'Permission cannot be delegated.');
		// Invitations (5.4S-C)
		if (error.code === 'INVITATION_NOT_FOUND')
			return failure(404, 'INVITATION_NOT_FOUND', 'Invitation not found.');
		if (error.code === 'INVITATION_ALREADY_PENDING')
			return failure(
				409,
				'INVITATION_ALREADY_PENDING',
				'A pending invitation already exists for this email.'
			);
		if (error.code === 'INVITATION_NOT_REVOCABLE')
			return failure(409, 'INVITATION_NOT_REVOCABLE', 'Invitation cannot be revoked.');
		if (error.code === 'INVITATION_NOT_RESENDABLE')
			return failure(409, 'INVITATION_NOT_RESENDABLE', 'Invitation cannot be resent.');
		if (error.code === 'ALREADY_MEMBER')
			return failure(409, 'ALREADY_MEMBER', 'Already a member of the organization.');
		if (error.code === 'EMAIL_DELIVERY_FAILED')
			return failure(
				502,
				'EMAIL_DELIVERY_FAILED',
				'The invitation was saved but the email could not be delivered.'
			);
		if (error.code === 'ORGANIZATION_NOT_FOUND' || error.code === 'ORGANIZATION_NOT_OPERATIONAL')
			return failure(403, 'FORBIDDEN', 'Permission denied.');
	}
	return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
}

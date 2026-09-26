import { authorizeAction } from '$lib/server/auth/authorization';
import type { PermissionId } from '$lib/server/auth/permissions';
import type { InvitationRecord } from '$lib/server/services/invitations';
import { failure, requireDelegatingActor } from '../roles/http';

export {
	failure,
	onlyKeys,
	readJsonObject,
	requireCapability,
	roleServiceFailure as adminServiceFailure,
	success,
	uuid
} from '../roles/http';

/**
 * Issuing an invitation (create or resend) is a deferred role assignment, so it requires
 * invitations:create AND roles:assign, plus the actor's effective permissions for monotonic
 * delegation of the invited role (checked by the service). Never decided by role code.
 */
export async function requireInvitationIssuer(
	headers: Headers,
	organizationId: string
): Promise<{ denied: Response } | { actorPermissions: PermissionId[] }> {
	const auth = await requireDelegatingActor(headers, organizationId, 'invitations:create');
	if ('denied' in auth) return auth;
	if (!(await authorizeAction(headers, { organizationId, permissionId: 'roles:assign' })))
		return { denied: failure(403, 'FORBIDDEN', 'Permission denied.') };
	return auth;
}

/** Explicit allowlist: never token, token hash, organizationId or auth/session data. */
export function toInvitationDto(invitation: InvitationRecord) {
	return {
		id: invitation.id,
		email: invitation.email,
		status: invitation.status,
		expiresAt: invitation.expiresAt.toISOString(),
		acceptedAt: invitation.acceptedAt ? invitation.acceptedAt.toISOString() : null,
		createdAt: invitation.createdAt.toISOString(),
		updatedAt: invitation.updatedAt.toISOString(),
		role: {
			id: invitation.role.id,
			code: invitation.role.code,
			name: invitation.role.name,
			active: invitation.role.active
		},
		invitedBy: { id: invitation.invitedBy.id, name: invitation.invitedBy.name }
	};
}

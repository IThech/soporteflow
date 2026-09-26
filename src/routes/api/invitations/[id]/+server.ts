import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getInvitation, revokeInvitation } from '$lib/server/services/invitations';
import {
	adminServiceFailure,
	failure,
	onlyKeys,
	requireCapability,
	success,
	toInvitationDto,
	uuid
} from '../http';

function ids(
	event: Parameters<RequestHandler>[0]
): { error: Response } | { organizationId: string; invitationId: string } {
	const organizationId = event.url.searchParams.get('organizationId');
	const invitationId = event.params.id;
	if (!organizationId || !uuid.test(organizationId))
		return { error: failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.') };
	if (!invitationId || !uuid.test(invitationId))
		return { error: failure(400, 'INVALID_INPUT', 'invitationId must be a valid UUID.') };
	return { organizationId, invitationId };
}

/**
 * GET /api/invitations/<id>?organizationId=<UUID>
 * Requires invitations:view. Another tenant's invitation is indistinguishable from a missing one.
 */
export const GET: RequestHandler = async (event) => {
	const parsed = ids(event);
	if ('error' in parsed) return parsed.error;
	try {
		const denied = await requireCapability(
			event.request.headers,
			parsed.organizationId,
			'invitations:view'
		);
		if (denied) return denied;
		if (!onlyKeys(event.url.searchParams, ['organizationId']))
			return failure(400, 'INVALID_INPUT', 'Invalid invitations query.');
		const invitation = await getInvitation(db, parsed.organizationId, parsed.invitationId);
		return success({ invitation: toInvitationDto(invitation) });
	} catch (error) {
		return adminServiceFailure(error);
	}
};

/**
 * DELETE /api/invitations/<id>?organizationId=<UUID>
 * Requires invitations:revoke. pending -> revoked (204); already revoked -> 204 (idempotent);
 * accepted or expired -> 409 INVITATION_NOT_REVOCABLE. The row is never deleted.
 */
export const DELETE: RequestHandler = async (event) => {
	const parsed = ids(event);
	if ('error' in parsed) return parsed.error;
	try {
		const denied = await requireCapability(
			event.request.headers,
			parsed.organizationId,
			'invitations:revoke'
		);
		if (denied) return denied;
		if (!onlyKeys(event.url.searchParams, ['organizationId']))
			return failure(400, 'INVALID_INPUT', 'Invalid invitations query.');
		await revokeInvitation(db, parsed.organizationId, parsed.invitationId);
		return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
	} catch (error) {
		return adminServiceFailure(error);
	}
};

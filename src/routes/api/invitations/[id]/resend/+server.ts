import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { getInvitationEmailSender } from '$lib/server/email/invitation-email';
import { deliverInvitation, resendInvitation } from '$lib/server/services/invitations';
import {
	adminServiceFailure,
	failure,
	onlyKeys,
	requireInvitationIssuer,
	success,
	toInvitationDto,
	uuid
} from '../../http';

/**
 * POST /api/invitations/<id>/resend?organizationId=<UUID>   (no body)
 * Same authorization as create (invitations:create + roles:assign + delegation of the role).
 * Re-issues the same invitation with a new token and expiry (the previous token stops matching)
 * and emails it after commit. pending/expired -> 200; revoked/accepted -> 409.
 */
export const POST: RequestHandler = async (event) => {
	const organizationId = event.url.searchParams.get('organizationId');
	const invitationId = event.params.id;
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	if (!invitationId || !uuid.test(invitationId))
		return failure(400, 'INVALID_INPUT', 'invitationId must be a valid UUID.');
	try {
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		const auth = await requireInvitationIssuer(event.request.headers, organizationId);
		if ('denied' in auth) return auth.denied;
		if (!onlyKeys(event.url.searchParams, ['organizationId']))
			return failure(400, 'INVALID_INPUT', 'Invalid invitations query.');
		if ((await event.request.text()).trim() !== '')
			return failure(400, 'INVALID_INPUT', 'This endpoint does not accept a body.');
		const issued = await resendInvitation(
			db,
			{ organizationId, actorUserId: principal.userId, actorPermissions: auth.actorPermissions },
			invitationId
		);
		await deliverInvitation(getInvitationEmailSender(), issued);
		return success({ invitation: toInvitationDto(issued.invitation) });
	} catch (error) {
		return adminServiceFailure(error);
	}
};

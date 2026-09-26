import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getInvitationEmailSender } from '$lib/server/email/invitation-email';
import {
	createInvitation,
	deliverInvitation,
	listInvitations,
	INVITATION_STATUSES,
	type InvitationStatus,
	type ListInvitationsFilters
} from '$lib/server/services/invitations';
import { resolvePrincipal } from '$lib/server/auth/principal';
import {
	adminServiceFailure,
	failure,
	onlyKeys,
	readJsonObject,
	requireCapability,
	requireInvitationIssuer,
	success,
	toInvitationDto,
	uuid
} from './http';

/**
 * GET /api/invitations?organizationId=<UUID>[&status=pending|accepted|revoked|expired][&email=]
 * Requires invitations:view. Newest first. Status is the effective one (expired is derived).
 */
export const GET: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	try {
		const denied = await requireCapability(
			event.request.headers,
			organizationId,
			'invitations:view'
		);
		if (denied) return denied;
		if (!onlyKeys(params, ['organizationId', 'status', 'email']))
			return failure(400, 'INVALID_INPUT', 'Invalid invitations query.');
		const filters: ListInvitationsFilters = {};
		const status = params.get('status');
		if (status !== null) {
			if (!INVITATION_STATUSES.includes(status as InvitationStatus))
				return failure(400, 'INVALID_INPUT', 'Invalid invitations query.');
			filters.status = status as InvitationStatus;
		}
		const email = params.get('email');
		if (email !== null) filters.email = email;
		const invitations = await listInvitations(db, organizationId, filters);
		return success({ invitations: invitations.map(toInvitationDto) });
	} catch (error) {
		return adminServiceFailure(error);
	}
};

/**
 * POST /api/invitations?organizationId=<UUID>   body: { email, roleId }
 * Requires invitations:create + roles:assign + delegation of the role. 201 with the safe DTO.
 * The raw token only reaches the email sender, after the database commit; if delivery fails the
 * invitation stays pending (502 EMAIL_DELIVERY_FAILED) and can be resent.
 */
export const POST: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	try {
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		const auth = await requireInvitationIssuer(event.request.headers, organizationId);
		if ('denied' in auth) return auth.denied;
		if (!onlyKeys(params, ['organizationId']))
			return failure(400, 'INVALID_INPUT', 'Invalid invitations query.');
		const body = await readJsonObject(event.request, ['email', 'roleId']);
		if (!body || typeof body.email !== 'string' || typeof body.roleId !== 'string')
			return failure(400, 'INVALID_INPUT', 'Invalid request.');
		const issued = await createInvitation(
			db,
			{ organizationId, actorUserId: principal.userId, actorPermissions: auth.actorPermissions },
			{ email: body.email, roleId: body.roleId }
		);
		await deliverInvitation(getInvitationEmailSender(), issued);
		return success({ invitation: toInvitationDto(issued.invitation) }, 201);
	} catch (error) {
		return adminServiceFailure(error);
	}
};

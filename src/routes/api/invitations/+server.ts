import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	createInvitation,
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
	INVITATION_ISSUER_PERMISSIONS,
	withActorAuthorization,
	success,
	toInvitationDto,
	QUEUED_DELIVERY,
	uuid
} from './http';
import { latestInvitationDeliveryStates } from '$lib/server/services/invitation-deliveries';
import { withAudit } from '$lib/server/services/audit-events';

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
		const deliveries = await latestInvitationDeliveryStates(
			db,
			organizationId,
			invitations.map((invitation) => invitation.id)
		);
		return success({
			invitations: invitations.map((invitation) =>
				toInvitationDto(invitation, deliveries.get(invitation.id) ?? null)
			)
		});
	} catch (error) {
		return adminServiceFailure(error);
	}
};

/**
 * POST /api/invitations?organizationId=<UUID>   body: { email, roleId }
 * Requires invitations:create + roles:assign + delegation of the role. 201 with the safe DTO.
 * 5.4X-C: the invitation, its token hash and its outbox delivery (token encrypted) are written in
 * one transaction; the email is sent by the delivery worker (never in the request). Without
 * INVITATION_TOKEN_ENCRYPTION_KEY nothing is written: 503 INVITATION_DELIVERY_NOT_CONFIGURED.
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
		// 5.4W-A (H1): issued inside a transaction that re-validates the actor after the
		// organization lock; the email is sent only after that transaction committed.
		const input = { email: body.email, roleId: body.roleId };
		const issued = await withActorAuthorization(
			db,
			{
				userId: principal.userId,
				organizationId,
				permissionIds: INVITATION_ISSUER_PERMISSIONS,
				lock: 'update'
			},
			(tx, actorPermissions) =>
				withAudit(
					tx,
					organizationId,
					principal.userId,
					() =>
						createInvitation(
							tx,
							{ organizationId, actorUserId: principal.userId, actorPermissions },
							input
						),
					// Never the token or the invitee address: ids only.
					(result) => ({
						action: 'invitation.created',
						entityType: 'invitation',
						entityId: result.invitation.id,
						metadata: { roleId: result.invitation.role.id }
					})
				)
		);
		return success({ invitation: toInvitationDto(issued.invitation, QUEUED_DELIVERY) }, 201);
	} catch (error) {
		return adminServiceFailure(error);
	}
};

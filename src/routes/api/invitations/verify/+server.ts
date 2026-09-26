import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { limitInvitationVerify } from '$lib/server/security/invitation-rate-limits';
import { verifyInvitationToken } from '$lib/server/services/invitation-acceptance';
import {
	clientAddress,
	invalidRequest,
	publicServiceFailure,
	publicSuccess,
	rateLimited,
	readPublicJson
} from '../public';

/**
 * POST /api/invitations/verify   body: { token }   (public, no session)
 * POST instead of GET so the token never travels in a URL (history, proxy logs, Referer).
 * 200 { valid: true, invitation: { organizationName, roleName, expiresAt, maskedEmail } }, or a
 * single 404 INVALID_INVITATION. Never reveals ids, the full email or whether an account exists.
 */
export const POST: RequestHandler = async (event) => {
	if ([...event.url.searchParams.keys()].length > 0) return invalidRequest();
	const body = await readPublicJson(event.request, ['token']);
	if (!body || typeof body.token !== 'string') return invalidRequest();
	const limit = limitInvitationVerify(body.token, clientAddress(event));
	if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);
	try {
		const invitation = await verifyInvitationToken(db, body.token);
		return publicSuccess({
			valid: true,
			invitation: {
				organizationName: invitation.organizationName,
				roleName: invitation.roleName,
				expiresAt: invitation.expiresAt.toISOString(),
				maskedEmail: invitation.maskedEmail
			}
		});
	} catch (error) {
		return publicServiceFailure(error);
	}
};

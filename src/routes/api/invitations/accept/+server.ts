import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { limitInvitationAccept } from '$lib/server/security/invitation-rate-limits';
import { acceptInvitation } from '$lib/server/services/invitation-acceptance';
import {
	clientAddress,
	invalidRequest,
	publicServiceFailure,
	publicSuccess,
	rateLimited,
	readPublicJson
} from '../public';

/**
 * POST /api/invitations/accept   body: { token, name?, password? }   (public; session optional)
 * The server decides the flow from invitation.email (never from a client flag):
 * - new identity: name + password required; the identity is created, no session is issued;
 * - existing identity: requires a session of that identity (401 AUTHENTICATION_REQUIRED /
 *   403 INVALID_ACCEPTOR); name/password are rejected when signed in.
 * 200 { accepted: true, organization: { name }, requiresLogin }. JSON only (no form posts); the
 * token travels only in the body. Never returns ids, roles, permissions or session tokens.
 */
export const POST: RequestHandler = async (event) => {
	if ([...event.url.searchParams.keys()].length > 0) return invalidRequest();
	const body = await readPublicJson(event.request, ['token', 'name', 'password']);
	if (!body || typeof body.token !== 'string') return invalidRequest();
	const limit = limitInvitationAccept(body.token, clientAddress(event));
	if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);
	try {
		// Optional session: null without cookie or with an invalid/expired session.
		const principal = await resolvePrincipal(event.request.headers);
		const accepted = await acceptInvitation(db, {
			token: body.token,
			principalUserId: principal?.userId ?? null,
			name: body.name,
			password: body.password
		});
		return publicSuccess({
			accepted: true,
			organization: { name: accepted.organizationName },
			requiresLogin: accepted.requiresLogin
		});
	} catch (error) {
		return publicServiceFailure(error);
	}
};

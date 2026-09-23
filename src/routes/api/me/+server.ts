import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { getAuthenticatedUserContext } from '$lib/server/services/user-context';

export const GET: RequestHandler = async (event) => {
	// 1. Authenticate with resolvePrincipal using request cookie header
	const principal = await resolvePrincipal(event.request.headers);
	if (!principal) {
		return json(
			{
				error: {
					code: 'UNAUTHORIZED',
					message: 'Authentication required.'
				}
			},
			{ status: 401 }
		);
	}

	// 2. Obtain user profile and operational organizations using strictly principal.userId
	try {
		const context = await getAuthenticatedUserContext(db, principal.userId);

		// 3. Return sanitized bootstrap context
		return json(
			{
				user: context.user,
				organizations: context.organizations
			},
			{ status: 200 }
		);
	} catch {
		// 4. Any unexpected failure or internal inconsistency after authentication returns 500
		return json(
			{
				error: {
					code: 'INTERNAL_ERROR',
					message: 'Internal server error.'
				}
			},
			{ status: 500 }
		);
	}
};

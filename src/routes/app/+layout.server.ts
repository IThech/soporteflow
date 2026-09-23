import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { db } from '$lib/server/db';
import { getAuthenticatedUserContext } from '$lib/server/services/user-context';

export const load: LayoutServerLoad = async (event) => {
	const principal = await resolvePrincipal(event.request.headers);
	if (!principal) {
		throw redirect(303, '/login');
	}

	const context = await getAuthenticatedUserContext(db, principal.userId);
	if (context.organizations.length === 0) {
		throw redirect(303, '/login?no_org=true');
	}

	return {
		userId: principal.userId
	};
};

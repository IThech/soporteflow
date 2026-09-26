import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { revokeRoleFromMembership } from '$lib/server/services/memberships';
import {
	adminServiceFailure,
	failure,
	onlyKeys,
	requireDelegatingActor,
	uuid
} from '../../../http';

/**
 * DELETE /api/memberships/<id>/roles/<roleId>?organizationId=<UUID>
 * Requires roles:assign. Removes only that organization-scoped assignment (role and membership are
 * kept). The actor must control the role (monotonic) and the tenant must keep at least one
 * administrator (409 LAST_ADMIN_REQUIRED). 204 on success.
 */
export const DELETE: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	const { id: membershipId, roleId } = event.params;
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	if (!membershipId || !uuid.test(membershipId) || !roleId || !uuid.test(roleId))
		return failure(400, 'INVALID_INPUT', 'membershipId and roleId must be valid UUIDs.');
	try {
		const auth = await requireDelegatingActor(
			event.request.headers,
			organizationId,
			'roles:assign'
		);
		if ('denied' in auth) return auth.denied;
		if (!onlyKeys(params, ['organizationId']))
			return failure(400, 'INVALID_INPUT', 'Invalid memberships query.');
		await revokeRoleFromMembership(db, organizationId, membershipId, roleId, auth.actorPermissions);
		return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
	} catch (error) {
		return adminServiceFailure(error);
	}
};

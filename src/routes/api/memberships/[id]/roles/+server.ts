import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { assignRoleToMembership } from '$lib/server/services/memberships';
import {
	adminServiceFailure,
	failure,
	onlyKeys,
	readJsonObject,
	requireDelegatingActor,
	success,
	toMembershipRoleDto,
	uuid
} from '../../http';

/**
 * POST /api/memberships/<id>/roles?organizationId=<UUID>   body: { roleId }
 * Requires roles:assign (the dedicated assignment capability). Organization-scoped assignment
 * with monotonic delegation over the actor's effective permissions. 201 when created, 200 when the
 * role was already assigned (idempotent). The response carries only the assignment, never member
 * profile data (that requires memberships:view).
 */
export const POST: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	const membershipId = event.params.id;
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	if (!membershipId || !uuid.test(membershipId))
		return failure(400, 'INVALID_INPUT', 'membershipId must be a valid UUID.');
	try {
		const auth = await requireDelegatingActor(
			event.request.headers,
			organizationId,
			'roles:assign'
		);
		if ('denied' in auth) return auth.denied;
		if (!onlyKeys(params, ['organizationId']))
			return failure(400, 'INVALID_INPUT', 'Invalid memberships query.');
		const body = await readJsonObject(event.request, ['roleId']);
		if (!body || typeof body.roleId !== 'string' || !uuid.test(body.roleId))
			return failure(400, 'INVALID_INPUT', 'Invalid request.');
		const result = await assignRoleToMembership(
			db,
			organizationId,
			membershipId,
			body.roleId,
			auth.actorPermissions
		);
		return success(
			{
				assignment: {
					membershipId: result.membershipId,
					role: toMembershipRoleDto(result.role),
					created: result.created
				}
			},
			result.created ? 201 : 200
		);
	} catch (error) {
		return adminServiceFailure(error);
	}
};

import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { assignRoleToMembership } from '$lib/server/services/memberships';
import {
	adminServiceFailure,
	failure,
	onlyKeys,
	readJsonObject,
	requireDelegatingActor,
	withActorAuthorization,
	success,
	toMembershipRoleDto,
	uuid
} from '../../http';
import { withAudit } from '$lib/server/services/audit-events';

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
		// 5.4W-A (H1): authority and delegation re-read inside the transaction, after the
		// organization lock; the pre-check snapshot above is never used for the mutation.
		const roleId = body.roleId;
		const result = await withActorAuthorization(
			db,
			{ userId: auth.userId, organizationId, permissionIds: ['roles:assign'], lock: 'update' },
			(tx, actorPermissions) =>
				withAudit(
					tx,
					organizationId,
					auth.userId,
					() => assignRoleToMembership(tx, organizationId, membershipId, roleId, actorPermissions),
					// Idempotent re-grant writes nothing, so it is not audited either.
					(assigned) =>
						assigned.created
							? {
									action: 'membership.role_granted',
									entityType: 'membership',
									entityId: membershipId,
									metadata: { roleId }
								}
							: null
				)
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

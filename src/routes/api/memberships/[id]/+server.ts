import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getOrganizationMembership } from '$lib/server/services/memberships';
import {
	adminServiceFailure,
	failure,
	onlyKeys,
	requireCapability,
	success,
	toMembershipDto,
	uuid
} from '../http';

/**
 * GET /api/memberships/<id>?organizationId=<UUID>
 * Requires memberships:view. A membership of another tenant behaves exactly like a missing one
 * (404 MEMBERSHIP_NOT_FOUND).
 */
export const GET: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	const membershipId = event.params.id;
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	if (!membershipId || !uuid.test(membershipId))
		return failure(400, 'INVALID_INPUT', 'membershipId must be a valid UUID.');
	try {
		const denied = await requireCapability(
			event.request.headers,
			organizationId,
			'memberships:view'
		);
		if (denied) return denied;
		if (!onlyKeys(params, ['organizationId']))
			return failure(400, 'INVALID_INPUT', 'Invalid memberships query.');
		const membership = await getOrganizationMembership(db, organizationId, membershipId);
		return success({ membership: toMembershipDto(membership) });
	} catch (error) {
		return adminServiceFailure(error);
	}
};

import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { listOrganizationMemberships } from '$lib/server/services/memberships';
import {
	adminServiceFailure,
	failure,
	onlyKeys,
	requireCapability,
	success,
	toMembershipDto,
	uuid
} from './http';

/**
 * GET /api/memberships?organizationId=<UUID>
 * Requires memberships:view. Lists every membership of the organization (active and inactive),
 * ordered by user name then id, each with its organization-scoped assigned roles (inactive roles
 * included with active=false: assigned is not effective). Read-only.
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
			'memberships:view'
		);
		if (denied) return denied;
		if (!onlyKeys(params, ['organizationId']))
			return failure(400, 'INVALID_INPUT', 'Invalid memberships query.');
		const memberships = await listOrganizationMemberships(db, organizationId);
		return success({ memberships: memberships.map(toMembershipDto) });
	} catch (error) {
		return adminServiceFailure(error);
	}
};

import type { RequestHandler } from '@sveltejs/kit';
import { listCanonicalPermissions } from '$lib/server/services/roles';
import {
	failure,
	onlyKeys,
	requireRolesView,
	roleServiceFailure,
	success,
	uuid
} from '../roles/http';

/**
 * GET /api/permissions?organizationId=<UUID>
 * Requires roles:view in the organization. Returns the canonical permission catalog only
 * (never platform:* or unknown database rows), in catalog order, for role administration.
 */
export const GET: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	try {
		const denied = await requireRolesView(event.request.headers, organizationId);
		if (denied) return denied;
		if (!onlyKeys(params, ['organizationId']))
			return failure(400, 'INVALID_INPUT', 'Invalid permissions query.');
		return success({ permissions: listCanonicalPermissions() });
	} catch (error) {
		return roleServiceFailure(error);
	}
};

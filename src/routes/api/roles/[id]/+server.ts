import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getOrganizationRole } from '$lib/server/services/roles';
import {
	failure,
	onlyKeys,
	requireRolesView,
	roleServiceFailure,
	success,
	toRoleDto,
	uuid
} from '../http';

/**
 * GET /api/roles/<id>?organizationId=<UUID>
 * Requires roles:view. A role of another tenant behaves exactly like a missing role (404).
 */
export const GET: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	const roleId = event.params.id;
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	if (!roleId || !uuid.test(roleId))
		return failure(400, 'INVALID_INPUT', 'roleId must be a valid UUID.');
	try {
		const denied = await requireRolesView(event.request.headers, organizationId);
		if (denied) return denied;
		if (!onlyKeys(params, ['organizationId']))
			return failure(400, 'INVALID_INPUT', 'Invalid roles query.');
		const role = await getOrganizationRole(db, organizationId, roleId);
		return success({ role: toRoleDto(role) });
	} catch (error) {
		return roleServiceFailure(error);
	}
};

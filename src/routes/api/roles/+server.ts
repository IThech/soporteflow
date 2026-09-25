import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { listOrganizationRoles } from '$lib/server/services/roles';
import {
	failure,
	onlyKeys,
	requireRolesView,
	roleServiceFailure,
	success,
	toRoleDto,
	uuid
} from './http';

/**
 * GET /api/roles?organizationId=<UUID>[&activeOnly=true|false]
 * Requires roles:view. Lists system and custom roles of the organization, active and inactive by
 * default, each with its real role_permissions (canonical ids, catalog order). Read-only (5.4R-A).
 */
export const GET: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	try {
		const denied = await requireRolesView(event.request.headers, organizationId);
		if (denied) return denied;
		const activeOnly = params.get('activeOnly');
		if (
			!onlyKeys(params, ['organizationId', 'activeOnly']) ||
			(activeOnly !== null && activeOnly !== 'true' && activeOnly !== 'false')
		)
			return failure(400, 'INVALID_INPUT', 'Invalid roles query.');
		const roles = await listOrganizationRoles(db, organizationId, {
			activeOnly: activeOnly === 'true'
		});
		return success({ roles: roles.map(toRoleDto) });
	} catch (error) {
		return roleServiceFailure(error);
	}
};

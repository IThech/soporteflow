import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { createCustomRole, listOrganizationRoles } from '$lib/server/services/roles';
import {
	failure,
	onlyKeys,
	readJsonObject,
	requireRolesManage,
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

/**
 * POST /api/roles?organizationId=<UUID>
 * Requires roles:manage. Body: { name, code, description?, permissions }. Creates an active custom
 * role (isCustom=true, templateId=null); every permission must be held by the actor (monotonic
 * delegation). 201 with the same DTO as the read model.
 */
export const POST: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	try {
		const auth = await requireRolesManage(event.request.headers, organizationId);
		if ('denied' in auth) return auth.denied;
		if (!onlyKeys(params, ['organizationId']))
			return failure(400, 'INVALID_INPUT', 'Invalid roles query.');
		const body = await readJsonObject(event.request, [
			'name',
			'code',
			'description',
			'permissions'
		]);
		if (!body) return failure(400, 'INVALID_INPUT', 'Invalid request.');
		const role = await createCustomRole(db, organizationId, auth.actorPermissions, {
			name: body.name,
			code: body.code,
			description: body.description,
			permissions: body.permissions
		});
		return success({ role: toRoleDto(role) }, 201);
	} catch (error) {
		return roleServiceFailure(error);
	}
};

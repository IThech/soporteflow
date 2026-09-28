import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getOrganizationRole, updateCustomRole } from '$lib/server/services/roles';
import {
	failure,
	onlyKeys,
	readJsonObject,
	requireRolesManage,
	requireRolesView,
	roleServiceFailure,
	success,
	toRoleDto,
	uuid,
	withActorAuthorization
} from '../http';
import { withAudit } from '$lib/server/services/audit-events';

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

/**
 * PATCH /api/roles/<id>?organizationId=<UUID>
 * Requires roles:manage. Partial update of a custom role: name, description, permissions (full
 * replacement of the canonical set) and active. code is immutable; system roles answer 409
 * SYSTEM_ROLE_IMMUTABLE; a role of another tenant answers 404. Empty body or unknown keys: 400.
 */
export const PATCH: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	const roleId = event.params.id;
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	if (!roleId || !uuid.test(roleId))
		return failure(400, 'INVALID_INPUT', 'roleId must be a valid UUID.');
	try {
		const auth = await requireRolesManage(event.request.headers, organizationId);
		if ('denied' in auth) return auth.denied;
		if (!onlyKeys(params, ['organizationId']))
			return failure(400, 'INVALID_INPUT', 'Invalid roles query.');
		const body = await readJsonObject(event.request, [
			'name',
			'description',
			'permissions',
			'active'
		]);
		if (!body || Object.keys(body).length === 0)
			return failure(400, 'INVALID_INPUT', 'Invalid request.');
		// 5.4W-A (H1): authority and delegation re-read inside the transaction, after the
		// organization lock (FOR UPDATE, as updateCustomRole takes it).
		const role = await withActorAuthorization(
			db,
			{ userId: auth.userId, organizationId, permissionIds: ['roles:manage'], lock: 'update' },
			(tx, actorPermissions) =>
				withAudit(
					tx,
					organizationId,
					auth.userId,
					() =>
						updateCustomRole(tx, organizationId, roleId, actorPermissions, {
							name: body.name,
							description: body.description,
							permissions: body.permissions,
							active: body.active
						}),
					(updated) => ({
						action: 'role.updated',
						entityType: 'role',
						entityId: updated.id,
						metadata: {
							fields: Object.keys(body).filter(
								(k) => (body as Record<string, unknown>)[k] !== undefined
							),
							active: updated.active,
							permissionIds: [...updated.permissions]
						}
					})
				)
		);
		return success({ role: toRoleDto(role) });
	} catch (error) {
		return roleServiceFailure(error);
	}
};

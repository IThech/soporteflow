import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { withActorAuthorization } from '$lib/server/auth/transactional-authorization';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import { setSubcategoryActive, updateSubcategory } from '$lib/server/services/subcategories';
import {
	categoryServiceFailure,
	failure,
	isDescription,
	onlyKeys,
	readJsonObject,
	success,
	toSubcategoryDto,
	uuid
} from '../../categories/http';
import { withAudit } from '$lib/server/services/audit-events';

/**
 * PATCH /api/subcategories/<id>?organizationId=<UUID> with a discriminated body:
 *   { "action": "update", "name"?: string, "description"?: string | null }
 *   { "action": "set_active", "active": true | false }
 * Operations are never mixed. Requires categories:manage.
 */
export const PATCH: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	const subcategoryId = event.params.id;
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	if (!subcategoryId || !uuid.test(subcategoryId))
		return failure(400, 'INVALID_INPUT', 'subcategoryId must be a valid UUID.');
	if (!onlyKeys(params, ['organizationId']))
		return failure(400, 'INVALID_INPUT', 'Invalid subcategories query.');
	try {
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		if (
			!(await authorizeAction(event.request.headers, {
				organizationId,
				permissionId: 'categories:manage'
			}))
		)
			return failure(403, 'FORBIDDEN', 'Permission denied.');

		const payload = await readJsonObject(event.request);
		if (payload instanceof Response) return payload;
		const keys = Object.keys(payload);

		if (payload.action === 'update') {
			const fields = keys.filter((key) => key !== 'action');
			if (
				fields.length === 0 ||
				fields.some((key) => key !== 'name' && key !== 'description') ||
				('name' in payload && typeof payload.name !== 'string') ||
				('description' in payload && !isDescription(payload.description))
			)
				return failure(
					400,
					'INVALID_INPUT',
					'update requires { action, name?, description? } with at least one field.'
				);
			const subcategory = await withActorAuthorization(
				db,
				{
					userId: principal.userId,
					organizationId,
					permissionIds: ['categories:manage'],
					lock: 'share'
				},
				(tx) =>
					withAudit(
						tx,
						organizationId,
						principal.userId,
						() =>
							updateSubcategory(tx, organizationId, subcategoryId, {
								...('name' in payload ? { name: payload.name as string } : {}),
								...('description' in payload
									? { description: payload.description as string | null }
									: {})
							}),
						() => ({
							action: 'subcategory.updated',
							entityType: 'subcategory',
							entityId: subcategoryId,
							metadata: { fields: fields.filter((key) => key !== 'action') }
						})
					)
			);
			return success({ subcategory: toSubcategoryDto(subcategory) });
		}
		if (payload.action === 'set_active') {
			if (keys.length !== 2 || !('active' in payload) || typeof payload.active !== 'boolean')
				return failure(400, 'INVALID_INPUT', 'set_active requires exactly { action, active }.');
			const active = payload.active;
			const subcategory = await withActorAuthorization(
				db,
				{
					userId: principal.userId,
					organizationId,
					permissionIds: ['categories:manage'],
					lock: 'share'
				},
				(tx) =>
					withAudit(
						tx,
						organizationId,
						principal.userId,
						() => setSubcategoryActive(tx, organizationId, subcategoryId, active),
						() => ({
							action: active ? 'subcategory.activated' : 'subcategory.deactivated',
							entityType: 'subcategory',
							entityId: subcategoryId
						})
					)
			);
			return success({ subcategory: toSubcategoryDto(subcategory) });
		}
		return failure(400, 'INVALID_INPUT', "action must be 'update' or 'set_active'.");
	} catch (error) {
		return categoryServiceFailure(error);
	}
};

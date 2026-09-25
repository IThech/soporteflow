import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import { setCategoryActive, updateCategory } from '$lib/server/services/categories';
import {
	categoryServiceFailure,
	failure,
	isDescription,
	onlyKeys,
	readJsonObject,
	success,
	toCategoryDto,
	uuid
} from '../http';

/**
 * PATCH /api/categories/<id>?organizationId=<UUID> with a discriminated body:
 *   { "action": "update", "name"?: string, "description"?: string | null }  (at least one)
 *   { "action": "set_active", "active": true | false }
 * Operations are never mixed. Requires categories:manage. A category of another tenant
 * behaves exactly like a missing category (404).
 */
export const PATCH: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	const categoryId = event.params.id;
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	if (!categoryId || !uuid.test(categoryId))
		return failure(400, 'INVALID_INPUT', 'categoryId must be a valid UUID.');
	if (!onlyKeys(params, ['organizationId']))
		return failure(400, 'INVALID_INPUT', 'Invalid categories query.');
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
			const category = await updateCategory(db, organizationId, categoryId, {
				...('name' in payload ? { name: payload.name } : {}),
				...('description' in payload ? { description: payload.description } : {})
			});
			return success({ category: toCategoryDto(category) });
		}
		if (payload.action === 'set_active') {
			if (keys.length !== 2 || !('active' in payload) || typeof payload.active !== 'boolean')
				return failure(400, 'INVALID_INPUT', 'set_active requires exactly { action, active }.');
			const category = await setCategoryActive(db, organizationId, categoryId, payload.active);
			return success({ category: toCategoryDto(category) });
		}
		return failure(400, 'INVALID_INPUT', "action must be 'update' or 'set_active'.");
	} catch (error) {
		return categoryServiceFailure(error);
	}
};

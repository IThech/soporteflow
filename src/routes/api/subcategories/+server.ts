import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { withActorAuthorization } from '$lib/server/auth/transactional-authorization';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import { createSubcategory, listSubcategories } from '$lib/server/services/subcategories';
import {
	categoryServiceFailure,
	failure,
	isDescription,
	onlyKeys,
	readJsonObject,
	success,
	toSubcategoryDto,
	uuid
} from '../categories/http';
import { withAudit } from '$lib/server/services/audit-events';

/**
 * GET /api/subcategories?organizationId=<UUID>[&categoryId=<UUID>][&activeOnly=true|false]
 * Requires categories:view. Inactive subcategories are included unless activeOnly=true.
 */
export const GET: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	try {
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		if (
			!(await authorizeAction(event.request.headers, {
				organizationId,
				permissionId: 'categories:view'
			}))
		)
			return failure(403, 'FORBIDDEN', 'Permission denied.');

		const activeOnly = params.get('activeOnly');
		const categoryId = params.get('categoryId');
		if (
			!onlyKeys(params, ['organizationId', 'categoryId', 'activeOnly']) ||
			(activeOnly !== null && activeOnly !== 'true' && activeOnly !== 'false') ||
			(categoryId !== null && !uuid.test(categoryId))
		)
			return failure(400, 'INVALID_INPUT', 'Invalid subcategories query.');

		const subcategories = await listSubcategories(db, organizationId, {
			...(categoryId ? { categoryId } : {}),
			activeOnly: activeOnly === 'true'
		});
		return success({ subcategories: subcategories.map(toSubcategoryDto) });
	} catch (error) {
		return categoryServiceFailure(error);
	}
};

/**
 * POST /api/subcategories?organizationId=<UUID> with body { categoryId, name, description? }.
 * Requires categories:manage. Tenant comes only from query; identity only from session.
 */
export const POST: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
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
		for (const key of Object.keys(payload)) {
			if (key !== 'categoryId' && key !== 'name' && key !== 'description')
				return failure(400, 'INVALID_INPUT', `Unknown property '${key}'.`);
		}
		if (typeof payload.categoryId !== 'string' || !uuid.test(payload.categoryId))
			return failure(400, 'INVALID_INPUT', 'categoryId must be a valid UUID.');
		if (typeof payload.name !== 'string')
			return failure(400, 'INVALID_INPUT', 'name must be a string.');
		if ('description' in payload && !isDescription(payload.description))
			return failure(400, 'INVALID_INPUT', 'description must be a string or null.');

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
						createSubcategory(tx, organizationId, payload.categoryId as string, {
							name: payload.name as string,
							...('description' in payload
								? { description: payload.description as string | null }
								: {})
						}),
					(created) => ({
						action: 'subcategory.created',
						entityType: 'subcategory',
						entityId: created.id,
						metadata: { categoryId: created.categoryId }
					})
				)
		);
		return success({ subcategory: toSubcategoryDto(subcategory) }, 201);
	} catch (error) {
		return categoryServiceFailure(error);
	}
};

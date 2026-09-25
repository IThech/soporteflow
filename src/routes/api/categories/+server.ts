import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import { createCategory, listCategories } from '$lib/server/services/categories';
import {
	categoryServiceFailure,
	failure,
	isDescription,
	onlyKeys,
	readJsonObject,
	success,
	toCategoryDto,
	uuid
} from './http';

/**
 * GET /api/categories?organizationId=<UUID>[&activeOnly=true|false]
 * Requires categories:view. Inactive categories are included unless activeOnly=true.
 * Authentication and authorization precede query validation beyond organizationId.
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
		if (
			!onlyKeys(params, ['organizationId', 'activeOnly']) ||
			(activeOnly !== null && activeOnly !== 'true' && activeOnly !== 'false')
		)
			return failure(400, 'INVALID_INPUT', 'Invalid categories query.');

		const categories = await listCategories(db, organizationId, {
			activeOnly: activeOnly === 'true'
		});
		return success({ categories: categories.map(toCategoryDto) });
	} catch (error) {
		return categoryServiceFailure(error);
	}
};

/**
 * POST /api/categories?organizationId=<UUID> with body exactly { name, description? }.
 * Requires categories:manage. Tenant comes only from the query; identity only from the session.
 */
export const POST: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
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
		for (const key of Object.keys(payload)) {
			if (key !== 'name' && key !== 'description')
				return failure(400, 'INVALID_INPUT', `Unknown property '${key}'.`);
		}
		if (typeof payload.name !== 'string')
			return failure(400, 'INVALID_INPUT', 'name must be a string.');
		if ('description' in payload && !isDescription(payload.description))
			return failure(400, 'INVALID_INPUT', 'description must be a string or null.');

		const category = await createCategory(db, organizationId, {
			name: payload.name,
			...('description' in payload ? { description: payload.description } : {})
		});
		return success({ category: toCategoryDto(category) }, 201);
	} catch (error) {
		return categoryServiceFailure(error);
	}
};

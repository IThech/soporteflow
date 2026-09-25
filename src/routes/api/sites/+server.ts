import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import { createSite, listSites } from '$lib/server/services/sites';
import {
	failure,
	onlyKeys,
	readJsonObject,
	siteServiceFailure,
	success,
	toSiteDto,
	uuid
} from './http';

/**
 * GET /api/sites?organizationId=<UUID>[&activeOnly=true|false]
 * Requires sites:view. Inactive sites are included unless activeOnly=true.
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
				permissionId: 'sites:view'
			}))
		)
			return failure(403, 'FORBIDDEN', 'Permission denied.');

		const activeOnly = params.get('activeOnly');
		if (
			!onlyKeys(params, ['organizationId', 'activeOnly']) ||
			(activeOnly !== null && activeOnly !== 'true' && activeOnly !== 'false')
		)
			return failure(400, 'INVALID_INPUT', 'Invalid sites query.');

		const sites = await listSites(db, organizationId, { activeOnly: activeOnly === 'true' });
		return success({ sites: sites.map(toSiteDto) });
	} catch (error) {
		return siteServiceFailure(error);
	}
};

/**
 * POST /api/sites?organizationId=<UUID> with body exactly { name }.
 * Requires sites:manage. Tenant comes only from the query; identity only from the session.
 */
export const POST: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	if (!onlyKeys(params, ['organizationId']))
		return failure(400, 'INVALID_INPUT', 'Invalid sites query.');
	try {
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		if (
			!(await authorizeAction(event.request.headers, {
				organizationId,
				permissionId: 'sites:manage'
			}))
		)
			return failure(403, 'FORBIDDEN', 'Permission denied.');

		const payload = await readJsonObject(event.request);
		if (payload instanceof Response) return payload;
		for (const key of Object.keys(payload)) {
			if (key !== 'name') return failure(400, 'INVALID_INPUT', `Unknown property '${key}'.`);
		}
		if (typeof payload.name !== 'string')
			return failure(400, 'INVALID_INPUT', 'name must be a string.');

		const site = await createSite(db, organizationId, { name: payload.name });
		return success({ site: toSiteDto(site) }, 201);
	} catch (error) {
		return siteServiceFailure(error);
	}
};

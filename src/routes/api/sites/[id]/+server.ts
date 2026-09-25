import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import { setSiteActive, updateSite } from '$lib/server/services/sites';
import {
	failure,
	onlyKeys,
	readJsonObject,
	siteServiceFailure,
	success,
	toSiteDto,
	uuid
} from '../http';

/**
 * PATCH /api/sites/<id>?organizationId=<UUID> with a discriminated body:
 *   { "action": "rename", "name": "..." }
 *   { "action": "set_active", "active": true | false }
 * Operations are never mixed. Requires sites:manage. A site of another tenant behaves
 * exactly like a missing site (404).
 */
export const PATCH: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	const siteId = event.params.id;
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	if (!siteId || !uuid.test(siteId))
		return failure(400, 'INVALID_INPUT', 'siteId must be a valid UUID.');
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
		const keys = Object.keys(payload).sort().join(',');

		if (payload.action === 'rename') {
			if (keys !== 'action,name' || typeof payload.name !== 'string')
				return failure(400, 'INVALID_INPUT', 'rename requires exactly { action, name }.');
			const site = await updateSite(db, organizationId, siteId, { name: payload.name });
			return success({ site: toSiteDto(site) });
		}
		if (payload.action === 'set_active') {
			if (keys !== 'action,active' || typeof payload.active !== 'boolean')
				return failure(400, 'INVALID_INPUT', 'set_active requires exactly { action, active }.');
			const site = await setSiteActive(db, organizationId, siteId, payload.active);
			return success({ site: toSiteDto(site) });
		}
		return failure(400, 'INVALID_INPUT', "action must be 'rename' or 'set_active'.");
	} catch (error) {
		return siteServiceFailure(error);
	}
};

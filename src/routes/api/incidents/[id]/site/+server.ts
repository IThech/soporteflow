import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import { changeIncidentSite, IncidentServiceError } from '$lib/server/services/incidents';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { 'Cache-Control': 'private, no-store' };
function failure(status: number, code: string, message: string) {
	return json({ error: { code, message } }, { status, headers: noStore });
}

/**
 * PATCH /api/incidents/<id>/site?organizationId=<UUID>
 * Body exactly { siteId: UUID | null, reason?: string }.
 * Requires incidents:edit (same capability as status, priority and support level changes);
 * sites:manage administers the catalog and does not grant incident edits.
 * Route/tenant ids are validated first; authentication and authorization precede body validation.
 */
export const PATCH: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	const incidentId = event.params.id;
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	if (!incidentId || !uuid.test(incidentId))
		return failure(400, 'INVALID_INPUT', 'incidentId must be a valid UUID.');
	for (const key of params.keys()) {
		if (key !== 'organizationId' || params.getAll(key).length !== 1)
			return failure(400, 'INVALID_INPUT', 'Invalid site change query.');
	}
	try {
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		if (
			!(await authorizeAction(event.request.headers, {
				organizationId,
				permissionId: 'incidents:edit'
			}))
		)
			return failure(403, 'FORBIDDEN', 'Permission denied.');

		let payload: unknown;
		try {
			payload = await event.request.json();
		} catch {
			return failure(400, 'INVALID_INPUT', 'Invalid JSON body.');
		}
		if (!payload || typeof payload !== 'object' || Array.isArray(payload))
			return failure(400, 'INVALID_INPUT', 'Body must be a JSON object.');
		for (const key of Object.keys(payload)) {
			if (key !== 'siteId' && key !== 'reason')
				return failure(400, 'INVALID_INPUT', `Unknown property '${key}'.`);
		}
		const { siteId, reason } = payload as { siteId?: unknown; reason?: unknown };
		if (
			!('siteId' in payload) ||
			(siteId !== null && (typeof siteId !== 'string' || !uuid.test(siteId)))
		)
			return failure(400, 'INVALID_INPUT', 'siteId must be a valid UUID or null.');
		if (reason !== undefined && typeof reason !== 'string')
			return failure(400, 'INVALID_INPUT', 'reason must be a string.');

		const result = await changeIncidentSite(
			db,
			{ organizationId, actorUserId: principal.userId },
			incidentId,
			{ siteId: siteId as string | null, reason: reason as string | undefined }
		);
		return json({ incident: result.incident }, { status: 200, headers: noStore });
	} catch (error) {
		if (error instanceof IncidentServiceError) {
			if (error.code === 'INVALID_INPUT') return failure(400, 'INVALID_INPUT', error.message + '.');
			if (error.code === 'INCIDENT_NOT_FOUND')
				return failure(404, 'INCIDENT_NOT_FOUND', 'Incident not found.');
			if (error.code === 'SITE_NOT_FOUND') return failure(404, 'SITE_NOT_FOUND', 'Site not found.');
			if (error.code === 'SITE_INACTIVE')
				return failure(409, 'SITE_INACTIVE', 'The selected site is inactive.');
			if (
				error.code === 'ORGANIZATION_NOT_FOUND' ||
				error.code === 'ORGANIZATION_NOT_OPERATIONAL' ||
				error.code === 'CREATOR_MEMBERSHIP_NOT_FOUND' ||
				error.code === 'CREATOR_MEMBERSHIP_INACTIVE' ||
				error.code === 'CREATOR_USER_INACTIVE'
			)
				return failure(403, 'FORBIDDEN', 'Permission denied.');
		}
		return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
	}
};

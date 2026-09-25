import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { resolveIncidentAccess } from '$lib/server/auth/incident-access';
import { IncidentServiceError } from '$lib/server/services/incidents';
import { listIncidentHistory, parseHistoryQuery } from '$lib/server/services/incident-history';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function failure(status: number, code: string, message: string) {
	return json({ error: { code, message } }, { status });
}
export const GET: RequestHandler = async (event) => {
	const organizationId = event.url.searchParams.get('organizationId');
	const incidentId = event.params.id;
	if (!organizationId || !incidentId || !uuid.test(organizationId) || !uuid.test(incidentId))
		return failure(400, 'INVALID_INPUT', 'Invalid history query.');
	try {
		// Authenticate and authorize before validating pagination parameters.
		// History is part of reading the incident: same access as the detail (view_all, or
		// view_own on incidents assigned to the principal); no separate history permission.
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		const access = await resolveIncidentAccess(
			event.request.headers,
			organizationId,
			principal.userId
		);
		if (!access) return failure(403, 'FORBIDDEN', 'Permission denied.');
		parseHistoryQuery(event.url.searchParams);
		const page = await listIncidentHistory(
			db,
			{ organizationId, incidentId, access },
			event.url.searchParams
		);
		return json(page, { headers: { 'Cache-Control': 'private, no-store' } });
	} catch (error) {
		if (error instanceof IncidentServiceError) {
			if (error.code === 'INVALID_INPUT')
				return failure(400, 'INVALID_INPUT', 'Invalid history query.');
			if (error.code === 'INCIDENT_NOT_FOUND')
				return failure(404, 'INCIDENT_NOT_FOUND', 'Incident not found.');
		}
		return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
	}
};

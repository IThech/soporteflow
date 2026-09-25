import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import { IncidentServiceError } from '$lib/server/services/incidents';
import {
	createInternalNote,
	listInternalNotes,
	parseInternalNotesQuery
} from '$lib/server/services/incident-messages';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { 'Cache-Control': 'private, no-store' };
function failure(status: number, code: string, message: string) {
	return json({ error: { code, message } }, { status, headers: noStore });
}
// Actor state errors can only surface if membership changes between authorization and write.
const FORBIDDEN_SERVICE_CODES = new Set([
	'ORGANIZATION_NOT_FOUND',
	'ORGANIZATION_NOT_OPERATIONAL',
	'CREATOR_MEMBERSHIP_NOT_FOUND',
	'CREATOR_MEMBERSHIP_INACTIVE',
	'CREATOR_USER_INACTIVE'
]);

/** Route/tenant ids are validated first; authentication and authorization precede query/body validation. */
async function authorize(
	headers: Headers,
	organizationId: string,
	permissionId: 'incidents:view_internal_notes' | 'incidents:add_internal_note'
) {
	const principal = await resolvePrincipal(headers);
	if (!principal) return { error: failure(401, 'UNAUTHORIZED', 'Authentication required.') };
	if (!(await authorizeAction(headers, { organizationId, permissionId })))
		return { error: failure(403, 'FORBIDDEN', 'Permission denied.') };
	return { principal };
}

export const GET: RequestHandler = async (event) => {
	const organizationId = event.url.searchParams.get('organizationId');
	const incidentId = event.params.id;
	if (!organizationId || !incidentId || !uuid.test(organizationId) || !uuid.test(incidentId))
		return failure(400, 'INVALID_INPUT', 'Invalid internal notes query.');
	try {
		const auth = await authorize(
			event.request.headers,
			organizationId,
			'incidents:view_internal_notes'
		);
		if (auth.error) return auth.error;
		parseInternalNotesQuery(event.url.searchParams);
		const page = await listInternalNotes(
			db,
			{ organizationId, incidentId },
			event.url.searchParams
		);
		return json({ items: page.items, nextCursor: page.nextCursor }, { headers: noStore });
	} catch (error) {
		if (error instanceof IncidentServiceError) {
			if (error.code === 'INVALID_INPUT')
				return failure(400, 'INVALID_INPUT', 'Invalid internal notes query.');
			if (error.code === 'INCIDENT_NOT_FOUND')
				return failure(404, 'INCIDENT_NOT_FOUND', 'Incident not found.');
		}
		return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
	}
};

export const POST: RequestHandler = async (event) => {
	const organizationId = event.url.searchParams.get('organizationId');
	const incidentId = event.params.id;
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	if (!incidentId || !uuid.test(incidentId))
		return failure(400, 'INVALID_INPUT', 'incidentId must be a valid UUID.');
	for (const key of event.url.searchParams.keys()) {
		if (key !== 'organizationId' || event.url.searchParams.getAll(key).length !== 1)
			return failure(400, 'INVALID_INPUT', 'Invalid internal notes query.');
	}
	try {
		const auth = await authorize(
			event.request.headers,
			organizationId,
			'incidents:add_internal_note'
		);
		if (auth.error) return auth.error;

		let payload: unknown;
		try {
			payload = await event.request.json();
		} catch {
			return failure(400, 'INVALID_INPUT', 'Invalid JSON body.');
		}
		if (!payload || typeof payload !== 'object' || Array.isArray(payload))
			return failure(400, 'INVALID_INPUT', 'Body must be a JSON object.');
		for (const key of Object.keys(payload)) {
			if (key !== 'body') return failure(400, 'INVALID_INPUT', `Unknown property '${key}'.`);
		}
		const { body } = payload as { body?: unknown };
		if (typeof body !== 'string') return failure(400, 'INVALID_INPUT', 'body must be a string.');

		const item = await createInternalNote(
			db,
			{ organizationId, incidentId, actorUserId: auth.principal.userId },
			body
		);
		return json(
			{
				item: { id: item.id, body: item.body, createdAt: item.createdAt, author: item.author }
			},
			{ status: 201, headers: noStore }
		);
	} catch (error) {
		if (error instanceof IncidentServiceError) {
			if (error.code === 'INVALID_INPUT') return failure(400, 'INVALID_INPUT', error.message);
			if (error.code === 'INCIDENT_NOT_FOUND')
				return failure(404, 'INCIDENT_NOT_FOUND', 'Incident not found.');
			if (error.code === 'INCIDENT_CLOSED')
				return failure(
					409,
					'INCIDENT_CLOSED',
					'No se pueden añadir notas internas a una incidencia cerrada.'
				);
			if (FORBIDDEN_SERVICE_CODES.has(error.code))
				return failure(403, 'FORBIDDEN', 'Permission denied.');
		}
		return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
	}
};

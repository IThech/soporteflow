import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import { incidentAccessRestriction, resolveIncidentAccess } from '$lib/server/auth/incident-access';
import { IncidentServiceError } from '$lib/server/services/incidents';
import {
	createPublicComment,
	listPublicComments,
	parsePublicCommentsQuery
} from '$lib/server/services/incident-messages';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { 'Cache-Control': 'private, no-store' };
function failure(status: number, code: string, message: string) {
	return json({ error: { code, message } }, { status, headers: noStore });
}
const forbidden = () => failure(403, 'FORBIDDEN', 'Permission denied.');
// Actor state errors can only surface if membership changes between authorization and write.
const FORBIDDEN_SERVICE_CODES = new Set([
	'INCIDENT_ACCESS_DENIED',
	'ORGANIZATION_NOT_FOUND',
	'ORGANIZATION_NOT_OPERATIONAL',
	'CREATOR_MEMBERSHIP_NOT_FOUND',
	'CREATOR_MEMBERSHIP_INACTIVE',
	'CREATOR_USER_INACTIVE'
]);

/** Incident read access, shared with the detail and mutation endpoints. */
const incidentAccess = resolveIncidentAccess;

function serviceFailure(error: unknown, invalidMessage?: string) {
	if (error instanceof IncidentServiceError) {
		if (error.code === 'INVALID_INPUT')
			return failure(400, 'INVALID_INPUT', invalidMessage ?? error.message);
		if (error.code === 'INCIDENT_NOT_FOUND')
			return failure(404, 'INCIDENT_NOT_FOUND', 'Incident not found.');
		if (error.code === 'INCIDENT_CLOSED')
			return failure(
				409,
				'INCIDENT_CLOSED',
				'No se pueden añadir comentarios a una incidencia cerrada.'
			);
		if (FORBIDDEN_SERVICE_CODES.has(error.code)) return forbidden();
	}
	return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
}

/** Route/tenant ids are validated first; authentication and authorization precede query/body validation. */
export const GET: RequestHandler = async (event) => {
	const organizationId = event.url.searchParams.get('organizationId');
	const incidentId = event.params.id;
	if (!organizationId || !incidentId || !uuid.test(organizationId) || !uuid.test(incidentId))
		return failure(400, 'INVALID_INPUT', 'Invalid comments query.');
	try {
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		const access = await incidentAccess(event.request.headers, organizationId, principal.userId);
		if (!access) return forbidden();
		parsePublicCommentsQuery(event.url.searchParams);
		const page = await listPublicComments(
			db,
			{ organizationId, incidentId, ...incidentAccessRestriction(access) },
			event.url.searchParams
		);
		return json({ items: page.items, nextCursor: page.nextCursor }, { headers: noStore });
	} catch (error) {
		return serviceFailure(error, 'Invalid comments query.');
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
			return failure(400, 'INVALID_INPUT', 'Invalid comments query.');
	}
	try {
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		// add_comment never widens read access: incident access is required as well.
		if (
			!(await authorizeAction(event.request.headers, {
				organizationId,
				permissionId: 'incidents:add_comment'
			}))
		)
			return forbidden();
		const access = await incidentAccess(event.request.headers, organizationId, principal.userId);
		if (!access) return forbidden();

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

		const item = await createPublicComment(
			db,
			{
				organizationId,
				incidentId,
				actorUserId: principal.userId,
				...incidentAccessRestriction(access),
				// 5.4T-B: a reply through a support scope (view_all / view_own) can be the first response;
				// a requester-only scope (view_requested) never is.
				supportResponse: access.viewAll === true || access.assignedToUserId !== undefined
			},
			body
		);
		return json(
			{
				item: { id: item.id, body: item.body, createdAt: item.createdAt, author: item.author }
			},
			{ status: 201, headers: noStore }
		);
	} catch (error) {
		return serviceFailure(error);
	}
};

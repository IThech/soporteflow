import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import {
	incidentMutationFailure,
	resolveIncidentMutationAccess
} from '$lib/server/auth/incident-access';
import { changeIncidentCategory, IncidentServiceError } from '$lib/server/services/incidents';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { 'Cache-Control': 'private, no-store' };
function failure(status: number, code: string, message: string) {
	return json({ error: { code, message } }, { status, headers: noStore });
}

/**
 * PATCH /api/incidents/<id>/category?organizationId=<UUID>
 * Body exactly { categoryId: UUID | null, reason?: string }.
 * Requires incidents:edit plus read access to the incident (view_all / view_own);
 * categories:manage administers the catalog and does not grant incident edits.
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
			return failure(400, 'INVALID_INPUT', 'Invalid category change query.');
	}
	try {
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		// The assignee restriction is enforced by the service under the incident row lock.
		const canEdit = await authorizeAction(event.request.headers, {
			organizationId,
			permissionId: 'incidents:edit'
		});
		const access = canEdit
			? await resolveIncidentMutationAccess(event.request.headers, organizationId, principal.userId)
			: null;
		if (!access) return failure(403, 'FORBIDDEN', 'Permission denied.');

		let payload: unknown;
		try {
			payload = await event.request.json();
		} catch {
			return failure(400, 'INVALID_INPUT', 'Invalid JSON body.');
		}
		if (!payload || typeof payload !== 'object' || Array.isArray(payload))
			return failure(400, 'INVALID_INPUT', 'Body must be a JSON object.');
		for (const key of Object.keys(payload)) {
			if (key !== 'categoryId' && key !== 'reason')
				return failure(400, 'INVALID_INPUT', `Unknown property '${key}'.`);
		}
		const { categoryId, reason } = payload as { categoryId?: unknown; reason?: unknown };
		if (
			!('categoryId' in payload) ||
			(categoryId !== null && (typeof categoryId !== 'string' || !uuid.test(categoryId)))
		)
			return failure(400, 'INVALID_INPUT', 'categoryId must be a valid UUID or null.');
		if (reason !== undefined && typeof reason !== 'string')
			return failure(400, 'INVALID_INPUT', 'reason must be a string.');

		const result = await changeIncidentCategory(
			db,
			{ organizationId, actorUserId: principal.userId, access },
			incidentId,
			{ categoryId: categoryId as string | null, reason: reason as string | undefined }
		);
		return json({ incident: result.incident }, { status: 200, headers: noStore });
	} catch (error) {
		if (error instanceof IncidentServiceError) {
			if (error.code === 'INVALID_INPUT') return failure(400, 'INVALID_INPUT', error.message + '.');
			if (error.code === 'INCIDENT_NOT_FOUND')
				return failure(404, 'INCIDENT_NOT_FOUND', 'Incident not found.');
			if (error.code === 'CATEGORY_NOT_FOUND')
				return failure(404, 'CATEGORY_NOT_FOUND', 'Category not found.');
			if (error.code === 'CATEGORY_INACTIVE')
				return failure(409, 'CATEGORY_INACTIVE', 'The selected category is inactive.');
			const mapped = incidentMutationFailure(error.code);
			if (mapped) return mapped;
		}
		return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
	}
};

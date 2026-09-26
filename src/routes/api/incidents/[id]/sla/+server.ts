import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import {
	incidentMutationFailure,
	resolveIncidentMutationAccess
} from '$lib/server/auth/incident-access';
import { changeIncidentSla, IncidentServiceError } from '$lib/server/services/incidents';
import { withSlaCompliance } from '$lib/server/services/sla-compliance';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { 'Cache-Control': 'private, no-store' };
function failure(status: number, code: string, message: string) {
	return json({ error: { code, message } }, { status, headers: noStore });
}

/**
 * PATCH /api/incidents/<id>/sla?organizationId=<UUID>   body exactly { slaPolicyId: UUID | null }
 * Requires sla:assign plus mutation access to the incident (view_all, or view_own on an assigned
 * incident; the requester scope never grants it, so a Customer can never change an SLA).
 * A new policy is snapshotted with deadlines from now; the same policy is a no-op; null removes the
 * SLA. firstResponseAt is always kept. Closed incidents are immutable (409).
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
			return failure(400, 'INVALID_INPUT', 'Invalid SLA change query.');
	}
	try {
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		const canAssign = await authorizeAction(event.request.headers, {
			organizationId,
			permissionId: 'sla:assign'
		});
		const access = canAssign
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
		const keys = Object.keys(payload);
		if (keys.length !== 1 || keys[0] !== 'slaPolicyId')
			return failure(400, 'INVALID_INPUT', 'Body must be exactly { slaPolicyId }.');
		const { slaPolicyId } = payload as { slaPolicyId: unknown };
		if (slaPolicyId !== null && (typeof slaPolicyId !== 'string' || !uuid.test(slaPolicyId)))
			return failure(400, 'INVALID_INPUT', 'slaPolicyId must be a valid UUID or null.');

		const result = await changeIncidentSla(
			db,
			{ organizationId, actorUserId: principal.userId, access },
			incidentId,
			{ slaPolicyId: slaPolicyId as string | null }
		);
		return json(
			{ incident: withSlaCompliance(result.incident) },
			{ status: 200, headers: noStore }
		);
	} catch (error) {
		if (error instanceof IncidentServiceError) {
			if (error.code === 'INVALID_INPUT') return failure(400, 'INVALID_INPUT', 'Invalid request.');
			if (error.code === 'INCIDENT_NOT_FOUND')
				return failure(404, 'INCIDENT_NOT_FOUND', 'Incident not found.');
			if (error.code === 'SLA_POLICY_NOT_FOUND')
				return failure(404, 'SLA_POLICY_NOT_FOUND', 'SLA policy not found.');
			if (error.code === 'SLA_POLICY_INACTIVE')
				return failure(409, 'SLA_POLICY_INACTIVE', 'SLA policy is not active.');
			const mapped = incidentMutationFailure(error.code);
			if (mapped) return mapped;
		}
		return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
	}
};

import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import {
	incidentMutationFailure,
	resolveIncidentMutationAccess
} from '$lib/server/auth/incident-access';
import { assignIncidentRecord, IncidentServiceError } from '$lib/server/services/incidents';
import { withSlaCompliance } from '$lib/server/services/sla-compliance';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID_REGEX.test(value);
}

export const POST: RequestHandler = async (event) => {
	// 1. Read organizationId from query string and incidentId from route params
	const organizationId = event.url.searchParams.get('organizationId');
	const incidentId = event.params.id;

	// 2. Validate both as UUID
	if (!isValidUuid(organizationId)) {
		return json(
			{
				error: {
					code: 'INVALID_INPUT',
					message: 'organizationId must be a valid UUID.'
				}
			},
			{ status: 400 }
		);
	}

	if (!isValidUuid(incidentId)) {
		return json(
			{
				error: {
					code: 'INVALID_INPUT',
					message: 'incidentId must be a valid UUID.'
				}
			},
			{ status: 400 }
		);
	}

	// 3. Parse JSON body
	let body: Record<string, unknown>;
	try {
		const raw = await event.request.json();
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			return json(
				{
					error: {
						code: 'INVALID_INPUT',
						message: 'Body must be a JSON object.'
					}
				},
				{ status: 400 }
			);
		}
		body = raw as Record<string, unknown>;
	} catch {
		return json(
			{
				error: {
					code: 'INVALID_INPUT',
					message: 'Invalid JSON body.'
				}
			},
			{ status: 400 }
		);
	}

	// 4. Validate allowed keys: teamId, assignedToUserId, and optional reason
	const allowedKeys = new Set(['teamId', 'assignedToUserId', 'reason']);
	const bodyKeys = Object.keys(body);

	for (const key of bodyKeys) {
		if (!allowedKeys.has(key)) {
			return json(
				{
					error: {
						code: 'INVALID_INPUT',
						message: `Unknown property '${key}'.`
					}
				},
				{ status: 400 }
			);
		}
	}

	if (body.teamId === undefined && body.assignedToUserId === undefined) {
		return json(
			{
				error: {
					code: 'INVALID_INPUT',
					message: 'At least teamId or assignedToUserId must be provided.'
				}
			},
			{ status: 400 }
		);
	}

	// 5. Validate teamId if provided
	if (body.teamId !== undefined && body.teamId !== null) {
		if (typeof body.teamId !== 'string' || !isValidUuid(body.teamId)) {
			return json(
				{
					error: {
						code: 'INVALID_INPUT',
						message: 'teamId must be a valid UUID.'
					}
				},
				{ status: 400 }
			);
		}
	}

	// 6. Validate assignedToUserId if provided
	if (body.assignedToUserId !== undefined && body.assignedToUserId !== null) {
		if (typeof body.assignedToUserId !== 'string' || !isValidUuid(body.assignedToUserId)) {
			return json(
				{
					error: {
						code: 'INVALID_INPUT',
						message: 'assignedToUserId must be a valid UUID.'
					}
				},
				{ status: 400 }
			);
		}
	}

	// 7. Validate reason type if provided
	if (body.reason !== undefined && typeof body.reason !== 'string') {
		return json(
			{
				error: {
					code: 'INVALID_INPUT',
					message: 'reason must be a string.'
				}
			},
			{ status: 400 }
		);
	}

	// 8. Authenticate
	const principal = await resolvePrincipal(event.request.headers);
	if (!principal) {
		return json(
			{
				error: {
					code: 'UNAUTHORIZED',
					message: 'Authentication required.'
				}
			},
			{ status: 401 }
		);
	}

	// 9. Authorize with incidents:assign
	const authorized = await authorizeAction(event.request.headers, {
		organizationId,
		permissionId: 'incidents:assign'
	});
	// Mutation permission plus read access to the incident (view_all / view_own);
	// the assignee restriction is enforced by the service under the incident row lock.
	const access = authorized
		? await resolveIncidentMutationAccess(event.request.headers, organizationId, principal.userId)
		: null;
	if (!access) {
		return json(
			{
				error: {
					code: 'FORBIDDEN',
					message: 'Permission denied.'
				}
			},
			{ status: 403 }
		);
	}

	// 10. Execute assignIncidentRecord
	try {
		const result = await assignIncidentRecord(
			db,
			{ organizationId, actorUserId: principal.userId, access },
			incidentId,
			{
				teamId: body.teamId as string | null | undefined,
				assignedToUserId: body.assignedToUserId as string | null | undefined,
				reason: body.reason as string | undefined
			}
		);

		return json(
			{
				incident: withSlaCompliance(result.incident)
			},
			{ status: 200 }
		);
	} catch (err: unknown) {
		if (err instanceof IncidentServiceError) {
			if (err.code === 'INCIDENT_NOT_FOUND') {
				return json(
					{
						error: {
							code: 'INCIDENT_NOT_FOUND',
							message: 'Incident not found.'
						}
					},
					{ status: 404 }
				);
			}
			if (err.code === 'ASSIGNEE_NOT_FOUND') {
				return json(
					{
						error: {
							code: 'ASSIGNEE_NOT_FOUND',
							message: 'Assignee user not found or not eligible in this organization.'
						}
					},
					{ status: 404 }
				);
			}
			if (err.code === 'INVALID_INPUT') {
				return json(
					{
						error: {
							code: 'INVALID_INPUT',
							message: err.message
						}
					},
					{ status: 400 }
				);
			}
			const mapped = incidentMutationFailure(err.code);
			if (mapped) return mapped;
		}

		return json(
			{
				error: {
					code: 'INTERNAL_ERROR',
					message: 'Internal server error.'
				}
			},
			{ status: 500 }
		);
	}
};

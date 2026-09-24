import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import {
	getIncidentById,
	updateIncidentRecord,
	IncidentServiceError,
	type IncidentStatus,
	type IncidentPriority
} from '$lib/server/services/incidents';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID_REGEX.test(value);
}

export const GET: RequestHandler = async (event) => {
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

	// 3. Authenticate
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

	// 4. Authorize with incidents:view_all
	const authorized = await authorizeAction(event.request.headers, {
		organizationId,
		permissionId: 'incidents:view_all'
	});
	if (!authorized) {
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

	// 5. Execute getIncidentById
	try {
		const result = await getIncidentById(db, { organizationId }, incidentId);

		// 6. Return 404 if not found or belongs to another tenant
		if (!result) {
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

		// 7. Success response
		return json(
			{
				incident: result.incident,
				history: result.history
			},
			{ status: 200 }
		);
	} catch (err: unknown) {
		if (err instanceof IncidentServiceError && err.code === 'INVALID_INPUT') {
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

export const PATCH: RequestHandler = async (event) => {
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

	// 4. Validate allowed keys: only status and priority are accepted
	const allowedKeys = new Set(['status', 'priority']);
	const bodyKeys = Object.keys(body);
	if (bodyKeys.length === 0) {
		return json(
			{
				error: {
					code: 'INVALID_INPUT',
					message: 'At least status or priority must be provided.'
				}
			},
			{ status: 400 }
		);
	}

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

	// 5. Validate status and priority values if provided
	if (body.status !== undefined) {
		if (
			typeof body.status !== 'string' ||
			!['open', 'pending', 'resolved', 'closed'].includes(body.status)
		) {
			return json(
				{
					error: {
						code: 'INVALID_INPUT',
						message: "status must be one of: 'open', 'pending', 'resolved', 'closed'."
					}
				},
				{ status: 400 }
			);
		}
	}

	if (body.priority !== undefined) {
		if (
			typeof body.priority !== 'string' ||
			!['low', 'medium', 'high', 'urgent'].includes(body.priority)
		) {
			return json(
				{
					error: {
						code: 'INVALID_INPUT',
						message: "priority must be one of: 'low', 'medium', 'high', 'urgent'."
					}
				},
				{ status: 400 }
			);
		}
	}

	// 6. Authenticate
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

	// 7. Authorize with incidents:edit
	const authorized = await authorizeAction(event.request.headers, {
		organizationId,
		permissionId: 'incidents:edit'
	});
	if (!authorized) {
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

	// 8. Execute updateIncidentRecord
	try {
		const result = await updateIncidentRecord(
			db,
			{ organizationId, actorUserId: principal.userId },
			incidentId,
			{
				status: body.status as IncidentStatus | undefined,
				priority: body.priority as IncidentPriority | undefined
			}
		);

		return json(
			{
				incident: result.incident
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

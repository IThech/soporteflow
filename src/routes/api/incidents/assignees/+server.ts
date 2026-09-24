import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import { getAssignableTechnicians, IncidentServiceError } from '$lib/server/services/incidents';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID_REGEX.test(value);
}

export const GET: RequestHandler = async (event) => {
	// 1. Read organizationId from query string
	const organizationId = event.url.searchParams.get('organizationId');

	// 2. Validate organizationId as UUID
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

	// 4. Authorize with incidents:assign
	const authorized = await authorizeAction(event.request.headers, {
		organizationId,
		permissionId: 'incidents:assign'
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

	// 5. Execute getAssignableTechnicians
	try {
		const assignees = await getAssignableTechnicians(db, organizationId);

		return json(
			{
				assignees
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

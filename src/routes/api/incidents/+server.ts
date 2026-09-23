import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import {
	createIncidentRecord,
	IncidentServiceError,
	type IncidentPriority
} from '$lib/server/services/incidents';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID_REGEX.test(value);
}

export const POST: RequestHandler = async (event) => {
	// 1. Parse JSON body
	let body: Record<string, unknown>;
	try {
		const raw = await event.request.json();
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			return json(
				{
					error: {
						code: 'INVALID_INPUT',
						message: 'Invalid request body.'
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
					message: 'Invalid request body.'
				}
			},
			{ status: 400 }
		);
	}

	// 2. Validate organizationId from body exclusively
	const organizationId = body.organizationId;
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

	// 4. Authorize
	const authorized = await authorizeAction(event.request.headers, {
		organizationId,
		permissionId: 'incidents:create'
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

	// 5. Execute service
	try {
		const result = await createIncidentRecord(
			db,
			{
				organizationId,
				creatorUserId: principal.userId
			},
			{
				title: body.title as string,
				description: body.description as string,
				client: body.client as string,
				priority: body.priority as IncidentPriority | undefined,
				clientUserId: body.clientUserId as string | null | undefined,
				siteId: body.siteId as string | null | undefined
			}
		);

		// 6. Success response
		return json(
			{
				incident: result.incident,
				history: result.history
			},
			{ status: 201 }
		);
	} catch (err: unknown) {
		if (err instanceof IncidentServiceError) {
			switch (err.code) {
				case 'INVALID_INPUT':
					return json(
						{
							error: {
								code: 'INVALID_INPUT',
								message: err.message
							}
						},
						{ status: 400 }
					);
				case 'SITE_NOT_FOUND':
				case 'CLIENT_USER_MEMBERSHIP_NOT_FOUND':
					return json(
						{
							error: {
								code: err.code,
								message: err.message
							}
						},
						{ status: 404 }
					);
				case 'SITE_INACTIVE':
				case 'CLIENT_USER_INACTIVE':
					return json(
						{
							error: {
								code: err.code,
								message: err.message
							}
						},
						{ status: 409 }
					);
				default:
					return json(
						{
							error: {
								code: 'FORBIDDEN',
								message: err.message
							}
						},
						{ status: 403 }
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

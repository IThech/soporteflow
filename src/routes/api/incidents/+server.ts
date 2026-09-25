import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import {
	createIncidentRecord,
	listIncidents,
	IncidentServiceError,
	type IncidentPriority,
	type IncidentStatus,
	type IncidentQueue,
	type SupportLevel,
	VALID_SUPPORT_LEVELS,
	type ListIncidentsFilters
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

	if (body.supportLevel !== undefined) {
		return json(
			{
				error: {
					code: 'INVALID_INPUT',
					message:
						'supportLevel cannot be specified during incident creation. Incidents are always initialized at level N1.'
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

export const GET: RequestHandler = async (event) => {
	// 1. Read organizationId from query string exclusively
	const organizationId = event.url.searchParams.get('organizationId');

	// 2. Validate organizationId
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

	// 4. Extract and validate queue param (mine | unassigned | all, default: all)
	const rawQueue = event.url.searchParams.get('queue');
	if (rawQueue !== null && rawQueue !== 'mine' && rawQueue !== 'unassigned' && rawQueue !== 'all') {
		return json(
			{
				error: {
					code: 'INVALID_INPUT',
					message: `invalid queue parameter '${rawQueue}'. Must be one of: mine, unassigned, all.`
				}
			},
			{ status: 400 }
		);
	}
	const queue: IncidentQueue = (rawQueue as IncidentQueue) ?? 'all';

	// 5. Authorize based on queue:
	// queue=all or queue=unassigned requires incidents:view_all
	// queue=mine requires incidents:view_all OR incidents:view_own
	const authorized =
		queue === 'mine'
			? (await authorizeAction(event.request.headers, {
					organizationId,
					permissionId: 'incidents:view_all'
				})) ||
				(await authorizeAction(event.request.headers, {
					organizationId,
					permissionId: 'incidents:view_own'
				}))
			: await authorizeAction(event.request.headers, {
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

	// 6. Extract optional filters from query string
	const filters: ListIncidentsFilters = { queue };
	const statusParam = event.url.searchParams.get('status');
	if (statusParam !== null) {
		filters.status = statusParam as IncidentStatus;
	}

	const priorityParam = event.url.searchParams.get('priority');
	if (priorityParam !== null) {
		filters.priority = priorityParam as IncidentPriority;
	}

	const siteIdParam = event.url.searchParams.get('siteId');
	if (siteIdParam !== null) {
		filters.siteId = siteIdParam;
	}

	const teamIdParam = event.url.searchParams.get('teamId');
	if (teamIdParam !== null) {
		if (teamIdParam === 'none' || teamIdParam === 'null') {
			filters.teamId = null;
		} else {
			filters.teamId = teamIdParam;
		}
	}

	const supportLevelParam = event.url.searchParams.get('supportLevel');
	if (supportLevelParam !== null) {
		if (!VALID_SUPPORT_LEVELS.includes(supportLevelParam as SupportLevel)) {
			return json(
				{
					error: {
						code: 'INVALID_INPUT',
						message: `invalid supportLevel parameter '${supportLevelParam}'. Must be one of: N1, N2, N3.`
					}
				},
				{ status: 400 }
			);
		}
		filters.supportLevel = supportLevelParam as SupportLevel;
	}

	// 7. Execute listIncidents
	try {
		const incidents = await listIncidents(
			db,
			{ organizationId, actorUserId: principal.userId },
			filters
		);

		// 8. Success response
		return json({ incidents }, { status: 200 });
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

import { resultLimitFailure } from '$lib/server/security/bounded-read';
import { onlyKeys } from '$lib/server/security/query';
import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import {
	incidentAudience,
	resolveIncidentAccess,
	withIncidentActor
} from '$lib/server/auth/incident-access';
import {
	ActorAuthorizationError,
	isActorAuthorizationError
} from '$lib/server/auth/transactional-authorization';
import { toIncidentDto } from '$lib/server/services/incident-dto';
import {
	createIncidentRecord,
	listIncidents,
	listIncidentsPage,
	type IncidentPageCursor,
	IncidentServiceError,
	type IncidentPriority,
	type IncidentAccess,
	type IncidentStatus,
	type IncidentQueue,
	type SupportLevel,
	VALID_SUPPORT_LEVELS,
	type ListIncidentsFilters
} from '$lib/server/services/incidents';
import {
	SLA_OBJECTIVE_STATUSES,
	SLA_OVERALL_STATUSES,
	type SlaObjectiveStatus,
	type SlaOverallStatus
} from '$lib/server/services/sla-compliance';
import { logUnexpectedError } from '$lib/server/logging/logger';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID_REGEX.test(value);
}

export const POST: RequestHandler = async (event) => {
	if (!onlyKeys(event.url.searchParams, []))
		return json({ error: { code: 'INVALID_INPUT', message: 'Invalid request.' } }, { status: 400 });
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

	// 2.1 Strict shape: unknown properties (categoryName, subcategoryId, classification,
	// routing, defaultTeamId, demo fields...) are rejected instead of silently ignored.
	const allowedKeys = new Set([
		'organizationId',
		'title',
		'description',
		'client',
		'priority',
		'clientUserId',
		'siteId',
		'categoryId',
		'slaPolicyId'
	]);
	for (const key of Object.keys(body)) {
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

	// 4.1 Requester (5.4S-B). Choosing another member as requester (clientUserId) gives that
	// member read access through incidents:view_requested, so it is reserved to callers that can
	// already see every incident of the tenant (incidents:view_all: support staff / admin).
	// Anyone else creates the incident for themselves: clientUserId is set by the server to the
	// principal; an explicit different value is refused (never silently re-targeted).
	const canChooseRequester = await authorizeAction(event.request.headers, {
		organizationId,
		permissionId: 'incidents:view_all'
	});
	let clientUserId = body.clientUserId as string | null | undefined;
	if (!canChooseRequester) {
		if (clientUserId !== undefined && clientUserId !== null && clientUserId !== principal.userId) {
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
		clientUserId = principal.userId;
	}

	// 4.2 SLA (5.4T-B). Deadlines and snapshot are always server-owned. Choosing the policy
	// (a UUID, or null for "no SLA") requires sla:assign; without it the server applies the
	// organization's default policy, if any. A caller lacking sla:assign that sends slaPolicyId
	// is refused (403), consistent with the requester spoof rule above.
	const slaPolicyId = body.slaPolicyId;
	if (slaPolicyId !== undefined) {
		if (slaPolicyId !== null && !isValidUuid(slaPolicyId)) {
			return json(
				{ error: { code: 'INVALID_INPUT', message: 'slaPolicyId must be a valid UUID or null.' } },
				{ status: 400 }
			);
		}
		const canAssignSla = await authorizeAction(event.request.headers, {
			organizationId,
			permissionId: 'sla:assign'
		});
		if (!canAssignSla) {
			return json({ error: { code: 'FORBIDDEN', message: 'Permission denied.' } }, { status: 403 });
		}
	}

	// 5. Execute service. 5.4W-B: the checks above are pre-checks; inside the creation transaction
	// (organization FOR SHARE) the capabilities are re-read and every decision that depended on
	// them (create, choosing another requester, choosing the SLA) is re-validated.
	try {
		const { incident, audience } = await withIncidentActor(
			db,
			{ userId: principal.userId, organizationId, permissionIds: ['incidents:create'] },
			async (tx, scope) => {
				const choosesRequester =
					clientUserId !== undefined && clientUserId !== null && clientUserId !== principal.userId;
				if (choosesRequester && !scope.permissions.includes('incidents:view_all'))
					throw new ActorAuthorizationError();
				if (slaPolicyId !== undefined && !scope.permissions.includes('sla:assign'))
					throw new ActorAuthorizationError();
				const result = await createIncidentRecord(
					tx,
					{
						organizationId,
						creatorUserId: principal.userId
					},
					{
						title: body.title as string,
						description: body.description as string,
						client: body.client as string,
						priority: body.priority as IncidentPriority | undefined,
						clientUserId,
						siteId: body.siteId as string | null | undefined,
						categoryId: body.categoryId as string | null | undefined,
						slaPolicyId: slaPolicyId as string | null | undefined
					}
				);
				return {
					incident: result.incident,
					audience: incidentAudience(scope.read, result.incident)
				};
			}
		);

		// 6. Success response: canonical projection for the creator's audience (5.4W-B)
		return json(
			{
				incident: toIncidentDto(incident, audience)
			},
			{ status: 201 }
		);
	} catch (err: unknown) {
		const oversized = resultLimitFailure(err);
		if (oversized) return oversized;
		if (isActorAuthorizationError(err))
			return json({ error: { code: 'FORBIDDEN', message: 'Permission denied.' } }, { status: 403 });
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
				case 'SLA_POLICY_NOT_FOUND':
					return json(
						{ error: { code: 'SLA_POLICY_NOT_FOUND', message: 'SLA policy not found.' } },
						{ status: 404 }
					);
				case 'SLA_POLICY_INACTIVE':
					return json(
						{ error: { code: 'SLA_POLICY_INACTIVE', message: 'SLA policy is not active.' } },
						{ status: 409 }
					);
				case 'SITE_NOT_FOUND':
				case 'CATEGORY_NOT_FOUND':
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
				case 'CATEGORY_INACTIVE':
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
				// Known organization/creator state errors keep their 403 contract, with a generic
				// message: internal details (e.g. organization status) are never exposed.
				case 'ORGANIZATION_NOT_FOUND':
				case 'ORGANIZATION_NOT_OPERATIONAL':
				case 'CREATOR_MEMBERSHIP_NOT_FOUND':
				case 'CREATOR_MEMBERSHIP_INACTIVE':
				case 'CREATOR_USER_INACTIVE':
					return json(
						{
							error: {
								code: 'FORBIDDEN',
								message: 'Permission denied.'
							}
						},
						{ status: 403 }
					);
				// Unrecognized domain errors fall through to the generic 500 below; err.message
				// is never forwarded to the client.
			}
		}

		logUnexpectedError(err);
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
	if (
		!onlyKeys(event.url.searchParams, [
			'organizationId',
			'queue',
			'status',
			'priority',
			'siteId',
			'categoryId',
			'teamId',
			'supportLevel',
			'slaStatus',
			'slaFirstResponseStatus',
			'slaResolutionStatus',
			// 5.4X-D: opt-in keyset pagination (absent -> legacy bounded list, unchanged contract)
			'limit',
			'cursor'
		])
	)
		return json({ error: { code: 'INVALID_INPUT', message: 'Invalid request.' } }, { status: 400 });
	const paging = parseIncidentPaging(event.url.searchParams);
	if (paging === 'invalid')
		return json(
			{ error: { code: 'INVALID_INPUT', message: 'Invalid pagination parameters.' } },
			{ status: 400 }
		);
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
	// 5. Authorize from the resolved incident access (5.4S-B):
	// - explicit queue=all / queue=unassigned: incidents:view_all only (a requester can never use
	//   them to widen access);
	// - explicit queue=mine: incidents:view_all OR incidents:view_own (assigned to the principal);
	// - no queue: view_all -> every incident of the tenant (unchanged); a caller holding the
	//   requester scope (incidents:view_requested) gets exactly its authorized scope, filtered in
	//   SQL (requested, or assigned OR requested with view_own too); view_own alone keeps its 5.4N-0
	//   contract (403 without queue=mine).
	const access = await resolveIncidentAccess(
		event.request.headers,
		organizationId,
		principal.userId
	);
	const viewAll = access?.viewAll === true;
	let queue: IncidentQueue | undefined;
	let scope: IncidentAccess | undefined;
	let authorized = false;
	if (rawQueue === 'mine') {
		queue = 'mine';
		authorized = viewAll || access?.assignedToUserId !== undefined;
	} else if (rawQueue !== null) {
		queue = rawQueue as IncidentQueue;
		authorized = viewAll;
	} else if (viewAll) {
		queue = 'all';
		authorized = true;
	} else if (access && access.clientUserId !== undefined) {
		scope = access;
		authorized = true;
	}

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
	const filters: ListIncidentsFilters = queue === undefined ? {} : { queue };
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

	// Category filter: single valid UUID; filtered as a plain FK within the tenant.
	const categoryIdParams = event.url.searchParams.getAll('categoryId');
	if (categoryIdParams.length > 0) {
		if (categoryIdParams.length !== 1 || !isValidUuid(categoryIdParams[0])) {
			return json(
				{
					error: {
						code: 'INVALID_INPUT',
						message: 'categoryId filter must be a single valid UUID.'
					}
				},
				{ status: 400 }
			);
		}
		filters.categoryId = categoryIdParams[0];
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

	// 6.1 SLA compliance filters (5.4T-C): derived in SQL at request time; they only narrow the
	// caller's already-authorized scope (never widen it). Single value each; unknown values -> 400.
	const slaParams = [
		['slaStatus', SLA_OVERALL_STATUSES],
		['slaFirstResponseStatus', SLA_OBJECTIVE_STATUSES],
		['slaResolutionStatus', SLA_OBJECTIVE_STATUSES]
	] as const;
	for (const [name, allowed] of slaParams) {
		const values = event.url.searchParams.getAll(name);
		if (values.length === 0) continue;
		if (values.length !== 1 || !(allowed as readonly string[]).includes(values[0])) {
			return json(
				{ error: { code: 'INVALID_INPUT', message: `invalid ${name} parameter.` } },
				{ status: 400 }
			);
		}
		if (name === 'slaStatus') filters.slaStatus = values[0] as SlaOverallStatus;
		else if (name === 'slaFirstResponseStatus')
			filters.slaFirstResponseStatus = values[0] as SlaObjectiveStatus;
		else filters.slaResolutionStatus = values[0] as SlaObjectiveStatus;
	}

	// 6.2 5.4W-B: a requester scope must not use internal fields as a filter oracle (team and support
	// level are not part of the customer projection; SLA compliance statuses are).
	if (scope !== undefined && (filters.teamId !== undefined || filters.supportLevel !== undefined)) {
		return json({ error: { code: 'FORBIDDEN', message: 'Permission denied.' } }, { status: 403 });
	}

	// 7. Execute listIncidents (one reference time for SQL filters and derived DTO fields)
	try {
		const now = new Date();
		const listContext = { organizationId, actorUserId: principal.userId, access: scope, now };
		if (paging) {
			// 5.4X-D: { incidents, nextCursor } — same scope, filters, order and DTO as the legacy list.
			const page = await listIncidentsPage(db, listContext, filters, paging);
			return json(
				{
					incidents: page.items.map((incident) =>
						toIncidentDto(incident, incidentAudience(access, incident), now)
					),
					nextCursor: page.nextCursor ? encodeIncidentCursor(page.nextCursor) : null
				},
				{ status: 200 }
			);
		}
		const incidents = await listIncidents(db, listContext, filters);

		// 8. Success response
		return json(
			{
				incidents: incidents.map((incident) =>
					toIncidentDto(incident, incidentAudience(access, incident), now)
				)
			},
			{ status: 200 }
		);
	} catch (err: unknown) {
		const oversized = resultLimitFailure(err);
		if (oversized) return oversized;
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

		logUnexpectedError(err);
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

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function encodeIncidentCursor(cursor: IncidentPageCursor): string {
	return Buffer.from(JSON.stringify([cursor.at, cursor.incidentNumber])).toString('base64url');
}

/**
 * null: legacy (no limit/cursor). 'invalid': malformed. Otherwise the page request:
 * limit 1..100 (default 50 when only a cursor is sent), opaque cursor round-tripped exactly.
 */
function parseIncidentPaging(
	params: URLSearchParams
): { limit: number; cursor: IncidentPageCursor | null } | null | 'invalid' {
	const rawLimit = params.get('limit');
	const rawCursor = params.get('cursor');
	if (rawLimit === null && rawCursor === null) return null;
	if (rawLimit !== null && !/^(?:[1-9]\d?|100)$/.test(rawLimit)) return 'invalid';
	const limit = rawLimit === null ? 50 : Number(rawLimit);
	if (rawCursor === null) return { limit, cursor: null };
	if (rawCursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(rawCursor)) return 'invalid';
	try {
		const value: unknown = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
		if (
			!Array.isArray(value) ||
			value.length !== 2 ||
			typeof value[0] !== 'string' ||
			!CURSOR_AT.test(value[0]) ||
			!Number.isSafeInteger(value[1]) ||
			value[1] < 1
		)
			return 'invalid';
		const cursor = { at: value[0], incidentNumber: value[1] as number };
		return encodeIncidentCursor(cursor) === rawCursor ? { limit, cursor } : 'invalid';
	} catch {
		return 'invalid';
	}
}

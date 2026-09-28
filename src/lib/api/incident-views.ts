import {
	parseAndValidateIncident,
	type IncidentListItem,
	type IncidentQueue,
	type SlaObjectiveStatus,
	type SlaOverallStatus,
	type SupportLevel
} from './incidents.ts';
import {
	ApiError,
	apiErrorFromResponse,
	invalidPayloadError,
	isAbortError,
	networkApiError,
	readRequestId
} from './errors.ts';

/**
 * UI-1A incident presentation model (FE-03, FE-04).
 *
 * A discriminated union mirrors the two server projections exactly:
 * - StaffIncidentView: the operational DTO (assignment, team, support level, SLA snapshot);
 * - RequesterIncidentView: the customer allowlist (5.4W-B). It has NO internal fields at all —
 *   components must branch on `audience` instead of reading nulls that pretend to be data.
 */

export type IncidentStatus = 'open' | 'pending' | 'resolved' | 'closed';
export type IncidentPriority = 'low' | 'medium' | 'high' | 'urgent';

interface IncidentViewBase {
	id: string;
	organizationId: string;
	incidentNumber: number;
	title: string;
	description: string;
	status: IncidentStatus;
	priority: IncidentPriority;
	clientUserId: string | null;
	siteId: string | null;
	categoryId: string | null;
	slaOverallStatus: SlaOverallStatus;
	slaFirstResponseStatus: SlaObjectiveStatus;
	slaResolutionStatus: SlaObjectiveStatus;
	createdAt: string;
	updatedAt: string;
}

export interface StaffIncidentView extends IncidentViewBase {
	audience: 'staff';
	/** Legacy free-text requester/client label (staff classification). */
	client: string;
	supportLevel: SupportLevel;
	createdByUserId: string;
	assignedToUserId: string | null;
	assignedToUserName: string | null;
	teamId: string | null;
	teamName: string | null;
	slaPolicyId: string | null;
	firstResponseDueAt: string | null;
	resolutionDueAt: string | null;
}

export interface RequesterIncidentView extends IncidentViewBase {
	audience: 'requester';
}

export type IncidentView = StaffIncidentView | RequesterIncidentView;

function baseOf(item: IncidentListItem): IncidentViewBase {
	return {
		id: item.id,
		organizationId: item.organizationId,
		incidentNumber: item.incidentNumber,
		title: item.title,
		description: item.description,
		status: item.status,
		priority: item.priority,
		clientUserId: item.clientUserId,
		siteId: item.siteId,
		categoryId: item.categoryId,
		slaOverallStatus: item.slaOverallStatus,
		slaFirstResponseStatus: item.slaFirstResponseStatus,
		slaResolutionStatus: item.slaResolutionStatus,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt
	};
}

/**
 * Validates one incident payload (staff or requester, strict) and projects it to the view model.
 * Throws ApiError INVALID_PAYLOAD on any contract violation, including a foreign organization.
 */
export function toIncidentView(raw: unknown, organizationId: string, status = 200): IncidentView {
	const item = parseAndValidateIncident(raw, organizationId, undefined, status);
	if (item.audience === 'requester') return { audience: 'requester', ...baseOf(item) };
	return {
		audience: 'staff',
		...baseOf(item),
		client: item.client as string,
		supportLevel: item.supportLevel as SupportLevel,
		createdByUserId: item.createdByUserId as string,
		assignedToUserId: item.assignedToUserId,
		assignedToUserName: item.assignedToUserName ?? null,
		teamId: item.teamId ?? null,
		teamName: item.teamName ?? null,
		slaPolicyId: item.slaPolicyId,
		firstResponseDueAt: item.firstResponseDueAt,
		resolutionDueAt: item.resolutionDueAt
	};
}

// ------------------------------------------------------------------------------------------------
// Keyset pagination (GET /api/incidents?limit&cursor, 5.4X-D)
// ------------------------------------------------------------------------------------------------

export const INCIDENT_PAGE_MIN_LIMIT = 1;
export const INCIDENT_PAGE_MAX_LIMIT = 100;
export const INCIDENT_PAGE_DEFAULT_LIMIT = 25;
/** Opaque server cursor: forwarded verbatim, only its transport shape is checked. */
const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const INCIDENT_STATUSES: readonly IncidentStatus[] = [
	'open',
	'pending',
	'resolved',
	'closed'
];
export const INCIDENT_PRIORITIES: readonly IncidentPriority[] = ['low', 'medium', 'high', 'urgent'];
const QUEUES: readonly IncidentQueue[] = ['mine', 'unassigned', 'all'];
const SUPPORT_LEVELS: readonly SupportLevel[] = ['N1', 'N2', 'N3'];
const SLA_OVERALL: readonly SlaOverallStatus[] = ['not_applicable', 'on_track', 'met', 'breached'];
const SLA_OBJECTIVE: readonly SlaObjectiveStatus[] = [
	'not_applicable',
	'pending',
	'met',
	'breached'
];

export interface IncidentPageQuery {
	queue?: IncidentQueue;
	status?: IncidentStatus;
	priority?: IncidentPriority;
	siteId?: string;
	categoryId?: string;
	/** UUID, or 'none' for incidents without team (server contract). */
	teamId?: string;
	supportLevel?: SupportLevel;
	slaStatus?: SlaOverallStatus;
	slaFirstResponseStatus?: SlaObjectiveStatus;
	slaResolutionStatus?: SlaObjectiveStatus;
	limit?: number;
	/** Opaque cursor returned by the previous page (never built client-side). */
	cursor?: string | null;
}

export interface IncidentPage {
	incidents: IncidentView[];
	nextCursor: string | null;
}

export function isValidIncidentCursor(value: unknown): value is string {
	return typeof value === 'string' && CURSOR.test(value);
}

function invalidQuery(message: string): ApiError {
	return new ApiError(0, 'INVALID_INPUT', message);
}

/** Builds the query string; throws ApiError INVALID_INPUT before any request on a bad value. */
export function buildIncidentPageSearch(
	organizationId: string,
	query: IncidentPageQuery
): URLSearchParams {
	if (typeof organizationId !== 'string' || !UUID.test(organizationId))
		throw invalidQuery('La organización no es válida.');
	const params = new URLSearchParams({ organizationId });
	const check = <T extends string>(key: keyof IncidentPageQuery, allowed: readonly T[]) => {
		const value = query[key];
		if (value === undefined) return;
		if (!(allowed as readonly unknown[]).includes(value)) throw invalidQuery('Filtro no válido.');
		params.set(key, value as string);
	};
	check('queue', QUEUES);
	check('status', INCIDENT_STATUSES);
	check('priority', INCIDENT_PRIORITIES);
	for (const key of ['siteId', 'categoryId'] as const) {
		const value = query[key];
		if (value === undefined) continue;
		if (typeof value !== 'string' || !UUID.test(value)) throw invalidQuery('Filtro no válido.');
		params.set(key, value);
	}
	if (query.teamId !== undefined) {
		if (query.teamId !== 'none' && !UUID.test(query.teamId))
			throw invalidQuery('Filtro no válido.');
		params.set('teamId', query.teamId);
	}
	check('supportLevel', SUPPORT_LEVELS);
	check('slaStatus', SLA_OVERALL);
	check('slaFirstResponseStatus', SLA_OBJECTIVE);
	check('slaResolutionStatus', SLA_OBJECTIVE);
	const limit = query.limit ?? INCIDENT_PAGE_DEFAULT_LIMIT;
	if (
		!Number.isInteger(limit) ||
		limit < INCIDENT_PAGE_MIN_LIMIT ||
		limit > INCIDENT_PAGE_MAX_LIMIT
	)
		throw invalidQuery('El tamaño de página no es válido.');
	params.set('limit', String(limit));
	if (query.cursor !== undefined && query.cursor !== null) {
		if (!isValidIncidentCursor(query.cursor))
			throw invalidQuery('La página solicitada no es válida.');
		params.set('cursor', query.cursor);
	}
	return params;
}

/**
 * One keyset page of the incident list. Always sends `limit` so the server answers the paged
 * contract `{ incidents, nextCursor }` (the legacy unpaged listIncidents stays for old callers).
 */
export async function listIncidentsPage(
	organizationId: string,
	query: IncidentPageQuery,
	options: { signal?: AbortSignal; customFetch?: typeof fetch } = {}
): Promise<IncidentPage> {
	const params = buildIncidentPageSearch(organizationId, query);
	const fetchFn = options.customFetch ?? fetch;
	let res: Response;
	try {
		res = await fetchFn(`/api/incidents?${params.toString()}`, {
			method: 'GET',
			signal: options.signal
		});
	} catch (error) {
		if (isAbortError(error, options.signal)) throw error;
		throw networkApiError();
	}
	if (!res.ok) throw await apiErrorFromResponse(res);
	const requestId = readRequestId(res.headers);
	let data: unknown;
	try {
		data = await res.json();
	} catch {
		throw invalidPayloadError(res.status, requestId);
	}
	if (!data || typeof data !== 'object' || Array.isArray(data))
		throw invalidPayloadError(res.status, requestId);
	const body = data as { incidents?: unknown; nextCursor?: unknown };
	if (!Array.isArray(body.incidents)) throw invalidPayloadError(res.status, requestId);
	if (body.nextCursor !== null && !isValidIncidentCursor(body.nextCursor))
		throw invalidPayloadError(res.status, requestId);
	const incidents: IncidentView[] = [];
	for (const raw of body.incidents) {
		try {
			incidents.push(toIncidentView(raw, organizationId, res.status));
		} catch {
			throw invalidPayloadError(res.status, requestId);
		}
	}
	return { incidents, nextCursor: body.nextCursor as string | null };
}

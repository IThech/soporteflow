import {
	ApiError,
	apiErrorFromResponse,
	invalidPayloadError,
	isAbortError,
	networkApiError,
	readRequestId
} from './errors.ts';
import type { SlaObjectiveStatus, SlaOverallStatus, SupportLevel } from './incidents.ts';
import type { IncidentPriority, IncidentStatus } from './incident-views.ts';

/**
 * UI-2A — Incident detail contract (GET /api/incidents/:id and the incident payload of the
 * mutations). Mirrors the backend projections EXACTLY (the server's incident-dto service):
 *
 * - requester (`audience: 'requester'`): the customer allowlist, 17 keys. The view type has NO
 *   internal property at all: reading `client`, `teamName`… on it is a type error, and a payload
 *   carrying any internal key is rejected as INVALID_PAYLOAD (never silently accepted).
 * - staff (no `audience` key on the wire): the full incident row (26 columns) + the 3 derived SLA
 *   compliance statuses. GET /api/incidents/:id adds `assignedToUserName` and `teamName` (joined);
 *   mutation responses (PATCH / assign / site / category / support-level / sla) and POST do not:
 *   they are StaffIncidentRecordView, and a UI must reload the detail instead of inventing names.
 *
 * Classification is a category plus an OPTIONAL subcategory of that category: a payload with a
 * subcategoryId but no categoryId breaks the backend invariant and is rejected.
 *
 * Every value is kept as sent (no renaming, no reinterpretation of SLA, no derived countdown).
 * Returned objects are frozen. This module never imports server code.
 */

export const INCIDENT_TITLE_MAX_LENGTH = 255;
export const INCIDENT_CLIENT_MAX_LENGTH = 255;

interface IncidentDetailCommon {
	readonly id: string;
	readonly organizationId: string;
	readonly incidentNumber: number;
	readonly title: string;
	readonly description: string;
	readonly status: IncidentStatus;
	readonly priority: IncidentPriority;
	readonly clientUserId: string | null;
	readonly siteId: string | null;
	readonly categoryId: string | null;
	/** Optional subcategory of categoryId (never set without a category). */
	readonly subcategoryId: string | null;
	readonly slaOverallStatus: SlaOverallStatus;
	readonly slaFirstResponseStatus: SlaObjectiveStatus;
	readonly slaResolutionStatus: SlaObjectiveStatus;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** Customer projection: nothing internal exists on this type. */
export interface RequesterIncidentDetailView extends IncidentDetailCommon {
	readonly audience: 'requester';
}

/** Staff incident as returned by mutations and POST (full row, no joined names). */
export interface StaffIncidentRecordView extends IncidentDetailCommon {
	readonly audience: 'staff';
	/** Free-text client label (staff classification). Distinct from clientUserId. */
	readonly client: string;
	readonly createdByUserId: string;
	readonly supportLevel: SupportLevel;
	readonly assignedToUserId: string | null;
	readonly teamId: string | null;
	/** SLA snapshot (5.4T-B): all null (no SLA) or all set, never partially. */
	readonly slaPolicyId: string | null;
	readonly slaFirstResponseMinutes: number | null;
	readonly slaResolutionMinutes: number | null;
	readonly slaAppliedAt: string | null;
	readonly firstResponseDueAt: string | null;
	readonly resolutionDueAt: string | null;
	/** Achievement facts (first write wins; kept on reopen). Independent of the snapshot. */
	readonly firstResponseAt: string | null;
	readonly firstResolvedAt: string | null;
}

/** Staff detail (GET /api/incidents/:id): the record + the names the server joined. */
export interface StaffIncidentDetailView extends StaffIncidentRecordView {
	readonly assignedToUserName: string | null;
	readonly teamName: string | null;
}

export type IncidentDetailView = RequesterIncidentDetailView | StaffIncidentDetailView;
/** POST /api/incidents answers with the creator's audience projection (no joined names). */
export type CreatedIncidentView = RequesterIncidentDetailView | StaffIncidentRecordView;

// ------------------------------------------------------------------------------------------------
// Strict validation
// ------------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const STATUSES: readonly string[] = ['open', 'pending', 'resolved', 'closed'];
const PRIORITIES: readonly string[] = ['low', 'medium', 'high', 'urgent'];
const SUPPORT_LEVELS: readonly string[] = ['N1', 'N2', 'N3'];
const SLA_OVERALL: readonly string[] = ['not_applicable', 'on_track', 'met', 'breached'];
const SLA_OBJECTIVE: readonly string[] = ['not_applicable', 'pending', 'met', 'breached'];

const COMMON_KEYS = [
	'id',
	'organizationId',
	'incidentNumber',
	'title',
	'description',
	'status',
	'priority',
	'clientUserId',
	'siteId',
	'categoryId',
	'subcategoryId',
	'slaOverallStatus',
	'slaFirstResponseStatus',
	'slaResolutionStatus',
	'createdAt',
	'updatedAt'
] as const;
const REQUESTER_KEYS: ReadonlySet<string> = new Set(['audience', ...COMMON_KEYS]);
const STAFF_RECORD_KEYS: ReadonlySet<string> = new Set([
	...COMMON_KEYS,
	'client',
	'createdByUserId',
	'supportLevel',
	'assignedToUserId',
	'teamId',
	'slaPolicyId',
	'slaFirstResponseMinutes',
	'slaResolutionMinutes',
	'slaAppliedAt',
	'firstResponseDueAt',
	'resolutionDueAt',
	'firstResponseAt',
	'firstResolvedAt'
]);
const STAFF_DETAIL_KEYS: ReadonlySet<string> = new Set([
	...STAFF_RECORD_KEYS,
	'assignedToUserName',
	'teamName'
]);

/** Internal validation failure (converted into ApiError INVALID_PAYLOAD by the caller). */
class ContractViolation extends Error {}
function fail(): never {
	throw new ContractViolation();
}
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const isTimestamp = (value: unknown): value is string =>
	typeof value === 'string' && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
const nullableUuid = (value: unknown) => (value === null || isUuid(value) ? value : fail());
const nullableTimestamp = (value: unknown) =>
	value === null || isTimestamp(value) ? value : fail();
const nullableString = (value: unknown) =>
	value === null || typeof value === 'string' ? value : fail();
const oneOf = (value: unknown, allowed: readonly string[]) =>
	typeof value === 'string' && allowed.includes(value) ? value : fail();

function exactKeys(item: Record<string, unknown>, keys: ReadonlySet<string>) {
	const present = Object.keys(item);
	if (present.length !== keys.size || present.some((key) => !keys.has(key))) fail();
}

function common(item: Record<string, unknown>, expect: DetailExpectation): IncidentDetailCommon {
	if (!isUuid(item.id) || !isUuid(item.organizationId)) fail();
	if (item.organizationId !== expect.organizationId) fail();
	if (expect.incidentId !== undefined && item.id !== expect.incidentId) fail();
	if (
		typeof item.incidentNumber !== 'number' ||
		!Number.isSafeInteger(item.incidentNumber) ||
		item.incidentNumber < 1
	)
		fail();
	if (typeof item.title !== 'string' || typeof item.description !== 'string') fail();
	if (!isTimestamp(item.createdAt) || !isTimestamp(item.updatedAt)) fail();
	const categoryId = nullableUuid(item.categoryId) as string | null;
	const subcategoryId = nullableUuid(item.subcategoryId) as string | null;
	if (subcategoryId !== null && categoryId === null) fail();
	return {
		id: item.id as string,
		organizationId: item.organizationId as string,
		incidentNumber: item.incidentNumber as number,
		title: item.title as string,
		description: item.description as string,
		status: oneOf(item.status, STATUSES) as IncidentStatus,
		priority: oneOf(item.priority, PRIORITIES) as IncidentPriority,
		clientUserId: nullableUuid(item.clientUserId) as string | null,
		siteId: nullableUuid(item.siteId) as string | null,
		categoryId,
		subcategoryId,
		slaOverallStatus: oneOf(item.slaOverallStatus, SLA_OVERALL) as SlaOverallStatus,
		slaFirstResponseStatus: oneOf(item.slaFirstResponseStatus, SLA_OBJECTIVE) as SlaObjectiveStatus,
		slaResolutionStatus: oneOf(item.slaResolutionStatus, SLA_OBJECTIVE) as SlaObjectiveStatus,
		createdAt: item.createdAt as string,
		updatedAt: item.updatedAt as string
	};
}

const isMinutes = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

function staffRecord(item: Record<string, unknown>, expect: DetailExpectation) {
	const base = common(item, expect);
	if (typeof item.client !== 'string' || !isUuid(item.createdByUserId)) fail();
	const snapshot = [
		item.slaPolicyId,
		item.slaFirstResponseMinutes,
		item.slaResolutionMinutes,
		item.slaAppliedAt,
		item.firstResponseDueAt,
		item.resolutionDueAt
	];
	const hasSla = snapshot.some((value) => value !== null);
	if (hasSla) {
		// Server CHECK: the whole snapshot or nothing (never a partial SLA).
		if (
			!isUuid(item.slaPolicyId) ||
			!isMinutes(item.slaFirstResponseMinutes) ||
			!isMinutes(item.slaResolutionMinutes) ||
			!isTimestamp(item.slaAppliedAt) ||
			!isTimestamp(item.firstResponseDueAt) ||
			!isTimestamp(item.resolutionDueAt)
		)
			fail();
	}
	// Derived statuses are coherent with the presence of an SLA (not_applicable <-> no SLA).
	for (const status of [
		base.slaOverallStatus,
		base.slaFirstResponseStatus,
		base.slaResolutionStatus
	])
		if ((status === 'not_applicable') === hasSla) fail();
	return {
		audience: 'staff' as const,
		...base,
		client: item.client as string,
		createdByUserId: item.createdByUserId as string,
		supportLevel: oneOf(item.supportLevel, SUPPORT_LEVELS) as SupportLevel,
		assignedToUserId: nullableUuid(item.assignedToUserId) as string | null,
		teamId: nullableUuid(item.teamId) as string | null,
		slaPolicyId: item.slaPolicyId as string | null,
		slaFirstResponseMinutes: item.slaFirstResponseMinutes as number | null,
		slaResolutionMinutes: item.slaResolutionMinutes as number | null,
		slaAppliedAt: item.slaAppliedAt as string | null,
		firstResponseDueAt: item.firstResponseDueAt as string | null,
		resolutionDueAt: item.resolutionDueAt as string | null,
		firstResponseAt: nullableTimestamp(item.firstResponseAt) as string | null,
		firstResolvedAt: nullableTimestamp(item.firstResolvedAt) as string | null
	};
}

function requester(item: Record<string, unknown>, expect: DetailExpectation) {
	exactKeys(item, REQUESTER_KEYS);
	return Object.freeze({ audience: 'requester' as const, ...common(item, expect) });
}

export interface DetailExpectation {
	/** Tenant the request was made for: a payload of another organization is invalid. */
	organizationId: string;
	/** The requested incident (omit only for POST, where the id is new). */
	incidentId?: string;
}

function asRecord(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail();
	return raw as Record<string, unknown>;
}

function guarded<T>(parse: () => T, status: number, requestId?: string): T {
	try {
		return parse();
	} catch (error) {
		if (error instanceof ContractViolation) throw invalidPayloadError(status, requestId);
		throw error;
	}
}

/** GET /api/incidents/:id payload -> discriminated detail (throws ApiError INVALID_PAYLOAD). */
export function parseIncidentDetail(
	raw: unknown,
	expect: DetailExpectation,
	status = 200,
	requestId?: string
): IncidentDetailView {
	return guarded(
		() => {
			const item = asRecord(raw);
			if (item.audience === 'requester') return requester(item, expect);
			exactKeys(item, STAFF_DETAIL_KEYS);
			return Object.freeze({
				...staffRecord(item, expect),
				assignedToUserName: nullableString(item.assignedToUserName) as string | null,
				teamName: nullableString(item.teamName) as string | null
			});
		},
		status,
		requestId
	);
}

/** Staff incident of a mutation response (PATCH, assign, site, category, support-level, sla). */
export function parseStaffIncidentRecord(
	raw: unknown,
	expect: DetailExpectation,
	status = 200,
	requestId?: string
): StaffIncidentRecordView {
	return guarded(
		() => {
			const item = asRecord(raw);
			exactKeys(item, STAFF_RECORD_KEYS);
			return Object.freeze(staffRecord(item, expect));
		},
		status,
		requestId
	);
}

/** POST /api/incidents payload: the creator's audience projection. */
export function parseCreatedIncident(
	raw: unknown,
	expect: DetailExpectation,
	status = 201,
	requestId?: string
): CreatedIncidentView {
	return guarded(
		() => {
			const item = asRecord(raw);
			if (item.audience === 'requester') return requester(item, expect);
			exactKeys(item, STAFF_RECORD_KEYS);
			return Object.freeze(staffRecord(item, expect));
		},
		status,
		requestId
	);
}

// ------------------------------------------------------------------------------------------------
// Transport
// ------------------------------------------------------------------------------------------------

export interface IncidentRequestOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

function invalidInput(message: string): ApiError {
	return new ApiError(0, 'INVALID_INPUT', message);
}

export function assertIncidentIds(organizationId: unknown, incidentId?: unknown): void {
	if (!isUuid(organizationId)) throw invalidInput('La organización no es válida.');
	if (incidentId !== undefined && !isUuid(incidentId))
		throw invalidInput('La incidencia no es válida.');
}

/**
 * Sends one request and returns the parsed JSON object of a 2xx response.
 * - network failure -> ApiError NETWORK_ERROR (status 0); an abort is re-thrown untouched;
 * - non-2xx -> apiErrorFromResponse (code, safe message, Retry-After, X-Request-ID);
 * - unreadable 2xx body -> ApiError INVALID_PAYLOAD with the request id.
 */
export async function requestIncidentJson(
	url: string,
	init: RequestInit,
	options: IncidentRequestOptions = {}
): Promise<{ body: Record<string, unknown>; status: number; requestId: string | undefined }> {
	const fetchFn = options.customFetch ?? fetch;
	let res: Response;
	try {
		res = await fetchFn(url, { ...init, signal: options.signal });
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
	return { body: data as Record<string, unknown>, status: res.status, requestId };
}

/** GET /api/incidents/:id -> IncidentDetailView (staff or requester, strictly validated). */
export async function getIncidentDetail(
	organizationId: string,
	incidentId: string,
	options: IncidentRequestOptions = {}
): Promise<IncidentDetailView> {
	assertIncidentIds(organizationId, incidentId);
	const params = new URLSearchParams({ organizationId });
	const { body, status, requestId } = await requestIncidentJson(
		`/api/incidents/${encodeURIComponent(incidentId)}?${params.toString()}`,
		{ method: 'GET' },
		options
	);
	if (Object.keys(body).length !== 1) throw invalidPayloadError(status, requestId);
	return parseIncidentDetail(body.incident, { organizationId, incidentId }, status, requestId);
}

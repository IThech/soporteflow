import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { incidents, incidentHistory } from '../db/schema';
import { IncidentServiceError, type IncidentDatabase } from './incidents';

export const SAFE_HISTORY_TYPES = [
	'created',
	'status_changed',
	'priority_changed',
	'assigned',
	'reassigned',
	'support_level_changed',
	'site_changed',
	'resolved',
	'closed',
	'reopened'
] as const;
export type SafeIncidentHistoryType = (typeof SAFE_HISTORY_TYPES)[number];
type Status = 'open' | 'pending' | 'resolved' | 'closed';
type Priority = 'low' | 'medium' | 'high' | 'urgent';
type Level = 'N1' | 'N2' | 'N3';
type Change<T> = { from?: T; to?: T };
type Base<T extends SafeIncidentHistoryType> = {
	id: string;
	type: T;
	occurredAt: string;
	actor: { type: 'user' | 'system'; label: 'Usuario' | 'Sistema' };
};
export type IncidentHistoryItem =
	| Base<'created'>
	| (Base<'status_changed' | 'resolved' | 'closed' | 'reopened'> & {
			changes?: { status: Change<Status> };
	  })
	| (Base<'priority_changed'> & { changes?: { priority: Change<Priority> } })
	| (Base<'support_level_changed'> & { changes?: { supportLevel: Change<Level> } })
	| (Base<'assigned' | 'reassigned'> & { changes?: { assignmentChanged: true } })
	| (Base<'site_changed'> & { changes?: { siteChanged: true } });
export interface IncidentHistoryPage {
	items: IncidentHistoryItem[];
	nextCursor: string | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const invalid = () => new IncidentServiceError('INVALID_INPUT', 'Invalid history query.');
type Cursor = { at: string; id: string };
function validTimestamp(at: string): boolean {
	if (!timestamp.test(at)) return false;
	const milliseconds = at.slice(0, 23) + 'Z';
	const date = new Date(milliseconds);
	return Number.isFinite(date.getTime()) && date.toISOString() === milliseconds;
}
function encodeCursor(cursor: Cursor): string {
	return Buffer.from(JSON.stringify([cursor.at, cursor.id])).toString('base64url');
}
export function parseHistoryQuery(params: URLSearchParams): {
	limit: number;
	cursor: Cursor | null;
} {
	for (const key of params.keys()) {
		if (!['organizationId', 'limit', 'cursor'].includes(key) || params.getAll(key).length !== 1)
			throw invalid();
	}
	const rawLimit = params.get('limit');
	if (rawLimit !== null && !/^(?:[1-9]\d?|100)$/.test(rawLimit)) throw invalid();
	const limit = rawLimit === null ? 50 : Number(rawLimit);
	const raw = params.get('cursor');
	if (raw === null) return { limit, cursor: null };
	if (raw.length > 256 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid();
	try {
		const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
		if (
			!Array.isArray(value) ||
			value.length !== 2 ||
			typeof value[0] !== 'string' ||
			!validTimestamp(value[0]) ||
			typeof value[1] !== 'string' ||
			!uuid.test(value[1])
		)
			throw invalid();
		const cursor = { at: value[0], id: value[1] };
		if (encodeCursor(cursor) !== raw) throw invalid();
		return { limit, cursor };
	} catch {
		throw invalid();
	}
}
type ProjectionRow = {
	id: string;
	eventType: string;
	actorType: string;
	occurredAt: string;
	payload: unknown;
};
function change<T extends string>(
	from: unknown,
	to: unknown,
	allowed: readonly T[]
): Change<T> | undefined {
	const result: Change<T> = {};
	if (typeof from === 'string' && allowed.includes(from as T)) result.from = from as T;
	if (typeof to === 'string' && allowed.includes(to as T)) result.to = to as T;
	return Object.keys(result).length ? result : undefined;
}
/** Explicit allowlist: never copy row, reason, comment or payload properties into the DTO. */
export function projectHistoryItem(row: ProjectionRow): IncidentHistoryItem | null {
	if (
		!uuid.test(row.id) ||
		!validTimestamp(row.occurredAt) ||
		(row.actorType !== 'user' && row.actorType !== 'system')
	)
		return null;
	const base: Omit<Base<SafeIncidentHistoryType>, 'type'> = {
		id: row.id,
		occurredAt: row.occurredAt,
		actor: {
			type: row.actorType,
			label: row.actorType === 'user' ? ('Usuario' as const) : ('Sistema' as const)
		}
	};
	const payload =
		row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
			? (row.payload as Record<string, unknown>)
			: {};
	switch (row.eventType) {
		case 'created':
			return { ...base, type: 'created' };
		case 'assigned':
		case 'reassigned':
			return {
				...base,
				type: row.eventType,
				...(row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
					? { changes: { assignmentChanged: true as const } }
					: {})
			};
		case 'site_changed':
			// Like assignments: signal the change only, never fromSiteId/toSiteId or site names.
			return {
				...base,
				type: 'site_changed',
				...(row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
					? { changes: { siteChanged: true as const } }
					: {})
			};
		case 'status_changed':
		case 'resolved':
		case 'closed':
		case 'reopened': {
			const status = change(payload.oldStatus, payload.newStatus, [
				'open',
				'pending',
				'resolved',
				'closed'
			] as const);
			return { ...base, type: row.eventType, ...(status ? { changes: { status } } : {}) };
		}
		case 'priority_changed': {
			const priority = change(payload.oldPriority, payload.newPriority, [
				'low',
				'medium',
				'high',
				'urgent'
			] as const);
			return { ...base, type: row.eventType, ...(priority ? { changes: { priority } } : {}) };
		}
		case 'support_level_changed': {
			const supportLevel = change(payload.previousSupportLevel, payload.newSupportLevel, [
				'N1',
				'N2',
				'N3'
			] as const);
			return {
				...base,
				type: row.eventType,
				...(supportLevel ? { changes: { supportLevel } } : {})
			};
		}
		default:
			return null;
	}
}
/** Caller must authorize incidents:view_all. Tenant membership of the incident is checked here too. */
export async function listIncidentHistory(
	db: IncidentDatabase,
	context: { organizationId: string; incidentId: string },
	params: URLSearchParams = new URLSearchParams()
): Promise<IncidentHistoryPage> {
	if (!uuid.test(context.organizationId) || !uuid.test(context.incidentId)) throw invalid();
	const { limit, cursor } = parseHistoryQuery(params);
	const [incident] = await db
		.select({ id: incidents.id })
		.from(incidents)
		.where(
			and(
				eq(incidents.id, context.incidentId),
				eq(incidents.organizationId, context.organizationId)
			)
		)
		.limit(1);
	if (!incident) throw new IncidentServiceError('INCIDENT_NOT_FOUND', 'Incident not found.');
	const conditions = [
		eq(incidentHistory.incidentId, context.incidentId),
		eq(incidentHistory.organizationId, context.organizationId),
		inArray(incidentHistory.eventType, [...SAFE_HISTORY_TYPES])
	];
	if (cursor)
		conditions.push(
			sql`(${incidentHistory.createdAt}, ${incidentHistory.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
		);
	// Keep PostgreSQL microseconds: JS Date would lose precision at the page boundary.
	const rows = await db
		.select({
			id: incidentHistory.id,
			eventType: incidentHistory.eventType,
			actorType: incidentHistory.actorType,
			payload: incidentHistory.payload,
			occurredAt: sql<string>`to_char(${incidentHistory.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
		})
		.from(incidentHistory)
		.where(and(...conditions))
		.orderBy(desc(incidentHistory.createdAt), desc(incidentHistory.id))
		.limit(limit + 1);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page
			.map(projectHistoryItem)
			.filter((item): item is IncidentHistoryItem => item !== null),
		nextCursor:
			rows.length > limit && last ? encodeCursor({ at: last.occurredAt, id: last.id }) : null
	};
}

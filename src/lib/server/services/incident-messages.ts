import { and, desc, eq, sql } from 'drizzle-orm';
import {
	incidents,
	incidentHistory,
	incidentMessages,
	memberships,
	organizations,
	users
} from '../db/schema';
import { IncidentServiceError, type IncidentDatabase } from './incidents';

/** Internal note DTO: explicit allowlist, never exposes tenant, incident or author UUIDs. */
export interface InternalNoteItem {
	id: string;
	body: string;
	createdAt: string;
	author: { name: string };
}
export interface InternalNotePage {
	items: InternalNoteItem[];
	nextCursor: string | null;
}
export interface InternalNoteContext {
	readonly organizationId: string;
	readonly incidentId: string;
}
export interface CreateInternalNoteContext extends InternalNoteContext {
	readonly actorUserId: string;
}

export const INTERNAL_NOTE_MAX_LENGTH = 4000;
export const UNAVAILABLE_AUTHOR_NAME = 'Usuario no disponible';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const invalidQuery = () =>
	new IncidentServiceError('INVALID_INPUT', 'Invalid internal notes query.');
// Keep PostgreSQL microseconds: JS Date would lose precision at the page boundary.
const createdAtIso = sql<string>`to_char(${incidentMessages.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function isValidUuid(value: unknown): value is string {
	return typeof value === 'string' && uuid.test(value);
}

function authorName(displayName: string | null, name: string | null): string {
	return displayName?.trim() || name?.trim() || UNAVAILABLE_AUTHOR_NAME;
}

// Cursor helpers intentionally mirror incident-history.ts (5.4M) instead of sharing code with it.
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
export function parseInternalNotesQuery(params: URLSearchParams): {
	limit: number;
	cursor: Cursor | null;
} {
	for (const key of params.keys()) {
		if (!['organizationId', 'limit', 'cursor'].includes(key) || params.getAll(key).length !== 1)
			throw invalidQuery();
	}
	const rawLimit = params.get('limit');
	if (rawLimit !== null && !/^(?:[1-9]\d?|100)$/.test(rawLimit)) throw invalidQuery();
	const limit = rawLimit === null ? 50 : Number(rawLimit);
	const raw = params.get('cursor');
	if (raw === null) return { limit, cursor: null };
	if (raw.length > 256 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalidQuery();
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
			throw invalidQuery();
		const cursor = { at: value[0], id: value[1] };
		if (encodeCursor(cursor) !== raw) throw invalidQuery();
		return { limit, cursor };
	} catch {
		throw invalidQuery();
	}
}

/**
 * Appends an internal note and its internal_note_added audit event in one transaction.
 * Caller must authorize the actor; organizationId, incidentId and actorUserId must come
 * from trusted server context. Visibility is fixed to 'internal'. The body is stored as
 * literal text (trimmed, never sanitized) and is never copied into incident_history.
 */
export async function createInternalNote(
	dbOrTx: IncidentDatabase,
	context: CreateInternalNoteContext,
	body: unknown
): Promise<InternalNoteItem> {
	// 1. Context and input validation
	if (!isValidUuid(context?.organizationId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'organizationId must be a valid UUID');
	}
	if (!isValidUuid(context?.incidentId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'incidentId must be a valid UUID');
	}
	if (!isValidUuid(context?.actorUserId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'actorUserId must be a valid UUID');
	}
	if (typeof body !== 'string') {
		throw new IncidentServiceError('INVALID_INPUT', 'body must be a string');
	}
	const text = body.trim();
	if (!text) {
		throw new IncidentServiceError('INVALID_INPUT', 'body must be a non-empty string');
	}
	if (text.length > INTERNAL_NOTE_MAX_LENGTH) {
		throw new IncidentServiceError(
			'INVALID_INPUT',
			`body must not exceed ${INTERNAL_NOTE_MAX_LENGTH} characters`
		);
	}

	const execute = async (tx: IncidentDatabase): Promise<InternalNoteItem> => {
		// A. Validate Organization existence & operational status
		const [org] = await tx
			.select({ id: organizations.id, status: organizations.status })
			.from(organizations)
			.where(eq(organizations.id, context.organizationId))
			.limit(1);
		if (!org) {
			throw new IncidentServiceError('ORGANIZATION_NOT_FOUND', 'Organization does not exist');
		}
		if (org.status !== 'active') {
			throw new IncidentServiceError(
				'ORGANIZATION_NOT_OPERATIONAL',
				`Organization is not operational (status: '${org.status}')`
			);
		}

		// B. Validate actor membership and user activity in this tenant
		const [actor] = await tx
			.select({
				membershipActive: memberships.active,
				userActive: users.active,
				name: users.name,
				displayName: users.displayName
			})
			.from(memberships)
			.innerJoin(users, eq(users.id, memberships.userId))
			.where(
				and(
					eq(memberships.organizationId, context.organizationId),
					eq(memberships.userId, context.actorUserId)
				)
			)
			.limit(1);
		if (!actor) {
			throw new IncidentServiceError(
				'CREATOR_MEMBERSHIP_NOT_FOUND',
				'Actor user is not a member of this organization'
			);
		}
		if (!actor.membershipActive) {
			throw new IncidentServiceError(
				'CREATOR_MEMBERSHIP_INACTIVE',
				'Actor user membership is inactive'
			);
		}
		if (!actor.userActive) {
			throw new IncidentServiceError('CREATOR_USER_INACTIVE', 'Actor user account is inactive');
		}

		// C. Lock the incident within the tenant. FOR SHARE conflicts with the row lock taken by
		// a concurrent UPDATE (e.g. closing), so the status read here stays valid until commit.
		const [incident] = await tx
			.select({ id: incidents.id, status: incidents.status })
			.from(incidents)
			.where(
				and(
					eq(incidents.id, context.incidentId),
					eq(incidents.organizationId, context.organizationId)
				)
			)
			.limit(1)
			.for('share');
		if (!incident) {
			throw new IncidentServiceError('INCIDENT_NOT_FOUND', 'Incident not found');
		}
		if (incident.status === 'closed') {
			throw new IncidentServiceError('INCIDENT_CLOSED', 'Incident is closed');
		}

		// D. Append the message
		const [message] = await tx
			.insert(incidentMessages)
			.values({
				organizationId: context.organizationId,
				incidentId: context.incidentId,
				authorUserId: context.actorUserId,
				visibility: 'internal',
				body: text
			})
			.returning({ id: incidentMessages.id, body: incidentMessages.body, createdAt: createdAtIso });

		// E. Audit event: only the message id, never the note body
		await tx.insert(incidentHistory).values({
			incidentId: context.incidentId,
			organizationId: context.organizationId,
			eventType: 'internal_note_added',
			actorType: 'user',
			actorUserId: context.actorUserId,
			reason: null,
			comment: null,
			payload: { messageId: message.id }
		});

		return {
			id: message.id,
			body: message.body,
			createdAt: message.createdAt,
			author: { name: authorName(actor.displayName, actor.name) }
		};
	};

	if ('transaction' in dbOrTx && typeof dbOrTx.transaction === 'function') {
		return await dbOrTx.transaction(async (tx) => execute(tx));
	}
	return await execute(dbOrTx);
}

/** Caller must authorize reading internal notes. Tenant membership of the incident is checked here too. */
export async function listInternalNotes(
	db: IncidentDatabase,
	context: InternalNoteContext,
	params: URLSearchParams = new URLSearchParams()
): Promise<InternalNotePage> {
	if (!isValidUuid(context?.organizationId) || !isValidUuid(context?.incidentId)) {
		throw invalidQuery();
	}
	const { limit, cursor } = parseInternalNotesQuery(params);
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
		eq(incidentMessages.organizationId, context.organizationId),
		eq(incidentMessages.incidentId, context.incidentId),
		eq(incidentMessages.visibility, 'internal')
	];
	if (cursor)
		conditions.push(
			sql`(${incidentMessages.createdAt}, ${incidentMessages.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
		);
	const rows = await db
		.select({
			id: incidentMessages.id,
			body: incidentMessages.body,
			createdAt: createdAtIso,
			name: users.name,
			displayName: users.displayName
		})
		.from(incidentMessages)
		.leftJoin(users, eq(users.id, incidentMessages.authorUserId))
		.where(and(...conditions))
		.orderBy(desc(incidentMessages.createdAt), desc(incidentMessages.id))
		.limit(limit + 1);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page.map((row) => ({
			id: row.id,
			body: row.body,
			createdAt: row.createdAt,
			author: { name: authorName(row.displayName, row.name) }
		})),
		nextCursor:
			rows.length > limit && last ? encodeCursor({ at: last.createdAt, id: last.id }) : null
	};
}

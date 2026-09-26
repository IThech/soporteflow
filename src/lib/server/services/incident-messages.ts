import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
	incidents,
	incidentHistory,
	incidentMessages,
	memberships,
	organizations,
	users
} from '../db/schema';
import { IncidentServiceError, incidentAccessAllows, type IncidentDatabase } from './incidents';

/** Message DTO: explicit allowlist, never exposes tenant, incident or author UUIDs. */
export interface IncidentMessageItem {
	id: string;
	body: string;
	createdAt: string;
	author: { name: string };
}
export interface IncidentMessagePage {
	items: IncidentMessageItem[];
	nextCursor: string | null;
}
export type InternalNoteItem = IncidentMessageItem;
export type InternalNotePage = IncidentMessagePage;
export type PublicCommentItem = IncidentMessageItem;
export type PublicCommentPage = IncidentMessagePage;

export interface InternalNoteContext {
	readonly organizationId: string;
	readonly incidentId: string;
}
export interface CreateInternalNoteContext extends InternalNoteContext {
	readonly actorUserId: string;
}
export interface PublicCommentContext {
	readonly organizationId: string;
	readonly incidentId: string;
	/**
	 * Read restrictions resolved from the caller's permissions (5.4S-B), applied as a UNION:
	 * - assignedToUserId (incidents:view_own): incidents assigned to this user;
	 * - clientUserId (incidents:view_requested): incidents whose requester is this user.
	 * Omit both only when the caller holds incidents:view_all.
	 */
	readonly assignedToUserId?: string;
	readonly clientUserId?: string;
}
export interface CreatePublicCommentContext extends PublicCommentContext {
	readonly actorUserId: string;
	/**
	 * 5.4T-B: true when the caller reaches the incident through a support scope (incidents:view_all
	 * or incidents:view_own, resolved from capabilities, never role codes). Such a comment records
	 * the incident's first response unless the actor is the incident's requester.
	 */
	readonly supportResponse?: boolean;
}

type Visibility = 'internal' | 'public';

export const MESSAGE_MAX_LENGTH = 4000;
export const INTERNAL_NOTE_MAX_LENGTH = MESSAGE_MAX_LENGTH;
export const UNAVAILABLE_AUTHOR_NAME = 'Usuario no disponible';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const QUERY_ERROR: Record<Visibility, string> = {
	internal: 'Invalid internal notes query.',
	public: 'Invalid comments query.'
};
// Keep PostgreSQL microseconds: JS Date would lose precision at the page boundary.
const createdAtIso = sql<string>`to_char(${incidentMessages.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function isValidUuid(value: unknown): value is string {
	return typeof value === 'string' && uuid.test(value);
}

function authorName(displayName: string | null, name: string | null): string {
	return displayName?.trim() || name?.trim() || UNAVAILABLE_AUTHOR_NAME;
}

function accessDenied() {
	return new IncidentServiceError('INCIDENT_ACCESS_DENIED', 'Incident access denied');
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
function parseMessageQuery(
	params: URLSearchParams,
	visibility: Visibility
): { limit: number; cursor: Cursor | null } {
	const invalid = () => new IncidentServiceError('INVALID_INPUT', QUERY_ERROR[visibility]);
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
export function parseInternalNotesQuery(params: URLSearchParams) {
	return parseMessageQuery(params, 'internal');
}
export function parsePublicCommentsQuery(params: URLSearchParams) {
	return parseMessageQuery(params, 'public');
}

function validateBody(body: unknown): string {
	if (typeof body !== 'string') {
		throw new IncidentServiceError('INVALID_INPUT', 'body must be a string');
	}
	const text = body.trim();
	if (!text) {
		throw new IncidentServiceError('INVALID_INPUT', 'body must be a non-empty string');
	}
	if (text.length > MESSAGE_MAX_LENGTH) {
		throw new IncidentServiceError(
			'INVALID_INPUT',
			`body must not exceed ${MESSAGE_MAX_LENGTH} characters`
		);
	}
	// PostgreSQL text rejects NUL (would surface as a 500) and the driver silently replaces
	// lone surrogates with U+FFFD, altering the stored text.
	if (text.includes('\u0000') || LONE_SURROGATE.test(text)) {
		throw new IncidentServiceError('INVALID_INPUT', 'body contains invalid characters');
	}
	return text;
}
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

type AppendContext = CreateInternalNoteContext & {
	readonly assignedToUserId?: string;
	readonly clientUserId?: string;
	readonly supportResponse?: boolean;
};

/** Restricted (view_own and/or view_requested) or unrestricted (neither field set). */
function restrictionOf(context: { assignedToUserId?: string; clientUserId?: string }) {
	if (context.assignedToUserId === undefined && context.clientUserId === undefined)
		return undefined;
	return { assignedToUserId: context.assignedToUserId, clientUserId: context.clientUserId };
}
function invalidRestriction(context: { assignedToUserId?: string; clientUserId?: string }) {
	return (
		(context.assignedToUserId !== undefined && !isValidUuid(context.assignedToUserId)) ||
		(context.clientUserId !== undefined && !isValidUuid(context.clientUserId))
	);
}

/**
 * Shared append path. Organization, actor and incident checks run inside one transaction;
 * the incident is read FOR SHARE, which conflicts with the row lock of a concurrent UPDATE
 * (closing, reassignment), so status and assignment stay valid until commit.
 * Only internal notes write an audit event; public comments never touch incident_history.
 */
async function appendMessage(
	dbOrTx: IncidentDatabase,
	context: AppendContext,
	body: unknown,
	visibility: Visibility
): Promise<IncidentMessageItem> {
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
	if (invalidRestriction(context)) {
		throw new IncidentServiceError('INVALID_INPUT', 'access restriction must be a valid UUID');
	}
	const text = validateBody(body);

	const execute = async (tx: IncidentDatabase): Promise<IncidentMessageItem> => {
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

		// C. Lock the incident within the tenant and check access and status. A support reply may
		// write first_response_at, so it takes the row lock up front (FOR UPDATE) instead of
		// upgrading a shared lock later (two concurrent replies would otherwise deadlock).
		const recordsResponse = visibility === 'public' && context.supportResponse === true;
		const lookup = tx
			.select({
				id: incidents.id,
				status: incidents.status,
				assignedToUserId: incidents.assignedToUserId,
				clientUserId: incidents.clientUserId
			})
			.from(incidents)
			.where(
				and(
					eq(incidents.id, context.incidentId),
					eq(incidents.organizationId, context.organizationId)
				)
			)
			.limit(1);
		const [incident] = await (recordsResponse ? lookup.for('update') : lookup.for('share'));
		if (!incident) {
			throw new IncidentServiceError('INCIDENT_NOT_FOUND', 'Incident not found');
		}
		if (!incidentAccessAllows(restrictionOf(context), incident)) {
			throw accessDenied();
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
				visibility,
				body: text
			})
			.returning({ id: incidentMessages.id, body: incidentMessages.body, createdAt: createdAtIso });

		// D.2 First response (5.4T-B): first support reply by someone other than the requester.
		// Idempotent, first write wins (never overwritten). Internal notes, requester comments and
		// history never count.
		if (recordsResponse && incident.clientUserId !== context.actorUserId) {
			const [recorded] = await tx
				.update(incidents)
				.set({ firstResponseAt: sql`now()` })
				.where(
					and(
						eq(incidents.id, context.incidentId),
						eq(incidents.organizationId, context.organizationId),
						isNull(incidents.firstResponseAt)
					)
				)
				.returning({
					slaPolicyId: incidents.slaPolicyId,
					firstResponseAt: incidents.firstResponseAt,
					firstResponseDueAt: incidents.firstResponseDueAt
				});
			// 5.4T-C: SLA first-response result, recorded once (only when this reply is the first one
			// and the incident has an SLA), in the same transaction as the comment.
			if (recorded?.slaPolicyId && recorded.firstResponseAt && recorded.firstResponseDueAt) {
				const met = recorded.firstResponseAt.getTime() <= recorded.firstResponseDueAt.getTime();
				await tx.insert(incidentHistory).values({
					incidentId: context.incidentId,
					organizationId: context.organizationId,
					eventType: met ? 'sla_first_response_met' : 'sla_first_response_breached',
					actorType: 'user',
					actorUserId: context.actorUserId,
					reason: null,
					comment: null,
					payload: {
						dueAt: recorded.firstResponseDueAt.toISOString(),
						achievedAt: recorded.firstResponseAt.toISOString()
					}
				});
			}
		}

		// E. Audit event for internal notes only: the message id, never the note body
		if (visibility === 'internal') {
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
		}

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

async function listMessages(
	db: IncidentDatabase,
	context: PublicCommentContext,
	params: URLSearchParams,
	visibility: Visibility
): Promise<IncidentMessagePage> {
	if (
		!isValidUuid(context?.organizationId) ||
		!isValidUuid(context?.incidentId) ||
		invalidRestriction(context)
	) {
		throw new IncidentServiceError('INVALID_INPUT', QUERY_ERROR[visibility]);
	}
	const { limit, cursor } = parseMessageQuery(params, visibility);
	const [incident] = await db
		.select({
			id: incidents.id,
			assignedToUserId: incidents.assignedToUserId,
			clientUserId: incidents.clientUserId
		})
		.from(incidents)
		.where(
			and(
				eq(incidents.id, context.incidentId),
				eq(incidents.organizationId, context.organizationId)
			)
		)
		.limit(1);
	if (!incident) throw new IncidentServiceError('INCIDENT_NOT_FOUND', 'Incident not found.');
	if (!incidentAccessAllows(restrictionOf(context), incident)) throw accessDenied();

	const conditions = [
		eq(incidentMessages.organizationId, context.organizationId),
		eq(incidentMessages.incidentId, context.incidentId),
		eq(incidentMessages.visibility, visibility)
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
	return appendMessage(
		dbOrTx,
		{
			organizationId: context?.organizationId,
			incidentId: context?.incidentId,
			actorUserId: context?.actorUserId
		},
		body,
		'internal'
	);
}

/** Caller must authorize reading internal notes. Tenant membership of the incident is checked here too. */
export async function listInternalNotes(
	db: IncidentDatabase,
	context: InternalNoteContext,
	params: URLSearchParams = new URLSearchParams()
): Promise<InternalNotePage> {
	return listMessages(
		db,
		{ organizationId: context?.organizationId, incidentId: context?.incidentId },
		params,
		'internal'
	);
}

/**
 * Appends a public comment. Visibility is fixed to 'public' and no incident_history event
 * is written. Caller must authorize incidents:add_comment plus incident access: pass the
 * restrictions held (assignedToUserId for view_own, clientUserId for view_requested) unless the
 * caller holds incidents:view_all.
 */
export async function createPublicComment(
	dbOrTx: IncidentDatabase,
	context: CreatePublicCommentContext,
	body: unknown
): Promise<PublicCommentItem> {
	return appendMessage(
		dbOrTx,
		{
			organizationId: context?.organizationId,
			incidentId: context?.incidentId,
			actorUserId: context?.actorUserId,
			assignedToUserId: context?.assignedToUserId,
			clientUserId: context?.clientUserId,
			supportResponse: context?.supportResponse === true
		},
		body,
		'public'
	);
}

/**
 * Lists public comments only (the whole public thread, never filtered by author). Caller must
 * authorize incidents:view_all, or pass the restrictions held (assignedToUserId for view_own,
 * clientUserId for view_requested) so that only accessible incidents are readable.
 */
export async function listPublicComments(
	db: IncidentDatabase,
	context: PublicCommentContext,
	params: URLSearchParams = new URLSearchParams()
): Promise<PublicCommentPage> {
	return listMessages(
		db,
		{
			organizationId: context?.organizationId,
			incidentId: context?.incidentId,
			assignedToUserId: context?.assignedToUserId,
			clientUserId: context?.clientUserId
		},
		params,
		'public'
	);
}

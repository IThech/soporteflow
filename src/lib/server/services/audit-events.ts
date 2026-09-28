import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { auditEvents } from '../db/schema';
import { isSensitiveKey, redactString } from '../logging/redact';
import { currentLogContext } from '../logging/logger';
import { parseHistoryQuery } from './incident-history';
import type { IncidentDatabase } from './incidents';

/**
 * Administrative audit trail service (5.4X-A). Two operations only: append (on the caller's
 * transaction) and read (tenant-scoped, paginated). There is deliberately no update/delete.
 *
 * Append contract: call it with the SAME transaction that performs the administrative mutation,
 * after the mutation succeeded. If anything later fails, the transaction rolls back the change
 * and its audit event together — there is never a "success" event for a change that did not
 * happen. The requestId comes from the W-E logging context (server-generated), never from input.
 *
 * Metadata policy: minimal identifiers and flags. Keys naming credentials (password, token,
 * secret, cookie, authorization, …) are dropped; strings are redacted and truncated; nested
 * objects are rejected; the serialized object must stay ≤ 4 KiB (also a CHECK in 0026).
 */

export type AuditActor =
	| { type: 'user'; userId: string }
	| { type: 'system' }
	| { type: 'automation' }
	| { type: 'platform' };

export type AuditMetadataValue = string | number | boolean | null | string[];

export interface AuditEventInput {
	organizationId: string;
	actor: AuditActor;
	/** `<entity>.<verb>` in snake_case, e.g. `category.created`, `membership.role_granted`. */
	action: string;
	entityType: string;
	entityId?: string | null;
	targetUserId?: string | null;
	metadata?: Record<string, unknown>;
}

export class AuditEventError extends Error {
	constructor(readonly code: 'INVALID_INPUT') {
		super(code);
		this.name = 'AuditEventError';
	}
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
const ENTITY_TYPE = /^[a-z][a-z_]*$/;
const METADATA_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
export const AUDIT_METADATA_MAX_BYTES = 4096;
const invalid = () => new AuditEventError('INVALID_INPUT');

function optionalId(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string' || !uuid.test(value)) throw invalid();
	return value;
}

/** Minimal, safe metadata (see module comment). Throws on shapes that must never be stored. */
export function sanitizeAuditMetadata(
	metadata: Record<string, unknown> | undefined
): Record<string, AuditMetadataValue> {
	if (metadata === undefined) return {};
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw invalid();
	const out: Record<string, AuditMetadataValue> = {};
	const entries = Object.entries(metadata);
	if (entries.length > 20) throw invalid();
	for (const [key, value] of entries) {
		if (!METADATA_KEY.test(key)) throw invalid();
		if (isSensitiveKey(key)) continue; // never persisted, whatever the value
		if (value === undefined) continue;
		if (value === null || typeof value === 'boolean') out[key] = value;
		else if (typeof value === 'number') {
			if (!Number.isFinite(value)) throw invalid();
			out[key] = value;
		} else if (typeof value === 'string') out[key] = redactString(value, 200);
		else if (Array.isArray(value)) {
			if (value.length > 50 || value.some((item) => typeof item !== 'string')) throw invalid();
			out[key] = value.map((item) => redactString(item as string, 100));
		} else throw invalid();
	}
	if (Buffer.byteLength(JSON.stringify(out)) > AUDIT_METADATA_MAX_BYTES) throw invalid();
	return out;
}

export async function appendAuditEvent(
	tx: IncidentDatabase,
	input: AuditEventInput
): Promise<{ id: string }> {
	if (typeof input?.organizationId !== 'string' || !uuid.test(input.organizationId))
		throw invalid();
	if (typeof input.action !== 'string' || input.action.length > 80 || !ACTION.test(input.action))
		throw invalid();
	if (
		typeof input.entityType !== 'string' ||
		input.entityType.length > 40 ||
		!ENTITY_TYPE.test(input.entityType)
	)
		throw invalid();
	const actor = input.actor;
	let actorUserId: string | null = null;
	if (actor?.type === 'user') {
		if (typeof actor.userId !== 'string' || !uuid.test(actor.userId)) throw invalid();
		actorUserId = actor.userId;
	} else if (!['system', 'automation', 'platform'].includes(actor?.type as string)) throw invalid();
	const requestId = currentLogContext().requestId;
	const [row] = await tx
		.insert(auditEvents)
		.values({
			organizationId: input.organizationId,
			actorType: actor.type,
			actorUserId,
			action: input.action,
			entityType: input.entityType,
			entityId: optionalId(input.entityId),
			targetUserId: optionalId(input.targetUserId),
			metadata: sanitizeAuditMetadata(input.metadata),
			requestId: requestId && uuid.test(requestId) ? requestId : null
		})
		.returning({ id: auditEvents.id });
	return row;
}

/** Shorthand for the common case: an authenticated administrator acting through the API. */
export function auditByUser(
	tx: IncidentDatabase,
	organizationId: string,
	actorUserId: string,
	event: Omit<AuditEventInput, 'organizationId' | 'actor'>
): Promise<{ id: string }> {
	return appendAuditEvent(tx, {
		organizationId,
		actor: { type: 'user', userId: actorUserId },
		...event
	});
}

export interface AuditEventDto {
	id: string;
	actorType: string;
	actorUserId: string | null;
	action: string;
	entityType: string;
	entityId: string | null;
	targetUserId: string | null;
	metadata: Record<string, AuditMetadataValue>;
	requestId: string | null;
	createdAt: string;
}

const FILTER_KEYS = ['actorUserId', 'action', 'entityType', 'entityId', 'from', 'to'] as const;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

function parseInstant(raw: string | null): Date | null {
	if (raw === null) return null;
	if (raw.length > 40 || !ISO_INSTANT.test(raw)) throw invalid();
	const date = new Date(raw);
	if (!Number.isFinite(date.getTime())) throw invalid();
	return date;
}

/**
 * Tenant-scoped page, newest first. Query keys: limit (1..100, default 50), cursor (opaque),
 * actorUserId, action, entityType, entityId, from, to (ISO-8601 instants, from ≤ createdAt < to).
 * Unknown or repeated keys are INVALID_INPUT.
 */
export async function listAuditEvents(
	db: IncidentDatabase,
	organizationId: string,
	params: URLSearchParams
): Promise<{ items: AuditEventDto[]; nextCursor: string | null }> {
	if (!uuid.test(organizationId)) throw invalid();
	const paging = new URLSearchParams();
	for (const key of params.keys()) {
		if (params.getAll(key).length !== 1) throw invalid();
		if (key === 'limit' || key === 'cursor') paging.set(key, params.get(key)!);
		else if (key !== 'organizationId' && !(FILTER_KEYS as readonly string[]).includes(key))
			throw invalid();
	}
	let page: ReturnType<typeof parseHistoryQuery>;
	try {
		page = parseHistoryQuery(paging);
	} catch {
		throw invalid();
	}
	const conditions: (SQL | undefined)[] = [eq(auditEvents.organizationId, organizationId)];
	const actorUserId = params.get('actorUserId');
	if (actorUserId !== null) conditions.push(eq(auditEvents.actorUserId, optionalId(actorUserId)!));
	const action = params.get('action');
	if (action !== null) {
		if (action.length > 80 || !ACTION.test(action)) throw invalid();
		conditions.push(eq(auditEvents.action, action));
	}
	const entityType = params.get('entityType');
	if (entityType !== null) {
		if (entityType.length > 40 || !ENTITY_TYPE.test(entityType)) throw invalid();
		conditions.push(eq(auditEvents.entityType, entityType));
	}
	const entityId = params.get('entityId');
	if (entityId !== null) conditions.push(eq(auditEvents.entityId, optionalId(entityId)!));
	const from = parseInstant(params.get('from'));
	const to = parseInstant(params.get('to'));
	if (from && to && from >= to) throw invalid();
	// Typed operators: Dates go through the column mapper (5.4W-A postgres-js lesson).
	if (from) conditions.push(gte(auditEvents.createdAt, from));
	if (to) conditions.push(lt(auditEvents.createdAt, to));
	if (page.cursor)
		conditions.push(
			sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${page.cursor.at}::timestamptz, ${page.cursor.id}::uuid)`
		);
	const rows = await db
		.select({
			id: auditEvents.id,
			actorType: auditEvents.actorType,
			actorUserId: auditEvents.actorUserId,
			action: auditEvents.action,
			entityType: auditEvents.entityType,
			entityId: auditEvents.entityId,
			targetUserId: auditEvents.targetUserId,
			metadata: auditEvents.metadata,
			requestId: auditEvents.requestId,
			cursorAt: sql<string>`to_char(${auditEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
		})
		.from(auditEvents)
		.where(and(...conditions))
		.orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
		.limit(page.limit + 1);
	const items = rows.slice(0, page.limit);
	const last = items.at(-1);
	return {
		items: items.map((row) => ({
			id: row.id,
			actorType: row.actorType,
			actorUserId: row.actorUserId,
			action: row.action,
			entityType: row.entityType,
			entityId: row.entityId,
			targetUserId: row.targetUserId,
			metadata: (row.metadata ?? {}) as Record<string, AuditMetadataValue>,
			requestId: row.requestId,
			createdAt: row.cursorAt
		})),
		nextCursor:
			rows.length > page.limit && last
				? Buffer.from(JSON.stringify([last.cursorAt, last.id])).toString('base64url')
				: null
	};
}

/**
 * Runs `mutate` and appends the event `describe(result)` on the same transaction. Used by the
 * administrative routes inside withActorAuthorization: authority, mutation and audit commit or
 * roll back together (no TOCTOU, no orphan event). `describe` returns null to skip (no-op change).
 */
export async function withAudit<T>(
	tx: IncidentDatabase,
	organizationId: string,
	actorUserId: string,
	mutate: () => Promise<T>,
	describe: (result: T) => Omit<AuditEventInput, 'organizationId' | 'actor'> | null
): Promise<T> {
	const result = await mutate();
	const event = describe(result);
	if (event) await auditByUser(tx, organizationId, actorUserId, event);
	return result;
}

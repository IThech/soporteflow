import { automationAuthority } from './automation-authority';
import { and, asc, eq, gt } from 'drizzle-orm';
import { automationEvents } from '../db/schema';
import {
	AUTOMATION_AGGREGATE_TYPES,
	AUTOMATION_EVENT_SCHEMA_VERSION,
	isAutomationEventType,
	type AutomationAggregateType,
	type AutomationEventEnvelope,
	type AutomationEventPayloads,
	type AutomationEventType
} from '../../automation/events';
import type { IncidentDatabase } from './incidents';

/**
 * Automation event store (5.4V-A). Internal only: no HTTP endpoint, no update, no delete.
 * appendAutomationEvent always runs on the caller's transaction (the domain mutation); it never
 * opens its own, so a failure here rolls back the mutation. Domain services do not call it
 * directly: they go through automation-event-producer.
 */

export class AutomationEventError extends Error {
	constructor(readonly code: 'INVALID_INPUT' | 'AUTOMATION_EVENT_NOT_FOUND') {
		super(code);
		this.name = 'AutomationEventError';
	}
}

/** Stored event: the envelope plus its global position (ordering/cursor). */
export type StoredAutomationEvent = AutomationEventEnvelope & { position: number };

export interface AppendAutomationEventInput<T extends AutomationEventType> {
	organizationId: string;
	eventType: T;
	aggregateType: AutomationAggregateType;
	aggregateId: string;
	actorUserId: string | null;
	occurredAt: Date;
	payload: AutomationEventPayloads[T];
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new AutomationEventError('INVALID_INPUT');
function validId(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !uuid.test(value)) throw invalid();
}

/** Payloads are flat objects of ids, numbers, enum strings, ISO dates and nulls only. */
function validPayload(value: unknown): asserts value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
	if (Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
	for (const [key, v] of Object.entries(value)) {
		if (!/^[a-z][A-Za-z0-9]*$/.test(key)) throw invalid();
		if (v === null || typeof v === 'boolean') continue;
		if (typeof v === 'number' && Number.isFinite(v)) continue;
		if (typeof v === 'string' && v.length <= 200 && !v.includes('\u0000')) continue;
		throw invalid();
	}
}

const columns = {
	id: automationEvents.id,
	position: automationEvents.position,
	organizationId: automationEvents.organizationId,
	eventType: automationEvents.eventType,
	schemaVersion: automationEvents.schemaVersion,
	aggregateType: automationEvents.aggregateType,
	aggregateId: automationEvents.aggregateId,
	actorUserId: automationEvents.actorUserId,
	occurredAt: automationEvents.occurredAt,
	payload: automationEvents.payload
};
type Row = { [K in keyof typeof columns]: (typeof automationEvents.$inferSelect)[K] };

function toStored(row: Row): StoredAutomationEvent {
	return {
		id: row.id,
		position: row.position,
		organizationId: row.organizationId,
		eventType: row.eventType as AutomationEventType,
		schemaVersion: row.schemaVersion,
		aggregateType: row.aggregateType as AutomationAggregateType,
		aggregateId: row.aggregateId,
		actorUserId: row.actorUserId,
		occurredAt: row.occurredAt.toISOString(),
		payload: row.payload as AutomationEventPayloads[AutomationEventType]
	};
}

/** Appends one immutable event (schemaVersion = current) on the caller's transaction. */
export async function appendAutomationEvent<T extends AutomationEventType>(
	tx: IncidentDatabase,
	input: AppendAutomationEventInput<T>
): Promise<StoredAutomationEvent> {
	validId(input?.organizationId);
	validId(input.aggregateId);
	if (input.actorUserId !== null) validId(input.actorUserId);
	if (!isAutomationEventType(input.eventType)) throw invalid();
	if (!(AUTOMATION_AGGREGATE_TYPES as readonly string[]).includes(input.aggregateType))
		throw invalid();
	if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime()))
		throw invalid();
	validPayload(input.payload);
	const authority = automationAuthority(tx, input.organizationId);
	if (authority && input.actorUserId !== null) throw invalid();
	const [row] = await tx
		.insert(automationEvents)
		.values({
			organizationId: input.organizationId,
			eventType: input.eventType,
			schemaVersion: AUTOMATION_EVENT_SCHEMA_VERSION,
			aggregateType: input.aggregateType,
			aggregateId: input.aggregateId,
			actorUserId: input.actorUserId,
			occurredAt: input.occurredAt,
			causationEventId: authority?.causationEventId ?? null,
			automationExecutionId: authority?.executionId ?? null,
			automationDepth: authority?.depth ?? 0,
			payload: input.payload
		})
		.returning(columns);
	return toStored(row);
}

export const AUTOMATION_EVENT_LIST_DEFAULT_LIMIT = 50;
export const AUTOMATION_EVENT_LIST_MAX_LIMIT = 200;

/**
 * Internal read for tests and future consumers (V-B): events of ONE organization in position
 * order, strictly after `afterPosition`, optionally for one aggregate. Bounded page.
 */
export async function listAutomationEventsInternal(
	db: IncidentDatabase,
	options: {
		organizationId: string;
		afterPosition?: number;
		limit?: number;
		aggregateId?: string;
	}
): Promise<{ events: StoredAutomationEvent[]; nextPosition: number | null }> {
	validId(options?.organizationId);
	const limit = options.limit ?? AUTOMATION_EVENT_LIST_DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > AUTOMATION_EVENT_LIST_MAX_LIMIT)
		throw invalid();
	const after = options.afterPosition ?? 0;
	if (!Number.isSafeInteger(after) || after < 0) throw invalid();
	if (options.aggregateId !== undefined) validId(options.aggregateId);
	const rows = await db
		.select(columns)
		.from(automationEvents)
		.where(
			and(
				eq(automationEvents.organizationId, options.organizationId),
				gt(automationEvents.position, after),
				options.aggregateId === undefined
					? undefined
					: eq(automationEvents.aggregateId, options.aggregateId)
			)
		)
		.orderBy(asc(automationEvents.position))
		.limit(limit + 1);
	const page = rows.slice(0, limit).map(toStored);
	return {
		events: page,
		nextPosition: rows.length > limit ? (page.at(-1)?.position ?? null) : null
	};
}

/** One event by id, scoped to its organization (another tenant's id is "not found"). */
export async function getAutomationEventInternal(
	db: IncidentDatabase,
	options: { organizationId: string; id: string }
): Promise<StoredAutomationEvent> {
	validId(options?.organizationId);
	validId(options.id);
	const [row] = await db
		.select(columns)
		.from(automationEvents)
		.where(
			and(
				eq(automationEvents.organizationId, options.organizationId),
				eq(automationEvents.id, options.id)
			)
		)
		.limit(1);
	if (!row) throw new AutomationEventError('AUTOMATION_EVENT_NOT_FOUND');
	return toStored(row);
}

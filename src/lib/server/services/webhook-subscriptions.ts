import { boundedRows } from '../security/bounded-read';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { webhookDeliveries, webhookSecrets, webhookSubscriptions } from '../db/schema';
import { isAutomationEventType, type AutomationEventType } from '../../automation/events';
import {
	WebhookConfigurationError,
	encryptWebhookSecret,
	generateWebhookSecret,
	webhookEncryptionKeyFromEnv
} from '../webhooks/secrets';
import { WebhookTargetError, normalizeWebhookTargetUrl } from '../webhooks/url-safety';
import type { IncidentDatabase } from './incidents';

/**
 * Outbound webhook subscriptions (5.4V-B). Authorization (webhooks:view / webhooks:manage) is
 * enforced by the routes; every function here is scoped by organizationId, so another tenant's
 * id is simply "not found".
 *
 * Secrets: generated server-side, returned ONCE (create / rotate), stored only encrypted.
 * DELETE semantics: deactivate (active = false) — history and pending-delivery checks keep the row.
 */

export type WebhookServiceErrorCode =
	'INVALID_INPUT' | 'INVALID_TARGET' | 'SSRF_BLOCKED' | 'WEBHOOK_NOT_FOUND' | 'CONFIGURATION_ERROR';

export class WebhookServiceError extends Error {
	constructor(readonly code: WebhookServiceErrorCode) {
		super(code);
		this.name = 'WebhookServiceError';
	}
}

export interface WebhookSubscriptionDto {
	id: string;
	name: string;
	targetUrl: string;
	active: boolean;
	eventTypes: AutomationEventType[];
	hasSecret: true;
	createdAt: string;
	updatedAt: string;
}

export interface WebhookDeliveryDto {
	id: string;
	eventId: string;
	eventType: string;
	status: string;
	attemptCount: number;
	lastStatusCode: number | null;
	lastErrorCode: string | null;
	responseTimeMs: number | null;
	nextAttemptAt: string | null;
	deliveredAt: string | null;
	failedAt: string | null;
	createdAt: string;
}

export const WEBHOOK_NAME_MAX_LENGTH = 120;
export const WEBHOOK_EVENT_TYPES_MAX = 50;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new WebhookServiceError('INVALID_INPUT');
function validId(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !uuid.test(value)) throw invalid();
}
function validName(value: unknown): string {
	if (typeof value !== 'string') throw invalid();
	const name = value.trim();
	// eslint-disable-next-line no-control-regex
	if (!name || name.length > WEBHOOK_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(name))
		throw invalid();
	return name;
}
function validEventTypes(value: unknown): AutomationEventType[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > WEBHOOK_EVENT_TYPES_MAX)
		throw invalid();
	if (!value.every(isAutomationEventType)) throw invalid(); // no wildcard in v1
	if (new Set(value).size !== value.length) throw invalid();
	return [...value].sort();
}
function validTarget(value: unknown): string {
	try {
		return normalizeWebhookTargetUrl(value);
	} catch (error) {
		if (error instanceof WebhookTargetError && error.code === 'SSRF_BLOCKED')
			throw new WebhookServiceError('SSRF_BLOCKED');
		throw new WebhookServiceError('INVALID_TARGET');
	}
}
function encryptionKey(provided?: Buffer): Buffer {
	try {
		return provided ?? webhookEncryptionKeyFromEnv();
	} catch (error) {
		if (error instanceof WebhookConfigurationError)
			throw new WebhookServiceError('CONFIGURATION_ERROR');
		throw error;
	}
}

type SubscriptionRow = typeof webhookSubscriptions.$inferSelect;
function toDto(row: SubscriptionRow): WebhookSubscriptionDto {
	return {
		id: row.id,
		name: row.name,
		targetUrl: row.targetUrl,
		active: row.active,
		eventTypes: row.eventTypes as AutomationEventType[],
		hasSecret: true,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString()
	};
}

export interface WebhookServiceOptions {
	/** Test injection; defaults to WEBHOOK_SECRET_ENCRYPTION_KEY. */
	encryptionKey?: Buffer;
}

/** Creates an active subscription + secret version 1. The secret is returned only here. */
export async function createWebhookSubscription(
	db: IncidentDatabase,
	context: { organizationId: string; actorUserId: string },
	input: unknown,
	options: WebhookServiceOptions = {}
): Promise<{ webhook: WebhookSubscriptionDto; secret: string }> {
	validId(context?.organizationId);
	validId(context.actorUserId);
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
	const body = input as Record<string, unknown>;
	if (Object.keys(body).some((k) => !['name', 'targetUrl', 'eventTypes'].includes(k)))
		throw invalid();
	const name = validName(body.name);
	const eventTypes = validEventTypes(body.eventTypes);
	const targetUrl = validTarget(body.targetUrl);
	const key = encryptionKey(options.encryptionKey); // fail before writing anything
	const id = randomUUID();
	const secret = generateWebhookSecret();
	const encrypted = encryptWebhookSecret(key, secret, { subscriptionId: id, version: 1 });
	const row = await db.transaction(async (tx) => {
		const [created] = await tx
			.insert(webhookSubscriptions)
			.values({
				id,
				organizationId: context.organizationId,
				name,
				targetUrl,
				eventTypes,
				currentSecretVersion: 1,
				createdByUserId: context.actorUserId
			})
			.returning();
		await tx.insert(webhookSecrets).values({
			subscriptionId: id,
			organizationId: context.organizationId,
			version: 1,
			...encrypted
		});
		return created;
	});
	return { webhook: toDto(row), secret };
}

export async function listWebhookSubscriptions(
	db: IncidentDatabase,
	organizationId: string
): Promise<WebhookSubscriptionDto[]> {
	validId(organizationId);
	const rows = await boundedRows(
		db
			.select()
			.from(webhookSubscriptions)
			.where(eq(webhookSubscriptions.organizationId, organizationId))
			.orderBy(desc(webhookSubscriptions.createdAt), desc(webhookSubscriptions.id))
	);
	return rows.map(toDto);
}

async function findRow(db: IncidentDatabase, organizationId: string, id: string, lock = false) {
	const query = db
		.select()
		.from(webhookSubscriptions)
		.where(
			and(eq(webhookSubscriptions.organizationId, organizationId), eq(webhookSubscriptions.id, id))
		)
		.limit(1);
	const [row] = lock ? await query.for('update') : await query;
	if (!row) throw new WebhookServiceError('WEBHOOK_NOT_FOUND');
	return row;
}

export async function getWebhookSubscription(
	db: IncidentDatabase,
	organizationId: string,
	id: unknown
): Promise<WebhookSubscriptionDto> {
	validId(organizationId);
	validId(id);
	return toDto(await findRow(db, organizationId, id));
}

/**
 * PATCH: strict subset of { name, targetUrl, eventTypes, active }, at least one key. Never the
 * secret (rotation is a separate operation). updated_at only moves when something changes.
 */
export async function updateWebhookSubscription(
	db: IncidentDatabase,
	organizationId: string,
	id: unknown,
	input: unknown
): Promise<WebhookSubscriptionDto> {
	validId(organizationId);
	validId(id);
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
	const body = input as Record<string, unknown>;
	const keys = Object.keys(body);
	if (
		keys.length === 0 ||
		keys.some((k) => !['name', 'targetUrl', 'eventTypes', 'active'].includes(k))
	)
		throw invalid();
	const patch: Partial<SubscriptionRow> = {};
	if ('name' in body) patch.name = validName(body.name);
	if ('targetUrl' in body) patch.targetUrl = validTarget(body.targetUrl);
	if ('eventTypes' in body) patch.eventTypes = validEventTypes(body.eventTypes);
	if ('active' in body) {
		if (typeof body.active !== 'boolean') throw invalid();
		patch.active = body.active;
	}
	return db.transaction(async (tx) => {
		const current = await findRow(tx, organizationId, id, true);
		const changed =
			(patch.name !== undefined && patch.name !== current.name) ||
			(patch.targetUrl !== undefined && patch.targetUrl !== current.targetUrl) ||
			(patch.active !== undefined && patch.active !== current.active) ||
			(patch.eventTypes !== undefined &&
				JSON.stringify(patch.eventTypes) !== JSON.stringify(current.eventTypes));
		if (!changed) return toDto(current);
		const [row] = await tx
			.update(webhookSubscriptions)
			.set({ ...patch, updatedAt: new Date() })
			.where(
				and(
					eq(webhookSubscriptions.organizationId, organizationId),
					eq(webhookSubscriptions.id, id)
				)
			)
			.returning();
		return toDto(row);
	});
}

/** DELETE semantics: deactivate (idempotent). Pending deliveries are then not sent. */
export async function deactivateWebhookSubscription(
	db: IncidentDatabase,
	organizationId: string,
	id: unknown
): Promise<WebhookSubscriptionDto> {
	return updateWebhookSubscription(db, organizationId, id, { active: false });
}

/**
 * New secret version (current + 1), returned once. Older versions are kept: deliveries created
 * before the rotation are still signed with the version they recorded.
 */
export async function rotateWebhookSecret(
	db: IncidentDatabase,
	organizationId: string,
	id: unknown,
	options: WebhookServiceOptions = {}
): Promise<{ webhook: WebhookSubscriptionDto; secret: string }> {
	validId(organizationId);
	validId(id);
	const key = encryptionKey(options.encryptionKey);
	return db.transaction(async (tx) => {
		const current = await findRow(tx, organizationId, id, true);
		const version = current.currentSecretVersion + 1;
		const secret = generateWebhookSecret();
		await tx.insert(webhookSecrets).values({
			subscriptionId: id,
			organizationId,
			version,
			...encryptWebhookSecret(key, secret, { subscriptionId: id, version })
		});
		const [row] = await tx
			.update(webhookSubscriptions)
			.set({ currentSecretVersion: version, updatedAt: new Date() })
			.where(
				and(
					eq(webhookSubscriptions.organizationId, organizationId),
					eq(webhookSubscriptions.id, id)
				)
			)
			.returning();
		return { webhook: toDto(row), secret };
	});
}

export const WEBHOOK_DELIVERY_PAGE_MAX = 100;
const createdAtMicros = sql<string>`to_char(${webhookDeliveries.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Read-only delivery history of one subscription (newest first, keyset cursor). No body. */
export async function listWebhookDeliveries(
	db: IncidentDatabase,
	organizationId: string,
	subscriptionId: unknown,
	options: { limit?: number; before?: { createdAt: string; id: string } } = {}
): Promise<{ deliveries: WebhookDeliveryDto[]; next: { createdAt: string; id: string } | null }> {
	validId(organizationId);
	validId(subscriptionId);
	const limit = options.limit ?? 50;
	if (!Number.isInteger(limit) || limit < 1 || limit > WEBHOOK_DELIVERY_PAGE_MAX) throw invalid();
	if (options.before) {
		validId(options.before.id);
		if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(String(options.before.createdAt)))
			throw invalid();
	}
	await findRow(db, organizationId, subscriptionId);
	// Keyset on (created_at, id) with microsecond timestamps (never JS Date precision).
	const cursor = options.before
		? sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (${options.before.createdAt}::timestamptz, ${options.before.id}::uuid)`
		: undefined;
	const rows = await db
		.select({ row: webhookDeliveries, at: createdAtMicros })
		.from(webhookDeliveries)
		.where(
			and(
				eq(webhookDeliveries.organizationId, organizationId),
				eq(webhookDeliveries.subscriptionId, subscriptionId),
				cursor
			)
		)
		.orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
		.limit(limit + 1);
	const page = rows.slice(0, limit).map((r) => ({ ...r.row, at: r.at }));
	const last = page.at(-1);
	const iso = (d: Date | null) => (d ? d.toISOString() : null);
	return {
		deliveries: page.map((r) => ({
			id: r.id,
			eventId: r.eventId,
			eventType: r.eventType,
			status: r.status,
			attemptCount: r.attemptCount,
			lastStatusCode: r.lastStatusCode,
			lastErrorCode: r.lastErrorCode,
			responseTimeMs: r.responseTimeMs,
			nextAttemptAt: iso(r.nextAttemptAt),
			deliveredAt: iso(r.deliveredAt),
			failedAt: iso(r.failedAt),
			createdAt: r.createdAt.toISOString()
		})),
		next: rows.length > limit && last ? { createdAt: last.at, id: last.id } : null
	};
}

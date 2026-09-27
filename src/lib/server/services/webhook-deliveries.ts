import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import {
	webhookDeliveries,
	webhookSecrets,
	webhookSubscriptions,
	type WebhookDeliveryErrorCode
} from '../db/schema';
import {
	WebhookConfigurationError,
	decryptWebhookSecret,
	signWebhookPayload,
	webhookEncryptionKeyFromEnv
} from '../webhooks/secrets';
import {
	WebhookTargetError,
	hostnameOf,
	normalizeWebhookTargetUrl,
	resolvePublicAddresses,
	systemLookup,
	type WebhookLookup
} from '../webhooks/url-safety';
import {
	WebhookTransportError,
	defaultWebhookHttpClient,
	type WebhookHttpClient
} from '../webhooks/http-client';
import type { IncidentDatabase } from './incidents';

/**
 * Outbound webhook delivery processor (5.4V-B). Same shape as notification-deliveries:
 * claim (short transaction, FOR UPDATE SKIP LOCKED, lease token) -> send outside any transaction
 * -> lease-guarded outcome update. No cron: processDueWebhookDeliveries is the entry point for a
 * future scheduler.
 *
 * Per attempt: subscription must still be active (disabled => SUBSCRIPTION_INACTIVE, not sent);
 * the snapshot URL is re-normalized and its DNS answers re-validated (all addresses public);
 * the connection is pinned to a validated address; the body is signed with the secret version
 * recorded at intent time.
 *
 * Delivery is AT-LEAST-ONCE: a receiver that processes the request but whose response is lost
 * gets it again on retry. Receivers must dedupe by event id (X-SoporteFlow-Event-Id).
 */

export const WEBHOOK_MAX_ATTEMPTS = 5;
/** Delay after failed attempt n (1-based). The 5th failed attempt is final. */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
	60_000, // 1 min
	5 * 60_000, // 5 min
	30 * 60_000, // 30 min
	2 * 60 * 60_000 // 2 h
]);
export const WEBHOOK_LEASE_MS = 5 * 60_000;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_RETRY_AFTER_MIN_MS = 60_000;
export const WEBHOOK_RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;
export const WEBHOOK_DEFAULT_LIMIT = 25;
export const WEBHOOK_MAX_LIMIT = 100;
export const WEBHOOK_USER_AGENT = 'SoporteFlow-Webhooks/1.0';

export class WebhookDeliveryError extends Error {
	constructor(readonly code: 'INVALID_INPUT') {
		super(code);
		this.name = 'WebhookDeliveryError';
	}
}
const invalid = () => new WebhookDeliveryError('INVALID_INPUT');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validDate(value: unknown): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw invalid();
	return value;
}

export interface ClaimedWebhookDelivery {
	id: string;
	leaseToken: string;
	organizationId: string;
	subscriptionId: string;
	eventId: string;
	eventType: string;
	targetUrl: string;
	secretVersion: number;
	body: string;
	attemptCount: number;
}

/**
 * Claims due deliveries (pending/retry due, or processing whose lease expired) in one short
 * transaction. Expired leases already at the attempt limit are closed as MAX_ATTEMPTS.
 */
export async function claimDueWebhookDeliveries(
	db: IncidentDatabase,
	options: { now: Date; limit?: number }
): Promise<ClaimedWebhookDelivery[]> {
	const now = validDate(options?.now);
	const limit = options.limit ?? WEBHOOK_DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > WEBHOOK_MAX_LIMIT) throw invalid();
	const leaseUntil = new Date(now.getTime() + WEBHOOK_LEASE_MS);
	return db.transaction(async (tx) => {
		await tx
			.update(webhookDeliveries)
			.set({
				status: 'failed',
				failedAt: now,
				lastErrorCode: 'MAX_ATTEMPTS',
				nextAttemptAt: null,
				leaseToken: null,
				updatedAt: now
			})
			.where(
				and(
					eq(webhookDeliveries.status, 'processing'),
					lte(webhookDeliveries.nextAttemptAt, now),
					sql`${webhookDeliveries.attemptCount} >= ${WEBHOOK_MAX_ATTEMPTS}`
				)
			);
		const due = await tx
			.select({ id: webhookDeliveries.id })
			.from(webhookDeliveries)
			.where(
				and(
					inArray(webhookDeliveries.status, ['pending', 'retry', 'processing']),
					lte(webhookDeliveries.nextAttemptAt, now),
					lt(webhookDeliveries.attemptCount, WEBHOOK_MAX_ATTEMPTS)
				)
			)
			.orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.id))
			.limit(limit)
			.for('update', { skipLocked: true });
		if (due.length === 0) return [];
		const rows = await tx
			.update(webhookDeliveries)
			.set({
				status: 'processing',
				leaseToken: sql`gen_random_uuid()`,
				attemptCount: sql`${webhookDeliveries.attemptCount} + 1`,
				lastAttemptAt: now,
				nextAttemptAt: leaseUntil,
				updatedAt: now
			})
			.where(
				inArray(
					webhookDeliveries.id,
					due.map((row) => row.id)
				)
			)
			.returning();
		const order = new Map(due.map((row, index) => [row.id, index]));
		return rows
			.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
			.map((row) => ({
				id: row.id,
				leaseToken: row.leaseToken as string,
				organizationId: row.organizationId,
				subscriptionId: row.subscriptionId,
				eventId: row.eventId,
				eventType: row.eventType,
				targetUrl: row.targetUrl,
				secretVersion: row.secretVersion,
				body: row.body,
				attemptCount: row.attemptCount
			}));
	});
}

interface LeaseRef {
	id: string;
	leaseToken: string;
	now: Date;
}
interface AttemptInfo {
	statusCode?: number | null;
	responseTimeMs?: number | null;
}

function leased(ref: LeaseRef) {
	if (typeof ref?.id !== 'string' || !uuid.test(ref.id)) throw invalid();
	if (typeof ref.leaseToken !== 'string' || !uuid.test(ref.leaseToken)) throw invalid();
	validDate(ref.now);
	return and(
		eq(webhookDeliveries.id, ref.id),
		eq(webhookDeliveries.status, 'processing'),
		eq(webhookDeliveries.leaseToken, ref.leaseToken)
	);
}
const attemptColumns = (info: AttemptInfo) => ({
	lastStatusCode: info.statusCode ?? null,
	responseTimeMs:
		info.responseTimeMs === undefined || info.responseTimeMs === null
			? null
			: Math.max(0, Math.round(info.responseTimeMs))
});

export async function markWebhookDeliverySent(
	db: IncidentDatabase,
	ref: LeaseRef & AttemptInfo
): Promise<boolean> {
	const rows = await db
		.update(webhookDeliveries)
		.set({
			status: 'sent',
			deliveredAt: ref.now,
			nextAttemptAt: null,
			leaseToken: null,
			lastErrorCode: null,
			...attemptColumns(ref),
			updatedAt: ref.now
		})
		.where(leased(ref))
		.returning({ id: webhookDeliveries.id });
	return rows.length === 1;
}

export async function markWebhookDeliveryFailed(
	db: IncidentDatabase,
	ref: LeaseRef & AttemptInfo & { errorCode: WebhookDeliveryErrorCode }
): Promise<boolean> {
	const rows = await db
		.update(webhookDeliveries)
		.set({
			status: 'failed',
			failedAt: ref.now,
			nextAttemptAt: null,
			leaseToken: null,
			lastErrorCode: ref.errorCode,
			...attemptColumns(ref),
			updatedAt: ref.now
		})
		.where(leased(ref))
		.returning({ id: webhookDeliveries.id });
	return rows.length === 1;
}

/**
 * 5.4W-A (H2): atomically re-asserts ownership right before the external POST and restarts the
 * lease from the worker's current time. A batch is sent sequentially (up to 100 x 10 s), so a
 * single claim-time lease may expire before a later item is sent; without this check another
 * processor could reclaim an unsent item and both would POST it. Guarded by the lease token only:
 * if another worker reclaimed the row (new token), the UPDATE matches nothing and the caller must
 * not send. If nobody reclaimed it, renewing is safe even after expiry (the UPDATE is atomic
 * against a concurrent claim: whichever commits first wins).
 */
export async function renewWebhookLease(db: IncidentDatabase, ref: LeaseRef): Promise<boolean> {
	const where = leased(ref);
	const rows = await db
		.update(webhookDeliveries)
		.set({ nextAttemptAt: new Date(ref.now.getTime() + WEBHOOK_LEASE_MS), updatedAt: ref.now })
		.where(where)
		.returning({ id: webhookDeliveries.id });
	return rows.length === 1;
}

/** Next attempt after failed attempt n, or null when exhausted. Retry-After overrides the delay. */
export function nextWebhookAttemptAt(
	attemptCount: number,
	now: Date,
	retryAfterMs: number | null = null
): Date | null {
	if (attemptCount >= WEBHOOK_MAX_ATTEMPTS) return null;
	const delay = retryAfterMs ?? WEBHOOK_RETRY_DELAYS_MS[attemptCount - 1];
	return delay === undefined ? null : new Date(now.getTime() + delay);
}

export async function markWebhookDeliveryRetry(
	db: IncidentDatabase,
	ref: LeaseRef &
		AttemptInfo & {
			attemptCount: number;
			errorCode: WebhookDeliveryErrorCode;
			retryAfterMs?: number | null;
		}
): Promise<'retry' | 'failed' | null> {
	const next = nextWebhookAttemptAt(ref.attemptCount, validDate(ref?.now), ref.retryAfterMs);
	if (next === null)
		return (await markWebhookDeliveryFailed(db, { ...ref, errorCode: 'MAX_ATTEMPTS' }))
			? 'failed'
			: null;
	const rows = await db
		.update(webhookDeliveries)
		.set({
			status: 'retry',
			nextAttemptAt: next,
			leaseToken: null,
			lastErrorCode: ref.errorCode,
			...attemptColumns(ref),
			updatedAt: ref.now
		})
		.where(leased(ref))
		.returning({ id: webhookDeliveries.id });
	return rows.length === 1 ? 'retry' : null;
}

/**
 * Retry-After (delta seconds or HTTP-date) -> delay in ms, clamped to [1 min, 24 h].
 * Invalid or missing -> null (default backoff applies).
 */
export function parseRetryAfter(value: string | null | undefined, now: Date): number | null {
	if (typeof value !== 'string' || !value.trim() || value.length > 64) return null;
	const text = value.trim();
	let ms: number;
	if (/^\d+$/.test(text)) ms = Number(text) * 1000;
	else {
		const at = Date.parse(text);
		if (Number.isNaN(at) || !/[a-z]/i.test(text)) return null;
		ms = at - now.getTime();
	}
	if (!Number.isFinite(ms)) return null;
	return Math.min(WEBHOOK_RETRY_AFTER_MAX_MS, Math.max(WEBHOOK_RETRY_AFTER_MIN_MS, ms));
}

export type WebhookOutcome =
	| { kind: 'sent' }
	/** Ownership lost before sending (lease renewal refused): nothing was sent or written. */
	| { kind: 'lost' }
	| { kind: 'retry'; code: WebhookDeliveryErrorCode; retryAfterMs?: number | null }
	| { kind: 'failed'; code: WebhookDeliveryErrorCode };

/**
 * HTTP status classification: 2xx sent; 3xx REDIRECT_NOT_ALLOWED (permanent, never followed);
 * 408/425 HTTP_4XX and 5xx HTTP_5XX transient; 429 RATE_LIMITED transient (Retry-After honoured,
 * also for 503); other 4xx HTTP_4XX permanent; anything else INVALID_RESPONSE permanent.
 */
export function classifyWebhookStatus(
	status: number,
	retryAfter: string | null,
	now: Date
): WebhookOutcome {
	if (!Number.isInteger(status) || status < 100 || status > 599)
		return { kind: 'failed', code: 'INVALID_RESPONSE' };
	if (status >= 200 && status < 300) return { kind: 'sent' };
	if (status >= 300 && status < 400) return { kind: 'failed', code: 'REDIRECT_NOT_ALLOWED' };
	if (status === 429)
		return { kind: 'retry', code: 'RATE_LIMITED', retryAfterMs: parseRetryAfter(retryAfter, now) };
	if (status === 408 || status === 425) return { kind: 'retry', code: 'HTTP_4XX' };
	if (status >= 400 && status < 500) return { kind: 'failed', code: 'HTTP_4XX' };
	if (status >= 500)
		return {
			kind: 'retry',
			code: 'HTTP_5XX',
			retryAfterMs: status === 503 ? parseRetryAfter(retryAfter, now) : null
		};
	return { kind: 'failed', code: 'INVALID_RESPONSE' };
}

export interface ProcessWebhookDeliveriesOptions {
	limit?: number;
	now?: Date;
	httpClient?: WebhookHttpClient;
	lookup?: WebhookLookup;
	/** Test injection; defaults to WEBHOOK_SECRET_ENCRYPTION_KEY. */
	encryptionKey?: Buffer;
	timeoutMs?: number;
	/** Clock for response time only (defaults to performance.now). */
	clock?: () => number;
}

export interface ProcessWebhookDeliveriesResult {
	claimed: number;
	sent: number;
	retried: number;
	failed: number;
	leaseLost: number;
}

/** Headers of one attempt. The signature covers `${timestamp}.${body}` exactly as sent. */
export function buildWebhookHeaders(input: {
	deliveryId: string;
	eventId: string;
	eventType: string;
	timestamp: number;
	secret: string;
	body: string;
}): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		'User-Agent': WEBHOOK_USER_AGENT,
		'X-SoporteFlow-Event-Id': input.eventId,
		'X-SoporteFlow-Event-Type': input.eventType,
		'X-SoporteFlow-Delivery-Id': input.deliveryId,
		'X-SoporteFlow-Timestamp': String(input.timestamp),
		'X-SoporteFlow-Signature': signWebhookPayload(input.secret, input.timestamp, input.body)
	};
}

async function attempt(
	db: IncidentDatabase,
	delivery: ClaimedWebhookDelivery,
	now: Date,
	options: ProcessWebhookDeliveriesOptions,
	/** Invocation time + elapsed monotonic time: the worker's current logical time. */
	current: () => Date
): Promise<WebhookOutcome & AttemptInfo> {
	const [subscription] = await db
		.select({
			active: webhookSubscriptions.active,
			ciphertext: webhookSecrets.ciphertext,
			iv: webhookSecrets.iv,
			authTag: webhookSecrets.authTag
		})
		.from(webhookSubscriptions)
		.leftJoin(
			webhookSecrets,
			and(
				eq(webhookSecrets.subscriptionId, webhookSubscriptions.id),
				eq(webhookSecrets.version, delivery.secretVersion)
			)
		)
		.where(
			and(
				eq(webhookSubscriptions.id, delivery.subscriptionId),
				eq(webhookSubscriptions.organizationId, delivery.organizationId)
			)
		)
		.limit(1);
	if (!subscription?.active) return { kind: 'failed', code: 'SUBSCRIPTION_INACTIVE' };
	if (!subscription.ciphertext || !subscription.iv || !subscription.authTag)
		return { kind: 'retry', code: 'CONFIGURATION_ERROR' };

	let secret: string;
	try {
		const key = options.encryptionKey ?? webhookEncryptionKeyFromEnv();
		secret = decryptWebhookSecret(
			key,
			{ ciphertext: subscription.ciphertext, iv: subscription.iv, authTag: subscription.authTag },
			{ subscriptionId: delivery.subscriptionId, version: delivery.secretVersion }
		);
	} catch (error) {
		if (error instanceof WebhookConfigurationError)
			return { kind: 'retry', code: 'CONFIGURATION_ERROR' };
		throw error;
	}

	let url: URL;
	let addresses;
	try {
		url = new URL(normalizeWebhookTargetUrl(delivery.targetUrl));
		addresses = await resolvePublicAddresses(hostnameOf(url), options.lookup ?? systemLookup);
	} catch (error) {
		if (error instanceof WebhookTargetError)
			return error.code === 'DNS_RESOLUTION_FAILED'
				? { kind: 'retry', code: 'DNS_RESOLUTION_FAILED' }
				: { kind: 'failed', code: error.code };
		throw error;
	}

	const timestamp = Math.floor(now.getTime() / 1000);
	const headers = buildWebhookHeaders({
		deliveryId: delivery.id,
		eventId: delivery.eventId,
		eventType: delivery.eventType,
		timestamp,
		secret,
		body: delivery.body
	});
	// H2: never POST an item whose lease another worker may have taken over.
	if (
		!(await renewWebhookLease(db, {
			id: delivery.id,
			leaseToken: delivery.leaseToken,
			now: current()
		}))
	)
		return { kind: 'lost' };
	const clock = options.clock ?? (() => performance.now());
	const started = clock();
	try {
		const response = await (options.httpClient ?? defaultWebhookHttpClient).post({
			url: url.toString(),
			addresses,
			headers,
			body: delivery.body,
			timeoutMs: options.timeoutMs ?? WEBHOOK_TIMEOUT_MS
		});
		return {
			...classifyWebhookStatus(response.status, response.retryAfter, now),
			statusCode:
				Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
					? response.status
					: null,
			responseTimeMs: clock() - started
		};
	} catch (error) {
		const code =
			error instanceof WebhookTransportError ||
			(error as { name?: unknown })?.name === 'WebhookTransportError'
				? ((error as WebhookTransportError).code as WebhookDeliveryErrorCode)
				: 'CONNECTION_FAILED';
		const safe: WebhookDeliveryErrorCode[] = ['TIMEOUT', 'CONNECTION_FAILED', 'TLS_ERROR'];
		return {
			kind: 'retry',
			code: safe.includes(code) ? code : 'CONNECTION_FAILED',
			responseTimeMs: clock() - started
		};
	}
}

/**
 * Entry point for a future scheduler (no cron here). Bounded per call (default 25, max 100).
 * Each HTTP call is outside any transaction and limited by the timeout (default 10 s); the lease
 * of each item is renewed right before its POST (see renewWebhookLease).
 */
export async function processDueWebhookDeliveries(
	db: IncidentDatabase,
	options: ProcessWebhookDeliveriesOptions = {}
): Promise<ProcessWebhookDeliveriesResult> {
	const now = options.now ?? new Date();
	const claimed = await claimDueWebhookDeliveries(db, { now, limit: options.limit });
	const result: ProcessWebhookDeliveriesResult = {
		claimed: claimed.length,
		sent: 0,
		retried: 0,
		failed: 0,
		leaseLost: 0
	};
	const clock = options.clock ?? (() => performance.now());
	const batchStart = clock();
	const current = () => new Date(now.getTime() + Math.max(0, clock() - batchStart));
	for (const delivery of claimed) {
		const outcome = await attempt(db, delivery, now, options, current);
		if (outcome.kind === 'lost') {
			result.leaseLost++;
			continue;
		}
		const ref = {
			id: delivery.id,
			leaseToken: delivery.leaseToken,
			now,
			statusCode: outcome.statusCode,
			responseTimeMs: outcome.responseTimeMs
		};
		if (outcome.kind === 'sent') {
			result[(await markWebhookDeliverySent(db, ref)) ? 'sent' : 'leaseLost']++;
		} else if (outcome.kind === 'failed') {
			result[
				(await markWebhookDeliveryFailed(db, { ...ref, errorCode: outcome.code }))
					? 'failed'
					: 'leaseLost'
			]++;
		} else {
			const status = await markWebhookDeliveryRetry(db, {
				...ref,
				attemptCount: delivery.attemptCount,
				errorCode: outcome.code,
				retryAfterMs: outcome.retryAfterMs ?? null
			});
			if (status === 'retry') result.retried++;
			else if (status === 'failed') result.failed++;
			else result.leaseLost++;
		}
	}
	return result;
}

/**
 * Retention helper for a future scheduler: deletes sent/failed deliveries last updated before
 * `before`. Pending/retry/processing rows are never deleted.
 */
export async function deleteOldWebhookDeliveries(
	db: IncidentDatabase,
	options: { before: Date }
): Promise<number> {
	const before = validDate(options?.before);
	const rows = await db
		.delete(webhookDeliveries)
		.where(
			and(
				inArray(webhookDeliveries.status, ['sent', 'failed']),
				lt(webhookDeliveries.updatedAt, before)
			)
		)
		.returning({ id: webhookDeliveries.id });
	return rows.length;
}

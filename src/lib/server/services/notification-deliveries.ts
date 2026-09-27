import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import {
	authUsers,
	memberships,
	notificationDeliveries,
	organizations,
	users,
	type NotificationDeliveryErrorCode
} from '../db/schema';
import {
	NotificationEmailError,
	TRANSIENT_EMAIL_ERROR_CODES,
	getNotificationEmailSender,
	type NotificationEmailErrorCode,
	type NotificationEmailSender
} from '../email/notification-email';
import type { IncidentDatabase } from './incidents';

/**
 * External notification delivery (5.4U-D), email only.
 *
 * 1. Intent: createNotificationDelivery runs inside the domain transaction (via the producer). If
 *    the insert fails the domain mutation rolls back: the intent is atomic with the change.
 * 2. Claim: claimDueDeliveries marks due rows as `processing` with a fresh lease token and a lease
 *    expiry (stored in next_attempt_at), in a short transaction that is committed before sending.
 * 3. Send: outside any transaction, through the injected/configured NotificationEmailSender.
 * 4. Result: markDeliverySent / markDeliveryRetry / markDeliveryFailed, each guarded by the lease
 *    token so a stale worker can never overwrite a newer outcome.
 *
 * Provider failures only change the delivery row; the domain data and inbox are never touched.
 * Semantics are at-least-once: a worker that crashes after the provider accepted the message but
 * before marking it sent will resend after the lease expires (documented; true exactly-once needs
 * provider idempotency keys, 5.4W).
 */

export const NOTIFICATION_DELIVERY_MAX_ATTEMPTS = 5;
/** Delay after failed attempt n (1-based) before attempt n + 1. Attempt 5 failing is final. */
export const NOTIFICATION_DELIVERY_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
	60_000, // 1 min
	5 * 60_000, // 5 min
	30 * 60_000, // 30 min
	2 * 60 * 60_000 // 2 h
]);
/** How long a claim is owned before another processor may take it again. */
export const NOTIFICATION_DELIVERY_LEASE_MS = 5 * 60_000;
/**
 * 5.4W-A (H2): upper bound for one provider call. Adapters should enforce their own shorter
 * timeout; this guard keeps a hung adapter from holding a batch (and outliving its lease). A timed
 * out send is transient (NETWORK_ERROR): the provider may still deliver it (at-least-once).
 */
export const NOTIFICATION_EMAIL_SEND_TIMEOUT_MS = 30_000;
export const NOTIFICATION_DELIVERY_DEFAULT_LIMIT = 25;
export const NOTIFICATION_DELIVERY_MAX_LIMIT = 100;

export class NotificationDeliveryError extends Error {
	constructor(readonly code: 'INVALID_INPUT') {
		super(code);
		this.name = 'NotificationDeliveryError';
	}
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const typePattern = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;
/** Conservative address check: one @, no whitespace/control/quoting/header characters. */
const emailPattern = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const invalid = () => new NotificationDeliveryError('INVALID_INPUT');

function validId(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !uuid.test(value)) throw invalid();
}
function validText(value: unknown, max: number): string {
	if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\u0000'))
		throw invalid();
	return value.trim();
}
function validDate(value: unknown): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw invalid();
	return value;
}

export function isDeliverableEmailAddress(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 254 && emailPattern.test(value);
}

/** Single-line subject: control characters (CR/LF included) collapse to one space. */
export function toEmailSubject(title: string): string {
	// eslint-disable-next-line no-control-regex
	return title.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

export interface CreateNotificationDeliveryInput {
	organizationId: string;
	recipientUserId: string;
	channel: 'email';
	eventType: string;
	title: string;
	message: string;
	/** In-app notification created for the same recipient, if any (reference only). */
	notificationId?: string | null;
}

/**
 * Persists one delivery intent on the caller's transaction (status pending, due now). No network,
 * no provider check: an unconfigured provider is only detected when the processor tries to send.
 */
export async function createNotificationDelivery(
	tx: IncidentDatabase,
	input: CreateNotificationDeliveryInput
): Promise<{ id: string }> {
	validId(input?.organizationId);
	validId(input.recipientUserId);
	if (input.channel !== 'email') throw invalid();
	if (input.notificationId !== undefined && input.notificationId !== null)
		validId(input.notificationId);
	const eventType = validText(input.eventType, 80);
	if (!typePattern.test(eventType)) throw invalid();
	const [row] = await tx
		.insert(notificationDeliveries)
		.values({
			organizationId: input.organizationId,
			recipientUserId: input.recipientUserId,
			notificationId: input.notificationId ?? null,
			channel: 'email',
			eventType,
			title: validText(input.title, 160),
			message: validText(input.message, 2000)
		})
		.returning({ id: notificationDeliveries.id });
	return row;
}

export interface ClaimedNotificationDelivery {
	id: string;
	leaseToken: string;
	organizationId: string;
	recipientUserId: string;
	title: string;
	message: string;
	/** Attempt number of this claim (1-based). */
	attemptCount: number;
}

function transactional<T>(db: IncidentDatabase, run: (tx: IncidentDatabase) => Promise<T>) {
	return 'transaction' in db && typeof db.transaction === 'function'
		? db.transaction(run)
		: run(db);
}

/**
 * Claims up to `limit` due deliveries (pending/retry due, or processing whose lease expired) in one
 * short transaction: FOR UPDATE SKIP LOCKED, then status processing + new lease token + attempt
 * count + lease expiry. Expired leases already at the attempt limit are closed as MAX_ATTEMPTS.
 */
export async function claimDueDeliveries(
	db: IncidentDatabase,
	options: { now: Date; limit?: number }
): Promise<ClaimedNotificationDelivery[]> {
	const now = validDate(options?.now);
	const limit = options.limit ?? NOTIFICATION_DELIVERY_DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > NOTIFICATION_DELIVERY_MAX_LIMIT)
		throw invalid();
	const leaseUntil = new Date(now.getTime() + NOTIFICATION_DELIVERY_LEASE_MS);
	return transactional(db, async (tx) => {
		await tx
			.update(notificationDeliveries)
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
					eq(notificationDeliveries.status, 'processing'),
					lte(notificationDeliveries.nextAttemptAt, now),
					sql`${notificationDeliveries.attemptCount} >= ${NOTIFICATION_DELIVERY_MAX_ATTEMPTS}`
				)
			);
		const due = await tx
			.select({ id: notificationDeliveries.id })
			.from(notificationDeliveries)
			.where(
				and(
					inArray(notificationDeliveries.status, ['pending', 'retry', 'processing']),
					lte(notificationDeliveries.nextAttemptAt, now),
					lt(notificationDeliveries.attemptCount, NOTIFICATION_DELIVERY_MAX_ATTEMPTS)
				)
			)
			.orderBy(asc(notificationDeliveries.nextAttemptAt), asc(notificationDeliveries.id))
			.limit(limit)
			.for('update', { skipLocked: true });
		if (due.length === 0) return [];
		const rows = await tx
			.update(notificationDeliveries)
			.set({
				status: 'processing',
				leaseToken: sql`gen_random_uuid()`,
				attemptCount: sql`${notificationDeliveries.attemptCount} + 1`,
				lastAttemptAt: now,
				nextAttemptAt: leaseUntil,
				updatedAt: now
			})
			.where(
				inArray(
					notificationDeliveries.id,
					due.map((row) => row.id)
				)
			)
			.returning({
				id: notificationDeliveries.id,
				leaseToken: notificationDeliveries.leaseToken,
				organizationId: notificationDeliveries.organizationId,
				recipientUserId: notificationDeliveries.recipientUserId,
				title: notificationDeliveries.title,
				message: notificationDeliveries.message,
				attemptCount: notificationDeliveries.attemptCount,
				nextAttemptAt: notificationDeliveries.nextAttemptAt
			});
		return rows
			.sort(
				(a, b) =>
					(a.nextAttemptAt?.getTime() ?? 0) - (b.nextAttemptAt?.getTime() ?? 0) ||
					a.id.localeCompare(b.id)
			)
			.map((row) => ({
				id: row.id,
				leaseToken: row.leaseToken as string,
				organizationId: row.organizationId,
				recipientUserId: row.recipientUserId,
				title: row.title,
				message: row.message,
				attemptCount: row.attemptCount
			}));
	});
}

interface LeaseRef {
	id: string;
	leaseToken: string;
	now: Date;
}

function leased(ref: LeaseRef) {
	validId(ref?.id);
	validId(ref.leaseToken);
	validDate(ref.now);
	return and(
		eq(notificationDeliveries.id, ref.id),
		eq(notificationDeliveries.status, 'processing'),
		eq(notificationDeliveries.leaseToken, ref.leaseToken)
	);
}

/** true when this lease still owned the row and it is now sent. */
export async function markDeliverySent(
	db: IncidentDatabase,
	ref: LeaseRef & { providerMessageId?: string | null }
): Promise<boolean> {
	const where = leased(ref);
	const providerMessageId =
		typeof ref.providerMessageId === 'string'
			? // eslint-disable-next-line no-control-regex
				ref.providerMessageId.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || null
			: null;
	const rows = await db
		.update(notificationDeliveries)
		.set({
			status: 'sent',
			sentAt: ref.now,
			nextAttemptAt: null,
			leaseToken: null,
			lastErrorCode: null,
			providerMessageId,
			updatedAt: ref.now
		})
		.where(where)
		.returning({ id: notificationDeliveries.id });
	return rows.length === 1;
}

/** Permanent failure. true when this lease still owned the row. */
export async function markDeliveryFailed(
	db: IncidentDatabase,
	ref: LeaseRef & { errorCode: NotificationDeliveryErrorCode }
): Promise<boolean> {
	const where = leased(ref);
	const rows = await db
		.update(notificationDeliveries)
		.set({
			status: 'failed',
			failedAt: ref.now,
			nextAttemptAt: null,
			leaseToken: null,
			lastErrorCode: ref.errorCode,
			updatedAt: ref.now
		})
		.where(where)
		.returning({ id: notificationDeliveries.id });
	return rows.length === 1;
}

/** Next attempt time after failed attempt `attemptCount`, or null when attempts are exhausted. */
export function nextDeliveryAttemptAt(attemptCount: number, now: Date): Date | null {
	if (attemptCount >= NOTIFICATION_DELIVERY_MAX_ATTEMPTS) return null;
	const delay = NOTIFICATION_DELIVERY_RETRY_DELAYS_MS[attemptCount - 1];
	return delay === undefined ? null : new Date(now.getTime() + delay);
}

/**
 * Transient failure: schedules the next attempt with the fixed backoff, or fails the delivery
 * with MAX_ATTEMPTS once the limit is reached. Returns the resulting status (null: lease lost).
 */
export async function markDeliveryRetry(
	db: IncidentDatabase,
	ref: LeaseRef & { attemptCount: number; errorCode: NotificationDeliveryErrorCode }
): Promise<'retry' | 'failed' | null> {
	const next = nextDeliveryAttemptAt(ref.attemptCount, validDate(ref?.now));
	if (next === null)
		return (await markDeliveryFailed(db, { ...ref, errorCode: 'MAX_ATTEMPTS' })) ? 'failed' : null;
	const rows = await db
		.update(notificationDeliveries)
		.set({
			status: 'retry',
			nextAttemptAt: next,
			leaseToken: null,
			lastErrorCode: ref.errorCode,
			updatedAt: ref.now
		})
		.where(leased(ref))
		.returning({ id: notificationDeliveries.id });
	return rows.length === 1 ? 'retry' : null;
}

/**
 * Current sign-in address (auth_users.email: unique, normalized, the identity the user controls)
 * of an active member of an active organization. Read at send time, never snapshotted and never
 * taken from a client or payload. null: not an active member; email null: no auth identity.
 */
async function recipientAddress(
	db: IncidentDatabase,
	delivery: ClaimedNotificationDelivery
): Promise<{ email: string | null } | null> {
	const [row] = await db
		.select({ userId: users.id, email: authUsers.email })
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.innerJoin(organizations, eq(organizations.id, memberships.organizationId))
		.leftJoin(authUsers, eq(authUsers.id, users.id))
		.where(
			and(
				eq(memberships.organizationId, delivery.organizationId),
				eq(memberships.userId, delivery.recipientUserId),
				eq(memberships.active, true),
				eq(users.active, true),
				eq(organizations.status, 'active')
			)
		)
		.limit(1);
	return row ? { email: row.email } : null;
}

const KNOWN_EMAIL_CODES: ReadonlySet<string> = new Set<NotificationEmailErrorCode>([
	'PROVIDER_NOT_CONFIGURED',
	'NETWORK_ERROR',
	'RATE_LIMITED',
	'RECIPIENT_INVALID',
	'PROVIDER_ERROR'
]);

/** Maps anything a sender throws to a safe code. Raw messages/stacks are never persisted. */
export function classifyEmailError(error: unknown): {
	code: NotificationEmailErrorCode;
	transient: boolean;
} {
	const candidate = (error as { name?: unknown; code?: unknown } | null) ?? null;
	const code =
		candidate?.name === 'NotificationEmailError' &&
		typeof candidate.code === 'string' &&
		KNOWN_EMAIL_CODES.has(candidate.code)
			? (candidate.code as NotificationEmailErrorCode)
			: 'PROVIDER_ERROR';
	return { code, transient: TRANSIENT_EMAIL_ERROR_CODES.has(code) };
}

export interface ProcessNotificationDeliveriesResult {
	claimed: number;
	sent: number;
	retried: number;
	failed: number;
	/** Rows whose lease was taken over before this worker finished (outcome not written). */
	leaseLost: number;
}

/**
 * 5.4W-A (H2): atomically re-asserts ownership right before the provider call and restarts the
 * lease from the worker's current time, so an item claimed in a long sequential batch cannot be
 * sent by this worker after another worker reclaimed it. Guarded by the lease token only (see
 * renewWebhookLease for the reasoning).
 */
export async function renewDeliveryLease(db: IncidentDatabase, ref: LeaseRef): Promise<boolean> {
	const where = leased(ref);
	const rows = await db
		.update(notificationDeliveries)
		.set({
			nextAttemptAt: new Date(ref.now.getTime() + NOTIFICATION_DELIVERY_LEASE_MS),
			updatedAt: ref.now
		})
		.where(where)
		.returning({ id: notificationDeliveries.id });
	return rows.length === 1;
}

async function sendWithTimeout(
	sender: NotificationEmailSender,
	message: Parameters<NotificationEmailSender['sendNotification']>[0],
	timeoutMs: number
) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			sender.sendNotification(message),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new NotificationEmailError('NETWORK_ERROR', 'send timeout')),
					timeoutMs
				);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Entry point for a future scheduler (no cron here). Claims due deliveries, then sends each one
 * outside any transaction and records the outcome. Bounded per call (default 25, max 100); each
 * provider call is bounded (NOTIFICATION_EMAIL_SEND_TIMEOUT_MS) and preceded by a lease renewal.
 */
export async function processDueNotificationDeliveries(
	db: IncidentDatabase,
	options: {
		limit?: number;
		now?: Date;
		sender?: NotificationEmailSender;
		sendTimeoutMs?: number;
		/** Monotonic clock (ms) used to advance the worker's logical time; defaults to performance.now. */
		clock?: () => number;
	} = {}
): Promise<ProcessNotificationDeliveriesResult> {
	const now = options.now ?? new Date();
	const clock = options.clock ?? (() => performance.now());
	const batchStart = clock();
	const current = () => new Date(now.getTime() + Math.max(0, clock() - batchStart));
	const sender = options.sender ?? getNotificationEmailSender();
	const claimed = await claimDueDeliveries(db, { now, limit: options.limit });
	const result: ProcessNotificationDeliveriesResult = {
		claimed: claimed.length,
		sent: 0,
		retried: 0,
		failed: 0,
		leaseLost: 0
	};
	for (const delivery of claimed) {
		const ref = { id: delivery.id, leaseToken: delivery.leaseToken, now };
		const recipient = await recipientAddress(db, delivery);
		if (!recipient || !isDeliverableEmailAddress(recipient.email)) {
			const ok = await markDeliveryFailed(db, {
				...ref,
				errorCode: recipient ? 'RECIPIENT_INVALID' : 'RECIPIENT_INACTIVE'
			});
			result[ok ? 'failed' : 'leaseLost']++;
			continue;
		}
		// H2: never send an item whose lease another worker may have taken over.
		if (!(await renewDeliveryLease(db, { ...ref, now: current() }))) {
			result.leaseLost++;
			continue;
		}
		let providerMessageId: string | null;
		try {
			const sent = await sendWithTimeout(
				sender,
				{ to: recipient.email, subject: toEmailSubject(delivery.title), text: delivery.message },
				options.sendTimeoutMs ?? NOTIFICATION_EMAIL_SEND_TIMEOUT_MS
			);
			providerMessageId =
				sent && typeof sent.providerMessageId === 'string' ? sent.providerMessageId : null;
		} catch (error) {
			const { code, transient } = classifyEmailError(error);
			if (transient) {
				const status = await markDeliveryRetry(db, {
					...ref,
					attemptCount: delivery.attemptCount,
					errorCode: code
				});
				if (status === 'retry') result.retried++;
				else if (status === 'failed') result.failed++;
				else result.leaseLost++;
			} else {
				const ok = await markDeliveryFailed(db, { ...ref, errorCode: code });
				result[ok ? 'failed' : 'leaseLost']++;
			}
			continue;
		}
		const ok = await markDeliverySent(db, { ...ref, providerMessageId });
		result[ok ? 'sent' : 'leaseLost']++;
	}
	return result;
}

/**
 * Retention helper for a future scheduler: deletes terminal (sent/failed) deliveries last updated
 * before `before`. Pending/retry/processing rows are never deleted. Inbox notifications are not
 * touched (separate retention).
 */
export async function deleteOldNotificationDeliveries(
	db: IncidentDatabase,
	options: { before: Date }
): Promise<number> {
	const before = validDate(options?.before);
	const rows = await db
		.delete(notificationDeliveries)
		.where(
			and(
				inArray(notificationDeliveries.status, ['sent', 'failed']),
				lt(notificationDeliveries.updatedAt, before)
			)
		)
		.returning({ id: notificationDeliveries.id });
	return rows.length;
}

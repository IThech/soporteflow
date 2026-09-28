import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import { invitationDeliveries, invitations, organizations, roles } from '../db/schema';
import {
	InvitationEmailError,
	getInvitationEmailSender,
	type InvitationEmailSender
} from '../email/invitation-email';
import {
	TRANSIENT_EMAIL_ERROR_CODES,
	type NotificationEmailErrorCode
} from '../email/notification-email';
import {
	InvitationTokenConfigurationError,
	decryptInvitationToken,
	encryptInvitationToken,
	invitationTokenKeyFromEnv
} from '../invitations/token-crypto';
import { logError, logger, runWithLogContext } from '../logging/logger';
import { DEFAULT_RETRY_DELAYS_MS, nextRetryAt, withTimeout } from './delivery-primitives';
import type { IncidentDatabase } from './incidents';

/**
 * Invitation email outbox (5.4X-C). Replaces the synchronous post-commit send.
 *
 * 1. Intent: enqueueInvitationDelivery runs in the SAME transaction as createInvitation /
 *    resendInvitation, together with the token hash: new delivery row with the token encrypted
 *    (AES-256-GCM, AAD = invitation id + delivery id). Any active delivery of the invitation is
 *    cancelled first (explicit resend rotates the link; one active delivery at most).
 * 2. Claim: short transaction, FOR UPDATE SKIP LOCKED, lease token + expiry, attempt count.
 * 3. Send: outside any transaction, token decrypted in memory only, bounded by a timeout; the
 *    lease is renewed right before the provider call (5.4W-A H2).
 * 4. Outcome, guarded by the lease token: sent / retry (same ciphertext => same link) / failed.
 *    Every terminal state (sent, failed, cancelled) nulls the ciphertext (DB CHECK enforces it).
 * Revocation, acceptance and expiry cancel pending deliveries (cancelInvitationDeliveries), and
 * the worker re-checks the invitation before sending. Semantics: at-least-once (a crash after the
 * provider accepted and before marking sent resends the same link after the lease expires).
 */

export const INVITATION_DELIVERY_MAX_ATTEMPTS = 5;
export const INVITATION_DELIVERY_RETRY_DELAYS_MS = DEFAULT_RETRY_DELAYS_MS;
export const INVITATION_DELIVERY_LEASE_MS = 5 * 60_000;
/** Upper bound for one provider call (was the in-request timeout before 5.4X-C). */
export const INVITATION_EMAIL_SEND_TIMEOUT_MS = 15_000;
export const INVITATION_DELIVERY_DEFAULT_LIMIT = 25;
export const INVITATION_DELIVERY_MAX_LIMIT = 100;

export type InvitationDeliveryErrorCode =
	NotificationEmailErrorCode | 'CONFIGURATION_ERROR' | 'MAX_ATTEMPTS';
export type InvitationDeliveryCancelReason =
	| 'SUPERSEDED'
	| 'INVITATION_REVOKED'
	| 'INVITATION_ACCEPTED'
	| 'INVITATION_EXPIRED'
	| 'INVITATION_NOT_PENDING'
	| 'ORGANIZATION_INACTIVE'
	| 'TOKEN_MISMATCH';

export class InvitationDeliveryError extends Error {
	constructor(readonly code: 'INVALID_INPUT') {
		super(code);
		this.name = 'InvitationDeliveryError';
	}
}
const invalid = () => new InvitationDeliveryError('INVALID_INPUT');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE = ['pending', 'processing', 'retry'] as const;
const sha256 = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** Columns every terminal transition sets: no sensitive material, no lease, no due time. */
const neutralized = {
	tokenCiphertext: null,
	tokenIv: null,
	tokenAuthTag: null,
	leaseToken: null,
	nextAttemptAt: null
} as const;

/**
 * Cancels every active delivery of the invitation (same transaction as the caller's change) and
 * neutralizes their ciphertext. Returns how many were cancelled.
 */
export async function cancelInvitationDeliveries(
	tx: IncidentDatabase,
	organizationId: string,
	invitationId: string,
	reason: InvitationDeliveryCancelReason,
	now: Date = new Date()
): Promise<number> {
	const rows = await tx
		.update(invitationDeliveries)
		.set({ ...neutralized, status: 'cancelled', lastErrorCode: reason, updatedAt: now })
		.where(
			and(
				eq(invitationDeliveries.organizationId, organizationId),
				eq(invitationDeliveries.invitationId, invitationId),
				inArray(invitationDeliveries.status, [...ACTIVE])
			)
		)
		.returning({ id: invitationDeliveries.id });
	return rows.length;
}

/**
 * Persists the delivery intent for a freshly issued token, on the caller's transaction. The
 * caller has already written the token hash on the invitation in the same transaction.
 */
export async function enqueueInvitationDelivery(
	tx: IncidentDatabase,
	input: {
		organizationId: string;
		invitationId: string;
		token: string;
		encryptionKey: Buffer;
		now?: Date;
	}
): Promise<{ id: string }> {
	const now = input.now ?? new Date();
	await cancelInvitationDeliveries(tx, input.organizationId, input.invitationId, 'SUPERSEDED', now);
	const id = randomUUID();
	const encrypted = encryptInvitationToken(input.encryptionKey, input.token, {
		invitationId: input.invitationId,
		deliveryId: id
	});
	await tx.insert(invitationDeliveries).values({
		id,
		organizationId: input.organizationId,
		invitationId: input.invitationId,
		status: 'pending',
		nextAttemptAt: now,
		tokenCiphertext: encrypted.ciphertext,
		tokenIv: encrypted.iv,
		tokenAuthTag: encrypted.authTag,
		createdAt: now,
		updatedAt: now
	});
	return { id };
}

export interface ClaimedInvitationDelivery {
	id: string;
	leaseToken: string;
	organizationId: string;
	invitationId: string;
	attemptCount: number;
}

function transactional<T>(db: IncidentDatabase, run: (tx: IncidentDatabase) => Promise<T>) {
	return 'transaction' in db && typeof db.transaction === 'function'
		? db.transaction(run)
		: run(db);
}

/**
 * Claims up to `limit` due deliveries in one short transaction (FOR UPDATE SKIP LOCKED). Expired
 * leases already at the attempt limit are closed as MAX_ATTEMPTS and neutralized.
 */
export async function claimDueInvitationDeliveries(
	db: IncidentDatabase,
	options: { now: Date; limit?: number }
): Promise<ClaimedInvitationDelivery[]> {
	const now = options?.now;
	if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw invalid();
	const limit = options.limit ?? INVITATION_DELIVERY_DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > INVITATION_DELIVERY_MAX_LIMIT)
		throw invalid();
	const leaseUntil = new Date(now.getTime() + INVITATION_DELIVERY_LEASE_MS);
	return transactional(db, async (tx) => {
		const exhausted = await tx
			.update(invitationDeliveries)
			.set({
				...neutralized,
				status: 'failed',
				failedAt: now,
				lastErrorCode: 'MAX_ATTEMPTS',
				updatedAt: now
			})
			.where(
				and(
					eq(invitationDeliveries.status, 'processing'),
					lte(invitationDeliveries.nextAttemptAt, now),
					sql`${invitationDeliveries.attemptCount} >= ${INVITATION_DELIVERY_MAX_ATTEMPTS}`
				)
			)
			.returning({ id: invitationDeliveries.id });
		for (const row of exhausted.slice(0, 20))
			logger.error('invitation_email.delivery_exhausted', {
				deliveryId: row.id,
				code: 'MAX_ATTEMPTS'
			});
		const due = await tx
			.select({ id: invitationDeliveries.id })
			.from(invitationDeliveries)
			.where(
				and(
					inArray(invitationDeliveries.status, [...ACTIVE]),
					lte(invitationDeliveries.nextAttemptAt, now),
					lt(invitationDeliveries.attemptCount, INVITATION_DELIVERY_MAX_ATTEMPTS)
				)
			)
			.orderBy(asc(invitationDeliveries.nextAttemptAt), asc(invitationDeliveries.id))
			.limit(limit)
			.for('update', { skipLocked: true });
		if (due.length === 0) return [];
		const rows = await tx
			.update(invitationDeliveries)
			.set({
				status: 'processing',
				leaseToken: sql`gen_random_uuid()`,
				attemptCount: sql`${invitationDeliveries.attemptCount} + 1`,
				lastAttemptAt: now,
				nextAttemptAt: leaseUntil,
				updatedAt: now
			})
			.where(
				inArray(
					invitationDeliveries.id,
					due.map((row) => row.id)
				)
			)
			.returning({
				id: invitationDeliveries.id,
				leaseToken: invitationDeliveries.leaseToken,
				organizationId: invitationDeliveries.organizationId,
				invitationId: invitationDeliveries.invitationId,
				attemptCount: invitationDeliveries.attemptCount
			});
		const order = new Map(due.map((row, index) => [row.id, index]));
		return rows
			.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
			.map((row) => ({ ...row, leaseToken: row.leaseToken as string }));
	});
}

interface LeaseRef {
	id: string;
	leaseToken: string;
	now: Date;
}
function leased(ref: LeaseRef) {
	if (!uuid.test(ref?.id ?? '') || !uuid.test(ref.leaseToken ?? '')) throw invalid();
	return and(
		eq(invitationDeliveries.id, ref.id),
		eq(invitationDeliveries.status, 'processing'),
		eq(invitationDeliveries.leaseToken, ref.leaseToken)
	);
}

async function markTerminal(
	db: IncidentDatabase,
	ref: LeaseRef,
	values: Partial<typeof invitationDeliveries.$inferInsert>
): Promise<boolean> {
	const rows = await db
		.update(invitationDeliveries)
		.set({ ...neutralized, ...values, updatedAt: ref.now })
		.where(leased(ref))
		.returning({ id: invitationDeliveries.id });
	return rows.length === 1;
}

/** 5.4W-A H2: re-assert ownership and restart the lease right before the provider call. */
async function renewLease(db: IncidentDatabase, ref: LeaseRef): Promise<boolean> {
	const rows = await db
		.update(invitationDeliveries)
		.set({
			nextAttemptAt: new Date(ref.now.getTime() + INVITATION_DELIVERY_LEASE_MS),
			updatedAt: ref.now
		})
		.where(leased(ref))
		.returning({ id: invitationDeliveries.id });
	return rows.length === 1;
}

/** Transient failure: same ciphertext kept for the next attempt (same link) or exhausted. */
async function markRetry(
	db: IncidentDatabase,
	ref: LeaseRef & { attemptCount: number; errorCode: InvitationDeliveryErrorCode }
): Promise<'retry' | 'failed' | null> {
	const next = nextRetryAt(
		ref.attemptCount,
		INVITATION_DELIVERY_MAX_ATTEMPTS,
		INVITATION_DELIVERY_RETRY_DELAYS_MS,
		ref.now
	);
	if (next === null)
		return (await markTerminal(db, ref, {
			status: 'failed',
			failedAt: ref.now,
			lastErrorCode: 'MAX_ATTEMPTS'
		}))
			? 'failed'
			: null;
	const rows = await db
		.update(invitationDeliveries)
		.set({
			status: 'retry',
			nextAttemptAt: next,
			leaseToken: null,
			lastErrorCode: ref.errorCode,
			updatedAt: ref.now
		})
		.where(leased(ref))
		.returning({ id: invitationDeliveries.id });
	return rows.length === 1 ? 'retry' : null;
}

const KNOWN_CODES: ReadonlySet<string> = new Set([
	'PROVIDER_NOT_CONFIGURED',
	'NETWORK_ERROR',
	'RATE_LIMITED',
	'RECIPIENT_INVALID',
	'PROVIDER_ERROR'
]);

/** Safe classification of anything a sender throws; messages are never persisted or logged. */
export function classifyInvitationEmailError(error: unknown): {
	code: NotificationEmailErrorCode;
	transient: boolean;
} {
	const candidate = (error as { name?: unknown; code?: unknown } | null) ?? null;
	const code =
		candidate?.name === 'InvitationEmailError' &&
		typeof candidate.code === 'string' &&
		KNOWN_CODES.has(candidate.code)
			? (candidate.code as NotificationEmailErrorCode)
			: 'PROVIDER_ERROR';
	return { code, transient: TRANSIENT_EMAIL_ERROR_CODES.has(code) };
}

export interface ProcessInvitationDeliveriesResult {
	claimed: number;
	sent: number;
	retried: number;
	failed: number;
	/** Cancelled at send time: invitation no longer pending/valid (ciphertext neutralized). */
	cancelled: number;
	leaseLost: number;
	/** Unexpected per-item failures; the item keeps its lease and is reclaimed later. */
	errors: number;
}

/**
 * Entry point for a future scheduler (no cron here). Bounded per call (default 25, max 100).
 */
export async function processDueInvitationDeliveries(
	db: IncidentDatabase,
	options: {
		limit?: number;
		now?: Date;
		sender?: InvitationEmailSender;
		sendTimeoutMs?: number;
		encryptionKey?: Buffer;
		clock?: () => number;
	} = {}
): Promise<ProcessInvitationDeliveriesResult> {
	const now = options.now ?? new Date();
	const clock = options.clock ?? (() => performance.now());
	const batchStart = clock();
	const current = () => new Date(now.getTime() + Math.max(0, clock() - batchStart));
	const sender = options.sender ?? getInvitationEmailSender();
	return runWithLogContext({ jobId: randomUUID(), worker: 'invitation_email' }, async () => {
		const claimed = await claimDueInvitationDeliveries(db, { now, limit: options.limit });
		const result: ProcessInvitationDeliveriesResult = {
			claimed: claimed.length,
			sent: 0,
			retried: 0,
			failed: 0,
			cancelled: 0,
			leaseLost: 0,
			errors: 0
		};
		for (const delivery of claimed) {
			try {
				await processOne(delivery);
			} catch (error) {
				result.errors++;
				logError('invitation_email.delivery_error', error, {
					deliveryId: delivery.id,
					attempt: delivery.attemptCount
				});
			}
		}
		if (claimed.length > 0) logger.info('invitation_email.batch_completed', { ...result });
		return result;

		// Logged: delivery/invitation ids, attempt and safe codes. Never the token, the ciphertext,
		// the recipient address or provider messages.
		async function processOne(delivery: ClaimedInvitationDelivery) {
			const ref = { id: delivery.id, leaseToken: delivery.leaseToken, now };
			const ids = {
				deliveryId: delivery.id,
				invitationId: delivery.invitationId,
				attempt: delivery.attemptCount
			};
			const [row] = await db
				.select({
					ciphertext: invitationDeliveries.tokenCiphertext,
					iv: invitationDeliveries.tokenIv,
					authTag: invitationDeliveries.tokenAuthTag,
					status: invitations.status,
					email: invitations.email,
					tokenHash: invitations.tokenHash,
					expiresAt: invitations.expiresAt,
					organizationName: organizations.name,
					organizationStatus: organizations.status,
					roleName: roles.name
				})
				.from(invitationDeliveries)
				.innerJoin(
					invitations,
					and(
						eq(invitations.id, invitationDeliveries.invitationId),
						eq(invitations.organizationId, invitationDeliveries.organizationId)
					)
				)
				.innerJoin(organizations, eq(organizations.id, invitations.organizationId))
				.innerJoin(
					roles,
					and(
						eq(roles.id, invitations.roleId),
						eq(roles.organizationId, invitations.organizationId)
					)
				)
				.where(
					and(
						eq(invitationDeliveries.id, delivery.id),
						eq(invitationDeliveries.organizationId, delivery.organizationId)
					)
				)
				.limit(1);
			const cancel = async (reason: InvitationDeliveryCancelReason) => {
				const ok = await markTerminal(db, ref, { status: 'cancelled', lastErrorCode: reason });
				result[ok ? 'cancelled' : 'leaseLost']++;
				if (ok) logger.info('invitation_email.delivery_cancelled', { ...ids, reason });
			};
			if (!row) return cancel('INVITATION_NOT_PENDING');
			if (row.organizationStatus !== 'active') return cancel('ORGANIZATION_INACTIVE');
			if (row.status !== 'pending') return cancel('INVITATION_NOT_PENDING');
			if (row.expiresAt.getTime() <= current().getTime()) return cancel('INVITATION_EXPIRED');
			if (!row.ciphertext || !row.iv || !row.authTag) return cancel('INVITATION_NOT_PENDING');

			let token: string;
			try {
				token = decryptInvitationToken(
					options.encryptionKey ?? invitationTokenKeyFromEnv(),
					{ ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag },
					{ invitationId: delivery.invitationId, deliveryId: delivery.id }
				);
			} catch (error) {
				if (!(error instanceof InvitationTokenConfigurationError)) throw error;
				// Missing/rotated key or tampered row: bounded retries, then exhausted (neutralized).
				const status = await markRetry(db, {
					...ref,
					attemptCount: delivery.attemptCount,
					errorCode: 'CONFIGURATION_ERROR'
				});
				if (status === 'retry') {
					result.retried++;
					logger.warn('invitation_email.delivery_retry', { ...ids, code: 'CONFIGURATION_ERROR' });
				} else if (status === 'failed') {
					result.failed++;
					logger.error('invitation_email.delivery_exhausted', {
						...ids,
						code: 'MAX_ATTEMPTS',
						lastCode: 'CONFIGURATION_ERROR'
					});
				} else result.leaseLost++;
				return;
			}
			// Defense in depth: an explicit resend already cancelled this delivery; never send a token
			// that is no longer the invitation's current one.
			if (sha256(token) !== row.tokenHash) return cancel('TOKEN_MISMATCH');

			if (!(await renewLease(db, { ...ref, now: current() }))) {
				result.leaseLost++;
				logger.warn('invitation_email.lease_lost', ids);
				return;
			}
			try {
				await withTimeout(
					sender.sendInvitation({
						email: row.email,
						organizationName: row.organizationName,
						roleName: row.roleName,
						token,
						expiresAt: row.expiresAt
					}),
					options.sendTimeoutMs ?? INVITATION_EMAIL_SEND_TIMEOUT_MS,
					// A timed-out send is transient; the provider may still deliver it (at-least-once).
					() => new InvitationEmailError('NETWORK_ERROR', 'send timeout')
				);
			} catch (error) {
				const { code, transient } = classifyInvitationEmailError(error);
				const effective = code;
				if (transient) {
					const status = await markRetry(db, {
						...ref,
						attemptCount: delivery.attemptCount,
						errorCode: effective
					});
					if (status === 'retry') {
						result.retried++;
						logger.warn('invitation_email.delivery_retry', { ...ids, code: effective });
					} else if (status === 'failed') {
						result.failed++;
						logger.error('invitation_email.delivery_exhausted', {
							...ids,
							code: 'MAX_ATTEMPTS',
							lastCode: effective
						});
					} else result.leaseLost++;
				} else {
					const ok = await markTerminal(db, ref, {
						status: 'failed',
						failedAt: ref.now,
						lastErrorCode: code
					});
					result[ok ? 'failed' : 'leaseLost']++;
					if (ok) logger.warn('invitation_email.delivery_failed', { ...ids, code });
				}
				return;
			}
			const ok = await markTerminal(db, ref, {
				status: 'sent',
				sentAt: ref.now,
				lastErrorCode: null
			});
			result[ok ? 'sent' : 'leaseLost']++;
		}
	});
}

/** Latest delivery state of each invitation (admin visibility; never token material). */
export async function latestInvitationDeliveryStates(
	db: IncidentDatabase,
	organizationId: string,
	invitationIds: readonly string[]
): Promise<Map<string, { status: string; lastErrorCode: string | null; attemptCount: number }>> {
	const map = new Map<
		string,
		{ status: string; lastErrorCode: string | null; attemptCount: number }
	>();
	if (invitationIds.length === 0) return map;
	const rows = await db
		.select({
			invitationId: invitationDeliveries.invitationId,
			status: invitationDeliveries.status,
			lastErrorCode: invitationDeliveries.lastErrorCode,
			attemptCount: invitationDeliveries.attemptCount,
			createdAt: invitationDeliveries.createdAt
		})
		.from(invitationDeliveries)
		.where(
			and(
				eq(invitationDeliveries.organizationId, organizationId),
				inArray(invitationDeliveries.invitationId, [...invitationIds])
			)
		);
	const newest = new Map<string, (typeof rows)[number]>();
	for (const row of rows) {
		const previous = newest.get(row.invitationId);
		if (!previous || previous.createdAt < row.createdAt) newest.set(row.invitationId, row);
	}
	for (const [id, row] of newest)
		map.set(id, {
			status: row.status,
			lastErrorCode: row.lastErrorCode,
			attemptCount: row.attemptCount
		});
	return map;
}

/**
 * Retention helper (5.4X-D): deletes terminal deliveries (sent/failed/cancelled, which hold no
 * token material) last updated before `before`, in bounded batches. Active rows are never touched.
 */
export async function deleteOldInvitationDeliveries(
	db: IncidentDatabase,
	options: { before: Date; limit?: number }
): Promise<number> {
	if (!(options?.before instanceof Date) || Number.isNaN(options.before.getTime())) throw invalid();
	const limit = options.limit ?? 1000;
	if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw invalid();
	const victims = db
		.select({ id: invitationDeliveries.id })
		.from(invitationDeliveries)
		.where(
			and(
				inArray(invitationDeliveries.status, ['sent', 'failed', 'cancelled']),
				lt(invitationDeliveries.updatedAt, options.before)
			)
		)
		.limit(limit);
	const rows = await db
		.delete(invitationDeliveries)
		.where(inArray(invitationDeliveries.id, victims))
		.returning({ id: invitationDeliveries.id });
	return rows.length;
}

import { and, asc, inArray, lt } from 'drizzle-orm';
import { invitationDeliveries, notificationDeliveries, webhookDeliveries } from '../db/schema';
import { logger, runWithLogContext } from '../logging/logger';
import { deleteOldAutomationExecutions } from './automation-rules';
import type { IncidentDatabase } from './incidents';
import { randomUUID } from 'node:crypto';

/**
 * Operational retention (5.4X-D). Primitives + configuration, no business decision baked in:
 *
 * - Opt-in per table: a table is purged only when its RETENTION_*_DAYS is configured (1..3650).
 *   Unset => kept forever (no aggressive default).
 * - Only TERMINAL rows older than the cutoff: never pending/processing/retry deliveries or
 *   executions still in flight. Terminal invitation deliveries hold no token material.
 * - Bounded: short transactions of `batchSize` rows (FOR UPDATE SKIP LOCKED, so a concurrent
 *   worker or a second retention run never blocks or double-deletes), at most `maxBatches` per
 *   table per call. Idempotent and safe to retry.
 * - The administrative audit trail (audit_events) is NEVER purged here: it needs an explicit
 *   policy (legal/contractual) that does not exist yet.
 * No scheduler: runRetention is a callable job for the future operator scheduler.
 */

export const RETENTION_TABLES = [
	'notificationDeliveries',
	'webhookDeliveries',
	'invitationDeliveries',
	'automationExecutions'
] as const;
export type RetentionTable = (typeof RETENTION_TABLES)[number];
export type RetentionPolicy = Partial<Record<RetentionTable, number>>;

export const RETENTION_ENV: Record<RetentionTable, string> = {
	notificationDeliveries: 'RETENTION_NOTIFICATION_DELIVERIES_DAYS',
	webhookDeliveries: 'RETENTION_WEBHOOK_DELIVERIES_DAYS',
	invitationDeliveries: 'RETENTION_INVITATION_DELIVERIES_DAYS',
	automationExecutions: 'RETENTION_AUTOMATION_EXECUTIONS_DAYS'
};
export const RETENTION_MAX_DAYS = 3650;
const DAY = 24 * 60 * 60_000;

export class RetentionError extends Error {
	constructor(readonly code: 'INVALID_INPUT') {
		super(code);
		this.name = 'RetentionError';
	}
}

/** Parses a RETENTION_*_DAYS value: undefined/empty => disabled; otherwise integer 1..3650. */
export function parseRetentionDays(raw: string | undefined): number | null {
	if (raw === undefined || raw.trim() === '') return null;
	if (!/^\d{1,4}$/.test(raw.trim())) throw new RetentionError('INVALID_INPUT');
	const days = Number(raw.trim());
	if (days < 1 || days > RETENTION_MAX_DAYS) throw new RetentionError('INVALID_INPUT');
	return days;
}

export function retentionPolicyFromEnv(env: Record<string, string | undefined>): RetentionPolicy {
	const policy: RetentionPolicy = {};
	for (const table of RETENTION_TABLES) {
		const days = parseRetentionDays(env[RETENTION_ENV[table]]);
		if (days !== null) policy[table] = days;
	}
	return policy;
}

type DeliveryTable =
	typeof notificationDeliveries | typeof webhookDeliveries | typeof invitationDeliveries;
const TERMINAL: Record<
	Exclude<RetentionTable, 'automationExecutions'>,
	{ table: DeliveryTable; statuses: string[] }
> = {
	notificationDeliveries: { table: notificationDeliveries, statuses: ['sent', 'failed'] },
	webhookDeliveries: { table: webhookDeliveries, statuses: ['sent', 'failed'] },
	invitationDeliveries: { table: invitationDeliveries, statuses: ['sent', 'failed', 'cancelled'] }
};

async function purgeDeliveryBatch(
	db: IncidentDatabase,
	kind: Exclude<RetentionTable, 'automationExecutions'>,
	before: Date,
	batchSize: number
): Promise<number> {
	const { table, statuses } = TERMINAL[kind];
	return db.transaction(async (tx) => {
		const victims = await tx
			.select({ id: table.id })
			.from(table)
			.where(and(inArray(table.status, statuses), lt(table.updatedAt, before)))
			.orderBy(asc(table.updatedAt), asc(table.id))
			.limit(batchSize)
			.for('update', { skipLocked: true });
		if (victims.length === 0) return 0;
		const deleted = await tx
			.delete(table)
			.where(
				inArray(
					table.id,
					victims.map((row) => row.id)
				)
			)
			.returning({ id: table.id });
		return deleted.length;
	});
}

export interface RetentionResult {
	deleted: Partial<Record<RetentionTable, number>>;
	/** Tables whose batch budget ran out (more eligible rows remain for the next run). */
	truncated: RetentionTable[];
}

export async function runRetention(
	db: IncidentDatabase,
	options: { policy: RetentionPolicy; now?: Date; batchSize?: number; maxBatches?: number }
): Promise<RetentionResult> {
	const now = options.now ?? new Date();
	const batchSize = options.batchSize ?? 500;
	const maxBatches = options.maxBatches ?? 20;
	if (
		!(now instanceof Date) ||
		Number.isNaN(now.getTime()) ||
		!Number.isInteger(batchSize) ||
		batchSize < 1 ||
		batchSize > 5000 ||
		!Number.isInteger(maxBatches) ||
		maxBatches < 1 ||
		maxBatches > 1000
	)
		throw new RetentionError('INVALID_INPUT');
	for (const [table, days] of Object.entries(options.policy ?? {})) {
		if (!RETENTION_TABLES.includes(table as RetentionTable))
			throw new RetentionError('INVALID_INPUT');
		if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > RETENTION_MAX_DAYS)
			throw new RetentionError('INVALID_INPUT');
	}
	return runWithLogContext({ jobId: randomUUID(), worker: 'retention' }, async () => {
		const result: RetentionResult = { deleted: {}, truncated: [] };
		for (const table of RETENTION_TABLES) {
			const days = options.policy[table];
			if (days === undefined) continue;
			const before = new Date(now.getTime() - days * DAY);
			// automation executions are purged by their own helper (max 100 per batch)
			const size = table === 'automationExecutions' ? Math.min(batchSize, 100) : batchSize;
			let total = 0;
			let full = false;
			for (let batch = 0; batch < maxBatches; batch++) {
				const deleted =
					table === 'automationExecutions'
						? (await deleteOldAutomationExecutions(db, before, size)).deleted
						: await purgeDeliveryBatch(db, table, before, size);
				total += deleted;
				// a full batch means more eligible rows may remain
				full = deleted >= size;
				if (!full) break;
			}
			if (full) result.truncated.push(table);
			result.deleted[table] = total;
			if (total > 0 || result.truncated.includes(table))
				logger.info('retention.purged', {
					table,
					days,
					deleted: total,
					truncated: result.truncated.includes(table)
				});
		}
		return result;
	});
}

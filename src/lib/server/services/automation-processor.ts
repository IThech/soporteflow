import { randomUUID } from 'node:crypto';
import { and, eq, or, lte, asc } from 'drizzle-orm';
import {
	automationExecutions as executions,
	automationRules,
	automationEvents,
	organizations
} from '../db/schema';
import { isAutomationEventType } from '../../automation/events';
import {
	evaluateConditions,
	validateConditions,
	validateActions,
	type Action
} from '../../automation/rules';
import { automationAuthority, withAutomationAuthority } from './automation-authority';
import {
	updateIncidentRecord,
	assignIncidentRecord,
	updateIncidentSupportLevel,
	changeIncidentSite,
	changeIncidentCategory,
	IncidentServiceError,
	type IncidentDatabase
} from './incidents';
import { createInternalNote } from './incident-messages';

async function action(tx: IncidentDatabase, org: string, id: string, a: Action) {
	const ctx = { organizationId: org, actorUserId: null };
	const authority = automationAuthority(tx, org)!;
	const reason = 'Automation rule ' + authority.ruleId + '; execution ' + authority.executionId;
	switch (a.type) {
		case 'incident.assign_user':
			return assignIncidentRecord(tx, ctx, id, { assignedToUserId: a.userId, reason });
		case 'incident.assign_team':
			return assignIncidentRecord(tx, ctx, id, { teamId: a.teamId, reason });
		case 'incident.set_priority':
			return updateIncidentRecord(tx, ctx, id, { priority: a.priority });
		case 'incident.set_status':
			return updateIncidentRecord(tx, ctx, id, { status: a.status });
		case 'incident.set_support_level':
			return updateIncidentSupportLevel(tx, ctx, id, { supportLevel: a.supportLevel, reason });
		case 'incident.set_category':
			return changeIncidentCategory(tx, ctx, id, { categoryId: a.categoryId, reason });
		case 'incident.set_site':
			return changeIncidentSite(tx, ctx, id, { siteId: a.siteId, reason });
		case 'incident.add_internal_note':
			return createInternalNote(tx, { ...ctx, incidentId: id }, a.text);
	}
}
const terminal = (
	status: 'succeeded' | 'failed' | 'skipped',
	now: Date,
	errorCode: string | null = null
) => ({
	status,
	completedAt: now,
	failedAt: status === 'failed' ? now : null,
	errorCode,
	leaseToken: null,
	leaseUntil: null
});
/** Bounded invocation, not a worker. Claims commit before actions; actions and success share one tx.
 * Expired claims can be recovered; semantic or internal failures are terminal (no hidden retries).
 */
export async function processAutomationExecutions(
	db: IncidentDatabase,
	options: { limit?: number; now?: Date } = {}
) {
	const now = options.now ?? new Date(),
		limit = options.limit ?? 25;
	if (
		!(now instanceof Date) ||
		!Number.isFinite(now.getTime()) ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 100
	)
		throw new Error('INVALID_INPUT');
	const claims = await db.transaction(async (tx) => {
		const rows = await tx
			.select()
			.from(executions)
			.where(
				// Typed operators: the Date goes through the column mapper. Interpolating a JS Date in a raw
				// sql template hands it to postgres-js unconverted (drizzle installs pass-through timestamp
				// serializers) and fails on real PostgreSQL (5.4W-A) even though PGlite accepts it.
				or(
					eq(executions.status, 'pending'),
					and(eq(executions.status, 'processing'), lte(executions.leaseUntil, now))
				)
			)
			.orderBy(asc(executions.createdAt), asc(executions.sortOrder), asc(executions.id))
			.limit(limit)
			.for('update', { skipLocked: true });
		const claimed: { id: string; token: string }[] = [];
		for (const row of rows) {
			if (row.attemptCount >= 3) {
				await tx
					.update(executions)
					.set(terminal('failed', now, 'CONCURRENCY_CONFLICT'))
					.where(eq(executions.id, row.id));
				continue;
			}
			const token = randomUUID();
			await tx
				.update(executions)
				.set({
					status: 'processing',
					attemptCount: row.attemptCount + 1,
					startedAt: now,
					leaseToken: token,
					leaseUntil: new Date(now.getTime() + 300000)
				})
				.where(eq(executions.id, row.id));
			claimed.push({ id: row.id, token });
		}
		return claimed;
	});
	let succeeded = 0,
		skipped = 0,
		failed = 0;
	for (const claim of claims) {
		try {
			const result = await db.transaction(async (tx) => {
				const [execution] = await tx
					.select()
					.from(executions)
					.where(
						and(
							eq(executions.id, claim.id),
							eq(executions.leaseToken, claim.token),
							eq(executions.status, 'processing')
						)
					)
					.for('update');
				if (!execution) return 'lost';
				const [org] = await tx
					.select()
					.from(organizations)
					.where(eq(organizations.id, execution.organizationId))
					.for('share');
				const [rule] = await tx
					.select()
					.from(automationRules)
					.where(
						and(
							eq(automationRules.id, execution.ruleId),
							eq(automationRules.organizationId, execution.organizationId)
						)
					)
					.for('share');
				const [event] = await tx
					.select()
					.from(automationEvents)
					.where(
						and(
							eq(automationEvents.id, execution.sourceEventId),
							eq(automationEvents.organizationId, execution.organizationId)
						)
					);
				let reason: string | null = null;
				if (!org || org.status !== 'active') reason = 'TARGET_INACTIVE';
				else if (!rule?.active) reason = 'RULE_INACTIVE';
				else if (!event) reason = 'TARGET_NOT_FOUND';
				else if (
					event.schemaVersion !== 1 ||
					event.aggregateType !== 'incident' ||
					!isAutomationEventType(event.eventType)
				)
					reason = 'UNSUPPORTED_EVENT_VERSION';
				else if (event.automationDepth >= 5) reason = 'MAX_DEPTH_REACHED';
				else {
					const conditions = validateConditions(
						event.eventType as Parameters<typeof validateConditions>[0],
						execution.conditions
					);
					if (
						!evaluateConditions(
							event.eventType as Parameters<typeof evaluateConditions>[0],
							conditions,
							event.payload as Record<string, unknown>
						)
					)
						reason = 'CONDITION_NOT_MATCHED';
				}
				if (reason) {
					await tx
						.update(executions)
						.set(terminal('skipped', now, reason))
						.where(eq(executions.id, execution.id));
					return 'skipped';
				}
				const actions = validateActions(execution.actions);
				await withAutomationAuthority(tx, execution.id, claim.token, async () => {
					for (const a of actions) await action(tx, execution.organizationId, event.aggregateId, a);
				});
				await tx
					.update(executions)
					.set({ ...terminal('succeeded', now), actionsCompleted: actions.length })
					.where(eq(executions.id, execution.id));
				return 'succeeded';
			});
			if (result === 'succeeded') succeeded++;
			else if (result === 'skipped') skipped++;
		} catch (error) {
			// The failed action transaction has rolled back before recording its sanitized outcome.
			const code = error instanceof IncidentServiceError ? 'ACTION_INVALID' : 'INTERNAL_ERROR';
			const rows = await db
				.update(executions)
				.set(terminal('failed', now, code))
				.where(
					and(
						eq(executions.id, claim.id),
						eq(executions.leaseToken, claim.token),
						eq(executions.status, 'processing')
					)
				)
				.returning({ id: executions.id });
			if (rows.length) failed++;
		}
	}
	return { claimed: claims.length, succeeded, skipped, failed };
}

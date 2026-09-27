import { and, asc, desc, eq, inArray, lt, sql, getTableColumns } from 'drizzle-orm';
import { automationRules, automationExecutions, organizations } from '../db/schema';
import { parseRule, validId, AutomationRuleError, type RuleInput } from '../../automation/rules';
import type { IncidentDatabase } from './incidents';
import { parseHistoryQuery } from './incident-history';

type Row = typeof automationRules.$inferSelect;
function dto(r: Row) {
	return {
		id: r.id,
		name: r.name,
		active: r.active,
		eventType: r.eventType,
		conditions: r.conditions,
		actions: r.actions,
		sortOrder: r.sortOrder,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString()
	};
}
async function orgLock(tx: IncidentDatabase, org: string) {
	validId(org);
	const [o] = await tx
		.select({ id: organizations.id, status: organizations.status })
		.from(organizations)
		.where(eq(organizations.id, org))
		.for('update');
	if (!o || o.status !== 'active') throw new AutomationRuleError('RULE_NOT_FOUND');
}
async function cap(tx: IncidentDatabase, org: string) {
	const [r] = await tx
		.select({ n: sql<number>`count(*)::int` })
		.from(automationRules)
		.where(and(eq(automationRules.organizationId, org), eq(automationRules.active, true)));
	if (r.n >= 100) throw new AutomationRuleError('RULE_LIMIT_REACHED');
}
export async function createAutomationRule(
	db: IncidentDatabase,
	org: string,
	actor: string,
	input: unknown
) {
	validId(actor);
	const r = parseRule(input);
	return db.transaction(async (tx) => {
		await orgLock(tx, org);
		if (r.active) await cap(tx, org);
		const [row] = await tx
			.insert(automationRules)
			.values({ ...r, organizationId: org, createdByUserId: actor })
			.returning();
		return dto(row);
	});
}
export async function getAutomationRule(db: IncidentDatabase, org: string, id: string) {
	validId(org);
	validId(id);
	const [row] = await db
		.select()
		.from(automationRules)
		.where(and(eq(automationRules.organizationId, org), eq(automationRules.id, id)));
	if (!row) throw new AutomationRuleError('RULE_NOT_FOUND');
	return dto(row);
}
export async function updateAutomationRule(
	db: IncidentDatabase,
	org: string,
	id: string,
	input: unknown
) {
	validId(id);
	return db.transaction(async (tx) => {
		await orgLock(tx, org);
		const [old] = await tx
			.select()
			.from(automationRules)
			.where(and(eq(automationRules.organizationId, org), eq(automationRules.id, id)))
			.for('update');
		if (!old) throw new AutomationRuleError('RULE_NOT_FOUND');
		const r = parseRule(input, old as RuleInput);
		if (r.active && !old.active) await cap(tx, org);
		const [row] = await tx
			.update(automationRules)
			.set({ ...r, updatedAt: new Date() })
			.where(and(eq(automationRules.organizationId, org), eq(automationRules.id, id)))
			.returning();
		return dto(row);
	});
}
export async function listAutomationRules(
	db: IncidentDatabase,
	org: string,
	query: URLSearchParams
) {
	validId(org);
	const { limit, cursor } = parseHistoryQuery(query);
	const rows = await db
		.select({
			...getTableColumns(automationRules),
			cursorAt: sql<string>`to_char(${automationRules.createdAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
		})
		.from(automationRules)
		.where(
			and(
				eq(automationRules.organizationId, org),
				cursor
					? sql`(${automationRules.createdAt},${automationRules.id}) < (${cursor.at}::timestamptz,${cursor.id}::uuid)`
					: undefined
			)
		)
		.orderBy(desc(automationRules.createdAt), desc(automationRules.id))
		.limit(limit + 1);
	const items = rows.slice(0, limit);
	const last = items.at(-1);
	const nextCursor = rows.length > limit && last ? encodeCursor(last.cursorAt, last.id) : null;
	return { items: items.map(dto), nextCursor };
}
function encodeCursor(at: string, id: string) {
	return Buffer.from(JSON.stringify([at, id])).toString('base64url');
}
export async function listAutomationExecutions(
	db: IncidentDatabase,
	org: string,
	ruleId: string,
	query: URLSearchParams
) {
	await getAutomationRule(db, org, ruleId);
	const { limit, cursor } = parseHistoryQuery(query);
	const e = automationExecutions;
	const rows = await db
		.select({
			cursorAt: sql<string>`to_char(${e.createdAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
			id: e.id,
			ruleId: e.ruleId,
			sourceEventId: e.sourceEventId,
			status: e.status,
			errorCode: e.errorCode,
			startedAt: e.startedAt,
			completedAt: e.completedAt,
			createdAt: e.createdAt,
			actionsCompleted: e.actionsCompleted
		})
		.from(e)
		.where(
			and(
				eq(e.organizationId, org),
				eq(e.ruleId, ruleId),
				cursor
					? sql`(${e.createdAt},${e.id}) < (${cursor.at}::timestamptz,${cursor.id}::uuid)`
					: undefined
			)
		)
		.orderBy(desc(e.createdAt), desc(e.id))
		.limit(limit + 1);
	const items = rows.slice(0, limit),
		last = items.at(-1);
	return {
		items: items.map((item) => ({
			id: item.id,
			ruleId: item.ruleId,
			sourceEventId: item.sourceEventId,
			status: item.status,
			errorCode: item.errorCode,
			startedAt: item.startedAt,
			completedAt: item.completedAt,
			createdAt: item.createdAt,
			actionsCompleted: item.actionsCompleted
		})),
		nextCursor: rows.length > limit && last ? encodeCursor(last.cursorAt, last.id) : null
	};
}
/** Explicit maintenance only. Terminal records only; never rescan/replay retained events after pruning. */
export async function deleteOldAutomationExecutions(
	db: IncidentDatabase,
	before: Date,
	limit = 100
) {
	if (
		!(before instanceof Date) ||
		!Number.isFinite(before.getTime()) ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 100
	)
		throw new AutomationRuleError('INVALID_INPUT');
	return db.transaction(async (tx) => {
		const e = automationExecutions;
		const rows = await tx
			.select({ id: e.id })
			.from(e)
			.where(and(inArray(e.status, ['succeeded', 'failed', 'skipped']), lt(e.completedAt, before)))
			.orderBy(asc(e.completedAt), asc(e.id))
			.limit(limit)
			.for('update', { skipLocked: true });
		for (const row of rows) await tx.delete(e).where(eq(e.id, row.id));
		return { deleted: rows.length };
	});
}

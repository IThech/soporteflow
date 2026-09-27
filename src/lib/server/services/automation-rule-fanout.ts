import { and, eq, asc } from 'drizzle-orm';
import { automationRules, automationExecutions } from '../db/schema';
import type { IncidentDatabase } from './incidents';
import type { StoredAutomationEvent } from './automation-events';
/** Pure DB intents, inside the producing transaction. Never evaluate or run actions here. */
export async function fanoutAutomationExecutions(
	tx: IncidentDatabase,
	event: StoredAutomationEvent
) {
	const rows = await tx
		.select()
		.from(automationRules)
		.where(
			and(
				eq(automationRules.organizationId, event.organizationId),
				eq(automationRules.eventType, event.eventType),
				eq(automationRules.active, true)
			)
		)
		.orderBy(asc(automationRules.sortOrder), asc(automationRules.id))
		.for('share');
	if (rows.length > 100) throw new Error('AUTOMATION_RULE_LIMIT');
	if (!rows.length) return { created: 0 };
	const created = await tx
		.insert(automationExecutions)
		.values(
			rows.map((r) => ({
				organizationId: event.organizationId,
				ruleId: r.id,
				sourceEventId: event.id,
				ruleName: r.name,
				conditions: r.conditions,
				actions: r.actions,
				sortOrder: r.sortOrder
			}))
		)
		.onConflictDoNothing({
			target: [automationExecutions.ruleId, automationExecutions.sourceEventId]
		})
		.returning({ id: automationExecutions.id });
	return { created: created.length };
}

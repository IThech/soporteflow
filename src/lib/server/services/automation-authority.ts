import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq } from 'drizzle-orm';
import {
	automationExecutions,
	automationEvents,
	automationRules,
	organizations
} from '../db/schema';
import type { IncidentDatabase } from './incidents';
/** Server-only capability scoped to a live processor transaction. Never serialized or accepted by HTTP. */
interface Authority {
	active: boolean;
	tx: IncidentDatabase;
	organizationId: string;
	ruleId: string;
	executionId: string;
	causationEventId: string;
	depth: number;
}
const storage = new AsyncLocalStorage<Authority>();
export function automationAuthority(
	tx: IncidentDatabase,
	organizationId: string
): Readonly<Authority> | undefined {
	const current = storage.getStore();
	return current?.active && current.tx === tx && current.organizationId === organizationId
		? current
		: undefined;
}
/** Processor entry only: the private persisted lease is checked under the transaction lock. */
export async function withAutomationAuthority<T>(
	tx: IncidentDatabase,
	executionId: string,
	leaseToken: string,
	run: () => Promise<T>
): Promise<T> {
	if (!('rollback' in tx) || typeof tx.rollback !== 'function')
		throw new Error('AUTOMATION_TRANSACTION_REQUIRED');
	const [row] = await tx
		.select({ execution: automationExecutions, event: automationEvents })
		.from(automationExecutions)
		.innerJoin(
			automationEvents,
			and(
				eq(automationEvents.id, automationExecutions.sourceEventId),
				eq(automationEvents.organizationId, automationExecutions.organizationId)
			)
		)
		.innerJoin(
			automationRules,
			and(
				eq(automationRules.id, automationExecutions.ruleId),
				eq(automationRules.organizationId, automationExecutions.organizationId),
				eq(automationRules.active, true)
			)
		)
		.innerJoin(
			organizations,
			and(
				eq(organizations.id, automationExecutions.organizationId),
				eq(organizations.status, 'active')
			)
		)
		.where(
			and(
				eq(automationExecutions.id, executionId),
				eq(automationExecutions.leaseToken, leaseToken),
				eq(automationExecutions.status, 'processing')
			)
		)
		.for('update', { of: automationExecutions });
	if (
		!row ||
		row.event.schemaVersion !== 1 ||
		row.event.aggregateType !== 'incident' ||
		row.event.automationDepth >= 5
	)
		throw new Error('INVALID_AUTOMATION_AUTHORITY');
	const authority: Authority = {
		active: true,
		tx,
		organizationId: row.execution.organizationId,
		ruleId: row.execution.ruleId,
		executionId,
		causationEventId: row.event.id,
		depth: row.event.automationDepth + 1
	};
	try {
		return await storage.run(authority, run);
	} finally {
		authority.active = false;
	}
}

/** Private audit metadata; never exposed by the safe incident-history projection. */
export function automationHistoryMetadata(tx: IncidentDatabase, organizationId: string) {
	const authority = automationAuthority(tx, organizationId);
	return authority
		? {
				automation: {
					source: 'automation',
					ruleId: authority.ruleId,
					executionId: authority.executionId
				}
			}
		: {};
}

import { sql } from 'drizzle-orm';
import {
	pgTable,
	uuid,
	varchar,
	boolean,
	integer,
	jsonb,
	timestamp,
	unique,
	foreignKey,
	check,
	index
} from 'drizzle-orm/pg-core';
import { organizations, users } from './identity';
import { automationEvents } from './automation';
export const automationRules = pgTable(
	'automation_rules',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		name: varchar('name', { length: 120 }).notNull(),
		active: boolean('active').default(true).notNull(),
		eventType: varchar('event_type', { length: 80 }).notNull(),
		conditions: jsonb('conditions').notNull(),
		actions: jsonb('actions').notNull(),
		sortOrder: integer('sort_order').default(0).notNull(),
		createdByUserId: uuid('created_by_user_id').references(() => users.id, {
			onDelete: 'set null'
		}),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(t) => [
		unique('automation_rules_id_org_unique').on(t.id, t.organizationId),
		check('automation_rules_name_check', sql`btrim(${t.name}) <> ''`),
		check(
			'automation_rules_conditions_check',
			sql`jsonb_typeof(${t.conditions}) = 'object' AND octet_length(${t.conditions}::text) <= 16384`
		),
		check(
			'automation_rules_actions_check',
			sql`jsonb_typeof(${t.actions}) = 'array' AND jsonb_array_length(${t.actions}) BETWEEN 1 AND 10 AND octet_length(${t.actions}::text) <= 24576`
		),
		index('automation_rules_fanout_idx').on(t.organizationId, t.eventType, t.active)
	]
);
export const automationExecutions = pgTable(
	'automation_executions',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id').notNull(),
		ruleId: uuid('rule_id').notNull(),
		sourceEventId: uuid('source_event_id').notNull(),
		ruleName: varchar('rule_name', { length: 120 }).notNull(),
		conditions: jsonb('conditions').notNull(),
		actions: jsonb('actions').notNull(),
		sortOrder: integer('sort_order').notNull(),
		status: varchar('status', { length: 20 }).default('pending').notNull(),
		attemptCount: integer('attempt_count').default(0).notNull(),
		leaseToken: uuid('lease_token'),
		leaseUntil: timestamp('lease_until', { withTimezone: true }),
		startedAt: timestamp('started_at', { withTimezone: true }),
		completedAt: timestamp('completed_at', { withTimezone: true }),
		failedAt: timestamp('failed_at', { withTimezone: true }),
		errorCode: varchar('error_code', { length: 64 }),
		actionsCompleted: integer('actions_completed').default(0).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(t) => [
		unique('automation_executions_rule_event_unique').on(t.ruleId, t.sourceEventId),
		foreignKey({
			name: 'automation_executions_rule_org_fk',
			columns: [t.ruleId, t.organizationId],
			foreignColumns: [automationRules.id, automationRules.organizationId]
		}).onDelete('cascade'),
		foreignKey({
			name: 'automation_executions_event_org_fk',
			columns: [t.sourceEventId, t.organizationId],
			foreignColumns: [automationEvents.id, automationEvents.organizationId]
		}).onDelete('cascade'),
		check(
			'automation_executions_status_check',
			sql`${t.status} IN ('pending','processing','succeeded','failed','skipped')`
		),
		check(
			'automation_executions_lease_check',
			sql`(${t.status} = 'processing' AND ${t.leaseToken} IS NOT NULL AND ${t.leaseUntil} IS NOT NULL) OR (${t.status} <> 'processing' AND ${t.leaseToken} IS NULL AND ${t.leaseUntil} IS NULL)`
		),
		check(
			'automation_executions_counts_check',
			sql`${t.attemptCount} >= 0 AND ${t.actionsCompleted} BETWEEN 0 AND 10`
		),
		index('automation_executions_due_idx').on(t.status, t.leaseUntil, t.createdAt),
		index('automation_executions_history_idx').on(t.organizationId, t.ruleId, t.createdAt, t.id),
		index('automation_executions_event_idx').on(t.sourceEventId)
	]
);

import { sql } from 'drizzle-orm';
import {
	bigint,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	timestamp,
	unique,
	uuid,
	varchar
} from 'drizzle-orm/pg-core';
import { organizations, users } from './identity';

/**
 * Canonical automation events (5.4V-A): durable, tenant-scoped facts emitted by domain mutations
 * in their own transaction, for future webhooks (V-B), automation rules (V-C) and n8n (V-D).
 *
 * NOT event sourcing: incidents & co. remain the source of truth and incident_history remains the
 * audit trail. These rows are derived integration events, append-only (a trigger in migration 0023
 * rejects UPDATE). `position` is a global, strictly increasing sequence for deterministic order and
 * cursor reads; `id` is the stable public event id.
 *
 * actor_user_id references users (global, ON DELETE SET NULL), not memberships: the fact must stay
 * valid after the actor leaves the organization.
 */
export const automationEvents = pgTable(
	'automation_events',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		position: bigint('position', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
		organizationId: uuid('organization_id').notNull(),
		eventType: varchar('event_type', { length: 80 }).notNull(),
		schemaVersion: integer('schema_version').default(1).notNull(),
		aggregateType: varchar('aggregate_type', { length: 40 }).notNull(),
		aggregateId: uuid('aggregate_id').notNull(),
		actorUserId: uuid('actor_user_id'),
		payload: jsonb('payload').notNull(),
		occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		unique('automation_events_position_unique').on(table.position),
		foreignKey({
			name: 'automation_events_organization_fk',
			columns: [table.organizationId],
			foreignColumns: [organizations.id]
		}).onDelete('cascade'),
		foreignKey({
			name: 'automation_events_actor_fk',
			columns: [table.actorUserId],
			foreignColumns: [users.id]
		}).onDelete('set null'),
		check(
			'automation_events_event_type_check',
			sql`${table.eventType} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'`
		),
		check(
			'automation_events_aggregate_type_check',
			sql`${table.aggregateType} ~ '^[a-z][a-z0-9_]*$'`
		),
		check('automation_events_schema_version_check', sql`${table.schemaVersion} >= 1`),
		check(
			'automation_events_payload_check',
			sql`jsonb_typeof(${table.payload}) = 'object' AND octet_length(${table.payload}::text) <= 8192`
		),
		index('automation_events_org_position_idx').on(table.organizationId, table.position),
		index('automation_events_aggregate_idx').on(
			table.organizationId,
			table.aggregateType,
			table.aggregateId,
			table.position
		)
	]
);
export type AutomationEventRecord = typeof automationEvents.$inferSelect;

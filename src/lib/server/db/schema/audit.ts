import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './identity';

/**
 * Administrative audit trail (5.4X-A): persistent, tenant-scoped, append-only record of
 * administrative actions (who changed which configuration, when, from which request).
 *
 * - Not the operational log (W-E stdout lines) and not incident_history (incident facts).
 * - Written by services/routes on the SAME transaction as the mutation it describes, so a rolled
 *   back change never leaves an event behind.
 * - Append-only: no update/delete API; a trigger in migration 0026 rejects UPDATE. DELETE is only
 *   reachable through the organization cascade (tenant removal) — retention is a 5.4X-D decision.
 * - actor/entity/target ids are historical references without FKs: an event must keep pointing
 *   to what existed when it happened.
 * - metadata holds only minimal, sanitized identifiers/flags (services/audit-events.ts).
 */
export const AUDIT_ACTOR_TYPES = ['user', 'system', 'automation', 'platform'] as const;

export const auditEvents = pgTable(
	'audit_events',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		actorType: varchar('actor_type', { length: 20 }).notNull(),
		actorUserId: uuid('actor_user_id'),
		action: varchar('action', { length: 80 }).notNull(),
		entityType: varchar('entity_type', { length: 40 }).notNull(),
		entityId: uuid('entity_id'),
		targetUserId: uuid('target_user_id'),
		metadata: jsonb('metadata').default({}).notNull(),
		requestId: uuid('request_id'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(t) => [
		check(
			'audit_events_actor_check',
			sql`(${t.actorType} = 'user' AND ${t.actorUserId} IS NOT NULL) OR (${t.actorType} IN ('system','automation','platform') AND ${t.actorUserId} IS NULL)`
		),
		check('audit_events_action_check', sql`${t.action} ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$'`),
		check('audit_events_entity_type_check', sql`${t.entityType} ~ '^[a-z][a-z_]*$'`),
		check(
			'audit_events_metadata_check',
			sql`jsonb_typeof(${t.metadata}) = 'object' AND octet_length(${t.metadata}::text) <= 4096`
		),
		// Listing (newest first) and the two investigation filters that need their own index.
		index('audit_events_org_created_idx').on(t.organizationId, t.createdAt, t.id),
		index('audit_events_org_entity_idx').on(
			t.organizationId,
			t.entityType,
			t.entityId,
			t.createdAt
		),
		index('audit_events_org_actor_idx').on(t.organizationId, t.actorUserId, t.createdAt)
	]
);

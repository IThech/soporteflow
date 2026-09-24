import { sql } from 'drizzle-orm';
import {
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
	varchar
} from 'drizzle-orm/pg-core';
import { organizations, memberships } from './identity';
import { sites } from './structure';

/**
 * Sequential incident number counters per organization.
 * Provides atomic, monotonic, tenant-isolated numbering under concurrency.
 */
export const organizationCounters = pgTable('organization_counters', {
	organizationId: uuid('organization_id')
		.primaryKey()
		.references(() => organizations.id, { onDelete: 'cascade' }),
	lastIncidentNumber: integer('last_incident_number').default(0).notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
});

/**
 * Incidents: core ticketing entities.
 * Enforces multi-tenant isolation via composite foreign keys.
 * Note: Foreign keys guarantee relational integrity and prevent cross-tenant references,
 * but do NOT verify active membership at the moment of an operation (validated by server services).
 */
export const incidents = pgTable(
	'incidents',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'restrict' }),
		incidentNumber: integer('incident_number').notNull(),
		title: varchar('title', { length: 255 }).notNull(),
		description: text('description').notNull(),
		status: varchar('status', { length: 30 }).default('open').notNull(),
		priority: varchar('priority', { length: 30 }).default('medium').notNull(),
		client: varchar('client', { length: 255 }).notNull(),
		clientUserId: uuid('client_user_id'),
		createdByUserId: uuid('created_by_user_id').notNull(),
		siteId: uuid('site_id'),
		assignedToUserId: uuid('assigned_to_user_id'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		unique('incidents_id_org_unique').on(table.id, table.organizationId),
		unique('incidents_org_number_unique').on(table.organizationId, table.incidentNumber),
		foreignKey({
			name: 'incidents_creator_org_fk',
			columns: [table.organizationId, table.createdByUserId],
			foreignColumns: [memberships.organizationId, memberships.userId]
		}).onDelete('restrict'),
		foreignKey({
			name: 'incidents_client_user_org_fk',
			columns: [table.organizationId, table.clientUserId],
			foreignColumns: [memberships.organizationId, memberships.userId]
		}).onDelete('restrict'),
		foreignKey({
			name: 'incidents_assigned_user_org_fk',
			columns: [table.organizationId, table.assignedToUserId],
			foreignColumns: [memberships.organizationId, memberships.userId]
		}).onDelete('restrict'),
		foreignKey({
			name: 'incidents_site_org_fk',
			columns: [table.siteId, table.organizationId],
			foreignColumns: [sites.id, sites.organizationId]
		}).onDelete('restrict'),
		check('incidents_title_check', sql`btrim(${table.title}) <> ''`),
		check('incidents_client_check', sql`btrim(${table.client}) <> ''`),
		check('incidents_description_check', sql`btrim(${table.description}) <> ''`),
		check(
			'incidents_status_check',
			sql`${table.status} IN ('open', 'pending', 'resolved', 'closed')`
		),
		check(
			'incidents_priority_check',
			sql`${table.priority} IN ('low', 'medium', 'high', 'urgent')`
		),
		index('incidents_org_status_idx').on(table.organizationId, table.status, table.createdAt),
		index('incidents_org_site_idx').on(table.organizationId, table.siteId)
	]
);

/**
 * Incident audit history events.
 * ON DELETE RESTRICT prevents deleting an incident record while history entries exist.
 * Note: RESTRICT on parent deletion does not alone guarantee immutability against direct
 * updates or deletes on the history table itself; application services enforce append-only access.
 */
export const incidentHistory = pgTable(
	'incident_history',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		incidentId: uuid('incident_id').notNull(),
		organizationId: uuid('organization_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'restrict' }),
		eventType: varchar('event_type', { length: 50 }).notNull(),
		actorType: varchar('actor_type', { length: 20 }).default('user').notNull(),
		actorUserId: uuid('actor_user_id'),
		reason: text('reason'),
		comment: text('comment'),
		payload: jsonb('payload').default('{}').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		foreignKey({
			name: 'incident_history_incident_org_fk',
			columns: [table.incidentId, table.organizationId],
			foreignColumns: [incidents.id, incidents.organizationId]
		}).onDelete('restrict'),
		foreignKey({
			name: 'incident_history_actor_org_fk',
			columns: [table.organizationId, table.actorUserId],
			foreignColumns: [memberships.organizationId, memberships.userId]
		}).onDelete('restrict'),
		check(
			'incident_history_actor_check',
			sql`(${table.actorType} = 'system' AND ${table.actorUserId} IS NULL) OR (${table.actorType} = 'user' AND ${table.actorUserId} IS NOT NULL)`
		),
		check('incident_history_actor_type_check', sql`${table.actorType} IN ('user', 'system')`),
		check(
			'incident_history_event_type_check',
			sql`${table.eventType} IN (
				'created', 'status_changed', 'priority_changed', 'assigned',
				'reassigned', 'escalated', 'site_changed', 'resolved',
				'resolution_accepted', 'resolution_rejected', 'closed',
				'reopened', 'reclassified', 'priority_override_applied',
				'priority_override_modified', 'priority_override_removed',
				'internal_note_added'
			)`
		),
		index('incident_history_incident_created_idx').on(table.incidentId, table.createdAt)
	]
);

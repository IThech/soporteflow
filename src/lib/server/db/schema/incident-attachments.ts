import { sql } from 'drizzle-orm';
import {
	pgTable,
	uuid,
	varchar,
	integer,
	timestamp,
	foreignKey,
	index,
	check,
	unique
} from 'drizzle-orm/pg-core';
import { incidents } from './incidents';
import { memberships } from './identity';
export const incidentAttachments = pgTable(
	'incident_attachments',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id').notNull(),
		incidentId: uuid('incident_id').notNull(),
		actorId: uuid('actor_id').notNull(),
		originalName: varchar('original_name', { length: 180 }).notNull(),
		storageKey: uuid('storage_key').notNull(),
		mimeType: varchar('mime_type', { length: 40 }).notNull(),
		size: integer('size').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(t) => [
		foreignKey({
			columns: [t.incidentId, t.organizationId],
			foreignColumns: [incidents.id, incidents.organizationId],
			name: 'attachments_incident_tenant_fk'
		}).onDelete('restrict'),
		foreignKey({
			columns: [t.organizationId, t.actorId],
			foreignColumns: [memberships.organizationId, memberships.userId],
			name: 'attachments_actor_tenant_fk'
		}).onDelete('restrict'),
		unique('attachments_storage_key_unique').on(t.storageKey),
		index('attachments_org_incident_idx').on(t.organizationId, t.incidentId),
		index('attachments_incident_idx').on(t.incidentId),
		check('attachments_size_check', sql`${t.size} > 0 AND ${t.size} <= 5242880`),
		check(
			'attachments_mime_check',
			sql`${t.mimeType} IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')`
		)
	]
);

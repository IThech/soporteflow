import { sql } from 'drizzle-orm';
import {
	boolean,
	primaryKey,
	pgTable,
	uuid,
	varchar,
	text,
	jsonb,
	timestamp,
	foreignKey,
	check,
	index
} from 'drizzle-orm/pg-core';
import { memberships } from './identity';

export const notifications = pgTable(
	'notifications',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id').notNull(),
		recipientUserId: uuid('recipient_user_id').notNull(),
		type: varchar('type', { length: 80 }).notNull(),
		title: varchar('title', { length: 160 }).notNull(),
		message: text('message').notNull(),
		payload: jsonb('payload'),
		readAt: timestamp('read_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		foreignKey({
			name: 'notifications_recipient_org_fk',
			columns: [table.organizationId, table.recipientUserId],
			foreignColumns: [memberships.organizationId, memberships.userId]
		}).onDelete('cascade'),
		check('notifications_type_check', sql`${table.type} ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'`),
		check('notifications_title_check', sql`length(btrim(${table.title})) BETWEEN 1 AND 160`),
		check('notifications_message_check', sql`length(btrim(${table.message})) BETWEEN 1 AND 2000`),
		check(
			'notifications_payload_check',
			sql`${table.payload} IS NULL OR (jsonb_typeof(${table.payload}) = 'object' AND octet_length(${table.payload}::text) <= 8192)`
		),
		index('notifications_recipient_created_idx').on(
			table.organizationId,
			table.recipientUserId,
			table.createdAt.desc(),
			table.id.desc()
		),
		index('notifications_recipient_unread_idx')
			.on(table.organizationId, table.recipientUserId)
			.where(sql`${table.readAt} IS NULL`)
	]
);
export type NotificationRecord = typeof notifications.$inferSelect;

/**
 * Personal notification preferences (5.4U-B): overrides per organization + user + event type.
 * A missing row means the catalog default (src/lib/notifications/events.ts); a row stores an
 * explicit boolean. The composite FK ties the preference to a membership of that organization
 * (removed with it). event_type is validated against the catalog by the service; the database
 * only enforces the same shape as notifications.type.
 */
export const notificationPreferences = pgTable(
	'notification_preferences',
	{
		organizationId: uuid('organization_id').notNull(),
		userId: uuid('user_id').notNull(),
		eventType: varchar('event_type', { length: 80 }).notNull(),
		inAppEnabled: boolean('in_app_enabled').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		primaryKey({
			name: 'notification_preferences_pkey',
			columns: [table.organizationId, table.userId, table.eventType]
		}),
		foreignKey({
			name: 'notification_preferences_member_org_fk',
			columns: [table.organizationId, table.userId],
			foreignColumns: [memberships.organizationId, memberships.userId]
		}).onDelete('cascade'),
		check(
			'notification_preferences_event_type_check',
			sql`${table.eventType} ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'`
		)
	]
);
export type NotificationPreferenceRecord = typeof notificationPreferences.$inferSelect;

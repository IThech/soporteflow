import { sql } from 'drizzle-orm';
import {
	boolean,
	primaryKey,
	pgTable,
	uuid,
	varchar,
	text,
	integer,
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
 * A missing row means the catalog default (src/lib/notifications/events.ts). 5.4U-D: each channel
 * column is an independent override; NULL = that channel's default. A row always overrides at
 * least one channel (otherwise it is deleted). The composite FK ties the preference to a membership of that organization
 * (removed with it). event_type is validated against the catalog by the service; the database
 * only enforces the same shape as notifications.type.
 */
export const notificationPreferences = pgTable(
	'notification_preferences',
	{
		organizationId: uuid('organization_id').notNull(),
		userId: uuid('user_id').notNull(),
		eventType: varchar('event_type', { length: 80 }).notNull(),
		inAppEnabled: boolean('in_app_enabled'),
		emailEnabled: boolean('email_enabled'),
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
		),
		check(
			'notification_preferences_override_check',
			sql`${table.inAppEnabled} IS NOT NULL OR ${table.emailEnabled} IS NOT NULL`
		)
	]
);
export type NotificationPreferenceRecord = typeof notificationPreferences.$inferSelect;

/**
 * External delivery intents (5.4U-D), one row per (recipient, channel, domain event). Acts as a
 * notification-scoped outbox: rows are written in the domain transaction and sent later by
 * processDueNotificationDeliveries, outside any long transaction.
 *
 * Self-contained snapshot (event type, title, message): it does NOT depend on the inbox row, so it
 * works with in-app disabled and survives the user deleting the in-app notification
 * (notification_id is a nullable reference, SET NULL on delete). The recipient address is NOT
 * stored: it is resolved at send time from the user's sign-in email (auth_users).
 *
 * Status machine: pending -> processing -> sent | retry | failed; retry -> processing -> ...
 * next_attempt_at is set exactly for pending/retry/processing (for processing it is the lease
 * expiry, so an abandoned claim becomes due again). Only 'email' is supported.
 */
export const NOTIFICATION_DELIVERY_STATUSES = [
	'pending',
	'processing',
	'sent',
	'retry',
	'failed'
] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];
export const NOTIFICATION_DELIVERY_ERROR_CODES = [
	'PROVIDER_NOT_CONFIGURED',
	'NETWORK_ERROR',
	'RATE_LIMITED',
	'RECIPIENT_INVALID',
	'RECIPIENT_INACTIVE',
	'PROVIDER_ERROR',
	'MAX_ATTEMPTS'
] as const;
export type NotificationDeliveryErrorCode = (typeof NOTIFICATION_DELIVERY_ERROR_CODES)[number];

export const notificationDeliveries = pgTable(
	'notification_deliveries',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id').notNull(),
		recipientUserId: uuid('recipient_user_id').notNull(),
		notificationId: uuid('notification_id'),
		channel: varchar('channel', { length: 20 }).notNull(),
		eventType: varchar('event_type', { length: 80 }).notNull(),
		title: varchar('title', { length: 160 }).notNull(),
		message: text('message').notNull(),
		status: varchar('status', { length: 20 }).default('pending').notNull(),
		attemptCount: integer('attempt_count').default(0).notNull(),
		nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow(),
		leaseToken: uuid('lease_token'),
		lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
		sentAt: timestamp('sent_at', { withTimezone: true }),
		failedAt: timestamp('failed_at', { withTimezone: true }),
		lastErrorCode: varchar('last_error_code', { length: 40 }),
		providerMessageId: varchar('provider_message_id', { length: 255 }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		foreignKey({
			name: 'notification_deliveries_recipient_org_fk',
			columns: [table.organizationId, table.recipientUserId],
			foreignColumns: [memberships.organizationId, memberships.userId]
		}).onDelete('cascade'),
		foreignKey({
			name: 'notification_deliveries_notification_fk',
			columns: [table.notificationId],
			foreignColumns: [notifications.id]
		}).onDelete('set null'),
		check('notification_deliveries_channel_check', sql`${table.channel} IN ('email')`),
		check(
			'notification_deliveries_status_check',
			sql`${table.status} IN ('pending', 'processing', 'sent', 'retry', 'failed')`
		),
		check(
			'notification_deliveries_event_type_check',
			sql`${table.eventType} ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'`
		),
		check(
			'notification_deliveries_title_check',
			sql`length(btrim(${table.title})) BETWEEN 1 AND 160`
		),
		check(
			'notification_deliveries_message_check',
			sql`length(btrim(${table.message})) BETWEEN 1 AND 2000`
		),
		check(
			'notification_deliveries_attempt_count_check',
			sql`${table.attemptCount} BETWEEN 0 AND 10`
		),
		check(
			'notification_deliveries_error_code_check',
			sql`${table.lastErrorCode} IS NULL OR ${table.lastErrorCode} IN ('PROVIDER_NOT_CONFIGURED', 'NETWORK_ERROR', 'RATE_LIMITED', 'RECIPIENT_INVALID', 'RECIPIENT_INACTIVE', 'PROVIDER_ERROR', 'MAX_ATTEMPTS')`
		),
		check(
			'notification_deliveries_state_check',
			sql`(${table.status} IN ('pending', 'retry', 'processing')) = (${table.nextAttemptAt} IS NOT NULL) AND (${table.status} = 'processing') = (${table.leaseToken} IS NOT NULL) AND (${table.status} = 'sent') = (${table.sentAt} IS NOT NULL) AND (${table.status} = 'failed') = (${table.failedAt} IS NOT NULL) AND (${table.status} <> 'failed' OR ${table.lastErrorCode} IS NOT NULL)`
		),
		index('notification_deliveries_due_idx')
			.on(table.nextAttemptAt, table.id)
			.where(sql`${table.status} IN ('pending', 'retry', 'processing')`),
		index('notification_deliveries_recipient_idx').on(
			table.organizationId,
			table.recipientUserId,
			table.createdAt
		),
		index('notification_deliveries_terminal_idx')
			.on(table.updatedAt)
			.where(sql`${table.status} IN ('sent', 'failed')`)
	]
);
export type NotificationDeliveryRecord = typeof notificationDeliveries.$inferSelect;

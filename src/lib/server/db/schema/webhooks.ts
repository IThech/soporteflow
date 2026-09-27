import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
	varchar
} from 'drizzle-orm/pg-core';
import { organizations, users } from './identity';
import { automationEvents } from './automation';

/**
 * Outbound webhook subscriptions (5.4V-B), per organization. `event_types` is an explicit JSON
 * array of automation event types (validated against the catalog server-side; no wildcard).
 * Never hard-deleted by the API (DELETE = deactivate) so delivery history keeps its subscription.
 * The signing secret is NOT stored here: see webhook_secrets (encrypted, versioned).
 */
export const webhookSubscriptions = pgTable(
	'webhook_subscriptions',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id').notNull(),
		name: varchar('name', { length: 120 }).notNull(),
		targetUrl: text('target_url').notNull(),
		eventTypes: jsonb('event_types').notNull(),
		active: boolean('active').default(true).notNull(),
		currentSecretVersion: integer('current_secret_version').default(1).notNull(),
		createdByUserId: uuid('created_by_user_id'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		unique('webhook_subscriptions_id_org_unique').on(table.id, table.organizationId),
		foreignKey({
			name: 'webhook_subscriptions_organization_fk',
			columns: [table.organizationId],
			foreignColumns: [organizations.id]
		}).onDelete('cascade'),
		foreignKey({
			name: 'webhook_subscriptions_created_by_fk',
			columns: [table.createdByUserId],
			foreignColumns: [users.id]
		}).onDelete('set null'),
		check('webhook_subscriptions_name_check', sql`length(btrim(${table.name})) BETWEEN 1 AND 120`),
		check(
			'webhook_subscriptions_target_url_check',
			sql`length(${table.targetUrl}) BETWEEN 9 AND 2048 AND ${table.targetUrl} LIKE 'https://%'`
		),
		check(
			'webhook_subscriptions_event_types_check',
			sql`jsonb_typeof(${table.eventTypes}) = 'array' AND jsonb_array_length(${table.eventTypes}) BETWEEN 1 AND 50`
		),
		check('webhook_subscriptions_secret_version_check', sql`${table.currentSecretVersion} >= 1`),
		index('webhook_subscriptions_org_idx').on(table.organizationId, table.active)
	]
);
export type WebhookSubscriptionRecord = typeof webhookSubscriptions.$inferSelect;

/**
 * Signing secrets, one row per (subscription, version). Encrypted with AES-256-GCM under the
 * application key WEBHOOK_SECRET_ENCRYPTION_KEY; the plaintext never reaches the database.
 * Old versions are kept so pending deliveries are signed with the version they were created with.
 */
export const webhookSecrets = pgTable(
	'webhook_secrets',
	{
		subscriptionId: uuid('subscription_id').notNull(),
		organizationId: uuid('organization_id').notNull(),
		version: integer('version').notNull(),
		ciphertext: text('ciphertext').notNull(),
		iv: varchar('iv', { length: 32 }).notNull(),
		authTag: varchar('auth_tag', { length: 32 }).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		primaryKey({
			name: 'webhook_secrets_pkey',
			columns: [table.subscriptionId, table.version]
		}),
		foreignKey({
			name: 'webhook_secrets_subscription_fk',
			columns: [table.subscriptionId, table.organizationId],
			foreignColumns: [webhookSubscriptions.id, webhookSubscriptions.organizationId]
		}).onDelete('cascade'),
		check('webhook_secrets_version_check', sql`${table.version} >= 1`)
	]
);

export const WEBHOOK_DELIVERY_ERROR_CODES = [
	'DNS_RESOLUTION_FAILED',
	'SSRF_BLOCKED',
	'INVALID_TARGET',
	'TIMEOUT',
	'CONNECTION_FAILED',
	'TLS_ERROR',
	'REDIRECT_NOT_ALLOWED',
	'HTTP_4XX',
	'HTTP_5XX',
	'RATE_LIMITED',
	'INVALID_RESPONSE',
	'CONFIGURATION_ERROR',
	'SUBSCRIPTION_INACTIVE',
	'MAX_ATTEMPTS'
] as const;
export type WebhookDeliveryErrorCode = (typeof WEBHOOK_DELIVERY_ERROR_CODES)[number];

/**
 * Webhook delivery intents (5.4V-B), created by the fanout in the same transaction as the
 * automation event. Self-contained snapshot: exact serialized body, target URL and secret version
 * at intent time. UNIQUE (subscription_id, event_id) makes the fanout idempotent.
 * Status machine and lease semantics mirror notification_deliveries.
 */
export const webhookDeliveries = pgTable(
	'webhook_deliveries',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id').notNull(),
		subscriptionId: uuid('subscription_id').notNull(),
		eventId: uuid('event_id').notNull(),
		eventType: varchar('event_type', { length: 80 }).notNull(),
		targetUrl: text('target_url').notNull(),
		secretVersion: integer('secret_version').notNull(),
		body: text('body').notNull(),
		status: varchar('status', { length: 20 }).default('pending').notNull(),
		attemptCount: integer('attempt_count').default(0).notNull(),
		nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow(),
		leaseToken: uuid('lease_token'),
		lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
		deliveredAt: timestamp('delivered_at', { withTimezone: true }),
		failedAt: timestamp('failed_at', { withTimezone: true }),
		lastStatusCode: integer('last_status_code'),
		lastErrorCode: varchar('last_error_code', { length: 40 }),
		responseTimeMs: integer('response_time_ms'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		unique('webhook_deliveries_subscription_event_unique').on(table.subscriptionId, table.eventId),
		foreignKey({
			name: 'webhook_deliveries_subscription_fk',
			columns: [table.subscriptionId, table.organizationId],
			foreignColumns: [webhookSubscriptions.id, webhookSubscriptions.organizationId]
		}).onDelete('cascade'),
		foreignKey({
			name: 'webhook_deliveries_secret_fk',
			columns: [table.subscriptionId, table.secretVersion],
			foreignColumns: [webhookSecrets.subscriptionId, webhookSecrets.version]
		}).onDelete('cascade'),
		foreignKey({
			name: 'webhook_deliveries_event_fk',
			columns: [table.eventId],
			foreignColumns: [automationEvents.id]
		}).onDelete('cascade'),
		check(
			'webhook_deliveries_status_check',
			sql`${table.status} IN ('pending', 'processing', 'sent', 'retry', 'failed')`
		),
		check(
			'webhook_deliveries_event_type_check',
			sql`${table.eventType} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'`
		),
		check(
			'webhook_deliveries_target_url_check',
			sql`length(${table.targetUrl}) BETWEEN 9 AND 2048 AND ${table.targetUrl} LIKE 'https://%'`
		),
		check('webhook_deliveries_body_check', sql`octet_length(${table.body}) BETWEEN 2 AND 32768`),
		check('webhook_deliveries_attempt_count_check', sql`${table.attemptCount} BETWEEN 0 AND 10`),
		check(
			'webhook_deliveries_status_code_check',
			sql`${table.lastStatusCode} IS NULL OR ${table.lastStatusCode} BETWEEN 100 AND 599`
		),
		check(
			'webhook_deliveries_response_time_check',
			sql`${table.responseTimeMs} IS NULL OR ${table.responseTimeMs} >= 0`
		),
		check(
			'webhook_deliveries_error_code_check',
			sql`${table.lastErrorCode} IS NULL OR ${table.lastErrorCode} IN ('DNS_RESOLUTION_FAILED', 'SSRF_BLOCKED', 'INVALID_TARGET', 'TIMEOUT', 'CONNECTION_FAILED', 'TLS_ERROR', 'REDIRECT_NOT_ALLOWED', 'HTTP_4XX', 'HTTP_5XX', 'RATE_LIMITED', 'INVALID_RESPONSE', 'CONFIGURATION_ERROR', 'SUBSCRIPTION_INACTIVE', 'MAX_ATTEMPTS')`
		),
		check(
			'webhook_deliveries_state_check',
			sql`(${table.status} IN ('pending', 'retry', 'processing')) = (${table.nextAttemptAt} IS NOT NULL) AND (${table.status} = 'processing') = (${table.leaseToken} IS NOT NULL) AND (${table.status} = 'sent') = (${table.deliveredAt} IS NOT NULL) AND (${table.status} = 'failed') = (${table.failedAt} IS NOT NULL) AND (${table.status} <> 'failed' OR ${table.lastErrorCode} IS NOT NULL)`
		),
		index('webhook_deliveries_due_idx')
			.on(table.nextAttemptAt, table.id)
			.where(sql`${table.status} IN ('pending', 'retry', 'processing')`),
		index('webhook_deliveries_subscription_idx').on(
			table.organizationId,
			table.subscriptionId,
			table.createdAt
		),
		index('webhook_deliveries_terminal_idx')
			.on(table.updatedAt)
			.where(sql`${table.status} IN ('sent', 'failed')`)
	]
);
export type WebhookDeliveryRecord = typeof webhookDeliveries.$inferSelect;

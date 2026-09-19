import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	foreignKey,
	index,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
	varchar
} from 'drizzle-orm/pg-core';
import { users, userEmails } from './identity';

const timestamps = () => ({
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
});

/** Optional access profile: the UUID is supplied by the Core, never generated here. */
export const authUsers = pgTable(
	'auth_users',
	{
		id: uuid('id')
			.primaryKey()
			.references(() => users.id, { onDelete: 'restrict' }),
		name: text('name').notNull(),
		email: varchar('email', { length: 255 }).notNull().unique(),
		emailVerified: boolean('email_verified').default(false).notNull(),
		image: text('image'),
		...timestamps()
	},
	(table) => [
		check(
			'auth_users_email_normalized',
			sql`${table.email} <> '' AND ${table.email} = lower(btrim(${table.email}))`
		),
		foreignKey({
			name: 'auth_users_email_owner_fk',
			columns: [table.id, table.email],
			foreignColumns: [userEmails.userId, userEmails.email]
		})
			.onDelete('restrict')
			.onUpdate('restrict')
	]
);

/** Better Auth 1.7.5 standard account fields; password stores a hash, never plaintext. */
export const authAccounts = pgTable(
	'auth_accounts',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		userId: uuid('user_id')
			.notNull()
			.references(() => authUsers.id, { onDelete: 'cascade' }),
		accountId: text('account_id').notNull(),
		providerId: text('provider_id').notNull(),
		password: text('password'),
		accessToken: text('access_token'),
		refreshToken: text('refresh_token'),
		idToken: text('id_token'),
		accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
		refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
		scope: text('scope'),
		...timestamps()
	},
	(table) => [
		unique('auth_accounts_provider_account_unique').on(table.providerId, table.accountId),
		check(
			'auth_accounts_credential_identity_check',
			sql`${table.providerId} <> 'credential' OR (${table.accountId} = ${table.userId}::text AND ${table.password} IS NOT NULL AND ${table.password} <> '')`
		),
		index('auth_accounts_user_idx').on(table.userId)
	]
);

/** Revocation deletes rows. No custom revoked_at field or cached authorization. */
export const authSessions = pgTable(
	'auth_sessions',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		userId: uuid('user_id')
			.notNull()
			.references(() => authUsers.id, { onDelete: 'cascade' }),
		token: text('token').notNull().unique(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		...timestamps()
	},
	(table) => [
		index('auth_sessions_user_idx').on(table.userId),
		index('auth_sessions_expiry_idx').on(table.expiresAt)
	]
);

/** Generic verification payloads: value is not necessarily a user UUID. No endpoint is enabled. */
export const authVerifications = pgTable(
	'auth_verifications',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		identifier: text('identifier').notNull(),
		value: text('value').notNull(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		...timestamps()
	},
	(table) => [
		index('auth_verifications_identifier_idx').on(table.identifier),
		index('auth_verifications_expiry_idx').on(table.expiresAt)
	]
);

import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	pgTable,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
	varchar
} from 'drizzle-orm/pg-core';

/**
 * Global identity: pure subject / actor.
 * Decoupled from email addresses and authentication credentials.
 */
export const users = pgTable('users', {
	id: uuid('id').defaultRandom().primaryKey(),
	name: varchar('name', { length: 255 }).notNull(),
	displayName: varchar('display_name', { length: 255 }),
	active: boolean('active').default(true).notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
});

/**
 * User contact email addresses.
 * Case-insensitively unique per email (LOWER(email)), with at most one primary email per user.
 */
export const userEmails = pgTable(
	'user_emails',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		email: varchar('email', { length: 255 }).notNull(),
		isPrimary: boolean('is_primary').default(false).notNull(),
		verifiedAt: timestamp('verified_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		uniqueIndex('user_emails_email_lower_unique_idx').on(sql`lower(${table.email})`),
		uniqueIndex('user_emails_user_primary_unique_idx')
			.on(table.userId)
			.where(sql`is_primary = true`)
	]
);

/**
 * Multi-tenant organization boundary.
 */
export const organizations = pgTable(
	'organizations',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		name: varchar('name', { length: 255 }).notNull(),
		slug: varchar('slug', { length: 100 }).notNull(),
		status: varchar('status', { length: 50 }).default('trial').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		unique('organizations_slug_unique').on(table.slug),
		check('organizations_status_check', sql`status IN ('trial', 'active', 'suspended')`)
	]
);

/**
 * Membership connecting a user with an organization.
 * Contains compound unique constraint (id, organization_id) to enable composite FKs in child tables.
 * Note: Composite foreign keys guarantee relational integrity (preventing cross-tenant foreign references),
 * but full multi-tenant isolation relies on server authorization and future RLS policies.
 */
export const memberships = pgTable(
	'memberships',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		active: boolean('active').default(true).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		unique('memberships_org_user_unique').on(table.organizationId, table.userId),
		unique('memberships_id_org_unique').on(table.id, table.organizationId)
	]
);

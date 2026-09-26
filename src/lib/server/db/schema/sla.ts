import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	integer,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
	varchar
} from 'drizzle-orm/pg-core';
import { organizations } from './identity';

/**
 * Organization SLA policies (5.4T-A, Core v1): a reusable set of targets owned by one tenant.
 * - Targets are elapsed minutes, 24x7 (no business hours, holidays or time zones yet).
 * - A policy carries targets only: which policy applies to an incident (priority, support level,
 *   category rules) is decided in 5.4T-B, which must also snapshot targets/deadlines on the
 *   incident so later policy edits never change them retroactively.
 * - No physical delete: policies are deactivated (future incidents keep historical references;
 *   UNIQUE (id, organization_id) allows tenant-safe composite FKs from them).
 * - At most one default per organization, and a default is always active.
 */
export const SLA_TARGET_MAX_MINUTES = 5_256_000; // ~10 years

export const slaPolicies = pgTable(
	'sla_policies',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		code: varchar('code', { length: 50 }).notNull(),
		name: varchar('name', { length: 100 }).notNull(),
		description: text('description'),
		active: boolean('active').default(true).notNull(),
		isDefault: boolean('is_default').default(false).notNull(),
		firstResponseMinutes: integer('first_response_minutes').notNull(),
		resolutionMinutes: integer('resolution_minutes').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		unique('sla_policies_org_code_unique').on(table.organizationId, table.code),
		unique('sla_policies_id_org_unique').on(table.id, table.organizationId),
		uniqueIndex('sla_policies_org_default_unique_idx')
			.on(table.organizationId)
			.where(sql`is_default = true`),
		check(
			'sla_policies_code_check',
			sql`char_length(${table.code}) BETWEEN 3 AND 50 AND ${table.code} ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'`
		),
		check('sla_policies_name_check', sql`btrim(${table.name}) <> ''`),
		check(
			'sla_policies_description_check',
			sql`${table.description} IS NULL OR char_length(${table.description}) <= 1000`
		),
		check(
			'sla_policies_targets_check',
			sql`${table.firstResponseMinutes} BETWEEN 1 AND 5256000 AND ${table.resolutionMinutes} BETWEEN 1 AND 5256000 AND ${table.resolutionMinutes} >= ${table.firstResponseMinutes}`
		),
		check('sla_policies_default_active_check', sql`NOT ${table.isDefault} OR ${table.active}`)
	]
);

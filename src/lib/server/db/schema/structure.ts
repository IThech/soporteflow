import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	foreignKey,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
	varchar
} from 'drizzle-orm/pg-core';
import { organizations, memberships } from './identity';

/**
 * Organizational departments (e.g. IT, Operations, Legal, Medical Direction).
 */
export const departments = pgTable(
	'departments',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		name: varchar('name', { length: 255 }).notNull(),
		code: varchar('code', { length: 50 }),
		description: text('description'),
		active: boolean('active').default(true).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		unique('departments_org_name_unique').on(table.organizationId, table.name),
		unique('departments_id_org_unique').on(table.id, table.organizationId)
	]
);

/**
 * Physical or logical sites / headquarters of an organization (e.g. Clínica Norte, Central).
 * Names are unique per organization ignoring case and redundant whitespace, enforced by
 * sites_org_normalized_name_unique_idx so concurrent writes cannot create duplicates.
 */
export const sites = pgTable(
	'sites',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		name: varchar('name', { length: 255 }).notNull(),
		description: text('description'),
		active: boolean('active').default(true).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		unique('sites_org_name_unique').on(table.organizationId, table.name),
		unique('sites_id_org_unique').on(table.id, table.organizationId),
		uniqueIndex('sites_org_normalized_name_unique_idx').on(
			table.organizationId,
			sql`lower(regexp_replace(btrim(${table.name}), '\\s+', ' ', 'g'))`
		)
	]
);

/**
 * Operational teams with visibility policy (shared vs restricted).
 */
export const teams = pgTable(
	'teams',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		name: varchar('name', { length: 255 }).notNull(),
		description: text('description'),
		visibility: varchar('visibility', { length: 20 }).default('shared').notNull(),
		active: boolean('active').default(true).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		unique('teams_org_name_unique').on(table.organizationId, table.name),
		unique('teams_id_org_unique').on(table.id, table.organizationId),
		check('teams_visibility_check', sql`visibility IN ('shared', 'restricted')`)
	]
);

/**
 * Team members with composite foreign keys for relational multi-tenant integrity.
 * Note: While composite foreign keys prevent cross-tenant references at the relational level,
 * tenant isolation is a defense-in-depth model requiring server-level authorization and future RLS policies.
 * `is_lead` is purely descriptive and NEVER grants permissions or queue visibility automatically.
 */
export const teamMemberships = pgTable(
	'team_memberships',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id').notNull(),
		teamId: uuid('team_id').notNull(),
		membershipId: uuid('membership_id').notNull(),
		isLead: boolean('is_lead').default(false).notNull(),
		active: boolean('active').default(true).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		unique('team_memberships_team_member_unique').on(table.teamId, table.membershipId),
		foreignKey({
			name: 'team_memberships_team_org_fk',
			columns: [table.teamId, table.organizationId],
			foreignColumns: [teams.id, teams.organizationId]
		}).onDelete('cascade'),
		foreignKey({
			name: 'team_memberships_membership_org_fk',
			columns: [table.membershipId, table.organizationId],
			foreignColumns: [memberships.id, memberships.organizationId]
		}).onDelete('cascade')
	]
);

/**
 * Operational site membership: "this membership normally works at this site".
 * Many-to-many, tenant-specific (membership, not global user). It NEVER grants permissions,
 * queue visibility, routing or incident access: authorization scopes live in
 * role_assignments (scope_type = 'site'), and "all sites" is expressed by organization-level
 * authorization, never by one row per site. No primary site in v1.
 * Deactivation keeps the row; RESTRICT (not CASCADE) protects the history of associations.
 */
export const membershipSites = pgTable(
	'membership_sites',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id').notNull(),
		membershipId: uuid('membership_id').notNull(),
		siteId: uuid('site_id').notNull(),
		active: boolean('active').default(true).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		unique('membership_sites_membership_site_unique').on(table.membershipId, table.siteId),
		foreignKey({
			name: 'membership_sites_membership_org_fk',
			columns: [table.membershipId, table.organizationId],
			foreignColumns: [memberships.id, memberships.organizationId]
		}).onDelete('restrict'),
		foreignKey({
			name: 'membership_sites_site_org_fk',
			columns: [table.siteId, table.organizationId],
			foreignColumns: [sites.id, sites.organizationId]
		}).onDelete('restrict')
	]
);

/**
 * Transversal teams associated with the departments they service.
 * Enforces that both team and department belong to the exact same organization.
 */
export const teamServiceDepartments = pgTable(
	'team_service_departments',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id').notNull(),
		teamId: uuid('team_id').notNull(),
		departmentId: uuid('department_id').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		unique('team_service_dept_unique').on(table.teamId, table.departmentId),
		foreignKey({
			name: 'team_service_dept_team_org_fk',
			columns: [table.teamId, table.organizationId],
			foreignColumns: [teams.id, teams.organizationId]
		}).onDelete('cascade'),
		foreignKey({
			name: 'team_service_dept_department_org_fk',
			columns: [table.departmentId, table.organizationId],
			foreignColumns: [departments.id, departments.organizationId]
		}).onDelete('cascade')
	]
);

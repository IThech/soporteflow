import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	foreignKey,
	index,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
	varchar
} from 'drizzle-orm/pg-core';
import { organizations, memberships, users } from './identity';
import { departments, sites, teams } from './structure';

/**
 * Granular permissions catalog.
 */
export const permissions = pgTable('permissions', {
	id: varchar('id', { length: 100 }).primaryKey(),
	name: varchar('name', { length: 255 }).notNull(),
	description: text('description'),
	category: varchar('category', { length: 50 }).notNull(),
	allowedScopeTypes: varchar('allowed_scope_types', { length: 50 }).array().notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

/**
 * System role blueprints / templates.
 * These act purely as templates to instantiate roles into organizations.
 * They have NO organization_id and CANNOT be assigned to any membership.
 */
export const roleTemplates = pgTable('role_templates', {
	id: varchar('id', { length: 50 }).primaryKey(),
	code: varchar('code', { length: 50 }).notNull().unique(),
	name: varchar('name', { length: 100 }).notNull(),
	description: text('description'),
	active: boolean('active').default(true).notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
});

/**
 * Permissions assigned to system role templates.
 */
export const roleTemplatePermissions = pgTable(
	'role_template_permissions',
	{
		roleTemplateId: varchar('role_template_id', { length: 50 })
			.notNull()
			.references(() => roleTemplates.id, { onDelete: 'cascade' }),
		permissionId: varchar('permission_id', { length: 100 })
			.notNull()
			.references(() => permissions.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [primaryKey({ columns: [table.roleTemplateId, table.permissionId] })]
);

/**
 * Organizational roles.
 * Must strictly belong to an organization (organization_id is NOT NULL).
 * Can be instantiated from a template or created custom.
 */
export const roles = pgTable(
	'roles',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		name: varchar('name', { length: 100 }).notNull(),
		code: varchar('code', { length: 50 }).notNull(),
		description: text('description'),
		templateId: varchar('template_id', { length: 50 }).references(() => roleTemplates.id, {
			onDelete: 'set null'
		}),
		isCustom: boolean('is_custom').default(false).notNull(),
		active: boolean('active').default(true).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		unique('roles_org_code_unique').on(table.organizationId, table.code),
		unique('roles_id_org_unique').on(table.id, table.organizationId)
	]
);

/**
 * Permissions granted to organizational roles.
 */
export const rolePermissions = pgTable(
	'role_permissions',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		roleId: uuid('role_id')
			.notNull()
			.references(() => roles.id, { onDelete: 'cascade' }),
		permissionId: varchar('permission_id', { length: 100 })
			.notNull()
			.references(() => permissions.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [unique('role_permissions_role_perm_unique').on(table.roleId, table.permissionId)]
);

/**
 * Explicit role assignments with typed scope and composite foreign keys for relational multi-tenant integrity.
 * Note: While composite foreign keys prevent cross-tenant references at the relational level,
 * tenant isolation is a defense-in-depth model requiring server-level authorization and future RLS policies.
 * Supported scope types: organization, department, team, site, personal.
 */
export const roleAssignments = pgTable(
	'role_assignments',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id').notNull(),
		membershipId: uuid('membership_id').notNull(),
		roleId: uuid('role_id').notNull(),
		scopeType: varchar('scope_type', { length: 30 }).notNull(),
		departmentId: uuid('department_id'),
		teamId: uuid('team_id'),
		siteId: uuid('site_id'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		foreignKey({
			name: 'role_assignments_membership_org_fk',
			columns: [table.membershipId, table.organizationId],
			foreignColumns: [memberships.id, memberships.organizationId]
		}).onDelete('cascade'),
		foreignKey({
			name: 'role_assignments_role_org_fk',
			columns: [table.roleId, table.organizationId],
			foreignColumns: [roles.id, roles.organizationId]
		}).onDelete('cascade'),
		foreignKey({
			name: 'role_assignments_department_org_fk',
			columns: [table.departmentId, table.organizationId],
			foreignColumns: [departments.id, departments.organizationId]
		}).onDelete('cascade'),
		foreignKey({
			name: 'role_assignments_team_org_fk',
			columns: [table.teamId, table.organizationId],
			foreignColumns: [teams.id, teams.organizationId]
		}).onDelete('cascade'),
		foreignKey({
			name: 'role_assignments_site_org_fk',
			columns: [table.siteId, table.organizationId],
			foreignColumns: [sites.id, sites.organizationId]
		}).onDelete('cascade'),
		check(
			'role_assignments_scope_type_check',
			sql`scope_type IN ('organization', 'department', 'team', 'site', 'personal')`
		),
		check(
			'role_assignments_scope_fk_check',
			sql`
				(scope_type = 'organization' AND department_id IS NULL AND team_id IS NULL AND site_id IS NULL) OR
				(scope_type = 'department'   AND department_id IS NOT NULL AND team_id IS NULL AND site_id IS NULL) OR
				(scope_type = 'team'         AND team_id IS NOT NULL AND department_id IS NULL AND site_id IS NULL) OR
				(scope_type = 'site'         AND site_id IS NOT NULL AND department_id IS NULL AND team_id IS NULL) OR
				(scope_type = 'personal'     AND department_id IS NULL AND team_id IS NULL AND site_id IS NULL)
			`
		),
		uniqueIndex('role_assignments_unique_idx').on(
			table.membershipId,
			table.roleId,
			table.scopeType,
			sql`COALESCE(${table.departmentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
			sql`COALESCE(${table.teamId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
			sql`COALESCE(${table.siteId}, '00000000-0000-0000-0000-000000000000'::uuid)`
		)
	]
);

/**
 * Organization invitations (5.4S-A: persistence only; no service, token generation or HTTP yet).
 * - email: persisted already normalized by the service (trimmed, lower-case). The database rejects
 *   non-normalized values instead of silently rewriting them, consistent with user_emails
 *   (case-insensitive uniqueness via lower(email)).
 * - token_hash: only a hash of the invitation token is ever stored (never the raw token).
 * - role: composite FK (role_id, organization_id) -> roles(id, organization_id), so an invitation
 *   can only reference a role of its own organization (same pattern as role_assignments).
 * - At most one pending invitation per (organization, email): partial unique index. Resend and
 *   revoke flows (5.4S-C) must retire the previous pending invitation in the same transaction.
 */
export const invitations = pgTable(
	'invitations',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		email: varchar('email', { length: 255 }).notNull(),
		roleId: uuid('role_id').notNull(),
		tokenHash: varchar('token_hash', { length: 64 }).notNull(),
		/**
		 * 5.4S-D: canonical permission ids of the role when the invitation was issued (create /
		 * resend, after the delegation check). Acceptance requires the role's current permissions to
		 * be a subset, so widening a role never flows through a pending invitation. Empty default is
		 * fail-closed (only a permission-less role could match).
		 */
		rolePermissionIds: varchar('role_permission_ids', { length: 100 })
			.array()
			.default(sql`'{}'::varchar(100)[]`)
			.notNull(),
		status: varchar('status', { length: 20 }).default('pending').notNull(),
		invitedByUserId: uuid('invited_by_user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		acceptedAt: timestamp('accepted_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		foreignKey({
			name: 'invitations_role_org_fk',
			columns: [table.roleId, table.organizationId],
			foreignColumns: [roles.id, roles.organizationId]
		}).onDelete('cascade'),
		unique('invitations_token_hash_unique').on(table.tokenHash),
		check(
			'invitations_status_check',
			sql`${table.status} IN ('pending', 'accepted', 'revoked', 'expired')`
		),
		check(
			'invitations_email_normalized_check',
			sql`${table.email} <> '' AND ${table.email} = lower(btrim(${table.email}))`
		),
		check(
			'invitations_accepted_at_check',
			sql`(${table.status} = 'accepted') = (${table.acceptedAt} IS NOT NULL)`
		),
		index('invitations_org_status_idx').on(table.organizationId, table.status),
		uniqueIndex('invitations_org_email_pending_unique_idx')
			.on(table.organizationId, table.email)
			.where(sql`status = 'pending'`)
	]
);

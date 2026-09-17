import {
	boolean,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
	varchar
} from 'drizzle-orm/pg-core';
import { organizations } from './identity';

/**
 * Platform modular registry.
 */
export const modules = pgTable('modules', {
	id: varchar('id', { length: 50 }).primaryKey(),
	name: varchar('name', { length: 100 }).notNull(),
	description: text('description'),
	version: varchar('version', { length: 20 }).default('1.0.0').notNull(),
	isCore: boolean('is_core').default(false).notNull(),
	active: boolean('active').default(true).notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

/**
 * Module activation and configuration per organization.
 */
export const organizationModules = pgTable(
	'organization_modules',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		organizationId: uuid('organization_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		moduleId: varchar('module_id', { length: 50 })
			.notNull()
			.references(() => modules.id, { onDelete: 'cascade' }),
		enabled: boolean('enabled').default(true).notNull(),
		config: jsonb('config').default('{}').notNull(),
		enabledAt: timestamp('enabled_at', { withTimezone: true }).defaultNow().notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		unique('organization_modules_org_module_unique').on(table.organizationId, table.moduleId)
	]
);

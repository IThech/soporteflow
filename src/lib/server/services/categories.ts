import { and, asc, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { categories, organizations } from '../db/schema';
import { IncidentServiceError } from './incidents';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CategoryDatabase = PgDatabase<any, any>;

/** Category DTO: organizationId is implied by the tenant-scoped query and never returned. */
export interface CategoryRecord {
	id: string;
	name: string;
	description: string | null;
	active: boolean;
	createdAt: Date;
	updatedAt: Date;
}

export const CATEGORY_NAME_MIN_LENGTH = 2;
export const CATEGORY_NAME_MAX_LENGTH = 100;
export const CATEGORY_DESCRIPTION_MAX_LENGTH = 1000;

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(value: unknown): value is string {
	return typeof value === 'string' && uuidRegex.test(value);
}

const categoryColumns = {
	id: categories.id,
	name: categories.name,
	description: categories.description,
	active: categories.active,
	createdAt: categories.createdAt,
	updatedAt: categories.updatedAt
};

/** Display form stored in the database: trimmed, inner whitespace collapsed to one space. */
export function canonicalCategoryName(name: string): string {
	return name.trim().replace(/\s+/g, ' ');
}

/** Comparison key mirroring categories_org_normalized_name_unique_idx. */
export function normalizeCategoryName(name: string): string {
	return canonicalCategoryName(name).toLowerCase();
}

function validateName(name: unknown): string {
	if (typeof name !== 'string') {
		throw new IncidentServiceError('INVALID_INPUT', 'name must be a string');
	}
	const canonical = canonicalCategoryName(name);
	if (canonical.length < CATEGORY_NAME_MIN_LENGTH) {
		throw new IncidentServiceError(
			'INVALID_INPUT',
			`name must have at least ${CATEGORY_NAME_MIN_LENGTH} characters`
		);
	}
	if (canonical.length > CATEGORY_NAME_MAX_LENGTH) {
		throw new IncidentServiceError(
			'INVALID_INPUT',
			`name must not exceed ${CATEGORY_NAME_MAX_LENGTH} characters`
		);
	}
	if (canonical.includes('\u0000')) {
		throw new IncidentServiceError('INVALID_INPUT', 'name contains invalid characters');
	}
	return canonical;
}

/** Optional text: trimmed; empty or whitespace-only becomes null (clears the description). */
function validateDescription(description: unknown): string | null {
	if (description === null) return null;
	if (typeof description !== 'string') {
		throw new IncidentServiceError('INVALID_INPUT', 'description must be a string or null');
	}
	const trimmed = description.trim();
	if (trimmed.length > CATEGORY_DESCRIPTION_MAX_LENGTH) {
		throw new IncidentServiceError(
			'INVALID_INPUT',
			`description must not exceed ${CATEGORY_DESCRIPTION_MAX_LENGTH} characters`
		);
	}
	if (trimmed.includes('\u0000')) {
		throw new IncidentServiceError('INVALID_INPUT', 'description contains invalid characters');
	}
	return trimmed.length === 0 ? null : trimmed;
}

function validateIds(organizationId: unknown, categoryId?: unknown): void {
	if (!isValidUuid(organizationId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'organizationId must be a valid UUID');
	}
	if (categoryId !== undefined && !isValidUuid(categoryId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'categoryId must be a valid UUID');
	}
}

function categoryNotFound(): IncidentServiceError {
	return new IncidentServiceError('CATEGORY_NOT_FOUND', 'Category not found');
}

/** Maps the database unique violation to a domain error; the index is the source of truth. */
function isDuplicateNameViolation(error: unknown): boolean {
	const candidates = [error, (error as { cause?: unknown })?.cause];
	return candidates.some((candidate) => {
		const { code, constraint, constraint_name } = (candidate ?? {}) as Record<string, unknown>;
		const name = constraint ?? constraint_name;
		return (
			code === '23505' &&
			(name === undefined ||
				name === 'categories_org_normalized_name_unique_idx' ||
				name === 'categories_org_name_unique')
		);
	});
}

async function assertOperationalOrganization(
	tx: CategoryDatabase,
	organizationId: string
): Promise<void> {
	const [org] = await tx
		.select({ status: organizations.status })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	if (!org) {
		throw new IncidentServiceError('ORGANIZATION_NOT_FOUND', 'Organization does not exist');
	}
	if (org.status !== 'active') {
		throw new IncidentServiceError(
			'ORGANIZATION_NOT_OPERATIONAL',
			`Organization is not operational (status: '${org.status}')`
		);
	}
}

async function inTransaction<T>(
	dbOrTx: CategoryDatabase,
	execute: (tx: CategoryDatabase) => Promise<T>
): Promise<T> {
	try {
		if ('transaction' in dbOrTx && typeof dbOrTx.transaction === 'function') {
			return await dbOrTx.transaction(async (tx) => execute(tx));
		}
		return await execute(dbOrTx);
	} catch (error) {
		if (error instanceof IncidentServiceError) throw error;
		if (isDuplicateNameViolation(error)) {
			throw new IncidentServiceError(
				'CATEGORY_NAME_DUPLICATE',
				'A category with this name already exists in the organization'
			);
		}
		throw error;
	}
}

/** Tenant-scoped row lock; cross-tenant and missing categories are indistinguishable. */
async function lockCategory(
	tx: CategoryDatabase,
	organizationId: string,
	categoryId: string
): Promise<CategoryRecord> {
	const [category] = await tx
		.select(categoryColumns)
		.from(categories)
		.where(and(eq(categories.id, categoryId), eq(categories.organizationId, organizationId)))
		.limit(1)
		.for('update');
	if (!category) throw categoryNotFound();
	return category;
}

/**
 * Lists the categories of one organization, including inactive ones for administration.
 * Pass { activeOnly: true } to list only categories selectable for new associations.
 * Deterministic ordering: name ASC, id ASC. Reads do not depend on organization status
 * (authorization belongs to the future API), same as listSites.
 */
export async function listCategories(
	db: CategoryDatabase,
	organizationId: string,
	options: { activeOnly?: boolean } = {}
): Promise<CategoryRecord[]> {
	validateIds(organizationId);
	const conditions = [eq(categories.organizationId, organizationId)];
	if (options.activeOnly === true) conditions.push(eq(categories.active, true));
	return db
		.select(categoryColumns)
		.from(categories)
		.where(and(...conditions))
		.orderBy(asc(categories.name), asc(categories.id));
}

/**
 * Creates an active category. Duplicate names (case and spacing insensitive) within the same
 * organization are rejected by the unique index, which also covers concurrent creations.
 */
export async function createCategory(
	dbOrTx: CategoryDatabase,
	organizationId: string,
	input: { name: unknown; description?: unknown }
): Promise<CategoryRecord> {
	validateIds(organizationId);
	const name = validateName(input?.name);
	const description =
		input?.description === undefined ? null : validateDescription(input.description);
	return inTransaction(dbOrTx, async (tx) => {
		await assertOperationalOrganization(tx, organizationId);
		const [category] = await tx
			.insert(categories)
			.values({ organizationId, name, description, active: true })
			.returning(categoryColumns);
		return category;
	});
}

/**
 * Updates name and/or description (omitted fields are kept; description null clears it).
 * Never changes active. No-op when the canonical values are unchanged: no write, same updatedAt.
 */
export async function updateCategory(
	dbOrTx: CategoryDatabase,
	organizationId: string,
	categoryId: string,
	input: { name?: unknown; description?: unknown }
): Promise<CategoryRecord> {
	validateIds(organizationId, categoryId);
	if (!input || (input.name === undefined && input.description === undefined)) {
		throw new IncidentServiceError('INVALID_INPUT', 'name or description must be provided');
	}
	const name = input.name === undefined ? undefined : validateName(input.name);
	const description =
		input.description === undefined ? undefined : validateDescription(input.description);
	return inTransaction(dbOrTx, async (tx) => {
		await assertOperationalOrganization(tx, organizationId);
		const current = await lockCategory(tx, organizationId, categoryId);
		const changes: { name?: string; description?: string | null } = {};
		if (name !== undefined && name !== current.name) changes.name = name;
		if (description !== undefined && description !== current.description)
			changes.description = description;
		if (Object.keys(changes).length === 0) return current;
		const [updated] = await tx
			.update(categories)
			.set({ ...changes, updatedAt: new Date() })
			.where(and(eq(categories.id, categoryId), eq(categories.organizationId, organizationId)))
			.returning(categoryColumns);
		return updated;
	});
}

/**
 * Activates or deactivates a category. Deactivation never deletes: historical references keep
 * pointing to it. Idempotent: setting the current state changes nothing (same updatedAt).
 */
export async function setCategoryActive(
	dbOrTx: CategoryDatabase,
	organizationId: string,
	categoryId: string,
	active: boolean
): Promise<CategoryRecord> {
	validateIds(organizationId, categoryId);
	if (typeof active !== 'boolean') {
		throw new IncidentServiceError('INVALID_INPUT', 'active must be a boolean');
	}
	return inTransaction(dbOrTx, async (tx) => {
		await assertOperationalOrganization(tx, organizationId);
		const current = await lockCategory(tx, organizationId, categoryId);
		if (current.active === active) return current;
		const [updated] = await tx
			.update(categories)
			.set({ active, updatedAt: new Date() })
			.where(and(eq(categories.id, categoryId), eq(categories.organizationId, organizationId)))
			.returning(categoryColumns);
		return updated;
	});
}

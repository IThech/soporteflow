import { and, asc, eq } from 'drizzle-orm';
import { categories, organizations, subcategories } from '../db/schema';
import { IncidentServiceError } from './incidents';
import { boundedRows } from '../security/bounded-read';
import type { CategoryDatabase, CategoryRecord } from './categories';

export interface SubcategoryRecord {
	id: string;
	categoryId: string;
	organizationId: string;
	name: string;
	description: string | null;
	active: boolean;
	createdAt: Date;
	updatedAt: Date;
}

export interface CategoryTreeRecord extends CategoryRecord {
	subcategories: SubcategoryRecord[];
}

export const SUBCATEGORY_NAME_MIN_LENGTH = 2;
export const SUBCATEGORY_NAME_MAX_LENGTH = 100;
export const SUBCATEGORY_DESCRIPTION_MAX_LENGTH = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateIds(...ids: string[]): void {
	for (const id of ids) {
		if (typeof id !== 'string' || !UUID.test(id)) {
			throw new IncidentServiceError('INVALID_INPUT', 'id must be a valid UUID');
		}
	}
}

const subcategoryColumns = {
	id: subcategories.id,
	categoryId: subcategories.categoryId,
	organizationId: subcategories.organizationId,
	name: subcategories.name,
	description: subcategories.description,
	active: subcategories.active,
	createdAt: subcategories.createdAt,
	updatedAt: subcategories.updatedAt
};

export function canonicalSubcategoryName(name: string): string {
	return name.trim().replace(/\s+/g, ' ');
}

export function normalizeSubcategoryName(name: string): string {
	return canonicalSubcategoryName(name).toLowerCase();
}

function validateSubcategoryName(name: unknown): string {
	if (typeof name !== 'string') {
		throw new IncidentServiceError('INVALID_INPUT', 'name must be a string');
	}
	const canonical = canonicalSubcategoryName(name);
	if (canonical.length < SUBCATEGORY_NAME_MIN_LENGTH) {
		throw new IncidentServiceError(
			'INVALID_INPUT',
			`name must have at least ${SUBCATEGORY_NAME_MIN_LENGTH} characters`
		);
	}
	if (canonical.length > SUBCATEGORY_NAME_MAX_LENGTH) {
		throw new IncidentServiceError(
			'INVALID_INPUT',
			`name must not exceed ${SUBCATEGORY_NAME_MAX_LENGTH} characters`
		);
	}
	if (canonical.includes('\u0000')) {
		throw new IncidentServiceError('INVALID_INPUT', 'name contains invalid characters');
	}
	return canonical;
}

function validateSubcategoryDescription(description: unknown): string | null {
	if (description === null) return null;
	if (typeof description !== 'string') {
		throw new IncidentServiceError('INVALID_INPUT', 'description must be a string or null');
	}
	const trimmed = description.trim();
	if (trimmed.length > SUBCATEGORY_DESCRIPTION_MAX_LENGTH) {
		throw new IncidentServiceError(
			'INVALID_INPUT',
			`description must not exceed ${SUBCATEGORY_DESCRIPTION_MAX_LENGTH} characters`
		);
	}
	if (trimmed.includes('\u0000')) {
		throw new IncidentServiceError('INVALID_INPUT', 'description contains invalid characters');
	}
	return trimmed.length === 0 ? null : trimmed;
}

function subcategoryNotFound(): IncidentServiceError {
	return new IncidentServiceError('SUBCATEGORY_NOT_FOUND', 'Subcategory not found');
}

function isDuplicateSubcategoryNameViolation(error: unknown): boolean {
	const candidates = [error, (error as { cause?: unknown })?.cause];
	return candidates.some((candidate) => {
		const { code, constraint, constraint_name } = (candidate ?? {}) as Record<string, unknown>;
		const name = constraint ?? constraint_name;
		return (
			code === '23505' &&
			(name === undefined ||
				name === 'subcategories_cat_normalized_name_unique_idx' ||
				name === 'subcategories_cat_name_unique')
		);
	});
}

async function inSubcategoryTransaction<T>(
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
		if (isDuplicateSubcategoryNameViolation(error)) {
			throw new IncidentServiceError(
				'SUBCATEGORY_NAME_DUPLICATE',
				'A subcategory with this name already exists in this category'
			);
		}
		throw error;
	}
}

async function lockOrganizationOperational(
	tx: CategoryDatabase,
	organizationId: string
): Promise<void> {
	const [org] = await tx
		.select({ status: organizations.status })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1)
		.for('share');
	if (!org) {
		throw new IncidentServiceError('ORGANIZATION_NOT_FOUND', 'Organization does not exist');
	}
	if (org.status !== 'active') {
		throw new IncidentServiceError(
			'ORGANIZATION_NOT_OPERATIONAL',
			`Organization is '${org.status}', operations require 'active'`
		);
	}
}

async function lockSubcategory(
	tx: CategoryDatabase,
	organizationId: string,
	subcategoryId: string
): Promise<SubcategoryRecord> {
	const [subcategory] = await tx
		.select(subcategoryColumns)
		.from(subcategories)
		.where(
			and(eq(subcategories.id, subcategoryId), eq(subcategories.organizationId, organizationId))
		)
		.limit(1)
		.for('update');
	if (!subcategory) throw subcategoryNotFound();
	return subcategory;
}

/**
 * Lists subcategories of an organization, optionally filtered by category and active status.
 * Deterministic ordering: name ASC, id ASC.
 */
export async function listSubcategories(
	db: CategoryDatabase,
	organizationId: string,
	options: { categoryId?: string; activeOnly?: boolean } = {}
): Promise<SubcategoryRecord[]> {
	validateIds(organizationId);
	if (options.categoryId) {
		validateIds(options.categoryId);
	}
	const conditions = [eq(subcategories.organizationId, organizationId)];
	if (options.categoryId) {
		conditions.push(eq(subcategories.categoryId, options.categoryId));
	}
	if (options.activeOnly) {
		conditions.push(eq(subcategories.active, true));
	}
	return boundedRows(
		db
			.select(subcategoryColumns)
			.from(subcategories)
			.where(and(...conditions))
			.orderBy(asc(subcategories.name), asc(subcategories.id))
	);
}

/**
 * Loads categories with their child subcategories in a single nested structure.
 */
export async function getCategoryTree(
	db: CategoryDatabase,
	organizationId: string,
	options: { activeOnly?: boolean } = {}
): Promise<CategoryTreeRecord[]> {
	validateIds(organizationId);
	const catConditions = [eq(categories.organizationId, organizationId)];
	if (options.activeOnly) {
		catConditions.push(eq(categories.active, true));
	}
	const catList = await boundedRows(
		db
			.select({
				id: categories.id,
				name: categories.name,
				description: categories.description,
				active: categories.active,
				createdAt: categories.createdAt,
				updatedAt: categories.updatedAt
			})
			.from(categories)
			.where(and(...catConditions))
			.orderBy(asc(categories.name), asc(categories.id))
	);

	const subList = await listSubcategories(db, organizationId, options);

	const subMap = new Map<string, SubcategoryRecord[]>();
	for (const sub of subList) {
		const list = subMap.get(sub.categoryId) ?? [];
		list.push(sub);
		subMap.set(sub.categoryId, list);
	}

	return catList.map((cat) => ({
		...cat,
		subcategories: subMap.get(cat.id) ?? []
	}));
}

/**
 * Creates a subcategory under a category within an organization.
 * Validates that parent category exists, belongs to tenant, and is active.
 */
export async function createSubcategory(
	dbOrTx: CategoryDatabase,
	organizationId: string,
	categoryId: string,
	input: { name: string; description?: string | null }
): Promise<SubcategoryRecord> {
	validateIds(organizationId, categoryId);
	const name = validateSubcategoryName(input.name);
	const description =
		input.description !== undefined ? validateSubcategoryDescription(input.description) : null;

	return inSubcategoryTransaction(dbOrTx, async (tx) => {
		await lockOrganizationOperational(tx, organizationId);

		const [cat] = await tx
			.select()
			.from(categories)
			.where(and(eq(categories.id, categoryId), eq(categories.organizationId, organizationId)))
			.limit(1)
			.for('share');
		if (!cat) {
			throw new IncidentServiceError('CATEGORY_NOT_FOUND', 'Category not found');
		}
		if (!cat.active) {
			throw new IncidentServiceError('CATEGORY_INACTIVE', 'Category is inactive');
		}

		const [inserted] = await tx
			.insert(subcategories)
			.values({
				organizationId,
				categoryId,
				name,
				description,
				active: true
			})
			.returning(subcategoryColumns);
		return inserted;
	});
}

/**
 * Updates a subcategory's name and/or description.
 */
export async function updateSubcategory(
	dbOrTx: CategoryDatabase,
	organizationId: string,
	subcategoryId: string,
	input: { name?: string; description?: string | null }
): Promise<SubcategoryRecord> {
	validateIds(organizationId, subcategoryId);
	if (input.name === undefined && input.description === undefined) {
		throw new IncidentServiceError(
			'INVALID_INPUT',
			'at least one of name or description is required'
		);
	}
	const hasName = input.name !== undefined;
	const hasDescription = input.description !== undefined;
	const name = hasName ? validateSubcategoryName(input.name) : undefined;
	const description = hasDescription
		? validateSubcategoryDescription(input.description)
		: undefined;

	return inSubcategoryTransaction(dbOrTx, async (tx) => {
		await lockOrganizationOperational(tx, organizationId);
		await lockSubcategory(tx, organizationId, subcategoryId);

		const values: Record<string, unknown> = { updatedAt: new Date() };
		if (hasName) {
			values.name = name!;
		}
		if (hasDescription) {
			values.description = description!;
		}

		const [updated] = await tx
			.update(subcategories)
			.set(values)
			.where(
				and(eq(subcategories.id, subcategoryId), eq(subcategories.organizationId, organizationId))
			)
			.returning(subcategoryColumns);
		return updated;
	});
}

/**
 * Activates or deactivates a subcategory.
 * Cannot activate if the parent category is inactive.
 */
export async function setSubcategoryActive(
	dbOrTx: CategoryDatabase,
	organizationId: string,
	subcategoryId: string,
	active: boolean
): Promise<SubcategoryRecord> {
	validateIds(organizationId, subcategoryId);
	if (typeof active !== 'boolean') {
		throw new IncidentServiceError('INVALID_INPUT', 'active must be a boolean');
	}

	return inSubcategoryTransaction(dbOrTx, async (tx) => {
		await lockOrganizationOperational(tx, organizationId);
		const current = await lockSubcategory(tx, organizationId, subcategoryId);

		if (current.active === active) {
			return current;
		}

		if (active) {
			const [cat] = await tx
				.select({ active: categories.active })
				.from(categories)
				.where(
					and(eq(categories.id, current.categoryId), eq(categories.organizationId, organizationId))
				)
				.limit(1)
				.for('share');
			if (!cat || !cat.active) {
				throw new IncidentServiceError(
					'CATEGORY_INACTIVE',
					'Cannot activate subcategory of an inactive category'
				);
			}
		}

		const [updated] = await tx
			.update(subcategories)
			.set({ active, updatedAt: new Date() })
			.where(
				and(eq(subcategories.id, subcategoryId), eq(subcategories.organizationId, organizationId))
			)
			.returning(subcategoryColumns);
		return updated;
	});
}

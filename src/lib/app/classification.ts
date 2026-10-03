/**
 * Classification choices (category + OPTIONAL subcategory of that category), shared by the
 * creation form and the category change of an existing incident. Pure TypeScript.
 *
 * Built from the category tree the page already loads for the active organization
 * (GET /api/categories?tree=true): no extra request, no parallel catalog. Only active entries
 * are offered (the server refuses inactive targets); `keep` re-adds the incident's CURRENT
 * category/subcategory when they became inactive, so an unchanged value is never silently lost.
 * A subcategory is only ever offered under its own category: picking another category drops a
 * subcategory that does not belong to it. The server stays the authority (same organization,
 * same category, active), whatever the UI sends.
 */

export interface ClassificationNode {
	readonly id: string;
	readonly name: string;
	/** Absent = active (a tree loaded with activeOnly). */
	readonly active?: boolean;
	readonly subcategories?: readonly ClassificationNode[];
}

export interface ChoiceOption {
	readonly value: string;
	readonly label: string;
}

export interface CategoryChoice extends ChoiceOption {
	/** Subcategories of THIS category only. */
	readonly subcategories: readonly ChoiceOption[];
}

export interface KeepClassification {
	readonly categoryId?: string | null;
	readonly subcategoryId?: string | null;
}

const byLabel = (a: ChoiceOption, b: ChoiceOption) => a.label.localeCompare(b.label, 'es');
const INACTIVE = ' (inactiva)';

export function classificationChoices(
	tree: readonly ClassificationNode[],
	keep: KeepClassification = {}
): CategoryChoice[] {
	const offered = (node: ClassificationNode, kept: string | null | undefined) =>
		node.active !== false || node.id === kept;
	const label = (node: ClassificationNode) =>
		node.active === false ? `${node.name}${INACTIVE}` : node.name;
	return tree
		.filter((category) => offered(category, keep.categoryId))
		.map((category) => ({
			value: category.id,
			label: label(category),
			subcategories: (category.subcategories ?? [])
				.filter((sub) => offered(sub, keep.subcategoryId))
				.map((sub) => ({ value: sub.id, label: label(sub) }))
				.sort(byLabel)
		}))
		.sort(byLabel);
}

/** A category choice as any catalog holds it (subcategories may be absent = none). */
export type CategoryLike = ChoiceOption & { readonly subcategories?: readonly ChoiceOption[] };

/** Subcategories selectable for `categoryId` ([] without a category or when it has none). */
export function subcategoryChoices(
	choices: readonly CategoryLike[],
	categoryId: string
): readonly ChoiceOption[] {
	if (!categoryId) return [];
	return choices.find((choice) => choice.value === categoryId)?.subcategories ?? [];
}

/** The subcategory to keep for `categoryId`: itself when it belongs to it, '' otherwise. */
export function reconcileSubcategory(
	choices: readonly CategoryLike[],
	categoryId: string,
	subcategoryId: string
): string {
	if (!subcategoryId) return '';
	return subcategoryChoices(choices, categoryId).some((sub) => sub.value === subcategoryId)
		? subcategoryId
		: '';
}

/**
 * Text under the subcategory select. It says WHY the select is disabled (never colour alone)
 * and that it depends on the category.
 */
export function subcategoryHint(categoryId: string, available: readonly ChoiceOption[]): string {
	if (!categoryId) return 'Elige primero una categoría.';
	if (available.length === 0) return 'Esta categoría no tiene subcategorías.';
	return 'Opcional. Solo se muestran las subcategorías de la categoría elegida.';
}

/** A classification as the API carries it. */
export interface Classification {
	readonly categoryId: string | null;
	readonly subcategoryId: string | null;
}

/**
 * Select values ('' = none) -> the classification to send: never a subcategory without its
 * category, and an explicit null for "Sin subcategoría".
 */
export function toClassification(categoryId: string, subcategoryId: string): Classification {
	return {
		categoryId: categoryId || null,
		subcategoryId: categoryId ? subcategoryId || null : null
	};
}

/** Whether `next` differs from the incident's current classification (either level). */
export function classificationChanged(current: Classification, next: Classification): boolean {
	return next.categoryId !== current.categoryId || next.subcategoryId !== current.subcategoryId;
}

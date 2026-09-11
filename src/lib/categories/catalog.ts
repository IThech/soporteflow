import type { IncidentCategory } from '$lib/types/category';
import type { SupportLevel, SupportLevelDefinition, SupportTeam } from '$lib/types/support';
import { normalizeLevelCode } from '$lib/support/levels-catalog';
import { initialCategories } from '$lib/data/categories';

export const CATEGORY_STORAGE_KEY = 'soporteflow-categories';

export type CategoryLoadResult =
	| { status: 'missing'; seededCategories: IncidentCategory[] }
	| { status: 'valid'; categories: IncidentCategory[] }
	| { status: 'corrupt'; error: string };

export function loadCategoriesResult(
	raw: string | null,
	seeds: IncidentCategory[] = initialCategories
): CategoryLoadResult {
	if (raw === null) {
		return {
			status: 'missing',
			seededCategories: seeds.map((category) => ({ ...category }))
		};
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (isCategoryList(parsed)) {
			const migrated = parsed.map((item) => {
				const seed = seeds.find((s) => s.id === item.id);
				return {
					...item,
					defaultSupportLevel:
						item.defaultSupportLevel !== undefined
							? item.defaultSupportLevel
							: (seed?.defaultSupportLevel ?? null),
					defaultTeamId:
						item.defaultTeamId !== undefined ? item.defaultTeamId : (seed?.defaultTeamId ?? null)
				};
			});
			return {
				status: 'valid',
				categories: migrated
			};
		}
		return {
			status: 'corrupt',
			error: 'El catálogo guardado no tiene un formato válido.'
		};
	} catch (err) {
		return {
			status: 'corrupt',
			error:
				err instanceof Error
					? `No se pudo parsear el catálogo de categorías: ${err.message}`
					: 'Error al cargar categorías guardadas.'
		};
	}
}

export function resolveCategoryRouting(category?: IncidentCategory | null): {
	categoryId?: string;
	supportLevel?: SupportLevel;
	teamId?: string;
} {
	if (!category) return {};
	return {
		categoryId: category.id,
		...(category.defaultSupportLevel?.trim()
			? { supportLevel: category.defaultSupportLevel.trim() }
			: {}),
		...(category.defaultTeamId?.trim() ? { teamId: category.defaultTeamId.trim() } : {})
	};
}

export function isCategory(item: unknown): item is IncidentCategory {
	if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
	const c = item as Record<string, unknown>;
	return (
		typeof c.id === 'string' &&
		c.id.trim().length > 0 &&
		typeof c.name === 'string' &&
		c.name.trim().length > 0 &&
		typeof c.description === 'string' &&
		typeof c.active === 'boolean' &&
		(c.organizationId === undefined || typeof c.organizationId === 'string') &&
		(c.defaultSupportLevel === undefined ||
			c.defaultSupportLevel === null ||
			(typeof c.defaultSupportLevel === 'string' && c.defaultSupportLevel.trim().length > 0)) &&
		(c.defaultTeamId === undefined ||
			c.defaultTeamId === null ||
			(typeof c.defaultTeamId === 'string' && c.defaultTeamId.trim().length > 0))
	);
}

export function isCategoryList(value: unknown): value is IncidentCategory[] {
	if (!Array.isArray(value)) return false;
	const ids = new Set<string>();
	return value.every((item) => {
		if (!isCategory(item)) return false;
		if (ids.has(item.id)) return false;
		ids.add(item.id);
		return true;
	});
}

export function validateCategoryRouting(
	input: { defaultSupportLevel?: string | null; defaultTeamId?: string | null },
	levels: SupportLevelDefinition[],
	teams: SupportTeam[],
	organizationId: string,
	original?: IncidentCategory
): { valid: boolean; error?: string } {
	const rawLevel = input.defaultSupportLevel?.trim() || null;
	const rawTeam = input.defaultTeamId?.trim() || null;

	if (rawLevel) {
		const normInput = normalizeLevelCode(rawLevel);
		const matched = levels.find(
			(l) => l.organizationId === organizationId && normalizeLevelCode(l.code) === normInput
		);
		if (!matched) {
			return {
				valid: false,
				error: 'El nivel de soporte predeterminado no pertenece a la organización o no existe.'
			};
		}
		const isOriginalLevel =
			original?.defaultSupportLevel &&
			normalizeLevelCode(original.defaultSupportLevel) === normInput;
		if (!matched.active && !isOriginalLevel) {
			return {
				valid: false,
				error:
					'No se puede seleccionar un nivel de soporte inactivo como nuevo destino predeterminado.'
			};
		}
	}

	if (rawTeam) {
		const matched = teams.find((t) => t.organizationId === organizationId && t.id === rawTeam);
		if (!matched) {
			return {
				valid: false,
				error: 'El equipo predeterminado no pertenece a la organización o no existe.'
			};
		}
		const isOriginalTeam = original?.defaultTeamId && original.defaultTeamId === rawTeam;
		if (!matched.active && !isOriginalTeam) {
			return {
				valid: false,
				error: 'No se puede seleccionar un equipo inactivo como nuevo destino predeterminado.'
			};
		}
	}

	return { valid: true };
}

import type { IncidentCategory } from '$lib/types/category';
import type {
	BaseCriticality,
	CalculatedPriority,
	CreateSubcategoryInput,
	Subcategory,
	SubcategoryLoadResult,
	SubcategoryOperationContext,
	UpdateSubcategoryInput
} from '$lib/types/classification';
import { generateId } from '$lib/utils/id';
import {
	isBaseCriticality,
	isCalculatedPriority,
	isSubcategory,
	VALID_BASE_CRITICALITIES,
	VALID_CALCULATED_PRIORITIES
} from './engine';
import { demoSubcategories } from '$lib/data/subcategories';

export const SUBCATEGORIES_STORAGE_KEY = 'soporteflow-subcategories';

/**
 * Normaliza un nombre de subcategoría para comprobaciones de unicidad insensible
 * a mayúsculas, acentos/diacríticos y espacios en blanco redundantes.
 */
export function normalizeSubcategoryName(name: string): string {
	return name
		.trim()
		.replace(/\s+/g, ' ')
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '');
}

/**
 * Genera la clave de unicidad para una subcategoría dentro de una categoría y organización.
 */
function subcategoryUniqueKey(organizationId: string, categoryId: string, name: string): string {
	return `${organizationId.trim()}:::${categoryId.trim()}:::${normalizeSubcategoryName(name)}`;
}

/**
 * Valida si una lista de elementos cumple rigurosamente con la interfaz Subcategory
 * y mantiene identificadores y nombres normalizados únicos por organización y categoría.
 */
export function isSubcategoryList(value: unknown): value is Subcategory[] {
	if (!Array.isArray(value)) return false;
	const ids = new Set<string>();
	const uniqueKeys = new Set<string>();

	return value.every((item) => {
		if (!isSubcategory(item)) return false;
		if (ids.has(item.id)) return false;
		ids.add(item.id);

		const key = subcategoryUniqueKey(item.organizationId, item.categoryId, item.name);
		if (uniqueKeys.has(key)) return false;
		uniqueKeys.add(key);

		return true;
	});
}

/**
 * Carga de forma segura el catálogo de subcategorías desde localStorage o JSON serializado.
 * Distingue explícitamente entre datos ausentes (`missing`), datos válidos (`valid`)
 * y datos corruptos o malformados (`corrupt`).
 */
export function loadSubcategoriesResult(raw: string | null): SubcategoryLoadResult {
	if (raw === null) {
		return {
			status: 'missing',
			subcategories: []
		};
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (isSubcategoryList(parsed)) {
			return {
				status: 'valid',
				subcategories: parsed
			};
		}
		return {
			status: 'corrupt',
			error: 'El catálogo de subcategorías guardado no tiene un formato válido.'
		};
	} catch (err) {
		return {
			status: 'corrupt',
			error:
				err instanceof Error
					? `No se pudo parsear el catálogo de subcategorías: ${err.message}`
					: 'Error al cargar subcategorías guardadas.'
		};
	}
}

export { demoSubcategories } from '$lib/data/subcategories';

export type SubcategoryInitResult =
	| { status: 'seeded'; subcategories: Subcategory[] }
	| { status: 'already_exists'; subcategories: Subcategory[] }
	| { status: 'corrupt'; error: string };

/**
 * Inicializa de forma segura el catálogo de subcategorías con las semillas demo de Nodhouses
 * si el almacenamiento está ausente (`missing`).
 *
 * REGLAS OBLIGATORIAS:
 * 1. Si el almacenamiento está ausente (`raw === null`), escribe las semillas demo en storage y devuelve status 'seeded'.
 * 2. Si el almacenamiento es válido (incluso si está vacío `[]`), NO sobrescribe y devuelve status 'already_exists'.
 * 3. Si el almacenamiento está corrupto, NO sobrescribe ni repara automáticamente y devuelve status 'corrupt'.
 */
export function initializeSubcategoriesCatalog(
	storage: {
		getItem: (key: string) => string | null;
		setItem: (key: string, value: string) => void;
	},
	seeds: Subcategory[] = demoSubcategories
): SubcategoryInitResult {
	const raw = storage.getItem(SUBCATEGORIES_STORAGE_KEY);
	if (raw === null) {
		if (!isSubcategoryList(seeds)) {
			throw new Error('Las semillas de subcategorías demo no tienen un formato válido.');
		}
		storage.setItem(SUBCATEGORIES_STORAGE_KEY, JSON.stringify(seeds));
		return {
			status: 'seeded',
			subcategories: seeds.map((s) => ({ ...s }))
		};
	}

	const loadRes = loadSubcategoriesResult(raw);
	if (loadRes.status === 'corrupt') {
		return {
			status: 'corrupt',
			error: loadRes.error
		};
	}

	return {
		status: 'already_exists',
		subcategories: loadRes.subcategories
	};
}

/**
 * Persiste el catálogo completo de subcategorías en storage de forma atómica.
 * Lanza errores controlados en caso de datos inválidos o fallos del almacenamiento.
 */
export function saveSubcategories(
	storage: { setItem: (key: string, value: string) => void },
	subcategories: Subcategory[]
): void {
	if (!isSubcategoryList(subcategories)) {
		throw new Error('La lista de subcategorías contiene elementos inválidos o nombres duplicados.');
	}

	try {
		storage.setItem(SUBCATEGORIES_STORAGE_KEY, JSON.stringify(subcategories));
	} catch (err) {
		throw new Error(
			err instanceof Error
				? `Fallo al persistir catálogo de subcategorías: ${err.message}`
				: 'Fallo al persistir catálogo de subcategorías.',
			{ cause: err }
		);
	}
}

/**
 * Crea una nueva subcategoría validando todas las reglas de negocio y restricciones de dominio.
 */
export function createSubcategory(
	subcategories: Subcategory[],
	input: CreateSubcategoryInput,
	categories: IncidentCategory[]
): Subcategory[] {
	if (!input || typeof input !== 'object') {
		throw new Error('Parámetros de subcategoría inválidos: se requiere un objeto de entrada.');
	}

	const orgId = typeof input.organizationId === 'string' ? input.organizationId.trim() : '';
	if (!orgId) {
		throw new Error('El identificador de organización es obligatorio.');
	}

	const categoryId = typeof input.categoryId === 'string' ? input.categoryId.trim() : '';
	if (!categoryId) {
		throw new Error('El identificador de categoría padre es obligatorio.');
	}

	// Validar existencia, aislamiento y estado de la categoría padre
	const parentCategory = categories.find((c) => c.id === categoryId);
	if (!parentCategory) {
		throw new Error('La categoría padre especificada no existe.');
	}
	if (parentCategory.organizationId && parentCategory.organizationId !== orgId) {
		throw new Error('La categoría padre no pertenece a la organización especificada.');
	}
	if (!parentCategory.active) {
		throw new Error('No se puede crear una subcategoría en una categoría padre inactiva.');
	}

	// Validar nombre
	const rawName = typeof input.name === 'string' ? input.name.trim() : '';
	if (rawName.length === 0) {
		throw new Error('El nombre de la subcategoría es obligatorio.');
	}
	const cleanName = rawName.replace(/\s+/g, ' ');

	// Validar unicidad normalizada dentro de la misma categoría y organización
	const incomingKey = subcategoryUniqueKey(orgId, categoryId, cleanName);
	const hasDuplicate = subcategories.some(
		(s) => subcategoryUniqueKey(s.organizationId, s.categoryId, s.name) === incomingKey
	);
	if (hasDuplicate) {
		throw new Error(
			`Ya existe una subcategoría con el nombre "${cleanName}" en esta categoría y organización.`
		);
	}

	// Validar criticidad base
	if (!isBaseCriticality(input.baseCriticality)) {
		throw new Error(
			`Criticidad base inválida: "${String(input.baseCriticality)}". Valores permitidos: ${VALID_BASE_CRITICALITIES.join(', ')}.`
		);
	}

	// Validar prioridad mínima (nullable)
	let minPriority: CalculatedPriority | null = null;
	if (input.minPriority !== undefined && input.minPriority !== null) {
		if (!isCalculatedPriority(input.minPriority)) {
			throw new Error(
				`Prioridad mínima inválida: "${String(input.minPriority)}". Valores permitidos: ${VALID_CALCULATED_PRIORITIES.join(', ')} o null.`
			);
		}
		minPriority = input.minPriority;
	}

	const newSubcategory: Subcategory = {
		id: typeof input.id === 'string' && input.id.trim().length > 0 ? input.id.trim() : generateId(),
		organizationId: orgId,
		categoryId,
		name: cleanName,
		baseCriticality: input.baseCriticality as BaseCriticality,
		minPriority,
		active: input.active ?? true
	};

	return [...subcategories, newSubcategory];
}

/**
 * Extrae y valida estrictamente el identificador de organización invocante desde el contexto.
 * El contexto es obligatorio y no puede ser nulo, indefinido ni estar en blanco.
 */
export function resolveCallingOrganizationId(
	context: SubcategoryOperationContext | string | null | undefined
): string {
	if (context === undefined || context === null) {
		throw new Error('El contexto de organización invocante es obligatorio.');
	}

	if (typeof context === 'string') {
		const trimmed = context.trim();
		if (trimmed.length === 0) {
			throw new Error('El identificador de organización en el contexto no puede estar vacío.');
		}
		return trimmed;
	}

	if (typeof context === 'object' && !Array.isArray(context)) {
		const orgIdVal = (context as { organizationId?: unknown }).organizationId;
		if (orgIdVal === undefined || orgIdVal === null) {
			throw new Error('El contexto de organización invocante es obligatorio.');
		}
		if (typeof orgIdVal !== 'string' || orgIdVal.trim().length === 0) {
			throw new Error('El identificador de organización en el contexto no puede estar vacío.');
		}
		return orgIdVal.trim();
	}

	throw new Error('El contexto de organización invocante es obligatorio.');
}

/**
 * Edita una subcategoría existente conservando inmutable su ID y relación organizacional.
 * El contexto de la organización invocante es obligatorio y no puede omitirse.
 */
export function updateSubcategory(
	subcategories: Subcategory[],
	input: UpdateSubcategoryInput,
	categories: IncidentCategory[],
	context: SubcategoryOperationContext | string
): Subcategory[] {
	if (!input || typeof input !== 'object') {
		throw new Error('Parámetros de edición inválidos: se requiere un objeto.');
	}

	const callingOrg = resolveCallingOrganizationId(context);

	const id = typeof input.id === 'string' ? input.id.trim() : '';
	if (!id) {
		throw new Error('El identificador de la subcategoría es obligatorio.');
	}

	const target = subcategories.find((s) => s.id === id);
	if (!target) {
		throw new Error('La subcategoría no existe.');
	}

	if (callingOrg !== target.organizationId) {
		throw new Error('No tienes permiso para modificar una subcategoría de otra organización.');
	}

	// Impedir alteración de la relación con la organización
	if (
		typeof input.organizationId === 'string' &&
		input.organizationId.trim().length > 0 &&
		input.organizationId.trim() !== target.organizationId
	) {
		throw new Error('No se permite transferir una subcategoría a otra organización.');
	}

	// Determinar categoría destino
	let nextCategoryId = target.categoryId;
	if (input.categoryId !== undefined) {
		const candidateCatId = input.categoryId.trim();
		if (!candidateCatId) {
			throw new Error('El identificador de categoría padre no puede estar vacío.');
		}
		const parentCategory = categories.find((c) => c.id === candidateCatId);
		if (!parentCategory) {
			throw new Error('La categoría padre especificada no existe.');
		}
		if (parentCategory.organizationId && parentCategory.organizationId !== target.organizationId) {
			throw new Error('La categoría padre no pertenece a la organización de la subcategoría.');
		}
		if (!parentCategory.active && candidateCatId !== target.categoryId) {
			throw new Error('No se puede transferir una subcategoría a una categoría padre inactiva.');
		}
		nextCategoryId = candidateCatId;
	}

	// Determinar nombre y verificar unicidad
	let nextName = target.name;
	if (input.name !== undefined) {
		const rawName = input.name.trim();
		if (rawName.length === 0) {
			throw new Error('El nombre de la subcategoría no puede estar vacío.');
		}
		nextName = rawName.replace(/\s+/g, ' ');
	}

	// Comprobar unicidad si cambiaron nombre o categoría
	const candidateKey = subcategoryUniqueKey(target.organizationId, nextCategoryId, nextName);
	const hasDuplicate = subcategories.some(
		(s) =>
			s.id !== target.id &&
			subcategoryUniqueKey(s.organizationId, s.categoryId, s.name) === candidateKey
	);
	if (hasDuplicate) {
		throw new Error(
			`Ya existe una subcategoría con el nombre "${nextName}" en esta categoría y organización.`
		);
	}

	// Determinar criticidad base
	let nextCriticality = target.baseCriticality;
	if (input.baseCriticality !== undefined) {
		if (!isBaseCriticality(input.baseCriticality)) {
			throw new Error(
				`Criticidad base inválida: "${String(input.baseCriticality)}". Valores permitidos: ${VALID_BASE_CRITICALITIES.join(', ')}.`
			);
		}
		nextCriticality = input.baseCriticality;
	}

	// Determinar prioridad mínima
	let nextMinPriority = target.minPriority;
	if (input.minPriority !== undefined) {
		if (input.minPriority !== null && !isCalculatedPriority(input.minPriority)) {
			throw new Error(
				`Prioridad mínima inválida: "${String(input.minPriority)}". Valores permitidos: ${VALID_CALCULATED_PRIORITIES.join(', ')} o null.`
			);
		}
		nextMinPriority = input.minPriority;
	}

	// Determinar estado activo
	let nextActive = target.active;
	if (input.active !== undefined) {
		if (typeof input.active !== 'boolean') {
			throw new Error('El estado activo debe ser un valor booleano.');
		}
		nextActive = input.active;
	}

	// Si la subcategoría queda o se reactiva en estado activo, validar categoría padre
	if (nextActive) {
		const parentCategory = categories.find((c) => c.id === nextCategoryId);
		if (!parentCategory) {
			throw new Error('La categoría padre especificada no existe.');
		}
		if (parentCategory.organizationId && parentCategory.organizationId !== target.organizationId) {
			throw new Error('La categoría padre no pertenece a la organización de la subcategoría.');
		}
		if (!parentCategory.active) {
			throw new Error('No se puede activar una subcategoría cuya categoría padre está inactiva.');
		}
	}

	const updated: Subcategory = {
		id: target.id,
		organizationId: target.organizationId,
		categoryId: nextCategoryId,
		name: nextName,
		baseCriticality: nextCriticality,
		minPriority: nextMinPriority,
		active: nextActive
	};

	return subcategories.map((s) => (s.id === id ? updated : s));
}

/**
 * Activa o desactiva una subcategoría de forma explícita.
 * Conserva el registro para consulta histórica sin borrado físico.
 *
 * Validaciones obligatorias:
 * 1. Contexto organizacional: OBLIGATORIO. Rechaza actuar sin contexto, con contexto vacío o
 *    sobre registros de otra empresa por ID.
 * 2. Reactivación: al activar (active: true), valida que la categoría padre exista, pertenezca
 *    a la organización y esté activa.
 */
export function setSubcategoryActive(
	subcategories: Subcategory[],
	id: string,
	active: boolean,
	context: SubcategoryOperationContext | string,
	categoriesArg?: IncidentCategory[]
): Subcategory[] {
	const callingOrg = resolveCallingOrganizationId(context);

	if (typeof active !== 'boolean') {
		throw new Error('El estado activo debe ser booleano.');
	}

	const target = subcategories.find((s) => s.id === id);
	if (!target) {
		throw new Error('La subcategoría no existe.');
	}

	if (callingOrg !== target.organizationId) {
		throw new Error('No tienes permiso para modificar una subcategoría de otra organización.');
	}

	const categoriesList =
		typeof context === 'object' && context !== null && 'categories' in context && context.categories
			? context.categories
			: categoriesArg;

	if (active && categoriesList) {
		const parent = categoriesList.find((c) => c.id === target.categoryId);
		if (!parent) {
			throw new Error('La categoría padre especificada no existe.');
		}
		if (parent.organizationId && parent.organizationId !== target.organizationId) {
			throw new Error('La categoría padre no pertenece a la organización de la subcategoría.');
		}
		if (!parent.active) {
			throw new Error('No se puede activar una subcategoría cuya categoría padre está inactiva.');
		}
	}

	return subcategories.map((s) => (s.id === id ? { ...s, active } : s));
}

/**
 * Invierte el estado activo de una subcategoría validando contexto organizacional obligatorio y categoría padre.
 */
export function toggleSubcategoryActive(
	subcategories: Subcategory[],
	id: string,
	context: SubcategoryOperationContext | string,
	categoriesArg?: IncidentCategory[]
): Subcategory[] {
	const callingOrg = resolveCallingOrganizationId(context);

	const target = subcategories.find((s) => s.id === id);
	if (!target) {
		throw new Error('La subcategoría no existe.');
	}

	if (callingOrg !== target.organizationId) {
		throw new Error('No tienes permiso para modificar una subcategoría de otra organización.');
	}

	return setSubcategoryActive(subcategories, id, !target.active, context, categoriesArg);
}

/**
 * Obtiene todas las subcategorías de una organización (activas e inactivas)
 * para consulta administrativa, auditoría o trazabilidad histórica.
 */
export function getOrganizationSubcategories(
	subcategories: Subcategory[],
	organizationId: string,
	categoryId?: string
): Subcategory[] {
	return subcategories.filter(
		(s) =>
			s.organizationId === organizationId &&
			(categoryId === undefined || s.categoryId === categoryId)
	);
}

/**
 * Filtra las subcategorías seleccionables para NUEVAS clasificaciones.
 * REGLAS DE NEGOCIO:
 * 1. La subcategoría debe pertenecer a la organización solicitada.
 * 2. La subcategoría debe estar activa (`active: true`).
 * 3. La categoría padre debe existir, pertenecer a la organización y estar ACTIVA.
 */
export function getAvailableSubcategories(
	subcategories: Subcategory[],
	categories: IncidentCategory[],
	organizationId: string,
	categoryId?: string
): Subcategory[] {
	return subcategories.filter((sub) => {
		if (sub.organizationId !== organizationId) return false;
		if (!sub.active) return false;
		if (categoryId !== undefined && sub.categoryId !== categoryId) return false;

		const parent = categories.find((c) => c.id === sub.categoryId);
		if (!parent) return false;
		if (parent.organizationId && parent.organizationId !== organizationId) return false;
		if (!parent.active) return false;

		return true;
	});
}

import type { IncidentPriority } from './incident';
import type { IncidentCategory } from './category';

/**
 * Nivel de impacto operativo (ascendente por alcance).
 * I1: Una persona (solo afecta al usuario solicitante).
 * I2: Varias personas.
 * I3: Equipo o departamento.
 * I4: Sede u organización completa.
 */
export type ImpactLevel = 'I1' | 'I2' | 'I3' | 'I4';

/**
 * Criticidad inherente a la subcategoría del servicio / activo.
 */
export type BaseCriticality = 'low' | 'medium' | 'high';

/**
 * Prioridad calculada por el motor V2.
 * Incorpora 'critical' como nivel máximo determinista.
 */
export type CalculatedPriority = 'low' | 'medium' | 'high' | 'critical';

/**
 * Subcategoría de soporte dentro de una categoría padre.
 */
export interface Subcategory {
	id: string;
	organizationId: string;
	categoryId: string;
	name: string;
	baseCriticality: BaseCriticality;
	minPriority: CalculatedPriority | null;
	active: boolean;
}

/**
 * Mapa bidimensional exhaustivo: (BaseCriticality, ImpactLevel) -> CalculatedPriority.
 */
export type PriorityMatrixMap = Record<BaseCriticality, Record<ImpactLevel, CalculatedPriority>>;

/**
 * Configuración de matriz de prioridad por organización.
 */
export interface PriorityMatrix {
	id?: string;
	organizationId: string;
	matrix: PriorityMatrixMap;
}

/**
 * Entrada para override manual de prioridad.
 *
 * FRONTERA DE SEGURIDAD:
 * El motor puro es determinista y no evalúa roles, sesiones ni contexto de usuario.
 * La capa de aplicación superior debe verificar los permisos antes de enviar este objeto,
 * certificando explícitamente `isAuthorized: true`.
 */
export interface ClassificationOverrideInput {
	targetPriority: CalculatedPriority;
	reason: string;
	isAuthorized: boolean;
	authorizedByUserId?: string;
}

/**
 * Snapshot inmutable explicativo con todas las variables evaluadas en la clasificación.
 */
export interface ClassificationSnapshot {
	baseCriticality: BaseCriticality;
	impactLevel: ImpactLevel;
	matrixPriority: CalculatedPriority;
	minPriority: CalculatedPriority | null;
	minPriorityApplied: boolean;
	calculatedPriority: CalculatedPriority;
	effectivePriority: CalculatedPriority;
	hasOverride: boolean;
	overrideReason?: string;
	overrideAuthorizedBy?: string;
}

/**
 * Resultado completo devuelto por el motor de clasificación puro.
 */
export interface ClassificationResult {
	calculatedPriority: CalculatedPriority;
	effectivePriority: CalculatedPriority;
	snapshot: ClassificationSnapshot;
	override: {
		targetPriority: CalculatedPriority;
		reason: string;
		authorizedByUserId?: string;
	} | null;
}

/**
 * Parámetros de entrada para el motor puro de clasificación.
 */
export interface ClassificationEngineInput {
	subcategory: Subcategory;
	impact: ImpactLevel;
	matrix: PriorityMatrix;
	override?: ClassificationOverrideInput | null;
}

/**
 * Tipo ampliado compatible para la integración con IncidentPriority.
 */
export type CompatibleIncidentPriority = IncidentPriority;

/**
 * Entrada para crear una nueva subcategoría.
 */
export interface CreateSubcategoryInput {
	id?: string;
	organizationId: string;
	categoryId: string;
	name: string;
	baseCriticality: BaseCriticality;
	minPriority?: CalculatedPriority | null;
	active?: boolean;
}

/**
 * Entrada para editar una subcategoría existente.
 * La organización es inmutable para preservar la integridad referencial.
 */
export interface UpdateSubcategoryInput {
	id: string;
	organizationId?: string;
	categoryId?: string;
	name?: string;
	baseCriticality?: BaseCriticality;
	minPriority?: CalculatedPriority | null;
	active?: boolean;
}

/**
 * Contexto obligatorio de organización invocante para operaciones de modificación y estado de subcategorías.
 */
export interface SubcategoryOperationContext {
	organizationId: string;
	categories?: IncidentCategory[];
}

/**
 * Alias para operaciones de estado (activar/desactivar).
 */
export type SubcategoryStatusContext = SubcategoryOperationContext;

/**
 * Resultado de la carga del catálogo persistido de subcategorías.
 */
export type SubcategoryLoadResult =
	| { status: 'missing'; subcategories: Subcategory[] }
	| { status: 'valid'; subcategories: Subcategory[] }
	| { status: 'corrupt'; error: string };

/**
 * Resultado de la resolución de matriz de prioridad para una organización.
 */
export type PriorityMatrixLoadResult =
	| { status: 'standard_fallback'; matrix: PriorityMatrix; isCustom: false }
	| { status: 'custom_valid'; matrix: PriorityMatrix; isCustom: true }
	| { status: 'corrupt'; error: string };

/**
 * Resultado de la carga del catálogo completo de matrices guardadas.
 */
export type PriorityMatricesCatalogLoadResult =
	| { status: 'missing'; matrices: PriorityMatrix[] }
	| { status: 'valid'; matrices: PriorityMatrix[] }
	| { status: 'corrupt'; error: string };

import type { IncidentPriority } from './incident';

/**
 * Nivel de impacto operativo (ITIL / Operaciones).
 * I1: Crítico / Incidencia generalizada o servicio esencial caído.
 * I2: Mayor / Departamento completo o servicio importante degradado.
 * I3: Moderado / Grupo de usuarios o degradación parcial.
 * I4: Menor / Usuario individual o incidencia cosmética / sin bloqueo.
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
 * Tipo ampliado compatible para la futura integración con IncidentPriority.
 */
export type CompatibleIncidentPriority = IncidentPriority | 'urgent';

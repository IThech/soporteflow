import type { IncidentPriority } from '../types/incident';
import type {
	BaseCriticality,
	CalculatedPriority,
	ClassificationEngineInput,
	ClassificationResult,
	ClassificationSnapshot,
	CompatibleIncidentPriority,
	ImpactLevel,
	PriorityMatrix,
	PriorityMatrixMap,
	Subcategory
} from '../types/classification';

/**
 * Niveles de impacto válidos en el sistema.
 */
export const VALID_IMPACT_LEVELS: readonly ImpactLevel[] = ['I1', 'I2', 'I3', 'I4'] as const;

/**
 * Niveles de criticidad base de subcategoría.
 */
export const VALID_BASE_CRITICALITIES: readonly BaseCriticality[] = [
	'low',
	'medium',
	'high'
] as const;

/**
 * Niveles de prioridad calculada por el motor V2.
 */
export const VALID_CALCULATED_PRIORITIES: readonly CalculatedPriority[] = [
	'low',
	'medium',
	'high',
	'critical'
] as const;

/**
 * Escala de rangos de prioridad calculada para comparaciones numéricas deterministas.
 */
export const CALCULATED_PRIORITY_RANK: Readonly<Record<CalculatedPriority, number>> = {
	low: 1,
	medium: 2,
	high: 3,
	critical: 4
} as const;

/**
 * Escala de rangos compatible para IncidentPriority (incluyendo 'urgent').
 */
export const COMPATIBLE_INCIDENT_PRIORITY_RANK: Readonly<
	Record<IncidentPriority | 'urgent', number>
> = {
	low: 1,
	medium: 2,
	high: 3,
	urgent: 4
} as const;

/**
 * Comprueba si un valor es un ImpactLevel válido.
 */
export function isImpactLevel(value: unknown): value is ImpactLevel {
	return typeof value === 'string' && VALID_IMPACT_LEVELS.includes(value as ImpactLevel);
}

/**
 * Comprueba si un valor es una BaseCriticality válida.
 */
export function isBaseCriticality(value: unknown): value is BaseCriticality {
	return typeof value === 'string' && VALID_BASE_CRITICALITIES.includes(value as BaseCriticality);
}

/**
 * Comprueba si un valor es una CalculatedPriority válida.
 */
export function isCalculatedPriority(value: unknown): value is CalculatedPriority {
	return (
		typeof value === 'string' && VALID_CALCULATED_PRIORITIES.includes(value as CalculatedPriority)
	);
}

/**
 * Comprueba si un objeto cumple con la interfaz Subcategory.
 */
export function isSubcategory(value: unknown): value is Subcategory {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;

	return (
		typeof candidate.id === 'string' &&
		candidate.id.trim().length > 0 &&
		typeof candidate.organizationId === 'string' &&
		candidate.organizationId.trim().length > 0 &&
		typeof candidate.categoryId === 'string' &&
		candidate.categoryId.trim().length > 0 &&
		typeof candidate.name === 'string' &&
		candidate.name.trim().length > 0 &&
		isBaseCriticality(candidate.baseCriticality) &&
		(candidate.minPriority === null || isCalculatedPriority(candidate.minPriority)) &&
		typeof candidate.active === 'boolean'
	);
}

/**
 * Valida la exhaustividad y consistencia de una matriz de prioridades.
 * Lanza un Error descriptivo si la matriz está incompleta o tiene valores inválidos.
 */
export function validatePriorityMatrix(matrix: unknown): asserts matrix is PriorityMatrix {
	if (!matrix || typeof matrix !== 'object') {
		throw new Error('Matriz de prioridades inválida: se requiere un objeto.');
	}

	const candidate = matrix as Record<string, unknown>;
	if (
		typeof candidate.organizationId !== 'string' ||
		candidate.organizationId.trim().length === 0
	) {
		throw new Error('Matriz de prioridades inválida: falta el identificador de organización.');
	}

	const rules = candidate.matrix as Record<string, unknown> | undefined;
	if (!rules || typeof rules !== 'object') {
		throw new Error('Matriz de prioridades inválida: falta el mapa bidimensional de reglas.');
	}

	for (const crit of VALID_BASE_CRITICALITIES) {
		const impactRow = rules[crit] as Record<string, unknown> | undefined;
		if (!impactRow || typeof impactRow !== 'object') {
			throw new Error(`Matriz de prioridades incompleta: falta la fila para criticidad "${crit}".`);
		}

		for (const impact of VALID_IMPACT_LEVELS) {
			const priorityValue = impactRow[impact];
			if (!isCalculatedPriority(priorityValue)) {
				throw new Error(
					`Matriz de prioridades incompleta o inválida: falta o es incorrecta la combinación para criticidad "${crit}" e impacto "${impact}".`
				);
			}
		}
	}
}

/**
 * Genera una matriz de prioridades estándar ITIL para una organización.
 */
export function createStandardPriorityMatrix(organizationId: string): PriorityMatrix {
	if (!organizationId || typeof organizationId !== 'string' || organizationId.trim().length === 0) {
		throw new Error('organizationId no puede estar vacío.');
	}

	const matrix: PriorityMatrixMap = {
		high: {
			I1: 'low',
			I2: 'medium',
			I3: 'high',
			I4: 'critical'
		},
		medium: {
			I1: 'low',
			I2: 'low',
			I3: 'medium',
			I4: 'high'
		},
		low: {
			I1: 'low',
			I2: 'low',
			I3: 'low',
			I4: 'medium'
		}
	};

	return {
		organizationId: organizationId.trim(),
		matrix
	};
}

/**
 * Compara dos prioridades calculadas numéricamente según su severidad.
 * Retorna > 0 si a > b, < 0 si a < b, y 0 si son equivalentes.
 */
export function compareCalculatedPriorities(a: CalculatedPriority, b: CalculatedPriority): number {
	return CALCULATED_PRIORITY_RANK[a] - CALCULATED_PRIORITY_RANK[b];
}

/**
 * Devuelve la prioridad de mayor severidad entre dos opciones.
 */
export function maxCalculatedPriority(
	a: CalculatedPriority,
	b: CalculatedPriority
): CalculatedPriority {
	return CALCULATED_PRIORITY_RANK[a] >= CALCULATED_PRIORITY_RANK[b] ? a : b;
}

/**
 * Mapeo explícito y bidireccional entre CalculatedPriority (V2) e IncidentPriority (V1 / compatible).
 * 'critical' se asigna estrictamente a 'urgent'.
 * En ningún caso se permite la conversión silenciosa de 'critical' a 'high'.
 */
export function toIncidentPriority(priority: CalculatedPriority): CompatibleIncidentPriority {
	if (priority === 'critical') return 'urgent';
	return priority;
}

/**
 * Mapeo inverso de IncidentPriority (o compatible con 'urgent') hacia CalculatedPriority (V2).
 * 'urgent' se mapea unívocamente a 'critical'.
 */
export function toCalculatedPriority(priority: IncidentPriority | 'urgent'): CalculatedPriority {
	if (priority === 'urgent') return 'critical';
	return priority;
}

/**
 * MOTOR PURO DE CLASIFICACIÓN V2
 *
 * Función puramente matemática y determinista.
 *
 * FRONTERA DE SEGURIDAD:
 * El motor no accede a base de datos, sesiones ni roles de usuario.
 * NO concede permisos ni evalúa autorización por sí mismo.
 * Exige una precondición explícita de autorización (`override.isAuthorized === true`)
 * que debe ser evaluada y garantizada por la capa de aplicación superior.
 *
 * Secuencia:
 * 1. Validar entradas y congruencia organizacional.
 * 2. Obtener criticidad base de la subcategoría.
 * 3. Consultar la matriz de prioridad de la organización.
 * 4. Aplicar prioridad mínima de la subcategoría si corresponde.
 * 5. Obtener prioridad calculada.
 * 6. Aplicar override autorizado con motivo válido, si existe.
 * 7. Devolver resultado determinista y snapshot explicativo.
 */
export function classifyIncident(input: ClassificationEngineInput): ClassificationResult {
	// 1. Validar entradas
	if (!input || typeof input !== 'object') {
		throw new Error('Parámetros de clasificación inválidos: se requiere un objeto de entrada.');
	}

	const { subcategory, impact, matrix, override } = input;

	// Validar subcategoría
	if (!subcategory || typeof subcategory !== 'object') {
		throw new Error('Subcategoría requerida para la clasificación.');
	}
	if (typeof subcategory.id !== 'string' || subcategory.id.trim().length === 0) {
		throw new Error('Subcategoría inválida: falta el identificador.');
	}
	if (
		typeof subcategory.organizationId !== 'string' ||
		subcategory.organizationId.trim().length === 0
	) {
		throw new Error('Subcategoría inválida: falta el identificador de organización.');
	}
	if (typeof subcategory.categoryId !== 'string' || subcategory.categoryId.trim().length === 0) {
		throw new Error('Subcategoría inválida: falta el identificador de categoría.');
	}
	if (typeof subcategory.name !== 'string' || subcategory.name.trim().length === 0) {
		throw new Error('Subcategoría inválida: falta el nombre.');
	}
	if (subcategory.active !== true) {
		throw new Error('No se puede clasificar con una subcategoría inactiva.');
	}
	if (!isBaseCriticality(subcategory.baseCriticality)) {
		throw new Error(
			`Criticidad base inválida: "${String(subcategory.baseCriticality)}". Valores permitidos: ${VALID_BASE_CRITICALITIES.join(', ')}.`
		);
	}
	if (
		subcategory.minPriority !== null &&
		subcategory.minPriority !== undefined &&
		!isCalculatedPriority(subcategory.minPriority)
	) {
		throw new Error(
			`Prioridad mínima inválida: "${String(subcategory.minPriority)}". Valores permitidos: ${VALID_CALCULATED_PRIORITIES.join(', ')} o null.`
		);
	}

	// Validar impacto
	if (!isImpactLevel(impact)) {
		throw new Error(
			`Impacto inválido: "${String(impact)}". Valores permitidos: ${VALID_IMPACT_LEVELS.join(', ')}.`
		);
	}

	// Validar matriz
	validatePriorityMatrix(matrix);

	// Aislamiento / Incoherencia de configuración por organización
	if (subcategory.organizationId.trim() !== matrix.organizationId.trim()) {
		throw new Error(
			`Incoherencia organizacional: la subcategoría pertenece a la organización "${subcategory.organizationId}", pero la matriz pertenece a "${matrix.organizationId}".`
		);
	}

	// 2. Obtener criticidad base
	const baseCriticality = subcategory.baseCriticality;

	// 3. Consultar matriz
	const matrixPriority = matrix.matrix[baseCriticality][impact];

	// 4. Aplicar prioridad mínima
	const minPriority = subcategory.minPriority ?? null;
	let calculatedPriority: CalculatedPriority = matrixPriority;
	let minPriorityApplied = false;

	if (minPriority !== null) {
		if (CALCULATED_PRIORITY_RANK[minPriority] > CALCULATED_PRIORITY_RANK[matrixPriority]) {
			calculatedPriority = minPriority;
			minPriorityApplied = true;
		}
	}

	// 5. Obtener prioridad calculada: ya almacenada en `calculatedPriority`

	// 6. Aplicar override válido, si existe
	let effectivePriority: CalculatedPriority = calculatedPriority;
	let hasOverride = false;
	let overrideRecord: ClassificationResult['override'] = null;

	if (override !== null && override !== undefined) {
		if (typeof override !== 'object') {
			throw new Error('El override debe ser un objeto válido.');
		}

		// Validar prioridad destino
		if (!isCalculatedPriority(override.targetPriority)) {
			throw new Error(
				`Prioridad de override inválida: "${String(override.targetPriority)}". Valores permitidos: ${VALID_CALCULATED_PRIORITIES.join(', ')}.`
			);
		}

		// Validar motivo
		const reason = typeof override.reason === 'string' ? override.reason.trim() : '';
		if (reason.length === 0) {
			throw new Error('El override de prioridad requiere un motivo justificado no vacío.');
		}

		// Validar precondición de autorización (frontera de seguridad)
		if (override.isAuthorized !== true) {
			throw new Error(
				'Override no autorizado: se requiere una precondición explícita de autorización por la capa de aplicación.'
			);
		}

		hasOverride = true;
		effectivePriority = override.targetPriority;
		overrideRecord = {
			targetPriority: override.targetPriority,
			reason,
			...(typeof override.authorizedByUserId === 'string' &&
			override.authorizedByUserId.trim().length > 0
				? { authorizedByUserId: override.authorizedByUserId.trim() }
				: {})
		};
	}

	// 7. Devolver resultado y snapshot explicativo
	const snapshot: ClassificationSnapshot = {
		baseCriticality,
		impactLevel: impact,
		matrixPriority,
		minPriority,
		minPriorityApplied,
		calculatedPriority,
		effectivePriority,
		hasOverride,
		...(hasOverride && overrideRecord
			? {
					overrideReason: overrideRecord.reason,
					...(overrideRecord.authorizedByUserId
						? { overrideAuthorizedBy: overrideRecord.authorizedByUserId }
						: {})
				}
			: {})
	};

	return {
		calculatedPriority,
		effectivePriority,
		snapshot,
		override: overrideRecord
	};
}

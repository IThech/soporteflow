import type {
	PriorityMatricesCatalogLoadResult,
	PriorityMatrix,
	PriorityMatrixLoadResult
} from '$lib/types/classification';
import { createStandardPriorityMatrix, validatePriorityMatrix } from './engine';

export const PRIORITY_MATRICES_STORAGE_KEY = 'soporteflow-priority-matrices';

/**
 * Valida si un valor es una lista coherente de matrices de prioridad organizacionales,
 * garantizando que cada entrada es válida y que cada organización tiene a lo sumo una matriz.
 */
export function isPriorityMatrixList(value: unknown): value is PriorityMatrix[] {
	if (!Array.isArray(value)) return false;
	const orgIds = new Set<string>();

	return value.every((item) => {
		try {
			validatePriorityMatrix(item);
		} catch {
			return false;
		}

		if (orgIds.has(item.organizationId)) return false;
		orgIds.add(item.organizationId);

		return true;
	});
}

/**
 * Carga segura del catálogo completo de matrices serializadas.
 */
export function loadPriorityMatricesResult(raw: string | null): PriorityMatricesCatalogLoadResult {
	if (raw === null) {
		return {
			status: 'missing',
			matrices: []
		};
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (isPriorityMatrixList(parsed)) {
			return {
				status: 'valid',
				matrices: parsed
			};
		}
		return {
			status: 'corrupt',
			error: 'El catálogo de matrices guardado no tiene un formato válido.'
		};
	} catch (err) {
		return {
			status: 'corrupt',
			error:
				err instanceof Error
					? `No se pudo parsear el catálogo de matrices: ${err.message}`
					: 'Error al cargar matrices guardadas.'
		};
	}
}

/**
 * Resuelve la matriz de prioridad para una organización evaluando las tres situaciones requeridas:
 * A. No existe configuración: estándar como fallback en memoria (sin auto-escribir).
 * B. Existe matriz personalizada válida: se utiliza.
 * C. Existe configuración corrupta o inválida: devuelve error controlado SIN sobrescribir ni sustituir silenciosamente.
 */
export function resolveOrganizationMatrix(
	matrices: PriorityMatrix[] | null | undefined,
	organizationId: string
): PriorityMatrixLoadResult {
	const orgId = typeof organizationId === 'string' ? organizationId.trim() : '';
	if (!orgId) {
		throw new Error('El identificador de organización es obligatorio.');
	}

	if (!matrices || !Array.isArray(matrices) || matrices.length === 0) {
		return {
			status: 'standard_fallback',
			matrix: createStandardPriorityMatrix(orgId),
			isCustom: false
		};
	}

	const matches = matrices.filter((m) => m && typeof m === 'object' && m.organizationId === orgId);

	if (matches.length === 0) {
		return {
			status: 'standard_fallback',
			matrix: createStandardPriorityMatrix(orgId),
			isCustom: false
		};
	}

	if (matches.length > 1) {
		return {
			status: 'corrupt',
			error: `Configuración inválida: existen múltiples matrices para la organización "${orgId}".`
		};
	}

	const candidate = matches[0];
	try {
		validatePriorityMatrix(candidate);
		return {
			status: 'custom_valid',
			matrix: candidate,
			isCustom: true
		};
	} catch (err) {
		return {
			status: 'corrupt',
			error:
				err instanceof Error
					? `La matriz personalizada para la organización "${orgId}" es inválida: ${err.message}`
					: `La matriz personalizada para la organización "${orgId}" es inválida.`
		};
	}
}

/**
 * Consulta la matriz de prioridad de una organización directamente desde el almacenamiento.
 * Maneja excepciones de lectura y nunca sustituye datos corruptos por la matriz estándar.
 */
export function getOrganizationPriorityMatrixResult(
	storage: { getItem: (key: string) => string | null },
	organizationId: string
): PriorityMatrixLoadResult {
	const orgId = typeof organizationId === 'string' ? organizationId.trim() : '';
	if (!orgId) {
		throw new Error('El identificador de organización es obligatorio.');
	}

	let raw: string | null;
	try {
		raw = storage.getItem(PRIORITY_MATRICES_STORAGE_KEY);
	} catch (err) {
		return {
			status: 'corrupt',
			error:
				err instanceof Error
					? `Error de lectura en almacenamiento: ${err.message}`
					: 'Error de lectura en almacenamiento.'
		};
	}

	if (raw === null) {
		return {
			status: 'standard_fallback',
			matrix: createStandardPriorityMatrix(orgId),
			isCustom: false
		};
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return {
				status: 'corrupt',
				error: 'El catálogo de matrices guardado no tiene formato de lista.'
			};
		}

		const matches = parsed.filter(
			(item): item is Record<string, unknown> =>
				!!item &&
				typeof item === 'object' &&
				(item as Record<string, unknown>).organizationId === orgId
		);

		if (matches.length > 1) {
			return {
				status: 'corrupt',
				error: `Existen múltiples matrices guardadas para la organización "${orgId}".`
			};
		}

		if (matches.length === 1) {
			const candidate = matches[0];
			try {
				validatePriorityMatrix(candidate);
				return {
					status: 'custom_valid',
					matrix: candidate,
					isCustom: true
				};
			} catch (err) {
				return {
					status: 'corrupt',
					error:
						err instanceof Error
							? `La matriz guardada para la organización "${orgId}" está corrupta o incompleta: ${err.message}`
							: `La matriz guardada para la organización "${orgId}" está corrupta o incompleta.`
				};
			}
		}

		// La organización no tiene matriz guardada en el catálogo
		return {
			status: 'standard_fallback',
			matrix: createStandardPriorityMatrix(orgId),
			isCustom: false
		};
	} catch (err) {
		return {
			status: 'corrupt',
			error:
				err instanceof Error
					? `No se pudo parsear el catálogo de matrices: ${err.message}`
					: 'Error al parsear matrices guardadas.'
		};
	}
}

/**
 * Guarda el catálogo completo de matrices en almacenamiento de forma atómica y segura.
 */
export function savePriorityMatrices(
	storage: { setItem: (key: string, value: string) => void },
	matrices: PriorityMatrix[]
): void {
	if (!isPriorityMatrixList(matrices)) {
		throw new Error(
			'El catálogo de matrices contiene elementos incompletos o configuraciones duplicadas por organización.'
		);
	}

	try {
		storage.setItem(PRIORITY_MATRICES_STORAGE_KEY, JSON.stringify(matrices));
	} catch (err) {
		throw new Error(
			err instanceof Error
				? `Fallo al persistir catálogo de matrices: ${err.message}`
				: 'Fallo al persistir catálogo de matrices.',
			{ cause: err }
		);
	}
}

/**
 * Asigna o reemplaza la matriz personalizada de una organización manteniendo intactas
 * todas las configuraciones de otras organizaciones.
 */
export function setOrganizationMatrix(
	matrices: PriorityMatrix[],
	matrix: PriorityMatrix
): PriorityMatrix[] {
	validatePriorityMatrix(matrix);

	const filtered = matrices.filter((m) => m.organizationId !== matrix.organizationId);
	return [...filtered, matrix];
}

/**
 * Elimina la configuración personalizada de una organización para retornar al fallback estándar,
 * preservando intactas las matrices de las demás organizaciones.
 */
export function removeOrganizationMatrix(
	matrices: PriorityMatrix[],
	organizationId: string
): PriorityMatrix[] {
	const orgId = organizationId.trim();
	return matrices.filter((m) => m.organizationId !== orgId);
}

/**
 * Persiste la matriz de una organización asegurando que no se sobrescriban datos si el storage
 * estuviera corrupto y manteniendo el aislamiento estricto entre organizaciones.
 */
export function saveOrganizationPriorityMatrix(
	storage: {
		getItem: (key: string) => string | null;
		setItem: (key: string, value: string) => void;
	},
	matrix: PriorityMatrix
): PriorityMatrix[] {
	validatePriorityMatrix(matrix);

	const raw = storage.getItem(PRIORITY_MATRICES_STORAGE_KEY);
	let currentMatrices: PriorityMatrix[] = [];

	if (raw !== null) {
		const loadRes = loadPriorityMatricesResult(raw);
		if (loadRes.status === 'corrupt') {
			throw new Error(
				'No se puede guardar: el catálogo de matrices en almacenamiento contiene datos corruptos. Corrija los datos antes de continuar.'
			);
		}
		currentMatrices = loadRes.matrices;
	}

	const updated = setOrganizationMatrix(currentMatrices, matrix);
	savePriorityMatrices(storage, updated);
	return updated;
}

/**
 * SoporteFlow — Coordinación y Persistencia del Cierre Automático (Demo / localStorage)
 *
 * Coordina la evaluación determinista de incidencias resueltas (>= 24h) y su persistencia
 * atómica en INCIDENTS_KEY e HISTORY_KEY mediante commitAssignment.
 *
 * Garantías:
 * 1. No muta el estado reactivo en memoria hasta confirmar la persistencia.
 * 2. Valida la ausencia de diarios pendientes antes de cualquier escritura.
 * 3. Gestiona conflictos entre pestañas validando los datos antes de actualizar memoria o snapshots.
 * 4. Bloquea escrituras y emite errores explícitos ante datos corruptos o recuperaciones pendientes.
 * 5. Idempotente y determinista.
 */

import {
	INCIDENTS_KEY,
	HISTORY_KEY,
	RECOVERY_KEY as ASSIGNMENT_RECOVERY_KEY,
	TRANSITION_RECOVERY_KEY,
	commitAssignment
} from './assignment';
import { FIRST_RESPONSE_RECOVERY_KEY } from './first-response';
import { isIncidentList } from '$lib/incidents/validation';
import { isIncidentHistory } from '$lib/incidents/history';
import { synchronizeIncidentClosures } from '$lib/incidents/closure';
import type { Incident } from '$lib/types/incident';
import type { IncidentHistoryEntry } from '$lib/types/incident-history';

type LocalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface AutoCloseState {
	incidents: Incident[];
	history: IncidentHistoryEntry[];
	incidentsSnapshot: string | null;
	historySnapshot: string | null;
}

export interface AutoCloseSyncResult {
	changed: boolean;
	status: 'unchanged' | 'committed' | 'conflict_resolved';
	state: AutoCloseState;
	closedIncidentIds: number[];
}

/**
 * Comprueba si existe algún diario de recuperación pendiente en el almacenamiento.
 */
export function hasPendingRecoveryJournal(storage: Pick<Storage, 'getItem'>): boolean {
	return (
		storage.getItem(ASSIGNMENT_RECOVERY_KEY) !== null ||
		storage.getItem(TRANSITION_RECOVERY_KEY) !== null ||
		storage.getItem(FIRST_RESPONSE_RECOVERY_KEY) !== null
	);
}

/**
 * Coordina la sincronización de cierre automático y su persistencia segura.
 */
export function syncAndCommitAutoClosures(
	storage: LocalStore,
	currentIncidents: Incident[],
	currentHistory: IncidentHistoryEntry[],
	expectedIncidentsRaw: string | null,
	expectedHistoryRaw: string | null,
	now: Date | string | number = new Date()
): AutoCloseSyncResult {
	// 1. Bloquear si hay algún diario de recuperación pendiente en cualquier subsistema
	if (hasPendingRecoveryJournal(storage)) {
		throw new Error(
			'Hay una operación de recuperación pendiente en el almacenamiento. Se ha bloqueado el cierre automático.'
		);
	}

	const storedIncidentsRaw = storage.getItem(INCIDENTS_KEY);
	const storedHistoryRaw = storage.getItem(HISTORY_KEY);

	// 2. Detección de conflicto con otra pestaña (almacenamiento diverge de los snapshots locales)
	const isConflict =
		storedIncidentsRaw !== expectedIncidentsRaw || storedHistoryRaw !== expectedHistoryRaw;

	let baseIncidents = currentIncidents;
	let baseHistory = currentHistory;
	let baseIncidentsSnapshot = expectedIncidentsRaw;
	let baseHistorySnapshot = expectedHistoryRaw;

	if (isConflict) {
		// Validar estrictamente los datos almacenados por la otra pestaña antes de adoptarlos
		let parsedIncidents: Incident[];
		let parsedHistory: IncidentHistoryEntry[];

		try {
			const parsedI: unknown = storedIncidentsRaw === null ? [] : JSON.parse(storedIncidentsRaw);
			if (!isIncidentList(parsedI)) throw new Error();
			parsedIncidents = parsedI;

			const parsedH: unknown = storedHistoryRaw === null ? [] : JSON.parse(storedHistoryRaw);
			if (!isIncidentHistory(parsedH)) throw new Error();
			parsedHistory = parsedH;
		} catch {
			throw new Error(
				'Los datos de incidencias o historial en el almacenamiento no son válidos. Se ha bloqueado el cierre automático.'
			);
		}

		baseIncidents = parsedIncidents;
		baseHistory = parsedHistory;
		baseIncidentsSnapshot = storedIncidentsRaw;
		baseHistorySnapshot = storedHistoryRaw;
	}

	// 3. Evaluar reglas de dominio deterministas de cierre (24h de inactividad)
	const sync = synchronizeIncidentClosures(baseIncidents, baseHistory, now);

	// Caso A: No hay incidencias que cerrar
	if (!sync.changed) {
		if (isConflict) {
			// El conflicto se resolvió adoptando los datos frescos válidos (ej. la otra pestaña ya cerró)
			return {
				changed: true,
				status: 'conflict_resolved',
				state: {
					incidents: baseIncidents,
					history: baseHistory,
					incidentsSnapshot: baseIncidentsSnapshot,
					historySnapshot: baseHistorySnapshot
				},
				closedIncidentIds: []
			};
		}

		return {
			changed: false,
			status: 'unchanged',
			state: {
				incidents: currentIncidents,
				history: currentHistory,
				incidentsSnapshot: expectedIncidentsRaw,
				historySnapshot: expectedHistoryRaw
			},
			closedIncidentIds: []
		};
	}

	// Caso B: Hay incidencias que cerrar -> persistir de forma atómica antes de actualizar memoria
	const nextHistory = [...baseHistory, ...sync.newHistoryEntries];
	const closedIncidentIds = sync.newHistoryEntries.map((e) => e.incidentId);

	commitAssignment(
		storage,
		sync.updatedIncidents,
		nextHistory,
		baseIncidentsSnapshot,
		baseHistorySnapshot
	);

	const nextIncidentsSnapshot = JSON.stringify(sync.updatedIncidents);
	const nextHistorySnapshot = JSON.stringify(nextHistory);

	return {
		changed: true,
		status: 'committed',
		state: {
			incidents: sync.updatedIncidents,
			history: nextHistory,
			incidentsSnapshot: nextIncidentsSnapshot,
			historySnapshot: nextHistorySnapshot
		},
		closedIncidentIds
	};
}

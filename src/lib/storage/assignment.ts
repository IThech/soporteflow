import { isIncidentList } from '$lib/incidents/validation';
import { isIncidentHistory } from '$lib/incidents/history';
import type { Incident } from '$lib/types/incident';
import type { IncidentHistoryEntry } from '$lib/types/incident-history';

export const INCIDENTS_KEY = 'soporteflow-incidents';
export const HISTORY_KEY = 'soporteflow-incident-history';
export const RECOVERY_KEY = 'soporteflow-assignment-recovery';
type LocalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function loadHistory(raw: string | null): IncidentHistoryEntry[] {
	const parsed: unknown = raw === null ? [] : JSON.parse(raw);
	if (!isIncidentHistory(parsed))
		throw new Error('El historial guardado no tiene un formato válido.');
	return parsed;
}

// The journal contains the exact previous values. Removing it is the commit point.
// Interrupted/failed writes roll back on the next load before any editing is enabled.
export function recoverAssignment(storage: LocalStore): void {
	const raw = storage.getItem(RECOVERY_KEY);
	if (raw === null) return;
	const journal = JSON.parse(raw);
	if (
		!journal ||
		journal.version !== 1 ||
		!(
			journal.incidents === null ||
			(typeof journal.incidents === 'string' && isIncidentList(JSON.parse(journal.incidents)))
		) ||
		!(
			journal.history === null ||
			(typeof journal.history === 'string' && isIncidentHistory(JSON.parse(journal.history)))
		)
	) {
		throw new Error('No se pudo validar la copia de recuperación. Los datos se han conservado.');
	}
	for (const [key, value] of [
		[INCIDENTS_KEY, journal.incidents],
		[HISTORY_KEY, journal.history]
	] as const) {
		if (value === null) storage.removeItem(key);
		else storage.setItem(key, value);
	}
	storage.removeItem(RECOVERY_KEY);
}

export function commitAssignment(
	storage: LocalStore,
	incidents: Incident[],
	history: IncidentHistoryEntry[],
	expectedIncidents: string | null,
	expectedHistory: string | null
): void {
	if (storage.getItem(RECOVERY_KEY) !== null)
		throw new Error('Hay una operación pendiente de recuperación. Recarga antes de continuar.');
	if (
		storage.getItem(INCIDENTS_KEY) !== expectedIncidents ||
		storage.getItem(HISTORY_KEY) !== expectedHistory
	)
		throw new Error('Los datos han cambiado en otra pestaña. Recarga antes de continuar.');
	if (!isIncidentList(incidents) || !isIncidentHistory(history))
		throw new Error('No se pueden guardar datos inválidos.');
	storage.setItem(
		RECOVERY_KEY,
		JSON.stringify({ version: 1, incidents: expectedIncidents, history: expectedHistory })
	);
	try {
		storage.setItem(INCIDENTS_KEY, JSON.stringify(incidents));
		storage.setItem(HISTORY_KEY, JSON.stringify(history));
		storage.removeItem(RECOVERY_KEY);
	} catch {
		try {
			recoverAssignment(storage);
		} catch {
			throw new Error(
				'Guardado interrumpido. La copia de recuperación se conserva; recarga antes de continuar.'
			);
		}
		throw new Error(
			'No se pudo guardar la asignación. Se han conservado la incidencia y el historial anteriores.'
		);
	}
}

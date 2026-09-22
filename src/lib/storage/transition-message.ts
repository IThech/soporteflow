/**
 * SoporteFlow — Persistencia Coordinada de Transición con Mensaje (Demo / localStorage)
 *
 * LIMITACIÓN ARQUITECTÓNICA DE LOCALSTORAGE:
 * El API de Web Storage (localStorage) es un almacén clave-valor síncrono por origen en el navegador,
 * pero NO proporciona transacciones atómicas multi-clave ni aislamiento transaccional (ACID)
 * entre pestañas concurrentes. Si otra pestaña lee o escribe en el almacenamiento mientras
 * este hilo ejecuta escrituras sucesivas (o si el proceso/pestaña se interrumpe abruptamente
 * en medio de las operaciones), las claves pueden observarse en un estado temporalmente parcial.
 *
 * Para mitigar este riesgo en la capa demo:
 * 1. Comprobación optimista previa: Se validan los snapshots previos de todas las claves antes de escribir.
 * 2. Diario de recuperación (journaling): Se persiste un registro previo atómico en TRANSITION_RECOVERY_KEY.
 * 3. Pseudo-transaccionalidad con rollback: Si cualquier escritura falla, se restaura el estado previo.
 * 4. Verificación de rollback: Si alguna restauración falla durante el rollback, se alerta explícitamente
 *    y se conserva el diario sin reportar falsamente una recuperación exitosa.
 * 5. Recuperación al inicio: La aplicación recupera diarios incompletos en el ciclo de montaje (onMount).
 */

import {
	INCIDENTS_KEY,
	HISTORY_KEY,
	RECOVERY_KEY as ASSIGNMENT_RECOVERY_KEY,
	TRANSITION_RECOVERY_KEY
} from './assignment';
import { MESSAGES_KEY, loadMessages } from './messages';
import { FIRST_RESPONSE_RECOVERY_KEY } from './first-response';
import { isIncidentList } from '$lib/incidents/validation';
import { isIncidentHistory } from '$lib/incidents/history';
import type { Incident } from '$lib/types/incident';
import type { IncidentHistoryEntry } from '$lib/types/incident-history';
import type { IncidentMessage } from '$lib/types/incident-message';

export { TRANSITION_RECOVERY_KEY };

type LocalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface TransitionJournal {
	version: 1;
	incidents: string | null;
	history: string | null;
	messages: string | null;
	targetIncidents?: string | null;
	targetHistory?: string | null;
	targetMessages?: string | null;
}

/**
 * Valida y restaura incidencias, historial y mensajes desde el diario de recuperación.
 *
 * Verificación conservadora contra sobrescrituras:
 * Antes de tocar ninguna clave, comprueba que el estado actual del almacenamiento
 * puede atribuirse con certeza matemática a la transacción interrumpida (uno de los
 * 4 estados secuenciales válidos: antes de escribir incidencias, tras incidencias,
 * tras historial, o tras mensajes). Si se detecta cualquier modificación divergente
 * realizada por otra pestaña o proceso externo, NO sobrescribe los datos, conserva
 * el diario de recuperación intacto y arroja un error requiriendo intervención manual.
 */
export function recoverTransitionWithMessage(storage: LocalStore): void {
	const raw = storage.getItem(TRANSITION_RECOVERY_KEY);
	if (raw === null) return;

	let journal: TransitionJournal;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
			throw new Error();
		}
		const p = parsed as {
			version: unknown;
			incidents: unknown;
			history: unknown;
			messages: unknown;
			targetIncidents?: unknown;
			targetHistory?: unknown;
			targetMessages?: unknown;
		};
		const incidentsValid =
			p.incidents === null ||
			(typeof p.incidents === 'string' && isIncidentList(JSON.parse(p.incidents)));
		const historyValid =
			p.history === null ||
			(typeof p.history === 'string' && isIncidentHistory(JSON.parse(p.history)));
		const messagesValid =
			p.messages === null ||
			(typeof p.messages === 'string' && Array.isArray(loadMessages(p.messages)));

		const targetIncidentsValid =
			p.targetIncidents === undefined ||
			p.targetIncidents === null ||
			(typeof p.targetIncidents === 'string' && isIncidentList(JSON.parse(p.targetIncidents)));
		const targetHistoryValid =
			p.targetHistory === undefined ||
			p.targetHistory === null ||
			(typeof p.targetHistory === 'string' && isIncidentHistory(JSON.parse(p.targetHistory)));
		const targetMessagesValid =
			p.targetMessages === undefined ||
			p.targetMessages === null ||
			(typeof p.targetMessages === 'string' && Array.isArray(loadMessages(p.targetMessages)));

		if (
			!incidentsValid ||
			!historyValid ||
			!messagesValid ||
			!targetIncidentsValid ||
			!targetHistoryValid ||
			!targetMessagesValid
		) {
			throw new Error();
		}
		journal = p as unknown as TransitionJournal;
	} catch {
		throw new Error(
			'No se pudo validar la copia de recuperación de transición. Los datos se han conservado.'
		);
	}

	const currInc = storage.getItem(INCIDENTS_KEY);
	const currHist = storage.getItem(HISTORY_KEY);
	const currMsg = storage.getItem(MESSAGES_KEY);

	const hasTargets =
		typeof journal.targetIncidents === 'string' &&
		typeof journal.targetHistory === 'string' &&
		typeof journal.targetMessages === 'string';

	const isSafeToRecover = hasTargets
		? (currInc === journal.incidents &&
				currHist === journal.history &&
				currMsg === journal.messages) ||
			(currInc === journal.targetIncidents &&
				currHist === journal.history &&
				currMsg === journal.messages) ||
			(currInc === journal.targetIncidents &&
				currHist === journal.targetHistory &&
				currMsg === journal.messages) ||
			(currInc === journal.targetIncidents &&
				currHist === journal.targetHistory &&
				currMsg === journal.targetMessages)
		: (currInc === journal.incidents ||
				(typeof currInc === 'string' && isIncidentList(JSON.parse(currInc)))) &&
			currHist === journal.history &&
			currMsg === journal.messages;

	if (!isSafeToRecover) {
		throw new Error(
			'Conflicto de recuperación: se detectaron modificaciones externas o divergentes en los datos. El diario se ha conservado y se requiere intervención manual.'
		);
	}

	// Restaurar cada almacén. Si setItem falla, no eliminamos el diario
	for (const [key, value] of [
		[INCIDENTS_KEY, journal.incidents],
		[HISTORY_KEY, journal.history],
		[MESSAGES_KEY, journal.messages]
	] as const) {
		if (value === null) {
			storage.removeItem(key);
		} else {
			storage.setItem(key, value);
		}
	}

	storage.removeItem(TRANSITION_RECOVERY_KEY);
}

/**
 * Coordina la persistencia atómica de incidencias, historial y mensajes (rechazo de solución o reapertura).
 * Comprueba snapshots optimistas antes de comenzar, crea un diario de recuperación previo y ejecuta
 * rollback completo si alguna escritura posterior falla.
 */
export function commitTransitionWithMessage(
	storage: LocalStore,
	incidents: Incident[],
	history: IncidentHistoryEntry[],
	messages: IncidentMessage[],
	expectedIncidents: string | null,
	expectedHistory: string | null,
	expectedMessages: string | null
): void {
	// 1. Evitar interferencias con otros diarios de recuperación activos
	if (storage.getItem(TRANSITION_RECOVERY_KEY) !== null) {
		throw new Error(
			'Hay una operación de transición pendiente de recuperación. Recarga antes de continuar.'
		);
	}
	if (storage.getItem(ASSIGNMENT_RECOVERY_KEY) !== null) {
		throw new Error(
			'Hay una operación de asignación pendiente de recuperación. Recarga antes de continuar.'
		);
	}
	if (storage.getItem(FIRST_RESPONSE_RECOVERY_KEY) !== null) {
		throw new Error(
			'Hay una primera respuesta pendiente de recuperación. Recarga antes de continuar.'
		);
	}

	// 2. Comprobar concurrencia optimista en las tres claves antes de cualquier escritura
	if (
		storage.getItem(INCIDENTS_KEY) !== expectedIncidents ||
		storage.getItem(HISTORY_KEY) !== expectedHistory ||
		storage.getItem(MESSAGES_KEY) !== expectedMessages
	) {
		throw new Error('Los datos han cambiado en otra pestaña. Recarga antes de continuar.');
	}

	// 3. Validar consistencia de los datos a persistir
	if (!isIncidentList(incidents) || !isIncidentHistory(history)) {
		throw new Error('No se pueden guardar datos de incidencia o historial inválidos.');
	}
	// Valida estructura de mensajes lanzando si no es array válido
	loadMessages(JSON.stringify(messages));

	const targetIncidents = JSON.stringify(incidents);
	const targetHistory = JSON.stringify(history);
	const targetMessages = JSON.stringify(messages);

	// 4. Escribir diario de recuperación con el estado previo confirmado y los valores objetivo previstos
	const journal: TransitionJournal = {
		version: 1,
		incidents: expectedIncidents,
		history: expectedHistory,
		messages: expectedMessages,
		targetIncidents,
		targetHistory,
		targetMessages
	};
	storage.setItem(TRANSITION_RECOVERY_KEY, JSON.stringify(journal));

	// 5. Escrituras coordinadas y commit point
	try {
		storage.setItem(INCIDENTS_KEY, targetIncidents);
		storage.setItem(HISTORY_KEY, targetHistory);
		storage.setItem(MESSAGES_KEY, targetMessages);
		storage.removeItem(TRANSITION_RECOVERY_KEY);
	} catch {
		// Rollback inmediato
		try {
			recoverTransitionWithMessage(storage);
		} catch {
			// El rollback no se completó: advertir explícitamente sin enmascarar el fallo
			throw new Error(
				'Guardado interrumpido y la recuperación automática ha fallado. La copia de recuperación se conserva; recarga antes de continuar.'
			);
		}
		// Rollback exitoso
		throw new Error(
			'No se pudo guardar la transición. Se han conservado la incidencia, el historial y los mensajes anteriores.'
		);
	}
}

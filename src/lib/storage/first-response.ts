import { loadMessages, appendMessage, MESSAGES_KEY } from './messages';
import { INCIDENTS_KEY } from './assignment';
import { isIncidentList } from '$lib/incidents/validation';
import { isFirstResponseEligible, recordFirstResponse } from '$lib/incidents/lifecycle';
import type { IncidentMessage } from '$lib/types/incident-message';
import type { Incident } from '$lib/types/incident';
import type { AppUser } from '$lib/types/user';

export const FIRST_RESPONSE_RECOVERY_KEY = 'soporteflow-first-response-recovery';

type LocalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface SendMessageResult {
	nextMessages: IncidentMessage[];
	updatedIncident?: Incident;
}

/**
 * Restores messages and incidents from the recovery journal if an operation was interrupted.
 * Removing the journal is the commit point.
 */
export function recoverFirstResponse(storage: LocalStore): void {
	const raw = storage.getItem(FIRST_RESPONSE_RECOVERY_KEY);
	if (raw === null) return;
	try {
		const journal = JSON.parse(raw);
		if (
			!journal ||
			journal.version !== 1 ||
			!(
				journal.messages === null ||
				(typeof journal.messages === 'string' && Array.isArray(loadMessages(journal.messages)))
			) ||
			!(
				journal.incidents === null ||
				(typeof journal.incidents === 'string' && isIncidentList(JSON.parse(journal.incidents)))
			)
		) {
			throw new Error();
		}
		for (const [key, value] of [
			[MESSAGES_KEY, journal.messages],
			[INCIDENTS_KEY, journal.incidents]
		] as const) {
			if (value === null) storage.removeItem(key);
			else storage.setItem(key, value);
		}
		storage.removeItem(FIRST_RESPONSE_RECOVERY_KEY);
	} catch {
		throw new Error(
			'No se pudo validar la copia de recuperación de primera respuesta. Los datos se han conservado.'
		);
	}
}

/**
 * Coordinated write for the SLA first response: persists the new public message
 * and updates incident.sla.firstRespondedAt in a single logical operation with journal and rollback.
 */
export function commitFirstResponse(
	storage: LocalStore,
	messages: IncidentMessage[],
	incidents: Incident[],
	expectedMessages: string | null,
	expectedIncidents: string | null
): void {
	if (storage.getItem(FIRST_RESPONSE_RECOVERY_KEY) !== null) {
		throw new Error(
			'Hay una operación de primera respuesta pendiente de recuperación. Recarga antes de continuar.'
		);
	}
	if (
		storage.getItem(MESSAGES_KEY) !== expectedMessages ||
		storage.getItem(INCIDENTS_KEY) !== expectedIncidents
	) {
		throw new Error('Los datos han cambiado en otra pestaña. Recarga antes de continuar.');
	}
	if (!isIncidentList(incidents)) {
		throw new Error('No se pueden guardar datos de incidencias inválidos.');
	}

	// Validate message structure
	loadMessages(JSON.stringify(messages));

	storage.setItem(
		FIRST_RESPONSE_RECOVERY_KEY,
		JSON.stringify({ version: 1, messages: expectedMessages, incidents: expectedIncidents })
	);
	try {
		storage.setItem(MESSAGES_KEY, JSON.stringify(messages));
		storage.setItem(INCIDENTS_KEY, JSON.stringify(incidents));
		storage.removeItem(FIRST_RESPONSE_RECOVERY_KEY);
	} catch {
		try {
			recoverFirstResponse(storage);
		} catch {
			throw new Error(
				'Guardado interrumpido. La copia de recuperación se conserva; recarga antes de continuar.'
			);
		}
		throw new Error(
			'No se pudo guardar la primera respuesta. Se han conservado los mensajes y la incidencia anteriores.'
		);
	}
}

/**
 * Coordinates message sending. If the message is the first public staff response on an SLA incident,
 * it performs a coordinated commit with recovery journal. Otherwise, it delegates to the standard message flow.
 */
export function sendIncidentMessage(
	storage: LocalStore,
	actor: AppUser,
	incident: Incident,
	message: IncidentMessage,
	messagesSnapshot: string | null,
	incidentList?: Incident[],
	incidentsSnapshot?: string | null
): SendMessageResult {
	const isFirstResponse = isFirstResponseEligible(incident, message, actor);

	if (!isFirstResponse || !incidentList) {
		const nextMessages = appendMessage(storage, actor, incident, message, messagesSnapshot);
		return { nextMessages };
	}

	const updatedIncident = recordFirstResponse(incident, message, actor);
	const previousMessages = loadMessages(storage.getItem(MESSAGES_KEY));
	const nextMessages = [...previousMessages, message];
	const updatedIncidents = incidentList.map((item) =>
		item.id === incident.id ? updatedIncident : item
	);

	commitFirstResponse(
		storage,
		nextMessages,
		updatedIncidents,
		messagesSnapshot,
		incidentsSnapshot ?? storage.getItem(INCIDENTS_KEY)
	);

	return {
		nextMessages,
		updatedIncident
	};
}

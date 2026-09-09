import type { IncidentMessage } from '$lib/types/incident-message';
import type { Incident } from '$lib/types/incident';
import type { AppUser } from '$lib/types/user';
import { canUseMessages } from '$lib/incidents/messages';
import { incidentOrganizationId } from '$lib/incidents/assignment';

export const MESSAGES_KEY = 'soporteflow-incident-messages';
export function loadMessages(raw: string | null): IncidentMessage[] {
	if (raw === null) return [];
	const data: unknown = JSON.parse(raw);
	if (
		!Array.isArray(data) ||
		!data.every(
			(message) =>
				message &&
				typeof message === 'object' &&
				['id', 'organizationId', 'authorUserId', 'content', 'createdAt'].every(
					(key) => typeof message[key] === 'string' && message[key].trim()
				) &&
				Number.isSafeInteger(message.incidentId) &&
				message.incidentId > 0 &&
				['public', 'internal'].includes(message.visibility) &&
				/^\d{4}-\d{2}-\d{2}T/.test(message.createdAt) &&
				Number.isFinite(Date.parse(message.createdAt))
		) ||
		new Set(data.map((message) => message.id)).size !== data.length
	)
		throw new Error(
			'Los mensajes guardados no son válidos. Se han conservado; revisa los datos antes de continuar.'
		);
	return data;
}
// Append-only write: no interface for editing, deleting or changing visibility.
export function appendMessage(
	storage: Pick<Storage, 'getItem' | 'setItem'>,
	actor: AppUser,
	incident: Incident,
	message: IncidentMessage,
	expectedRaw: string | null
): IncidentMessage[] {
	if (
		!canUseMessages(actor, incident, message.visibility) ||
		message.authorUserId !== actor.id ||
		message.incidentId !== incident.id ||
		message.organizationId !== incidentOrganizationId(incident)
	)
		throw new Error('No tienes permiso para guardar este mensaje.');
	const raw = storage.getItem(MESSAGES_KEY);
	if (raw !== expectedRaw)
		throw new Error(
			'Los mensajes han cambiado en otra pestaña. Cierra y vuelve a abrir la incidencia antes de enviar.'
		);
	const previous = loadMessages(raw);
	const next = loadMessages(JSON.stringify([...previous, message]));
	try {
		storage.setItem(MESSAGES_KEY, JSON.stringify(next));
	} catch {
		throw new Error('No se pudo guardar el mensaje. Tu texto se conserva para reintentarlo.');
	}
	return next;
}

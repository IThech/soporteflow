import { canUseMessages } from '$lib/incidents/messages';
import { incidentOrganizationId } from '$lib/incidents/assignment';
import { hasPermission } from '$lib/auth/permissions';
import { buildIncidentNotification } from '$lib/incidents/notifications';
import { loadMessages, MESSAGES_KEY } from './messages';
import { loadHistory, HISTORY_KEY, RECOVERY_KEY, TRANSITION_RECOVERY_KEY } from './assignment';
import { loadNotifications, saveNotifications, NOTIFICATIONS_KEY } from './notifications';
import type { AppUser } from '$lib/types/user';
import type { Incident } from '$lib/types/incident';
import type { IncidentMessage } from '$lib/types/incident-message';
import type { IncidentHistoryEntry } from '$lib/types/incident-history';

// Best-effort secondary writes, not a transaction. Stable IDs make explicit retries idempotent.
// The persisted note is the source of truth; never roll it back or send it again on an effect failure.
export function completeInternalNoteEffects(
	storage: Pick<Storage, 'getItem' | 'setItem'>,
	actor: AppUser,
	incident: Incident,
	message: IncidentMessage,
	users: AppUser[]
) {
	if (
		!canUseMessages(actor, incident, 'internal') ||
		!hasPermission(actor, 'incidents:add_internal_note') ||
		message.visibility !== 'internal' ||
		message.authorUserId !== actor.id ||
		message.incidentId !== incident.id ||
		message.organizationId !== incidentOrganizationId(incident)
	) {
		throw new Error('No tienes permiso para registrar esta nota interna.');
	}
	const saved = loadMessages(storage.getItem(MESSAGES_KEY)).find((item) => item.id === message.id);
	if (!saved || JSON.stringify(saved) !== JSON.stringify(message))
		throw new Error('La nota guardada no coincide. Revisa los datos antes de continuar.');
	if (storage.getItem(RECOVERY_KEY) !== null || storage.getItem(TRANSITION_RECOVERY_KEY) !== null)
		throw new Error('Hay una recuperación pendiente del historial. Recarga antes de continuar.');
	const raw = storage.getItem(HISTORY_KEY);
	const history = loadHistory(raw);
	const event: IncidentHistoryEntry = {
		id: `internal-note:${message.id}`,
		incidentId: message.incidentId,
		organizationId: message.organizationId,
		actorUserId: message.authorUserId,
		timestamp: new Date(message.createdAt).toISOString(),
		eventType: 'internal_note_added',
		newValue: { messageId: message.id }
	};
	const existing = history.find((item) => item.id === event.id);
	if (existing && JSON.stringify(existing) !== JSON.stringify(event))
		throw new Error('El evento de la nota no coincide. Revisa el historial.');
	if (!existing) {
		history.push(event);
		if (storage.getItem(HISTORY_KEY) !== raw)
			throw new Error('El historial ha cambiado. Reintenta el registro.');
		storage.setItem(HISTORY_KEY, JSON.stringify(history));
	}
	const recipient = users.find((user) => user.id === incident.assignedToUserId);
	if (!recipient || !canUseMessages(recipient, incident, 'internal') || recipient.id === actor.id)
		return { history, notifications: undefined };
	const notification = buildIncidentNotification({
		type: 'incident_internal_note',
		incident,
		actor,
		message
	});
	if (!notification) return { history, notifications: undefined };
	notification.id = `internal-note:${message.id}:${recipient.id}`;
	notification.createdAt = message.createdAt;
	const notificationRaw = storage.getItem(NOTIFICATIONS_KEY);
	const notifications = loadNotifications(notificationRaw);
	if (!notifications.some((item) => item.id === notification.id)) {
		notifications.push(notification);
		saveNotifications(storage, notifications, notificationRaw);
	}
	return { history, notifications };
}

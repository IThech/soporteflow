import { canActOnIncident } from '$lib/auth/record-access';
import { incidentOrganizationId } from '$lib/incidents/assignment';
import { recordStatusTransition, resolveEditedIncidentPriority } from '$lib/incidents/lifecycle';
import type { EventNotificationInput } from '$lib/incidents/notifications';
import type { Incident, IncidentStatus } from '$lib/types/incident';
import type { IncidentHistoryEntry } from '$lib/types/incident-history';
import type { AppUser } from '$lib/types/user';
import { generateId } from '$lib/utils/id';
import { commitAssignment } from './assignment';
import { FIRST_RESPONSE_RECOVERY_KEY } from './first-response';

export type IncidentEditChange =
	| { kind: 'status'; status: IncidentStatus }
	| {
			kind: 'edit';
			draft: Pick<
				Incident,
				'status' | 'priority' | 'title' | 'client' | 'description' | 'solution'
			>;
	  };

// Only the status selector and edit form use this coordinator. No new journal or SLA rules.
export function commitIncidentEdit(
	storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
	actor: AppUser,
	original: Incident,
	change: IncidentEditChange,
	incidents: Incident[],
	history: IncidentHistoryEntry[],
	expectedIncidents: string | null,
	expectedHistory: string | null,
	timestamp = new Date().toISOString()
) {
	if (!canActOnIncident(actor, original, 'incidents:edit'))
		throw new Error('No tienes permiso para editar esta incidencia.');
	if (
		!incidents.some(
			(item) =>
				item.id === original.id && incidentOrganizationId(item) === incidentOrganizationId(original)
		)
	)
		throw new Error('La incidencia ya no está disponible.');
	const status = change.kind === 'status' ? change.status : change.draft.status;
	if (!['open', 'pending', 'resolved', 'closed'].includes(status))
		throw new Error('Estado no válido.');
	if (status === 'closed' && original.status !== 'closed')
		throw new Error('El cierre requiere confirmación del cliente o cierre automático.');
	const statusChanged = status !== original.status;
	let updated: Incident = { ...original };
	if (change.kind === 'edit') {
		const draft = change.draft;
		updated = {
			...updated,
			title: draft.title.trim(),
			client: draft.client.trim(),
			description: (draft.description ?? '').trim(),
			solution: (draft.solution ?? '').trim(),
			priority: resolveEditedIncidentPriority(original, draft.priority)
		};
		if (!updated.title || !updated.client) throw new Error('Completa el título y el cliente.');
	}
	if (!updated.description?.trim())
		throw new Error('Describe el problema antes de guardar la incidencia.');
	if (status === 'resolved' && !updated.solution?.trim())
		throw new Error('Para resolver esta incidencia, indica qué hiciste y cuál fue el resultado.');
	if (statusChanged) updated = recordStatusTransition(updated, status, timestamp);
	const nextHistory = [...history];
	let notificationInput: EventNotificationInput | null = null;
	if (statusChanged) {
		const identity = {
			id: generateId(),
			incidentId: original.id,
			organizationId: incidentOrganizationId(original),
			actorUserId: actor.id,
			timestamp
		};
		const reopening = original.status === 'resolved' || original.status === 'closed';
		if (status === 'resolved') {
			nextHistory.push({
				...identity,
				eventType: 'resolved',
				previousValue: { status: original.status },
				newValue: { status, solution: updated.solution }
			});
		} else if (reopening && status === 'open') {
			nextHistory.push({ ...identity, eventType: 'reopened', newValue: { status: 'open' } });
		} else {
			// The existing reopened schema is open-only; pending retains a truthful status_changed event.
			nextHistory.push({
				...identity,
				eventType: 'status_changed',
				previousValue: original.status,
				newValue: status
			});
		}
		notificationInput = {
			type:
				status === 'resolved'
					? 'incident_resolved'
					: reopening
						? 'incident_reopened'
						: 'incident_status_changed',
			incident: updated,
			actor,
			previousStatus: original.status,
			nextStatus: status
		};
	}
	const nextIncidents = incidents.map((item) =>
		item.id === original.id && incidentOrganizationId(item) === incidentOrganizationId(original)
			? updated
			: item
	);
	if (storage.getItem(FIRST_RESPONSE_RECOVERY_KEY) !== null)
		throw new Error(
			'Hay una primera respuesta pendiente de recuperación. Recarga antes de continuar.'
		);
	commitAssignment(storage, nextIncidents, nextHistory, expectedIncidents, expectedHistory);
	return { incidents: nextIncidents, history: nextHistory, notificationInput };
}

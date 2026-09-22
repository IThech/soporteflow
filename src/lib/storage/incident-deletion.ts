import { canActOnIncident } from '$lib/auth/record-access';
import type { Incident } from '$lib/types/incident';
import type { IncidentHistoryEntry } from '$lib/types/incident-history';
import type { AppUser } from '$lib/types/user';
import { commitAssignment, TRANSITION_RECOVERY_KEY } from './assignment';
import { FIRST_RESPONSE_RECOVERY_KEY } from './first-response';

type LocalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function commitIncidentDeletion(
	storage: LocalStore,
	actor: AppUser,
	incidentId: number,
	incidents: Incident[],
	history: IncidentHistoryEntry[],
	expectedIncidents: string | null,
	expectedHistory: string | null
): { incidents: Incident[] } {
	const target = incidents.find((item) => item.id === incidentId);
	if (!target) {
		throw new Error('La incidencia ya no está disponible.');
	}

	if (!canActOnIncident(actor, target, 'incidents:delete')) {
		throw new Error('No tienes permiso para eliminar esta incidencia.');
	}

	if (storage.getItem(FIRST_RESPONSE_RECOVERY_KEY) !== null) {
		throw new Error(
			'Hay una primera respuesta pendiente de recuperación. Recarga antes de continuar.'
		);
	}
	if (storage.getItem(TRANSITION_RECOVERY_KEY) !== null) {
		throw new Error('Hay una operación pendiente de recuperación. Recarga antes de continuar.');
	}

	const nextIncidents = incidents.filter((item) => item.id !== incidentId);

	commitAssignment(storage, nextIncidents, history, expectedIncidents, expectedHistory);

	return { incidents: nextIncidents };
}

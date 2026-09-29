import type { ApiError } from '../api/errors.ts';
import type { StaffIncidentDetailView } from '../api/incident-detail.ts';
import type { SlaObjectiveStatus } from '../api/incidents.ts';
import { presentApiError } from './error-presentation.ts';
import type { Tone } from './incident-presentation.ts';

/**
 * UI-2C — pure presentation of the incident detail (no Svelte, unit-tested in Node).
 * Values are shown as the server sent them: no SLA recomputation, no invented names. Internal
 * labels ("Sin asignar", "Sin equipo"…) exist only for the STAFF view, where the field is really
 * part of the DTO; the requester view never receives these helpers' inputs.
 */

export const SLA_OBJECTIVE_LABELS: Record<SlaObjectiveStatus, string> = {
	not_applicable: 'No aplica',
	pending: 'Pendiente',
	met: 'Cumplido',
	breached: 'Incumplido'
};

export const SLA_OBJECTIVE_TONES: Record<SlaObjectiveStatus, Tone> = {
	not_applicable: 'neutral',
	pending: 'info',
	met: 'success',
	breached: 'danger'
};

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', {
	day: '2-digit',
	month: '2-digit',
	year: 'numeric',
	hour: '2-digit',
	minute: '2-digit'
});

/** Local, readable date; null for a missing or unparsable value (never "Invalid Date"). */
export function formatDetailDate(value: string | null | undefined): string | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? DATE_FORMAT.format(date) : null;
}

/** Staff only: the assignee as the detail DTO states it. */
export function staffAssigneeLabel(incident: StaffIncidentDetailView): string {
	if (incident.assignedToUserName) return incident.assignedToUserName;
	return incident.assignedToUserId ? 'Técnico asignado' : 'Sin asignar';
}

/** Staff only: the team as the detail DTO states it. */
export function staffTeamLabel(incident: StaffIncidentDetailView): string {
	if (incident.teamName) return incident.teamName;
	return incident.teamId ? 'Equipo asignado' : 'Sin equipo';
}

export const NOT_AVAILABLE = 'No disponible';

/**
 * A catalog-backed name (site, category, requester member): the name when the catalog could be
 * read, `emptyLabel` when the incident has none, and "No disponible" otherwise — never the UUID.
 */
export function catalogName(
	id: string | null,
	names: ReadonlyMap<string, string> | null,
	emptyLabel: string
): string {
	if (!id) return emptyLabel;
	return names?.get(id) ?? NOT_AVAILABLE;
}

/** Staff only: the requester member (clientUserId), distinct from the free-text `client`. */
export function staffRequesterLabel(
	incident: StaffIncidentDetailView,
	selfUserId: string | null,
	selfName: string | null,
	members: ReadonlyMap<string, string> | null
): string {
	if (!incident.clientUserId) return 'Sin solicitante';
	if (incident.clientUserId === selfUserId) return selfName ? `${selfName} (tú)` : 'Tú';
	return catalogName(incident.clientUserId, members, 'Sin solicitante');
}

export interface DetailErrorView {
	tone: 'danger' | 'warning';
	title: string;
	message: string;
	requestId?: string;
	/** A manual retry of the READ makes sense (never automatic). */
	retry: boolean;
}

/**
 * Safe presentation of a failed detail read. 403 and 404 use the same neutral wording: a missing
 * incident and one of another tenant must be indistinguishable. Server messages are never shown.
 */
export function presentDetailError(error: ApiError, accessLost = false): DetailErrorView {
	if (accessLost || error.status === 404 || error.status === 403 || error.kind === 'invalid-input')
		return {
			tone: 'warning',
			title: 'Incidencia no disponible',
			message: accessLost
				? 'Esta incidencia ya no está disponible.'
				: 'Esta incidencia no está disponible o no tienes acceso a ella.',
			requestId: error.requestId,
			retry: false
		};
	const base = presentApiError(error);
	return {
		tone: base.tone === 'warning' ? 'warning' : 'danger',
		title: base.title,
		message: base.message,
		requestId: base.requestId,
		retry: base.action === 'retry'
	};
}

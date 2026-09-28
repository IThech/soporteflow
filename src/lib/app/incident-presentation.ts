import {
	PRIORITY_LABELS,
	STATUS_LABELS,
	formatDate
} from '../components/incidents/presentation.ts';
import type { SlaOverallStatus } from '../api/incidents.ts';
import type { IncidentView, StaffIncidentView } from '../api/incident-views.ts';

/**
 * Pure presentation helpers for the incident workspace (UI-2A). Labels reuse the existing Spanish
 * vocabulary; tones map to design tokens. Text always carries the meaning (never color alone).
 */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export const STATUS_TONES: Record<IncidentView['status'], Tone> = {
	open: 'accent',
	pending: 'warning',
	resolved: 'success',
	closed: 'neutral'
};
export const PRIORITY_TONES: Record<IncidentView['priority'], Tone> = {
	low: 'neutral',
	medium: 'info',
	high: 'warning',
	urgent: 'danger'
};
export const SLA_LABELS: Record<SlaOverallStatus, string> = {
	not_applicable: 'Sin SLA',
	on_track: 'En plazo',
	met: 'Cumplido',
	breached: 'Incumplido'
};
export const SLA_TONES: Record<SlaOverallStatus, Tone> = {
	not_applicable: 'neutral',
	on_track: 'info',
	met: 'success',
	breached: 'danger'
};
export const QUEUE_LABELS = {
	all: 'Todas',
	mine: 'Asignadas a mí',
	unassigned: 'Sin asignar'
} as const;

export const statusLabel = (status: IncidentView['status']) => STATUS_LABELS[status] ?? status;
export const priorityLabel = (priority: IncidentView['priority']) =>
	PRIORITY_LABELS[priority] ?? priority;
export { formatDate };

/** Staff-only assignment text; the requester projection never reaches this function. */
export function assignmentLabel(incident: StaffIncidentView): string {
	if (incident.assignedToUserName) return incident.assignedToUserName;
	return incident.assignedToUserId ? 'Técnico asignado' : 'Sin asignar';
}

export interface EmptyListCopy {
	title: string;
	description: readonly string[];
	/** Label of the create CTA (shown only when the page passes a create href). */
	createLabel: string;
}

/**
 * Empty-list copy (UI-1C), honest for each view: "no incidents in this organization" is only
 * claimed for the `all` queue; `mine`/`unassigned` describe that queue; a requester-only user
 * (no queue) sees their own scope. Filtered results use a separate "no results" state.
 */
export function emptyListCopy(queue: 'all' | 'mine' | 'unassigned' | null): EmptyListCopy {
	const title = 'Todo tranquilo por aquí';
	switch (queue) {
		case 'all':
			return {
				title,
				description: [
					'Todavía no hay incidencias en esta organización.',
					'Cuando llegue la primera, aparecerá aquí con todo su contexto.'
				],
				createLabel: 'Crear primera incidencia'
			};
		case 'mine':
			return {
				title,
				description: ['No tienes incidencias asignadas en este momento.'],
				createLabel: 'Nueva incidencia'
			};
		case 'unassigned':
			return {
				title,
				description: ['No hay incidencias pendientes de asignar.'],
				createLabel: 'Nueva incidencia'
			};
		default:
			return {
				title,
				description: [
					'Todavía no tienes incidencias registradas.',
					'Cuando crees la primera, aparecerá aquí con todo su contexto.'
				],
				createLabel: 'Crear primera incidencia'
			};
	}
}

export function incidentHref(base: string, incident: Pick<IncidentView, 'id' | 'organizationId'>) {
	return `${base}/${encodeURIComponent(incident.id)}?organizationId=${encodeURIComponent(incident.organizationId)}`;
}

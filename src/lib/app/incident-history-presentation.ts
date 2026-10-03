import type { IncidentHistoryItem, SafeIncidentHistoryType } from '$lib/api/incidents';
import { STATUS_LABELS, PRIORITY_LABELS } from '$lib/components/incidents/presentation';
import type { Tone } from '$lib/app/incident-presentation';

/**
 * Returns a human-friendly Spanish title for each safe incident history event.
 */
export function historyEventTitle(type: SafeIncidentHistoryType): string {
	switch (type) {
		case 'created':
			return 'Incidencia creada';
		case 'status_changed':
			return 'Estado modificado';
		case 'resolved':
			return 'Incidencia resuelta';
		case 'closed':
			return 'Incidencia cerrada';
		case 'reopened':
			return 'Incidencia reabierta';
		case 'priority_changed':
			return 'Prioridad modificada';
		case 'assigned':
			return 'Incidencia asignada';
		case 'reassigned':
			return 'Incidencia reasignada';
		case 'support_level_changed':
			return 'Nivel de soporte modificado';
		case 'site_changed':
			return 'Sede modificada';
		case 'category_changed':
			// the same event records category and/or subcategory changes: one wording for both
			return 'Clasificación modificada';
		case 'sla_applied':
			return 'Compromiso SLA aplicado';
		case 'sla_changed':
			return 'Compromiso SLA modificado';
		case 'sla_cleared':
			return 'Compromiso SLA retirado';
		case 'sla_first_response_met':
			return 'Primera respuesta en plazo (SLA)';
		case 'sla_first_response_breached':
			return 'Primera respuesta fuera de plazo (SLA incumplido)';
		case 'sla_resolution_met':
			return 'Resolución en plazo (SLA)';
		case 'sla_resolution_breached':
			return 'Resolución fuera de plazo (SLA incumplido)';
		default:
			return 'Evento registrado';
	}
}

/**
 * Returns a badge tone associated with the event type.
 */
export function historyEventTone(type: SafeIncidentHistoryType): Tone {
	switch (type) {
		case 'resolved':
		case 'sla_resolution_met':
		case 'sla_first_response_met':
			return 'success';
		case 'sla_resolution_breached':
		case 'sla_first_response_breached':
			return 'danger';
		case 'reopened':
			return 'warning';
		case 'closed':
			return 'neutral';
		default:
			return 'info';
	}
}

/**
 * Returns structured changes description if applicable.
 */
export function describeHistoryChanges(item: IncidentHistoryItem): {
	statusChange?: { fromLabel: string; toLabel: string };
	priorityChange?: { fromLabel: string; toLabel: string };
	levelChange?: { from: string; to: string };
	note?: string;
} {
	if (item.changes?.status) {
		const from = item.changes.status.from;
		const to = item.changes.status.to;
		return {
			statusChange: {
				fromLabel: from ? (STATUS_LABELS[from] ?? from) : 'Sin estado',
				toLabel: to ? (STATUS_LABELS[to] ?? to) : 'Sin estado'
			}
		};
	}
	if (item.changes?.priority) {
		const from = item.changes.priority.from;
		const to = item.changes.priority.to;
		return {
			priorityChange: {
				fromLabel: from ? (PRIORITY_LABELS[from] ?? from) : 'Sin prioridad',
				toLabel: to ? (PRIORITY_LABELS[to] ?? to) : 'Sin prioridad'
			}
		};
	}
	if (item.changes?.supportLevel) {
		return {
			levelChange: {
				from: item.changes.supportLevel.from ?? 'Sin nivel',
				to: item.changes.supportLevel.to ?? 'Sin nivel'
			}
		};
	}
	if (item.changes?.assignmentChanged) {
		return { note: 'Se ha modificado la asignación de equipo o técnico.' };
	}
	if (item.changes?.siteChanged) {
		return { note: 'Se ha actualizado la sede de la incidencia.' };
	}
	if (item.changes?.categoryChanged) {
		return { note: 'Se ha actualizado la clasificación de la incidencia.' };
	}
	return {};
}

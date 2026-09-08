import { canViewIncident } from '$lib/auth/record-access';
import { demoOrganization } from '$lib/data/organizations';
import { incidentOrganizationId } from './assignment';
import type { Incident } from '$lib/types/incident';
import type { IncidentHistoryEntry, IncidentRoutingSnapshot } from '$lib/types/incident-history';
import type { AppUser } from '$lib/types/user';
import type { IncidentCategory } from '$lib/types/category';
import type { SupportTeam } from '$lib/types/support';

export function visibleIncidentHistory(
	viewer: AppUser,
	incident: Incident,
	entries: IncidentHistoryEntry[]
): IncidentHistoryEntry[] {
	if (
		!['platform_admin', 'organization_admin', 'technician'].includes(viewer.role) ||
		!canViewIncident(viewer, incident)
	)
		return [];
	return entries
		.filter(
			(entry) =>
				entry.incidentId === incident.id &&
				entry.organizationId === incidentOrganizationId(incident)
		)
		.toSorted((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
}

export function describeHistoryEvent(
	entry: IncidentHistoryEntry,
	users: AppUser[],
	categories: IncidentCategory[] = [],
	teams: SupportTeam[] = []
): string {
	const userName = (id: string | null | undefined, actor = false) =>
		users.find(
			(user) =>
				user.id === id &&
				(user.organizationId === entry.organizationId || (actor && user.role === 'platform_admin'))
		)?.name || 'Usuario no disponible';
	const actor = userName(entry.actorUserId, true);
	const statuses = { open: 'Abierta', pending: 'Pendiente', resolved: 'Resuelta' };
	const priorities = { low: 'Baja', medium: 'Media', high: 'Alta' };
	const categoryName = (id: string | null | undefined) =>
		id === null
			? 'Sin categoría'
			: categories.find(
					(category) =>
						category.id === id &&
						(category.organizationId ?? demoOrganization.id) === entry.organizationId
				)?.name || 'Categoría no disponible';
	const routing = (value: IncidentRoutingSnapshot | undefined) => {
		if (!value) return 'Destino no registrado';
		const level = value.supportLevel ?? 'Nivel no registrado';
		const team =
			value.teamId === null
				? 'Sin equipo'
				: teams.find(
						(item) => item.id === value.teamId && item.organizationId === entry.organizationId
					)?.name || 'Equipo no disponible';
		const assignee =
			value.assignedToUserId === null ? 'Sin asignar' : userName(value.assignedToUserId);
		return `${level} · ${team} (responsable: ${assignee})`;
	};
	switch (entry.eventType) {
		case 'created':
			return `${actor} creó la incidencia`;
		case 'assigned':
			return entry.newValue && entry.actorUserId === entry.newValue
				? `${actor} se asignó la incidencia`
				: `${actor} asignó la incidencia a ${userName(entry.newValue)}`;
		case 'reassigned':
			return `${actor} reasignó la incidencia de ${userName(entry.previousValue)} a ${userName(entry.newValue)}`;
		case 'escalated':
			return `${actor} escaló la incidencia de ${routing(entry.previousValue)} a ${routing(entry.newValue)}`;
		case 'status_changed':
			return `${actor} cambió el estado de ${entry.previousValue ? statuses[entry.previousValue] : 'Estado no registrado'} a ${entry.newValue ? statuses[entry.newValue] : 'Estado no registrado'}`;
		case 'priority_changed':
			return `${actor} cambió la prioridad de ${entry.previousValue ? priorities[entry.previousValue] : 'Prioridad no registrada'} a ${entry.newValue ? priorities[entry.newValue] : 'Prioridad no registrada'}`;
		case 'category_changed':
			return `${actor} cambió la categoría de ${categoryName(entry.previousValue)} a ${categoryName(entry.newValue)}`;
		case 'resolved':
			return `${actor} resolvió la incidencia${entry.previousValue ? ` (estado anterior: ${statuses[entry.previousValue.status]})` : ''}`;
	}
}

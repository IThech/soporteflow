import { canViewIncident } from '$lib/auth/record-access';
import { demoOrganization } from '$lib/data/organizations';
import { incidentOrganizationId } from './assignment';
import { SYSTEM_ACTOR_ID } from './history';
import type { Incident, IncidentPriority } from '$lib/types/incident';
import type { IncidentHistoryEntry, IncidentRoutingSnapshot } from '$lib/types/incident-history';
import type { AppUser } from '$lib/types/user';
import type { IncidentCategory } from '$lib/types/category';
import type { SupportTeam } from '$lib/types/support';
import type { Site } from '$lib/types/site';

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
	teams: SupportTeam[] = [],
	sites: Site[] = []
): string {
	const userName = (id: string | null | undefined, actor = false) => {
		if (id === SYSTEM_ACTOR_ID) return 'Sistema';
		return (
			users.find(
				(user) =>
					user.id === id &&
					(user.organizationId === entry.organizationId ||
						(actor && user.role === 'platform_admin'))
			)?.name || 'Usuario no disponible'
		);
	};
	const actor = userName(entry.actorUserId, true);
	const statuses: Record<string, string> = {
		open: 'Abierta',
		pending: 'Pendiente',
		resolved: 'Resuelta',
		closed: 'Cerrada'
	};
	const priorities: Record<IncidentPriority, string> = {
		urgent: 'Urgente',
		high: 'Alta',
		medium: 'Media',
		low: 'Baja'
	};
	const categoryName = (id: string | null | undefined) =>
		id === null
			? 'Sin categoría'
			: categories.find(
					(category) =>
						category.id === id &&
						(category.organizationId ?? demoOrganization.id) === entry.organizationId
				)?.name || 'Categoría no disponible';
	const siteName = (id: string | null | undefined) =>
		id === null
			? 'Sin sede'
			: sites.find(
					(site) =>
						site.id === id && (site.organizationId ?? demoOrganization.id) === entry.organizationId
				)?.name || 'Sede no disponible';
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
		case 'site_changed':
			return `${actor} cambió la sede de ${siteName(entry.previousValue)} a ${siteName(entry.newValue)}`;
		case 'resolved':
			return `${actor} resolvió la incidencia${entry.previousValue ? ` (estado anterior: ${statuses[entry.previousValue.status]})` : ''}`;
		case 'resolution_accepted':
			return `${actor} confirmó la solución`;
		case 'resolution_rejected':
			return `${actor} rechazó la solución y reabrió la incidencia`;
		case 'closed':
			return entry.actorUserId === SYSTEM_ACTOR_ID
				? 'La incidencia se cerró automáticamente por inactividad (24 h)'
				: `${actor} cerró la incidencia`;
		case 'reopened':
			return `${actor} reabrió la incidencia`;
		case 'reclassified': {
			if (!entry.newValue) return `${actor} reclasificó la incidencia`;
			const val = entry.newValue;
			const changes: string[] = [];

			if (val.previousCategoryId !== val.newCategoryId) {
				const prevCat = categoryName(val.previousCategoryId);
				const newCat = categoryName(val.newCategoryId);
				changes.push(`categoría de ${prevCat} a ${newCat}`);
			}

			if (val.previousSubcategoryId !== val.newSubcategoryId) {
				const prevSub = val.previousSubcategoryId ?? 'Sin subcategoría';
				const newSub = val.newSubcategoryId;
				changes.push(`subcategoría de ${prevSub} a ${newSub}`);
			}

			if (val.previousImpact !== val.newImpact) {
				const prevImp = val.previousImpact ?? 'Sin impacto';
				const newImp = val.newImpact;
				changes.push(`impacto de ${prevImp} a ${newImp}`);
			}

			const detail =
				changes.length > 0
					? changes.join(', ')
					: `categoría de ${categoryName(val.previousCategoryId)} a ${categoryName(val.newCategoryId)}`;

			const newPrio = priorities[val.newEffectivePriority] || val.newEffectivePriority;

			if (val.overrideRevoked) {
				const revokedPrio =
					priorities[val.overrideRevoked.previousTargetPriority] ||
					val.overrideRevoked.previousTargetPriority;
				return `${actor} reclasificó la incidencia (${detail}), restableciendo la prioridad calculada ${newPrio} y anulando el override previo (${revokedPrio})`;
			}

			return `${actor} reclasificó la incidencia (${detail}, prioridad calculada: ${newPrio})`;
		}
		case 'priority_override_applied': {
			if (!entry.newValue) return `${actor} estableció una excepción de prioridad`;
			const targetPrio =
				priorities[entry.newValue.newEffectivePriority] || entry.newValue.newEffectivePriority;
			const calcPrio =
				priorities[entry.newValue.calculatedPriority] || entry.newValue.calculatedPriority;
			return `${actor} estableció una excepción de prioridad a ${targetPrio} (prioridad calculada: ${calcPrio})`;
		}
		case 'priority_override_modified': {
			if (!entry.newValue) return `${actor} modificó la excepción de prioridad`;
			const prevPrio =
				priorities[entry.newValue.previousEffectivePriority] ||
				entry.newValue.previousEffectivePriority;
			const nextPrio =
				priorities[entry.newValue.newEffectivePriority] || entry.newValue.newEffectivePriority;
			const calcPrio =
				priorities[entry.newValue.calculatedPriority] || entry.newValue.calculatedPriority;
			return `${actor} modificó la excepción de prioridad de ${prevPrio} a ${nextPrio} (prioridad calculada: ${calcPrio})`;
		}
		case 'priority_override_removed': {
			if (!entry.newValue) return `${actor} retiró la excepción de prioridad`;
			const restoredPrio =
				priorities[entry.newValue.newEffectivePriority] || entry.newValue.newEffectivePriority;
			return `${actor} retiró la excepción de prioridad, restableciendo la prioridad calculada ${restoredPrio}`;
		}
	}
}

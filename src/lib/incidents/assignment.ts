import { canActOnIncident } from '$lib/auth/record-access';
import { demoOrganization } from '$lib/data/organizations';
import type { Incident } from '$lib/types/incident';
import type { IncidentHistoryEntry } from '$lib/types/incident-history';
import type { AppUser } from '$lib/types/user';

export const reassignmentReasons = [
	'Fin de turno',
	'Ausencia / vacaciones',
	'Requiere otra especialidad',
	'Escalado técnico',
	'Carga de trabajo',
	'Intervención presencial',
	'Otro'
] as const;
export const incidentOrganizationId = (incident: Incident) =>
	incident.organizationId ?? demoOrganization.id;

export function assignmentCandidates(incident: Incident, users: AppUser[]): AppUser[] {
	return users.filter(
		(user) =>
			user.active &&
			user.role === 'technician' &&
			user.organizationId === incidentOrganizationId(incident)
	);
}

export function requiresAssignmentReason(
	actor: AppUser,
	incident: Incident,
	targetId: string
): boolean {
	if (!targetId || targetId === incident.assignedToUserId) return false;
	return !!incident.assignedToUserId || (actor.role === 'technician' && targetId !== actor.id);
}

export function prepareAssignment(
	actor: AppUser,
	incident: Incident,
	users: AppUser[],
	targetId: string,
	reason = '',
	comment = ''
): { incident: Incident; event: IncidentHistoryEntry } | null {
	if (!canActOnIncident(actor, incident, 'incidents:assign'))
		throw new Error('No tienes permiso para asignar esta incidencia.');
	const target = assignmentCandidates(incident, users).find((user) => user.id === targetId);
	if (!target) throw new Error('Selecciona un técnico activo de la organización de la incidencia.');
	if (incident.assignedToUserId === target.id) return null;
	const cleanReason = reason.trim();
	if (requiresAssignmentReason(actor, incident, target.id) && !cleanReason)
		throw new Error('Indica un motivo para asignar trabajo a otro técnico.');
	const timestamp = new Date().toISOString();
	return {
		incident: { ...incident, assignedToUserId: target.id, updatedAt: timestamp },
		event: {
			id: crypto.randomUUID(),
			incidentId: incident.id,
			organizationId: incidentOrganizationId(incident),
			actorUserId: actor.id,
			timestamp,
			eventType: incident.assignedToUserId ? 'reassigned' : 'assigned',
			previousValue: incident.assignedToUserId || null,
			newValue: target.id,
			...(cleanReason ? { reason: cleanReason } : {}),
			...(comment.trim() ? { comment: comment.trim() } : {})
		}
	};
}

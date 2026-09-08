import { canActOnIncident } from '$lib/auth/record-access';
import {
	assignmentCandidates,
	incidentOrganizationId,
	prepareAssignment,
	canManageAssignment
} from './assignment';
import { supportLevels, type SupportLevel, type SupportTeam } from '$lib/types/support';
import type { Incident } from '$lib/types/incident';
import type { IncidentHistoryEntry, IncidentRoutingSnapshot } from '$lib/types/incident-history';
import type { AppUser } from '$lib/types/user';

export interface EscalationInput {
	// Omitted fields preserve the current value, including legacy missing values.
	supportLevel?: SupportLevel;
	teamId?: string;
	assignedToUserId?: string;
	reason: string;
	comment?: string;
}
export function escalationTeams(incident: Incident, teams: SupportTeam[]): SupportTeam[] {
	return teams.filter(
		(team) => team.active && team.organizationId === incidentOrganizationId(incident)
	);
}
export function canEscalate(user: AppUser, incident: Incident): boolean {
	return canActOnIncident(user, incident, 'incidents:edit') && canManageAssignment(user, incident);
}
export function prepareEscalation(
	actor: AppUser,
	incident: Incident,
	users: AppUser[],
	teams: SupportTeam[],
	input: EscalationInput
): { incident: Incident; event: IncidentHistoryEntry } | null {
	if (!canEscalate(actor, incident))
		throw new Error('No tienes permiso para escalar esta incidencia.');
	const level = input.supportLevel === undefined ? incident.supportLevel : input.supportLevel;
	const team = input.teamId === undefined ? incident.teamId : input.teamId;
	const assignee =
		input.assignedToUserId === undefined ? incident.assignedToUserId : input.assignedToUserId;
	if (input.supportLevel !== undefined && !supportLevels.includes(input.supportLevel))
		throw new Error('Selecciona un nivel válido.');
	const routingChanged = level !== incident.supportLevel || team !== incident.teamId;
	const assigneeChanged = assignee !== incident.assignedToUserId;
	if (!routingChanged) {
		if (!assigneeChanged) return null;
		// Responsible-only changes remain assignment/reassignment, never escalation.
		return prepareAssignment(actor, incident, users, assignee ?? '', input.reason, input.comment);
	}
	if (
		team !== incident.teamId &&
		!escalationTeams(incident, teams).some((item) => item.id === team)
	)
		throw new Error('Selecciona un equipo activo de la organización de la incidencia.');
	if (
		assigneeChanged &&
		!assignmentCandidates(incident, users).some((user) => user.id === assignee)
	)
		throw new Error('Selecciona un técnico activo de la organización de la incidencia.');
	const reason = input.reason.trim();
	if (!reason) throw new Error('Describe el motivo del escalado.');
	const timestamp = new Date().toISOString();
	const updated: Incident = {
		...incident,
		updatedAt: timestamp,
		...(level !== incident.supportLevel ? { supportLevel: level } : {}),
		...(team !== incident.teamId ? { teamId: team } : {}),
		...(assigneeChanged ? { assignedToUserId: assignee } : {})
	};
	const snapshot = (item: Incident): IncidentRoutingSnapshot => ({
		supportLevel: item.supportLevel ?? null,
		teamId: item.teamId || null,
		assignedToUserId: item.assignedToUserId || null
	});
	return {
		incident: updated,
		event: {
			id: crypto.randomUUID(),
			incidentId: incident.id,
			organizationId: incidentOrganizationId(incident),
			actorUserId: actor.id,
			timestamp,
			eventType: 'escalated',
			previousValue: snapshot(incident),
			newValue: snapshot(updated),
			reason,
			...(input.comment?.trim() ? { comment: input.comment.trim() } : {})
		}
	};
}

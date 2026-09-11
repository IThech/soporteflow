import { canActOnIncident } from '$lib/auth/record-access';
import {
	assignmentCandidates,
	canAssignTo,
	incidentOrganizationId,
	prepareAssignment,
	canManageAssignment,
	resolveInitialRouting,
	shouldInheritInitialRouting
} from './assignment';
import { demoSupportLevels } from '$lib/data/support-levels';
import { demoSupportTeams } from '$lib/data/teams';
import type { SupportLevel, SupportLevelDefinition, SupportTeam } from '$lib/types/support';
import type { Incident } from '$lib/types/incident';
import type { IncidentCategory } from '$lib/types/category';
import type { IncidentHistoryEntry, IncidentRoutingSnapshot } from '$lib/types/incident-history';
import type { AppUser } from '$lib/types/user';

export interface UnifiedAssignmentInput {
	assignedToUserId?: string;
	supportLevel?: SupportLevel;
	teamId?: string;
	reason?: string;
	comment?: string;
}

export interface EscalationInput {
	// Omitted fields preserve the current value, including legacy missing values.
	categoryId?: string;
	supportLevel?: SupportLevel;
	teamId?: string;
	assignedToUserId?: string;
	reason: string;
	comment?: string;
}

export interface ClassificationChangeInput {
	categoryId?: string;
	supportLevel?: SupportLevel;
	teamId?: string;
	reason: string;
	comment?: string;
}

export function escalationTeams(incident: Incident, teams: SupportTeam[]): SupportTeam[] {
	return teams.filter(
		(team) => team.active && team.organizationId === incidentOrganizationId(incident)
	);
}

export function escalationLevels(
	incident: Incident,
	levels: SupportLevelDefinition[]
): SupportLevelDefinition[] {
	return levels
		.filter((level) => level.active && level.organizationId === incidentOrganizationId(incident))
		.sort((a, b) => a.order - b.order);
}

export function canEscalate(user: AppUser, incident: Incident): boolean {
	return canActOnIncident(user, incident, 'incidents:edit') && canManageAssignment(user, incident);
}

export function prepareEscalation(
	actor: AppUser,
	incident: Incident,
	users: AppUser[],
	teams: SupportTeam[],
	input: EscalationInput,
	levels: SupportLevelDefinition[] = demoSupportLevels
): { incident: Incident; event: IncidentHistoryEntry } | null {
	if (!canEscalate(actor, incident))
		throw new Error('No tienes permiso para escalar esta incidencia.');

	const rawCategory = input.categoryId?.trim() ? input.categoryId.trim() : undefined;
	const rawLevel = input.supportLevel?.trim() ? input.supportLevel.trim() : undefined;
	const rawTeam = input.teamId?.trim() ? input.teamId.trim() : undefined;
	const rawAssignee = input.assignedToUserId?.trim() ? input.assignedToUserId.trim() : undefined;

	const category = rawCategory === undefined ? incident.categoryId : rawCategory;
	let level = rawLevel === undefined ? incident.supportLevel : rawLevel;
	const team = rawTeam === undefined ? incident.teamId : rawTeam;
	const assignee = rawAssignee === undefined ? incident.assignedToUserId : rawAssignee;

	if (level !== incident.supportLevel && level !== undefined) {
		const available = escalationLevels(incident, levels);
		const normalizedLevel = level.trim().toUpperCase();
		const matchedLevel = available.find((l) => l.code.toUpperCase() === normalizedLevel);
		if (!matchedLevel) {
			throw new Error('Selecciona un nivel activo de la organización de la incidencia.');
		}
		level = matchedLevel.code;
	}

	const routingChanged = level !== incident.supportLevel || team !== incident.teamId;
	const assigneeChanged = assignee !== incident.assignedToUserId;
	const categoryChanged = category !== incident.categoryId;

	if (!routingChanged) {
		if (categoryChanged && !assigneeChanged) {
			// Pure category change delegates to classification change event
			return prepareClassificationChange(
				actor,
				incident,
				{
					categoryId: category,
					reason: input.reason,
					comment: input.comment
				},
				{ levels, teams }
			);
		}
		if (!assigneeChanged) return null;
		// Responsible-only changes remain assignment/reassignment, never escalation.
		return prepareAssignment(actor, incident, users, assignee ?? '', input.reason, input.comment, {
			levels,
			teams
		});
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
		...(category !== undefined ? { categoryId: category } : {}),
		...(level !== undefined ? { supportLevel: level } : {}),
		...(team !== undefined ? { teamId: team } : {}),
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

export function prepareClassificationChange(
	actor: AppUser,
	incident: Incident,
	input: ClassificationChangeInput,
	catalogs?: {
		levels?: SupportLevelDefinition[];
		teams?: SupportTeam[];
		categories?: IncidentCategory[];
	}
): { incident: Incident; event: IncidentHistoryEntry } | null {
	if (!canActOnIncident(actor, incident, 'incidents:edit')) {
		throw new Error('No tienes permiso para modificar la clasificación de esta incidencia.');
	}

	const levels = catalogs?.levels ?? demoSupportLevels;
	const teams = catalogs?.teams ?? demoSupportTeams;

	const rawCategory = input.categoryId?.trim() || undefined;
	const rawLevel = input.supportLevel?.trim() ? input.supportLevel.trim() : undefined;
	const rawTeam = input.teamId?.trim() ? input.teamId.trim() : undefined;

	const targetCategory = rawCategory !== undefined ? rawCategory : incident.categoryId;
	let targetLevel = rawLevel !== undefined ? rawLevel : incident.supportLevel;
	const targetTeam = rawTeam !== undefined ? rawTeam : incident.teamId;

	if (levelChangedCandidate(targetLevel, incident.supportLevel)) {
		const available = escalationLevels(incident, levels);
		const normalized = (targetLevel || '').trim().toUpperCase();
		const matchedLevel = available.find((l) => l.code.toUpperCase() === normalized);
		if (!matchedLevel) {
			throw new Error('Selecciona un nivel activo de la organización de la incidencia.');
		}
		targetLevel = matchedLevel.code;
	}

	if (
		targetTeam !== incident.teamId &&
		targetTeam !== undefined &&
		!escalationTeams(incident, teams).some((t) => t.id === targetTeam)
	) {
		throw new Error('Selecciona un equipo activo de la organización de la incidencia.');
	}

	const categoryChanged = targetCategory !== incident.categoryId;
	const levelChanged = targetLevel !== incident.supportLevel;
	const teamChanged = targetTeam !== incident.teamId;

	if (!categoryChanged && !levelChanged && !teamChanged) {
		return null;
	}

	const reason = input.reason?.trim();
	if (!reason) {
		throw new Error('Describe el motivo del cambio de clasificación.');
	}

	if (categoryChanged && targetCategory && catalogs?.categories) {
		const orgId = incidentOrganizationId(incident);
		const matchedCat = catalogs.categories.find(
			(c) => c.id === targetCategory && (!c.organizationId || c.organizationId === orgId)
		);
		if (!matchedCat) {
			throw new Error('Selecciona una categoría válida de la organización de la incidencia.');
		}
	}

	const timestamp = new Date().toISOString();
	const updated: Incident = {
		...incident,
		updatedAt: timestamp,
		...(targetCategory !== undefined ? { categoryId: targetCategory } : {}),
		...(targetLevel !== undefined ? { supportLevel: targetLevel } : {}),
		...(targetTeam !== undefined ? { teamId: targetTeam } : {})
	};

	const snapshot = (item: Incident): IncidentRoutingSnapshot => ({
		supportLevel: item.supportLevel ?? null,
		teamId: item.teamId || null,
		assignedToUserId: item.assignedToUserId || null
	});

	if (levelChanged || teamChanged) {
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

	// Only category changed
	return {
		incident: updated,
		event: {
			id: crypto.randomUUID(),
			incidentId: incident.id,
			organizationId: incidentOrganizationId(incident),
			actorUserId: actor.id,
			timestamp,
			eventType: 'category_changed',
			previousValue: incident.categoryId || null,
			newValue: targetCategory || null,
			reason,
			...(input.comment?.trim() ? { comment: input.comment.trim() } : {})
		}
	};
}

function levelChangedCandidate(candidate?: string, current?: string): boolean {
	if (candidate === undefined && current === undefined) return false;
	if (candidate === undefined || current === undefined) return true;
	return candidate.trim().toUpperCase() !== current.trim().toUpperCase();
}

export function prepareUnifiedAssignment(
	actor: AppUser,
	incident: Incident,
	users: AppUser[],
	teams: SupportTeam[],
	input: UnifiedAssignmentInput,
	levels: SupportLevelDefinition[] = demoSupportLevels
): { incident: Incident; event: IncidentHistoryEntry } | null {
	const rawAssignee = input.assignedToUserId?.trim() ? input.assignedToUserId.trim() : undefined;
	const rawLevel = input.supportLevel?.trim() ? input.supportLevel.trim() : undefined;
	const rawTeam = input.teamId?.trim() ? input.teamId.trim() : undefined;

	const currentAssignee = incident.assignedToUserId?.trim() || undefined;
	const currentLevel = incident.supportLevel?.trim() || undefined;
	const currentTeam = incident.teamId?.trim() || undefined;

	const targetAssignee = rawAssignee !== undefined ? rawAssignee : currentAssignee;
	const targetLevel = rawLevel !== undefined ? rawLevel : currentLevel;
	const targetTeam = rawTeam !== undefined ? rawTeam : currentTeam;

	const isSelfAssign =
		!incident.assignedToUserId && actor.role === 'technician' && targetAssignee === actor.id;

	if (!canManageAssignment(actor, incident) && !isSelfAssign) {
		throw new Error('No tienes permiso para gestionar la asignación de esta incidencia.');
	}

	const assigneeChanged = targetAssignee !== currentAssignee;
	const normalizedCurrentLevel = currentLevel?.toUpperCase();
	const normalizedTargetLevel = targetLevel?.toUpperCase();
	const levelChanged = normalizedTargetLevel !== normalizedCurrentLevel;
	const teamChanged = targetTeam !== currentTeam;

	if (!assigneeChanged && !levelChanged && !teamChanged) {
		return null;
	}

	let matchedCandidate: AppUser | undefined;
	if (assigneeChanged) {
		if (!targetAssignee) {
			throw new Error('Selecciona un técnico activo de la organización de la incidencia.');
		}
		const candidates = assignmentCandidates(incident, users);
		matchedCandidate = candidates.find((u) => u.id === targetAssignee);
		if (!matchedCandidate) {
			throw new Error('Selecciona un técnico activo de la organización de la incidencia.');
		}
		if (!canAssignTo(actor, incident, targetAssignee, levels)) {
			throw new Error('No tienes permiso para asignar esta incidencia a este usuario.');
		}
	}

	let canonicalLevel = targetLevel;
	if (levelChanged) {
		if (!targetLevel) {
			throw new Error('Selecciona un nivel activo de la organización de la incidencia.');
		}
		const availableLevels = escalationLevels(incident, levels);
		const matchedLevel = availableLevels.find(
			(l) => l.code.toUpperCase() === targetLevel.toUpperCase()
		);
		if (!matchedLevel) {
			throw new Error('Selecciona un nivel activo de la organización de la incidencia.');
		}
		canonicalLevel = matchedLevel.code;
	}

	if (teamChanged) {
		if (!targetTeam) {
			throw new Error('Selecciona un equipo activo de la organización de la incidencia.');
		}
		const availableTeams = escalationTeams(incident, teams);
		const matchedTeam = availableTeams.find((t) => t.id === targetTeam);
		if (!matchedTeam) {
			throw new Error('Selecciona un equipo activo de la organización de la incidencia.');
		}
	}

	const isInitial =
		!incident.assignedToUserId && assigneeChanged && !!targetAssignee && !!matchedCandidate;
	const initialRoutingCandidate =
		isInitial && shouldInheritInitialRouting(incident) ? matchedCandidate : undefined;
	const candidateInheritedRouting = initialRoutingCandidate
		? resolveInitialRouting(incident, initialRoutingCandidate, { levels, teams })
		: undefined;

	const isInitialInheritance =
		isInitial &&
		shouldInheritInitialRouting(incident) &&
		(rawLevel === undefined ||
			rawLevel.toUpperCase() === (candidateInheritedRouting?.supportLevel ?? '').toUpperCase()) &&
		(rawTeam === undefined || rawTeam === (candidateInheritedRouting?.teamId ?? ''));

	let defaultReason = input.reason?.trim();
	if (!defaultReason) {
		if (
			isInitialInheritance ||
			(!incident.assignedToUserId && assigneeChanged && !levelChanged && !teamChanged)
		) {
			defaultReason = 'Asignación inicial de incidencia';
		} else if (assigneeChanged && !levelChanged && !teamChanged) {
			defaultReason = 'Reasignación de responsable';
		} else if (levelChanged && !teamChanged && !assigneeChanged) {
			defaultReason = 'Cambio de nivel de soporte';
		} else if (!levelChanged && teamChanged && !assigneeChanged) {
			defaultReason = 'Cambio de equipo de soporte';
		} else if (levelChanged && teamChanged && !assigneeChanged) {
			defaultReason = 'Cambio de nivel y equipo de soporte';
		} else if (assigneeChanged && (levelChanged || teamChanged)) {
			defaultReason = 'Reasignación y escalado de soporte';
		} else {
			defaultReason = 'Actualización de asignación';
		}
	}

	if (
		isInitialInheritance ||
		(!incident.assignedToUserId && assigneeChanged && !levelChanged && !teamChanged)
	) {
		return prepareAssignment(
			actor,
			incident,
			users,
			targetAssignee!,
			defaultReason,
			input.comment?.trim() || '',
			{ levels, teams }
		);
	}

	if (assigneeChanged && !levelChanged && !teamChanged) {
		return prepareAssignment(
			actor,
			incident,
			users,
			targetAssignee!,
			defaultReason,
			input.comment?.trim() || '',
			{ levels, teams }
		);
	}

	return prepareEscalation(
		actor,
		incident,
		users,
		teams,
		{
			...(canonicalLevel !== undefined ? { supportLevel: canonicalLevel } : {}),
			...(targetTeam !== undefined ? { teamId: targetTeam } : {}),
			...(targetAssignee !== undefined ? { assignedToUserId: targetAssignee } : {}),
			reason: defaultReason,
			comment: input.comment?.trim()
		},
		levels
	);
}

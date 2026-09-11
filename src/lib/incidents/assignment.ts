import type { ReassignmentReason } from '$lib/types/reassignment-reason';
import { resolveReason } from '$lib/reasons/catalog';
import { canActOnIncident } from '$lib/auth/record-access';
import { demoOrganization } from '$lib/data/organizations';
import { demoSupportLevels } from '$lib/data/support-levels';
import { demoSupportTeams } from '$lib/data/teams';
import type { Incident } from '$lib/types/incident';
import type { IncidentHistoryEntry } from '$lib/types/incident-history';
import type { AppUser } from '$lib/types/user';
import type { SupportLevel, SupportLevelDefinition, SupportTeam } from '$lib/types/support';

export const incidentOrganizationId = (incident: Incident) =>
	incident.organizationId ?? demoOrganization.id;

export function assignmentCandidates(incident: Incident, users: AppUser[]): AppUser[] {
	return users.filter(
		(user) =>
			user.active &&
			(user.role === 'technician' ||
				(user.role === 'organization_admin' && !!(user.supportLevel || user.teamId))) &&
			user.organizationId === incidentOrganizationId(incident)
	);
}

export function canManageAssignment(actor: AppUser, incident: Incident): boolean {
	return (
		canActOnIncident(actor, incident, 'incidents:assign') &&
		(actor.role !== 'technician' || incident.assignedToUserId === actor.id)
	);
}

export function isCandidateLevelCompatible(
	candidate: AppUser,
	incident: Incident,
	levels: SupportLevelDefinition[] = demoSupportLevels
): boolean {
	const incLevel = incident.supportLevel?.trim();
	if (!incLevel) {
		return true;
	}

	const candLevel = candidate.supportLevel?.trim();
	if (!candLevel) {
		return false;
	}

	const orgId = incidentOrganizationId(incident);
	if (candidate.organizationId !== orgId) {
		return false;
	}

	const normInc = incLevel.toUpperCase();
	const normCand = candLevel.toUpperCase();

	if (normCand === normInc) {
		return true;
	}

	let incDef = levels.find((l) => l.organizationId === orgId && l.code.toUpperCase() === normInc);
	let candDef = levels.find((l) => l.organizationId === orgId && l.code.toUpperCase() === normCand);

	if ((!incDef || !candDef) && !levels.some((l) => l.organizationId === orgId)) {
		incDef = levels.find((l) => l.code.toUpperCase() === normInc);
		candDef = levels.find((l) => l.code.toUpperCase() === normCand);
	}

	if (!candDef || !incDef) {
		return false;
	}

	if (!incDef.active) {
		return true;
	}

	return candDef.order >= incDef.order;
}

export interface AssigneeLevelIncompatibility {
	incompatible: true;
	assigneeName: string;
	assigneeLevel?: string;
	requiredLevel: string;
	message: string;
}

export function getAssigneeLevelIncompatibility(
	incident: Incident,
	assignee: AppUser | undefined | null,
	levels: SupportLevelDefinition[] = demoSupportLevels
): AssigneeLevelIncompatibility | null {
	if (!incident.assignedToUserId || !assignee) {
		return null;
	}
	const incLevel = incident.supportLevel?.trim();
	if (!incLevel) {
		return null;
	}

	const isCompatible = isCandidateLevelCompatible(assignee, incident, levels);
	if (isCompatible) {
		return null;
	}

	const assigneeLevel = assignee.supportLevel?.trim();
	const message = assigneeLevel
		? `${assignee.name} tiene nivel ${assigneeLevel} y esta incidencia requiere ${incLevel}. Reasigna la incidencia a un responsable compatible.`
		: `${assignee.name} no tiene nivel de soporte configurado y esta incidencia requiere ${incLevel}. Reasigna la incidencia a un responsable compatible.`;

	return {
		incompatible: true,
		assigneeName: assignee.name,
		...(assigneeLevel ? { assigneeLevel } : {}),
		requiredLevel: incLevel,
		message
	};
}

export function canAssignTo(
	actor: AppUser,
	incident: Incident,
	targetId: string,
	levels: SupportLevelDefinition[] = demoSupportLevels
): boolean {
	const hasPermission =
		canActOnIncident(actor, incident, 'incidents:assign') &&
		(actor.role !== 'technician' ||
			(incident.assignedToUserId ? incident.assignedToUserId === actor.id : targetId === actor.id));

	if (!hasPermission) return false;

	if (actor.role === 'technician' && targetId === actor.id) {
		return isCandidateLevelCompatible(actor, incident, levels);
	}

	return true;
}

export function requiresAssignmentReason(
	actor: AppUser,
	incident: Incident,
	targetId: string
): boolean {
	if (!targetId || targetId === incident.assignedToUserId) return false;
	return !!incident.assignedToUserId || (actor.role === 'technician' && targetId !== actor.id);
}

export function shouldInheritInitialRouting(incident: Incident): boolean {
	return (
		!incident.assignedToUserId &&
		(!incident.supportLevel || incident.supportLevel.trim() === '') &&
		(!incident.teamId || incident.teamId.trim() === '')
	);
}

export function resolveInitialRouting(
	incident: Incident,
	assignee: AppUser,
	catalogs?: {
		levels?: SupportLevelDefinition[];
		teams?: SupportTeam[];
	}
): { supportLevel?: SupportLevel; teamId?: string } {
	if (!shouldInheritInitialRouting(incident)) {
		return {
			...(incident.supportLevel !== undefined ? { supportLevel: incident.supportLevel } : {}),
			...(incident.teamId !== undefined ? { teamId: incident.teamId } : {})
		};
	}

	const orgId = incidentOrganizationId(incident);
	const levels = catalogs?.levels ?? demoSupportLevels;
	const teams = catalogs?.teams ?? demoSupportTeams;

	let inheritedLevel: SupportLevel | undefined;
	let inheritedTeamId: string | undefined;

	if (assignee.supportLevel && assignee.supportLevel.trim().length > 0) {
		const normalized = assignee.supportLevel.trim().toUpperCase();
		const matched = levels.find(
			(level) =>
				level.active && level.organizationId === orgId && level.code.toUpperCase() === normalized
		);
		if (matched) {
			inheritedLevel = matched.code;
		}
	}

	if (assignee.teamId && assignee.teamId.trim().length > 0) {
		const matched = teams.find(
			(team) => team.active && team.organizationId === orgId && team.id === assignee.teamId
		);
		if (matched) {
			inheritedTeamId = matched.id;
		}
	}

	return {
		...(inheritedLevel !== undefined ? { supportLevel: inheritedLevel } : {}),
		...(inheritedTeamId !== undefined ? { teamId: inheritedTeamId } : {})
	};
}

export function applyInitialRouting(
	incident: Incident,
	assignee: AppUser,
	catalogs?: {
		levels?: SupportLevelDefinition[];
		teams?: SupportTeam[];
	}
): Incident {
	if (!shouldInheritInitialRouting(incident)) {
		return incident;
	}
	const routing = resolveInitialRouting(incident, assignee, catalogs);
	return {
		...incident,
		...routing
	};
}

export function prepareAssignment(
	actor: AppUser,
	incident: Incident,
	users: AppUser[],
	targetId: string,
	reason = '',
	comment = '',
	catalogs?: {
		levels?: SupportLevelDefinition[];
		teams?: SupportTeam[];
	}
): { incident: Incident; event: IncidentHistoryEntry } | null {
	if (!canAssignTo(actor, incident, targetId, catalogs?.levels))
		throw new Error('No tienes permiso para asignar esta incidencia.');
	const target = assignmentCandidates(incident, users).find((user) => user.id === targetId);
	if (!target) throw new Error('Selecciona un técnico activo de la organización de la incidencia.');
	if (!isCandidateLevelCompatible(target, incident, catalogs?.levels))
		throw new Error(
			'El responsable seleccionado no tiene el nivel requerido para esta incidencia.'
		);
	if (incident.assignedToUserId === target.id) return null;
	const cleanReason = reason.trim();
	if (requiresAssignmentReason(actor, incident, target.id) && !cleanReason)
		throw new Error('Indica un motivo para asignar trabajo a otro técnico.');
	const timestamp = new Date().toISOString();
	const isInitial = !incident.assignedToUserId;
	const routing = isInitial
		? resolveInitialRouting(incident, target, catalogs)
		: {
				...(incident.supportLevel !== undefined ? { supportLevel: incident.supportLevel } : {}),
				...(incident.teamId !== undefined ? { teamId: incident.teamId } : {})
			};

	return {
		incident: {
			...incident,
			assignedToUserId: target.id,
			updatedAt: timestamp,
			...routing
		},
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

export function prepareCatalogAssignment(
	actor: AppUser,
	incident: Incident,
	users: AppUser[],
	targetId: string,
	reasons: ReassignmentReason[],
	selection: string,
	manual: string,
	comment = '',
	catalogs?: {
		levels?: SupportLevelDefinition[];
		teams?: SupportTeam[];
	}
) {
	const reason = requiresAssignmentReason(actor, incident, targetId)
		? resolveReason(reasons, incidentOrganizationId(incident), selection, manual)
		: '';
	return prepareAssignment(actor, incident, users, targetId, reason, comment, catalogs);
}

export { prepareUnifiedAssignment, type UnifiedAssignmentInput } from './escalation';

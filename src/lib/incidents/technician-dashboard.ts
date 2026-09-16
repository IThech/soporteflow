import {
	incidentOrganizationId,
	isCandidateLevelCompatible,
	getAssigneeLevelIncompatibility
} from './assignment';
import { evaluateIncidentSla } from './sla';
import { isIncidentReopened } from './lifecycle';
import type { Incident, IncidentPriority } from '$lib/types/incident';
import type { IncidentHistoryEntry, IncidentHistoryEventType } from '$lib/types/incident-history';
import type { IncidentMessage } from '$lib/types/incident-message';
import type { AppUser } from '$lib/types/user';
import type { SupportLevelDefinition } from '$lib/types/support';
import type { IncidentCategory } from '$lib/types/category';
import type {
	AttentionReason,
	AttentionReasonType,
	AttentionIncidentItem,
	TechnicianDashboardSummary,
	TechnicianActivityMetrics,
	CategoryDistribution,
	LevelDistribution
} from '$lib/types/technician-dashboard';

export const ATTENTION_RANKS: Record<AttentionReasonType, number> = {
	client_responded: 1,
	reopened: 1,
	sla_breached: 2,
	sla_approaching: 3,
	incompatible_level: 4,
	high_priority: 5
};

/**
 * Relevant history events by staff that count as attending to an incident.
 * Management/administrative actions (category, priority, site, assignment) do NOT count as attending.
 */
const STAFF_ATTENTION_HISTORY_EVENTS: IncidentHistoryEventType[] = ['resolved', 'status_changed'];

/**
 * Formats a timestamp into a concise Spanish relative time description.
 */
export function formatRelativeTimeAgo(timestampMs: number, nowMs: number = Date.now()): string {
	const diffMs = Math.max(0, nowMs - timestampMs);
	const diffMinutes = Math.floor(diffMs / 60000);
	if (diffMinutes < 1) return 'ahora mismo';
	if (diffMinutes < 60) return `hace ${diffMinutes} min`;
	const diffHours = Math.floor(diffMinutes / 60);
	if (diffHours < 24) return `hace ${diffHours} h`;
	const diffDays = Math.floor(diffHours / 24);
	return `hace ${diffDays} d`;
}

/**
 * Returns the timestamp of the latest client public response if it has not yet been attended to
 * by operational staff, or null if no response is pending.
 *
 * Principle: "Ver != Atender"
 * Viewing the incident does not extinguish this warning.
 *
 * Attending actions:
 * - A subsequent public comment by operational staff (technician, org_admin, platform_admin).
 * - A subsequent status change ('status_changed') performed by operational staff.
 * - A subsequent resolution ('resolved') performed by operational staff.
 */
export function getClientPendingResponseTimestamp(
	incident: Incident,
	messages: IncidentMessage[],
	users: AppUser[],
	history: IncidentHistoryEntry[] = []
): number | null {
	const orgId = incidentOrganizationId(incident);

	// Relevant public messages for this incident in this org
	const incidentMessages = messages.filter(
		(m) => m.incidentId === incident.id && m.organizationId === orgId && m.visibility === 'public'
	);

	// Find user helper
	const getUser = (userId: string) => users.find((u) => u.id === userId);

	// Client messages: author role is client or author is incident clientUserId
	const clientMessages = incidentMessages.filter((m) => {
		const author = getUser(m.authorUserId);
		return (
			author?.role === 'client' ||
			(incident.clientUserId && m.authorUserId === incident.clientUserId)
		);
	});

	if (clientMessages.length === 0) {
		return null;
	}

	// Latest client public message timestamp
	const clientTimestamps = clientMessages
		.map((m) => Date.parse(m.createdAt))
		.filter((t) => Number.isFinite(t));
	if (clientTimestamps.length === 0) {
		return null;
	}
	const lastClientTime = Math.max(...clientTimestamps);

	// Staff actions:
	// 1. Staff public messages
	const staffMessages = incidentMessages.filter((m) => {
		const author = getUser(m.authorUserId);
		return (
			author?.role === 'technician' ||
			author?.role === 'organization_admin' ||
			author?.role === 'platform_admin'
		);
	});
	const staffMsgTimes = staffMessages
		.map((m) => Date.parse(m.createdAt))
		.filter((t) => Number.isFinite(t));

	// 2. Staff relevant history events (status_changed, resolved)
	const incidentHistory = history.filter(
		(h) =>
			h.incidentId === incident.id &&
			h.organizationId === orgId &&
			STAFF_ATTENTION_HISTORY_EVENTS.includes(h.eventType)
	);
	const staffHistory = incidentHistory.filter((h) => {
		const actor = getUser(h.actorUserId);
		return (
			actor?.role === 'technician' ||
			actor?.role === 'organization_admin' ||
			actor?.role === 'platform_admin'
		);
	});
	const staffHistoryTimes = staffHistory
		.map((h) => Date.parse(h.timestamp))
		.filter((t) => Number.isFinite(t));

	// 3. Incident creation timestamp (initial state)
	const createdTime = Date.parse(incident.createdAt);

	const allStaffActionTimes = [createdTime, ...staffMsgTimes, ...staffHistoryTimes].filter((t) =>
		Number.isFinite(t)
	);

	const lastStaffActionTime = Math.max(...allStaffActionTimes);

	return lastClientTime > lastStaffActionTime ? lastClientTime : null;
}

/**
 * Determines whether a client has posted a public response that has not yet been attended to
 * by operational staff.
 */
export function hasClientRespondedPendingStaff(
	incident: Incident,
	messages: IncidentMessage[],
	users: AppUser[],
	history: IncidentHistoryEntry[] = []
): boolean {
	return getClientPendingResponseTimestamp(incident, messages, users, history) !== null;
}

/**
 * Returns the timestamp of the reopening event for an incident, or null if not reopened.
 */
export function getIncidentReopenTimestamp(
	incident: Incident,
	history: IncidentHistoryEntry[] = []
): number | null {
	const orgId = incidentOrganizationId(incident);
	const reopenEntries = history.filter(
		(h) =>
			h.incidentId === incident.id &&
			h.organizationId === orgId &&
			(h.eventType === 'reopened' || h.eventType === 'resolution_rejected')
	);
	if (reopenEntries.length > 0) {
		const times = reopenEntries
			.map((h) => Date.parse(h.timestamp))
			.filter((t) => Number.isFinite(t));
		if (times.length > 0) {
			return Math.max(...times);
		}
	}
	if (isIncidentReopened(incident, history)) {
		const fallbackTime = Date.parse(
			incident.resolvedAt || incident.updatedAt || incident.createdAt
		);
		return Number.isFinite(fallbackTime) ? fallbackTime : null;
	}
	return null;
}

/**
 * Computes all applicable attention reasons for a given incident.
 * An incident only qualifies for attention if it is active (open or pending) and assigned to activeUser.
 */
export function getIncidentAttentionReasons(
	incident: Incident,
	activeUser: AppUser,
	history: IncidentHistoryEntry[] = [],
	messages: IncidentMessage[] = [],
	users: AppUser[] = [],
	levels: SupportLevelDefinition[] = [],
	now: Date | string | number = new Date()
): AttentionReason[] {
	// Must be assigned to this user and active (open or pending)
	if (
		incident.assignedToUserId !== activeUser.id ||
		(incident.status !== 'open' && incident.status !== 'pending') ||
		incidentOrganizationId(incident) !== activeUser.organizationId
	) {
		return [];
	}

	const nowMs =
		typeof now === 'number' ? now : typeof now === 'string' ? Date.parse(now) : now.getTime();
	const reasons: AttentionReason[] = [];

	// Tier 1: Cliente ha respondido y todavía no ha sido atendido
	const clientRespTime = getClientPendingResponseTimestamp(incident, messages, users, history);
	if (clientRespTime !== null) {
		reasons.push({
			type: 'client_responded',
			label: 'Cliente respondió',
			priorityRank: ATTENTION_RANKS.client_responded,
			eventTimestamp: clientRespTime,
			timeAgo: formatRelativeTimeAgo(clientRespTime, nowMs)
		});
	}

	// Tier 1: Incidencia reabierta
	const reopenTime = getIncidentReopenTimestamp(incident, history);
	if (reopenTime !== null) {
		reasons.push({
			type: 'reopened',
			label: 'Reabierta',
			priorityRank: ATTENTION_RANKS.reopened,
			eventTimestamp: reopenTime
		});
	}

	// Tier 2: SLA incumplido / Tier 3: SLA próximo
	const slaEval = evaluateIncidentSla(incident, now);
	if (slaEval.status === 'breached') {
		reasons.push({
			type: 'sla_breached',
			label: 'SLA incumplido',
			priorityRank: ATTENTION_RANKS.sla_breached
		});
	} else if (slaEval.status === 'approaching') {
		reasons.push({
			type: 'sla_approaching',
			label: 'SLA próximo',
			priorityRank: ATTENTION_RANKS.sla_approaching
		});
	}

	// Tier 4: Responsable incompatible con el nivel requerido actual
	const incomp = getAssigneeLevelIncompatibility(incident, activeUser, levels);
	if (incomp) {
		reasons.push({
			type: 'incompatible_level',
			label: 'Nivel incompatible',
			priorityRank: ATTENTION_RANKS.incompatible_level,
			detail: incomp.message
		});
	}

	// Tier 5: Prioridad alta o urgente
	if (incident.priority === 'urgent' || incident.priority === 'high') {
		reasons.push({
			type: 'high_priority',
			label: incident.priority === 'urgent' ? 'Prioridad urgente' : 'Prioridad alta',
			priorityRank: ATTENTION_RANKS.high_priority
		});
	}

	// Sort reasons within this incident:
	// Lower priorityRank first. If both are Tier 1 (rank 1), newest eventTimestamp first.
	return reasons.sort((a, b) => {
		if (a.priorityRank !== b.priorityRank) {
			return a.priorityRank - b.priorityRank;
		}
		if (a.priorityRank === 1) {
			const tA = a.eventTimestamp ?? 0;
			const tB = b.eventTimestamp ?? 0;
			if (tA !== tB) return tB - tA;
		}
		return 0;
	});
}

/**
 * Returns prioritized list of incidents requiring technician attention.
 * Each incident appears once, ordered by primary rank (1 to 5).
 * Within Tier 1, ordered descending by eventTimestamp (newest interaction first).
 * In other tiers or ties, ordered by incident.createdAt ascending (oldest first).
 */
export function getAttentionIncidents(
	incidents: Incident[],
	activeUser: AppUser,
	history: IncidentHistoryEntry[] = [],
	messages: IncidentMessage[] = [],
	users: AppUser[] = [],
	levels: SupportLevelDefinition[] = [],
	now: Date | string | number = new Date()
): AttentionIncidentItem[] {
	const items: AttentionIncidentItem[] = [];

	for (const inc of incidents) {
		const reasons = getIncidentAttentionReasons(
			inc,
			activeUser,
			history,
			messages,
			users,
			levels,
			now
		);
		if (reasons.length > 0) {
			items.push({
				incident: inc,
				reasons,
				primaryReason: reasons[0]
			});
		}
	}

	return items.sort((a, b) => {
		// 1. Hierarchy of primary reason rank (lower number = higher urgency)
		if (a.primaryReason.priorityRank !== b.primaryReason.priorityRank) {
			return a.primaryReason.priorityRank - b.primaryReason.priorityRank;
		}

		// 2. Within Tier 1 (rank 1), order descending by interaction eventTimestamp
		if (a.primaryReason.priorityRank === 1) {
			const timeA = a.primaryReason.eventTimestamp ?? 0;
			const timeB = b.primaryReason.eventTimestamp ?? 0;
			if (timeA !== timeB) {
				return timeB - timeA; // Most recent interaction first
			}
		}

		// 3. For other tiers or ties, oldest createdAt first
		const createdA = Date.parse(a.incident.createdAt) || 0;
		const createdB = Date.parse(b.incident.createdAt) || 0;
		if (createdA !== createdB) {
			return createdA - createdB;
		}

		// 4. Deterministic tie-break by ID
		return a.incident.id - b.incident.id;
	});
}

/**
 * Returns active unassigned incidents in the same organization that the technician has capacity to assume.
 * Prioritizes incidents matching the technician's team, followed by older and higher priority incidents.
 */
export function getAvailableToAssumeIncidents(
	incidents: Incident[],
	activeUser: AppUser,
	levels: SupportLevelDefinition[] = []
): Incident[] {
	const orgId = activeUser.organizationId;
	if (!orgId) return [];

	return incidents
		.filter((inc) => {
			if (incidentOrganizationId(inc) !== orgId) return false;
			if (inc.status !== 'open' && inc.status !== 'pending') return false;
			if (inc.assignedToUserId) return false;
			return isCandidateLevelCompatible(activeUser, inc, levels);
		})
		.sort((a, b) => {
			// Prioritize technician's team
			const teamA = a.teamId && activeUser.teamId && a.teamId === activeUser.teamId ? 1 : 0;
			const teamB = b.teamId && activeUser.teamId && b.teamId === activeUser.teamId ? 1 : 0;
			if (teamA !== teamB) {
				return teamB - teamA;
			}

			// Priority order (urgent > high > medium > low)
			const prioWeight: Record<IncidentPriority, number> = {
				urgent: 4,
				high: 3,
				medium: 2,
				low: 1
			};
			const pA = prioWeight[a.priority] ?? 0;
			const pB = prioWeight[b.priority] ?? 0;
			if (pA !== pB) {
				return pB - pA;
			}

			// Oldest first
			const timeA = Date.parse(a.createdAt) || 0;
			const timeB = Date.parse(b.createdAt) || 0;
			if (timeA !== timeB) {
				return timeA - timeB;
			}

			return a.id - b.id;
		});
}

/**
 * Computes the 4 operational KPI summary counters for the Technician Dashboard.
 */
export function computeTechnicianDashboardSummary(
	incidents: Incident[],
	activeUser: AppUser,
	history: IncidentHistoryEntry[] = [],
	messages: IncidentMessage[] = [],
	users: AppUser[] = [],
	levels: SupportLevelDefinition[] = [],
	now: Date | string | number = new Date()
): TechnicianDashboardSummary {
	const orgId = activeUser.organizationId;
	const myActiveIncidents = incidents.filter(
		(inc) =>
			incidentOrganizationId(inc) === orgId &&
			inc.assignedToUserId === activeUser.id &&
			(inc.status === 'open' || inc.status === 'pending')
	);

	const attentionItems = getAttentionIncidents(
		incidents,
		activeUser,
		history,
		messages,
		users,
		levels,
		now
	);

	const slaApproachingCount = myActiveIncidents.filter((inc) => {
		const evalResult = evaluateIncidentSla(inc, now);
		return evalResult.status === 'approaching';
	}).length;

	const availableToAssume = getAvailableToAssumeIncidents(incidents, activeUser, levels);

	return {
		myActiveCount: myActiveIncidents.length,
		attentionCount: attentionItems.length,
		slaApproachingCount,
		availableToAssumeCount: availableToAssume.length
	};
}

/**
 * Computes 30-day operational activity metrics for the active technician.
 *
 * Attribution principle:
 * Uses the actor of the 'resolved' history event to attribute resolutions to the technician who
 * actually resolved them, preventing misattribution if an incident was later reopened or reassigned.
 * If history is absent (legacy seed data), falls back carefully to currently assigned resolved incidents.
 */
export function computeTechnicianActivityMetrics(
	incidents: Incident[],
	activeUser: AppUser,
	history: IncidentHistoryEntry[] = [],
	categories: IncidentCategory[] = [],
	levels: SupportLevelDefinition[] = [],
	now: Date | string | number = new Date(),
	periodDays: number = 30
): TechnicianActivityMetrics {
	const nowMs =
		typeof now === 'number' ? now : typeof now === 'string' ? Date.parse(now) : now.getTime();
	const cutoffMs = nowMs - periodDays * 24 * 60 * 60 * 1000;
	const orgId = activeUser.organizationId;

	// Identify incidents resolved by this technician in the window
	const resolvedIncidentIds = new Set<number>();
	const incidentMap = new Map<number, Incident>();
	for (const inc of incidents) {
		if (incidentOrganizationId(inc) === orgId) {
			incidentMap.set(inc.id, inc);
		}
	}

	// 1. Search resolution events in history
	for (const entry of history) {
		if (
			entry.organizationId === orgId &&
			entry.actorUserId === activeUser.id &&
			entry.eventType === 'resolved'
		) {
			const time = Date.parse(entry.timestamp);
			if (Number.isFinite(time) && time >= cutoffMs && time <= nowMs) {
				resolvedIncidentIds.add(entry.incidentId);
			}
		}
	}

	// 2. Fallback for incidents without history entries
	for (const inc of incidents) {
		if (
			incidentOrganizationId(inc) === orgId &&
			inc.assignedToUserId === activeUser.id &&
			(inc.status === 'resolved' || inc.status === 'closed') &&
			inc.resolvedAt &&
			!history.some((h) => h.incidentId === inc.id && h.eventType === 'resolved')
		) {
			const time = Date.parse(inc.resolvedAt);
			if (Number.isFinite(time) && time >= cutoffMs && time <= nowMs) {
				resolvedIncidentIds.add(inc.id);
			}
		}
	}

	const resolvedIncidents = Array.from(resolvedIncidentIds)
		.map((id) => incidentMap.get(id))
		.filter((inc): inc is Incident => inc !== undefined);

	const resolvedCount = resolvedIncidents.length;

	if (resolvedCount === 0) {
		return {
			periodDays,
			resolvedCount: 0,
			withinSlaCount: 0,
			withinSlaPercentage: 0,
			reopenedCount: 0,
			reopenedPercentage: 0,
			categories: [],
			levels: []
		};
	}

	// SLA Compliance
	let withinSlaCount = 0;
	let slaEligibleCount = 0;

	for (const inc of resolvedIncidents) {
		if (inc.sla && inc.sla.resolutionDueAt) {
			slaEligibleCount++;
			// If snapshot has resolvedAt, check against resolutionDueAt
			const resAt = inc.sla.resolvedAt ?? inc.resolvedAt;
			if (resAt) {
				const resMs = Date.parse(resAt);
				const dueMs = Date.parse(inc.sla.resolutionDueAt);
				if (Number.isFinite(resMs) && Number.isFinite(dueMs) && resMs <= dueMs) {
					withinSlaCount++;
				}
			}
		}
	}

	const withinSlaPercentage =
		slaEligibleCount > 0 ? Math.round((withinSlaCount / slaEligibleCount) * 100) : 100;

	// Reopened incidents count among this resolved pool
	let reopenedCount = 0;
	for (const inc of resolvedIncidents) {
		const incHistory = history.filter((h) => h.incidentId === inc.id);
		const hasReopenEvent = incHistory.some(
			(h) => h.eventType === 'reopened' || h.eventType === 'resolution_rejected'
		);
		if (hasReopenEvent || isIncidentReopened(inc, history)) {
			reopenedCount++;
		}
	}

	const reopenedPercentage = Math.round((reopenedCount / resolvedCount) * 1000) / 10;

	// Category distribution
	const catCountMap = new Map<string, number>();
	for (const inc of resolvedIncidents) {
		const catId = inc.categoryId || 'none';
		catCountMap.set(catId, (catCountMap.get(catId) || 0) + 1);
	}

	const categoryList: CategoryDistribution[] = Array.from(catCountMap.entries())
		.map(([catId, count]) => {
			const catObj = categories.find((c) => c.id === catId);
			const categoryName = catId === 'none' ? 'Sin categoría' : (catObj?.name ?? 'Sin categoría');
			const percentage = Math.round((count / resolvedCount) * 100);
			return { categoryId: catId, categoryName, count, percentage };
		})
		.sort((a, b) => b.count - a.count || a.categoryName.localeCompare(b.categoryName));

	// Level distribution
	const levelCountMap = new Map<string, number>();
	for (const inc of resolvedIncidents) {
		const lvlCode = inc.supportLevel || 'none';
		levelCountMap.set(lvlCode, (levelCountMap.get(lvlCode) || 0) + 1);
	}

	const levelList: LevelDistribution[] = Array.from(levelCountMap.entries())
		.map(([lvlCode, count]) => {
			const lvlObj = levels.find((l) => l.code === lvlCode);
			const levelName =
				lvlCode === 'none' ? 'Sin nivel' : lvlObj ? `${lvlObj.code} · ${lvlObj.name}` : lvlCode;
			const percentage = Math.round((count / resolvedCount) * 100);
			return { levelCode: lvlCode, levelName, count, percentage };
		})
		.sort((a, b) => {
			const ordA = levels.find((l) => l.code === a.levelCode)?.order ?? 999;
			const ordB = levels.find((l) => l.code === b.levelCode)?.order ?? 999;
			return ordA - ordB || b.count - a.count;
		});

	return {
		periodDays,
		resolvedCount,
		withinSlaCount,
		withinSlaPercentage,
		reopenedCount,
		reopenedPercentage,
		categories: categoryList,
		levels: levelList
	};
}

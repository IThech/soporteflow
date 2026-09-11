import type { Incident } from '$lib/types/incident';
import type { IncidentHistoryEntry } from '$lib/types/incident-history';
import type { AppUser } from '$lib/types/user';
import type { IncidentRating } from '$lib/types/incident-rating';
import { incidentOrganizationId } from './assignment';
import { SYSTEM_ACTOR_ID } from './history';
import { recordStatusTransition } from './lifecycle';

export const CLOSURE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 natural hours
export const REOPEN_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 natural hours

function toTimestampMs(now: Date | string | number): number {
	return typeof now === 'number' ? now : typeof now === 'string' ? Date.parse(now) : now.getTime();
}

/**
 * Composite uniqueness key for ratings: scoped to the specific resolution cycle.
 * Allows re-rating if an incident is reopened, worked on, and resolved anew.
 */
export function getResolutionRatingKey(
	organizationId: string,
	incidentId: number,
	resolvedAt: string
): string {
	return `${organizationId}#${incidentId}#${resolvedAt}`;
}

/**
 * Returns the effective resolvedAt timestamp for an incident.
 */
export function getIncidentResolvedAt(incident: Incident): string | null {
	return incident.resolvedAt ?? incident.sla?.resolvedAt ?? null;
}

/**
 * Checks if an active client can confirm or reject a resolved incident.
 */
export function canClientConfirmOrReject(incident: Incident, user: AppUser): boolean {
	if (!user.active || user.role !== 'client') return false;
	if (incident.clientUserId !== user.id) return false;
	return incident.status === 'resolved';
}

/**
 * Checks if the client can reopen a closed incident.
 * For v1, this rule applies specifically to client self-service actions:
 * client cannot reopen after closedAt + 24h.
 * Administrative roles are not blocked by this domain check.
 */
export function canClientReopenIncident(
	incident: Incident,
	user: AppUser,
	now: Date | string | number = new Date()
): boolean {
	if (!user.active || user.role !== 'client') return false;
	if (incident.clientUserId !== user.id) return false;
	if (incident.status !== 'closed' || !incident.closedAt) return false;

	const closedMs = Date.parse(incident.closedAt);
	if (!Number.isFinite(closedMs)) return false;

	const nowMs = toTimestampMs(now);
	const reopenDeadlineMs = closedMs + REOPEN_WINDOW_MS;

	return nowMs <= reopenDeadlineMs;
}

/**
 * Remaining minutes until the client's 24h reopen window expires.
 * Returns null if not closed or missing closedAt, or 0 if expired.
 */
export function getReopenRemainingMinutes(
	incident: Incident,
	now: Date | string | number = new Date()
): number | null {
	if (incident.status !== 'closed' || !incident.closedAt) return null;
	const closedMs = Date.parse(incident.closedAt);
	if (!Number.isFinite(closedMs)) return null;

	const nowMs = toTimestampMs(now);
	const deadlineMs = closedMs + REOPEN_WINDOW_MS;
	if (nowMs >= deadlineMs) return 0;

	return Math.ceil((deadlineMs - nowMs) / 60000);
}

/**
 * Remaining minutes until an incident in 'resolved' status is auto-closed.
 * Returns null if not resolved or missing resolved timestamp, or 0 if past deadline.
 */
export function getAutoCloseRemainingMinutes(
	incident: Incident,
	now: Date | string | number = new Date()
): number | null {
	if (incident.status !== 'resolved') return null;
	const resolvedAt = getIncidentResolvedAt(incident);
	if (!resolvedAt) return null;

	const resolvedMs = Date.parse(resolvedAt);
	if (!Number.isFinite(resolvedMs)) return null;

	const nowMs = toTimestampMs(now);
	const deadlineMs = resolvedMs + CLOSURE_WINDOW_MS;
	if (nowMs >= deadlineMs) return 0;

	return Math.ceil((deadlineMs - nowMs) / 60000);
}

/**
 * Finds the rating matching a specific resolution cycle of an incident.
 */
export function getRatingForResolution(
	incident: Incident,
	ratings: IncidentRating[]
): IncidentRating | undefined {
	const resolvedAt = getIncidentResolvedAt(incident);
	if (!resolvedAt) return undefined;
	const orgId = incidentOrganizationId(incident);
	const key = getResolutionRatingKey(orgId, incident.id, resolvedAt);

	return ratings.find(
		(r) => getResolutionRatingKey(r.organizationId, r.incidentId, r.resolvedAt) === key
	);
}

/**
 * Checks whether the client can submit a rating for the current resolution cycle.
 */
export function canClientRateIncident(
	incident: Incident,
	user: AppUser,
	existingRatings: IncidentRating[]
): boolean {
	if (!user.active || user.role !== 'client') return false;
	if (incident.clientUserId !== user.id) return false;
	if (incident.status !== 'resolved' && incident.status !== 'closed') return false;

	const resolvedAt = getIncidentResolvedAt(incident);
	if (!resolvedAt) return false;

	const existing = getRatingForResolution(incident, existingRatings);
	return !existing;
}

export interface SynchronizeClosuresResult {
	updatedIncidents: Incident[];
	newHistoryEntries: IncidentHistoryEntry[];
	changed: boolean;
}

/**
 * Pure domain function to deterministically transition incidents from 'resolved' to 'closed'
 * after 24 natural hours of inactivity.
 *
 * Requirements:
 * - Deterministic: uses the exact 24h timestamp (resolvedAt + 24h) for closedAt, not current time.
 * - History entry records actorUserId = SYSTEM_ACTOR_ID ('system').
 * - Preserves immutability and returns updated arrays and a changed flag.
 */
export function synchronizeIncidentClosures(
	incidents: Incident[],
	history: IncidentHistoryEntry[],
	now: Date | string | number = new Date()
): SynchronizeClosuresResult {
	const nowMs = toTimestampMs(now);
	const newHistoryEntries: IncidentHistoryEntry[] = [];
	let hasChanges = false;

	const updatedIncidents = incidents.map((incident) => {
		if (incident.status !== 'resolved') {
			return incident;
		}

		const resolvedAt = getIncidentResolvedAt(incident);
		if (!resolvedAt) {
			return incident;
		}

		const resolvedMs = Date.parse(resolvedAt);
		if (!Number.isFinite(resolvedMs)) {
			return incident;
		}

		const autoCloseDeadlineMs = resolvedMs + CLOSURE_WINDOW_MS;
		if (nowMs < autoCloseDeadlineMs) {
			return incident;
		}

		// Exact 24h timestamp
		const closedAt = new Date(autoCloseDeadlineMs).toISOString();
		hasChanges = true;

		const updated = recordStatusTransition(incident, 'closed', closedAt, {
			closureType: 'auto_closed'
		});

		const historyEntry: IncidentHistoryEntry = {
			id: crypto.randomUUID(),
			incidentId: incident.id,
			organizationId: incidentOrganizationId(incident),
			actorUserId: SYSTEM_ACTOR_ID,
			timestamp: closedAt,
			eventType: 'closed',
			newValue: {
				status: 'closed',
				closedAt,
				closureType: 'auto_closed'
			}
		};

		newHistoryEntries.push(historyEntry);
		return updated;
	});

	return {
		updatedIncidents,
		newHistoryEntries,
		changed: hasChanges
	};
}

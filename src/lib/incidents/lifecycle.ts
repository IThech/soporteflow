import { incidentOrganizationId } from './assignment';
import { matchSlaPolicy, createSlaSnapshot } from './sla';
import type { Incident, IncidentClosureType, IncidentStatus } from '$lib/types/incident';
import type { SlaPolicy } from '$lib/types/sla';
import type { IncidentMessage } from '$lib/types/incident-message';
import type { AppUser } from '$lib/types/user';
import type { IncidentHistoryEntry, IncidentHistoryEventType } from '$lib/types/incident-history';

/**
 * Applies initial SLA to an incident draft upon creation.
 * Source of truth for multi-tenant policy selection is the incident's organization,
 * not the acting user's profile.
 * If no matching policy or fallback exists, the incident remains without SLA.
 */
export function applyCreationSla(incident: Incident, policies: SlaPolicy[]): Incident {
	const orgId = incidentOrganizationId(incident);
	const orgPolicies = policies.filter((policy) => policy.organizationId === orgId);
	const policy = matchSlaPolicy(incident, orgPolicies);
	if (!policy) {
		return incident;
	}
	return {
		...incident,
		sla: createSlaSnapshot(incident, policy)
	};
}

/**
 * Checks whether a message qualifies as an initial staff response for SLA purposes:
 * - The incident has an active SLA snapshot with firstRespondedAt === null
 * - The message is public
 * - The author is staff (technician, organization_admin, or platform_admin)
 * - The message belongs to the incident
 */
export function isFirstResponseEligible(
	incident: Incident,
	message: Pick<IncidentMessage, 'visibility' | 'incidentId'>,
	actor: Pick<AppUser, 'role'>
): boolean {
	if (!incident.sla || incident.sla.firstRespondedAt !== null) {
		return false;
	}
	if (message.visibility !== 'public') {
		return false;
	}
	if (message.incidentId !== incident.id) {
		return false;
	}
	return ['technician', 'organization_admin', 'platform_admin'].includes(actor.role);
}

/**
 * Updates an incident's SLA snapshot with the first response timestamp if eligible.
 * Subsequent public messages do not alter an already recorded firstRespondedAt.
 */
export function recordFirstResponse(
	incident: Incident,
	message: IncidentMessage,
	actor: AppUser
): Incident {
	if (!isFirstResponseEligible(incident, message, actor)) {
		return incident;
	}
	return {
		...incident,
		sla: {
			...incident.sla!,
			firstRespondedAt: message.createdAt
		}
	};
}

export interface StatusTransitionOptions {
	closureType?: IncidentClosureType | null;
}

/**
 * Transitions an incident's status while preserving SLA commitments.
 * - If transitioning to 'resolved': sets incident.resolvedAt and incident.sla.resolvedAt = timestamp.
 * - If transitioning to 'closed': sets incident.closedAt and incident.closureType while preserving resolvedAt.
 * - If reopening ('resolved' | 'closed' -> 'open' | 'pending'): clears closure metadata while preserving SLA deadlines and historical resolvedAt.
 * - If transitioning again to 'resolved' after reopen: updates resolvedAt to the new timestamp.
 */
export function recordStatusTransition(
	incident: Incident,
	nextStatus: IncidentStatus,
	timestamp: string = new Date().toISOString(),
	options?: StatusTransitionOptions
): Incident {
	if (incident.status === nextStatus) {
		return incident;
	}

	if (nextStatus === 'resolved') {
		const base: Incident = {
			...incident,
			status: nextStatus,
			resolvedAt: timestamp,
			closedAt: null,
			closureType: null,
			updatedAt: timestamp
		};
		if (incident.sla) {
			return {
				...base,
				sla: {
					...incident.sla,
					resolvedAt: timestamp
				}
			};
		}
		return base;
	}

	if (nextStatus === 'closed') {
		return {
			...incident,
			status: nextStatus,
			resolvedAt: incident.resolvedAt ?? incident.sla?.resolvedAt ?? timestamp,
			closedAt: timestamp,
			closureType: options?.closureType ?? incident.closureType ?? 'client_confirmed',
			updatedAt: timestamp
		};
	}

	// Reopening or transition to 'open' | 'pending'
	return {
		...incident,
		status: nextStatus,
		closedAt: null,
		closureType: null,
		updatedAt: timestamp
	};
}

/**
 * Detects whether an incident is currently in a reopened state.
 * Reopened incidents have an active open status after having been resolved or closed.
 * Disappears once the incident is resolved or closed again.
 */
export function isIncidentReopened(incident: Incident, history?: IncidentHistoryEntry[]): boolean {
	if (incident.status === 'resolved' || incident.status === 'closed') {
		return false;
	}

	if (history && history.length > 0) {
		const incidentEvents = history.filter((e) => e.incidentId === incident.id);
		if (incidentEvents.length > 0) {
			const statusEvents: IncidentHistoryEventType[] = [
				'created',
				'resolved',
				'resolution_accepted',
				'closed',
				'resolution_rejected',
				'reopened',
				'status_changed'
			];

			const relevant = incidentEvents
				.filter((e) => statusEvents.includes(e.eventType))
				.sort(
					(a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id)
				);

			if (relevant.length > 0) {
				const last = relevant[relevant.length - 1];
				if (last.eventType === 'resolution_rejected' || last.eventType === 'reopened') {
					return true;
				}
				if (last.eventType === 'status_changed') {
					const prev = (last as { previousValue?: unknown }).previousValue;
					const next = (last as { newValue?: unknown }).newValue;
					if (
						(prev === 'resolved' || prev === 'closed') &&
						(next === 'open' || next === 'pending')
					) {
						return true;
					}
				}
				// If last status event was created, resolved, closed, resolution_accepted, or regular status_changed
				return false;
			}
		}
	}

	// Fallback when history is not available:
	// In the lifecycle, reopening preserves historical resolvedAt while resetting closedAt.
	return incident.status === 'open' && incident.resolvedAt != null;
}

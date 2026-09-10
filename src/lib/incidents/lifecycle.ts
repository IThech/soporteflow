import { incidentOrganizationId } from './assignment';
import { matchSlaPolicy, createSlaSnapshot } from './sla';
import type { Incident, IncidentStatus } from '$lib/types/incident';
import type { SlaPolicy } from '$lib/types/sla';
import type { IncidentMessage } from '$lib/types/incident-message';
import type { AppUser } from '$lib/types/user';

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

/**
 * Transitions an incident's status while preserving SLA commitments.
 * - If transitioning to 'resolved': sets incident.sla.resolvedAt = timestamp (never uses updatedAt as substitute).
 * - If reopening ('resolved' -> 'open' | 'pending'): preserves original SLA, deadlines, and historical resolvedAt.
 * - If transitioning again to 'resolved' after reopen: updates resolvedAt to the new timestamp.
 */
export function recordStatusTransition(
	incident: Incident,
	nextStatus: IncidentStatus,
	timestamp: string = new Date().toISOString()
): Incident {
	if (incident.status === nextStatus) {
		return incident;
	}

	const transitioningToResolved = nextStatus === 'resolved';

	if (transitioningToResolved && incident.sla) {
		return {
			...incident,
			status: nextStatus,
			updatedAt: timestamp,
			sla: {
				...incident.sla,
				resolvedAt: timestamp
			}
		};
	}

	// Reopening or other status transition
	return {
		...incident,
		status: nextStatus,
		updatedAt: timestamp
	};
}

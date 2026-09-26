/**
 * SLA compliance (5.4T-C, Core v1). Pure derivation from persisted timestamps plus a caller-supplied
 * `now`: no stored breach flags, no worker. A target becomes "breached" simply because the query
 * runs after its deadline.
 *
 * Objective status (first response / resolution):
 * - not_applicable: the incident has no SLA;
 * - met:            achieved at or before its deadline;
 * - breached:       achieved after its deadline, or not achieved and now > deadline;
 * - pending:        not achieved and now <= deadline.
 * Overall: not_applicable (no SLA) / breached (any objective breached) / met (both met) /
 * on_track (otherwise).
 *
 * Achievement timestamps are first-write-wins facts: firstResponseAt (first support reply) and
 * firstResolvedAt (first entry into resolved/closed). Reopening never restarts the SLA, so the
 * original cycle's result is kept.
 */

export type SlaObjectiveStatus = 'not_applicable' | 'pending' | 'met' | 'breached';
export type SlaOverallStatus = 'not_applicable' | 'on_track' | 'met' | 'breached';

export const SLA_OBJECTIVE_STATUSES: readonly SlaObjectiveStatus[] = [
	'not_applicable',
	'pending',
	'met',
	'breached'
];
export const SLA_OVERALL_STATUSES: readonly SlaOverallStatus[] = [
	'not_applicable',
	'on_track',
	'met',
	'breached'
];

export interface SlaComplianceInput {
	slaPolicyId: string | null;
	firstResponseDueAt: Date | null;
	resolutionDueAt: Date | null;
	firstResponseAt: Date | null;
	firstResolvedAt: Date | null;
}

export interface SlaCompliance {
	slaOverallStatus: SlaOverallStatus;
	slaFirstResponseStatus: SlaObjectiveStatus;
	slaResolutionStatus: SlaObjectiveStatus;
}

/** Status of one objective. dueAt null means "no SLA". */
export function objectiveStatus(
	dueAt: Date | null,
	achievedAt: Date | null,
	now: Date
): SlaObjectiveStatus {
	if (!dueAt) return 'not_applicable';
	if (achievedAt) return achievedAt.getTime() <= dueAt.getTime() ? 'met' : 'breached';
	return now.getTime() > dueAt.getTime() ? 'breached' : 'pending';
}

export function computeIncidentSlaCompliance(
	incident: SlaComplianceInput,
	now: Date
): SlaCompliance {
	if (!incident.slaPolicyId)
		return {
			slaOverallStatus: 'not_applicable',
			slaFirstResponseStatus: 'not_applicable',
			slaResolutionStatus: 'not_applicable'
		};
	const firstResponse = objectiveStatus(incident.firstResponseDueAt, incident.firstResponseAt, now);
	const resolution = objectiveStatus(incident.resolutionDueAt, incident.firstResolvedAt, now);
	const overall: SlaOverallStatus =
		firstResponse === 'breached' || resolution === 'breached'
			? 'breached'
			: firstResponse === 'met' && resolution === 'met'
				? 'met'
				: 'on_track';
	return {
		slaOverallStatus: overall,
		slaFirstResponseStatus: firstResponse,
		slaResolutionStatus: resolution
	};
}

/** Incident DTO with the derived compliance fields appended (all other fields unchanged). */
export function withSlaCompliance<T extends SlaComplianceInput>(
	incident: T,
	now: Date = new Date()
): T & SlaCompliance {
	return { ...incident, ...computeIncidentSlaCompliance(incident, now) };
}

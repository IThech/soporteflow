import {
	computeIncidentSlaCompliance,
	withSlaCompliance,
	type SlaCompliance,
	type SlaComplianceInput
} from './sla-compliance';

/**
 * Canonical incident projections for HTTP (5.4W-B). Routes never shape incident payloads
 * themselves: they call toIncidentDto with the audience resolved by incidentAudience().
 *
 * - staff:     the operational DTO (assignment, team, support level, SLA snapshot and derived
 *              compliance), unchanged from previous stages.
 * - requester: explicit allowlist for customers (incidents visible only through
 *              incidents:view_requested). It carries `audience: 'requester'` so clients can
 *              validate it strictly. Excluded on purpose: assignee and team (who handles it is
 *              internal), support level, the SLA configuration (policy id, snapshot minutes,
 *              applied/due/achieved timestamps), the creator id (may be a staff member) and the
 *              legacy `client` label (staff classification text). Kept: the derived SLA
 *              compliance statuses, a customer-facing product decision of 5.4T-C ("the customer
 *              sees the compliance of their incident").
 */
export interface RequesterIncidentDto {
	audience: 'requester';
	id: string;
	organizationId: string;
	incidentNumber: number;
	title: string;
	description: string;
	status: string;
	priority: string;
	/** Requester of the incident (always the caller for this audience). */
	clientUserId: string | null;
	siteId: string | null;
	categoryId: string | null;
	slaOverallStatus: SlaCompliance['slaOverallStatus'];
	slaFirstResponseStatus: SlaCompliance['slaFirstResponseStatus'];
	slaResolutionStatus: SlaCompliance['slaResolutionStatus'];
	createdAt: Date | string;
	updatedAt: Date | string;
}

export interface IncidentDtoSource extends SlaComplianceInput {
	id: string;
	organizationId: string;
	incidentNumber: number;
	title: string;
	description: string;
	status: string;
	priority: string;
	clientUserId: string | null;
	siteId: string | null;
	categoryId?: string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
}

export function toRequesterIncidentDto(
	incident: IncidentDtoSource,
	now: Date = new Date()
): RequesterIncidentDto {
	const compliance = computeIncidentSlaCompliance(incident, now);
	return {
		audience: 'requester',
		id: incident.id,
		organizationId: incident.organizationId,
		incidentNumber: incident.incidentNumber,
		title: incident.title,
		description: incident.description,
		status: incident.status,
		priority: incident.priority,
		clientUserId: incident.clientUserId,
		siteId: incident.siteId,
		categoryId: incident.categoryId ?? null,
		slaOverallStatus: compliance.slaOverallStatus,
		slaFirstResponseStatus: compliance.slaFirstResponseStatus,
		slaResolutionStatus: compliance.slaResolutionStatus,
		createdAt: incident.createdAt,
		updatedAt: incident.updatedAt
	};
}

export function toIncidentDto<T extends IncidentDtoSource>(
	incident: T,
	audience: 'staff' | 'requester',
	now: Date = new Date()
) {
	return audience === 'staff'
		? withSlaCompliance(incident, now)
		: toRequesterIncidentDto(incident, now);
}

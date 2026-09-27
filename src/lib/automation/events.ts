/**
 * Canonical automation event catalog (5.4V-A). Shared contract for future consumers: outbound
 * webhooks (V-B), automation rules (V-C) and n8n (V-D). No imports: usable from server and client.
 *
 * Independent from the notification catalog (src/lib/notifications/events.ts): notifications are a
 * user-facing selection filtered by preferences; automation events are domain facts, emitted
 * regardless of any user preference, and cover more mutations (priority, category, site, support
 * level, team, internal notes, SLA results).
 *
 * Every event type is produced synchronously by a domain mutation, in its transaction. Nothing here
 * is produced by the passage of time: SLA events record a result OBSERVED when an action happened
 * (e.g. a late first response), never a deadline alert (no scheduler yet; see docs).
 */
export const AUTOMATION_EVENT_TYPES = [
	'incident.created',
	'incident.assigned',
	'incident.unassigned',
	'incident.team_changed',
	'incident.status_changed',
	'incident.reopened',
	'incident.priority_changed',
	'incident.category_changed',
	'incident.site_changed',
	'incident.support_level_changed',
	'incident.public_comment_added',
	'incident.internal_note_added',
	'sla.first_response_met',
	'sla.first_response_breached',
	'sla.resolution_met',
	'sla.resolution_breached'
] as const;

export type AutomationEventType = (typeof AUTOMATION_EVENT_TYPES)[number];

export const AUTOMATION_AGGREGATE_TYPES = ['incident'] as const;
export type AutomationAggregateType = (typeof AUTOMATION_AGGREGATE_TYPES)[number];

/** Current payload contract version. Stored per event; never rewritten on stored events. */
export const AUTOMATION_EVENT_SCHEMA_VERSION = 1;

export type AutomationIncidentStatus = 'open' | 'pending' | 'resolved' | 'closed';
export type AutomationIncidentPriority = 'low' | 'medium' | 'high' | 'urgent';
export type AutomationSupportLevel = 'N1' | 'N2' | 'N3';

/** Common payload part: the incident reference (identifier + tenant-local number). */
interface IncidentRef {
	incidentId: string;
	incidentNumber: number;
}

/**
 * Payload contracts, schemaVersion 1. Keys are stable (V-C rules and n8n will read them).
 * Ids and enumerated values only: never titles, descriptions, client names, message bodies,
 * emails or other free text.
 */
export interface AutomationEventPayloads {
	'incident.created': IncidentRef & {
		status: AutomationIncidentStatus;
		priority: AutomationIncidentPriority;
		supportLevel: AutomationSupportLevel;
		requesterUserId: string | null;
		categoryId: string | null;
		siteId: string | null;
		slaPolicyId: string | null;
	};
	'incident.assigned': IncidentRef & {
		previousAssigneeUserId: string | null;
		assignedToUserId: string;
	};
	'incident.unassigned': IncidentRef & { previousAssigneeUserId: string };
	'incident.team_changed': IncidentRef & {
		previousTeamId: string | null;
		newTeamId: string | null;
	};
	'incident.status_changed': IncidentRef & {
		previousStatus: AutomationIncidentStatus;
		newStatus: AutomationIncidentStatus;
	};
	'incident.reopened': IncidentRef & {
		previousStatus: 'resolved' | 'closed';
		newStatus: 'open';
	};
	'incident.priority_changed': IncidentRef & {
		previousPriority: AutomationIncidentPriority;
		newPriority: AutomationIncidentPriority;
	};
	'incident.category_changed': IncidentRef & {
		previousCategoryId: string | null;
		newCategoryId: string | null;
	};
	'incident.site_changed': IncidentRef & {
		previousSiteId: string | null;
		newSiteId: string | null;
	};
	'incident.support_level_changed': IncidentRef & {
		previousSupportLevel: AutomationSupportLevel;
		newSupportLevel: AutomationSupportLevel;
	};
	'incident.public_comment_added': IncidentRef & { messageId: string };
	'incident.internal_note_added': IncidentRef & { messageId: string };
	'sla.first_response_met': IncidentRef & SlaObservation;
	'sla.first_response_breached': IncidentRef & SlaObservation;
	'sla.resolution_met': IncidentRef & SlaObservation;
	'sla.resolution_breached': IncidentRef & SlaObservation;
}

/**
 * SLA result observed when the objective was achieved (first response / first resolution).
 * `observedBy: 'action'` distinguishes it from a future time-based breach alert ('schedule').
 */
export interface SlaObservation {
	slaPolicyId: string;
	dueAt: string;
	achievedAt: string;
	observedBy: 'action';
}

/**
 * Canonical envelope (V-B/V-C/V-D can use it as-is, without reading the incident again).
 * `id` is generated once and never reused: webhook event id, idempotency and dedup reference.
 */
export interface AutomationEventEnvelope<T extends AutomationEventType = AutomationEventType> {
	id: string;
	organizationId: string;
	eventType: T;
	schemaVersion: number;
	aggregateType: AutomationAggregateType;
	aggregateId: string;
	actorUserId: string | null;
	occurredAt: string;
	payload: AutomationEventPayloads[T];
}

export function isAutomationEventType(value: unknown): value is AutomationEventType {
	return typeof value === 'string' && (AUTOMATION_EVENT_TYPES as readonly string[]).includes(value);
}

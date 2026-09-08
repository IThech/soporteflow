import type { Incident, IncidentPriority, IncidentStatus } from './incident';
import type { SupportLevel } from './support';

// Null means explicitly unassigned; an absent property means not recorded.
export interface IncidentRoutingSnapshot {
	supportLevel?: SupportLevel | null;
	teamId?: string | null;
	assignedToUserId?: string | null;
}

type HistoryValues = {
	created: Pick<Incident, 'title' | 'status' | 'priority'> & IncidentRoutingSnapshot;
	assigned: string | null;
	reassigned: string | null;
	escalated: IncidentRoutingSnapshot;
	status_changed: IncidentStatus;
	priority_changed: IncidentPriority;
	category_changed: string | null;
	resolved: { status: IncidentStatus; solution?: string };
};

export type IncidentHistoryEventType = keyof HistoryValues;

interface IncidentHistoryIdentity {
	id: string;
	incidentId: number;
	organizationId: string;
	actorUserId: string;
	/** ISO 8601 UTC timestamp with time, e.g. 2026-09-08T09:30:00.000Z. */
	timestamp: string;
	reason?: string;
	comment?: string;
}

// Discriminated union: eventType determines the permitted previous/new values.
// Assignment values are user IDs; escalation records level/team independently.
export type IncidentHistoryEntry = {
	[Event in IncidentHistoryEventType]: IncidentHistoryIdentity & {
		eventType: Event;
		previousValue?: HistoryValues[Event];
		newValue?: HistoryValues[Event];
	};
}[IncidentHistoryEventType];

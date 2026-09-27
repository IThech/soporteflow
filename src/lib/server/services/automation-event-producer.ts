import { and, eq } from 'drizzle-orm';
import { incidents } from '../db/schema';
import type {
	AutomationEventPayloads,
	AutomationIncidentPriority,
	AutomationIncidentStatus,
	AutomationSupportLevel
} from '../../automation/events';
import type { IncidentDatabase } from './incidents';
import { appendAutomationEvent, type StoredAutomationEvent } from './automation-events';

/**
 * Domain automation event producer (5.4V-A). The only entry point domain services use to record
 * automation events. Sibling of notification-producer: neither imports the other, and user
 * notification preferences never affect automation events (they are domain facts).
 *
 * Contract:
 * - runs on the caller's transaction and never catches: any failure rolls the mutation back;
 * - tenant-safe: the incident is read by (id, organizationId) in that transaction; the
 *   organization and incident number always come from the database row;
 * - facts are appended in the given order (e.g. unassigned before assigned) and share the
 *   mutation's occurredAt;
 * - no HTTP, webhooks, rules or n8n: consumers come in V-B/V-C/V-D.
 */

type Status = AutomationIncidentStatus;
type Priority = AutomationIncidentPriority;
type Level = AutomationSupportLevel;

/** Variable data of each fact; the incident reference is added by the producer. */
export type IncidentAutomationFact =
	| { eventType: 'incident.created' }
	| {
			eventType: 'incident.assigned';
			previousAssigneeUserId: string | null;
			assignedToUserId: string;
	  }
	| { eventType: 'incident.unassigned'; previousAssigneeUserId: string }
	| { eventType: 'incident.team_changed'; previousTeamId: string | null; newTeamId: string | null }
	| { eventType: 'incident.status_changed'; previousStatus: Status; newStatus: Status }
	| { eventType: 'incident.reopened'; previousStatus: 'resolved' | 'closed' }
	| { eventType: 'incident.priority_changed'; previousPriority: Priority; newPriority: Priority }
	| {
			eventType: 'incident.category_changed';
			previousCategoryId: string | null;
			newCategoryId: string | null;
	  }
	| { eventType: 'incident.site_changed'; previousSiteId: string | null; newSiteId: string | null }
	| {
			eventType: 'incident.support_level_changed';
			previousSupportLevel: Level;
			newSupportLevel: Level;
	  }
	| {
			eventType: 'incident.public_comment_added' | 'incident.internal_note_added';
			messageId: string;
	  }
	| {
			eventType:
				| 'sla.first_response_met'
				| 'sla.first_response_breached'
				| 'sla.resolution_met'
				| 'sla.resolution_breached';
			slaPolicyId: string;
			dueAt: Date;
			achievedAt: Date;
	  };

export interface RecordIncidentAutomationEventsInput {
	organizationId: string;
	incidentId: string;
	/** Mutation actor; null only for system events (none produced in V-A). */
	actorUserId: string | null;
	/** Timestamp of the mutation (shared by all its facts). */
	occurredAt: Date;
	facts: readonly IncidentAutomationFact[];
}

export class AutomationEventProducerError extends Error {
	constructor(readonly code: 'INVALID_INPUT' | 'INCIDENT_NOT_FOUND') {
		super(code);
		this.name = 'AutomationEventProducerError';
	}
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set<string>(['open', 'pending', 'resolved', 'closed']);
const PRIORITIES = new Set<string>(['low', 'medium', 'high', 'urgent']);
const LEVELS = new Set<string>(['N1', 'N2', 'N3']);
const invalid = () => new AutomationEventProducerError('INVALID_INPUT');
const id = (v: unknown): string => {
	if (typeof v !== 'string' || !uuid.test(v)) throw invalid();
	return v;
};
const optionalId = (v: unknown): string | null => (v === null ? null : id(v));
const oneOf = <T extends string>(set: Set<string>, v: unknown): T => {
	if (typeof v !== 'string' || !set.has(v)) throw invalid();
	return v as T;
};
const changed = <T>(previous: T, next: T): [T, T] => {
	if (previous === next) throw invalid(); // no-ops never produce events
	return [previous, next];
};
const date = (v: unknown): string => {
	if (!(v instanceof Date) || Number.isNaN(v.getTime())) throw invalid();
	return v.toISOString();
};

type IncidentRow = {
	id: string;
	incidentNumber: number;
	status: string;
	priority: string;
	supportLevel: string;
	clientUserId: string | null;
	categoryId: string | null;
	siteId: string | null;
	slaPolicyId: string | null;
};

/** Typed payload of one fact (schemaVersion 1). */
function payloadOf(
	fact: IncidentAutomationFact,
	incident: IncidentRow
): AutomationEventPayloads[IncidentAutomationFact['eventType']] {
	const ref = { incidentId: incident.id, incidentNumber: incident.incidentNumber };
	switch (fact.eventType) {
		case 'incident.created':
			return {
				...ref,
				status: oneOf<Status>(STATUSES, incident.status),
				priority: oneOf<Priority>(PRIORITIES, incident.priority),
				supportLevel: oneOf<Level>(LEVELS, incident.supportLevel),
				requesterUserId: incident.clientUserId,
				categoryId: incident.categoryId,
				siteId: incident.siteId,
				slaPolicyId: incident.slaPolicyId
			} satisfies AutomationEventPayloads['incident.created'];
		case 'incident.assigned': {
			const previousAssigneeUserId = optionalId(fact.previousAssigneeUserId);
			const assignedToUserId = id(fact.assignedToUserId);
			changed(previousAssigneeUserId, assignedToUserId);
			return { ...ref, previousAssigneeUserId, assignedToUserId };
		}
		case 'incident.unassigned':
			return { ...ref, previousAssigneeUserId: id(fact.previousAssigneeUserId) };
		case 'incident.team_changed': {
			const [previousTeamId, newTeamId] = changed(
				optionalId(fact.previousTeamId),
				optionalId(fact.newTeamId)
			);
			return { ...ref, previousTeamId, newTeamId };
		}
		case 'incident.status_changed': {
			const [previousStatus, newStatus] = changed(
				oneOf<Status>(STATUSES, fact.previousStatus),
				oneOf<Status>(STATUSES, fact.newStatus)
			);
			return { ...ref, previousStatus, newStatus };
		}
		case 'incident.reopened':
			if (fact.previousStatus !== 'resolved' && fact.previousStatus !== 'closed') throw invalid();
			return { ...ref, previousStatus: fact.previousStatus, newStatus: 'open' };
		case 'incident.priority_changed': {
			const [previousPriority, newPriority] = changed(
				oneOf<Priority>(PRIORITIES, fact.previousPriority),
				oneOf<Priority>(PRIORITIES, fact.newPriority)
			);
			return { ...ref, previousPriority, newPriority };
		}
		case 'incident.category_changed': {
			const [previousCategoryId, newCategoryId] = changed(
				optionalId(fact.previousCategoryId),
				optionalId(fact.newCategoryId)
			);
			return { ...ref, previousCategoryId, newCategoryId };
		}
		case 'incident.site_changed': {
			const [previousSiteId, newSiteId] = changed(
				optionalId(fact.previousSiteId),
				optionalId(fact.newSiteId)
			);
			return { ...ref, previousSiteId, newSiteId };
		}
		case 'incident.support_level_changed': {
			const [previousSupportLevel, newSupportLevel] = changed(
				oneOf<Level>(LEVELS, fact.previousSupportLevel),
				oneOf<Level>(LEVELS, fact.newSupportLevel)
			);
			return { ...ref, previousSupportLevel, newSupportLevel };
		}
		case 'incident.public_comment_added':
		case 'incident.internal_note_added':
			return { ...ref, messageId: id(fact.messageId) };
		case 'sla.first_response_met':
		case 'sla.first_response_breached':
		case 'sla.resolution_met':
		case 'sla.resolution_breached':
			return {
				...ref,
				slaPolicyId: id(fact.slaPolicyId),
				dueAt: date(fact.dueAt),
				achievedAt: date(fact.achievedAt),
				observedBy: 'action'
			};
		default:
			throw invalid();
	}
}

/**
 * Appends the automation events of one incident mutation, in order, on the caller's transaction.
 * Returns the stored events (same order).
 */
export async function recordIncidentAutomationEvents(
	tx: IncidentDatabase,
	input: RecordIncidentAutomationEventsInput
): Promise<StoredAutomationEvent[]> {
	const organizationId = id(input?.organizationId);
	const incidentId = id(input.incidentId);
	const actorUserId = optionalId(input.actorUserId);
	date(input.occurredAt);
	if (!Array.isArray(input.facts) || input.facts.length === 0) throw invalid();

	const [incident] = await tx
		.select({
			id: incidents.id,
			incidentNumber: incidents.incidentNumber,
			status: incidents.status,
			priority: incidents.priority,
			supportLevel: incidents.supportLevel,
			clientUserId: incidents.clientUserId,
			categoryId: incidents.categoryId,
			siteId: incidents.siteId,
			slaPolicyId: incidents.slaPolicyId
		})
		.from(incidents)
		.where(and(eq(incidents.id, incidentId), eq(incidents.organizationId, organizationId)))
		.limit(1);
	if (!incident) throw new AutomationEventProducerError('INCIDENT_NOT_FOUND');

	// Build every payload first: an invalid fact fails before anything is written.
	const payloads = input.facts.map((fact) => payloadOf(fact, incident));
	const stored: StoredAutomationEvent[] = [];
	for (const [index, fact] of input.facts.entries())
		stored.push(
			await appendAutomationEvent(tx, {
				organizationId,
				eventType: fact.eventType,
				aggregateType: 'incident',
				aggregateId: incidentId,
				actorUserId,
				occurredAt: input.occurredAt,
				payload: payloads[index]
			})
		);
	return stored;
}

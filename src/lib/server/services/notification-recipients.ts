import { and, eq, inArray } from 'drizzle-orm';
import { incidents, memberships, organizations, users } from '../db/schema';
import { isNotificationEventType, type NotificationEventType } from '../../notifications/events';
import type { IncidentDatabase } from './incidents';
import { filterUsersWithNotificationEnabled } from './notification-preferences';

/**
 * Notification recipient rules (5.4U-B). Given a domain event, returns WHO should receive it.
 * It never creates notifications: since 5.4U-C its only caller is notification-producer, which
 * domain services use inside their own transaction.
 *
 * Recipients derive from the incident's CURRENT relationships, read server-side by
 * (incidentId, organizationId): requester (incidents.client_user_id) and assignee
 * (incidents.assigned_to_user_id). Never role codes, never the whole organization.
 * The only caller-supplied recipient is previousAssigneeUserId for incident.unassigned (the
 * relationship no longer exists in the row); it still has to be an active member of the tenant.
 *
 * Rules (then: exclude the actor, dedupe, keep active members only, apply preferences):
 * - incident.assigned            -> current assignee
 * - incident.unassigned          -> previous assignee
 * - incident.status_changed      -> requester + assignee
 * - incident.reopened            -> requester + assignee
 * - incident.public_comment_added-> author is the requester: assignee; otherwise: requester
 * - sla.first_response_breached  -> assignee only (time-based: no actor)
 * - sla.resolution_breached      -> assignee only (time-based: no actor)
 * Self-notification is never produced: the actor of an action is always excluded.
 */

/**
 * Own error type (same codes as the incident service) so this module only has type-level imports
 * from incidents.ts: incidents.ts -> notification-producer -> this module stays acyclic.
 */
export class NotificationRecipientError extends Error {
	constructor(
		readonly code: 'INVALID_INPUT' | 'INCIDENT_NOT_FOUND',
		message: string
	) {
		super(message);
		this.name = 'NotificationRecipientError';
	}
}

export type NotificationRecipientEvent =
	| {
			eventType:
				| 'incident.assigned'
				| 'incident.status_changed'
				| 'incident.reopened'
				| 'incident.public_comment_added';
			organizationId: string;
			incidentId: string;
			/** User who performed the action (comment author for public comments). */
			actorUserId: string;
	  }
	| {
			eventType: 'incident.unassigned';
			organizationId: string;
			incidentId: string;
			actorUserId: string;
			previousAssigneeUserId: string;
	  }
	| {
			eventType: 'sla.first_response_breached' | 'sla.resolution_breached';
			organizationId: string;
			incidentId: string;
	  };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validId(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !uuid.test(value))
		throw new NotificationRecipientError('INVALID_INPUT', 'invalid recipient event');
}

/**
 * Candidate recipients from the incident relationships, actor excluded, deduplicated and sorted
 * (deterministic). Neither activity nor preferences are applied here.
 */
export async function resolveCandidateRecipients(
	db: IncidentDatabase,
	event: NotificationRecipientEvent
): Promise<string[]> {
	if (!isNotificationEventType(event?.eventType))
		throw new NotificationRecipientError('INVALID_INPUT', 'unknown notification event');
	validId(event?.organizationId);
	validId(event.incidentId);
	const actor = 'actorUserId' in event ? event.actorUserId : null;
	if (actor !== null) validId(actor);
	if (event.eventType === 'incident.unassigned') validId(event.previousAssigneeUserId);

	const [incident] = await db
		.select({
			requester: incidents.clientUserId,
			assignee: incidents.assignedToUserId
		})
		.from(incidents)
		.where(
			and(eq(incidents.id, event.incidentId), eq(incidents.organizationId, event.organizationId))
		)
		.limit(1);
	if (!incident) throw new NotificationRecipientError('INCIDENT_NOT_FOUND', 'Incident not found');

	let candidates: (string | null)[];
	switch (event.eventType) {
		case 'incident.assigned':
			candidates = [incident.assignee];
			break;
		case 'incident.unassigned':
			candidates = [event.previousAssigneeUserId];
			break;
		case 'incident.status_changed':
		case 'incident.reopened':
			candidates = [incident.requester, incident.assignee];
			break;
		case 'incident.public_comment_added':
			// Decided by the author's relationship with this incident, not by role:
			// the requester writing -> the assignee should see it; anyone else -> the requester.
			candidates = actor === incident.requester ? [incident.assignee] : [incident.requester];
			break;
		case 'sla.first_response_breached':
		case 'sla.resolution_breached':
			candidates = [incident.assignee];
			break;
		default:
			throw new NotificationRecipientError('INVALID_INPUT', 'unknown notification event');
	}
	return [...new Set(candidates.filter((id): id is string => id !== null && id !== actor))].sort();
}

/** Keeps only users that are active members of an active organization (one query). */
async function activeMembers(
	db: IncidentDatabase,
	organizationId: string,
	userIds: string[]
): Promise<Set<string>> {
	if (userIds.length === 0) return new Set();
	const rows = await db
		.select({ userId: memberships.userId })
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.innerJoin(organizations, eq(organizations.id, memberships.organizationId))
		.where(
			and(
				eq(memberships.organizationId, organizationId),
				inArray(memberships.userId, userIds),
				eq(memberships.active, true),
				eq(users.active, true),
				eq(organizations.status, 'active')
			)
		);
	return new Set(rows.map((row) => row.userId));
}

/**
 * Final recipients for 5.4U-C: candidates -> active members -> preference enabled. Constant query
 * count regardless of the number of candidates (incident, memberships, preferences). Sorted ids.
 */
export async function resolveNotificationRecipients(
	db: IncidentDatabase,
	event: NotificationRecipientEvent
): Promise<string[]> {
	const candidates = await resolveCandidateRecipients(db, event);
	const active = await activeMembers(db, event.organizationId, candidates);
	const eligible = candidates.filter((id) => active.has(id));
	return filterUsersWithNotificationEnabled(db, {
		organizationId: event.organizationId,
		eventType: event.eventType satisfies NotificationEventType,
		userIds: eligible
	});
}

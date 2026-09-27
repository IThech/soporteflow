import { and, eq } from 'drizzle-orm';
import { incidents } from '../db/schema';
import type { IncidentDatabase } from './incidents';
import { createNotification } from './notifications';
import { resolveNotificationRecipients } from './notification-recipients';

/**
 * Domain notification producer (5.4U-C). The ONLY entry point domain services use to emit in-app
 * notifications: event -> recipients (5.4U-B rules) -> centralized title/message/payload ->
 * createNotification per recipient.
 *
 * Transactional contract: it runs on the caller's dbOrTx (the domain mutation's transaction) and
 * never catches errors. If resolving recipients or inserting any notification fails, the error
 * propagates and the whole domain mutation rolls back. No outbox, email, worker or retries.
 *
 * Content contract: fixed Spanish texts that only reference the incident number. Never the
 * incident title, comment bodies, names, emails or any other PII. Payload is minimal metadata.
 *
 * SLA breach events (sla.*) are catalogued but NOT produced: breaches are time-based and there is
 * no worker/cron yet, so this producer rejects them.
 */

export type IncidentNotificationStatus = 'open' | 'pending' | 'resolved' | 'closed';

interface BaseEvent {
	organizationId: string;
	incidentId: string;
	/** User who performed the domain action; never notified. */
	actorUserId: string;
}

export type DomainNotificationEvent =
	| (BaseEvent & { eventType: 'incident.assigned' })
	| (BaseEvent & {
			eventType: 'incident.unassigned';
			/** Must come from the locked incident row, never from request input. */
			previousAssigneeUserId: string;
	  })
	| (BaseEvent & {
			eventType: 'incident.status_changed';
			previousStatus: IncidentNotificationStatus;
			newStatus: IncidentNotificationStatus;
	  })
	| (BaseEvent & {
			eventType: 'incident.reopened';
			previousStatus: 'resolved' | 'closed';
	  })
	| (BaseEvent & { eventType: 'incident.public_comment_added'; commentId: string });

export type DomainNotificationEventType = DomainNotificationEvent['eventType'];

export type IncidentAssignedPayload = { incidentId: string };
export type IncidentUnassignedPayload = { incidentId: string };
export type IncidentStatusChangedPayload = {
	incidentId: string;
	previousStatus: IncidentNotificationStatus;
	newStatus: IncidentNotificationStatus;
};
export type IncidentReopenedPayload = {
	incidentId: string;
	previousStatus: 'resolved' | 'closed';
	newStatus: 'open';
};
export type IncidentPublicCommentPayload = { incidentId: string; commentId: string };

export class NotificationProducerError extends Error {
	constructor(
		readonly code: 'INVALID_INPUT' | 'INCIDENT_NOT_FOUND',
		message: string
	) {
		super(message);
		this.name = 'NotificationProducerError';
	}
}

const STATUS_LABELS: Record<IncidentNotificationStatus, string> = {
	open: 'Abierta',
	pending: 'Pendiente',
	resolved: 'Resuelta',
	closed: 'Cerrada'
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new NotificationProducerError('INVALID_INPUT', 'invalid notification event');
function status(value: unknown): IncidentNotificationStatus {
	if (typeof value !== 'string' || !Object.hasOwn(STATUS_LABELS, value)) throw invalid();
	return value as IncidentNotificationStatus;
}

/** Centralized content per event. Only the incident number is interpolated. */
function content(
	event: DomainNotificationEvent,
	incidentNumber: number
): { title: string; message: string; payload: Record<string, unknown> } {
	const ref = `#${incidentNumber}`;
	switch (event.eventType) {
		case 'incident.assigned':
			return {
				title: 'Incidencia asignada',
				message: `Se te ha asignado la incidencia ${ref}.`,
				payload: { incidentId: event.incidentId } satisfies IncidentAssignedPayload
			};
		case 'incident.unassigned':
			return {
				title: 'Incidencia desasignada',
				message: `Ya no tienes asignada la incidencia ${ref}.`,
				payload: { incidentId: event.incidentId } satisfies IncidentUnassignedPayload
			};
		case 'incident.status_changed': {
			const previousStatus = status(event.previousStatus);
			const newStatus = status(event.newStatus);
			if (previousStatus === newStatus) throw invalid();
			return {
				title: 'Estado de incidencia actualizado',
				message: `La incidencia ${ref} ha pasado de ${STATUS_LABELS[previousStatus]} a ${STATUS_LABELS[newStatus]}.`,
				payload: {
					incidentId: event.incidentId,
					previousStatus,
					newStatus
				} satisfies IncidentStatusChangedPayload
			};
		}
		case 'incident.reopened': {
			if (event.previousStatus !== 'resolved' && event.previousStatus !== 'closed') throw invalid();
			return {
				title: 'Incidencia reabierta',
				message: `La incidencia ${ref} se ha reabierto.`,
				payload: {
					incidentId: event.incidentId,
					previousStatus: event.previousStatus,
					newStatus: 'open'
				} satisfies IncidentReopenedPayload
			};
		}
		case 'incident.public_comment_added':
			if (typeof event.commentId !== 'string' || !uuid.test(event.commentId)) throw invalid();
			return {
				title: 'Nuevo comentario',
				message: `Hay un nuevo comentario en la incidencia ${ref}.`,
				payload: {
					incidentId: event.incidentId,
					commentId: event.commentId
				} satisfies IncidentPublicCommentPayload
			};
		default:
			// sla.* and anything else: not produced by domain mutations.
			throw invalid();
	}
}

/**
 * Emits the in-app notifications for one domain event on the caller's transaction.
 * notification.type === eventType. Returns how many notifications were created.
 */
export async function produceDomainNotification(
	tx: IncidentDatabase,
	event: DomainNotificationEvent
): Promise<{ created: number }> {
	if (!event || typeof event !== 'object') throw invalid();
	if (typeof event.incidentId !== 'string' || !uuid.test(event.incidentId)) throw invalid();
	if (typeof event.organizationId !== 'string' || !uuid.test(event.organizationId)) throw invalid();

	const [incident] = await tx
		.select({ incidentNumber: incidents.incidentNumber })
		.from(incidents)
		.where(
			and(eq(incidents.id, event.incidentId), eq(incidents.organizationId, event.organizationId))
		)
		.limit(1);
	if (!incident) throw new NotificationProducerError('INCIDENT_NOT_FOUND', 'Incident not found');

	// Content first: an unsupported/invalid event fails before any recipient lookup or insert.
	const { title, message, payload } = content(event, incident.incidentNumber);
	const recipients = await resolveNotificationRecipients(
		tx,
		event.eventType === 'incident.unassigned'
			? {
					eventType: event.eventType,
					organizationId: event.organizationId,
					incidentId: event.incidentId,
					actorUserId: event.actorUserId,
					previousAssigneeUserId: event.previousAssigneeUserId
				}
			: {
					eventType: event.eventType,
					organizationId: event.organizationId,
					incidentId: event.incidentId,
					actorUserId: event.actorUserId
				}
	);

	for (const recipientUserId of recipients) {
		await createNotification(tx, {
			organizationId: event.organizationId,
			recipientUserId,
			type: event.eventType,
			title,
			message,
			payload
		});
	}
	return { created: recipients.length };
}

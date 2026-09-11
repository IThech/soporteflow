import type { AppUser } from '$lib/types/user';
import type { Incident, IncidentStatus } from '$lib/types/incident';
import type { IncidentMessage } from '$lib/types/incident-message';
import type { Notification, NotificationType, DynamicSlaAlert } from '$lib/types/notification';
import { canAccessOrganization } from '$lib/auth/permissions';
import { canViewIncident } from '$lib/auth/record-access';
import { incidentOrganizationId } from './assignment';
import { evaluateIncidentSla } from './sla';

export interface EventNotificationInput {
	type: NotificationType;
	incident: Incident;
	actor: AppUser;
	newAssigneeId?: string;
	message?: IncidentMessage;
	reason?: string;
	previousStatus?: IncidentStatus;
	nextStatus?: IncidentStatus;
	authorName?: string;
}

const statusDisplayLabels: Record<IncidentStatus, string> = {
	open: 'abierta',
	pending: 'pendiente',
	resolved: 'resuelta',
	closed: 'cerrada'
};

function truncate(text: string, maxLength = 100): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxLength) return trimmed;
	return trimmed.slice(0, maxLength - 1) + '…';
}

/**
 * Pure domain builder that determines the recipient and content for persistent incident events.
 * Returns null if:
 * - Recipient is the actor (self-action rule)
 * - Recipient cannot be determined (e.g. unassigned technician or missing client user)
 * - Recipient is unauthorized (e.g. client receiving internal note)
 */
export function buildIncidentNotification(
	input: EventNotificationInput,
	timestamp = new Date().toISOString()
): Notification | null {
	const { type, incident, actor, newAssigneeId, message, reason, nextStatus } = input;
	const orgId = incidentOrganizationId(incident);
	let recipientUserId: string;
	let title: string;
	let body: string;

	switch (type) {
		case 'incident_assigned': {
			const targetId = newAssigneeId ?? incident.assignedToUserId;
			if (!targetId || targetId === actor.id) return null;
			recipientUserId = targetId;
			title = `Te han asignado la incidencia #${incident.id}`;
			body = reason?.trim() ? `${incident.title} (Motivo: ${reason.trim()})` : incident.title;
			break;
		}

		case 'incident_reassigned': {
			const targetId = newAssigneeId ?? incident.assignedToUserId;
			if (!targetId || targetId === actor.id) return null;
			recipientUserId = targetId;
			title = `Te han reasignado la incidencia #${incident.id}`;
			body = reason?.trim() ? `${incident.title} (Motivo: ${reason.trim()})` : incident.title;
			break;
		}

		case 'incident_escalated': {
			// If assignee changed, recipient is new assignee; otherwise current assignee
			const targetId = newAssigneeId ?? incident.assignedToUserId;
			if (!targetId || targetId === actor.id) return null;
			recipientUserId = targetId;
			title = `Incidencia #${incident.id} escalada`;
			body = reason?.trim() ? `${incident.title} · ${reason.trim()}` : incident.title;
			break;
		}

		case 'incident_comment': {
			if (!message) return null;
			const isAuthorClient = actor.role === 'client';

			if (isAuthorClient) {
				// Client commented -> notify assigned technician
				if (!incident.assignedToUserId || incident.assignedToUserId === actor.id) {
					return null;
				}
				recipientUserId = incident.assignedToUserId;
			} else {
				// Staff commented -> notify incident client owner
				if (!incident.clientUserId || incident.clientUserId === actor.id) {
					return null;
				}
				recipientUserId = incident.clientUserId;
			}

			title = `Nuevo comentario en #${incident.id}`;
			body = truncate(message.content);
			break;
		}

		case 'incident_internal_note': {
			if (!message) return null;
			// Internal notes are strictly for staff. Notify assigned technician if not the author.
			if (!incident.assignedToUserId || incident.assignedToUserId === actor.id) {
				return null;
			}
			recipientUserId = incident.assignedToUserId;
			title = `Nueva nota interna en #${incident.id}`;
			body = truncate(message.content);
			break;
		}

		case 'incident_status_changed': {
			const status = nextStatus ?? incident.status;
			const statusLabel = statusDisplayLabels[status] ?? status;

			if (actor.role === 'client') {
				// Client changed status -> notify technician
				if (!incident.assignedToUserId || incident.assignedToUserId === actor.id) {
					return null;
				}
				recipientUserId = incident.assignedToUserId;
			} else {
				// Staff changed status -> notify client owner
				if (!incident.clientUserId || incident.clientUserId === actor.id) {
					return null;
				}
				recipientUserId = incident.clientUserId;
			}

			title = `Estado actualizado en #${incident.id}`;
			body = `La incidencia #${incident.id} ahora está ${statusLabel}.`;
			break;
		}

		case 'incident_resolved': {
			if (!incident.clientUserId || incident.clientUserId === actor.id) {
				return null;
			}
			recipientUserId = incident.clientUserId;
			title = `Incidencia #${incident.id} resuelta`;
			body = `La incidencia "${incident.title}" ha sido marcada como resuelta.`;
			break;
		}

		case 'incident_reopened': {
			if (!incident.assignedToUserId || incident.assignedToUserId === actor.id) {
				return null;
			}
			recipientUserId = incident.assignedToUserId;
			title = `Incidencia #${incident.id} reabierta`;
			body = reason?.trim()
				? `La incidencia "${incident.title}" ha sido reabierta: "${reason.trim()}"`
				: `La incidencia "${incident.title}" ha sido reabierta.`;
			break;
		}

		case 'incident_closed': {
			if (actor.role === 'client') {
				if (!incident.assignedToUserId || incident.assignedToUserId === actor.id) {
					return null;
				}
				recipientUserId = incident.assignedToUserId;
				title = `Incidencia #${incident.id} cerrada`;
				body = `El cliente ha confirmado la solución de "${incident.title}".`;
			} else {
				if (!incident.clientUserId || incident.clientUserId === actor.id) {
					return null;
				}
				recipientUserId = incident.clientUserId;
				title = `Incidencia #${incident.id} cerrada`;
				body = `La incidencia "${incident.title}" ha sido cerrada.`;
			}
			break;
		}

		default:
			return null;
	}

	if (!recipientUserId) return null;

	return {
		id: crypto.randomUUID(),
		organizationId: orgId,
		recipientUserId,
		type,
		incidentId: incident.id,
		title,
		message: body,
		createdAt: timestamp,
		readAt: null
	};
}

/**
 * Filters notifications visible to a specific user, strictly enforcing multi-tenant
 * isolation and recipient identity. Clients never receive internal notes.
 */
export function filterUserNotifications(
	user: AppUser,
	notifications: Notification[]
): Notification[] {
	if (!user.active) return [];

	return notifications
		.filter((notification) => {
			if (notification.recipientUserId !== user.id) return false;
			if (!canAccessOrganization(user, notification.organizationId)) return false;
			if (user.role === 'client' && notification.type === 'incident_internal_note') return false;
			return true;
		})
		.toSorted(
			(a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id)
		);
}

/**
 * Calculates unread count of persistent notifications for a user.
 */
export function countUnreadNotifications(user: AppUser, notifications: Notification[]): number {
	const userNotifications = filterUserNotifications(user, notifications);
	return userNotifications.filter((n) => n.readAt === null).length;
}

/**
 * Pure transition: marks a single notification as read.
 */
export function markNotificationAsRead(
	notifications: Notification[],
	notificationId: string,
	timestamp = new Date().toISOString()
): Notification[] {
	return notifications.map((n) =>
		n.id === notificationId && n.readAt === null ? { ...n, readAt: timestamp } : n
	);
}

/**
 * Pure transition: marks all notifications of a recipient as read.
 */
export function markAllNotificationsAsRead(
	notifications: Notification[],
	recipientUserId: string,
	organizationId?: string,
	timestamp = new Date().toISOString()
): Notification[] {
	return notifications.map((n) => {
		if (n.recipientUserId !== recipientUserId || n.readAt !== null) {
			return n;
		}
		if (organizationId && n.organizationId !== organizationId) {
			return n;
		}
		return { ...n, readAt: timestamp };
	});
}

/**
 * Pure transition: removes persisted notifications belonging to a specific recipient and organization.
 * Preserves notifications belonging to other users or other organizations.
 */
export function clearUserNotifications(
	notifications: Notification[],
	recipientUserId: string,
	organizationId?: string
): Notification[] {
	return notifications.filter((n) => {
		if (n.recipientUserId !== recipientUserId) return true;
		if (organizationId && n.organizationId !== organizationId) return true;
		return false;
	});
}

/**
 * Calculates dynamic in-memory SLA alerts ('approaching' and 'breached') for open/active
 * incidents requiring the user's attention. Reuses the existing SLA evaluation engine
 * without persisting state to localStorage or duplicating logic.
 */
export function deriveDynamicSlaAlerts(
	user: AppUser,
	incidents: Incident[],
	now: Date | string | number = new Date()
): DynamicSlaAlert[] {
	if (!user.active) return [];

	const alerts: DynamicSlaAlert[] = [];

	for (const incident of incidents) {
		if (!incident || typeof incident.id !== 'number' || !incident.sla) continue;
		// Resolved or closed incidents are no longer in active progress and do not generate dynamic alerts
		if (incident.status === 'resolved' || incident.status === 'closed') continue;
		if (!canViewIncident(user, incident)) continue;

		// Filter incidents requiring attention by role:
		// - Technician: incidents assigned to them
		// - Client: incidents owned by them
		// - Organization Admin: incidents in their organization
		// - Platform Admin: all accessible incidents
		if (user.role === 'technician' && incident.assignedToUserId !== user.id) {
			continue;
		}
		if (user.role === 'client' && incident.clientUserId !== user.id) {
			continue;
		}

		const evaluation = evaluateIncidentSla(incident, now);

		// First response target (active only if not yet fulfilled)
		if (incident.sla.firstRespondedAt === null) {
			const stage = evaluation.firstResponse.stage;
			if (stage === 'approaching' || stage === 'breached') {
				const isApproaching = stage === 'approaching';
				const rem = evaluation.firstResponse.remainingMinutes;
				const message = isApproaching
					? rem !== null && rem > 0
						? `Quedan ${rem} minutos para primera respuesta`
						: 'Primera respuesta próxima a vencer'
					: 'Se ha superado el tiempo de primera respuesta';

				alerts.push({
					id: `dynamic-sla-${incident.id}-first_response-${stage}`,
					incidentId: incident.id,
					target: 'first_response',
					stage,
					title: isApproaching
						? `SLA próximo a vencer · #${incident.id}`
						: `SLA incumplido · #${incident.id}`,
					message,
					dueAt: incident.sla.firstResponseDueAt
				});
			}
		}

		// Resolution target (incident is active)
		const resolutionStage = evaluation.resolution.stage;
		if (resolutionStage === 'approaching' || resolutionStage === 'breached') {
			const isApproaching = resolutionStage === 'approaching';
			const rem = evaluation.resolution.remainingMinutes;
			const message = isApproaching
				? rem !== null && rem > 0
					? `Quedan ${rem} minutos para resolución`
					: 'Resolución próxima a vencer'
				: 'Se ha superado el tiempo de resolución';

			alerts.push({
				id: `dynamic-sla-${incident.id}-resolution-${resolutionStage}`,
				incidentId: incident.id,
				target: 'resolution',
				stage: resolutionStage,
				title: isApproaching
					? `SLA próximo a vencer · #${incident.id}`
					: `SLA incumplido · #${incident.id}`,
				message,
				dueAt: incident.sla.resolutionDueAt
			});
		}
	}

	// Sort alerts: breached first, then by earliest deadline
	return alerts.toSorted((a, b) => {
		if (a.stage === 'breached' && b.stage !== 'breached') return -1;
		if (b.stage === 'breached' && a.stage !== 'breached') return 1;
		return Date.parse(a.dueAt) - Date.parse(b.dueAt);
	});
}

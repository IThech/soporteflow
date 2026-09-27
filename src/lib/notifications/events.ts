/**
 * Canonical notification event catalog (5.4U-B). Shared by server and client (no imports).
 *
 * The set is intentionally minimal: only events that 5.4U-C will actually produce and that have a
 * clear, bounded audience. Not included yet (no clear recipient value or too noisy for Core v1):
 * incident.created, priority/category/site/support-level changes. notifications.type in the
 * database stays extensible; this catalog governs preferences and recipient rules only.
 *
 * Defaults per channel (5.4U-D): in-app ON, email OFF for every event (existing users never start
 * receiving unexpected emails). A missing preference row, or a NULL channel column, means "default";
 * a stored boolean is an explicit override for that channel only.
 */
export const NOTIFICATION_EVENT_TYPES = [
	'incident.assigned',
	'incident.unassigned',
	'incident.status_changed',
	'incident.public_comment_added',
	'incident.reopened',
	'sla.first_response_breached',
	'sla.resolution_breached'
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export const NOTIFICATION_EVENT_DEFAULTS: Readonly<
	Record<NotificationEventType, { readonly inAppEnabled: boolean; readonly emailEnabled: boolean }>
> = Object.freeze({
	'incident.assigned': { inAppEnabled: true, emailEnabled: false },
	'incident.unassigned': { inAppEnabled: true, emailEnabled: false },
	'incident.status_changed': { inAppEnabled: true, emailEnabled: false },
	'incident.public_comment_added': { inAppEnabled: true, emailEnabled: false },
	'incident.reopened': { inAppEnabled: true, emailEnabled: false },
	'sla.first_response_breached': { inAppEnabled: true, emailEnabled: false },
	'sla.resolution_breached': { inAppEnabled: true, emailEnabled: false }
});

export const NOTIFICATION_CHANNELS = ['in_app', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export function isNotificationEventType(value: unknown): value is NotificationEventType {
	return (
		typeof value === 'string' && (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value)
	);
}

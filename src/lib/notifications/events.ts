/**
 * Canonical notification event catalog (5.4U-B). Shared by server and client (no imports).
 *
 * The set is intentionally minimal: only events that 5.4U-C will actually produce and that have a
 * clear, bounded audience. Not included yet (no clear recipient value or too noisy for Core v1):
 * incident.created, priority/category/site/support-level changes. notifications.type in the
 * database stays extensible; this catalog governs preferences and recipient rules only.
 *
 * Default: every catalogued event is enabled in-app. A missing preference row means "default";
 * a stored row is an explicit override (true or false).
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
	Record<NotificationEventType, { readonly inAppEnabled: boolean }>
> = Object.freeze({
	'incident.assigned': { inAppEnabled: true },
	'incident.unassigned': { inAppEnabled: true },
	'incident.status_changed': { inAppEnabled: true },
	'incident.public_comment_added': { inAppEnabled: true },
	'incident.reopened': { inAppEnabled: true },
	'sla.first_response_breached': { inAppEnabled: true },
	'sla.resolution_breached': { inAppEnabled: true }
});

export function isNotificationEventType(value: unknown): value is NotificationEventType {
	return (
		typeof value === 'string' && (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value)
	);
}

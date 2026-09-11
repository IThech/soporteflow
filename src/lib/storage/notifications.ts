import type { Notification, NotificationType } from '$lib/types/notification';

export const NOTIFICATIONS_KEY = 'soporteflow-notifications';

export const NOTIFICATION_TYPES: readonly NotificationType[] = [
	'incident_assigned',
	'incident_reassigned',
	'incident_escalated',
	'incident_comment',
	'incident_internal_note',
	'incident_status_changed',
	'incident_resolved',
	'incident_reopened',
	'incident_closed'
] as const;

export type NotificationLoadResult =
	| { status: 'missing'; notifications: Notification[] }
	| { status: 'valid'; notifications: Notification[] }
	| { status: 'corrupt'; error: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && !!v.trim();

const isValidTimestamp = (v: unknown): v is string =>
	typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));

export function isNotification(value: unknown): value is Notification {
	if (!isObject(value)) return false;

	if (
		!isNonEmptyString(value.id) ||
		!isNonEmptyString(value.organizationId) ||
		!isNonEmptyString(value.recipientUserId) ||
		!isNonEmptyString(value.title) ||
		!isNonEmptyString(value.message)
	) {
		return false;
	}

	if (!NOTIFICATION_TYPES.includes(value.type as NotificationType)) {
		return false;
	}

	if (!Number.isSafeInteger(value.incidentId) || (value.incidentId as number) <= 0) {
		return false;
	}

	if (!isValidTimestamp(value.createdAt)) {
		return false;
	}

	if (value.readAt !== null && !isValidTimestamp(value.readAt)) {
		return false;
	}

	return true;
}

export function isNotificationList(value: unknown): value is Notification[] {
	if (!Array.isArray(value)) return false;
	const ids = new Set<string>();
	for (const item of value) {
		if (!isNotification(item)) return false;
		if (ids.has(item.id)) return false;
		ids.add(item.id);
	}
	return true;
}

/**
 * Loads notifications from raw localStorage string, explicitly differentiating
 * between missing (empty initially), valid (including saved empty list), and corrupt.
 */
export function loadNotificationsResult(raw: string | null): NotificationLoadResult {
	if (raw === null) {
		return { status: 'missing', notifications: [] };
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (isNotificationList(parsed)) {
			return { status: 'valid', notifications: parsed };
		}
		return {
			status: 'corrupt',
			error: 'Las notificaciones guardadas están corruptas o no cumplen el esquema.'
		};
	} catch {
		return {
			status: 'corrupt',
			error: 'El contenido guardado de notificaciones no es un JSON válido.'
		};
	}
}

/**
 * Direct load helper that throws on corrupt data to prevent silent data loss.
 */
export function loadNotifications(raw: string | null): Notification[] {
	const result = loadNotificationsResult(raw);
	if (result.status === 'corrupt') {
		throw new Error(result.error);
	}
	return result.notifications;
}

/**
 * Saves notifications to storage with optimistic concurrency check.
 */
export function saveNotifications(
	storage: Pick<Storage, 'getItem' | 'setItem'>,
	list: Notification[],
	expectedRaw: string | null
): string {
	if (storage.getItem(NOTIFICATIONS_KEY) !== expectedRaw) {
		throw new Error('Las notificaciones han cambiado en otra pestaña. Recarga antes de continuar.');
	}
	if (!isNotificationList(list)) {
		throw new Error('No se pueden guardar notificaciones con formato inválido.');
	}
	const raw = JSON.stringify(list);
	storage.setItem(NOTIFICATIONS_KEY, raw);
	return raw;
}

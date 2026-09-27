/**
 * Typed client for the caller's own notification preferences (5.4U-B).
 * fetch + runtime validation + typed errors only: no session handling, storage or UI.
 * Tenant travels only in the query string; identity comes from the session cookie.
 */
import {
	NOTIFICATION_EVENT_TYPES,
	isNotificationEventType,
	type NotificationEventType
} from '../notifications/events.ts';

export { NOTIFICATION_EVENT_TYPES, type NotificationEventType };

export interface NotificationPreference {
	eventType: NotificationEventType;
	inAppEnabled: boolean;
	/** true: no override stored, the value is the catalog default. */
	isDefault: boolean;
}

export interface NotificationPreferenceRequestOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

export class NotificationPreferenceApiError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'NotificationPreferenceApiError';
		this.status = status;
		this.code = code;
	}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalidInput = () =>
	new NotificationPreferenceApiError(0, 'INVALID_INPUT', 'Solicitud no válida.');
const invalidPayload = (status: number) =>
	new NotificationPreferenceApiError(
		status,
		'INVALID_PAYLOAD',
		'No se pudo interpretar la respuesta del servidor.'
	);

function assertOrganization(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !UUID.test(value)) throw invalidInput();
}
function assertEventType(value: unknown): asserts value is NotificationEventType {
	if (!isNotificationEventType(value)) throw invalidInput();
}

async function send(
	url: string,
	options: NotificationPreferenceRequestOptions | undefined,
	method: 'GET' | 'PUT' | 'DELETE',
	body?: unknown
): Promise<Response> {
	const fetchFn = options?.customFetch ?? fetch;
	const init: RequestInit = { method, signal: options?.signal, credentials: 'same-origin' };
	if (body !== undefined) {
		init.headers = { 'Content-Type': 'application/json' };
		init.body = JSON.stringify(body);
	}
	try {
		return await fetchFn(url, init);
	} catch (err: unknown) {
		if ((err as Error)?.name === 'AbortError' || options?.signal?.aborted) throw err;
		throw new NotificationPreferenceApiError(
			0,
			'NETWORK_ERROR',
			'No se pudo conectar con el servidor.'
		);
	}
}

/** Fixed messages; only the status is used, never the backend message. */
function failure(res: Response): NotificationPreferenceApiError {
	if (res.status === 400)
		return new NotificationPreferenceApiError(400, 'INVALID_INPUT', 'Solicitud no válida.');
	if (res.status === 401)
		return new NotificationPreferenceApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida.');
	if (res.status === 403)
		return new NotificationPreferenceApiError(
			403,
			'FORBIDDEN',
			'No tienes acceso a las preferencias de esta organización.'
		);
	return new NotificationPreferenceApiError(
		res.status,
		res.status >= 500 ? 'SERVER_ERROR' : 'INTERNAL_ERROR',
		'No se pudieron guardar o cargar las preferencias. Inténtalo de nuevo.'
	);
}

async function readObject(res: Response): Promise<Record<string, unknown>> {
	let data: unknown;
	try {
		data = await res.json();
	} catch {
		throw invalidPayload(res.status);
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidPayload(res.status);
	return data as Record<string, unknown>;
}

/** Strict allowlist: rebuilds the preference, extra fields are dropped. */
function parsePreference(raw: unknown, status: number): NotificationPreference {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidPayload(status);
	const p = raw as Record<string, unknown>;
	if (
		!isNotificationEventType(p.eventType) ||
		typeof p.inAppEnabled !== 'boolean' ||
		typeof p.isDefault !== 'boolean'
	)
		throw invalidPayload(status);
	return { eventType: p.eventType, inAppEnabled: p.inAppEnabled, isDefault: p.isDefault };
}

function url(organizationId: string, eventType?: NotificationEventType): string {
	const path = eventType
		? `/api/notification-preferences/${encodeURIComponent(eventType)}`
		: '/api/notification-preferences';
	return `${path}?${new URLSearchParams({ organizationId }).toString()}`;
}

/** GET: every catalogued event with its effective value (exactly the catalog, in order). */
export async function listNotificationPreferences(
	organizationId: string,
	options?: NotificationPreferenceRequestOptions
): Promise<NotificationPreference[]> {
	assertOrganization(organizationId);
	const res = await send(url(organizationId), options, 'GET');
	if (!res.ok) throw failure(res);
	const data = await readObject(res);
	if (!Array.isArray(data.preferences)) throw invalidPayload(res.status);
	const preferences = data.preferences.map((p) => parsePreference(p, res.status));
	const types = preferences.map((p) => p.eventType);
	if (new Set(types).size !== types.length || types.length !== NOTIFICATION_EVENT_TYPES.length)
		throw invalidPayload(res.status);
	return preferences;
}

/** PUT: stores the final value for this event (override). */
export async function setNotificationPreference(
	organizationId: string,
	eventType: NotificationEventType,
	inAppEnabled: boolean,
	options?: NotificationPreferenceRequestOptions
): Promise<NotificationPreference> {
	assertOrganization(organizationId);
	assertEventType(eventType);
	if (typeof inAppEnabled !== 'boolean') throw invalidInput();
	const res = await send(url(organizationId, eventType), options, 'PUT', { inAppEnabled });
	if (!res.ok) throw failure(res);
	const preference = parsePreference((await readObject(res)).preference, res.status);
	if (
		preference.eventType !== eventType ||
		preference.inAppEnabled !== inAppEnabled ||
		preference.isDefault
	)
		throw invalidPayload(res.status);
	return preference;
}

/** DELETE: back to the catalog default (idempotent, 204). */
export async function resetNotificationPreference(
	organizationId: string,
	eventType: NotificationEventType,
	options?: NotificationPreferenceRequestOptions
): Promise<void> {
	assertOrganization(organizationId);
	assertEventType(eventType);
	const res = await send(url(organizationId, eventType), options, 'DELETE');
	if (!res.ok) throw failure(res);
	if (res.status !== 204) throw invalidPayload(res.status);
}

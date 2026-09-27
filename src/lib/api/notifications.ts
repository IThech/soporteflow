/** Personal in-app inbox. No metadata payload is exposed until a typed event contract exists. */
export interface NotificationDto {
	id: string;
	type: string;
	title: string;
	message: string;
	readAt: string | null;
	createdAt: string;
	updatedAt: string;
}
export interface NotificationPage {
	items: NotificationDto[];
	nextCursor: string | null;
}
export interface NotificationRequestOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}
export interface NotificationListOptions extends NotificationRequestOptions {
	status?: 'read' | 'unread';
	limit?: number;
	cursor?: string;
}
export class NotificationApiError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'NotificationApiError';
		this.status = status;
		this.code = code;
	}
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = () => new NotificationApiError(0, 'INVALID_INPUT', 'Solicitud no válida.');
const invalid = (status: number) =>
	new NotificationApiError(
		status,
		'INVALID_PAYLOAD',
		'No se pudo interpretar la respuesta del servidor.'
	);
function assertId(id: unknown): asserts id is string {
	if (typeof id !== 'string' || !uuid.test(id)) throw bad();
}
function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
function date(value: unknown): value is string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(value))
		return false;
	const normalized = value.slice(0, 23) + 'Z';
	const d = new Date(normalized);
	return Number.isFinite(d.getTime()) && d.toISOString() === normalized;
}
function parse(value: unknown, status: number, id?: string): NotificationDto {
	if (
		!object(value) ||
		typeof value.id !== 'string' ||
		!uuid.test(value.id) ||
		(id && value.id !== id) ||
		typeof value.type !== 'string' ||
		value.type.length > 80 ||
		!/^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/.test(value.type) ||
		typeof value.title !== 'string' ||
		!value.title.trim() ||
		value.title.length > 160 ||
		value.title.includes('\u0000') ||
		typeof value.message !== 'string' ||
		!value.message.trim() ||
		value.message.length > 2000 ||
		value.message.includes('\u0000') ||
		!(value.readAt === null || date(value.readAt)) ||
		!date(value.createdAt) ||
		!date(value.updatedAt)
	)
		throw invalid(status);
	return {
		id: value.id,
		type: value.type,
		title: value.title,
		message: value.message,
		readAt: value.readAt,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt
	};
}
function url(org: string, id?: string): string {
	assertId(org);
	if (id !== undefined) assertId(id);
	return (
		'/api/notifications' +
		(id ? '/' + encodeURIComponent(id) : '') +
		'?organizationId=' +
		encodeURIComponent(org)
	);
}
async function send(
	url: string,
	options: NotificationRequestOptions,
	method = 'GET',
	body?: unknown
): Promise<Response> {
	let response: Response;
	try {
		response = await (options.customFetch ?? fetch)(url, {
			method,
			credentials: 'same-origin',
			signal: options.signal,
			...(body === undefined
				? {}
				: { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
		});
	} catch (error) {
		if ((error as Error)?.name === 'AbortError' || options.signal?.aborted) throw error;
		throw new NotificationApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.');
	}
	if (!response.ok) {
		const codes: Record<number, [string, string]> = {
			400: ['INVALID_INPUT', 'Solicitud no válida.'],
			401: ['UNAUTHORIZED', 'Tu sesión ya no es válida.'],
			403: ['FORBIDDEN', 'No tienes acceso a estas notificaciones.'],
			404: ['NOTIFICATION_NOT_FOUND', 'La notificación no está disponible.']
		};
		const [code, message] = codes[response.status] ?? [
			'INTERNAL_ERROR',
			'No se pudo completar la operación.'
		];
		throw new NotificationApiError(response.status, code, message);
	}
	return response;
}
async function json(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		throw invalid(res.status);
	}
}
async function item(res: Response, id?: string) {
	const data = await json(res);
	if (!object(data)) throw invalid(res.status);
	return parse(data.notification, res.status, id);
}
async function noContent(res: Response) {
	if (res.status !== 204) throw invalid(res.status);
}
export async function listNotifications(
	organizationId: string,
	options: NotificationListOptions = {}
): Promise<NotificationPage> {
	let endpoint = url(organizationId);
	if (options.status !== undefined) {
		if (!['read', 'unread'].includes(options.status)) throw bad();
		endpoint += '&status=' + options.status;
	}
	if (options.limit !== undefined) {
		if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw bad();
		endpoint += '&limit=' + options.limit;
	}
	if (options.cursor !== undefined) {
		if (!/^[A-Za-z0-9_-]{1,256}$/.test(options.cursor)) throw bad();
		endpoint += '&cursor=' + encodeURIComponent(options.cursor);
	}
	const res = await send(endpoint, options),
		data = await json(res);
	if (
		!object(data) ||
		!Array.isArray(data.items) ||
		!(
			data.nextCursor === null ||
			(typeof data.nextCursor === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(data.nextCursor))
		)
	)
		throw invalid(res.status);
	return { items: data.items.map((i) => parse(i, res.status)), nextCursor: data.nextCursor };
}
export async function getNotification(
	org: string,
	id: string,
	options: NotificationRequestOptions = {}
) {
	return item(await send(url(org, id), options), id);
}
export async function markNotificationRead(
	org: string,
	id: string,
	options: NotificationRequestOptions = {}
) {
	return item(await send(url(org, id), options, 'PATCH', { read: true }), id);
}
export async function markNotificationUnread(
	org: string,
	id: string,
	options: NotificationRequestOptions = {}
) {
	return item(await send(url(org, id), options, 'PATCH', { read: false }), id);
}
export async function deleteNotification(
	org: string,
	id: string,
	options: NotificationRequestOptions = {}
) {
	return noContent(await send(url(org, id), options, 'DELETE'));
}
export async function clearNotifications(
	org: string,
	scope: 'read' | 'all',
	options: NotificationRequestOptions = {}
) {
	if (scope !== 'read' && scope !== 'all') throw bad();
	return noContent(await send(url(org) + '&scope=' + scope, options, 'DELETE'));
}
export async function markAllNotificationsRead(
	org: string,
	options: NotificationRequestOptions = {}
) {
	assertId(org);
	return noContent(
		await send(
			'/api/notifications/read-all?organizationId=' + encodeURIComponent(org),
			options,
			'POST',
			{}
		)
	);
}
export async function getUnreadNotificationCount(
	org: string,
	options: NotificationRequestOptions = {}
): Promise<number> {
	assertId(org);
	const res = await send(
			'/api/notifications/unread-count?organizationId=' + encodeURIComponent(org),
			options
		),
		data = await json(res);
	if (
		!object(data) ||
		typeof data.unreadCount !== 'number' ||
		!Number.isSafeInteger(data.unreadCount) ||
		data.unreadCount < 0
	)
		throw invalid(res.status);
	return data.unreadCount;
}

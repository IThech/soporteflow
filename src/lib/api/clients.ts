/**
 * Typed client for the real clients catalog (/api/clients).
 * fetch + runtime validation + typed errors only: no session handling, navigation or storage.
 * Tenant travels only in the query string; identity comes from the session cookie.
 */
import { ApiError, responseErrorMeta, type ApiErrorMeta } from './errors.ts';

export interface Client {
	id: string;
	name: string;
	description?: string | null;
	active: boolean;
	createdAt: string;
	updatedAt: string;
}

export class ClientApiError extends ApiError {
	constructor(status: number, code: string, message: string, meta: ApiErrorMeta = {}) {
		super(status, code, message, meta);
		this.name = 'ClientApiError';
	}
}

interface ClientRequestOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

export interface ListClientsInput extends ClientRequestOptions {
	organizationId: string;
	activeOnly?: boolean;
}

export interface GetClientInput extends ClientRequestOptions {
	organizationId: string;
	clientId: string;
}

export interface CreateClientInput extends ClientRequestOptions {
	organizationId: string;
	name: string;
	description?: string | null;
}

export interface RenameClientInput extends ClientRequestOptions {
	organizationId: string;
	clientId: string;
	name: string;
}

export interface UpdateClientInput extends ClientRequestOptions {
	organizationId: string;
	clientId: string;
	name?: string;
	description?: string | null;
}

export interface SetClientActiveInput extends ClientRequestOptions {
	organizationId: string;
	clientId: string;
	active: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const NAME_MAX_LENGTH = 255;

type Action = 'list' | 'get' | 'create' | 'rename' | 'update' | 'set_active';

const FAILURE_TEXT: Record<Action, string> = {
	list: 'No se pudieron cargar los clientes. Inténtalo de nuevo.',
	get: 'No se pudo cargar el cliente. Inténtalo de nuevo.',
	create: 'No se pudo crear el cliente. Inténtalo de nuevo.',
	rename: 'No se pudo renombrar el cliente. Inténtalo de nuevo.',
	update: 'No se pudo actualizar el cliente. Inténtalo de nuevo.',
	set_active: 'No se pudo cambiar el estado del cliente. Inténtalo de nuevo.'
};

function invalidInput(message: string): ClientApiError {
	return new ClientApiError(0, 'INVALID_INPUT', message);
}

function invalidPayload(status: number): ClientApiError {
	return new ClientApiError(
		status,
		'INVALID_PAYLOAD',
		'No se pudo interpretar la respuesta del servidor.'
	);
}

function assertUuid(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || !UUID.test(value)) {
		throw invalidInput(`Identificador de ${label} no válido.`);
	}
}

function assertName(name: unknown): asserts name is string {
	if (typeof name !== 'string' || name.trim().length === 0) {
		throw invalidInput('El nombre del cliente no es válido.');
	}
	if (name.trim().length > NAME_MAX_LENGTH) {
		throw invalidInput(`El nombre del cliente no puede superar ${NAME_MAX_LENGTH} caracteres.`);
	}
}

function clientUrl(organizationId: string, clientId?: string, query: Record<string, string> = {}) {
	const params = new URLSearchParams({ organizationId, ...query });
	const path =
		clientId === undefined ? '/api/clients' : `/api/clients/${encodeURIComponent(clientId)}`;
	return `${path}?${params.toString()}`;
}

async function send(
	url: string,
	init: RequestInit,
	options: ClientRequestOptions
): Promise<Response> {
	const fetchFn = options.customFetch ?? fetch;
	try {
		return await fetchFn(url, {
			...init,
			signal: options.signal,
			headers: {
				Accept: 'application/json',
				...(init.headers ?? {})
			}
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') throw error;
		throw new ClientApiError(0, 'NETWORK_ERROR', 'Comprueba tu conexión e inténtalo de nuevo.');
	}
}

function parseClientItem(item: unknown): Client {
	if (!item || typeof item !== 'object') throw invalidPayload(200);
	const raw = item as Record<string, unknown>;
	if (
		typeof raw.id !== 'string' ||
		!UUID.test(raw.id) ||
		typeof raw.name !== 'string' ||
		raw.name.trim().length === 0 ||
		typeof raw.active !== 'boolean' ||
		typeof raw.createdAt !== 'string' ||
		!ISO_DATE.test(raw.createdAt) ||
		typeof raw.updatedAt !== 'string' ||
		!ISO_DATE.test(raw.updatedAt)
	) {
		throw invalidPayload(200);
	}
	const description =
		raw.description === null || raw.description === undefined
			? null
			: typeof raw.description === 'string'
				? raw.description
				: null;
	return {
		id: raw.id,
		name: raw.name,
		description,
		active: raw.active,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt
	};
}

async function handleFailure(response: Response, action: Action): Promise<never> {
	const meta = responseErrorMeta(response);
	let code = response.status === 403 ? 'FORBIDDEN' : 'UNKNOWN_ERROR';
	let serverMessage = FAILURE_TEXT[action];
	try {
		const body = (await response.json()) as { error?: { code?: string; message?: string } };
		if (body?.error?.code && typeof body.error.code === 'string') {
			code = body.error.code;
			if (body.error.message && typeof body.error.message === 'string') {
				serverMessage = body.error.message;
			}
		}
	} catch {
		// Non-JSON failure body: fallback defaults kept
	}

	if (response.status === 409 && code === 'CLIENT_NAME_DUPLICATE') {
		throw new ClientApiError(
			response.status,
			'CLIENT_NAME_DUPLICATE',
			'Ya existe un cliente con este nombre en la organización.',
			meta
		);
	}
	if (response.status === 404 && code === 'CLIENT_NOT_FOUND') {
		throw new ClientApiError(response.status, 'CLIENT_NOT_FOUND', 'El cliente no existe.', meta);
	}
	if (response.status === 403) {
		throw new ClientApiError(
			response.status,
			'FORBIDDEN',
			'No tienes permisos para realizar esta acción.',
			meta
		);
	}
	if (response.status === 401) {
		throw new ClientApiError(response.status, 'UNAUTHORIZED', 'La sesión ha caducado.', meta);
	}

	throw new ClientApiError(response.status, code, serverMessage, meta);
}

export async function listClients(input: ListClientsInput): Promise<Client[]> {
	assertUuid(input?.organizationId, 'organización');
	const query: Record<string, string> = {};
	if (input.activeOnly !== undefined) query.activeOnly = String(input.activeOnly);
	const response = await send(
		clientUrl(input.organizationId, undefined, query),
		{ method: 'GET' },
		input
	);
	if (!response.ok) await handleFailure(response, 'list');
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw invalidPayload(response.status);
	}
	if (!payload || typeof payload !== 'object') throw invalidPayload(response.status);
	const raw = payload as Record<string, unknown>;
	if (!Array.isArray(raw.clients)) throw invalidPayload(response.status);
	return raw.clients.map(parseClientItem);
}

export async function getClient(input: GetClientInput): Promise<Client> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input?.clientId, 'cliente');
	const response = await send(
		clientUrl(input.organizationId, input.clientId),
		{ method: 'GET' },
		input
	);
	if (!response.ok) await handleFailure(response, 'get');
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw invalidPayload(response.status);
	}
	if (!payload || typeof payload !== 'object') throw invalidPayload(response.status);
	const raw = payload as Record<string, unknown>;
	return parseClientItem(raw.client);
}

export async function createClient(input: CreateClientInput): Promise<Client> {
	assertUuid(input?.organizationId, 'organización');
	assertName(input?.name);
	const body: Record<string, unknown> = { name: input.name.trim() };
	if (input.description !== undefined && input.description !== null) {
		body.description = String(input.description).trim();
	}
	const response = await send(
		clientUrl(input.organizationId),
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		},
		input
	);
	if (!response.ok) await handleFailure(response, 'create');
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw invalidPayload(response.status);
	}
	if (!payload || typeof payload !== 'object') throw invalidPayload(response.status);
	const raw = payload as Record<string, unknown>;
	return parseClientItem(raw.client);
}

export async function renameClient(input: RenameClientInput): Promise<Client> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input?.clientId, 'cliente');
	assertName(input?.name);
	const response = await send(
		clientUrl(input.organizationId, input.clientId),
		{
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'rename', name: input.name.trim() })
		},
		input
	);
	if (!response.ok) await handleFailure(response, 'rename');
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw invalidPayload(response.status);
	}
	if (!payload || typeof payload !== 'object') throw invalidPayload(response.status);
	const raw = payload as Record<string, unknown>;
	return parseClientItem(raw.client);
}

export async function updateClient(input: UpdateClientInput): Promise<Client> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input?.clientId, 'cliente');
	const body: Record<string, unknown> = { action: 'edit' };
	if (input.name !== undefined) {
		assertName(input.name);
		body.name = input.name.trim();
	}
	if (input.description !== undefined) {
		body.description = input.description ? input.description.trim() : null;
	}
	const response = await send(
		clientUrl(input.organizationId, input.clientId),
		{
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		},
		input
	);
	if (!response.ok) await handleFailure(response, 'update');
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw invalidPayload(response.status);
	}
	if (!payload || typeof payload !== 'object') throw invalidPayload(response.status);
	const raw = payload as Record<string, unknown>;
	return parseClientItem(raw.client);
}

export async function setClientActive(input: SetClientActiveInput): Promise<Client> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input?.clientId, 'cliente');
	if (typeof input?.active !== 'boolean') {
		throw invalidInput('El estado debe ser un booleano.');
	}
	const response = await send(
		clientUrl(input.organizationId, input.clientId),
		{
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'set_active', active: input.active })
		},
		input
	);
	if (!response.ok) await handleFailure(response, 'set_active');
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw invalidPayload(response.status);
	}
	if (!payload || typeof payload !== 'object') throw invalidPayload(response.status);
	const raw = payload as Record<string, unknown>;
	return parseClientItem(raw.client);
}

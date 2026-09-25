/**
 * Typed client for the real sites catalog (/api/sites).
 * fetch + runtime validation + typed errors only: no session handling, navigation or storage.
 * Tenant travels only in the query string; identity comes from the session cookie.
 */

export interface Site {
	id: string;
	name: string;
	active: boolean;
	createdAt: string;
	updatedAt: string;
}

export class SiteApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'SiteApiError';
		this.status = status;
		this.code = code;
	}
}

interface SiteRequestOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

export interface ListSitesInput extends SiteRequestOptions {
	organizationId: string;
	activeOnly?: boolean;
}

export interface CreateSiteInput extends SiteRequestOptions {
	organizationId: string;
	name: string;
}

export interface RenameSiteInput extends SiteRequestOptions {
	organizationId: string;
	siteId: string;
	name: string;
}

export interface SetSiteActiveInput extends SiteRequestOptions {
	organizationId: string;
	siteId: string;
	active: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const NAME_MAX_LENGTH = 255;

type Action = 'list' | 'create' | 'rename' | 'set_active';

const FAILURE_TEXT: Record<Action, string> = {
	list: 'No se pudieron cargar las sedes. Inténtalo de nuevo.',
	create: 'No se pudo crear la sede. Inténtalo de nuevo.',
	rename: 'No se pudo renombrar la sede. Inténtalo de nuevo.',
	set_active: 'No se pudo cambiar el estado de la sede. Inténtalo de nuevo.'
};

function invalidInput(message: string): SiteApiError {
	return new SiteApiError(0, 'INVALID_INPUT', message);
}

function invalidPayload(status: number): SiteApiError {
	return new SiteApiError(
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
		throw invalidInput('El nombre de la sede no es válido.');
	}
}

function siteUrl(organizationId: string, siteId?: string, query: Record<string, string> = {}) {
	const params = new URLSearchParams({ organizationId, ...query });
	const path = siteId === undefined ? '/api/sites' : `/api/sites/${encodeURIComponent(siteId)}`;
	return `${path}?${params.toString()}`;
}

async function send(
	url: string,
	init: RequestInit,
	options: SiteRequestOptions
): Promise<Response> {
	const fetchFn = options.customFetch ?? fetch;
	try {
		return await fetchFn(url, { ...init, signal: options.signal });
	} catch (err: unknown) {
		if (err instanceof SiteApiError) throw err;
		if ((err as Error)?.name === 'AbortError' || options.signal?.aborted) throw err;
		throw new SiteApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.');
	}
}

/** Fixed client messages; only the backend error code is read, never its message. */
async function failure(res: Response, action: Action): Promise<SiteApiError> {
	let backendCode: unknown;
	try {
		backendCode = ((await res.json()) as { error?: { code?: unknown } })?.error?.code;
	} catch {
		backendCode = undefined;
	}
	if (res.status === 400) {
		return new SiteApiError(400, 'INVALID_INPUT', 'Revisa los datos de la sede.');
	}
	if (res.status === 401) {
		return new SiteApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida.');
	}
	if (res.status === 403) {
		return new SiteApiError(403, 'FORBIDDEN', 'No tienes permisos para gestionar las sedes.');
	}
	if (res.status === 404) {
		return backendCode === 'SITE_NOT_FOUND'
			? new SiteApiError(404, 'SITE_NOT_FOUND', 'La sede no está disponible.')
			: new SiteApiError(404, 'NOT_FOUND', 'El recurso solicitado no está disponible.');
	}
	if (res.status === 409) {
		return backendCode === 'SITE_NAME_DUPLICATE'
			? new SiteApiError(409, 'SITE_NAME_DUPLICATE', 'Ya existe una sede con ese nombre.')
			: new SiteApiError(409, 'CONFLICT', FAILURE_TEXT[action]);
	}
	if (res.status >= 500) {
		return new SiteApiError(res.status, 'SERVER_ERROR', FAILURE_TEXT[action]);
	}
	return new SiteApiError(res.status, 'INTERNAL_ERROR', FAILURE_TEXT[action]);
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

function validDate(value: unknown): value is string {
	return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

/** Strict allowlist: rebuilds the site so no extra backend field reaches the UI. */
function parseSite(raw: unknown, status: number): Site {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidPayload(status);
	const site = raw as Record<string, unknown>;
	if (
		typeof site.id !== 'string' ||
		!UUID.test(site.id) ||
		typeof site.name !== 'string' ||
		site.name.trim().length === 0 ||
		site.name.length > NAME_MAX_LENGTH ||
		typeof site.active !== 'boolean' ||
		!validDate(site.createdAt) ||
		!validDate(site.updatedAt)
	) {
		throw invalidPayload(status);
	}
	return {
		id: site.id,
		name: site.name,
		active: site.active,
		createdAt: site.createdAt,
		updatedAt: site.updatedAt
	};
}

async function mutate(
	url: string,
	method: 'POST' | 'PATCH',
	body: Record<string, unknown>,
	action: Action,
	options: SiteRequestOptions
): Promise<Site> {
	const res = await send(
		url,
		{ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
		options
	);
	if (!res.ok) throw await failure(res, action);
	return parseSite((await readObject(res)).site, res.status);
}

/** GET /api/sites?organizationId=<UUID>[&activeOnly=true|false] */
export async function listSites(input: ListSitesInput): Promise<Site[]> {
	assertUuid(input?.organizationId, 'organización');
	const query: Record<string, string> = {};
	if (input.activeOnly !== undefined) {
		if (typeof input.activeOnly !== 'boolean') throw invalidInput('Filtro de sedes no válido.');
		query.activeOnly = String(input.activeOnly);
	}
	const res = await send(siteUrl(input.organizationId, undefined, query), { method: 'GET' }, input);
	if (!res.ok) throw await failure(res, 'list');
	const data = await readObject(res);
	if (!Array.isArray(data.sites)) throw invalidPayload(res.status);
	const sites = data.sites.map((site) => parseSite(site, res.status));
	if (new Set(sites.map((site) => site.id)).size !== sites.length) throw invalidPayload(res.status);
	return sites;
}

/** POST /api/sites?organizationId=<UUID> with body exactly { name }. */
export async function createSite(input: CreateSiteInput): Promise<Site> {
	assertUuid(input?.organizationId, 'organización');
	assertName(input.name);
	return mutate(siteUrl(input.organizationId), 'POST', { name: input.name }, 'create', input);
}

/** PATCH /api/sites/<id>?organizationId=<UUID> with body exactly { action: 'rename', name }. */
export async function renameSite(input: RenameSiteInput): Promise<Site> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.siteId, 'sede');
	assertName(input.name);
	return mutate(
		siteUrl(input.organizationId, input.siteId),
		'PATCH',
		{ action: 'rename', name: input.name },
		'rename',
		input
	);
}

/** PATCH /api/sites/<id>?organizationId=<UUID> with body exactly { action: 'set_active', active }. */
export async function setSiteActive(input: SetSiteActiveInput): Promise<Site> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.siteId, 'sede');
	if (typeof input.active !== 'boolean') throw invalidInput('Estado de sede no válido.');
	return mutate(
		siteUrl(input.organizationId, input.siteId),
		'PATCH',
		{ action: 'set_active', active: input.active },
		'set_active',
		input
	);
}

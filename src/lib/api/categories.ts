/**
 * Typed client for the real categories catalog (/api/categories).
 * fetch + runtime validation + typed errors only: no session handling, navigation or storage.
 * Tenant travels only in the query string; identity comes from the session cookie.
 */

export interface Category {
	id: string;
	name: string;
	description: string | null;
	active: boolean;
	createdAt: string;
	updatedAt: string;
}

export class CategoryApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'CategoryApiError';
		this.status = status;
		this.code = code;
	}
}

interface CategoryRequestOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

export interface ListCategoriesInput extends CategoryRequestOptions {
	organizationId: string;
	activeOnly?: boolean;
}

export interface CreateCategoryInput extends CategoryRequestOptions {
	organizationId: string;
	name: string;
	/** Omitted: stored as null. null or blank: stored as null. */
	description?: string | null;
}

export interface UpdateCategoryInput extends CategoryRequestOptions {
	organizationId: string;
	categoryId: string;
	/** At least one of name / description is required. */
	name?: string;
	/** null clears the description; omitted keeps it. */
	description?: string | null;
}

export interface SetCategoryActiveInput extends CategoryRequestOptions {
	organizationId: string;
	categoryId: string;
	active: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 1000;

type Action = 'list' | 'create' | 'update' | 'set_active';

const FAILURE_TEXT: Record<Action, string> = {
	list: 'No se pudieron cargar las categorías. Inténtalo de nuevo.',
	create: 'No se pudo crear la categoría. Inténtalo de nuevo.',
	update: 'No se pudo actualizar la categoría. Inténtalo de nuevo.',
	set_active: 'No se pudo cambiar el estado de la categoría. Inténtalo de nuevo.'
};

function invalidInput(message: string): CategoryApiError {
	return new CategoryApiError(0, 'INVALID_INPUT', message);
}

function invalidPayload(status: number): CategoryApiError {
	return new CategoryApiError(
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
		throw invalidInput('El nombre de la categoría no es válido.');
	}
}

function assertDescription(description: unknown): asserts description is string | null {
	if (description !== null && typeof description !== 'string') {
		throw invalidInput('La descripción de la categoría no es válida.');
	}
}

function categoryUrl(
	organizationId: string,
	categoryId?: string,
	query: Record<string, string> = {}
) {
	const params = new URLSearchParams({ organizationId, ...query });
	const path =
		categoryId === undefined
			? '/api/categories'
			: `/api/categories/${encodeURIComponent(categoryId)}`;
	return `${path}?${params.toString()}`;
}

async function send(
	url: string,
	init: RequestInit,
	options: CategoryRequestOptions
): Promise<Response> {
	const fetchFn = options.customFetch ?? fetch;
	try {
		return await fetchFn(url, { ...init, signal: options.signal });
	} catch (err: unknown) {
		if (err instanceof CategoryApiError) throw err;
		if ((err as Error)?.name === 'AbortError' || options.signal?.aborted) throw err;
		throw new CategoryApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.');
	}
}

/** Fixed client messages; only the backend error code is read, never its message. */
async function failure(res: Response, action: Action): Promise<CategoryApiError> {
	let backendCode: unknown;
	try {
		backendCode = ((await res.json()) as { error?: { code?: unknown } })?.error?.code;
	} catch {
		backendCode = undefined;
	}
	if (res.status === 400) {
		return new CategoryApiError(400, 'INVALID_INPUT', 'Revisa los datos de la categoría.');
	}
	if (res.status === 401) {
		return new CategoryApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida.');
	}
	if (res.status === 403) {
		return new CategoryApiError(
			403,
			'FORBIDDEN',
			'No tienes permisos para gestionar las categorías.'
		);
	}
	if (res.status === 404) {
		return backendCode === 'CATEGORY_NOT_FOUND'
			? new CategoryApiError(404, 'CATEGORY_NOT_FOUND', 'La categoría no está disponible.')
			: new CategoryApiError(404, 'NOT_FOUND', 'El recurso solicitado no está disponible.');
	}
	if (res.status === 409) {
		return backendCode === 'CATEGORY_NAME_DUPLICATE'
			? new CategoryApiError(
					409,
					'CATEGORY_NAME_DUPLICATE',
					'Ya existe una categoría con ese nombre.'
				)
			: new CategoryApiError(409, 'CONFLICT', FAILURE_TEXT[action]);
	}
	if (res.status >= 500) {
		return new CategoryApiError(res.status, 'SERVER_ERROR', FAILURE_TEXT[action]);
	}
	return new CategoryApiError(res.status, 'INTERNAL_ERROR', FAILURE_TEXT[action]);
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

/** Strict allowlist: rebuilds the category so no extra backend field reaches the UI. */
function parseCategory(raw: unknown, status: number): Category {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidPayload(status);
	const category = raw as Record<string, unknown>;
	if (
		typeof category.id !== 'string' ||
		!UUID.test(category.id) ||
		typeof category.name !== 'string' ||
		category.name.trim().length === 0 ||
		category.name.length > NAME_MAX_LENGTH ||
		(category.description !== null &&
			(typeof category.description !== 'string' ||
				category.description.length > DESCRIPTION_MAX_LENGTH)) ||
		typeof category.active !== 'boolean' ||
		!validDate(category.createdAt) ||
		!validDate(category.updatedAt)
	) {
		throw invalidPayload(status);
	}
	return {
		id: category.id,
		name: category.name,
		description: category.description as string | null,
		active: category.active,
		createdAt: category.createdAt,
		updatedAt: category.updatedAt
	};
}

async function mutate(
	url: string,
	method: 'POST' | 'PATCH',
	body: Record<string, unknown>,
	action: Action,
	options: CategoryRequestOptions
): Promise<Category> {
	const res = await send(
		url,
		{ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
		options
	);
	if (!res.ok) throw await failure(res, action);
	return parseCategory((await readObject(res)).category, res.status);
}

/** GET /api/categories?organizationId=<UUID>[&activeOnly=true|false] */
export async function listCategories(input: ListCategoriesInput): Promise<Category[]> {
	assertUuid(input?.organizationId, 'organización');
	const query: Record<string, string> = {};
	if (input.activeOnly !== undefined) {
		if (typeof input.activeOnly !== 'boolean')
			throw invalidInput('Filtro de categorías no válido.');
		query.activeOnly = String(input.activeOnly);
	}
	const res = await send(
		categoryUrl(input.organizationId, undefined, query),
		{ method: 'GET' },
		input
	);
	if (!res.ok) throw await failure(res, 'list');
	const data = await readObject(res);
	if (!Array.isArray(data.categories)) throw invalidPayload(res.status);
	const categories = data.categories.map((category) => parseCategory(category, res.status));
	if (new Set(categories.map((category) => category.id)).size !== categories.length)
		throw invalidPayload(res.status);
	return categories;
}

/** POST /api/categories?organizationId=<UUID> with body exactly { name, description? }. */
export async function createCategory(input: CreateCategoryInput): Promise<Category> {
	assertUuid(input?.organizationId, 'organización');
	assertName(input.name);
	const body: Record<string, unknown> = { name: input.name };
	if (input.description !== undefined) {
		assertDescription(input.description);
		body.description = input.description;
	}
	return mutate(categoryUrl(input.organizationId), 'POST', body, 'create', input);
}

/** PATCH /api/categories/<id> with body exactly { action: 'update', name?, description? }. */
export async function updateCategory(input: UpdateCategoryInput): Promise<Category> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.categoryId, 'categoría');
	if (input.name === undefined && input.description === undefined) {
		throw invalidInput('Indica el nombre o la descripción de la categoría.');
	}
	const body: Record<string, unknown> = { action: 'update' };
	if (input.name !== undefined) {
		assertName(input.name);
		body.name = input.name;
	}
	if (input.description !== undefined) {
		assertDescription(input.description);
		body.description = input.description;
	}
	return mutate(
		categoryUrl(input.organizationId, input.categoryId),
		'PATCH',
		body,
		'update',
		input
	);
}

/** PATCH /api/categories/<id> with body exactly { action: 'set_active', active }. */
export async function setCategoryActive(input: SetCategoryActiveInput): Promise<Category> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.categoryId, 'categoría');
	if (typeof input.active !== 'boolean') throw invalidInput('Estado de categoría no válido.');
	return mutate(
		categoryUrl(input.organizationId, input.categoryId),
		'PATCH',
		{ action: 'set_active', active: input.active },
		'set_active',
		input
	);
}

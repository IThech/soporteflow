/**
 * Typed client for the subcategories catalog (/api/subcategories).
 * fetch + runtime validation + typed errors only: no session handling, navigation or storage.
 * Tenant travels only in the query string; identity comes from the session cookie.
 */
import { ApiError, responseErrorMeta, type ApiErrorMeta } from './errors.ts';
import type { Category } from './categories.ts';

export interface Subcategory {
	id: string;
	categoryId: string;
	name: string;
	description: string | null;
	active: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface CategoryWithSubcategories extends Category {
	subcategories: Subcategory[];
}

export class SubcategoryApiError extends ApiError {
	constructor(status: number, code: string, message: string, meta: ApiErrorMeta = {}) {
		super(status, code, message, meta);
		this.name = 'SubcategoryApiError';
	}
}

interface RequestOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

export interface ListSubcategoriesInput extends RequestOptions {
	organizationId: string;
	categoryId?: string;
	activeOnly?: boolean;
}

export interface CreateSubcategoryInput extends RequestOptions {
	organizationId: string;
	categoryId: string;
	name: string;
	description?: string | null;
}

export interface UpdateSubcategoryInput extends RequestOptions {
	organizationId: string;
	subcategoryId: string;
	name?: string;
	description?: string | null;
}

export interface SetSubcategoryActiveInput extends RequestOptions {
	organizationId: string;
	subcategoryId: string;
	active: boolean;
}

export interface GetCategoryTreeInput extends RequestOptions {
	organizationId: string;
	activeOnly?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 1000;

type Action = 'list' | 'create' | 'update' | 'set_active' | 'tree';

const FAILURE_TEXT: Record<Action, string> = {
	list: 'No se pudieron cargar las subcategorías. Inténtalo de nuevo.',
	tree: 'No se pudieron cargar las categorías. Inténtalo de nuevo.',
	create: 'No se pudo crear la subcategoría. Inténtalo de nuevo.',
	update: 'No se pudo actualizar la subcategoría. Inténtalo de nuevo.',
	set_active: 'No se pudo cambiar el estado de la subcategoría. Inténtalo de nuevo.'
};

function invalidInput(message: string): SubcategoryApiError {
	return new SubcategoryApiError(0, 'INVALID_INPUT', message);
}

function invalidPayload(status: number): SubcategoryApiError {
	return new SubcategoryApiError(
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
		throw invalidInput('El nombre de la subcategoría no es válido.');
	}
}

function assertDescription(description: unknown): asserts description is string | null {
	if (description !== null && typeof description !== 'string') {
		throw invalidInput('La descripción de la subcategoría no es válida.');
	}
}

function subcategoryUrl(
	organizationId: string,
	subcategoryId?: string,
	query: Record<string, string> = {}
) {
	const params = new URLSearchParams({ organizationId, ...query });
	const path =
		subcategoryId === undefined
			? '/api/subcategories'
			: `/api/subcategories/${encodeURIComponent(subcategoryId)}`;
	return `${path}?${params.toString()}`;
}

async function send(url: string, init: RequestInit, options: RequestOptions): Promise<Response> {
	const fetchFn = options.customFetch ?? fetch;
	try {
		return await fetchFn(url, { ...init, signal: options.signal });
	} catch (err: unknown) {
		if (err instanceof SubcategoryApiError) throw err;
		if ((err as Error)?.name === 'AbortError' || options.signal?.aborted) throw err;
		throw new SubcategoryApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.');
	}
}

async function failure(res: Response, action: Action): Promise<SubcategoryApiError> {
	const classified = await classifyFailure(res, action);
	return new SubcategoryApiError(
		classified.status,
		classified.code,
		classified.message,
		responseErrorMeta(res)
	);
}

async function classifyFailure(res: Response, action: Action): Promise<SubcategoryApiError> {
	let backendCode: unknown;
	try {
		backendCode = ((await res.json()) as { error?: { code?: unknown } })?.error?.code;
	} catch {
		backendCode = undefined;
	}
	if (res.status === 400) {
		return new SubcategoryApiError(400, 'INVALID_INPUT', 'Revisa los datos de la subcategoría.');
	}
	if (res.status === 401) {
		return new SubcategoryApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida.');
	}
	if (res.status === 403) {
		return new SubcategoryApiError(
			403,
			'FORBIDDEN',
			'No tienes permisos para gestionar las subcategorías.'
		);
	}
	if (res.status === 404) {
		if (backendCode === 'SUBCATEGORY_NOT_FOUND')
			return new SubcategoryApiError(
				404,
				'SUBCATEGORY_NOT_FOUND',
				'La subcategoría no está disponible.'
			);
		if (backendCode === 'CATEGORY_NOT_FOUND')
			return new SubcategoryApiError(404, 'CATEGORY_NOT_FOUND', 'La categoría no está disponible.');
		return new SubcategoryApiError(404, 'NOT_FOUND', 'El recurso solicitado no está disponible.');
	}
	if (res.status === 409) {
		if (backendCode === 'SUBCATEGORY_NAME_DUPLICATE')
			return new SubcategoryApiError(
				409,
				'SUBCATEGORY_NAME_DUPLICATE',
				'Ya existe una subcategoría con ese nombre en esta categoría.'
			);
		if (backendCode === 'CATEGORY_INACTIVE')
			return new SubcategoryApiError(409, 'CATEGORY_INACTIVE', 'La categoría no está activa.');
		if (backendCode === 'SUBCATEGORY_INACTIVE')
			return new SubcategoryApiError(
				409,
				'SUBCATEGORY_INACTIVE',
				'La subcategoría no está activa.'
			);
		return new SubcategoryApiError(409, 'CONFLICT', FAILURE_TEXT[action]);
	}
	if (res.status >= 500) {
		return new SubcategoryApiError(res.status, 'SERVER_ERROR', FAILURE_TEXT[action]);
	}
	return new SubcategoryApiError(res.status, 'INTERNAL_ERROR', FAILURE_TEXT[action]);
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

function parseSubcategory(raw: unknown, status: number): Subcategory {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidPayload(status);
	const sub = raw as Record<string, unknown>;
	if (
		typeof sub.id !== 'string' ||
		!UUID.test(sub.id) ||
		typeof sub.categoryId !== 'string' ||
		!UUID.test(sub.categoryId) ||
		typeof sub.name !== 'string' ||
		sub.name.trim().length === 0 ||
		sub.name.length > NAME_MAX_LENGTH ||
		(sub.description !== null &&
			(typeof sub.description !== 'string' || sub.description.length > DESCRIPTION_MAX_LENGTH)) ||
		typeof sub.active !== 'boolean' ||
		!validDate(sub.createdAt) ||
		!validDate(sub.updatedAt)
	) {
		throw invalidPayload(status);
	}
	return {
		id: sub.id,
		categoryId: sub.categoryId,
		name: sub.name,
		description: sub.description as string | null,
		active: sub.active,
		createdAt: sub.createdAt,
		updatedAt: sub.updatedAt
	};
}

function parseCategoryTreeNode(raw: unknown, status: number): CategoryWithSubcategories {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidPayload(status);
	const cat = raw as Record<string, unknown>;
	if (
		typeof cat.id !== 'string' ||
		!UUID.test(cat.id) ||
		typeof cat.name !== 'string' ||
		cat.name.trim().length === 0 ||
		cat.name.length > NAME_MAX_LENGTH ||
		(cat.description !== null &&
			(typeof cat.description !== 'string' || cat.description.length > DESCRIPTION_MAX_LENGTH)) ||
		typeof cat.active !== 'boolean' ||
		!validDate(cat.createdAt) ||
		!validDate(cat.updatedAt) ||
		!Array.isArray(cat.subcategories)
	) {
		throw invalidPayload(status);
	}
	const subcategories = cat.subcategories.map((s) => parseSubcategory(s, status));
	return {
		id: cat.id,
		name: cat.name,
		description: cat.description as string | null,
		active: cat.active,
		createdAt: cat.createdAt,
		updatedAt: cat.updatedAt,
		subcategories
	};
}

async function mutate(
	url: string,
	method: 'POST' | 'PATCH',
	body: Record<string, unknown>,
	action: Action,
	options: RequestOptions
): Promise<Subcategory> {
	const res = await send(
		url,
		{ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
		options
	);
	if (!res.ok) throw await failure(res, action);
	return parseSubcategory((await readObject(res)).subcategory, res.status);
}

/** GET /api/subcategories?organizationId=<UUID>[&categoryId=<UUID>][&activeOnly=true|false] */
export async function listSubcategories(input: ListSubcategoriesInput): Promise<Subcategory[]> {
	assertUuid(input?.organizationId, 'organización');
	const query: Record<string, string> = {};
	if (input.categoryId !== undefined) {
		assertUuid(input.categoryId, 'categoría');
		query.categoryId = input.categoryId;
	}
	if (input.activeOnly !== undefined) {
		if (typeof input.activeOnly !== 'boolean')
			throw invalidInput('Filtro de subcategorías no válido.');
		query.activeOnly = String(input.activeOnly);
	}
	const res = await send(
		subcategoryUrl(input.organizationId, undefined, query),
		{ method: 'GET' },
		input
	);
	if (!res.ok) throw await failure(res, 'list');
	const data = await readObject(res);
	if (!Array.isArray(data.subcategories)) throw invalidPayload(res.status);
	const subcategories = data.subcategories.map((sub) => parseSubcategory(sub, res.status));
	if (new Set(subcategories.map((sub) => sub.id)).size !== subcategories.length)
		throw invalidPayload(res.status);
	return subcategories;
}

/** GET /api/categories?organizationId=<UUID>&tree=true[&activeOnly=true|false] */
export async function getCategoryTree(
	input: GetCategoryTreeInput
): Promise<CategoryWithSubcategories[]> {
	assertUuid(input?.organizationId, 'organización');
	const query: Record<string, string> = { tree: 'true' };
	if (input.activeOnly !== undefined) {
		if (typeof input.activeOnly !== 'boolean')
			throw invalidInput('Filtro de categorías no válido.');
		query.activeOnly = String(input.activeOnly);
	}
	const params = new URLSearchParams({ organizationId: input.organizationId, ...query });
	const res = await send(`/api/categories?${params.toString()}`, { method: 'GET' }, input);
	if (!res.ok) throw await failure(res, 'tree');
	const data = await readObject(res);
	if (!Array.isArray(data.categories)) throw invalidPayload(res.status);
	const nodes = data.categories.map((node) => parseCategoryTreeNode(node, res.status));
	return nodes;
}

/** POST /api/subcategories?organizationId=<UUID> with body { categoryId, name, description? }. */
export async function createSubcategory(input: CreateSubcategoryInput): Promise<Subcategory> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.categoryId, 'categoría');
	assertName(input.name);
	const body: Record<string, unknown> = {
		categoryId: input.categoryId,
		name: input.name
	};
	if (input.description !== undefined) {
		assertDescription(input.description);
		body.description = input.description;
	}
	return mutate(subcategoryUrl(input.organizationId), 'POST', body, 'create', input);
}

/** PATCH /api/subcategories/<id> with body { action: 'update', name?, description? }. */
export async function updateSubcategory(input: UpdateSubcategoryInput): Promise<Subcategory> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.subcategoryId, 'subcategoría');
	if (input.name === undefined && input.description === undefined) {
		throw invalidInput('Indica el nombre o la descripción de la subcategoría.');
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
		subcategoryUrl(input.organizationId, input.subcategoryId),
		'PATCH',
		body,
		'update',
		input
	);
}

/** PATCH /api/subcategories/<id> with body { action: 'set_active', active }. */
export async function setSubcategoryActive(input: SetSubcategoryActiveInput): Promise<Subcategory> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.subcategoryId, 'subcategoría');
	if (typeof input.active !== 'boolean') throw invalidInput('Estado de subcategoría no válido.');
	return mutate(
		subcategoryUrl(input.organizationId, input.subcategoryId),
		'PATCH',
		{ action: 'set_active', active: input.active },
		'set_active',
		input
	);
}

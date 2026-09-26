/**
 * Typed client for SLA policy configuration (/api/sla-policies, 5.4T-A).
 * fetch + runtime validation + typed errors only: no session handling, navigation or storage.
 * Tenant travels only in the query string; identity comes from the session cookie.
 * Targets are 24x7 elapsed minutes. UI actions must be gated by /api/me capabilities.
 */

export const SLA_TARGET_MAX_MINUTES = 5_256_000;

export interface SlaPolicy {
	id: string;
	code: string;
	name: string;
	description: string | null;
	active: boolean;
	isDefault: boolean;
	firstResponseMinutes: number;
	resolutionMinutes: number;
	createdAt: string;
	updatedAt: string;
}

export class SlaPolicyApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'SlaPolicyApiError';
		this.status = status;
		this.code = code;
	}
}

interface SlaRequestOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

export interface ListSlaPoliciesInput extends SlaRequestOptions {
	organizationId: string;
	active?: boolean;
	isDefault?: boolean;
}

export interface GetSlaPolicyInput extends SlaRequestOptions {
	organizationId: string;
	policyId: string;
}

export interface CreateSlaPolicyInput extends SlaRequestOptions {
	organizationId: string;
	policy: {
		code: string;
		name: string;
		description?: string | null;
		firstResponseMinutes: number;
		resolutionMinutes: number;
		isDefault?: boolean;
	};
}

/** Partial update; code is immutable. */
export interface UpdateSlaPolicyPatch {
	name?: string;
	description?: string | null;
	active?: boolean;
	firstResponseMinutes?: number;
	resolutionMinutes?: number;
	isDefault?: boolean;
}

export interface UpdateSlaPolicyInput extends SlaRequestOptions {
	organizationId: string;
	policyId: string;
	patch: UpdateSlaPolicyPatch;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const PATCH_KEYS = [
	'name',
	'description',
	'active',
	'firstResponseMinutes',
	'resolutionMinutes',
	'isDefault'
] as const;

type Action = 'list' | 'detail' | 'create' | 'update';

const FAILURE_TEXT: Record<Action, string> = {
	list: 'No se pudieron cargar las políticas SLA. Inténtalo de nuevo.',
	detail: 'No se pudo cargar la política SLA. Inténtalo de nuevo.',
	create: 'No se pudo crear la política SLA. Inténtalo de nuevo.',
	update: 'No se pudo actualizar la política SLA. Inténtalo de nuevo.'
};

const CONFLICT: Record<string, string> = {
	SLA_POLICY_CODE_CONFLICT: 'Ya existe una política SLA con ese código.',
	SLA_POLICY_INVALID_DEFAULT: 'Solo una política SLA activa puede ser la predeterminada.'
};

function invalidInput(message: string): SlaPolicyApiError {
	return new SlaPolicyApiError(0, 'INVALID_INPUT', message);
}

function invalidPayload(status: number): SlaPolicyApiError {
	return new SlaPolicyApiError(
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

function isMinutes(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value >= 1 &&
		value <= SLA_TARGET_MAX_MINUTES
	);
}

async function send(
	url: string,
	options: SlaRequestOptions,
	method: 'GET' | 'POST' | 'PATCH' = 'GET',
	body?: unknown
): Promise<Response> {
	const fetchFn = options.customFetch ?? fetch;
	const init: RequestInit = { method, signal: options.signal };
	if (body !== undefined) {
		init.headers = { 'Content-Type': 'application/json' };
		init.body = JSON.stringify(body);
	}
	try {
		return await fetchFn(url, init);
	} catch (err: unknown) {
		if (err instanceof SlaPolicyApiError) throw err;
		if ((err as Error)?.name === 'AbortError' || options.signal?.aborted) throw err;
		throw new SlaPolicyApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.');
	}
}

/** Fixed client messages; only the backend error code is read, never its message. */
async function failure(res: Response, action: Action): Promise<SlaPolicyApiError> {
	let backendCode: unknown;
	try {
		backendCode = ((await res.json()) as { error?: { code?: unknown } })?.error?.code;
	} catch {
		backendCode = undefined;
	}
	const code = typeof backendCode === 'string' ? backendCode : '';
	if (res.status === 400) {
		return code === 'SLA_POLICY_INVALID_TARGET'
			? new SlaPolicyApiError(
					400,
					'SLA_POLICY_INVALID_TARGET',
					'Los objetivos deben ser minutos enteros y la resolución no puede ser menor que la primera respuesta.'
				)
			: new SlaPolicyApiError(400, 'INVALID_INPUT', 'Solicitud no válida.');
	}
	if (res.status === 401)
		return new SlaPolicyApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida.');
	if (res.status === 403)
		return new SlaPolicyApiError(
			403,
			'FORBIDDEN',
			action === 'list' || action === 'detail'
				? 'No tienes permisos para consultar las políticas SLA.'
				: 'No tienes permisos para gestionar las políticas SLA.'
		);
	if (res.status === 404)
		return code === 'SLA_POLICY_NOT_FOUND'
			? new SlaPolicyApiError(404, 'SLA_POLICY_NOT_FOUND', 'La política SLA no está disponible.')
			: new SlaPolicyApiError(404, 'NOT_FOUND', 'El recurso solicitado no está disponible.');
	if (res.status === 409)
		return Object.hasOwn(CONFLICT, code)
			? new SlaPolicyApiError(409, code, CONFLICT[code])
			: new SlaPolicyApiError(409, 'CONFLICT', FAILURE_TEXT[action]);
	if (res.status >= 500)
		return new SlaPolicyApiError(res.status, 'SERVER_ERROR', FAILURE_TEXT[action]);
	return new SlaPolicyApiError(res.status, 'INTERNAL_ERROR', FAILURE_TEXT[action]);
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

function isIso(value: unknown): value is string {
	return typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));
}

/** Strict allowlist: rebuilds the policy so no extra backend field reaches the UI. */
function parsePolicy(raw: unknown, status: number): SlaPolicy {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidPayload(status);
	const p = raw as Record<string, unknown>;
	if (
		typeof p.id !== 'string' ||
		!UUID.test(p.id) ||
		typeof p.code !== 'string' ||
		!CODE.test(p.code) ||
		typeof p.name !== 'string' ||
		!p.name.trim() ||
		(p.description !== null && typeof p.description !== 'string') ||
		typeof p.active !== 'boolean' ||
		typeof p.isDefault !== 'boolean' ||
		(p.isDefault && !p.active) ||
		!isMinutes(p.firstResponseMinutes) ||
		!isMinutes(p.resolutionMinutes) ||
		p.resolutionMinutes < p.firstResponseMinutes ||
		!isIso(p.createdAt) ||
		!isIso(p.updatedAt)
	) {
		throw invalidPayload(status);
	}
	return {
		id: p.id,
		code: p.code,
		name: p.name,
		description: p.description as string | null,
		active: p.active,
		isDefault: p.isDefault,
		firstResponseMinutes: p.firstResponseMinutes,
		resolutionMinutes: p.resolutionMinutes,
		createdAt: p.createdAt,
		updatedAt: p.updatedAt
	};
}

function url(organizationId: string, policyId?: string, extra: Record<string, string> = {}) {
	const path = policyId ? `/api/sla-policies/${encodeURIComponent(policyId)}` : '/api/sla-policies';
	return `${path}?${new URLSearchParams({ organizationId, ...extra }).toString()}`;
}

/** GET /api/sla-policies?organizationId=<UUID>[&active][&isDefault] (requires sla:view). */
export async function listSlaPolicies(input: ListSlaPoliciesInput): Promise<SlaPolicy[]> {
	assertUuid(input?.organizationId, 'organización');
	const extra: Record<string, string> = {};
	for (const key of ['active', 'isDefault'] as const) {
		if (input[key] === undefined) continue;
		if (typeof input[key] !== 'boolean') throw invalidInput('Filtro no válido.');
		extra[key] = String(input[key]);
	}
	const res = await send(url(input.organizationId, undefined, extra), input);
	if (!res.ok) throw await failure(res, 'list');
	const data = await readObject(res);
	if (!Array.isArray(data.slaPolicies)) throw invalidPayload(res.status);
	const policies = data.slaPolicies.map((p) => parsePolicy(p, res.status));
	if (new Set(policies.map((p) => p.id)).size !== policies.length) throw invalidPayload(res.status);
	if (policies.filter((p) => p.isDefault).length > 1) throw invalidPayload(res.status);
	return policies;
}

/** GET /api/sla-policies/<id>?organizationId=<UUID> (requires sla:view). */
export async function getSlaPolicy(input: GetSlaPolicyInput): Promise<SlaPolicy> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.policyId, 'política SLA');
	const res = await send(url(input.organizationId, input.policyId), input);
	if (!res.ok) throw await failure(res, 'detail');
	const policy = parsePolicy((await readObject(res)).slaPolicy, res.status);
	if (policy.id !== input.policyId) throw invalidPayload(res.status);
	return policy;
}

/** POST /api/sla-policies?organizationId=<UUID> (requires sla:manage). */
export async function createSlaPolicy(input: CreateSlaPolicyInput): Promise<SlaPolicy> {
	assertUuid(input?.organizationId, 'organización');
	const p = input.policy;
	if (
		!p ||
		typeof p !== 'object' ||
		typeof p.code !== 'string' ||
		p.code.length < 3 ||
		p.code.length > 50 ||
		!CODE.test(p.code) ||
		typeof p.name !== 'string' ||
		!p.name.trim() ||
		(p.description !== undefined && p.description !== null && typeof p.description !== 'string') ||
		!isMinutes(p.firstResponseMinutes) ||
		!isMinutes(p.resolutionMinutes) ||
		p.resolutionMinutes < p.firstResponseMinutes ||
		(p.isDefault !== undefined && typeof p.isDefault !== 'boolean')
	)
		throw invalidInput('Datos de la política SLA no válidos.');
	const body: Record<string, unknown> = {
		code: p.code,
		name: p.name,
		firstResponseMinutes: p.firstResponseMinutes,
		resolutionMinutes: p.resolutionMinutes
	};
	if (p.description !== undefined) body.description = p.description;
	if (p.isDefault !== undefined) body.isDefault = p.isDefault;
	const res = await send(url(input.organizationId), input, 'POST', body);
	if (!res.ok) throw await failure(res, 'create');
	if (res.status !== 201) throw invalidPayload(res.status);
	const created = parsePolicy((await readObject(res)).slaPolicy, res.status);
	if (created.code !== p.code) throw invalidPayload(res.status);
	return created;
}

/** PATCH /api/sla-policies/<id>?organizationId=<UUID> (requires sla:manage). */
export async function updateSlaPolicy(input: UpdateSlaPolicyInput): Promise<SlaPolicy> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.policyId, 'política SLA');
	const patch = input.patch;
	if (!patch || typeof patch !== 'object' || Array.isArray(patch))
		throw invalidInput('Cambios de la política SLA no válidos.');
	const keys = Object.keys(patch).filter(
		(key) => (patch as Record<string, unknown>)[key] !== undefined
	);
	if (
		keys.length === 0 ||
		keys.some((key) => !(PATCH_KEYS as readonly string[]).includes(key)) ||
		(patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim())) ||
		(patch.description !== undefined &&
			patch.description !== null &&
			typeof patch.description !== 'string') ||
		(patch.active !== undefined && typeof patch.active !== 'boolean') ||
		(patch.isDefault !== undefined && typeof patch.isDefault !== 'boolean') ||
		(patch.firstResponseMinutes !== undefined && !isMinutes(patch.firstResponseMinutes)) ||
		(patch.resolutionMinutes !== undefined && !isMinutes(patch.resolutionMinutes))
	)
		throw invalidInput('Cambios de la política SLA no válidos.');
	const body: Record<string, unknown> = {};
	for (const key of keys) body[key] = (patch as Record<string, unknown>)[key];
	const res = await send(url(input.organizationId, input.policyId), input, 'PATCH', body);
	if (!res.ok) throw await failure(res, 'update');
	const policy = parsePolicy((await readObject(res)).slaPolicy, res.status);
	if (policy.id !== input.policyId) throw invalidPayload(res.status);
	return policy;
}

/**
 * Typed client for membership administration (/api/memberships).
 * fetch + runtime validation + typed errors only: no session handling, navigation or storage.
 * Tenant travels only in the query string; identity comes from the session cookie.
 * Assigned roles are administrative metadata, not effective capabilities: UI actions must be
 * gated by /api/me capabilities.
 */

export interface MembershipRole {
	id: string;
	code: string;
	name: string;
	/** Assigned but inactive roles are listed with active=false and grant nothing. */
	active: boolean;
	isCustom: boolean;
}

export interface Membership {
	id: string;
	user: {
		id: string;
		name: string;
		email: string | null;
		active: boolean;
	};
	active: boolean;
	roles: MembershipRole[];
}

export interface RoleAssignment {
	membershipId: string;
	role: MembershipRole;
	/** false when the role was already assigned (idempotent). */
	created: boolean;
}

export class MembershipApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'MembershipApiError';
		this.status = status;
		this.code = code;
	}
}

interface MembershipRequestOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

export interface ListMembershipsInput extends MembershipRequestOptions {
	organizationId: string;
}

export interface GetMembershipInput extends MembershipRequestOptions {
	organizationId: string;
	membershipId: string;
}

export interface AssignRoleInput extends MembershipRequestOptions {
	organizationId: string;
	membershipId: string;
	roleId: string;
}

export type RevokeRoleInput = AssignRoleInput;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Action = 'list' | 'detail' | 'assign' | 'revoke';

const FAILURE_TEXT: Record<Action, string> = {
	list: 'No se pudieron cargar los miembros. Inténtalo de nuevo.',
	detail: 'No se pudo cargar el miembro. Inténtalo de nuevo.',
	assign: 'No se pudo asignar el rol. Inténtalo de nuevo.',
	revoke: 'No se pudo retirar el rol. Inténtalo de nuevo.'
};

function invalidInput(message: string): MembershipApiError {
	return new MembershipApiError(0, 'INVALID_INPUT', message);
}

function invalidPayload(status: number): MembershipApiError {
	return new MembershipApiError(
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

async function send(
	url: string,
	options: MembershipRequestOptions,
	method: 'GET' | 'POST' | 'DELETE' = 'GET',
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
		if (err instanceof MembershipApiError) throw err;
		if ((err as Error)?.name === 'AbortError' || options.signal?.aborted) throw err;
		throw new MembershipApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.');
	}
}

const NOT_FOUND: Record<string, string> = {
	MEMBERSHIP_NOT_FOUND: 'El miembro no está disponible.',
	ROLE_NOT_FOUND: 'El rol no está disponible.',
	ROLE_ASSIGNMENT_NOT_FOUND: 'El miembro no tiene asignado ese rol.'
};

const CONFLICT: Record<string, string> = {
	MEMBERSHIP_INACTIVE: 'El miembro no está activo.',
	ROLE_INACTIVE: 'El rol no está activo.',
	LAST_ADMIN_REQUIRED: 'La organización debe conservar al menos un administrador.'
};

/** Fixed client messages; only the backend error code is read, never its message. */
async function failure(res: Response, action: Action): Promise<MembershipApiError> {
	let backendCode: unknown;
	try {
		backendCode = ((await res.json()) as { error?: { code?: unknown } })?.error?.code;
	} catch {
		backendCode = undefined;
	}
	const code = typeof backendCode === 'string' ? backendCode : '';
	if (res.status === 400)
		return new MembershipApiError(400, 'INVALID_INPUT', 'Solicitud no válida.');
	if (res.status === 401)
		return new MembershipApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida.');
	if (res.status === 403) {
		if (code === 'PERMISSION_NOT_DELEGABLE')
			return new MembershipApiError(
				403,
				'PERMISSION_NOT_DELEGABLE',
				'No puedes gestionar un rol con permisos que no tienes.'
			);
		return new MembershipApiError(
			403,
			'FORBIDDEN',
			action === 'list' || action === 'detail'
				? 'No tienes permisos para consultar los miembros.'
				: 'No tienes permisos para gestionar los roles de los miembros.'
		);
	}
	if (res.status === 404) {
		return Object.hasOwn(NOT_FOUND, code)
			? new MembershipApiError(404, code, NOT_FOUND[code])
			: new MembershipApiError(404, 'NOT_FOUND', 'El recurso solicitado no está disponible.');
	}
	if (res.status === 409) {
		return Object.hasOwn(CONFLICT, code)
			? new MembershipApiError(409, code, CONFLICT[code])
			: new MembershipApiError(409, 'CONFLICT', FAILURE_TEXT[action]);
	}
	if (res.status >= 500)
		return new MembershipApiError(res.status, 'SERVER_ERROR', FAILURE_TEXT[action]);
	return new MembershipApiError(res.status, 'INTERNAL_ERROR', FAILURE_TEXT[action]);
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

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

/** Strict allowlist: rebuilds the role so no extra backend field reaches the UI. */
function parseRole(raw: unknown, status: number): MembershipRole {
	if (!isObject(raw)) throw invalidPayload(status);
	if (
		typeof raw.id !== 'string' ||
		!UUID.test(raw.id) ||
		!isNonEmptyString(raw.code) ||
		!isNonEmptyString(raw.name) ||
		typeof raw.active !== 'boolean' ||
		typeof raw.isCustom !== 'boolean'
	) {
		throw invalidPayload(status);
	}
	return {
		id: raw.id,
		code: raw.code,
		name: raw.name,
		active: raw.active,
		isCustom: raw.isCustom
	};
}

function assertUniqueIds(items: { id: string }[], status: number): void {
	if (new Set(items.map((item) => item.id)).size !== items.length) throw invalidPayload(status);
}

function parseMembership(raw: unknown, status: number): Membership {
	if (!isObject(raw) || !isObject(raw.user)) throw invalidPayload(status);
	const user = raw.user;
	if (
		typeof raw.id !== 'string' ||
		!UUID.test(raw.id) ||
		typeof raw.active !== 'boolean' ||
		typeof user.id !== 'string' ||
		!UUID.test(user.id) ||
		typeof user.name !== 'string' ||
		(user.email !== null && typeof user.email !== 'string') ||
		typeof user.active !== 'boolean' ||
		!Array.isArray(raw.roles)
	) {
		throw invalidPayload(status);
	}
	const roles = raw.roles.map((role) => parseRole(role, status));
	assertUniqueIds(roles, status);
	return {
		id: raw.id,
		user: {
			id: user.id,
			name: user.name,
			email: user.email as string | null,
			active: user.active
		},
		active: raw.active,
		roles
	};
}

function query(organizationId: string): string {
	return new URLSearchParams({ organizationId }).toString();
}

/** GET /api/memberships?organizationId=<UUID> (requires memberships:view). */
export async function listMemberships(input: ListMembershipsInput): Promise<Membership[]> {
	assertUuid(input?.organizationId, 'organización');
	const res = await send(`/api/memberships?${query(input.organizationId)}`, input);
	if (!res.ok) throw await failure(res, 'list');
	const data = await readObject(res);
	if (!Array.isArray(data.memberships)) throw invalidPayload(res.status);
	const memberships = data.memberships.map((m) => parseMembership(m, res.status));
	assertUniqueIds(memberships, res.status);
	return memberships;
}

/** GET /api/memberships/<id>?organizationId=<UUID> (requires memberships:view). */
export async function getMembership(input: GetMembershipInput): Promise<Membership> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.membershipId, 'miembro');
	const url = `/api/memberships/${encodeURIComponent(input.membershipId)}?${query(input.organizationId)}`;
	const res = await send(url, input);
	if (!res.ok) throw await failure(res, 'detail');
	const membership = parseMembership((await readObject(res)).membership, res.status);
	if (membership.id !== input.membershipId) throw invalidPayload(res.status);
	return membership;
}

/**
 * POST /api/memberships/<id>/roles?organizationId=<UUID> (requires roles:assign).
 * Resolves on 201 (created) and 200 (already assigned). The server decides delegation.
 */
export async function assignRole(input: AssignRoleInput): Promise<RoleAssignment> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.membershipId, 'miembro');
	assertUuid(input.roleId, 'rol');
	const url = `/api/memberships/${encodeURIComponent(input.membershipId)}/roles?${query(input.organizationId)}`;
	const res = await send(url, input, 'POST', { roleId: input.roleId });
	if (!res.ok) throw await failure(res, 'assign');
	if (res.status !== 200 && res.status !== 201) throw invalidPayload(res.status);
	const data = await readObject(res);
	if (!isObject(data.assignment)) throw invalidPayload(res.status);
	const { membershipId, created } = data.assignment;
	const role = parseRole(data.assignment.role, res.status);
	if (
		membershipId !== input.membershipId ||
		role.id !== input.roleId ||
		typeof created !== 'boolean' ||
		created !== (res.status === 201)
	)
		throw invalidPayload(res.status);
	return { membershipId, role, created };
}

/** DELETE /api/memberships/<id>/roles/<roleId>?organizationId=<UUID> (requires roles:assign). */
export async function revokeRole(input: RevokeRoleInput): Promise<void> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.membershipId, 'miembro');
	assertUuid(input.roleId, 'rol');
	const url = `/api/memberships/${encodeURIComponent(input.membershipId)}/roles/${encodeURIComponent(input.roleId)}?${query(input.organizationId)}`;
	const res = await send(url, input, 'DELETE');
	if (!res.ok) throw await failure(res, 'revoke');
	if (res.status !== 204) throw invalidPayload(res.status);
}

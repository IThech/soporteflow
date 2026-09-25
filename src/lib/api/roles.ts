/**
 * Typed client for role administration (/api/permissions, /api/roles).
 * fetch + runtime validation + typed errors only: no session handling, navigation or storage.
 * Tenant travels only in the query string; identity comes from the session cookie.
 * Role data is administrative configuration; UI actions must be gated by /api/me capabilities.
 */

export type PermissionScopeType = 'organization' | 'department' | 'team' | 'site' | 'personal';

export interface Permission {
	id: string;
	name: string;
	description: string;
	category: string;
	allowedScopeTypes: PermissionScopeType[];
}

export interface Role {
	id: string;
	code: string;
	name: string;
	description: string | null;
	templateId: string | null;
	isCustom: boolean;
	active: boolean;
	/** Real permissions of this tenant role (canonical ids), not the template's. */
	permissions: string[];
}

export class RoleApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'RoleApiError';
		this.status = status;
		this.code = code;
	}
}

interface RoleRequestOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

export interface ListPermissionsInput extends RoleRequestOptions {
	organizationId: string;
}

export interface ListRolesInput extends RoleRequestOptions {
	organizationId: string;
	activeOnly?: boolean;
}

export interface GetRoleInput extends RoleRequestOptions {
	organizationId: string;
	roleId: string;
}

export interface CreateRoleInput extends RoleRequestOptions {
	organizationId: string;
	role: {
		name: string;
		code: string;
		description?: string | null;
		permissions: string[];
	};
}

/** Partial update; code is immutable. permissions replaces the whole canonical set. */
export interface UpdateRolePatch {
	name?: string;
	description?: string | null;
	permissions?: string[];
	active?: boolean;
}

export interface UpdateRoleInput extends RoleRequestOptions {
	organizationId: string;
	roleId: string;
	patch: UpdateRolePatch;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMISSION_ID = /^[a-z][a-z_]*:[a-z][a-z_]*$/;
const ROLE_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const PATCH_KEYS = ['name', 'description', 'permissions', 'active'] as const;
const SCOPES: readonly PermissionScopeType[] = [
	'organization',
	'department',
	'team',
	'site',
	'personal'
];

type Action = 'permissions' | 'roles' | 'role' | 'create' | 'update';

const FAILURE_TEXT: Record<Action, string> = {
	permissions: 'No se pudo cargar el catálogo de permisos. Inténtalo de nuevo.',
	roles: 'No se pudieron cargar los roles. Inténtalo de nuevo.',
	role: 'No se pudo cargar el rol. Inténtalo de nuevo.',
	create: 'No se pudo crear el rol. Inténtalo de nuevo.',
	update: 'No se pudo actualizar el rol. Inténtalo de nuevo.'
};

function invalidInput(message: string): RoleApiError {
	return new RoleApiError(0, 'INVALID_INPUT', message);
}

function invalidPayload(status: number): RoleApiError {
	return new RoleApiError(
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
	options: RoleRequestOptions,
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
		if (err instanceof RoleApiError) throw err;
		if ((err as Error)?.name === 'AbortError' || options.signal?.aborted) throw err;
		throw new RoleApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.');
	}
}

/** Fixed client messages; only the backend error code is read, never its message. */
async function failure(res: Response, action: Action): Promise<RoleApiError> {
	let backendCode: unknown;
	try {
		backendCode = ((await res.json()) as { error?: { code?: unknown } })?.error?.code;
	} catch {
		backendCode = undefined;
	}
	if (res.status === 400) return new RoleApiError(400, 'INVALID_INPUT', 'Solicitud no válida.');
	if (res.status === 401)
		return new RoleApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida.');
	if (res.status === 403) {
		if (backendCode === 'PERMISSION_NOT_DELEGABLE')
			return new RoleApiError(
				403,
				'PERMISSION_NOT_DELEGABLE',
				'No puedes conceder permisos que no tienes.'
			);
		return action === 'create' || action === 'update'
			? new RoleApiError(403, 'FORBIDDEN', 'No tienes permisos para gestionar los roles.')
			: new RoleApiError(403, 'FORBIDDEN', 'No tienes permisos para consultar los roles.');
	}
	if (res.status === 409) {
		if (backendCode === 'ROLE_CODE_CONFLICT')
			return new RoleApiError(409, 'ROLE_CODE_CONFLICT', 'Ya existe un rol con ese código.');
		if (backendCode === 'SYSTEM_ROLE_IMMUTABLE')
			return new RoleApiError(
				409,
				'SYSTEM_ROLE_IMMUTABLE',
				'Los roles del sistema no se pueden modificar.'
			);
		if (backendCode === 'ROLE_HAS_UNKNOWN_PERMISSIONS')
			return new RoleApiError(
				409,
				'ROLE_HAS_UNKNOWN_PERMISSIONS',
				'Los permisos de este rol no se pueden reemplazar.'
			);
		return new RoleApiError(409, 'CONFLICT', FAILURE_TEXT[action]);
	}
	if (res.status === 404) {
		return backendCode === 'ROLE_NOT_FOUND'
			? new RoleApiError(404, 'ROLE_NOT_FOUND', 'El rol no está disponible.')
			: new RoleApiError(404, 'NOT_FOUND', 'El recurso solicitado no está disponible.');
	}
	if (res.status >= 500) return new RoleApiError(res.status, 'SERVER_ERROR', FAILURE_TEXT[action]);
	return new RoleApiError(res.status, 'INTERNAL_ERROR', FAILURE_TEXT[action]);
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

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isPermissionIdList(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.every((id) => typeof id === 'string' && PERMISSION_ID.test(id)) &&
		new Set(value).size === value.length
	);
}

function parsePermission(raw: unknown, status: number): Permission {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidPayload(status);
	const p = raw as Record<string, unknown>;
	const scopes = p.allowedScopeTypes;
	if (
		typeof p.id !== 'string' ||
		!PERMISSION_ID.test(p.id) ||
		!isNonEmptyString(p.name) ||
		typeof p.description !== 'string' ||
		!isNonEmptyString(p.category) ||
		!Array.isArray(scopes) ||
		scopes.length === 0 ||
		!scopes.every((scope) => SCOPES.includes(scope as PermissionScopeType)) ||
		new Set(scopes).size !== scopes.length
	) {
		throw invalidPayload(status);
	}
	return {
		id: p.id,
		name: p.name,
		description: p.description,
		category: p.category,
		allowedScopeTypes: [...(scopes as PermissionScopeType[])]
	};
}

/** Strict allowlist: rebuilds the role so no extra backend field reaches the UI. */
function parseRole(raw: unknown, status: number): Role {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidPayload(status);
	const r = raw as Record<string, unknown>;
	if (
		typeof r.id !== 'string' ||
		!UUID.test(r.id) ||
		!isNonEmptyString(r.code) ||
		!isNonEmptyString(r.name) ||
		(r.description !== null && typeof r.description !== 'string') ||
		(r.templateId !== null && !isNonEmptyString(r.templateId)) ||
		typeof r.isCustom !== 'boolean' ||
		typeof r.active !== 'boolean' ||
		!isPermissionIdList(r.permissions)
	) {
		throw invalidPayload(status);
	}
	return {
		id: r.id,
		code: r.code,
		name: r.name,
		description: r.description as string | null,
		templateId: r.templateId as string | null,
		isCustom: r.isCustom,
		active: r.active,
		permissions: [...r.permissions]
	};
}

function assertUniqueIds(items: { id: string }[], status: number): void {
	if (new Set(items.map((item) => item.id)).size !== items.length) throw invalidPayload(status);
}

/** GET /api/permissions?organizationId=<UUID> (requires roles:view). */
export async function listPermissions(input: ListPermissionsInput): Promise<Permission[]> {
	assertUuid(input?.organizationId, 'organización');
	const url = `/api/permissions?${new URLSearchParams({ organizationId: input.organizationId }).toString()}`;
	const res = await send(url, input);
	if (!res.ok) throw await failure(res, 'permissions');
	const data = await readObject(res);
	if (!Array.isArray(data.permissions)) throw invalidPayload(res.status);
	const permissions = data.permissions.map((p) => parsePermission(p, res.status));
	assertUniqueIds(permissions, res.status);
	return permissions;
}

/** GET /api/roles?organizationId=<UUID>[&activeOnly=true|false] (requires roles:view). */
export async function listRoles(input: ListRolesInput): Promise<Role[]> {
	assertUuid(input?.organizationId, 'organización');
	const query: Record<string, string> = { organizationId: input.organizationId };
	if (input.activeOnly !== undefined) {
		if (typeof input.activeOnly !== 'boolean') throw invalidInput('Filtro de roles no válido.');
		query.activeOnly = String(input.activeOnly);
	}
	const res = await send(`/api/roles?${new URLSearchParams(query).toString()}`, input);
	if (!res.ok) throw await failure(res, 'roles');
	const data = await readObject(res);
	if (!Array.isArray(data.roles)) throw invalidPayload(res.status);
	const roles = data.roles.map((role) => parseRole(role, res.status));
	assertUniqueIds(roles, res.status);
	return roles;
}

/** GET /api/roles/<id>?organizationId=<UUID> (requires roles:view). */
export async function getRole(input: GetRoleInput): Promise<Role> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.roleId, 'rol');
	const url = `/api/roles/${encodeURIComponent(input.roleId)}?${new URLSearchParams({ organizationId: input.organizationId }).toString()}`;
	const res = await send(url, input);
	if (!res.ok) throw await failure(res, 'role');
	const role = parseRole((await readObject(res)).role, res.status);
	if (role.id !== input.roleId) throw invalidPayload(res.status);
	return role;
}

function isDescriptionInput(value: unknown): boolean {
	return value === null || typeof value === 'string';
}

function roleUrl(organizationId: string, roleId?: string): string {
	const path = roleId ? `/api/roles/${encodeURIComponent(roleId)}` : '/api/roles';
	return `${path}?${new URLSearchParams({ organizationId }).toString()}`;
}

/**
 * POST /api/roles?organizationId=<UUID> (requires roles:manage). Creates an active custom role.
 * Only well-formed fields are sent; the server remains the authority (delegation, reserved codes).
 */
export async function createRole(input: CreateRoleInput): Promise<Role> {
	assertUuid(input?.organizationId, 'organización');
	const role = input.role;
	if (
		!role ||
		typeof role !== 'object' ||
		!isNonEmptyString(role.name) ||
		typeof role.code !== 'string' ||
		!ROLE_CODE.test(role.code) ||
		(role.description !== undefined && !isDescriptionInput(role.description)) ||
		!isPermissionIdList(role.permissions)
	) {
		throw invalidInput('Datos del rol no válidos.');
	}
	const body: Record<string, unknown> = {
		name: role.name,
		code: role.code,
		permissions: [...role.permissions]
	};
	if (role.description !== undefined) body.description = role.description;
	const res = await send(roleUrl(input.organizationId), input, 'POST', body);
	if (!res.ok) throw await failure(res, 'create');
	if (res.status !== 201) throw invalidPayload(res.status);
	const created = parseRole((await readObject(res)).role, res.status);
	if (created.code !== role.code) throw invalidPayload(res.status);
	return created;
}

/**
 * PATCH /api/roles/<id>?organizationId=<UUID> (requires roles:manage). Partial update of a custom
 * role; the patch must contain at least one known field and never code.
 */
export async function updateRole(input: UpdateRoleInput): Promise<Role> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.roleId, 'rol');
	const patch = input.patch;
	if (!patch || typeof patch !== 'object' || Array.isArray(patch))
		throw invalidInput('Cambios del rol no válidos.');
	const keys = Object.keys(patch).filter(
		(key) => (patch as Record<string, unknown>)[key] !== undefined
	);
	if (
		keys.length === 0 ||
		keys.some((key) => !(PATCH_KEYS as readonly string[]).includes(key)) ||
		(patch.name !== undefined && !isNonEmptyString(patch.name)) ||
		(patch.description !== undefined && !isDescriptionInput(patch.description)) ||
		(patch.permissions !== undefined && !isPermissionIdList(patch.permissions)) ||
		(patch.active !== undefined && typeof patch.active !== 'boolean')
	) {
		throw invalidInput('Cambios del rol no válidos.');
	}
	const body: Record<string, unknown> = {};
	for (const key of keys) {
		const value = (patch as Record<string, unknown>)[key];
		body[key] = Array.isArray(value) ? [...value] : value;
	}
	const res = await send(roleUrl(input.organizationId, input.roleId), input, 'PATCH', body);
	if (!res.ok) throw await failure(res, 'update');
	const role = parseRole((await readObject(res)).role, res.status);
	if (role.id !== input.roleId) throw invalidPayload(res.status);
	return role;
}

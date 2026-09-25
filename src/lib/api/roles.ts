/**
 * Typed read client for role administration (/api/permissions, /api/roles).
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMISSION_ID = /^[a-z][a-z_]*:[a-z][a-z_]*$/;
const SCOPES: readonly PermissionScopeType[] = [
	'organization',
	'department',
	'team',
	'site',
	'personal'
];

type Action = 'permissions' | 'roles' | 'role';

const FAILURE_TEXT: Record<Action, string> = {
	permissions: 'No se pudo cargar el catálogo de permisos. Inténtalo de nuevo.',
	roles: 'No se pudieron cargar los roles. Inténtalo de nuevo.',
	role: 'No se pudo cargar el rol. Inténtalo de nuevo.'
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

async function send(url: string, options: RoleRequestOptions): Promise<Response> {
	const fetchFn = options.customFetch ?? fetch;
	try {
		return await fetchFn(url, { method: 'GET', signal: options.signal });
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
		return new RoleApiError(403, 'FORBIDDEN', 'No tienes permisos para consultar los roles.');
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

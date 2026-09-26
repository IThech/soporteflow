/**
 * Typed client for administrative invitations (/api/invitations).
 * fetch + runtime validation + typed errors only: no session handling, navigation or storage.
 * Tenant travels only in the query string; identity comes from the session cookie.
 * Invitation tokens never reach this client: the server only emails them.
 */

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface Invitation {
	id: string;
	email: string;
	status: InvitationStatus;
	expiresAt: string;
	acceptedAt: string | null;
	createdAt: string;
	updatedAt: string;
	role: { id: string; code: string; name: string; active: boolean };
	invitedBy: { id: string; name: string };
}

export class InvitationApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'InvitationApiError';
		this.status = status;
		this.code = code;
	}
}

interface InvitationRequestOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

export interface ListInvitationsInput extends InvitationRequestOptions {
	organizationId: string;
	status?: InvitationStatus;
	email?: string;
}

export interface GetInvitationInput extends InvitationRequestOptions {
	organizationId: string;
	invitationId: string;
}

export interface CreateInvitationInput extends InvitationRequestOptions {
	organizationId: string;
	email: string;
	roleId: string;
}

export type RevokeInvitationInput = GetInvitationInput;
export type ResendInvitationInput = GetInvitationInput;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const STATUSES: readonly InvitationStatus[] = ['pending', 'accepted', 'revoked', 'expired'];

type Action = 'list' | 'detail' | 'create' | 'revoke' | 'resend';

const FAILURE_TEXT: Record<Action, string> = {
	list: 'No se pudieron cargar las invitaciones. Inténtalo de nuevo.',
	detail: 'No se pudo cargar la invitación. Inténtalo de nuevo.',
	create: 'No se pudo crear la invitación. Inténtalo de nuevo.',
	revoke: 'No se pudo revocar la invitación. Inténtalo de nuevo.',
	resend: 'No se pudo reenviar la invitación. Inténtalo de nuevo.'
};

const NOT_FOUND: Record<string, string> = {
	INVITATION_NOT_FOUND: 'La invitación no está disponible.',
	ROLE_NOT_FOUND: 'El rol no está disponible.'
};

const CONFLICT: Record<string, string> = {
	INVITATION_ALREADY_PENDING: 'Ya existe una invitación pendiente para ese correo.',
	ALREADY_MEMBER: 'Esa persona ya es miembro de la organización.',
	MEMBERSHIP_INACTIVE: 'Esa persona tiene una membresía inactiva en la organización.',
	ROLE_INACTIVE: 'El rol no está activo.',
	INVITATION_NOT_REVOCABLE: 'La invitación ya no se puede revocar.',
	INVITATION_NOT_RESENDABLE: 'La invitación ya no se puede reenviar.'
};

function invalidInput(message: string): InvitationApiError {
	return new InvitationApiError(0, 'INVALID_INPUT', message);
}

function invalidPayload(status: number): InvitationApiError {
	return new InvitationApiError(
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
	options: InvitationRequestOptions,
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
		if (err instanceof InvitationApiError) throw err;
		if ((err as Error)?.name === 'AbortError' || options.signal?.aborted) throw err;
		throw new InvitationApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.');
	}
}

/** Fixed client messages; only the backend error code is read, never its message. */
async function failure(res: Response, action: Action): Promise<InvitationApiError> {
	let backendCode: unknown;
	try {
		backendCode = ((await res.json()) as { error?: { code?: unknown } })?.error?.code;
	} catch {
		backendCode = undefined;
	}
	const code = typeof backendCode === 'string' ? backendCode : '';
	if (res.status === 400)
		return new InvitationApiError(400, 'INVALID_INPUT', 'Solicitud no válida.');
	if (res.status === 401)
		return new InvitationApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida.');
	if (res.status === 403) {
		if (code === 'PERMISSION_NOT_DELEGABLE')
			return new InvitationApiError(
				403,
				'PERMISSION_NOT_DELEGABLE',
				'No puedes invitar con un rol que tiene permisos que no tienes.'
			);
		return new InvitationApiError(
			403,
			'FORBIDDEN',
			'No tienes permisos para gestionar las invitaciones.'
		);
	}
	if (res.status === 404) {
		return Object.hasOwn(NOT_FOUND, code)
			? new InvitationApiError(404, code, NOT_FOUND[code])
			: new InvitationApiError(404, 'NOT_FOUND', 'El recurso solicitado no está disponible.');
	}
	if (res.status === 409) {
		return Object.hasOwn(CONFLICT, code)
			? new InvitationApiError(409, code, CONFLICT[code])
			: new InvitationApiError(409, 'CONFLICT', FAILURE_TEXT[action]);
	}
	if (res.status === 502 && code === 'EMAIL_DELIVERY_FAILED')
		return new InvitationApiError(
			502,
			'EMAIL_DELIVERY_FAILED',
			'La invitación se guardó pero no se pudo enviar el correo. Puedes reenviarla.'
		);
	if (res.status >= 500)
		return new InvitationApiError(res.status, 'SERVER_ERROR', FAILURE_TEXT[action]);
	return new InvitationApiError(res.status, 'INTERNAL_ERROR', FAILURE_TEXT[action]);
}

async function readObject(res: Response): Promise<Record<string, unknown>> {
	let data: unknown;
	try {
		data = await res.json();
	} catch {
		throw invalidPayload(res.status);
	}
	if (!isObject(data)) throw invalidPayload(res.status);
	return data;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isIso(value: unknown): value is string {
	return typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));
}

/** Strict allowlist: rebuilds the invitation, so token fields or any other extra field are dropped. */
function parseInvitation(raw: unknown, status: number): Invitation {
	if (!isObject(raw) || !isObject(raw.role) || !isObject(raw.invitedBy))
		throw invalidPayload(status);
	const { role, invitedBy } = raw;
	if (
		typeof raw.id !== 'string' ||
		!UUID.test(raw.id) ||
		typeof raw.email !== 'string' ||
		!EMAIL.test(raw.email) ||
		raw.email !== raw.email.toLowerCase() ||
		!STATUSES.includes(raw.status as InvitationStatus) ||
		!isIso(raw.expiresAt) ||
		(raw.acceptedAt !== null && !isIso(raw.acceptedAt)) ||
		!isIso(raw.createdAt) ||
		!isIso(raw.updatedAt) ||
		typeof role.id !== 'string' ||
		!UUID.test(role.id) ||
		!isNonEmptyString(role.code) ||
		!isNonEmptyString(role.name) ||
		typeof role.active !== 'boolean' ||
		typeof invitedBy.id !== 'string' ||
		!UUID.test(invitedBy.id) ||
		typeof invitedBy.name !== 'string'
	) {
		throw invalidPayload(status);
	}
	return {
		id: raw.id,
		email: raw.email,
		status: raw.status as InvitationStatus,
		expiresAt: raw.expiresAt,
		acceptedAt: raw.acceptedAt as string | null,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
		role: { id: role.id, code: role.code, name: role.name, active: role.active },
		invitedBy: { id: invitedBy.id, name: invitedBy.name }
	};
}

function base(organizationId: string, invitationId?: string, suffix = ''): string {
	const path = invitationId
		? `/api/invitations/${encodeURIComponent(invitationId)}${suffix}`
		: '/api/invitations';
	return `${path}?${new URLSearchParams({ organizationId }).toString()}`;
}

async function readInvitation(res: Response, invitationId?: string): Promise<Invitation> {
	const invitation = parseInvitation((await readObject(res)).invitation, res.status);
	if (invitationId !== undefined && invitation.id !== invitationId)
		throw invalidPayload(res.status);
	return invitation;
}

/** GET /api/invitations?organizationId=<UUID>[&status][&email] (requires invitations:view). */
export async function listInvitations(input: ListInvitationsInput): Promise<Invitation[]> {
	assertUuid(input?.organizationId, 'organización');
	const query: Record<string, string> = { organizationId: input.organizationId };
	if (input.status !== undefined) {
		if (!STATUSES.includes(input.status)) throw invalidInput('Filtro de estado no válido.');
		query.status = input.status;
	}
	if (input.email !== undefined) {
		if (typeof input.email !== 'string' || !EMAIL.test(input.email.trim()))
			throw invalidInput('Filtro de correo no válido.');
		query.email = input.email.trim().toLowerCase();
	}
	const res = await send(`/api/invitations?${new URLSearchParams(query).toString()}`, input);
	if (!res.ok) throw await failure(res, 'list');
	const data = await readObject(res);
	if (!Array.isArray(data.invitations)) throw invalidPayload(res.status);
	const invitations = data.invitations.map((raw) => parseInvitation(raw, res.status));
	if (new Set(invitations.map((i) => i.id)).size !== invitations.length)
		throw invalidPayload(res.status);
	return invitations;
}

/** GET /api/invitations/<id>?organizationId=<UUID> (requires invitations:view). */
export async function getInvitation(input: GetInvitationInput): Promise<Invitation> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.invitationId, 'invitación');
	const res = await send(base(input.organizationId, input.invitationId), input);
	if (!res.ok) throw await failure(res, 'detail');
	return readInvitation(res, input.invitationId);
}

/**
 * POST /api/invitations?organizationId=<UUID> (requires invitations:create + roles:assign).
 * EMAIL_DELIVERY_FAILED means the invitation was saved and can be resent.
 */
export async function createInvitation(input: CreateInvitationInput): Promise<Invitation> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.roleId, 'rol');
	if (typeof input.email !== 'string') throw invalidInput('Correo no válido.');
	const email = input.email.trim().toLowerCase();
	if (!email || email.length > 255 || !EMAIL.test(email)) throw invalidInput('Correo no válido.');
	const res = await send(base(input.organizationId), input, 'POST', {
		email,
		roleId: input.roleId
	});
	if (!res.ok) throw await failure(res, 'create');
	if (res.status !== 201) throw invalidPayload(res.status);
	const invitation = await readInvitation(res);
	if (invitation.email !== email || invitation.role.id !== input.roleId)
		throw invalidPayload(res.status);
	return invitation;
}

/** DELETE /api/invitations/<id>?organizationId=<UUID> (requires invitations:revoke). */
export async function revokeInvitation(input: RevokeInvitationInput): Promise<void> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.invitationId, 'invitación');
	const res = await send(base(input.organizationId, input.invitationId), input, 'DELETE');
	if (!res.ok) throw await failure(res, 'revoke');
	if (res.status !== 204) throw invalidPayload(res.status);
}

/** POST /api/invitations/<id>/resend?organizationId=<UUID> (same permissions as create). */
export async function resendInvitation(input: ResendInvitationInput): Promise<Invitation> {
	assertUuid(input?.organizationId, 'organización');
	assertUuid(input.invitationId, 'invitación');
	const res = await send(base(input.organizationId, input.invitationId, '/resend'), input, 'POST');
	if (!res.ok) throw await failure(res, 'resend');
	const invitation = await readInvitation(res, input.invitationId);
	if (invitation.status !== 'pending') throw invalidPayload(res.status);
	return invitation;
}

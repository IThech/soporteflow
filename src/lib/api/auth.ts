export interface SignInCredentials {
	email: string;
	password: string;
}

export interface AuthUserProfile {
	id: string;
	name: string;
	email: string;
}

export interface UserOrganizationSummary {
	id: string;
	name: string;
	slug: string;
}

/**
 * Organization selected with getMe({ organizationId }). capabilities are canonical permission
 * ids (e.g. 'sites:manage') to enable or hide UI actions; they are never a security boundary:
 * every endpoint still authorizes on the server.
 */
export interface ActiveOrganizationContext {
	id: string;
	name: string;
	slug: string;
	capabilities: string[];
}

export interface AuthenticatedUserContext {
	user: AuthUserProfile;
	organizations: UserOrganizationSummary[];
	activeOrganization?: ActiveOrganizationContext;
}

export interface GetMeOptions {
	/** When set, the response includes activeOrganization with its effective capabilities. */
	organizationId?: string;
}

const ME_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITY_ID = /^[a-z][a-z_]*:[a-z][a-z_]*$/;

function invalidMePayload(status: number): AuthApiError {
	return new AuthApiError(
		status,
		'INVALID_PAYLOAD',
		'No se pudo interpretar la respuesta del servidor.'
	);
}

/** Strict parser for activeOrganization: rebuilt field by field, extra fields discarded. */
function parseActiveOrganization(
	raw: unknown,
	expectedId: string,
	status: number
): ActiveOrganizationContext {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidMePayload(status);
	const org = raw as Record<string, unknown>;
	const capabilities = org.capabilities;
	if (
		org.id !== expectedId ||
		typeof org.name !== 'string' ||
		typeof org.slug !== 'string' ||
		!Array.isArray(capabilities) ||
		!capabilities.every((c) => typeof c === 'string' && CAPABILITY_ID.test(c)) ||
		new Set(capabilities).size !== capabilities.length
	) {
		throw invalidMePayload(status);
	}
	return { id: org.id, name: org.name, slug: org.slug, capabilities: [...capabilities] };
}

export class AuthApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'AuthApiError';
	}
}

/**
 * Initiates an email/password sign-in request against Better Auth.
 * Cookie HttpOnly is managed by the browser; zero credentials/tokens stored in client storage.
 */
export async function signIn(
	credentials: SignInCredentials,
	customFetch: typeof fetch = fetch
): Promise<{ user: AuthUserProfile }> {
	try {
		const res = await customFetch('/api/auth/sign-in/email', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(credentials)
		});

		if (!res.ok) {
			let errorBody: { error?: { code?: string; message?: string } } | null = null;
			try {
				errorBody = await res.json();
			} catch {
				// Non-JSON error body
			}

			const code =
				errorBody?.error?.code ?? (res.status === 401 ? 'INVALID_CREDENTIALS' : 'AUTH_ERROR');
			let message = 'Error de autenticación.';
			if (res.status === 401) {
				message = 'Correo o contraseña incorrectos.';
			} else if (res.status === 429) {
				message = 'Demasiados intentos. Espera unos momentos antes de volver a intentarlo.';
			} else if (res.status === 503) {
				message = 'El servicio de autenticación no está disponible temporalmente.';
			} else if (res.status >= 500) {
				message = 'Error interno del servidor.';
			}

			throw new AuthApiError(res.status, code, message);
		}

		return await res.json();
	} catch (err) {
		if (err instanceof AuthApiError) throw err;
		throw new AuthApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.');
	}
}

/**
 * Revokes the current session and instructs browser to expire the HttpOnly cookie.
 */
export async function signOut(customFetch: typeof fetch = fetch): Promise<void> {
	try {
		const res = await customFetch('/api/auth/sign-out', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		});

		if (!res.ok && res.status !== 401) {
			throw new AuthApiError(res.status, 'SIGN_OUT_FAILED', 'Error al cerrar sesión.');
		}
	} catch (err) {
		if (err instanceof AuthApiError) throw err;
		throw new AuthApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.');
	}
}

/**
 * Fetches authenticated user identity and operational organizations from /api/me.
 */
export async function getMe(
	customFetch: typeof fetch = fetch,
	options: GetMeOptions = {}
): Promise<AuthenticatedUserContext> {
	const organizationId = options.organizationId;
	if (
		organizationId !== undefined &&
		(typeof organizationId !== 'string' || !ME_UUID.test(organizationId))
	) {
		throw new AuthApiError(0, 'INVALID_INPUT', 'Organización no válida.');
	}
	const url =
		organizationId === undefined
			? '/api/me'
			: `/api/me?${new URLSearchParams({ organizationId }).toString()}`;
	try {
		const res = await customFetch(url, {
			method: 'GET'
		});

		if (!res.ok) {
			let errorBody: { error?: { code?: string; message?: string } } | null = null;
			try {
				errorBody = await res.json();
			} catch {
				// Non-JSON error body
			}

			const code = errorBody?.error?.code ?? (res.status === 401 ? 'UNAUTHORIZED' : 'AUTH_ERROR');
			const message =
				res.status === 401 ? 'Sesión no válida o expirada.' : 'Error al obtener usuario.';

			throw new AuthApiError(res.status, code, message);
		}

		const data: AuthenticatedUserContext = await res.json();
		if (organizationId === undefined) return data;
		return {
			user: data?.user,
			organizations: data?.organizations,
			activeOrganization: parseActiveOrganization(
				(data as { activeOrganization?: unknown })?.activeOrganization,
				organizationId,
				res.status
			)
		};
	} catch (err) {
		if (err instanceof AuthApiError) throw err;
		throw new AuthApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.');
	}
}

/**
 * Common frontend API error (UI-1A, FE-06).
 *
 * Every real API client normalizes failures into ApiError so pages never parse Response objects
 * nor invent their own strings. It preserves the backend contract `{ error: { code, message } }`
 * plus the two operational headers a user or support needs:
 * - Retry-After (429/503): seconds until a retry makes sense;
 * - X-Request-ID: server correlation id (5.4W-E) to quote to support.
 * No other header is read or kept.
 *
 * Plain class fields (no TS parameter properties): the module is imported directly by Node tests.
 */

export type ApiErrorKind =
	| 'network'
	| 'invalid-input'
	| 'unauthenticated'
	| 'forbidden'
	| 'not-found'
	| 'conflict'
	| 'payload-too-large'
	| 'unprocessable'
	| 'rate-limited'
	| 'unavailable'
	| 'server'
	| 'invalid-payload';

export interface ApiErrorMeta {
	retryAfterSeconds?: number;
	requestId?: string;
}

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly retryAfterSeconds: number | undefined;
	readonly requestId: string | undefined;

	constructor(status: number, code: string, message: string, meta: ApiErrorMeta = {}) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.retryAfterSeconds = meta.retryAfterSeconds;
		this.requestId = meta.requestId;
	}

	get kind(): ApiErrorKind {
		return apiErrorKind(this.status, this.code);
	}
}

export function isApiError(value: unknown): value is ApiError {
	return value instanceof ApiError;
}

export function apiErrorKind(status: number, code: string): ApiErrorKind {
	if (code === 'INVALID_PAYLOAD') return 'invalid-payload';
	if (status === 0) return code === 'INVALID_INPUT' ? 'invalid-input' : 'network';
	if (status === 400) return 'invalid-input';
	if (status === 401) return 'unauthenticated';
	if (status === 403) return 'forbidden';
	if (status === 404) return 'not-found';
	if (status === 409) return 'conflict';
	if (status === 413) return 'payload-too-large';
	if (status === 422) return 'unprocessable';
	if (status === 429) return 'rate-limited';
	if (status === 503) return 'unavailable';
	if (status >= 500) return 'server';
	return 'invalid-input';
}

/** Upper bound for a server-requested wait; anything larger is treated as this. */
export const MAX_RETRY_AFTER_SECONDS = 3600;
/** Safe fallback when a 429/503 has no (or an unreadable) Retry-After. */
export const DEFAULT_RETRY_AFTER_SECONDS = 30;

/**
 * Retry-After as whole seconds (RFC 9110: delta-seconds or HTTP-date). null when absent or
 * malformed; never negative; capped at MAX_RETRY_AFTER_SECONDS.
 */
export function parseRetryAfter(
	value: string | null | undefined,
	now: number = Date.now()
): number | null {
	if (value === null || value === undefined) return null;
	const raw = value.trim();
	if (raw === '') return null;
	if (/^\d{1,10}$/.test(raw)) return Math.min(Number(raw), MAX_RETRY_AFTER_SECONDS);
	// HTTP-date only (IMF-fixdate / obsolete formats Date.parse understands); never a bare number.
	if (!/[a-z]/i.test(raw)) return null;
	const at = Date.parse(raw);
	if (!Number.isFinite(at)) return null;
	return Math.min(Math.max(0, Math.ceil((at - now) / 1000)), MAX_RETRY_AFTER_SECONDS);
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** X-Request-ID only when it is a well-formed server id (never echo arbitrary header text). */
export function readRequestId(
	headers: Pick<Headers, 'get'> | null | undefined
): string | undefined {
	const value = headers?.get('x-request-id')?.trim();
	return value && REQUEST_ID.test(value) ? value.toLowerCase() : undefined;
}

/** Uniform, safe user-facing messages (Spanish UI). Pages never write their own. */
const DEFAULT_MESSAGES: Record<ApiErrorKind, string> = {
	network: 'No se pudo conectar con el servidor. Comprueba tu conexión.',
	'invalid-input': 'La solicitud no es válida. Revisa los datos e inténtalo de nuevo.',
	unauthenticated: 'Tu sesión ya no es válida. Vuelve a iniciar sesión.',
	forbidden: 'No tienes permisos para realizar esta acción.',
	'not-found': 'El recurso solicitado no está disponible.',
	conflict: 'La operación entra en conflicto con el estado actual. Revisa los datos.',
	'payload-too-large': 'La solicitud es demasiado grande.',
	unprocessable: 'La solicitud no se pudo procesar. Acota la consulta o revisa los datos.',
	'rate-limited': 'Demasiadas solicitudes. Espera un momento antes de reintentar.',
	unavailable: 'El servicio no está disponible temporalmente. Inténtalo más tarde.',
	server: 'Se produjo un error en el servidor. Inténtalo de nuevo.',
	'invalid-payload': 'No se pudo interpretar la respuesta del servidor.'
};

export function defaultMessageFor(kind: ApiErrorKind): string {
	return DEFAULT_MESSAGES[kind];
}

/**
 * Builds the ApiError of a non-OK response. The backend code is kept (it is a stable contract);
 * the backend message is used only for 4xx client-correctable errors, never for 5xx (a generic,
 * safe text is shown instead). The body is read at most once and only as JSON.
 */
export async function apiErrorFromResponse(
	res: Response,
	options: { messages?: Partial<Record<ApiErrorKind, string>>; now?: number } = {}
): Promise<ApiError> {
	let code: string | undefined;
	let backendMessage: string | undefined;
	try {
		const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } } | null;
		if (typeof body?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(body.error.code))
			code = body.error.code;
		if (typeof body?.error?.message === 'string') backendMessage = body.error.message.slice(0, 300);
	} catch {
		// Non-JSON body: status-based classification only.
	}
	const fallbackCode =
		res.status === 401
			? 'UNAUTHORIZED'
			: res.status === 403
				? 'FORBIDDEN'
				: res.status === 404
					? 'NOT_FOUND'
					: res.status === 429
						? 'RATE_LIMITED'
						: res.status >= 500
							? 'SERVER_ERROR'
							: 'REQUEST_FAILED';
	const finalCode = code ?? fallbackCode;
	const kind = apiErrorKind(res.status, finalCode);
	const retryAfter =
		res.status === 429 || res.status === 503
			? (parseRetryAfter(res.headers.get('retry-after'), options.now) ??
				(res.status === 429 ? DEFAULT_RETRY_AFTER_SECONDS : undefined))
			: undefined;
	const clientCorrectable =
		kind === 'invalid-input' || kind === 'conflict' || kind === 'unprocessable';
	const message =
		options.messages?.[kind] ??
		(clientCorrectable && backendMessage ? backendMessage : defaultMessageFor(kind));
	return new ApiError(res.status, finalCode, message, {
		retryAfterSeconds: retryAfter ?? undefined,
		requestId: readRequestId(res.headers)
	});
}

export function networkApiError(): ApiError {
	return new ApiError(0, 'NETWORK_ERROR', defaultMessageFor('network'));
}

export function invalidPayloadError(status: number, requestId?: string): ApiError {
	return new ApiError(status, 'INVALID_PAYLOAD', defaultMessageFor('invalid-payload'), {
		requestId
	});
}

export function isAbortError(error: unknown, signal?: AbortSignal | null): boolean {
	return (error as { name?: unknown } | null)?.name === 'AbortError' || signal?.aborted === true;
}

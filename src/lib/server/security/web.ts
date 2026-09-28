import type { RequestEvent, ResolveOptions } from '@sveltejs/kit';

export const MAX_JSON_BYTES = 64 * 1024;
const mutations = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const methods = new Set(['GET', 'HEAD', 'OPTIONS', ...mutations]);
export interface WebPolicy {
	origin?: string;
	development: boolean;
	beforeResolve?: (event: RequestEvent) => Promise<Response | null>;
	/**
	 * 5.4W-E: security/operational events, injected by hooks.server.ts (structured logger). This
	 * module stays dependency-free; without an observer nothing is logged.
	 */
	observer?: WebSecurityObserver;
}
export interface WebRejection {
	reason: RejectReason;
	severity: 'warn' | 'info';
	status: number;
	method: string;
	route: string;
}
export interface WebSecurityObserver {
	rejected(rejection: WebRejection): void;
	unhandled(error: unknown): void;
}

/** The public origin is operator configuration, never Host or forwarded headers. */
export function configuredOrigin(policy: WebPolicy, requestUrl: URL): string | null {
	const raw = policy.origin;
	if (!raw)
		return policy.development &&
			['localhost', '127.0.0.1', '[::1]'].includes(requestUrl.hostname) &&
			['http:', 'https:'].includes(requestUrl.protocol)
			? requestUrl.origin
			: null;
	try {
		const u = new URL(raw);
		if (u.username || u.password || u.search || u.hash || u.pathname !== '/') return null;
		if (
			u.protocol !== 'https:' &&
			!(
				policy.development &&
				u.protocol === 'http:' &&
				['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
			)
		)
			return null;
		return u.origin;
	} catch {
		return null;
	}
}

export function allowsMutation(request: Request, url: URL, policy: WebPolicy): boolean {
	const expected = configuredOrigin(policy, url);
	return (
		expected !== null &&
		request.headers.get('origin') === expected &&
		!['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site') ?? '')
	);
}

/** Callback locations are internal paths; reject encoded separators/control characters too. */
export function isInternalLocation(value: unknown): value is string {
	if (typeof value !== 'string' || value.length > 2048) return false;
	let decoded = value;
	for (let i = 0; i < 4; i++) {
		if (
			!decoded.startsWith('/') ||
			decoded.startsWith('//') ||
			decoded.includes('\\') ||
			[...decoded].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
		)
			return false;
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) return true;
			decoded = next;
		} catch {
			return false;
		}
	}
	return false;
}

function failure(status: number, code: string): Response {
	return Response.json(
		{
			error: {
				code,
				message: code === 'INTERNAL_ERROR' ? 'Internal server error.' : 'Invalid request.'
			}
		},
		{ status }
	);
}

/**
 * 5.4W-E: rejected requests are reported to the observer. The reason is a server constant
 * (never request text); method/route template are the only request-derived fields.
 */
export type RejectReason =
	| 'METHOD_NOT_ALLOWED'
	| 'METHOD_OVERRIDE'
	| 'URI_TOO_LONG'
	| 'DUPLICATE_QUERY_PARAMETER'
	| 'ORIGIN_REJECTED'
	| 'CONTENT_ENCODING'
	| 'PAYLOAD_TOO_LARGE'
	| 'BODY_READ_FAILED'
	| 'UNSUPPORTED_MEDIA_TYPE'
	| 'INVALID_JSON'
	| 'UNSAFE_CALLBACK_URL';
const WARN_REASONS = new Set<RejectReason>([
	'METHOD_OVERRIDE',
	'ORIGIN_REJECTED',
	'UNSAFE_CALLBACK_URL',
	'CONTENT_ENCODING'
]);
function rejected(
	event: RequestEvent,
	policy: WebPolicy,
	reason: RejectReason,
	response: Response
): Response {
	try {
		policy.observer?.rejected({
			reason,
			severity: WARN_REASONS.has(reason) ? 'warn' : 'info',
			status: response.status,
			method: methods.has(event.request.method) ? event.request.method : 'OTHER',
			route: event.route?.id ?? 'unmatched'
		});
	} catch {
		// Observability never changes the security decision.
	}
	return response;
}

/** Read a bounded stream, without trusting Content-Length or buffering an unbounded clone. */
async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer> | Response> {
	const length = request.headers.get('content-length');
	if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BYTES))
		return failure(413, 'PAYLOAD_TOO_LARGE');
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_JSON_BYTES) {
				void reader.cancel().catch(() => {});
				return failure(413, 'PAYLOAD_TOO_LARGE');
			}
			chunks.push(value);
		}
	} catch {
		return failure(400, 'INVALID_INPUT');
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** Current API surface is JSON or bodyless, with cookie auth or invitation tokens.
 * No inbound webhook/raw-signature endpoint exists. Such a future route needs an explicit,
 * independently authenticated policy; never exempt the webhook MANAGEMENT API by prefix.
 */
export async function validateApiRequest(
	event: RequestEvent,
	policy: WebPolicy
): Promise<Response | null> {
	const { request, url } = event;
	const reject = (reason: RejectReason, status: number, code: string) =>
		rejected(event, policy, reason, failure(status, code));
	if (!methods.has(request.method)) return reject('METHOD_NOT_ALLOWED', 405, 'METHOD_NOT_ALLOWED');
	if (request.headers.has('x-http-method-override') || request.headers.has('x-method-override'))
		return reject('METHOD_OVERRIDE', 400, 'INVALID_INPUT');
	if (url.search.length > 8192) return reject('URI_TOO_LONG', 414, 'URI_TOO_LONG');
	for (const key of url.searchParams.keys()) {
		if (url.searchParams.getAll(key).length !== 1)
			return reject('DUPLICATE_QUERY_PARAMETER', 400, 'INVALID_INPUT');
	}
	if (!mutations.has(request.method)) return null;
	if (!allowsMutation(request, url, policy)) return reject('ORIGIN_REJECTED', 403, 'FORBIDDEN');
	if (request.headers.has('content-encoding'))
		return reject('CONTENT_ENCODING', 415, 'UNSUPPORTED_MEDIA_TYPE');
	const bytes = await boundedBody(request);
	if (bytes instanceof Response)
		return rejected(
			event,
			policy,
			bytes.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BODY_READ_FAILED',
			bytes
		);
	const type = request.headers.get('content-type');
	if (
		(bytes.length > 0 || type !== null) &&
		!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(type ?? '')
	)
		return reject('UNSUPPORTED_MEDIA_TYPE', 415, 'UNSUPPORTED_MEDIA_TYPE');
	if (bytes.length > 0) {
		let body: Record<string, unknown>;
		try {
			const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
			if (!value || typeof value !== 'object' || Array.isArray(value))
				return reject('INVALID_JSON', 400, 'INVALID_INPUT');
			body = value as Record<string, unknown>;
		} catch {
			return reject('INVALID_JSON', 400, 'INVALID_INPUT');
		}
		if (routePath(event).startsWith('/api/auth/')) {
			for (const key of ['callbackURL', 'newUserCallbackURL', 'errorCallbackURL']) {
				if (body[key] !== undefined && !isInternalLocation(body[key]))
					return reject('UNSAFE_CALLBACK_URL', 400, 'INVALID_INPUT');
			}
		}
	}
	// Preserve exact bytes and headers; existing strict domain readers remain authoritative.
	event.request = new Request(request.url, {
		method: request.method,
		headers: request.headers,
		signal: request.signal,
		body: bytes.length ? bytes : null
	});
	return null;
}

export function secureResponse(response: Response, url: URL, policy: WebPolicy): Response {
	const headers = new Headers(response.headers);
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('Referrer-Policy', 'no-referrer');
	headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
	// SvelteKit supplies document nonces. This fallback covers JSON and early error responses.
	if (!headers.has('Content-Security-Policy'))
		headers.set(
			'Content-Security-Policy',
			"default-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"
		);
	for (const name of [...headers.keys()])
		if (name.toLowerCase().startsWith('access-control-')) headers.delete(name);
	if (
		!policy.development &&
		configuredOrigin(policy, url)?.startsWith('https:') &&
		url.protocol === 'https:'
	)
		headers.set('Strict-Transport-Security', 'max-age=31536000');
	const sensitive =
		url.pathname === '/api' ||
		url.pathname.startsWith('/api/') ||
		url.pathname === '/app' ||
		url.pathname.startsWith('/app/') ||
		url.pathname === '/login' ||
		url.pathname.startsWith('/login/') ||
		url.pathname.startsWith('/invitations/');
	if (sensitive || headers.has('set-cookie')) headers.set('Cache-Control', 'private, no-store');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

/** Route identity prevents percent-encoded path aliases bypassing the API policy. */
function routePath(event: RequestEvent): string {
	if (event.route?.id) return event.route.id;
	try {
		return decodeURIComponent(event.url.pathname);
	} catch {
		return event.url.pathname;
	}
}

export async function handleWebRequest(
	event: RequestEvent,
	resolve: (event: RequestEvent, options?: ResolveOptions) => Response | Promise<Response>,
	policy: WebPolicy
): Promise<Response> {
	const pathname = routePath(event);
	const api = pathname === '/api' || pathname.startsWith('/api/');
	let response: Response;
	try {
		response =
			(api ? await validateApiRequest(event, policy) : null) ??
			(api && policy.beforeResolve ? await policy.beforeResolve(event) : null) ??
			(await resolve(event));
		if (api && response.status === 500) response = failure(response.status, 'INTERNAL_ERROR');
	} catch (error) {
		// 5.4W-E: the client gets the generic body; the redacted stack stays server-side.
		try {
			policy.observer?.unhandled(error);
		} catch {
			// ignore
		}
		response = failure(500, 'INTERNAL_ERROR');
	}
	const responseUrl = new URL(event.url);
	responseUrl.pathname = pathname;
	return secureResponse(response, responseUrl, policy);
}

import { json, type RequestEvent } from '@sveltejs/kit';
import { IncidentServiceError } from '$lib/server/services/incidents';

/**
 * Shared helpers of the PUBLIC invitation endpoints (verify / accept). Public error model:
 * a single INVALID_INVITATION for unknown, revoked, expired, used or invalidated tokens, and no
 * internal code (ROLE_*, MEMBERSHIP_*, USER_EXISTS, SQL...) ever reaches the client.
 */
const noStore = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
export const PUBLIC_BODY_MAX_BYTES = 4096;

export function publicFailure(status: number, code: string, message: string, extra?: HeadersInit) {
	return json({ error: { code, message } }, { status, headers: { ...noStore, ...extra } });
}

export function publicSuccess(body: unknown) {
	return json(body, { status: 200, headers: noStore });
}

export const invalidRequest = () => publicFailure(400, 'INVALID_INPUT', 'Invalid request.');

export function rateLimited(retryAfterSeconds: number) {
	return publicFailure(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', {
		'Retry-After': String(retryAfterSeconds)
	});
}

/** Client address as provided by the adapter; null when unavailable (never X-Forwarded-For). */
export function clientAddress(event: RequestEvent): string | null {
	try {
		return typeof event.getClientAddress === 'function' ? event.getClientAddress() : null;
	} catch {
		return null;
	}
}

/**
 * Strict JSON body: application/json only (form posts rejected), bounded size, plain object and
 * only the allowed keys. Returns null on any violation.
 */
export async function readPublicJson(
	request: Request,
	allowed: readonly string[]
): Promise<Record<string, unknown> | null> {
	if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return null;
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > PUBLIC_BODY_MAX_BYTES) return null;
	let text: string;
	try {
		text = await request.text();
	} catch {
		return null;
	}
	if (new TextEncoder().encode(text).length > PUBLIC_BODY_MAX_BYTES) return null;
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return null;
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
	if (Object.keys(body).some((key) => !allowed.includes(key))) return null;
	return body as Record<string, unknown>;
}

/** Maps acceptance/verification errors to the safe public contract. */
export function publicServiceFailure(error: unknown) {
	if (error instanceof IncidentServiceError) {
		switch (error.code) {
			case 'INVALID_INPUT':
				return invalidRequest();
			case 'INVALID_INVITATION':
				return publicFailure(404, 'INVALID_INVITATION', 'This invitation is not valid.');
			case 'AUTHENTICATION_REQUIRED':
				return publicFailure(
					401,
					'AUTHENTICATION_REQUIRED',
					'Sign in with the invited account to accept this invitation.'
				);
			case 'INVALID_ACCEPTOR':
				return publicFailure(
					403,
					'INVALID_ACCEPTOR',
					'This invitation cannot be accepted with the current session.'
				);
			case 'ACCEPTANCE_CONFLICT':
				return publicFailure(
					409,
					'ACCEPTANCE_CONFLICT',
					'The invitation could not be accepted. Try again.'
				);
		}
	}
	return publicFailure(500, 'INTERNAL_ERROR', 'Internal server error.');
}

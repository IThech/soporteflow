import { randomUUID } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { logError, logger, runWithLogContext } from './logger';

/**
 * Request correlation (5.4W-E). Every request gets a server-generated UUID v4:
 * - client-supplied X-Request-ID / X-Correlation-ID headers are IGNORED (never trusted, never
 *   echoed): an attacker cannot forge correlation, inject text into logs or collide ids;
 * - the id is stored in `event.locals.requestId`, bound to the logging context of everything the
 *   request runs (AsyncLocalStorage) and returned as `X-Request-ID` on every response, including
 *   4xx/5xx/429/503 and the W-C early rejections;
 * - one access entry per request: method, route TEMPLATE (never the raw path/query, which can
 *   carry invitation tokens), status and duration. Bodies, headers and cookies are never logged.
 *   429/503 limiter responses are covered by the throttled security events instead.
 */
export const REQUEST_ID_HEADER = 'X-Request-ID';
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isRequestId(value: unknown): value is string {
	return typeof value === 'string' && REQUEST_ID.test(value);
}

function withRequestId(response: Response, requestId: string): Response {
	try {
		response.headers.set(REQUEST_ID_HEADER, requestId);
		return response;
	} catch {
		// Immutable headers (e.g. a fetched Response): copy once.
		const headers = new Headers(response.headers);
		headers.set(REQUEST_ID_HEADER, requestId);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers
		});
	}
}

const METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);

export async function observeRequest(
	event: RequestEvent,
	run: () => Promise<Response>,
	clock: () => number = () => performance.now()
): Promise<Response> {
	const requestId = randomUUID();
	event.locals.requestId = requestId;
	const started = clock();
	return runWithLogContext({ requestId }, async () => {
		let response: Response;
		try {
			response = await run();
		} catch (error) {
			logError('http.unhandled_error', error);
			// Last resort (the W-C wrapper itself failed): keep the W-C baseline headers anyway.
			response = Response.json(
				{ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } },
				{
					status: 500,
					headers: {
						'Cache-Control': 'private, no-store',
						'X-Content-Type-Options': 'nosniff',
						'Referrer-Policy': 'no-referrer',
						'Content-Security-Policy':
							"default-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"
					}
				}
			);
		}
		const status = response.status;
		// 5.4X-B: successful health/readiness probes (every few seconds from the orchestrator) are
		// not access-logged; failures still are.
		const probe = (event.route?.id === '/healthz' || event.route?.id === '/readyz') && status < 500;
		if (!probe && status !== 429 && !(status === 503 && response.headers.get('retry-after'))) {
			const method = METHODS.has(event.request.method) ? event.request.method : 'OTHER';
			const fields = {
				method,
				route: event.route?.id ?? 'unmatched',
				status,
				durationMs: Math.round(clock() - started)
			};
			if (status >= 500) logger.error('http.request', fields);
			else logger.info('http.request', fields);
		}
		return withRequestId(response, requestId);
	});
}

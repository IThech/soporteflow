import { request } from 'node:https';
import type { ResolvedAddress } from './url-safety';

/**
 * Outbound webhook HTTP client (5.4V-B). Injected into the processor so tests never touch the
 * network. The default implementation:
 * - POSTs with node:https, never following redirects;
 * - PINS the TCP connection to an address that was already validated as public (custom `lookup`),
 *   while TLS still verifies the certificate against the original hostname (SNI) — this closes the
 *   DNS-rebinding window between validation and connection;
 * - aborts after `timeoutMs` (total), ignores and discards the response body.
 */

export interface WebhookHttpRequest {
	url: string;
	/** Validated public addresses for the URL host; the connection must use one of them. */
	addresses: readonly ResolvedAddress[];
	headers: Record<string, string>;
	body: string;
	timeoutMs: number;
}

export interface WebhookHttpResponse {
	status: number;
	/** Raw Retry-After header, if any (only this header is read). */
	retryAfter: string | null;
}

export type WebhookTransportErrorCode = 'TIMEOUT' | 'CONNECTION_FAILED' | 'TLS_ERROR';

/** Transport failure with a safe code; the message is never persisted. */
export class WebhookTransportError extends Error {
	constructor(readonly code: WebhookTransportErrorCode) {
		super(code);
		this.name = 'WebhookTransportError';
	}
}

export interface WebhookHttpClient {
	post(request: WebhookHttpRequest): Promise<WebhookHttpResponse>;
}

function transportCode(error: unknown): WebhookTransportErrorCode {
	const code = String((error as { code?: unknown })?.code ?? '');
	if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_OSSL)/.test(code))
		return 'TLS_ERROR';
	return 'CONNECTION_FAILED';
}

export const defaultWebhookHttpClient: WebhookHttpClient = {
	post(input) {
		return new Promise((resolve, reject) => {
			const url = new URL(input.url);
			const pinned = input.addresses[0];
			if (!pinned) return reject(new WebhookTransportError('CONNECTION_FAILED'));
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				fn();
			};
			const req = request(
				{
					protocol: 'https:',
					hostname: url.hostname.replace(/^\[(.*)\]$/, '$1'),
					port: url.port || 443,
					path: `${url.pathname}${url.search}`,
					method: 'POST',
					headers: { ...input.headers, 'Content-Length': Buffer.byteLength(input.body) },
					// Pin: the socket connects to the validated address, never a fresh DNS answer.
					lookup: (_hostname, options, callback) => {
						const cb = callback as (...args: unknown[]) => void;
						if ((options as { all?: boolean })?.all)
							cb(null, [{ address: pinned.address, family: pinned.family }]);
						else cb(null, pinned.address, pinned.family);
					},
					agent: false
				},
				(res) => {
					const retryAfter = res.headers['retry-after'];
					finish(() =>
						resolve({
							status: res.statusCode ?? 0,
							retryAfter: typeof retryAfter === 'string' ? retryAfter : null
						})
					);
					res.destroy(); // body is never read or stored
				}
			);
			const timer = setTimeout(() => {
				finish(() => reject(new WebhookTransportError('TIMEOUT')));
				req.destroy();
			}, input.timeoutMs);
			req.on('error', (error) =>
				finish(() => reject(new WebhookTransportError(transportCode(error))))
			);
			req.end(input.body);
		});
	}
};

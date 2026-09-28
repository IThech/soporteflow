/**
 * Central redaction for operational logs (5.4W-E). Server-only, dependency-free.
 *
 * Every value that reaches a log line goes through `redactValue`:
 * - keys that name a credential (password, token, secret, cookie, authorization, api key,
 *   encryption key, DATABASE_URL, …) are replaced by `[REDACTED]` whatever their value;
 * - strings are scrubbed of embedded credentials (URL userinfo, Bearer/Basic, `whsec_…`,
 *   `password=…`/`"token":"…"` pairs, session cookies, 64-hex keys) and truncated;
 * - structure is bounded (depth, keys, array items) so attacker-controlled input cannot produce
 *   huge entries; Requests/Responses/bodies/buffers are never serialized.
 *
 * Redaction is a safety net, not a licence: callers log identifiers and codes, never bodies.
 */

export const REDACTED = '[REDACTED]';
export const LOG_LIMITS = Object.freeze({
	maxString: 512,
	maxDepth: 4,
	maxKeys: 32,
	maxArray: 20,
	maxStack: 4096
});

/** Key names whose value is always a secret (matched on the normalized key). */
const SENSITIVE_KEY =
	/(pass(word|wd|phrase)?|pwd|secret|token|authorization|cookie|api-?key|access-?key|private-?key|credential|signature|encryption-?key|database-?url|connection-?string|dsn|smtp-?(pass|auth|user)|salt|ciphertext|auth-?tag|session|otp|^key$|^iv$)/;

const normalizeKey = (key: string) => key.toLowerCase().replace(/[_\s.]/g, '-');

export function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY.test(normalizeKey(key));
}

const STRING_RULES: readonly [RegExp, string][] = [
	// scheme://user:password@host -> scheme://[REDACTED]@host
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`],
	[/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
	[/whsec_[A-Za-z0-9_-]+/g, `whsec_${REDACTED}`],
	// cookie / query / form pairs: session_token=…, password=…, token=…
	[
		/\b([A-Za-z0-9_.-]*(?:pass(?:word)?|pwd|secret|token|api[_-]?key|authorization|session)[A-Za-z0-9_.-]*)=([^\s&;,"']+)/gi,
		`$1=${REDACTED}`
	],
	// JSON-ish pairs: "password": "…"
	[
		/("[A-Za-z0-9_.-]*(?:pass(?:word)?|pwd|secret|token|api[_-]?key|authorization|cookie)[A-Za-z0-9_.-]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
		`$1"${REDACTED}"`
	],
	// 32-byte keys written as hex (e.g. WEBHOOK_SECRET_ENCRYPTION_KEY)
	[/\b[0-9a-f]{64}\b/gi, REDACTED],
	// 32-byte values in standard base64 (44 chars, one '=' of padding)
	[/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/g, REDACTED],
	// Opaque bearer-like tokens: invitation tokens are 43 base64url chars; any unbroken
	// base64url run of 40+ chars is treated as a credential (UUIDs are 36; the rare long file
	// name in a stack trace is an accepted false positive).
	[/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g, REDACTED]
];

/** Scrubs embedded credentials from free text and truncates it. */
export function redactString(value: string, max: number = LOG_LIMITS.maxString): string {
	let out = value.length > max * 4 ? value.slice(0, max * 4) : value;
	for (const [pattern, replacement] of STRING_RULES) out = out.replace(pattern, replacement);
	return out.length > max ? `${out.slice(0, max)}…[truncated ${value.length - max}]` : out;
}

/** Only the connection shape of a database URL: never user, password or query. */
export function describeDatabaseUrl(raw: string | undefined): string {
	if (!raw) return 'unset';
	try {
		const url = new URL(raw);
		return `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}${url.pathname}`;
	} catch {
		return 'invalid';
	}
}

export interface SerializedError {
	name: string;
	code?: string;
	message: string;
	stack?: string;
}

/** Error summary: name, safe code, redacted message and (optionally) redacted stack. */
export function serializeError(error: unknown, includeStack = true): SerializedError {
	if (!(error instanceof Error)) {
		return { name: typeof error, message: redactString(String(error ?? ''), 200) };
	}
	const rawCode = (error as { code?: unknown }).code;
	const serialized: SerializedError = {
		name: redactString(error.name || 'Error', 80),
		message: redactString(error.message ?? '', LOG_LIMITS.maxString)
	};
	if (typeof rawCode === 'string' || typeof rawCode === 'number')
		serialized.code = redactString(String(rawCode), 80);
	if (includeStack && typeof error.stack === 'string')
		serialized.stack = redactString(error.stack, LOG_LIMITS.maxStack);
	return serialized;
}

function isBinary(value: object): boolean {
	return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

/**
 * Bounded, redacted copy of an arbitrary value, safe for JSON serialization. Never throws.
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (value === null || value === undefined) return value;
	switch (typeof value) {
		case 'string':
			return redactString(value);
		case 'number':
			return Number.isFinite(value) ? value : String(value);
		case 'boolean':
			return value;
		case 'bigint':
			return value.toString();
		case 'function':
		case 'symbol':
			return undefined;
	}
	const object = value as object;
	if (value instanceof Date)
		return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
	if (value instanceof Error) return serializeError(value, false);
	if (isBinary(object)) return '[binary]';
	if (
		(typeof Request !== 'undefined' && value instanceof Request) ||
		(typeof Response !== 'undefined' && value instanceof Response) ||
		(typeof ReadableStream !== 'undefined' && value instanceof ReadableStream)
	)
		return '[omitted]';
	if (typeof Headers !== 'undefined' && value instanceof Headers) {
		const out: Record<string, string> = {};
		let count = 0;
		for (const [name, headerValue] of value) {
			if (count++ >= LOG_LIMITS.maxKeys) break;
			out[name] = isSensitiveKey(name) ? REDACTED : redactString(headerValue);
		}
		return out;
	}
	if (seen.has(object)) return '[circular]';
	if (depth >= LOG_LIMITS.maxDepth) return '[max-depth]';
	seen.add(object);
	if (Array.isArray(value)) {
		const items = value
			.slice(0, LOG_LIMITS.maxArray)
			.map((item) => redactValue(item, depth + 1, seen));
		if (value.length > LOG_LIMITS.maxArray)
			items.push(`[+${value.length - LOG_LIMITS.maxArray} items]`);
		return items;
	}
	const out: Record<string, unknown> = {};
	const entries = value instanceof Map ? [...value.entries()] : Object.entries(object);
	let count = 0;
	for (const [rawKey, item] of entries) {
		if (count++ >= LOG_LIMITS.maxKeys) {
			out['…'] = `[+${entries.length - LOG_LIMITS.maxKeys} keys]`;
			break;
		}
		const key = redactString(String(rawKey), 64);
		out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1, seen);
	}
	return out;
}

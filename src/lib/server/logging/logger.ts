import { AsyncLocalStorage } from 'node:async_hooks';
import { redactString, redactValue, serializeError } from './redact';

/**
 * Structured server-side logging (5.4W-E). One JSON object per line; no dependency.
 *
 * Entry: { ts, level, event, requestId?, jobId?, worker?, ...fields }. Fields are redacted and
 * bounded (redact.ts); the final line escapes C1 controls and U+2028/U+2029 so user-controlled
 * text can never forge a new line or send terminal escapes (C0 controls are escaped by JSON).
 *
 * Context (requestId for HTTP, jobId/worker for processors) travels through AsyncLocalStorage,
 * so services log without threading ids through every call.
 *
 * Level: LOG_LEVEL = debug | info | warn | error | silent (default info). Non-secret.
 *
 * This is an OPERATIONAL log, not the administrative audit trail (5.4X-A): lines are not
 * append-only, not tamper-evident and may be dropped or sampled (see `throttled`).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const RANK: Record<LogLevel | 'silent', number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
	silent: 99
};
/** Hard cap for one serialized line; bigger entries are replaced by a truncation marker. */
export const MAX_LOG_LINE_BYTES = 8192;
const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,4}$/;
const RESERVED = new Set(['ts', 'level', 'event', 'requestId', 'jobId', 'worker']);

export interface LogContext {
	requestId?: string;
	jobId?: string;
	worker?: string;
}
export type LogSink = (line: string, level: LogLevel) => void;

const storage = new AsyncLocalStorage<LogContext>();

const defaultSink: LogSink = (line, level) => {
	(level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(line + '\n');
};
let sink: LogSink = defaultSink;

/** Test/wiring hook; undefined restores stdout/stderr. */
export function setLogSink(next: LogSink | undefined): void {
	sink = next ?? defaultSink;
}

function threshold(): number {
	const raw = (typeof process !== 'undefined' ? process.env.LOG_LEVEL : undefined)
		?.trim()
		.toLowerCase();
	return raw && raw in RANK ? RANK[raw as LogLevel | 'silent'] : RANK.info;
}

export function runWithLogContext<T>(context: LogContext, run: () => T): T {
	return storage.run({ ...storage.getStore(), ...context }, run);
}
export function currentLogContext(): LogContext {
	return { ...storage.getStore() };
}

/** Escapes characters JSON.stringify leaves raw but terminals/log viewers may interpret. */
/** C1 controls (incl. 8-bit CSI) and U+2028/U+2029: raw in JSON.stringify output. */
const UNSAFE_LINE_CHARS = /[\u007f-\u009f\u2028\u2029]/g;
function safeLine(value: unknown): string {
	return JSON.stringify(value).replace(
		UNSAFE_LINE_CHARS,
		(c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
	);
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
	try {
		if (RANK[level] < threshold()) return;
		const entry: Record<string, unknown> = {
			ts: new Date().toISOString(),
			level,
			event: EVENT_NAME.test(event) && event.length <= 80 ? event : 'log.invalid_event_name'
		};
		const context = storage.getStore();
		if (context?.requestId) entry.requestId = context.requestId;
		if (context?.jobId) entry.jobId = context.jobId;
		if (context?.worker) entry.worker = context.worker;
		const safe = redactValue(fields) as Record<string, unknown>;
		for (const [key, value] of Object.entries(safe ?? {})) {
			if (value === undefined) continue;
			entry[RESERVED.has(key) ? `field_${key}` : key] = value;
		}
		let line = safeLine(entry);
		if (Buffer.byteLength(line) > MAX_LOG_LINE_BYTES)
			line = safeLine({
				ts: entry.ts,
				level,
				event: entry.event,
				requestId: entry.requestId,
				jobId: entry.jobId,
				truncated: true
			});
		sink(line, level);
	} catch {
		// Logging never breaks the request or the worker.
	}
}

export const logger = {
	debug: (event: string, fields?: Record<string, unknown>) => log('debug', event, fields),
	info: (event: string, fields?: Record<string, unknown>) => log('info', event, fields),
	warn: (event: string, fields?: Record<string, unknown>) => log('warn', event, fields),
	error: (event: string, fields?: Record<string, unknown>) => log('error', event, fields)
};

/** Error-level entry with the redacted error (name, code, message, stack). Server-side only. */
export function logError(
	event: string,
	error: unknown,
	fields: Record<string, unknown> = {}
): void {
	log('error', event, { ...fields, error: serializeError(error, true) });
}

/**
 * Unexpected failure mapped to a generic 500 by a route: keeps the stack server-side, correlated
 * by requestId, while the client only ever sees `INTERNAL_ERROR`.
 */
export function logUnexpectedError(error: unknown, fields: Record<string, unknown> = {}): void {
	logError('http.internal_error', error, fields);
}

// ---------------------------------------------------------------------------------------------
// Throttling for events an attacker can trigger at will (429, rejected requests): at most
// `limit` lines per event+bucket per window, then one summary with the suppressed count. The
// bucket must come from server-side constants (policy/reason), never raw request input.
// ---------------------------------------------------------------------------------------------
const THROTTLE_WINDOW_MS = 60_000;
const THROTTLE_LIMIT = 20;
const THROTTLE_MAX_BUCKETS = 256;
const throttles = new Map<string, { windowStart: number; count: number; suppressed: number }>();

export function throttled(
	level: LogLevel,
	event: string,
	bucket: string,
	fields: Record<string, unknown> = {},
	now: number = Date.now()
): void {
	const key = `${event}|${bucket}`;
	let state = throttles.get(key);
	if (!state || now - state.windowStart >= THROTTLE_WINDOW_MS) {
		if (state?.suppressed)
			log(level, 'log.suppressed', { suppressedEvent: event, bucket, count: state.suppressed });
		if (!state && throttles.size >= THROTTLE_MAX_BUCKETS) throttles.clear();
		state = { windowStart: now, count: 0, suppressed: 0 };
		throttles.set(key, state);
	}
	if (state.count >= THROTTLE_LIMIT) {
		state.suppressed++;
		return;
	}
	state.count++;
	log(level, event, fields);
}

/** Test hook. */
export function resetLogThrottles(): void {
	throttles.clear();
}

/** Short, safe copy of an attacker-influenced label (route id, method) for a log field. */
export function safeLabel(value: unknown, max = 128): string | undefined {
	return typeof value === 'string' ? redactString(value, max) : undefined;
}

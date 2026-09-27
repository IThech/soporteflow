/**
 * 5.4W-A real PostgreSQL concurrency lab — core helpers (no PGlite anywhere).
 *
 * - Safeguards: DATABASE_URL is mandatory and must point to a clearly identified lab database;
 *   the server-side current_database() is re-checked on every connection.
 * - Every connection is an independent PostgreSQL session (postgres-js client with max: 1),
 *   with statement_timeout, lock_timeout and idle_in_transaction_session_timeout.
 * - Coordination: signals/barriers, a transaction wrapper that pauses a service transaction at a
 *   chosen point while it holds its locks, and lock-wait detection through pg_stat_activity.
 * - Never prints passwords, tokens, secrets or the full DATABASE_URL.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

export const LAB_APP_PREFIX = 'sf-wa-';
export const STATEMENT_TIMEOUT_MS = 20_000;
export const LOCK_TIMEOUT_MS = 10_000;
export const IDLE_IN_TX_TIMEOUT_MS = 60_000;
export const SCENARIO_TIMEOUT_MS = 60_000;

/** Exact names that are never accepted, whatever the pattern says. */
const DENIED_DATABASES = new Set([
	'soporteflow',
	'production',
	'prod',
	'postgres',
	'template0',
	'template1',
	'soporteflow_prod',
	'soporteflow_production'
]);
/** Accepted: lowercase identifiers that explicitly say lab/test/concurrency (e.g. soporteflow_concurrency_lab). */
const LAB_NAME = /^[a-z][a-z0-9_]*$/;
const LAB_MARKER = /(^|_)(lab|test|concurrency)(_|$)/;

export class LabSafetyError extends Error {
	constructor(message) {
		super(`[LAB SAFETY] ${message}`);
		this.name = 'LabSafetyError';
	}
}

/** Validates a database name as a lab database (pure; exported for tests of the guard itself). */
export function assertLabDatabaseName(name) {
	if (typeof name !== 'string' || !LAB_NAME.test(name))
		throw new LabSafetyError('database name must be a lowercase identifier');
	if (DENIED_DATABASES.has(name) || /prod/.test(name))
		throw new LabSafetyError(`database "${name}" is never accepted by the lab`);
	if (!LAB_MARKER.test(name))
		throw new LabSafetyError(
			`database "${name}" is not identified as lab/test (expected e.g. soporteflow_concurrency_lab)`
		);
	return name;
}

/** Parses DATABASE_URL (mandatory). Returns the target and a redacted description. */
export function labTarget(env = process.env) {
	const raw = env.DATABASE_URL;
	if (!raw || !raw.trim())
		throw new LabSafetyError(
			'DATABASE_URL is required (postgresql://USER:PASSWORD@HOST:PORT/soporteflow_concurrency_lab)'
		);
	let url;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new LabSafetyError('DATABASE_URL is not a valid URL');
	}
	if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:')
		throw new LabSafetyError('DATABASE_URL must use postgresql://');
	const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
	assertLabDatabaseName(database);
	// 5.4W-A (first real run): route-level scenarios run the production auth configuration, which
	// only accepts a DATABASE_URL with a hostname. A socket-only URL (postgresql:///db + PGHOST)
	// silently disables authentication there, so the lab requires TCP like production does.
	if (!url.hostname)
		throw new LabSafetyError(
			'DATABASE_URL must include a host (TCP, e.g. postgresql://USER:PASSWORD@127.0.0.1:5432/soporteflow_concurrency_lab): ' +
				'the production auth configuration rejects socket-only URLs'
		);
	const host = url.hostname;
	const redacted = `${decodeURIComponent(url.username) || '(default user)'}@${host}${
		url.port ? ':' + url.port : ''
	}/${database}`;
	return { url: raw.trim(), database, redacted };
}

let connectionCounter = 0;
const openClients = new Set();

/**
 * Opens ONE independent PostgreSQL session and verifies it really is the lab database.
 * Returns { sql, db, label, appName }. `schema` enables drizzle's relational API (optional).
 */
export async function connect(label, schema) {
	const target = labTarget();
	const appName = `${LAB_APP_PREFIX}${label}-${++connectionCounter}`.slice(0, 60);
	const sql = postgres(target.url, {
		max: 1,
		idle_timeout: 0,
		connect_timeout: 10,
		prepare: true,
		onnotice: () => {},
		connection: {
			application_name: appName,
			statement_timeout: STATEMENT_TIMEOUT_MS,
			lock_timeout: LOCK_TIMEOUT_MS,
			idle_in_transaction_session_timeout: IDLE_IN_TX_TIMEOUT_MS
		}
	});
	openClients.add(sql);
	const [row] = await sql`SELECT current_database() AS db, pg_backend_pid() AS pid`;
	if (row.db !== target.database) {
		await sql.end({ timeout: 1 });
		throw new LabSafetyError('connected database does not match DATABASE_URL');
	}
	assertLabDatabaseName(row.db);
	return { sql, db: drizzle(sql, schema ? { schema } : undefined), label, appName, pid: row.pid };
}

export async function closeAll() {
	await Promise.all([...openClients].map((sql) => sql.end({ timeout: 2 }).catch(() => {})));
	openClients.clear();
}

/** Rejects if `promise` does not settle within ms (no scenario may hang on a lock forever). */
export function withTimeout(promise, ms, label) {
	let timer;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`[TIMEOUT] ${label} exceeded ${ms} ms`)), ms);
		})
	]);
}

/** One-shot signal: wait() until notify(). Times out instead of hanging. */
export function createSignal(name, timeoutMs = 20_000) {
	let resolve;
	let reject;
	let done = false;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	const timer = setTimeout(() => {
		if (!done) {
			done = true;
			reject(new Error(`[SIGNAL TIMEOUT] ${name} after ${timeoutMs} ms`));
		}
	}, timeoutMs);
	promise.catch(() => {});
	return {
		name,
		notify(value) {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(value);
		},
		fail(error) {
			if (done) return;
			done = true;
			clearTimeout(timer);
			reject(error);
		},
		wait: () => promise,
		get done() {
			return done;
		}
	};
}

/**
 * Wraps a drizzle db so that its N-th call to db.transaction() (1-based) pauses while holding
 * its locks:
 * - at: 'beforeCommit' (default): after the callback succeeded, before COMMIT;
 * - at: 'beforeStart': before the callback runs (transaction opened, nothing locked yet).
 * `reached` is notified when paused; the transaction continues after `release.notify()`.
 * If `failWith` is set, the paused transaction throws it after release (forces ROLLBACK).
 * The wrapper keeps `'transaction' in db === true` (services rely on it).
 */
export function pausingDb(db, { call = 1, at = 'beforeCommit', failWith } = {}) {
	const reached = createSignal(`pause#${call}:${at}:reached`);
	const release = createSignal(`pause#${call}:${at}:release`, 45_000);
	let calls = 0;
	const wrapped = new Proxy(db, {
		get(target, prop, receiver) {
			if (prop !== 'transaction') {
				const value = Reflect.get(target, prop, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			}
			return (fn, config) => {
				const n = ++calls;
				if (n !== call) return target.transaction(fn, config);
				return target.transaction(async (tx) => {
					if (at === 'beforeStart') {
						reached.notify();
						await release.wait();
					}
					const result = await fn(tx);
					if (at === 'beforeCommit') {
						reached.notify();
						await release.wait();
					}
					if (failWith) throw failWith;
					return result;
				}, config);
			};
		}
	});
	return { db: wrapped, reached, release, calls: () => calls };
}

/**
 * Waits until the session whose application_name is `appName` is blocked on a lock
 * (pg_stat_activity.wait_event_type = 'Lock'). Proves the competing operation really reached
 * the database and is waiting, instead of assuming it with a sleep.
 */
export async function waitForLockWait(monitorSql, appName, timeoutMs = 15_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const rows = await monitorSql`
			SELECT pid FROM pg_stat_activity
			WHERE application_name = ${appName} AND wait_event_type = 'Lock'`;
		if (rows.length > 0) return rows.length;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`[LOCK WAIT TIMEOUT] ${appName} never blocked on a lock within ${timeoutMs} ms`);
}

/**
 * Same as waitForLockWait for sessions we do not name (e.g. the production pool used by routes):
 * any backend of this database, other than `excludePids`, blocked on a lock.
 */
export async function waitForForeignLockWait(monitorSql, excludePids = [], timeoutMs = 15_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const rows = await monitorSql`
			SELECT pid FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'
			  AND NOT (pid = ANY(${excludePids}))`;
		if (rows.length > 0) return rows.length;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`[LOCK WAIT TIMEOUT] no foreign session blocked within ${timeoutMs} ms`);
}

/** Minimal scenario log: scenario, worker, outcome. Never values, tokens or URLs. */
export function log(scenario, message) {
	process.stdout.write(`  [${scenario}] ${message}\n`);
}

/** Settles all promises and returns { status, value | reason } like Promise.allSettled. */
export const settle = (promises) => Promise.allSettled(promises);

/** Error code of a service error or a PostgreSQL error (driver wraps the cause). */
export function errorCode(error) {
	return error?.code ?? error?.cause?.code ?? error?.name ?? 'UNKNOWN';
}

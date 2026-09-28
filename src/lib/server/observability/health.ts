import { sql } from 'drizzle-orm';
import { validateServerEnvironment } from '../config/env';
import { serializeError } from '../logging/redact';
import { throttled } from '../logging/logger';

/**
 * Health and readiness (5.4X-B). Public, minimal, no secrets:
 *
 * - liveness  (`GET /healthz`): the process answers. Never touches the database or the network.
 * - readiness (`GET /readyz`):  configuration valid + database reachable (`SELECT 1`, bounded by
 *   a timeout). 200 when ready, 503 otherwise.
 *
 * Responses carry only `status`, `service`, `version` (SvelteKit build id), per-check
 * `ok`/`fail`/`unconfigured` and a timestamp — never URLs, hostnames, error messages or stacks.
 * Diagnostic detail for a failed check goes to the structured log (`health.readiness_failed`,
 * throttled, redacted), correlated by requestId.
 */

export const HEALTH_SERVICE = 'soporteflow-core';
export const READINESS_DB_TIMEOUT_MS = 2_000;

export type CheckState = 'ok' | 'fail' | 'unconfigured';
export interface HealthReport {
	status: 'ok' | 'unavailable';
	service: string;
	version: string;
	checks: Record<string, CheckState>;
	timestamp: string;
}

interface Pingable {
	execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
}

export interface ReadinessDependencies {
	env: Record<string, string | undefined>;
	development: boolean;
	version: string;
	/** Database handle; null when DATABASE_URL is absent (demo builds). */
	db: Pingable | null;
	timeoutMs?: number;
	now?: () => Date;
}

export function livenessReport(version: string, now: Date = new Date()): HealthReport {
	return {
		status: 'ok',
		service: HEALTH_SERVICE,
		version,
		checks: { process: 'ok' },
		timestamp: now.toISOString()
	};
}

async function pingDatabase(db: Pingable, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			db.execute(sql`select 1`),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('readiness database timeout')), timeoutMs);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function readinessReport(deps: ReadinessDependencies): Promise<HealthReport> {
	const checks: Record<string, CheckState> = {};
	try {
		validateServerEnvironment(deps.env, { development: deps.development });
		checks.config = 'ok';
	} catch (error) {
		checks.config = 'fail';
		throttled('error', 'health.readiness_failed', 'config', {
			check: 'config',
			error: serializeError(error, false)
		});
	}
	if (!deps.db) {
		checks.database = 'unconfigured';
	} else {
		try {
			await pingDatabase(deps.db, deps.timeoutMs ?? READINESS_DB_TIMEOUT_MS);
			checks.database = 'ok';
		} catch (error) {
			checks.database = 'fail';
			throttled('error', 'health.readiness_failed', 'database', {
				check: 'database',
				error: serializeError(error, false)
			});
		}
	}
	const ready = Object.values(checks).every((state) => state === 'ok');
	return {
		status: ready ? 'ok' : 'unavailable',
		service: HEALTH_SERVICE,
		version: deps.version,
		checks,
		timestamp: (deps.now ?? (() => new Date()))().toISOString()
	};
}

export function healthResponse(report: HealthReport, method: string): Response {
	const status = report.status === 'ok' ? 200 : 503;
	const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
	return new Response(method === 'HEAD' ? null : JSON.stringify(report), { status, headers });
}

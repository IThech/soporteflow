import type { RequestHandler } from '@sveltejs/kit';
import { dev, version } from '$app/environment';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { healthResponse, readinessReport } from '$lib/server/observability/health';

/**
 * GET|HEAD /readyz — readiness (5.4X-B): valid configuration and a reachable database.
 * 200 { status: 'ok' } or 503 { status: 'unavailable' } with per-check states only.
 */
export const GET: RequestHandler = async ({ request }) => {
	const merged = { ...process.env, ...env };
	let db: Parameters<typeof readinessReport>[0]['db'] = null;
	if (merged.DATABASE_URL?.trim()) {
		try {
			db = getDb();
		} catch {
			db = null;
		}
	}
	return healthResponse(
		await readinessReport({ env: merged, development: dev, version, db }),
		request.method
	);
};
export const HEAD = GET;

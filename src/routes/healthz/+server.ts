import type { RequestHandler } from '@sveltejs/kit';
import { version } from '$app/environment';
import { healthResponse, livenessReport } from '$lib/server/observability/health';

/** GET|HEAD /healthz — liveness only (5.4X-B): no database, no network, no configuration detail. */
export const GET: RequestHandler = ({ request }) =>
	healthResponse(livenessReport(version), request.method);
export const HEAD = GET;

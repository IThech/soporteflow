import { json } from '@sveltejs/kit';
import { IncidentServiceError } from '$lib/server/services/incidents';
import type { SiteRecord } from '$lib/server/services/sites';

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { 'Cache-Control': 'private, no-store' };

export function failure(status: number, code: string, message: string) {
	return json({ error: { code, message } }, { status, headers: noStore });
}

export function success(body: unknown, status = 200) {
	return json(body, { status, headers: noStore });
}

/** Explicit allowlist: never organizationId or description. */
export function toSiteDto(site: SiteRecord) {
	return {
		id: site.id,
		name: site.name,
		active: site.active,
		createdAt: site.createdAt,
		updatedAt: site.updatedAt
	};
}

/** Rejects unknown or repeated query parameters. */
export function onlyKeys(params: URLSearchParams, allowed: string[]): boolean {
	for (const key of params.keys()) {
		if (!allowed.includes(key) || params.getAll(key).length !== 1) return false;
	}
	return true;
}

/** Parses a JSON object body; returns a Response on malformed input. */
export async function readJsonObject(
	request: Request
): Promise<Record<string, unknown> | Response> {
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return failure(400, 'INVALID_INPUT', 'Invalid JSON body.');
	}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload))
		return failure(400, 'INVALID_INPUT', 'Body must be a JSON object.');
	return payload as Record<string, unknown>;
}

/** Maps service errors to stable client messages; never forwards driver or SQL details. */
export function siteServiceFailure(error: unknown) {
	if (error instanceof IncidentServiceError) {
		if (error.code === 'INVALID_INPUT') return failure(400, 'INVALID_INPUT', error.message + '.');
		if (error.code === 'SITE_NOT_FOUND') return failure(404, 'SITE_NOT_FOUND', 'Site not found.');
		if (error.code === 'SITE_NAME_DUPLICATE')
			return failure(
				409,
				'SITE_NAME_DUPLICATE',
				'A site with this name already exists in the organization.'
			);
		// Organization state only changes between authorization and write: treat as denied.
		if (error.code === 'ORGANIZATION_NOT_FOUND' || error.code === 'ORGANIZATION_NOT_OPERATIONAL')
			return failure(403, 'FORBIDDEN', 'Permission denied.');
	}
	return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
}

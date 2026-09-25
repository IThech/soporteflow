import { json } from '@sveltejs/kit';
import { IncidentServiceError } from '$lib/server/services/incidents';
import type { CategoryRecord } from '$lib/server/services/categories';

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { 'Cache-Control': 'private, no-store' };

export function failure(status: number, code: string, message: string) {
	return json({ error: { code, message } }, { status, headers: noStore });
}

export function success(body: unknown, status = 200) {
	return json(body, { status, headers: noStore });
}

/** Explicit allowlist: never organizationId or any demo/classification field. */
export function toCategoryDto(category: CategoryRecord) {
	return {
		id: category.id,
		name: category.name,
		description: category.description,
		active: category.active,
		createdAt: category.createdAt,
		updatedAt: category.updatedAt
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

/** Accepts only string or null for description (the service normalizes it). */
export function isDescription(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

/** Maps service errors to stable client messages; never forwards driver or SQL details. */
export function categoryServiceFailure(error: unknown) {
	if (error instanceof IncidentServiceError) {
		if (error.code === 'INVALID_INPUT') return failure(400, 'INVALID_INPUT', error.message + '.');
		if (error.code === 'CATEGORY_NOT_FOUND')
			return failure(404, 'CATEGORY_NOT_FOUND', 'Category not found.');
		if (error.code === 'CATEGORY_NAME_DUPLICATE')
			return failure(
				409,
				'CATEGORY_NAME_DUPLICATE',
				'A category with this name already exists in the organization.'
			);
		// Organization state only changes between authorization and write: treat as denied.
		if (error.code === 'ORGANIZATION_NOT_FOUND' || error.code === 'ORGANIZATION_NOT_OPERATIONAL')
			return failure(403, 'FORBIDDEN', 'Permission denied.');
	}
	return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
}

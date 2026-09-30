import { resultLimitFailure } from '$lib/server/security/bounded-read';
import { json } from '@sveltejs/kit';
import { IncidentServiceError } from '$lib/server/services/incidents';
import { isActorAuthorizationError } from '$lib/server/auth/transactional-authorization';
import type { ClientRecord } from '$lib/server/services/clients';
import { logUnexpectedError } from '$lib/server/logging/logger';

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { 'Cache-Control': 'private, no-store' };

export function failure(status: number, code: string, message: string) {
	return json({ error: { code, message } }, { status, headers: noStore });
}

export function success(body: unknown, status = 200) {
	return json(body, { status, headers: noStore });
}

/** Explicit allowlist: never organizationId. */
export function toClientDto(client: ClientRecord) {
	return {
		id: client.id,
		name: client.name,
		description: client.description,
		active: client.active,
		createdAt: client.createdAt,
		updatedAt: client.updatedAt
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
export function clientServiceFailure(error: unknown) {
	const oversized = resultLimitFailure(error);
	if (oversized) return oversized;
	if (isActorAuthorizationError(error)) return failure(403, 'FORBIDDEN', 'Permission denied.');
	if (error instanceof IncidentServiceError) {
		if (error.code === 'INVALID_INPUT') return failure(400, 'INVALID_INPUT', error.message + '.');
		if (error.code === 'CLIENT_NOT_FOUND')
			return failure(404, 'CLIENT_NOT_FOUND', 'Client not found.');
		if (error.code === 'CLIENT_NAME_DUPLICATE')
			return failure(
				409,
				'CLIENT_NAME_DUPLICATE',
				'A client with this name already exists in the organization.'
			);
		if (error.code === 'ORGANIZATION_NOT_FOUND' || error.code === 'ORGANIZATION_NOT_OPERATIONAL')
			return failure(403, 'FORBIDDEN', 'Permission denied.');
	}
	logUnexpectedError(error);
	return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
}

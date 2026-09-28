import type { RequestEvent } from '@sveltejs/kit';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { NotificationPreferenceError } from '$lib/server/services/notification-preferences';
import type { NotificationPreferenceContext } from '$lib/server/services/notification-preferences';
import { failure, onlyKeys, uuid } from '../roles/http';
import { logUnexpectedError } from '$lib/server/logging/logger';

export { failure, success } from '../roles/http';

const MAX_BODY_BYTES = 256;

/**
 * Personal resource (like the inbox): session + the caller's own membership in the organization.
 * The user is always the principal; no user id is ever accepted from query or body.
 */
export async function preferenceContext(
	event: RequestEvent,
	mutation: boolean
): Promise<{ response: Response } | { context: NotificationPreferenceContext }> {
	const query = event.url.searchParams;
	const organizationId = query.get('organizationId');
	if (!onlyKeys(query, ['organizationId']) || !organizationId || !uuid.test(organizationId))
		return { response: failure(400, 'INVALID_INPUT', 'Invalid request.') };
	if (mutation && event.request.headers.get('origin') !== event.url.origin)
		return { response: failure(403, 'FORBIDDEN', 'Permission denied.') };
	const principal = await resolvePrincipal(event.request.headers);
	if (!principal) return { response: failure(401, 'UNAUTHORIZED', 'Authentication required.') };
	return { context: { organizationId, userId: principal.userId } };
}

/** Strict small JSON body: application/json, at most 256 bytes, a plain object. */
export async function readSmallJson(request: Request): Promise<Record<string, unknown> | null> {
	if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return null;
	const reader = request.body?.getReader();
	if (!reader) return null;
	const decoder = new TextDecoder();
	let text = '';
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.length;
			if (size > MAX_BODY_BYTES) {
				await reader.cancel();
				return null;
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		reader.releaseLock();
	}
	try {
		const body: unknown = JSON.parse(text);
		return body && typeof body === 'object' && !Array.isArray(body)
			? (body as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export function preferenceFailure(error: unknown): Response {
	if (error instanceof NotificationPreferenceError) {
		if (error.code === 'INVALID_INPUT') return failure(400, 'INVALID_INPUT', 'Invalid request.');
		if (error.code === 'FORBIDDEN') return failure(403, 'FORBIDDEN', 'Permission denied.');
	}
	logUnexpectedError(error);
	return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
}

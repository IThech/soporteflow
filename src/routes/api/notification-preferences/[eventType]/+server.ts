import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	resetNotificationPreference,
	setNotificationPreference
} from '$lib/server/services/notification-preferences';
import { isNotificationEventType } from '$lib/notifications/events';
import { failure, preferenceContext, preferenceFailure, readSmallJson, success } from '../http';

/**
 * PUT /api/notification-preferences/<eventType>?organizationId=<UUID>   body: a strict subset of
 * { inAppEnabled: boolean | null, emailEnabled: boolean | null } with at least one key. Only the
 * channels present change (boolean = override, null = back to that channel's default); idempotent.
 * 200 { preference: { eventType, inAppEnabled, emailEnabled, inAppIsDefault, emailIsDefault } }.
 * Unknown event, unknown key, empty body or non-boolean/null value -> 400.
 */
export const PUT: RequestHandler = async (event) => {
	if (!isNotificationEventType(event.params.eventType))
		return failure(400, 'INVALID_INPUT', 'Invalid request.');
	try {
		const resolved = await preferenceContext(event, true);
		if ('response' in resolved) return resolved.response;
		const body = await readSmallJson(event.request);
		const keys = body ? Object.keys(body) : [];
		if (
			!body ||
			keys.length === 0 ||
			keys.some(
				(key) =>
					(key !== 'inAppEnabled' && key !== 'emailEnabled') ||
					(body[key] !== null && typeof body[key] !== 'boolean')
			)
		)
			return failure(400, 'INVALID_INPUT', 'Invalid request.');
		return success({
			preference: await setNotificationPreference(
				db,
				resolved.context,
				event.params.eventType,
				body
			)
		});
	} catch (error) {
		return preferenceFailure(error);
	}
};

/**
 * DELETE /api/notification-preferences/<eventType>?organizationId=<UUID>   (no body)
 * Removes the caller's overrides of both channels: back to the catalog defaults. Idempotent 204.
 */
export const DELETE: RequestHandler = async (event) => {
	if (!isNotificationEventType(event.params.eventType))
		return failure(400, 'INVALID_INPUT', 'Invalid request.');
	try {
		const resolved = await preferenceContext(event, true);
		if ('response' in resolved) return resolved.response;
		if (event.request.body !== null)
			return failure(400, 'INVALID_INPUT', 'Request body is not allowed.');
		await resetNotificationPreference(db, resolved.context, event.params.eventType);
		return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
	} catch (error) {
		return preferenceFailure(error);
	}
};

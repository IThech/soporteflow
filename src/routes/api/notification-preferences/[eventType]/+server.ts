import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	resetNotificationPreference,
	setNotificationPreference
} from '$lib/server/services/notification-preferences';
import { isNotificationEventType } from '$lib/notifications/events';
import { failure, preferenceContext, preferenceFailure, readSmallJson, success } from '../http';

/**
 * PUT /api/notification-preferences/<eventType>?organizationId=<UUID>   body exactly
 * { inAppEnabled: boolean }. Stores the final value for the caller (upsert, idempotent).
 * 200 { preference: { eventType, inAppEnabled, isDefault: false } }. Unknown event -> 400.
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
			keys.length !== 1 ||
			keys[0] !== 'inAppEnabled' ||
			typeof body.inAppEnabled !== 'boolean'
		)
			return failure(400, 'INVALID_INPUT', 'Invalid request.');
		return success({
			preference: await setNotificationPreference(
				db,
				resolved.context,
				event.params.eventType,
				body.inAppEnabled
			)
		});
	} catch (error) {
		return preferenceFailure(error);
	}
};

/**
 * DELETE /api/notification-preferences/<eventType>?organizationId=<UUID>   (no body)
 * Removes the caller's override: back to the catalog default. Idempotent 204.
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

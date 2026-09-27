import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { listNotificationPreferences } from '$lib/server/services/notification-preferences';
import { preferenceContext, preferenceFailure, success } from './http';

/**
 * GET /api/notification-preferences?organizationId=<UUID>
 * The caller's own effective preferences for every catalogued event (defaults included), in
 * catalog order: { preferences: [{ eventType, inAppEnabled, isDefault }] }.
 */
export const GET: RequestHandler = async (event) => {
	try {
		const resolved = await preferenceContext(event, false);
		if ('response' in resolved) return resolved.response;
		return success({ preferences: await listNotificationPreferences(db, resolved.context) });
	} catch (error) {
		return preferenceFailure(error);
	}
};

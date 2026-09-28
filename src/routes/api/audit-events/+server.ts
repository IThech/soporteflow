import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { logUnexpectedError } from '$lib/server/logging/logger';
import { AuditEventError, listAuditEvents } from '$lib/server/services/audit-events';
import { failure, requireCapability, success, uuid } from '../roles/http';

/**
 * GET /api/audit-events?organizationId=<UUID>[&limit&cursor&actorUserId&action&entityType
 *   &entityId&from&to]   (audit:view)
 *
 * Read-only by design: there is no POST/PATCH/DELETE for audit events (append-only trail; events
 * are written by the administrative mutations themselves). Tenant from the query, identity from
 * the session; other tenants' events are unreachable (the query is always organization-scoped).
 */
export const GET: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	try {
		const denied = await requireCapability(event.request.headers, organizationId, 'audit:view');
		if (denied) return denied;
		return success(await listAuditEvents(db, organizationId, params));
	} catch (error) {
		if (error instanceof AuditEventError)
			return failure(400, 'INVALID_INPUT', 'Invalid audit query.');
		logUnexpectedError(error);
		return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
	}
};

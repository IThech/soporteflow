import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { withActorAuthorization } from '$lib/server/auth/transactional-authorization';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import { createClient, listClients } from '$lib/server/services/clients';
import {
	clientServiceFailure,
	failure,
	onlyKeys,
	readJsonObject,
	success,
	toClientDto,
	uuid
} from './http';
import { withAudit } from '$lib/server/services/audit-events';

/**
 * GET /api/clients?organizationId=<UUID>[&activeOnly=true|false]
 * Requires clients:view. Inactive clients are included unless activeOnly=true.
 * Authentication and authorization precede query validation beyond organizationId.
 */
export const GET: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	try {
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		if (
			!(await authorizeAction(event.request.headers, {
				organizationId,
				permissionId: 'clients:view'
			}))
		)
			return failure(403, 'FORBIDDEN', 'Permission denied.');

		const activeOnly = params.get('activeOnly');
		if (
			!onlyKeys(params, ['organizationId', 'activeOnly']) ||
			(activeOnly !== null && activeOnly !== 'true' && activeOnly !== 'false')
		)
			return failure(400, 'INVALID_INPUT', 'Invalid clients query.');

		const clients = await listClients(db, organizationId, { activeOnly: activeOnly === 'true' });
		return success({ clients: clients.map(toClientDto) });
	} catch (error) {
		return clientServiceFailure(error);
	}
};

/**
 * POST /api/clients?organizationId=<UUID> with body { name, description? }.
 * Requires clients:manage. Tenant comes only from the query; identity only from the session.
 */
export const POST: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	if (!onlyKeys(params, ['organizationId']))
		return failure(400, 'INVALID_INPUT', 'Invalid clients query.');
	try {
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		if (
			!(await authorizeAction(event.request.headers, {
				organizationId,
				permissionId: 'clients:manage'
			}))
		)
			return failure(403, 'FORBIDDEN', 'Permission denied.');

		const payload = await readJsonObject(event.request);
		if (payload instanceof Response) return payload;
		for (const key of Object.keys(payload)) {
			if (key !== 'name' && key !== 'description')
				return failure(400, 'INVALID_INPUT', `Unknown property '${key}'.`);
		}
		if (typeof payload.name !== 'string')
			return failure(400, 'INVALID_INPUT', 'name must be a string.');

		const name = payload.name;
		const description = payload.description;
		const client = await withActorAuthorization(
			db,
			{
				userId: principal.userId,
				organizationId,
				permissionIds: ['clients:manage'],
				lock: 'share'
			},
			(tx) =>
				withAudit(
					tx,
					organizationId,
					principal.userId,
					() => createClient(tx, organizationId, { name, description }),
					(created) => ({
						action: 'client.created',
						entityType: 'client',
						entityId: created.id
					})
				)
		);
		return success({ client: toClientDto(client) }, 201);
	} catch (error) {
		return clientServiceFailure(error);
	}
};

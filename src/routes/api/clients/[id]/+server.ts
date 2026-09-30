import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { withActorAuthorization } from '$lib/server/auth/transactional-authorization';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { authorizeAction } from '$lib/server/auth/authorization';
import { getClient, setClientActive, updateClient } from '$lib/server/services/clients';
import {
	clientServiceFailure,
	failure,
	onlyKeys,
	readJsonObject,
	success,
	toClientDto,
	uuid
} from '../http';
import { withAudit } from '$lib/server/services/audit-events';

/**
 * GET /api/clients/<id>?organizationId=<UUID>
 * Requires clients:view. Returns 404 for missing or other tenant's clients.
 */
export const GET: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	const clientId = event.params.id;
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	if (!clientId || !uuid.test(clientId))
		return failure(400, 'INVALID_INPUT', 'clientId must be a valid UUID.');
	if (!onlyKeys(params, ['organizationId']))
		return failure(400, 'INVALID_INPUT', 'Invalid clients query.');
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

		const client = await getClient(db, organizationId, clientId);
		return success({ client: toClientDto(client) });
	} catch (error) {
		return clientServiceFailure(error);
	}
};

/**
 * PATCH /api/clients/<id>?organizationId=<UUID> with a discriminated body:
 *   { "action": "rename", "name": "..." }
 *   { "action": "edit", "name": "...", "description": "..." }
 *   { "action": "set_active", "active": true | false }
 * Operations are never mixed. Requires clients:manage. A client of another tenant behaves
 * exactly like a missing client (404).
 */
export const PATCH: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	const clientId = event.params.id;
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	if (!clientId || !uuid.test(clientId))
		return failure(400, 'INVALID_INPUT', 'clientId must be a valid UUID.');
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

		if (payload.action === 'rename') {
			if (typeof payload.name !== 'string')
				return failure(400, 'INVALID_INPUT', 'rename requires name as string.');
			const name = payload.name;
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
						() => updateClient(tx, organizationId, clientId, { name }),
						() => ({
							action: 'client.renamed',
							entityType: 'client',
							entityId: clientId
						})
					)
			);
			return success({ client: toClientDto(client) });
		}

		if (payload.action === 'edit') {
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
						() =>
							updateClient(tx, organizationId, clientId, {
								name: payload.name,
								description: payload.description
							}),
						() => ({
							action: 'client.updated',
							entityType: 'client',
							entityId: clientId
						})
					)
			);
			return success({ client: toClientDto(client) });
		}

		if (payload.action === 'set_active') {
			if (typeof payload.active !== 'boolean')
				return failure(400, 'INVALID_INPUT', 'set_active requires active as boolean.');
			const active = payload.active;
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
						() => setClientActive(tx, organizationId, clientId, active),
						() => ({
							action: active ? 'client.activated' : 'client.deactivated',
							entityType: 'client',
							entityId: clientId
						})
					)
			);
			return success({ client: toClientDto(client) });
		}

		return failure(400, 'INVALID_INPUT', 'Unknown or missing action.');
	} catch (error) {
		return clientServiceFailure(error);
	}
};

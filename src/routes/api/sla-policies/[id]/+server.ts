import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { withActorAuthorization } from '$lib/server/auth/transactional-authorization';
import { getSlaPolicy, updateSlaPolicy } from '$lib/server/services/sla-policies';
import {
	failure,
	onlyKeys,
	readJsonObject,
	requireActor,
	requireCapability,
	slaServiceFailure,
	success,
	toSlaPolicyDto,
	uuid
} from '../http';
import { withAudit } from '$lib/server/services/audit-events';

function ids(
	event: Parameters<RequestHandler>[0]
): { error: Response } | { organizationId: string; policyId: string } {
	const organizationId = event.url.searchParams.get('organizationId');
	const policyId = event.params.id;
	if (!organizationId || !uuid.test(organizationId))
		return { error: failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.') };
	if (!policyId || !uuid.test(policyId))
		return { error: failure(400, 'INVALID_INPUT', 'policyId must be a valid UUID.') };
	return { organizationId, policyId };
}

/**
 * GET /api/sla-policies/<id>?organizationId=<UUID>
 * Requires sla:view. Another tenant's policy is indistinguishable from a missing one (404).
 */
export const GET: RequestHandler = async (event) => {
	const parsed = ids(event);
	if ('error' in parsed) return parsed.error;
	try {
		const denied = await requireCapability(
			event.request.headers,
			parsed.organizationId,
			'sla:view'
		);
		if (denied) return denied;
		if (!onlyKeys(event.url.searchParams, ['organizationId']))
			return failure(400, 'INVALID_INPUT', 'Invalid SLA policies query.');
		const policy = await getSlaPolicy(db, parsed.organizationId, parsed.policyId);
		return success({ slaPolicy: toSlaPolicyDto(policy) });
	} catch (error) {
		return slaServiceFailure(error);
	}
};

/**
 * PATCH /api/sla-policies/<id>?organizationId=<UUID>
 * body: at least one of { name, description, active, firstResponseMinutes, resolutionMinutes,
 * isDefault }. code is immutable. Requires sla:manage. No DELETE: deactivate with active=false.
 */
export const PATCH: RequestHandler = async (event) => {
	const parsed = ids(event);
	if ('error' in parsed) return parsed.error;
	try {
		const actor = await requireActor(event.request.headers, parsed.organizationId, 'sla:manage');
		if ('denied' in actor) return actor.denied;
		if (!onlyKeys(event.url.searchParams, ['organizationId']))
			return failure(400, 'INVALID_INPUT', 'Invalid SLA policies query.');
		const body = await readJsonObject(event.request, [
			'name',
			'description',
			'active',
			'firstResponseMinutes',
			'resolutionMinutes',
			'isDefault'
		]);
		if (!body || Object.keys(body).length === 0)
			return failure(400, 'INVALID_INPUT', 'Invalid request.');
		// 5.4W-A (H1): re-validated inside the transaction after the organization lock.
		const policy = await withActorAuthorization(
			db,
			{
				userId: actor.userId,
				organizationId: parsed.organizationId,
				permissionIds: ['sla:manage'],
				lock: 'update'
			},
			(tx) =>
				withAudit(
					tx,
					parsed.organizationId,
					actor.userId,
					() =>
						updateSlaPolicy(tx, parsed.organizationId, parsed.policyId, {
							name: body.name,
							description: body.description,
							active: body.active,
							firstResponseMinutes: body.firstResponseMinutes,
							resolutionMinutes: body.resolutionMinutes,
							isDefault: body.isDefault
						}),
					(updated) => ({
						action: 'sla_policy.updated',
						entityType: 'sla_policy',
						entityId: parsed.policyId,
						metadata: {
							fields: Object.keys(body).filter(
								(k) => (body as Record<string, unknown>)[k] !== undefined
							),
							active: updated.active,
							isDefault: updated.isDefault,
							firstResponseMinutes: updated.firstResponseMinutes,
							resolutionMinutes: updated.resolutionMinutes
						}
					})
				)
		);
		return success({ slaPolicy: toSlaPolicyDto(policy) });
	} catch (error) {
		return slaServiceFailure(error);
	}
};

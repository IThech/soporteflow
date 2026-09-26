import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getSlaPolicy, updateSlaPolicy } from '$lib/server/services/sla-policies';
import {
	failure,
	onlyKeys,
	readJsonObject,
	requireCapability,
	slaServiceFailure,
	success,
	toSlaPolicyDto,
	uuid
} from '../http';

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
		const denied = await requireCapability(
			event.request.headers,
			parsed.organizationId,
			'sla:manage'
		);
		if (denied) return denied;
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
		const policy = await updateSlaPolicy(db, parsed.organizationId, parsed.policyId, {
			name: body.name,
			description: body.description,
			active: body.active,
			firstResponseMinutes: body.firstResponseMinutes,
			resolutionMinutes: body.resolutionMinutes,
			isDefault: body.isDefault
		});
		return success({ slaPolicy: toSlaPolicyDto(policy) });
	} catch (error) {
		return slaServiceFailure(error);
	}
};

import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { createSlaPolicy, listSlaPolicies } from '$lib/server/services/sla-policies';
import {
	booleanParam,
	failure,
	onlyKeys,
	readJsonObject,
	requireCapability,
	slaServiceFailure,
	success,
	toSlaPolicyDto,
	uuid
} from './http';

/**
 * GET /api/sla-policies?organizationId=<UUID>[&active=true|false][&isDefault=true|false]
 * Requires sla:view. Ordered by code (tenant-unique). Inactive policies are included unless
 * filtered out.
 */
export const GET: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	try {
		const denied = await requireCapability(event.request.headers, organizationId, 'sla:view');
		if (denied) return denied;
		const active = booleanParam(params.get('active'));
		const isDefault = booleanParam(params.get('isDefault'));
		if (
			!onlyKeys(params, ['organizationId', 'active', 'isDefault']) ||
			active === null ||
			isDefault === null
		)
			return failure(400, 'INVALID_INPUT', 'Invalid SLA policies query.');
		const policies = await listSlaPolicies(db, organizationId, { active, isDefault });
		return success({ slaPolicies: policies.map(toSlaPolicyDto) });
	} catch (error) {
		return slaServiceFailure(error);
	}
};

/**
 * POST /api/sla-policies?organizationId=<UUID>
 * body: { code, name, description?, firstResponseMinutes, resolutionMinutes, isDefault? }
 * Requires sla:manage. New policies are always active. 201 with the DTO.
 */
export const POST: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	const organizationId = params.get('organizationId');
	if (!organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'organizationId must be a valid UUID.');
	try {
		const denied = await requireCapability(event.request.headers, organizationId, 'sla:manage');
		if (denied) return denied;
		if (!onlyKeys(params, ['organizationId']))
			return failure(400, 'INVALID_INPUT', 'Invalid SLA policies query.');
		const body = await readJsonObject(event.request, [
			'code',
			'name',
			'description',
			'firstResponseMinutes',
			'resolutionMinutes',
			'isDefault'
		]);
		if (!body) return failure(400, 'INVALID_INPUT', 'Invalid request.');
		const policy = await createSlaPolicy(db, organizationId, {
			code: body.code,
			name: body.name,
			description: body.description,
			firstResponseMinutes: body.firstResponseMinutes,
			resolutionMinutes: body.resolutionMinutes,
			isDefault: body.isDefault
		});
		return success({ slaPolicy: toSlaPolicyDto(policy) }, 201);
	} catch (error) {
		return slaServiceFailure(error);
	}
};

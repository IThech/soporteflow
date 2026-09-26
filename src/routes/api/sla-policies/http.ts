import { IncidentServiceError } from '$lib/server/services/incidents';
import type { SlaPolicyRecord } from '$lib/server/services/sla-policies';
import { failure } from '../roles/http';

export { failure, onlyKeys, readJsonObject, requireCapability, success, uuid } from '../roles/http';

/** Explicit allowlist: never organizationId or internal fields. */
export function toSlaPolicyDto(policy: SlaPolicyRecord) {
	return {
		id: policy.id,
		code: policy.code,
		name: policy.name,
		description: policy.description,
		active: policy.active,
		isDefault: policy.isDefault,
		firstResponseMinutes: policy.firstResponseMinutes,
		resolutionMinutes: policy.resolutionMinutes,
		createdAt: policy.createdAt.toISOString(),
		updatedAt: policy.updatedAt.toISOString()
	};
}

/** Stable client messages; never SQL, constraint names or stacks. */
export function slaServiceFailure(error: unknown) {
	if (error instanceof IncidentServiceError) {
		switch (error.code) {
			case 'INVALID_INPUT':
				return failure(400, 'INVALID_INPUT', 'Invalid request.');
			case 'SLA_POLICY_INVALID_TARGET':
				return failure(
					400,
					'SLA_POLICY_INVALID_TARGET',
					'SLA targets must be whole minutes (1 to 5256000) and resolution must not be shorter than first response.'
				);
			case 'SLA_POLICY_NOT_FOUND':
				return failure(404, 'SLA_POLICY_NOT_FOUND', 'SLA policy not found.');
			case 'SLA_POLICY_CODE_CONFLICT':
				return failure(409, 'SLA_POLICY_CODE_CONFLICT', 'SLA policy code is already in use.');
			case 'SLA_POLICY_INVALID_DEFAULT':
				return failure(
					409,
					'SLA_POLICY_INVALID_DEFAULT',
					'Only an active SLA policy can be the default.'
				);
			case 'ORGANIZATION_NOT_FOUND':
			case 'ORGANIZATION_NOT_OPERATIONAL':
				return failure(403, 'FORBIDDEN', 'Permission denied.');
		}
	}
	return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
}

/** Strict boolean query flag: exactly "true" or "false". */
export function booleanParam(value: string | null): boolean | undefined | null {
	if (value === null) return undefined;
	if (value === 'true') return true;
	if (value === 'false') return false;
	return null;
}

import type { Incident } from '$lib/types/incident';
import { supportLevels } from '$lib/types/support';

function isValidSlaSnapshot(sla: unknown): boolean {
	if (sla === undefined || sla === null) return true;
	if (typeof sla !== 'object' || Array.isArray(sla)) return false;
	const s = sla as Record<string, unknown>;
	return (
		typeof s.policyId === 'string' &&
		!!s.policyId.trim() &&
		typeof s.policyName === 'string' &&
		!!s.policyName.trim() &&
		typeof s.firstResponseMinutes === 'number' &&
		Number.isSafeInteger(s.firstResponseMinutes) &&
		s.firstResponseMinutes > 0 &&
		typeof s.resolutionMinutes === 'number' &&
		Number.isSafeInteger(s.resolutionMinutes) &&
		s.resolutionMinutes > 0 &&
		typeof s.firstResponseDueAt === 'string' &&
		Number.isFinite(Date.parse(s.firstResponseDueAt)) &&
		typeof s.resolutionDueAt === 'string' &&
		Number.isFinite(Date.parse(s.resolutionDueAt)) &&
		(s.firstRespondedAt === null ||
			(typeof s.firstRespondedAt === 'string' &&
				Number.isFinite(Date.parse(s.firstRespondedAt)))) &&
		(s.resolvedAt === null ||
			(typeof s.resolvedAt === 'string' && Number.isFinite(Date.parse(s.resolvedAt))))
	);
}

function isValidOptionalTimestamp(val: unknown): boolean {
	if (val === undefined || val === null) return true;
	return typeof val === 'string' && Number.isFinite(Date.parse(val));
}

function isValidClosureType(val: unknown): boolean {
	if (val === undefined || val === null) return true;
	return val === 'client_confirmed' || val === 'auto_closed';
}

export function isIncidentList(parsed: unknown): parsed is Incident[] {
	return !(
		!Array.isArray(parsed) ||
		!parsed.every(
			(item) =>
				item &&
				typeof item === 'object' &&
				Number.isSafeInteger(item.id) &&
				(item.assignedToUserId == null || typeof item.assignedToUserId === 'string') &&
				['title', 'client', 'createdAt'].every((key) => typeof item[key] === 'string') &&
				['open', 'pending', 'resolved', 'closed'].includes(item.status) &&
				['low', 'medium', 'high'].includes(item.priority) &&
				(item.supportLevel === undefined || supportLevels.includes(item.supportLevel)) &&
				[
					'organizationId',
					'clientUserId',
					'createdByUserId',
					'teamId',
					'description',
					'solution',
					'categoryId',
					'updatedAt'
				].every((key) => item[key] === undefined || typeof item[key] === 'string') &&
				isValidOptionalTimestamp(item.resolvedAt) &&
				isValidOptionalTimestamp(item.closedAt) &&
				isValidClosureType(item.closureType) &&
				isValidSlaSnapshot(item.sla)
		) ||
		new Set(parsed.map((item) => item.id)).size !== parsed.length
	);
}

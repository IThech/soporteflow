import type { Incident } from '$lib/types/incident';
import type { ClassificationSnapshot } from '$lib/types/classification';
import { toIncidentPriority } from '$lib/classification/engine';

const VALID_BASE_CRITICALITIES = ['low', 'medium', 'high'];
const VALID_IMPACT_LEVELS = ['I1', 'I2', 'I3', 'I4'];
const VALID_CALCULATED_PRIORITIES = ['low', 'medium', 'high', 'critical'];

export function isValidClassificationSnapshot(
	snapshot: unknown
): snapshot is ClassificationSnapshot | null | undefined {
	if (snapshot === undefined || snapshot === null) return true;
	if (typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
	const s = snapshot as Record<string, unknown>;

	if (
		typeof s.baseCriticality !== 'string' ||
		!VALID_BASE_CRITICALITIES.includes(s.baseCriticality)
	) {
		return false;
	}

	if (typeof s.impactLevel !== 'string' || !VALID_IMPACT_LEVELS.includes(s.impactLevel)) {
		return false;
	}

	if (
		typeof s.matrixPriority !== 'string' ||
		!VALID_CALCULATED_PRIORITIES.includes(s.matrixPriority)
	) {
		return false;
	}

	if (
		s.minPriority !== null &&
		(typeof s.minPriority !== 'string' || !VALID_CALCULATED_PRIORITIES.includes(s.minPriority))
	) {
		return false;
	}

	if (typeof s.minPriorityApplied !== 'boolean') {
		return false;
	}

	if (s.minPriorityApplied && s.minPriority === null) {
		return false;
	}

	if (
		typeof s.calculatedPriority !== 'string' ||
		!VALID_CALCULATED_PRIORITIES.includes(s.calculatedPriority)
	) {
		return false;
	}

	if (
		typeof s.effectivePriority !== 'string' ||
		!VALID_CALCULATED_PRIORITIES.includes(s.effectivePriority)
	) {
		return false;
	}

	if (typeof s.hasOverride !== 'boolean') {
		return false;
	}

	if (!s.hasOverride) {
		if (s.effectivePriority !== s.calculatedPriority) {
			return false;
		}
		if (s.overrideReason !== undefined && typeof s.overrideReason !== 'string') {
			return false;
		}
		if (s.overrideAuthorizedBy !== undefined && typeof s.overrideAuthorizedBy !== 'string') {
			return false;
		}
	} else {
		if (typeof s.overrideReason !== 'string' || !s.overrideReason.trim()) {
			return false;
		}
		if (s.overrideAuthorizedBy !== undefined && typeof s.overrideAuthorizedBy !== 'string') {
			return false;
		}
	}

	return true;
}

export function isCoherentClassificationPriority(
	priority: unknown,
	classification: unknown
): boolean {
	if (classification === undefined || classification === null) {
		return true;
	}
	if (!isValidClassificationSnapshot(classification)) {
		return false;
	}
	return priority === toIncidentPriority(classification.effectivePriority);
}

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
				(item.siteId === undefined ||
					item.siteId === null ||
					(typeof item.siteId === 'string' && item.siteId.trim().length > 0)) &&
				(item.subcategoryId === undefined ||
					item.subcategoryId === null ||
					(typeof item.subcategoryId === 'string' && item.subcategoryId.trim().length > 0)) &&
				['title', 'client', 'createdAt'].every((key) => typeof item[key] === 'string') &&
				['open', 'pending', 'resolved', 'closed'].includes(item.status) &&
				['low', 'medium', 'high', 'urgent'].includes(item.priority) &&
				(item.supportLevel === undefined ||
					(typeof item.supportLevel === 'string' && item.supportLevel.trim().length > 0)) &&
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
				isValidSlaSnapshot(item.sla) &&
				isValidClassificationSnapshot(item.classification) &&
				isCoherentClassificationPriority(item.priority, item.classification)
		) ||
		new Set(parsed.map((item) => item.id)).size !== parsed.length
	);
}

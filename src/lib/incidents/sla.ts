import { incidentOrganizationId } from './assignment';
import type { Incident } from '$lib/types/incident';
import type {
	SlaPolicy,
	IncidentSlaSnapshot,
	IncidentSlaEvaluation,
	SlaTargetEvaluation,
	SlaTargetStage,
	SlaEvaluationOptions
} from '$lib/types/sla';

/**
 * Calculates a future deadline timestamp in ISO 8601 UTC format.
 * Accurately handles both date-only ('YYYY-MM-DD') and full ISO strings.
 */
export function calculateSlaDeadline(baseTimestamp: string, minutes: number): string {
	const parsed = Date.parse(baseTimestamp);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Fecha base inválida para el cálculo de SLA: "${baseTimestamp}".`);
	}
	return new Date(parsed + minutes * 60_000).toISOString();
}

/**
 * Checks whether an organization has more than one active default policy.
 * Under normal functional rules, an organization must have at most one active default.
 */
export function hasMultipleActiveDefaults(policies: SlaPolicy[], organizationId: string): boolean {
	const activeDefaults = policies.filter(
		(policy) => policy.active && policy.isDefault && policy.organizationId === organizationId
	);
	return activeDefaults.length > 1;
}

/**
 * Deterministic policy selection engine based on strict precedence:
 *   1. category + priority (isDefault === false)
 *   2. category (isDefault === false)
 *   3. priority (isDefault === false)
 *   4. default fallback (isDefault === true)
 *
 * If multiple policies match at the same level (e.g. data anomaly with multiple defaults),
 * it applies a defensive deterministic tie-breaker: oldest createdAt, then alphabetical ID.
 */
export function matchSlaPolicy(incident: Incident, policies: SlaPolicy[]): SlaPolicy | null {
	const orgId = incidentOrganizationId(incident);
	const activePolicies = policies.filter(
		(policy) => policy.active && policy.organizationId === orgId
	);

	const sortDeterministic = (candidates: SlaPolicy[]): SlaPolicy[] =>
		[...candidates].sort(
			(a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)
		);

	// Level 1: Category + Priority (only non-default policies)
	if (incident.categoryId && incident.priority) {
		const level1 = activePolicies.filter(
			(policy) =>
				!policy.isDefault &&
				policy.categoryId === incident.categoryId &&
				policy.priority === incident.priority
		);
		if (level1.length > 0) return sortDeterministic(level1)[0];
	}

	// Level 2: Category only (only non-default policies)
	if (incident.categoryId) {
		const level2 = activePolicies.filter(
			(policy) =>
				!policy.isDefault &&
				policy.categoryId === incident.categoryId &&
				(policy.priority === undefined || policy.priority === null)
		);
		if (level2.length > 0) return sortDeterministic(level2)[0];
	}

	// Level 3: Priority only (only non-default policies)
	if (incident.priority) {
		const level3 = activePolicies.filter(
			(policy) =>
				!policy.isDefault &&
				policy.priority === incident.priority &&
				(policy.categoryId === undefined || policy.categoryId === null)
		);
		if (level3.length > 0) return sortDeterministic(level3)[0];
	}

	// Level 4: Default Fallback
	const level4 = activePolicies.filter((policy) => policy.isDefault);
	if (level4.length > 0) {
		// Note: More than one active default is an invalid data condition, handled defensively here.

		return sortDeterministic(level4)[0];
	}

	return null;
}

/**
 * Generates an immutable SLA snapshot for an incident from the chosen policy.
 * Initializes firstRespondedAt and resolvedAt as null until real events occur.
 */
export function createSlaSnapshot(incident: Incident, policy: SlaPolicy): IncidentSlaSnapshot {
	return {
		policyId: policy.id,
		policyName: policy.name,
		firstResponseMinutes: policy.firstResponseMinutes,
		resolutionMinutes: policy.resolutionMinutes,
		firstResponseDueAt: calculateSlaDeadline(incident.createdAt, policy.firstResponseMinutes),
		resolutionDueAt: calculateSlaDeadline(incident.createdAt, policy.resolutionMinutes),
		firstRespondedAt: null,
		resolvedAt: null
	};
}

function evaluateTarget(
	dueAt: string,
	completedAt: string | null | undefined,
	nowMs: number,
	warningThresholdMinutes: number,
	isResolvedWithoutTimestamp = false
): SlaTargetEvaluation {
	// If completed with a recorded timestamp
	if (completedAt) {
		const completedMs = Date.parse(completedAt);
		const dueMs = Date.parse(dueAt);
		const withinSla =
			Number.isFinite(completedMs) && Number.isFinite(dueMs) && completedMs <= dueMs;
		return {
			stage: withinSla ? 'fulfilled_within_sla' : 'fulfilled_breached',
			dueAt,
			completedAt,
			remainingMinutes: null
		};
	}

	// If resolved but without a known resolvedAt timestamp, timing cannot be evaluated.
	// Rule: never infer or invent resolution timing from updatedAt.
	if (isResolvedWithoutTimestamp) {
		return {
			stage: 'fulfilled_unknown',
			dueAt,
			completedAt: null,
			remainingMinutes: null
		};
	}

	// Target is pending: calculate real-time status against 'now'
	const dueMs = Date.parse(dueAt);
	if (!Number.isFinite(dueMs)) {
		return {
			stage: 'breached',
			dueAt,
			completedAt: null,
			remainingMinutes: null
		};
	}

	const diffMs = dueMs - nowMs;
	const remainingMinutes = Math.round(diffMs / 60_000);

	let stage: SlaTargetStage;
	if (diffMs < 0) {
		stage = 'breached';
	} else if (remainingMinutes <= warningThresholdMinutes) {
		stage = 'approaching';
	} else {
		stage = 'on_track';
	}

	return {
		stage,
		dueAt,
		completedAt: null,
		remainingMinutes
	};
}

const isFulfilledStage = (stage: SlaTargetStage): boolean =>
	stage === 'fulfilled_within_sla' ||
	stage === 'fulfilled_breached' ||
	stage === 'fulfilled_unknown';

/**
 * Dynamically evaluates an incident's real-time SLA status.
 * Never relies on hardcoded Date.now() internally; accepts an optional deterministic `now`.
 */
export function evaluateIncidentSla(
	incident: Incident,
	now: Date | string | number = new Date(),
	options?: SlaEvaluationOptions
): IncidentSlaEvaluation {
	const snapshot = incident.sla;
	if (!snapshot) {
		const emptyTarget: SlaTargetEvaluation = {
			stage: 'on_track',
			dueAt: '',
			completedAt: null,
			remainingMinutes: null
		};
		return {
			status: 'no_sla',
			firstResponse: emptyTarget,
			resolution: emptyTarget
		};
	}

	const nowMs =
		typeof now === 'number' ? now : typeof now === 'string' ? Date.parse(now) : now.getTime();

	const warningMinutes = options?.warningThresholdMinutes ?? 15;
	const isResolvedWithoutTimestamp = incident.status === 'resolved' && !snapshot.resolvedAt;

	const firstResponse = evaluateTarget(
		snapshot.firstResponseDueAt,
		snapshot.firstRespondedAt,
		nowMs,
		warningMinutes
	);

	// Resolution is only completed if incident is currently resolved.
	// If reopened (status !== 'resolved'), historical resolvedAt is ignored during active evaluation
	// and resolution is evaluated as pending against nowMs and resolutionDueAt.
	const resolutionCompletedAt = incident.status === 'resolved' ? snapshot.resolvedAt : null;

	const resolution = evaluateTarget(
		snapshot.resolutionDueAt,
		resolutionCompletedAt,
		nowMs,
		warningMinutes,
		isResolvedWithoutTimestamp
	);

	let status: IncidentSlaEvaluation['status'];
	if (isFulfilledStage(firstResponse.stage) && isFulfilledStage(resolution.stage)) {
		status = 'fulfilled';
	} else if (firstResponse.stage === 'breached' || resolution.stage === 'breached') {
		status = 'breached';
	} else if (firstResponse.stage === 'approaching' || resolution.stage === 'approaching') {
		status = 'approaching';
	} else {
		status = 'on_track';
	}

	return {
		status,
		firstResponse,
		resolution
	};
}

/**
 * Type guard for validating lists of SLA policies loaded from storage or fixtures.
 */
export function isSlaPolicyList(value: unknown): value is SlaPolicy[] {
	if (!Array.isArray(value)) return false;
	const ids = new Set<string>();

	return value.every((item) => {
		if (
			!item ||
			typeof item !== 'object' ||
			Array.isArray(item) ||
			typeof item.id !== 'string' ||
			!item.id.trim() ||
			ids.has(item.id) ||
			typeof item.organizationId !== 'string' ||
			!item.organizationId.trim() ||
			typeof item.name !== 'string' ||
			!item.name.trim() ||
			typeof item.active !== 'boolean' ||
			typeof item.isDefault !== 'boolean' ||
			typeof item.firstResponseMinutes !== 'number' ||
			!Number.isSafeInteger(item.firstResponseMinutes) ||
			item.firstResponseMinutes <= 0 ||
			typeof item.resolutionMinutes !== 'number' ||
			!Number.isSafeInteger(item.resolutionMinutes) ||
			item.resolutionMinutes <= 0 ||
			typeof item.createdAt !== 'string' ||
			!Number.isFinite(Date.parse(item.createdAt))
		) {
			return false;
		}

		if (item.description !== undefined && typeof item.description !== 'string') return false;
		if (
			item.categoryId !== undefined &&
			item.categoryId !== null &&
			typeof item.categoryId !== 'string'
		) {
			return false;
		}
		if (
			item.priority !== undefined &&
			item.priority !== null &&
			!['low', 'medium', 'high'].includes(item.priority)
		) {
			return false;
		}
		if (
			item.updatedAt !== undefined &&
			(typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt)))
		) {
			return false;
		}

		// Default policies are exclusively fallback and must not define categoryId or priority with non-null values
		if (item.isDefault) {
			if (item.categoryId !== undefined && item.categoryId !== null) return false;
			if (item.priority !== undefined && item.priority !== null) return false;
		} else {
			// Non-default (specific) policies must define at least categoryId or priority
			const hasCategory =
				item.categoryId !== undefined && item.categoryId !== null && item.categoryId.trim() !== '';
			const hasPriority = item.priority !== undefined && item.priority !== null;
			if (!hasCategory && !hasPriority) return false;
		}

		ids.add(item.id);
		return true;
	});
}

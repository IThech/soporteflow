import type { IncidentPriority } from './incident';

export interface SlaPolicy {
	/** Unique identifier (e.g. UUID or slug) */
	id: string;
	/** Owning organization for multi-tenant isolation */
	organizationId: string;
	/** Human-readable policy name */
	name: string;
	/** Optional policy description */
	description?: string;
	/** If false, engine ignores this policy */
	active: boolean;
	/** If true, acts as the organization's fallback policy (at most one active default per organization) */
	isDefault: boolean;
	/** Optional category match criterion */
	categoryId?: string | null;
	/** Optional priority match criterion */
	priority?: IncidentPriority | null;
	/** Maximum first response time in elapsed natural minutes */
	firstResponseMinutes: number;
	/** Maximum resolution time in elapsed natural minutes */
	resolutionMinutes: number;
	/** ISO 8601 UTC creation date */
	createdAt: string;
	/** ISO 8601 UTC last update date */
	updatedAt?: string;
}

/**
 * Immutable commitment snapshot captured when an SLA is applied to an incident.
 * Preserved across policy updates in the catalog, reassignments, and escalations.
 */
export interface IncidentSlaSnapshot {
	/** ID of the policy applied at snapshot time */
	policyId: string;
	/** Name of the policy at snapshot time */
	policyName: string;
	/** Committed first response threshold in natural minutes */
	firstResponseMinutes: number;
	/** Committed resolution threshold in natural minutes */
	resolutionMinutes: number;
	/** Calculated deadline for first response: ISO 8601 UTC */
	firstResponseDueAt: string;
	/** Calculated deadline for resolution: ISO 8601 UTC */
	resolutionDueAt: string;
	/** Timestamp when first public response was sent by staff; null if pending */
	firstRespondedAt: string | null;
	/** Timestamp when incident was resolved; null if open or pending */
	resolvedAt: string | null;
}

export type SlaTargetStage =
	| 'on_track' // Pendiente y fuera del umbral de aviso (en plazo)
	| 'approaching' // Pendiente y dentro del umbral de aviso (próximo a vencer)
	| 'breached' // Vencido sin cumplir
	| 'fulfilled_within_sla' // Fulfilled before or at deadline
	| 'fulfilled_breached' // Fulfilled after deadline passed
	| 'fulfilled_unknown'; // Incident resolved, but resolution timestamp unknown

export type IncidentSlaOverallStatus =
	| 'no_sla' // Incident has no SLA applied
	| 'on_track' // All active targets are on track
	| 'approaching' // At least one active target is approaching breach
	| 'breached' // At least one target has been breached
	| 'fulfilled'; // All targets have been fulfilled

export interface SlaTargetEvaluation {
	stage: SlaTargetStage;
	dueAt: string;
	completedAt: string | null;
	remainingMinutes: number | null;
}

export interface IncidentSlaEvaluation {
	status: IncidentSlaOverallStatus;
	firstResponse: SlaTargetEvaluation;
	resolution: SlaTargetEvaluation;
}

export interface SlaEvaluationOptions {
	/**
	 * Umbral de advertencia en minutos antes de la fecha límite para considerar el objetivo 'approaching'.
	 * En SLA v1 el valor por defecto es de 15 minutos.
	 */
	warningThresholdMinutes?: number;
}

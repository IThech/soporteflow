import type { Incident } from './incident';

export type AttentionReasonType =
	| 'sla_breached'
	| 'sla_approaching'
	| 'reopened'
	| 'client_responded'
	| 'incompatible_level'
	| 'high_priority';

export interface AttentionReason {
	type: AttentionReasonType;
	label: string;
	priorityRank: number; // 1 (highest: human interactions) to 5 (lowest: high priority)
	detail?: string;
	eventTimestamp?: number;
	timeAgo?: string;
}

export interface AttentionIncidentItem {
	incident: Incident;
	reasons: AttentionReason[];
	primaryReason: AttentionReason;
}

export interface TechnicianDashboardSummary {
	myActiveCount: number;
	attentionCount: number;
	slaApproachingCount: number;
	availableToAssumeCount: number;
}

export interface CategoryDistribution {
	categoryId: string;
	categoryName: string;
	count: number;
	percentage: number;
}

export interface LevelDistribution {
	levelCode: string;
	levelName: string;
	count: number;
	percentage: number;
}

export interface TechnicianActivityMetrics {
	periodDays: number;
	resolvedCount: number;
	withinSlaCount: number;
	withinSlaPercentage: number;
	reopenedCount: number;
	reopenedPercentage: number;
	categories: CategoryDistribution[];
	levels: LevelDistribution[];
}

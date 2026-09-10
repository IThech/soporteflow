import type { IncidentSlaEvaluation, SlaTargetEvaluation, SlaTargetStage } from '$lib/types/sla';

export type VisualSlaStatus =
	'no_sla' | 'on_track' | 'approaching' | 'breached' | 'fulfilled' | 'unknown';

export interface SlaBadgeConfig {
	label: string;
	fullLabel: string;
	dotClass: string;
	badgeClass: string;
	ariaLabel: string;
}

/**
 * Formats a duration in minutes into a human-readable string.
 * Supports values less than 1 hour, between 1 and 24 hours, and multiple days.
 */
export function formatSlaDuration(minutes: number): string {
	const absoluteMinutes = Math.abs(Math.round(minutes));
	if (absoluteMinutes < 60) {
		return `${absoluteMinutes} min`;
	}
	if (absoluteMinutes < 1440) {
		const hours = Math.floor(absoluteMinutes / 60);
		const remainingMins = absoluteMinutes % 60;
		return remainingMins === 0 ? `${hours} h` : `${hours} h ${remainingMins} min`;
	}
	const days = Math.floor(absoluteMinutes / 1440);
	const remainingMins = absoluteMinutes % 1440;
	const remainingHours = Math.floor(remainingMins / 60);
	return remainingHours === 0 ? `${days} d` : `${days} d ${remainingHours} h`;
}

/**
 * Formats remaining or exceeded time relative to a deadline.
 */
export function formatSlaRemaining(remainingMinutes: number | null): string {
	if (remainingMinutes === null) {
		return '';
	}
	if (remainingMinutes >= 0) {
		return `${formatSlaDuration(remainingMinutes)} restantes`;
	}
	return `Vencido hace ${formatSlaDuration(remainingMinutes)}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat('es-ES', {
	day: 'numeric',
	month: 'short',
	year: 'numeric',
	hour: '2-digit',
	minute: '2-digit'
});

/**
 * Formats an ISO 8601 timestamp for user presentation.
 */
export function formatSlaDateTime(isoString: string | null | undefined): string {
	if (!isoString) return '';
	const parsed = Date.parse(isoString);
	if (!Number.isFinite(parsed)) return '';
	return dateTimeFormatter.format(new Date(parsed));
}

/**
 * Derives the strict visual status for an incident from its evaluation.
 * GUARANTEE: Finalized does not automatically mean fulfilled within SLA.
 * Any breached target marks the incident as breached, even if completed.
 * If unknown targets exist without breach, it evaluates to 'unknown' (never falsely 'fulfilled').
 */
export function getIncidentVisualSlaStatus(evaluation: IncidentSlaEvaluation): VisualSlaStatus {
	if (evaluation.status === 'no_sla') {
		return 'no_sla';
	}

	const isBreached = (target: SlaTargetEvaluation) =>
		target.stage === 'breached' || target.stage === 'fulfilled_breached';

	if (isBreached(evaluation.firstResponse) || isBreached(evaluation.resolution)) {
		return 'breached';
	}

	const isUnknown = (target: SlaTargetEvaluation) => target.stage === 'fulfilled_unknown';

	if (isUnknown(evaluation.firstResponse) || isUnknown(evaluation.resolution)) {
		return 'unknown';
	}

	if (
		evaluation.firstResponse.stage === 'fulfilled_within_sla' &&
		evaluation.resolution.stage === 'fulfilled_within_sla'
	) {
		return 'fulfilled';
	}

	if (
		evaluation.firstResponse.stage === 'approaching' ||
		evaluation.resolution.stage === 'approaching'
	) {
		return 'approaching';
	}

	return 'on_track';
}

/**
 * Returns visual presentation properties (labels, colors, accessibility) for an incident's SLA status.
 */
export function getSlaBadgeConfig(status: VisualSlaStatus, compact = true): SlaBadgeConfig {
	switch (status) {
		case 'on_track':
			return {
				label: 'En plazo',
				fullLabel: 'En plazo',
				dotClass: 'bg-emerald-400',
				badgeClass: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
				ariaLabel: 'SLA en plazo'
			};
		case 'approaching':
			return {
				label: compact ? 'Próximo' : 'Próximo a vencer',
				fullLabel: 'Próximo a vencer',
				dotClass: 'bg-amber-400',
				badgeClass: 'border-amber-500/30 bg-amber-500/15 text-amber-400',
				ariaLabel: 'SLA próximo a vencer'
			};
		case 'breached':
			return {
				label: 'Incumplido',
				fullLabel: 'Incumplido',
				dotClass: 'bg-red-400',
				badgeClass: 'border-red-500/30 bg-red-500/15 text-red-400',
				ariaLabel: 'SLA incumplido'
			};
		case 'fulfilled':
			return {
				label: 'Cumplido',
				fullLabel: 'Cumplido',
				dotClass: 'bg-emerald-400',
				badgeClass: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
				ariaLabel: 'SLA cumplido'
			};
		case 'unknown':
			return {
				label: compact ? 'Sin registro' : 'Sin registro fiable',
				fullLabel: 'Sin registro fiable',
				dotClass: 'bg-slate-400',
				badgeClass: 'border-slate-600 bg-slate-800/60 text-slate-300',
				ariaLabel: 'SLA con cumplimiento no evaluable'
			};
		case 'no_sla':
		default:
			return {
				label: 'Sin SLA',
				fullLabel: 'Sin SLA',
				dotClass: 'bg-slate-500',
				badgeClass: 'border-slate-700 bg-slate-900/50 text-slate-500',
				ariaLabel: 'Sin SLA asignado'
			};
	}
}

/**
 * Returns badge properties for an individual target (first response or resolution).
 */
export function getTargetBadgeConfig(stage: SlaTargetStage): {
	label: string;
	badgeClass: string;
	dotClass: string;
} {
	switch (stage) {
		case 'fulfilled_within_sla':
			return {
				label: 'Cumplido',
				badgeClass: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
				dotClass: 'bg-emerald-400'
			};
		case 'fulfilled_breached':
			return {
				label: 'Incumplido',
				badgeClass: 'border-red-500/30 bg-red-500/15 text-red-400',
				dotClass: 'bg-red-400'
			};
		case 'fulfilled_unknown':
			return {
				label: 'Sin registro',
				badgeClass: 'border-slate-600 bg-slate-800/60 text-slate-300',
				dotClass: 'bg-slate-400'
			};
		case 'breached':
			return {
				label: 'Incumplido',
				badgeClass: 'border-red-500/30 bg-red-500/15 text-red-400',
				dotClass: 'bg-red-400'
			};
		case 'approaching':
			return {
				label: 'Próximo a vencer',
				badgeClass: 'border-amber-500/30 bg-amber-500/15 text-amber-400',
				dotClass: 'bg-amber-400'
			};
		case 'on_track':
		default:
			return {
				label: 'En plazo',
				badgeClass: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
				dotClass: 'bg-emerald-400'
			};
	}
}

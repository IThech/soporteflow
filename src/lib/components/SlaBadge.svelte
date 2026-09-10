<script lang="ts">
	import type { Incident } from '$lib/types/incident';
	import { evaluateIncidentSla } from '$lib/incidents/sla';
	import {
		getIncidentVisualSlaStatus,
		getSlaBadgeConfig,
		formatSlaRemaining
	} from '$lib/incidents/sla-presentation';

	let {
		incident,
		now = new Date(),
		compact = true
	}: {
		incident: Incident;
		now?: Date | string | number;
		compact?: boolean;
	} = $props();

	const evaluation = $derived(evaluateIncidentSla(incident, now));
	const visualStatus = $derived(getIncidentVisualSlaStatus(evaluation));
	const config = $derived(getSlaBadgeConfig(visualStatus, compact));

	const tooltip = $derived.by(() => {
		if (visualStatus === 'no_sla') return 'Sin compromiso SLA';
		if (visualStatus === 'fulfilled') return 'SLA cumplido dentro de plazo';
		if (visualStatus === 'unknown') return 'Resuelta sin hora de resolución registrada';

		const activeTarget =
			evaluation.firstResponse.completedAt === null
				? evaluation.firstResponse
				: evaluation.resolution;
		const remaining = formatSlaRemaining(activeTarget.remainingMinutes);
		return `${config.fullLabel}${remaining ? ` · ${remaining}` : ''}`;
	});
</script>

{#if visualStatus === 'no_sla'}
	<span class="text-xs text-slate-500" aria-label="Sin SLA">—</span>
{:else}
	<span
		class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium {config.badgeClass}"
		aria-label={config.ariaLabel}
		title={tooltip}
	>
		<span class="h-1.5 w-1.5 rounded-full {config.dotClass}" aria-hidden="true"></span>
		<span>{config.label}</span>
	</span>
{/if}

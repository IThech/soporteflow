<script lang="ts">
	import type { Incident } from '$lib/types/incident';
	import { evaluateIncidentSla } from '$lib/incidents/sla';
	import {
		getIncidentVisualSlaStatus,
		getSlaBadgeConfig,
		getTargetBadgeConfig,
		formatSlaRemaining,
		formatSlaDateTime
	} from '$lib/incidents/sla-presentation';

	let {
		incident,
		now = new Date()
	}: {
		incident: Incident;
		now?: Date | string | number;
	} = $props();

	const evaluation = $derived(evaluateIncidentSla(incident, now));
	const visualStatus = $derived(getIncidentVisualSlaStatus(evaluation));
	const overallConfig = $derived(getSlaBadgeConfig(visualStatus, false));

	const firstResponseBadge = $derived(getTargetBadgeConfig(evaluation.firstResponse.stage));
	const resolutionBadge = $derived(getTargetBadgeConfig(evaluation.resolution.stage));
</script>

{#if !incident.sla}
	<section
		aria-labelledby="incident-sla-title"
		class="incident-sla rounded-xl border border-slate-700/60 bg-slate-900/40 p-4"
	>
		<h3 id="incident-sla-title" class="text-base font-semibold text-slate-300">SLA</h3>
		<p class="mt-2 text-xs text-slate-400">Esta incidencia no tiene una política SLA asignada.</p>
	</section>
{:else}
	{@const snapshot = incident.sla}
	<section
		aria-labelledby="incident-sla-title"
		class="incident-sla rounded-xl border border-slate-700 p-4 text-sm"
	>
		<div class="flex items-center justify-between gap-2 border-b border-slate-800 pb-3">
			<div>
				<h3 id="incident-sla-title" class="text-base font-semibold text-white">SLA</h3>
				<p class="mt-0.5 text-xs font-medium text-cyan-400">{snapshot.policyName}</p>
			</div>
			<span
				class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium {overallConfig.badgeClass}"
				aria-label={overallConfig.ariaLabel}
			>
				<span class="h-1.5 w-1.5 rounded-full {overallConfig.dotClass}" aria-hidden="true"></span>
				<span>{overallConfig.fullLabel}</span>
			</span>
		</div>

		<div class="mt-3.5 space-y-3">
			<!-- Primera Respuesta -->
			<div class="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
				<div class="flex items-center justify-between gap-2">
					<span class="text-xs font-medium text-slate-300">Primera respuesta</span>
					<span
						class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium {firstResponseBadge.badgeClass}"
					>
						<span class="h-1 w-1 rounded-full {firstResponseBadge.dotClass}" aria-hidden="true"
						></span>
						<span>{firstResponseBadge.label}</span>
					</span>
				</div>
				<div class="mt-2 space-y-1 text-xs text-slate-400">
					<p>
						<span class="text-slate-400">Límite:</span>
						<time datetime={snapshot.firstResponseDueAt} class="font-medium text-slate-300">
							{formatSlaDateTime(snapshot.firstResponseDueAt)}
						</time>
					</p>
					{#if evaluation.firstResponse.completedAt}
						<p>
							<span class="text-slate-400">Respondido:</span>
							<time
								datetime={evaluation.firstResponse.completedAt}
								class="font-medium text-slate-300"
							>
								{formatSlaDateTime(evaluation.firstResponse.completedAt)}
							</time>
							<span
								class="ml-1 text-[11px] {evaluation.firstResponse.stage === 'fulfilled_within_sla'
									? 'text-emerald-400'
									: 'text-red-400'}"
							>
								{evaluation.firstResponse.stage === 'fulfilled_within_sla'
									? '(dentro de plazo)'
									: '(fuera de plazo)'}
							</span>
						</p>
					{:else}
						<p
							class="font-medium {evaluation.firstResponse.stage === 'breached'
								? 'text-red-400'
								: evaluation.firstResponse.stage === 'approaching'
									? 'text-amber-400'
									: 'text-slate-300'}"
						>
							{formatSlaRemaining(evaluation.firstResponse.remainingMinutes)}
						</p>
					{/if}
				</div>
			</div>

			<!-- Resolución -->
			<div class="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
				<div class="flex items-center justify-between gap-2">
					<span class="text-xs font-medium text-slate-300">Resolución</span>
					<span
						class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium {resolutionBadge.badgeClass}"
					>
						<span class="h-1 w-1 rounded-full {resolutionBadge.dotClass}" aria-hidden="true"></span>
						<span>{resolutionBadge.label}</span>
					</span>
				</div>
				<div class="mt-2 space-y-1 text-xs text-slate-400">
					<p>
						<span class="text-slate-400">Límite:</span>
						<time datetime={snapshot.resolutionDueAt} class="font-medium text-slate-300">
							{formatSlaDateTime(snapshot.resolutionDueAt)}
						</time>
					</p>
					{#if evaluation.resolution.stage === 'fulfilled_unknown'}
						<p class="text-slate-400 italic">Resuelta · sin hora de resolución registrada</p>
					{:else if evaluation.resolution.completedAt}
						<p>
							<span class="text-slate-400">Resuelto:</span>
							<time datetime={evaluation.resolution.completedAt} class="font-medium text-slate-300">
								{formatSlaDateTime(evaluation.resolution.completedAt)}
							</time>
							<span
								class="ml-1 text-[11px] {evaluation.resolution.stage === 'fulfilled_within_sla'
									? 'text-emerald-400'
									: 'text-red-400'}"
							>
								{evaluation.resolution.stage === 'fulfilled_within_sla'
									? '(dentro de plazo)'
									: '(fuera de plazo)'}
							</span>
						</p>
					{:else}
						<p
							class="font-medium {evaluation.resolution.stage === 'breached'
								? 'text-red-400'
								: evaluation.resolution.stage === 'approaching'
									? 'text-amber-400'
									: 'text-slate-300'}"
						>
							{formatSlaRemaining(evaluation.resolution.remainingMinutes)}
						</p>
					{/if}
				</div>
			</div>
		</div>
	</section>
{/if}

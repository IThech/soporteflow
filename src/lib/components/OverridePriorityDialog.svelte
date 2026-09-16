<script lang="ts">
	import type { Incident, IncidentPriority } from '$lib/types/incident';
	import { toIncidentPriority } from '$lib/classification/engine';

	let {
		incident,
		error = '',
		onapply,
		onremove,
		oncancel
	}: {
		incident: Incident;
		error?: string;
		onapply: (input: { targetPriority: IncidentPriority; reason: string }) => void;
		onremove?: (input: { reason: string }) => void;
		oncancel: () => void;
	} = $props();

	let isRemoveMode = $state(false);
	let targetPriority = $state<IncidentPriority>('urgent');
	let reason = $state('');

	const hasActiveOverride = $derived(incident.classification?.hasOverride === true);

	const calculatedPriority = $derived<IncidentPriority>(
		incident.classification
			? toIncidentPriority(incident.classification.calculatedPriority)
			: incident.priority
	);

	const currentEffectivePriority = $derived<IncidentPriority>(incident.priority);

	const priorityLabels: Record<IncidentPriority, string> = {
		urgent: 'Urgente',
		high: 'Alta',
		medium: 'Media',
		low: 'Baja'
	};

	const priorityBadgeClasses: Record<IncidentPriority, string> = {
		urgent: 'border-purple-500/40 bg-purple-950/50 text-purple-300',
		high: 'border-red-500/40 bg-red-950/50 text-red-300',
		medium: 'border-yellow-500/40 bg-yellow-950/50 text-yellow-300',
		low: 'border-emerald-500/40 bg-emerald-950/50 text-emerald-300'
	};

	const isTargetDifferent = $derived(
		isRemoveMode ||
			(hasActiveOverride
				? targetPriority !== currentEffectivePriority
				: targetPriority !== calculatedPriority)
	);

	const isSubmittable = $derived(
		isTargetDifferent && reason.trim().length > 0 && (!isRemoveMode || hasActiveOverride)
	);

	function show(dialog: HTMLDialogElement) {
		isRemoveMode = false;
		targetPriority = incident.priority === 'urgent' ? 'high' : 'urgent';
		reason = '';
		dialog.showModal();
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!isSubmittable) return;

		if (isRemoveMode) {
			onremove?.({ reason: reason.trim() });
		} else {
			onapply({ targetPriority, reason: reason.trim() });
		}
	}
</script>

<dialog
	{@attach show}
	class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
	aria-labelledby="override-dialog-title"
>
	<form onsubmit={submit} class="space-y-4">
		<div class="flex items-center justify-between border-b border-slate-800 pb-3">
			<div>
				<h2 id="override-dialog-title" class="text-base font-semibold text-white">
					Excepción de prioridad (Override)
				</h2>
				<p class="text-xs text-slate-400">
					#{incident.id} · {incident.title}
				</p>
			</div>
			<button
				type="button"
				onclick={oncancel}
				class="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
				aria-label="Cerrar ventana"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="h-5 w-5"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M6 18L18 6M6 6l12 12"
					/>
				</svg>
			</button>
		</div>

		{#if error}
			<p
				role="alert"
				class="rounded-xl border border-red-500/30 bg-red-950/40 p-3 text-xs text-red-300"
			>
				{error}
			</p>
		{/if}

		<div class="rounded-xl border border-cyan-500/20 bg-cyan-950/20 p-3 text-xs text-cyan-300">
			El SLA original y sus compromisos permanecen estrictamente inmutables. Esta excepción
			autorizada modifica únicamente la prioridad operativa de resolución y atención técnica.
		</div>

		<div class="grid grid-cols-2 gap-3">
			<div class="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs">
				<span class="block font-medium text-slate-400">Prioridad calculada base:</span>
				<div class="mt-1 flex items-center gap-2">
					<span
						class="inline-flex items-center rounded-lg border px-2.5 py-1 font-semibold {priorityBadgeClasses[
							calculatedPriority
						]}"
					>
						{priorityLabels[calculatedPriority]}
					</span>
				</div>
			</div>

			<div class="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs">
				<span class="block font-medium text-slate-400">Prioridad operativa actual:</span>
				<div class="mt-1 flex items-center gap-2">
					<span
						class="inline-flex items-center rounded-lg border px-2.5 py-1 font-semibold {priorityBadgeClasses[
							currentEffectivePriority
						]}"
					>
						{priorityLabels[currentEffectivePriority]}
					</span>
					{#if hasActiveOverride}
						<span
							class="rounded-full border border-purple-500/40 bg-purple-950/40 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-purple-300 uppercase"
						>
							Override
						</span>
					{/if}
				</div>
			</div>
		</div>

		{#if hasActiveOverride && incident.classification?.overrideReason}
			<div
				class="rounded-xl border border-purple-500/30 bg-purple-950/20 p-3 text-xs text-purple-200"
			>
				<p class="font-semibold">Detalle del override actual:</p>
				<p class="mt-0.5 text-slate-300 italic">"{incident.classification.overrideReason}"</p>
			</div>
		{/if}

		{#if hasActiveOverride}
			<div class="flex rounded-xl border border-slate-800 bg-slate-950 p-1 text-xs">
				<button
					type="button"
					onclick={() => (isRemoveMode = false)}
					class="flex-1 rounded-lg py-1.5 font-medium transition {!isRemoveMode
						? 'bg-slate-800 text-white shadow-xs'
						: 'text-slate-400 hover:text-slate-200'}"
				>
					Modificar excepción
				</button>
				<button
					type="button"
					onclick={() => (isRemoveMode = true)}
					class="flex-1 rounded-lg py-1.5 font-medium transition {isRemoveMode
						? 'border border-amber-500/40 bg-amber-950/60 text-amber-300 shadow-xs'
						: 'text-slate-400 hover:text-slate-200'}"
				>
					Restablecer calculada (Quitar)
				</button>
			</div>
		{/if}

		{#if isRemoveMode}
			<div class="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 text-xs text-amber-300">
				Se retirará la excepción de prioridad y la incidencia volverá a operar con su prioridad
				calculada original:
				<strong class="text-amber-200"> {priorityLabels[calculatedPriority]}</strong>.
			</div>
		{:else}
			<div>
				<label
					for="override-priority-select"
					class="mb-1 block text-xs font-semibold text-slate-300"
				>
					{hasActiveOverride ? 'Nueva prioridad forzada' : 'Prioridad forzada deseada'}
				</label>
				<select
					id="override-priority-select"
					bind:value={targetPriority}
					class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white transition outline-none focus:border-cyan-400"
				>
					<option value="low">Baja</option>
					<option value="medium">Media</option>
					<option value="high">Alta</option>
					<option value="urgent">Urgente</option>
				</select>
			</div>
		{/if}

		<div>
			<label for="override-reason" class="mb-1 block text-xs font-semibold text-slate-300">
				{isRemoveMode
					? 'Motivo de la retirada de la excepción (obligatorio)'
					: 'Motivo justificado de la excepción (obligatorio)'}
			</label>
			<textarea
				id="override-reason"
				bind:value={reason}
				required
				rows="3"
				placeholder={isRemoveMode
					? 'Explica por qué se retira la excepción y se restablece la prioridad calculada...'
					: 'Explica la justificación operativa para establecer una prioridad diferente de la calculada...'}
				class="w-full resize-y rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 transition outline-none focus:border-cyan-400"
			></textarea>
		</div>

		<div class="flex justify-end gap-3 pt-2">
			<button
				type="button"
				onclick={oncancel}
				class="rounded-xl px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800"
			>
				Cancelar
			</button>

			<button
				type="submit"
				disabled={!isSubmittable}
				class="rounded-xl px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 {isRemoveMode
					? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
					: 'bg-cyan-500 text-slate-950 hover:bg-cyan-400'}"
			>
				{isRemoveMode ? 'Retirar excepción y restablecer' : 'Guardar excepción de prioridad'}
			</button>
		</div>
	</form>
</dialog>

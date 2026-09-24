<script lang="ts">
	import type { IncidentListItem } from '$lib/api/incidents';
	import { STATUS_LABELS, PRIORITY_LABELS } from './presentation';

	type IncidentStatus = 'open' | 'pending' | 'resolved' | 'closed';
	type IncidentPriority = 'low' | 'medium' | 'high' | 'urgent';

	interface Props {
		incident: IncidentListItem;
		submitting?: boolean;
		error?: string | null;
		onSave: (changes: {
			status?: IncidentStatus;
			priority?: IncidentPriority;
		}) => void | Promise<void>;
		onCancel: () => void;
	}

	let { incident, submitting = false, error = null, onSave, onCancel }: Props = $props();

	// svelte-ignore state_referenced_locally
	let selectedStatus = $state<IncidentStatus>(incident.status);
	// svelte-ignore state_referenced_locally
	let selectedPriority = $state<IncidentPriority>(incident.priority);

	// Status options: current status + only valid transitions from current status
	// open: pending, resolved
	// pending: open, resolved
	// resolved: open, closed
	// closed: open
	const VALID_TARGETS: Record<IncidentStatus, IncidentStatus[]> = {
		open: ['pending', 'resolved'],
		pending: ['open', 'resolved'],
		resolved: ['open', 'closed'],
		closed: ['open']
	};

	const availableStatuses = $derived<IncidentStatus[]>([
		incident.status,
		...VALID_TARGETS[incident.status]
	]);

	const availablePriorities: IncidentPriority[] = ['low', 'medium', 'high', 'urgent'];

	function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (submitting) return;

		const statusChanged = selectedStatus !== incident.status;
		const priorityChanged = selectedPriority !== incident.priority;

		if (!statusChanged && !priorityChanged) {
			onCancel();
			return;
		}

		onSave({
			status: statusChanged ? selectedStatus : undefined,
			priority: priorityChanged ? selectedPriority : undefined
		});
	}
</script>

<form
	class="space-y-6 rounded-xl border border-slate-700 bg-slate-900/90 p-6 md:p-8"
	onsubmit={handleSubmit}
>
	<div class="border-b border-slate-800 pb-4">
		<h2 class="text-lg font-bold text-white">Editar incidencia #{incident.incidentNumber}</h2>
		<p class="mt-1 text-xs text-slate-400">Modifica el estado y/o la prioridad del ticket.</p>
	</div>

	{#if error}
		<div
			class="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300"
			role="alert"
		>
			<p class="font-medium">{error}</p>
		</div>
	{/if}

	<div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
		<!-- Status Select -->
		<div>
			<label
				for="edit-status"
				class="block text-xs font-semibold tracking-wider text-slate-400 uppercase"
			>
				Estado
			</label>
			<select
				id="edit-status"
				bind:value={selectedStatus}
				disabled={submitting}
				class="mt-2 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 shadow-sm transition focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 focus:outline-none disabled:opacity-50"
			>
				{#each availableStatuses as st (st)}
					<option value={st}>
						{STATUS_LABELS[st] ?? st}
						{st === incident.status ? '(Actual)' : ''}
					</option>
				{/each}
			</select>
		</div>

		<!-- Priority Select -->
		<div>
			<label
				for="edit-priority"
				class="block text-xs font-semibold tracking-wider text-slate-400 uppercase"
			>
				Prioridad
			</label>
			<select
				id="edit-priority"
				bind:value={selectedPriority}
				disabled={submitting}
				class="mt-2 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 shadow-sm transition focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 focus:outline-none disabled:opacity-50"
			>
				{#each availablePriorities as prio (prio)}
					<option value={prio}>
						{PRIORITY_LABELS[prio] ?? prio}
						{prio === incident.priority ? '(Actual)' : ''}
					</option>
				{/each}
			</select>
		</div>
	</div>

	<!-- Action buttons -->
	<div class="flex items-center justify-end space-x-3 border-t border-slate-800 pt-4">
		<button
			type="button"
			onclick={onCancel}
			disabled={submitting}
			class="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-800 focus:ring-2 focus:ring-slate-500 focus:outline-none disabled:opacity-50"
		>
			Cancelar
		</button>
		<button
			type="submit"
			disabled={submitting}
			class="inline-flex items-center rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-cyan-500 focus:ring-2 focus:ring-cyan-400 focus:outline-none disabled:opacity-50"
		>
			{#if submitting}
				<svg
					class="mr-2 h-4 w-4 animate-spin text-white"
					xmlns="http://www.w3.org/2000/svg"
					fill="none"
					viewBox="0 0 24 24"
					aria-hidden="true"
				>
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"
					></circle>
					<path
						class="opacity-75"
						fill="currentColor"
						d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
					></path>
				</svg>
				Guardando...
			{:else}
				Guardar cambios
			{/if}
		</button>
	</div>
</form>

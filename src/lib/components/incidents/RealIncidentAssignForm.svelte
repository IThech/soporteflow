<script lang="ts">
	import type { IncidentAssignee } from '$lib/api/incidents';

	interface Props {
		currentAssigneeUserId: string | null;
		currentAssigneeUserName?: string | null;
		assignees: IncidentAssignee[];
		loading?: boolean;
		submitting?: boolean;
		error?: string | null;
		onSave: (data: { assignedToUserId: string; reason?: string }) => void | Promise<void>;
		onCancel: () => void;
	}

	let {
		currentAssigneeUserId,
		currentAssigneeUserName = null,
		assignees,
		loading = false,
		submitting = false,
		error = null,
		onSave,
		onCancel
	}: Props = $props();

	// svelte-ignore state_referenced_locally
	let selectedUserId = $state<string>(currentAssigneeUserId ?? '');
	let reason = $state<string>('');
	let validationError = $state<string | null>(null);

	const isReassignment = $derived(currentAssigneeUserId !== null);
	const assigneeChanged = $derived(selectedUserId !== (currentAssigneeUserId ?? ''));
	const requiresReason = $derived(isReassignment && assigneeChanged);

	function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (submitting || loading) return;

		validationError = null;

		if (!selectedUserId) {
			validationError = 'Debes seleccionar un técnico.';
			return;
		}

		// No-op: user selected the already assigned technician
		if (selectedUserId === currentAssigneeUserId) {
			onCancel();
			return;
		}

		// Reassignment requires a non-empty reason
		if (isReassignment) {
			const cleanReason = reason.trim();
			if (cleanReason.length === 0) {
				validationError = 'Debes indicar el motivo de la reasignación.';
				return;
			}
			onSave({
				assignedToUserId: selectedUserId,
				reason: cleanReason
			});
			return;
		}

		// Initial assignment: no reason required
		onSave({
			assignedToUserId: selectedUserId
		});
	}
</script>

<form
	class="space-y-6 rounded-xl border border-slate-700 bg-slate-900/90 p-6 md:p-8"
	onsubmit={handleSubmit}
>
	<div class="border-b border-slate-800 pb-4">
		<h2 class="text-lg font-bold text-white">
			{isReassignment ? 'Reasignar técnico' : 'Asignar técnico'}
		</h2>
		<p class="mt-1 text-xs text-slate-400">
			{isReassignment
				? 'Selecciona un nuevo técnico para la incidencia e indica el motivo del cambio.'
				: 'Selecciona un técnico del equipo para atender la incidencia.'}
		</p>
		{#if isReassignment && currentAssigneeUserName}
			<p class="mt-1 text-xs text-slate-400">
				Técnico asignado actualmente: <span class="font-medium text-slate-200"
					>{currentAssigneeUserName}</span
				>
			</p>
		{/if}
	</div>

	{#if error || validationError}
		<div
			class="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300"
			role="alert"
		>
			<p class="font-medium">{validationError || error}</p>
		</div>
	{/if}

	{#if loading}
		<div class="flex items-center justify-center p-6 text-center" role="status" aria-live="polite">
			<svg
				class="mr-3 h-5 w-5 animate-spin text-cyan-400"
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
			<span class="text-sm font-medium text-slate-300">Cargando técnicos disponibles...</span>
		</div>
	{:else if assignees.length === 0}
		<div class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
			<p>No hay técnicos disponibles para asignar.</p>
		</div>
	{:else}
		<div class="space-y-4">
			<!-- Technician Selector -->
			<div>
				<label
					for="assign-technician"
					class="block text-xs font-semibold tracking-wider text-slate-400 uppercase"
				>
					Técnico
				</label>
				<select
					id="assign-technician"
					bind:value={selectedUserId}
					disabled={submitting || loading}
					class="mt-2 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 shadow-sm transition focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 focus:outline-none disabled:opacity-50"
				>
					{#if !currentAssigneeUserId}
						<option value="" disabled>Selecciona un técnico</option>
					{/if}
					{#each assignees as tech (tech.id)}
						<option value={tech.id}>
							{tech.name}{tech.id === currentAssigneeUserId ? ' (Actual)' : ''}
						</option>
					{/each}
				</select>
			</div>

			<!-- Reassignment Reason Field (only shown if reassignment and assignee changed) -->
			{#if requiresReason}
				<div>
					<label
						for="assign-reason"
						class="block text-xs font-semibold tracking-wider text-slate-400 uppercase"
					>
						Motivo de la reasignación
					</label>
					<textarea
						id="assign-reason"
						bind:value={reason}
						disabled={submitting}
						required
						rows={3}
						placeholder="Indica el motivo por el cual se transfiere la incidencia..."
						class="mt-2 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 shadow-sm transition focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 focus:outline-none disabled:opacity-50"
					></textarea>
				</div>
			{/if}
		</div>
	{/if}

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
			disabled={submitting || loading || assignees.length === 0 || !selectedUserId}
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
			{:else if isReassignment}
				Reasignar
			{:else}
				Asignar técnico
			{/if}
		</button>
	</div>
</form>

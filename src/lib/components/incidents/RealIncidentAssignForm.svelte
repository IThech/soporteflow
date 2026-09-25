<script lang="ts">
	import type { IncidentAssignee, IncidentTeam } from '$lib/api/incidents';

	interface Props {
		currentTeamId?: string | null;
		currentTeamName?: string | null;
		currentAssigneeUserId: string | null;
		currentAssigneeUserName?: string | null;
		teams?: IncidentTeam[];
		assignees: IncidentAssignee[];
		teamsLoading?: boolean;
		assigneesLoading?: boolean;
		loading?: boolean;
		submitting?: boolean;
		error?: string | null;
		onTeamChange?: (teamId: string | null) => void | Promise<void>;
		onSave: (data: {
			teamId?: string | null;
			assignedToUserId?: string | null;
			reason?: string;
		}) => void | Promise<void>;
		onCancel: () => void;
	}

	let {
		currentTeamId = null,
		currentTeamName = null,
		currentAssigneeUserId,
		currentAssigneeUserName = null,
		teams = [],
		assignees = [],
		teamsLoading = false,
		assigneesLoading = false,
		loading = false,
		submitting = false,
		error = null,
		onTeamChange,
		onSave,
		onCancel
	}: Props = $props();

	// svelte-ignore state_referenced_locally
	let selectedTeamId = $state<string>(currentTeamId ?? '');
	// svelte-ignore state_referenced_locally
	let selectedUserId = $state<string>(currentAssigneeUserId ?? '');
	let reason = $state<string>('');
	let validationError = $state<string | null>(null);

	// Automatically clean incompatible technician selection when new assignees catalog arrives
	$effect(() => {
		if (!assigneesLoading && selectedUserId) {
			const isStillValid = assignees.some((a) => a.id === selectedUserId);
			if (!isStillValid) {
				selectedUserId = '';
			}
		}
	});

	const wasAssigned = $derived(Boolean(currentTeamId || currentAssigneeUserId));
	const teamChanged = $derived((selectedTeamId || null) !== (currentTeamId || null));
	const assigneeChanged = $derived((selectedUserId || null) !== (currentAssigneeUserId || null));
	const isChanged = $derived(teamChanged || assigneeChanged);
	const requiresReason = $derived(wasAssigned && isChanged);

	function handleTeamSelect(event: Event) {
		const target = event.target as HTMLSelectElement;
		const val = target.value;
		selectedTeamId = val;
		validationError = null;

		if (onTeamChange) {
			onTeamChange(val ? val : null);
		}
	}

	function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (submitting || loading || teamsLoading || assigneesLoading) return;

		validationError = null;

		const targetTeamId = selectedTeamId ? selectedTeamId : null;
		const targetUserId = selectedUserId ? selectedUserId : null;

		// Must select at least a team or a technician
		if (!targetTeamId && !targetUserId) {
			validationError = 'Debes seleccionar al menos un equipo o un técnico.';
			return;
		}

		// No-op check: both team and technician remain identical to current values
		const initialTeamId = currentTeamId ? currentTeamId : null;
		const initialUserId = currentAssigneeUserId ? currentAssigneeUserId : null;

		if (targetTeamId === initialTeamId && targetUserId === initialUserId) {
			onCancel();
			return;
		}

		// Reassignment requires a non-empty reason
		let cleanReason: string | undefined = undefined;
		if (requiresReason) {
			cleanReason = reason.trim();
			if (cleanReason.length === 0) {
				validationError = 'Debes indicar el motivo de la reasignación.';
				return;
			}
		}

		onSave({
			teamId: targetTeamId,
			assignedToUserId: targetUserId,
			...(cleanReason ? { reason: cleanReason } : {})
		});
	}
</script>

<form
	class="space-y-6 rounded-xl border border-slate-700 bg-slate-900/90 p-6 md:p-8"
	onsubmit={handleSubmit}
>
	<div class="border-b border-slate-800 pb-4">
		<h2 class="text-lg font-bold text-white">
			{wasAssigned ? 'Reasignar incidencia' : 'Asignar técnico'}
		</h2>
		<p class="mt-1 text-xs text-slate-400">
			{wasAssigned
				? 'Selecciona el equipo o técnico responsable e indica el motivo del cambio.'
				: 'Selecciona un equipo o un técnico para atender la incidencia.'}
		</p>
		{#if wasAssigned}
			<div class="mt-2 space-y-0.5 text-xs text-slate-400">
				{#if currentTeamName}
					<p>
						Equipo actual: <span class="font-medium text-slate-200">{currentTeamName}</span>
					</p>
				{/if}
				{#if currentAssigneeUserName}
					<p>
						Técnico actual: <span class="font-medium text-slate-200">{currentAssigneeUserName}</span
						>
					</p>
				{/if}
			</div>
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

	{#if loading || teamsLoading}
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
			<span class="text-sm font-medium text-slate-300">Cargando datos de asignación...</span>
		</div>
	{:else}
		<div class="space-y-4">
			<!-- Team Selector -->
			<div>
				<label
					for="assign-team"
					class="block text-xs font-semibold tracking-wider text-slate-400 uppercase"
				>
					Equipo
				</label>
				<select
					id="assign-team"
					value={selectedTeamId}
					onchange={handleTeamSelect}
					disabled={submitting || loading || teamsLoading}
					class="mt-2 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 shadow-sm transition focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 focus:outline-none disabled:opacity-50"
				>
					<option value="">Sin equipo</option>
					{#each teams as team (team.id)}
						<option value={team.id}>
							{team.name}{team.id === currentTeamId ? ' (Actual)' : ''}
						</option>
					{/each}
				</select>
			</div>

			<!-- Technician Selector -->
			<div>
				<div class="flex items-center justify-between">
					<label
						for="assign-technician"
						class="block text-xs font-semibold tracking-wider text-slate-400 uppercase"
					>
						Técnico
					</label>
					{#if assigneesLoading}
						<span class="text-xs text-cyan-400" role="status" aria-live="polite">
							Actualizando técnicos...
						</span>
					{/if}
				</div>
				<select
					id="assign-technician"
					bind:value={selectedUserId}
					disabled={submitting || loading || assigneesLoading}
					class="mt-2 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 shadow-sm transition focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 focus:outline-none disabled:opacity-50"
				>
					<option value="">Sin técnico</option>
					{#each assignees as tech (tech.id)}
						<option value={tech.id}>
							{tech.name}{tech.id === currentAssigneeUserId ? ' (Actual)' : ''}
						</option>
					{/each}
				</select>
				{#if !assigneesLoading && assignees.length === 0}
					<p class="mt-1.5 text-xs text-amber-300">
						No hay técnicos disponibles {selectedTeamId ? 'en este equipo' : 'en la organización'}.
						Puedes asignar únicamente al equipo.
					</p>
				{/if}
			</div>

			<!-- Reassignment Reason Field (only shown if reassignment and either team or tech changed) -->
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
						placeholder="Indica el motivo por el cual se reasigna la incidencia..."
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
			disabled={submitting ||
				loading ||
				teamsLoading ||
				assigneesLoading ||
				(!selectedTeamId && !selectedUserId)}
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
			{:else if wasAssigned}
				Reasignar
			{:else}
				Asignar técnico
			{/if}
		</button>
	</div>
</form>

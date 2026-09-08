<script lang="ts">
	import { supportLevels, type SupportLevel, type SupportTeam } from '$lib/types/support';
	import type { Incident } from '$lib/types/incident';
	import type { AppUser } from '$lib/types/user';
	import { escalationTeams, type EscalationInput } from '$lib/incidents/escalation';
	import { assignmentCandidates, incidentOrganizationId } from '$lib/incidents/assignment';
	let {
		incident,
		teams,
		users,
		currentAssignee,
		error,
		onconfirm,
		oncancel
	}: {
		incident: Incident;
		teams: SupportTeam[];
		users: AppUser[];
		currentAssignee: string;
		error: string;
		onconfirm: (input: EscalationInput) => void;
		oncancel: () => void;
	} = $props();
	let level = $state<SupportLevel | ''>('');
	let team = $state('');
	let assignee = $state('');
	let reason = $state('');
	let comment = $state('');
	const availableTeams = $derived(escalationTeams(incident, teams));
	const candidates = $derived(assignmentCandidates(incident, users));
	const currentTeam = $derived(
		teams.find(
			(item) =>
				item.id === incident.teamId && item.organizationId === incidentOrganizationId(incident)
		)?.name ?? (incident.teamId ? 'Equipo no disponible' : 'Sin equipo')
	);
	const changed = $derived(
		(level !== '' && level !== incident.supportLevel) || (team !== '' && team !== incident.teamId)
	);
	function show(dialog: HTMLDialogElement) {
		dialog.showModal();
	}
	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!changed) return;
		onconfirm({
			...(level ? { supportLevel: level } : {}),
			...(team ? { teamId: team } : {}),
			...(assignee ? { assignedToUserId: assignee } : {}),
			reason,
			comment
		});
	}
</script>

<dialog
	use:show
	onclose={oncancel}
	aria-labelledby="escalation-title"
	class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
>
	<h2 id="escalation-title" class="text-xl font-semibold">Escalar incidencia #{incident.id}</h2>
	<p class="mt-2 text-sm text-slate-300">{incident.title}</p>
	<p class="mt-3 text-sm text-slate-400">
		Actual: {incident.supportLevel ?? 'Sin nivel'} · {currentTeam}<br />Responsable: {currentAssignee}
	</p>
	{#if error}<p role="alert" class="mt-4 text-sm text-red-300">{error}</p>{/if}
	<form onsubmit={submit} class="mt-5 space-y-4">
		<div>
			<label for="escalation-level" class="mb-2 block text-sm">Nuevo nivel</label><select
				id="escalation-level"
				bind:value={level}
				class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3"
				><option value="">Mantener: {incident.supportLevel ?? 'Sin nivel'}</option
				>{#each supportLevels as item (item)}<option value={item}>{item}</option>{/each}</select
			>
		</div>
		<div>
			<label for="escalation-team" class="mb-2 block text-sm">Nuevo equipo</label><select
				id="escalation-team"
				bind:value={team}
				class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3"
				><option value="">Mantener: {currentTeam}</option
				>{#each availableTeams as item (item.id)}<option value={item.id}>{item.name}</option
					>{/each}</select
			>
		</div>
		<div>
			<label for="escalation-assignee" class="mb-2 block text-sm"
				>Responsable (cambio opcional)</label
			><select
				id="escalation-assignee"
				bind:value={assignee}
				class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3"
				><option value="">Mantener: {currentAssignee}</option
				>{#each candidates as item (item.id)}<option value={item.id}>{item.name}</option
					>{/each}</select
			>
		</div>
		<p class="text-sm text-slate-400">
			Cambia el nivel o el equipo para escalar. Si solo necesitas cambiar responsable, utiliza
			Asignar/Reasignar.
		</p>
		<div>
			<label for="escalation-reason" class="mb-2 block text-sm"
				>Motivo del escalado (obligatorio)</label
			><textarea
				id="escalation-reason"
				bind:value={reason}
				required
				rows="3"
				class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3"></textarea>
		</div>
		<div>
			<label for="escalation-comment" class="mb-2 block text-sm">Comentario (opcional)</label
			><textarea
				id="escalation-comment"
				bind:value={comment}
				rows="2"
				class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3"></textarea>
		</div>
		<div class="flex justify-end gap-3">
			<button
				type="button"
				onclick={oncancel}
				class="rounded-lg px-4 py-2 text-sm hover:bg-slate-800">Cancelar</button
			><button
				type="submit"
				disabled={!changed}
				class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
				>Confirmar escalado</button
			>
		</div>
	</form>
</dialog>

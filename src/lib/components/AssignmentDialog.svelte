<script lang="ts">
	import type { Incident } from '$lib/types/incident';
	import type { AppUser } from '$lib/types/user';
	import { reassignmentReasons, requiresAssignmentReason } from '$lib/incidents/assignment';
	let {
		incident,
		actor,
		candidates,
		currentName,
		initialTarget,
		error,
		onconfirm,
		oncancel
	}: {
		incident: Incident;
		actor: AppUser;
		candidates: AppUser[];
		currentName: string;
		initialTarget: string;
		error: string;
		onconfirm: (target: string, reason: string, comment: string) => void;
		oncancel: () => void;
	} = $props();
	let target = $state('');
	let reason = $state('');
	let manualReason = $state('');
	let comment = $state('');
	const reassigning = $derived(!!incident.assignedToUserId);
	const needsReason = $derived(requiresAssignmentReason(actor, incident, target));
	function show(dialog: HTMLDialogElement) {
		target = initialTarget;
		dialog.showModal();
	}
	function submit(event: SubmitEvent) {
		event.preventDefault();
		onconfirm(
			target,
			needsReason ? (reason === 'Otro' ? manualReason.trim() : reason.trim()) : '',
			comment.trim()
		);
	}
</script>

<dialog
	use:show
	onclose={oncancel}
	aria-labelledby="assignment-title"
	class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
>
	<h2 id="assignment-title" class="text-xl font-semibold">
		{reassigning
			? 'Reasignar incidencia'
			: needsReason
				? 'Asignar a otro técnico'
				: 'Asignar incidencia'} #{incident.id}
	</h2>
	<p class="mt-2 text-sm text-slate-300">{incident.title}</p>
	<p class="mt-2 text-sm text-slate-400">Responsable actual: {currentName}</p>
	{#if error}<p role="alert" class="mt-4 text-sm text-red-300">{error}</p>{/if}
	<form class="mt-5 space-y-4" onsubmit={submit}>
		<div>
			<label for="assignment-target" class="mb-2 block text-sm"
				>{reassigning ? 'Nuevo técnico' : 'Técnico'}</label
			>
			<select
				id="assignment-target"
				bind:value={target}
				required
				class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3"
			>
				<option value="" disabled>Selecciona un técnico</option>
				{#each candidates as user (user.id)}<option value={user.id}
						>{user.name}{user.id === incident.assignedToUserId ? ' (actual)' : ''}</option
					>{/each}
			</select>
		</div>
		{#if candidates.length === 0}<p class="text-sm text-amber-300">
				No hay técnicos activos disponibles en esta organización.
			</p>{/if}
		{#if needsReason}
			<div>
				<label for="assignment-reason" class="mb-2 block text-sm">Motivo (obligatorio)</label>
				<select
					id="assignment-reason"
					bind:value={reason}
					required
					class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3"
					><option value="" disabled>Selecciona un motivo</option
					>{#each reassignmentReasons as item (item)}<option>{item}</option>{/each}</select
				>
			</div>
			{#if reason === 'Otro'}<div>
					<label for="assignment-manual" class="mb-2 block text-sm">Describe el motivo</label
					><textarea
						id="assignment-manual"
						bind:value={manualReason}
						required
						rows="2"
						class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3"></textarea>
				</div>{/if}
			{#if reason === 'Escalado técnico'}<p class="text-sm text-slate-400">
					Se registra como motivo del cambio de responsable. No cambia el nivel ni el equipo.
				</p>{/if}
		{/if}
		<div>
			<label for="assignment-comment" class="mb-2 block text-sm">Comentario (opcional)</label
			><textarea
				id="assignment-comment"
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
				disabled={!target || target === incident.assignedToUserId || candidates.length === 0}
				class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
				>Confirmar {reassigning ? 'reasignación' : 'asignación'}</button
			>
		</div>
	</form>
</dialog>

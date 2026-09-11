<script lang="ts">
	import { demoSupportLevels } from '$lib/data/support-levels';
	import type { SupportLevelDefinition, SupportTeam } from '$lib/types/support';
	import type { Incident } from '$lib/types/incident';
	import type { IncidentCategory } from '$lib/types/category';
	import type { AppUser } from '$lib/types/user';
	import type { ReassignmentReason } from '$lib/types/reassignment-reason';
	import type { UnifiedAssignmentInput } from '$lib/incidents/escalation';
	import {
		assignmentCandidates,
		canAssignTo,
		incidentOrganizationId,
		isCandidateLevelCompatible
	} from '$lib/incidents/assignment';

	let {
		incident,
		actor,
		users,
		teams,
		levels = demoSupportLevels,
		categories = [],
		reasons = [],
		initialTarget = '',
		error = '',
		onconfirm,
		oncancel
	}: {
		incident: Incident;
		actor: AppUser;
		users: AppUser[];
		teams: SupportTeam[];
		levels?: SupportLevelDefinition[];
		categories?: IncidentCategory[];
		reasons?: ReassignmentReason[];
		initialTarget?: string;
		error?: string;
		onconfirm: (input: UnifiedAssignmentInput) => void;
		oncancel: () => void;
	} = $props();

	let targetAssignee = $state('');
	let reason = $state('');
	let comment = $state('');

	const orgId = $derived(incidentOrganizationId(incident));
	const candidates = $derived(
		assignmentCandidates(incident, users).filter((u) => canAssignTo(actor, incident, u.id, levels))
	);
	const reassigning = $derived(!!incident.assignedToUserId);

	const currentCategory = $derived(categories.find((c) => c.id === incident.categoryId));
	const currentTeamDef = $derived(
		teams.find((t) => t.id === incident.teamId && t.organizationId === orgId)
	);
	const currentAssigneeUser = $derived(
		users.find((u) => u.id === incident.assignedToUserId && u.organizationId === orgId)
	);
	const hasInactiveCurrentAssignee = $derived(
		!!incident.assignedToUserId && !candidates.some((u) => u.id === incident.assignedToUserId)
	);

	const selectedCandidate = $derived(users.find((u) => u.id === targetAssignee));
	const selectedCandidateIncompatible = $derived(
		selectedCandidate ? !isCandidateLevelCompatible(selectedCandidate, incident, levels) : false
	);

	const changed = $derived(targetAssignee !== (incident.assignedToUserId ?? ''));

	function show(dialog: HTMLDialogElement) {
		targetAssignee = initialTarget || incident.assignedToUserId || '';
		reason = '';
		comment = '';
		dialog.showModal();
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!changed || selectedCandidateIncompatible) return;
		onconfirm({
			assignedToUserId: targetAssignee || undefined,
			reason: reason.trim() || undefined,
			comment: comment.trim() || undefined
		});
	}
</script>

<dialog
	use:show
	onclose={oncancel}
	aria-labelledby="assignment-dialog-title"
	class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
>
	<h2 id="assignment-dialog-title" class="text-xl font-semibold">
		{reassigning ? 'Reasignar incidencia' : 'Asignar incidencia'} #{incident.id}
	</h2>
	<p class="mt-1 text-sm text-slate-400">
		Selecciona el técnico responsable para la atención de esta incidencia.
	</p>

	<!-- Read-only classification box -->
	<div class="mt-4 rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-xs text-slate-300">
		<div class="font-medium text-slate-200">{incident.title}</div>
		<div class="mt-2 text-slate-400">
			<span class="font-semibold text-slate-300">Clasificación actual:</span>
			<span class="text-slate-200"
				>{currentCategory ? currentCategory.name : incident.categoryId || 'Sin categoría'}</span
			>
			· Nivel requerido:
			<span class="font-semibold text-cyan-300">{incident.supportLevel ?? 'Sin nivel'}</span>
			· Equipo:
			<span class="text-slate-200">
				{currentTeamDef
					? currentTeamDef.name
					: incident.teamId
						? 'Equipo no disponible'
						: 'Sin equipo'}
			</span>
		</div>
		<div class="mt-1 text-slate-400">
			Responsable actual:
			<span class="text-slate-200">
				{currentAssigneeUser
					? currentAssigneeUser.name
					: incident.assignedToUserId
						? 'Técnico no disponible'
						: 'Sin asignar'}
			</span>
		</div>
	</div>

	{#if error}<p role="alert" class="mt-4 text-sm text-red-300">{error}</p>{/if}

	<form class="mt-5 space-y-4" onsubmit={submit}>
		<div>
			<label for="assignment-assignee" class="mb-2 block text-sm font-medium text-slate-200">
				Responsable
			</label>
			<select
				id="assignment-assignee"
				bind:value={targetAssignee}
				class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-white focus:border-cyan-500 focus:outline-none"
			>
				<option value="">Sin asignar</option>
				{#if hasInactiveCurrentAssignee && incident.assignedToUserId}
					<option value={incident.assignedToUserId}>
						{currentAssigneeUser ? currentAssigneeUser.name : 'Responsable actual'} (actual · inactivo)
					</option>
				{/if}
				{#each candidates as user (user.id)}
					{@const compatible = isCandidateLevelCompatible(user, incident, levels)}
					{#if compatible}
						<option value={user.id}>
							{user.name} ({user.supportLevel ?? 'Sin nivel'}){user.id === incident.assignedToUserId
								? ' (actual)'
								: ''}
						</option>
					{:else}
						<option value={user.id} disabled>
							{user.name} ({user.supportLevel ?? 'Sin nivel'}) — Nivel insuficiente
						</option>
					{/if}
				{/each}
			</select>
			{#if candidates.length === 0}
				<p class="mt-1 text-xs text-amber-300">
					No hay técnicos activos disponibles en esta organización.
				</p>
			{:else}
				<p class="mt-1 text-xs text-slate-400">
					Los técnicos con nivel inferior al nivel requerido aparecen deshabilitados.
				</p>
			{/if}
		</div>

		<div>
			<label for="assignment-reason" class="mb-2 block text-sm font-medium text-slate-200">
				Motivo (opcional)
			</label>
			<input
				type="text"
				id="assignment-reason"
				bind:value={reason}
				list="assignment-reason-options"
				placeholder="Opcional. Si se deja vacío, se asignará un motivo automático."
				class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-white focus:border-cyan-500 focus:outline-none"
			/>
			<datalist id="assignment-reason-options">
				{#each (reasons ?? []).filter((r) => r.active && r.organizationId === orgId) as r (r.id)}
					<option value={r.name}>{r.name}</option>
				{/each}
			</datalist>
		</div>

		<div>
			<label for="assignment-comment" class="mb-2 block text-sm font-medium text-slate-200">
				Comentario (opcional)
			</label>
			<textarea
				id="assignment-comment"
				bind:value={comment}
				rows="2"
				placeholder="Información adicional para la trazabilidad (opcional)"
				class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-white focus:border-cyan-500 focus:outline-none"
			></textarea>
		</div>

		<div class="flex justify-end gap-3 pt-2">
			<button
				type="button"
				onclick={oncancel}
				class="rounded-lg px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
			>
				Cancelar
			</button>
			<button
				type="submit"
				disabled={!changed || selectedCandidateIncompatible}
				class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
			>
				Guardar cambios
			</button>
		</div>
	</form>
</dialog>

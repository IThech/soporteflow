<script lang="ts">
	import { demoSupportLevels } from '$lib/data/support-levels';
	import type { SupportLevelDefinition, SupportTeam } from '$lib/types/support';
	import type { Incident } from '$lib/types/incident';
	import type { IncidentCategory } from '$lib/types/category';
	import type { ReassignmentReason } from '$lib/types/reassignment-reason';
	import type { ClassificationChangeInput } from '$lib/incidents/escalation';
	import { incidentOrganizationId } from '$lib/incidents/assignment';
	import { escalationLevels, escalationTeams } from '$lib/incidents/escalation';

	let {
		incident,
		categories = [],
		levels = demoSupportLevels,
		teams = [],
		reasons = [],
		error = '',
		onconfirm,
		oncancel
	}: {
		incident: Incident;
		categories: IncidentCategory[];
		levels?: SupportLevelDefinition[];
		teams?: SupportTeam[];
		reasons?: ReassignmentReason[];
		error?: string;
		onconfirm: (input: ClassificationChangeInput) => void;
		oncancel: () => void;
	} = $props();

	let targetCategory = $state('');
	let targetLevel = $state('');
	let targetTeam = $state('');
	let reason = $state('');
	let comment = $state('');

	const orgId = $derived(incidentOrganizationId(incident));
	const availableCategories = $derived(
		categories.filter((c) => c.active && (!c.organizationId || c.organizationId === orgId))
	);
	const availableLevels = $derived(escalationLevels(incident, levels));
	const availableTeams = $derived(escalationTeams(incident, teams));

	const currentCategoryDef = $derived(categories.find((c) => c.id === incident.categoryId));
	const hasInactiveCurrentCategory = $derived(
		!!incident.categoryId && !availableCategories.some((c) => c.id === incident.categoryId)
	);

	const currentLevelDef = $derived(
		levels.find(
			(l) =>
				l.organizationId === orgId &&
				l.code.toUpperCase() === (incident.supportLevel || '').trim().toUpperCase()
		)
	);
	const hasInactiveCurrentLevel = $derived(
		!!incident.supportLevel &&
			!availableLevels.some((l) => l.code.toUpperCase() === incident.supportLevel?.toUpperCase())
	);

	const currentTeamDef = $derived(
		teams.find((t) => t.id === incident.teamId && t.organizationId === orgId)
	);
	const hasInactiveCurrentTeam = $derived(
		!!incident.teamId && !availableTeams.some((t) => t.id === incident.teamId)
	);

	const changed = $derived(
		targetCategory !== (incident.categoryId ?? '') ||
			targetLevel !== (incident.supportLevel ?? '') ||
			targetTeam !== (incident.teamId ?? '')
	);

	const selectedCategoryObj = $derived(categories.find((c) => c.id === targetCategory));
	const categoryChanged = $derived(targetCategory !== (incident.categoryId ?? ''));
	const showDefaultRoutingHint = $derived(
		categoryChanged &&
			selectedCategoryObj &&
			(selectedCategoryObj.defaultSupportLevel || selectedCategoryObj.defaultTeamId)
	);
	const defaultRoutingTeamName = $derived(
		selectedCategoryObj?.defaultTeamId
			? (teams.find((t) => t.id === selectedCategoryObj.defaultTeamId)?.name ??
					selectedCategoryObj.defaultTeamId)
			: '—'
	);

	function show(dialog: HTMLDialogElement) {
		targetCategory = incident.categoryId ?? '';
		targetLevel = incident.supportLevel ?? '';
		targetTeam = incident.teamId ?? '';
		reason = '';
		comment = '';
		dialog.showModal();
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!changed || !reason.trim()) return;
		onconfirm({
			categoryId: targetCategory || undefined,
			supportLevel: targetLevel ? targetLevel : undefined,
			teamId: targetTeam ? targetTeam : undefined,
			reason: reason.trim(),
			comment: comment.trim() || undefined
		});
	}
</script>

<dialog
	use:show
	onclose={oncancel}
	aria-labelledby="classification-dialog-title"
	class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
>
	<h2 id="classification-dialog-title" class="text-xl font-semibold">
		Cambiar clasificación #{incident.id}
	</h2>
	<p class="mt-1 text-sm text-slate-400">
		Modifica la categoría, el nivel requerido (escalado / desescalado) o el equipo técnico asignado.
	</p>

	<!-- Read-only current classification box -->
	<div class="mt-4 rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-xs text-slate-300">
		<div class="font-medium text-slate-200">{incident.title}</div>
		<div class="mt-2 text-slate-400">
			<span class="font-semibold text-slate-300">Clasificación actual:</span>
			<span class="text-slate-200"
				>{currentCategoryDef
					? currentCategoryDef.name
					: incident.categoryId || 'Sin categoría'}</span
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
	</div>

	{#if error}<p role="alert" class="mt-4 text-sm text-red-300">{error}</p>{/if}

	<form class="mt-5 space-y-4" onsubmit={submit}>
		<div>
			<label for="classification-category" class="mb-2 block text-sm font-medium text-slate-200">
				Categoría
			</label>
			<select
				id="classification-category"
				bind:value={targetCategory}
				class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-white focus:border-cyan-500 focus:outline-none"
			>
				<option value="">Sin categoría</option>
				{#if hasInactiveCurrentCategory && incident.categoryId}
					<option value={incident.categoryId}>
						{currentCategoryDef ? currentCategoryDef.name : incident.categoryId} (actual · inactiva)
					</option>
				{/if}
				{#each availableCategories as cat (cat.id)}
					<option value={cat.id}>
						{cat.name}{cat.id === incident.categoryId ? ' (actual)' : ''}
					</option>
				{/each}
			</select>
			{#if showDefaultRoutingHint}
				<p class="mt-1.5 rounded bg-slate-800/80 p-2 text-xs text-amber-300">
					La categoría seleccionada tiene como routing predeterminado:
					<span class="font-semibold text-cyan-300"
						>{selectedCategoryObj?.defaultSupportLevel ?? '—'}</span
					>
					· <span class="font-semibold text-slate-200">{defaultRoutingTeamName}</span>. El routing
					actual no se modificará automáticamente salvo que lo indiques abajo.
				</p>
			{/if}
		</div>

		<div>
			<label for="classification-level" class="mb-2 block text-sm font-medium text-slate-200">
				Nivel requerido
			</label>
			<select
				id="classification-level"
				bind:value={targetLevel}
				class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-white focus:border-cyan-500 focus:outline-none"
			>
				<option value="">Sin nivel</option>
				{#if hasInactiveCurrentLevel && incident.supportLevel}
					<option value={incident.supportLevel}>
						{incident.supportLevel}{currentLevelDef ? ` — ${currentLevelDef.name}` : ''} (actual · inactivo)
					</option>
				{/if}
				{#each availableLevels as item (item.id)}
					<option value={item.code}>
						{item.code} — {item.name}{item.code === incident.supportLevel ? ' (actual)' : ''}
					</option>
				{/each}
			</select>
		</div>

		<div>
			<label for="classification-team" class="mb-2 block text-sm font-medium text-slate-200">
				Equipo
			</label>
			<select
				id="classification-team"
				bind:value={targetTeam}
				class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-white focus:border-cyan-500 focus:outline-none"
			>
				<option value="">Sin equipo</option>
				{#if hasInactiveCurrentTeam && incident.teamId}
					<option value={incident.teamId}>
						{currentTeamDef ? currentTeamDef.name : incident.teamId} (actual · inactivo)
					</option>
				{/if}
				{#each availableTeams as item (item.id)}
					<option value={item.id}>
						{item.name}{item.id === incident.teamId ? ' (actual)' : ''}
					</option>
				{/each}
			</select>
		</div>

		<div>
			<label for="classification-reason" class="mb-2 block text-sm font-medium text-slate-200">
				Motivo del cambio (obligatorio)
			</label>
			<input
				type="text"
				id="classification-reason"
				bind:value={reason}
				required
				list="classification-reason-options"
				placeholder="Indica el motivo de la reclasificación o escalado"
				class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-white focus:border-cyan-500 focus:outline-none"
			/>
			<datalist id="classification-reason-options">
				{#each (reasons ?? []).filter((r) => r.active && r.organizationId === orgId) as r (r.id)}
					<option value={r.name}>{r.name}</option>
				{/each}
			</datalist>
		</div>

		<div>
			<label for="classification-comment" class="mb-2 block text-sm font-medium text-slate-200">
				Comentario (opcional)
			</label>
			<textarea
				id="classification-comment"
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
				disabled={!changed || !reason.trim()}
				class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
			>
				Guardar cambios
			</button>
		</div>
	</form>
</dialog>

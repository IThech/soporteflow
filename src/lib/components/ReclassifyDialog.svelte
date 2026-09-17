<script lang="ts">
	import type { Incident, IncidentPriority } from '$lib/types/incident';
	import type { IncidentCategory } from '$lib/types/category';
	import type {
		Subcategory,
		PriorityMatrix,
		ImpactLevel,
		ClassificationResult
	} from '$lib/types/classification';
	import { incidentOrganizationId } from '$lib/incidents/assignment';
	import { getAvailableSubcategories } from '$lib/classification/subcategories-catalog';
	import { resolveOrganizationMatrix } from '$lib/classification/matrix-catalog';
	import { classifyIncident, isImpactLevel, toIncidentPriority } from '$lib/classification/engine';

	let {
		incident,
		categories = [],
		subcategories = [],
		priorityMatrices = [],
		error = '',
		onconfirm,
		oncancel
	}: {
		incident: Incident;
		categories?: IncidentCategory[];
		subcategories?: Subcategory[];
		priorityMatrices?: PriorityMatrix[];
		error?: string;
		onconfirm: (input: {
			newCategoryId: string;
			newSubcategoryId: string;
			newImpact: ImpactLevel;
			reason: string;
		}) => void;
		oncancel: () => void;
	} = $props();

	let newCategoryId = $state('');
	let newSubcategoryId = $state('');
	let newImpact = $state<ImpactLevel | ''>('');
	let reason = $state('');

	const orgId = $derived(incidentOrganizationId(incident));

	const availableCategories = $derived(
		categories.filter((c) => c.active && (!c.organizationId || c.organizationId === orgId))
	);

	const availableSubcategories = $derived(
		getAvailableSubcategories(subcategories, categories, orgId, newCategoryId)
	);

	$effect(() => {
		if (newSubcategoryId && !availableSubcategories.some((s) => s.id === newSubcategoryId)) {
			newSubcategoryId = '';
		}
	});

	const selectedSubcategory = $derived(
		availableSubcategories.find((s) => s.id === newSubcategoryId)
	);

	const resolvedMatrix = $derived.by(() => {
		try {
			return resolveOrganizationMatrix(priorityMatrices, orgId);
		} catch {
			return null;
		}
	});

	const classificationPreview = $derived.by<ClassificationResult | null>(() => {
		if (
			!selectedSubcategory ||
			!newImpact ||
			!isImpactLevel(newImpact) ||
			!resolvedMatrix ||
			resolvedMatrix.status === 'corrupt'
		) {
			return null;
		}
		try {
			return classifyIncident({
				subcategory: selectedSubcategory,
				impact: newImpact,
				matrix: resolvedMatrix.matrix,
				override: null
			});
		} catch {
			return null;
		}
	});

	const previewPriority = $derived(
		classificationPreview ? toIncidentPriority(classificationPreview.effectivePriority) : null
	);

	const isChanged = $derived(
		Boolean(
			newCategoryId &&
			newSubcategoryId &&
			newImpact &&
			(newCategoryId !== incident.categoryId ||
				newSubcategoryId !== incident.subcategoryId ||
				newImpact !== incident.classification?.impactLevel)
		)
	);

	const isSubmittable = $derived(isChanged && reason.trim().length > 0 && previewPriority !== null);

	const hasPreviousOverride = $derived(incident.classification?.hasOverride === true);

	const priorityLabels: Record<IncidentPriority, string> = {
		urgent: 'Urgente',
		high: 'Alta',
		medium: 'Media',
		low: 'Baja'
	};

	const priorityBadgeClasses: Record<IncidentPriority, string> = {
		urgent: 'badge-priority-urgent',
		high: 'badge-priority-high',
		medium: 'badge-priority-medium',
		low: 'badge-priority-low'
	};

	function show(dialog: HTMLDialogElement) {
		newCategoryId = incident.categoryId ?? '';
		newSubcategoryId = incident.subcategoryId ?? '';
		newImpact = (incident.classification?.impactLevel as ImpactLevel) ?? '';
		reason = '';
		dialog.showModal();
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!isSubmittable || !newImpact || !isImpactLevel(newImpact)) return;
		onconfirm({
			newCategoryId,
			newSubcategoryId,
			newImpact,
			reason: reason.trim()
		});
	}
</script>

<dialog
	{@attach show}
	class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
	aria-labelledby="reclassify-dialog-title"
>
	<form onsubmit={submit} class="space-y-4">
		<div class="flex items-center justify-between border-b border-slate-800 pb-3">
			<div>
				<h2 id="reclassify-dialog-title" class="text-base font-semibold text-white">
					Reclasificar incidencia
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

		{#if hasPreviousOverride}
			<div role="alert" class="box-override-remove-notice rounded-xl p-3 text-xs">
				<p class="font-semibold">Aviso: override activo previo</p>
				<p class="mt-1">
					Esta incidencia cuenta actualmente con una excepción de prioridad a <strong
						>{priorityLabels[incident.priority] || incident.priority}</strong
					>. Al reclasificar, el override se retirará automáticamente y la prioridad operativa
					pasará a ser la calculada por la nueva taxonomía.
				</p>
			</div>
		{/if}

		<div class="rounded-xl border border-cyan-500/20 bg-cyan-950/20 p-3 text-xs text-cyan-300">
			La reclasificación evalúa la nueva combinación de categoría, subcategoría e impacto mediante
			el motor V2. El SLA original y el responsable o equipo asignados permanecerán inmutables.
		</div>

		<div>
			<label for="reclassify-category" class="mb-1 block text-xs font-semibold text-slate-300">
				Categoría
			</label>
			<select
				id="reclassify-category"
				bind:value={newCategoryId}
				required
				class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white transition outline-none focus:border-cyan-400"
			>
				<option value="">Selecciona una categoría</option>
				{#each availableCategories as category (category.id)}
					<option value={category.id}>{category.name}</option>
				{/each}
			</select>
		</div>

		<div>
			<label for="reclassify-subcategory" class="mb-1 block text-xs font-semibold text-slate-300">
				Subcategoría
			</label>
			<select
				id="reclassify-subcategory"
				bind:value={newSubcategoryId}
				required
				disabled={!newCategoryId || availableSubcategories.length === 0}
				class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white transition outline-none focus:border-cyan-400 disabled:opacity-50"
			>
				{#if !newCategoryId}
					<option value="">Selecciona primero una categoría</option>
				{:else if availableSubcategories.length === 0}
					<option value="">No hay subcategorías activas disponibles</option>
				{:else}
					<option value="">Selecciona una subcategoría</option>
					{#each availableSubcategories as subcat (subcat.id)}
						<option value={subcat.id}>
							{subcat.name} (Criticidad base: {subcat.baseCriticality})
						</option>
					{/each}
				{/if}
			</select>
		</div>

		<div>
			<label for="reclassify-impact" class="mb-1 block text-xs font-semibold text-slate-300">
				Nivel de impacto
			</label>
			<select
				id="reclassify-impact"
				bind:value={newImpact}
				required
				class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white transition outline-none focus:border-cyan-400"
			>
				<option value="">Selecciona el alcance del impacto</option>
				<option value="I1">I1 — Una persona</option>
				<option value="I2">I2 — Varias personas</option>
				<option value="I3">I3 — Equipo o departamento</option>
				<option value="I4">I4 — Sede u organización completa</option>
			</select>
		</div>

		<div class="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs">
			<span class="block font-medium text-slate-400">Nueva prioridad calculada:</span>
			{#if previewPriority}
				<div class="mt-1 flex items-center gap-2">
					<span
						class="inline-flex items-center rounded-lg border px-2.5 py-1 font-semibold {priorityBadgeClasses[
							previewPriority
						]}"
					>
						{priorityLabels[previewPriority]}
					</span>
					{#if classificationPreview?.snapshot?.minPriorityApplied}
						<span class="text-priority-medium font-medium">
							(Elevada por prioridad mínima de la subcategoría)
						</span>
					{/if}
				</div>
			{:else}
				<span class="mt-1 block text-slate-500 italic">
					Selecciona categoría, subcategoría e impacto para previsualizar la prioridad resultante.
				</span>
			{/if}
		</div>

		<div>
			<label for="reclassify-reason" class="mb-1 block text-xs font-semibold text-slate-300">
				Motivo de la reclasificación (obligatorio)
			</label>
			<textarea
				id="reclassify-reason"
				bind:value={reason}
				required
				rows="3"
				placeholder="Describe la justificación del cambio de clasificación..."
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
				class="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
			>
				Confirmar reclasificación
			</button>
		</div>
	</form>
</dialog>

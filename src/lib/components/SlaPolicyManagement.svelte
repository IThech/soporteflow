<script lang="ts">
	import { hasPermission, canAccessOrganization } from '$lib/auth/permissions';
	import { canAccessRecord } from '$lib/auth/record-access';
	import type { AppUser } from '$lib/types/user';
	import type { SlaPolicy } from '$lib/types/sla';
	import type { IncidentCategory } from '$lib/types/category';
	import type { IncidentPriority } from '$lib/types/incident';
	import {
		formatSlaPolicyScope,
		minutesToTimeInput,
		timeInputToMinutes,
		type SlaPolicyChange
	} from '$lib/incidents/sla-catalog';
	import { formatSlaDuration } from '$lib/incidents/sla-presentation';

	let {
		actor,
		policies,
		categories,
		ready,
		error,
		onchange
	}: {
		actor: AppUser;
		policies: SlaPolicy[];
		categories: IncidentCategory[];
		ready: boolean;
		error: string;
		onchange: (change: SlaPolicyChange) => boolean;
	} = $props();

	interface SlaDraft {
		id?: string;
		name: string;
		description: string;
		isDefault: boolean;
		categoryId: string;
		priority: string;
		firstResponseValue: number;
		firstResponseUnit: 'minutes' | 'hours' | 'days';
		resolutionValue: number;
		resolutionUnit: 'minutes' | 'hours' | 'days';
	}

	let draft = $state<SlaDraft | null>(null);
	let formError = $state('');

	const allowed = $derived(hasPermission(actor, 'sla:manage'));
	const visiblePolicies = $derived(
		policies.filter((policy) => canAccessOrganization(actor, policy.organizationId))
	);
	const orgCategories = $derived(categories.filter((category) => canAccessRecord(actor, category)));
	const activeOrgCategories = $derived(orgCategories.filter((category) => category.active));

	// If editing an existing policy that already has an inactive category, allow preserving it
	const currentInactiveCategory = $derived.by(() => {
		if (!draft?.categoryId) return null;
		return orgCategories.find((c) => c.id === draft?.categoryId && !c.active) ?? null;
	});

	function openCreate() {
		if (!ready || !allowed) return;
		formError = '';
		draft = {
			name: '',
			description: '',
			isDefault: false,
			categoryId: '',
			priority: '',
			firstResponseValue: 4,
			firstResponseUnit: 'hours',
			resolutionValue: 24,
			resolutionUnit: 'hours'
		};
	}

	function openEdit(policy: SlaPolicy) {
		if (!ready || !allowed || !canAccessOrganization(actor, policy.organizationId)) return;
		formError = '';
		const fr = minutesToTimeInput(policy.firstResponseMinutes);
		const res = minutesToTimeInput(policy.resolutionMinutes);
		draft = {
			id: policy.id,
			name: policy.name,
			description: policy.description ?? '',
			isDefault: policy.isDefault,
			categoryId: policy.categoryId ?? '',
			priority: policy.priority ?? '',
			firstResponseValue: fr.value,
			firstResponseUnit: fr.unit,
			resolutionValue: res.value,
			resolutionUnit: res.unit
		};
	}

	function handleToggle(policy: SlaPolicy) {
		if (!ready || !allowed) return;
		formError = '';
		onchange({ type: 'toggle', id: policy.id });
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		formError = '';
		if (!draft) return;

		try {
			const firstResponseMinutes = timeInputToMinutes(
				draft.firstResponseValue,
				draft.firstResponseUnit
			);
			const resolutionMinutes = timeInputToMinutes(draft.resolutionValue, draft.resolutionUnit);

			const success = onchange({
				type: 'save',
				id: draft.id,
				name: draft.name,
				description: draft.description,
				isDefault: draft.isDefault,
				categoryId: draft.isDefault ? null : draft.categoryId || null,
				priority: draft.isDefault ? null : (draft.priority as IncidentPriority) || null,
				firstResponseMinutes,
				resolutionMinutes
			});

			if (success) {
				draft = null;
				formError = '';
			}
		} catch (err) {
			formError = err instanceof Error ? err.message : 'Error al guardar la política.';
		}
	}
</script>

{#if allowed}
	<section
		aria-labelledby="sla-policies-title"
		class="rounded-xl border border-slate-800 bg-slate-900 p-6"
	>
		<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<div>
				<h2 id="sla-policies-title" class="text-lg font-semibold text-white">Políticas de SLA</h2>
				<p class="mt-1 text-sm text-slate-400">
					Compromisos de tiempo de atención y resolución para tu organización.
				</p>
			</div>
			{#if ready && !draft}
				<button
					type="button"
					onclick={openCreate}
					class="self-start rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 sm:self-auto"
				>
					Nueva política
				</button>
			{/if}
		</div>

		{#if error}
			<p
				role="alert"
				class="mt-4 rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-300"
			>
				{error}
			</p>
		{/if}

		{#if draft}
			<form
				onsubmit={submit}
				class="mt-6 space-y-4 rounded-lg border border-slate-700 bg-slate-950 p-4 sm:p-6"
				aria-labelledby="sla-form-title"
			>
				<h3 id="sla-form-title" class="text-base font-semibold text-white">
					{draft.id ? 'Editar política SLA' : 'Nueva política SLA'}
				</h3>

				{#if formError}
					<p
						role="alert"
						class="rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm text-red-400"
					>
						{formError}
					</p>
				{/if}

				<div>
					<label for="sla-name" class="mb-1 block text-sm font-medium text-slate-300">
						Nombre (obligatorio)
					</label>
					<input
						id="sla-name"
						type="text"
						required
						bind:value={draft.name}
						placeholder="Ej. SLA Estándar, SLA Crítico Redes"
						class="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-white outline-none focus:border-cyan-400"
					/>
				</div>

				<div>
					<label for="sla-description" class="mb-1 block text-sm font-medium text-slate-300">
						Descripción (opcional)
					</label>
					<textarea
						id="sla-description"
						rows="2"
						bind:value={draft.description}
						placeholder="Detalle o alcance de aplicación de este compromiso"
						class="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-white outline-none focus:border-cyan-400"
					></textarea>
				</div>

				<div class="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
					<div class="flex items-start gap-3">
						<input
							id="sla-is-default"
							type="checkbox"
							bind:checked={draft.isDefault}
							class="mt-1 h-4 w-4 rounded border-slate-600 bg-slate-950 text-cyan-500 focus:ring-cyan-400"
						/>
						<div>
							<label for="sla-is-default" class="text-sm font-medium text-slate-200">
								Política predeterminada (Fallback general)
							</label>
							<p class="mt-0.5 text-xs text-slate-400">
								Se aplicará automáticamente a cualquier incidencia de la organización que no
								coincida con una regla específica de categoría o prioridad.
							</p>
						</div>
					</div>

					{#if !draft.isDefault}
						<div class="mt-4 grid gap-4 border-t border-slate-800 pt-4 sm:grid-cols-2">
							<div>
								<label for="sla-category" class="mb-1 block text-xs font-medium text-slate-300">
									Categoría
								</label>
								<select
									id="sla-category"
									bind:value={draft.categoryId}
									class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
								>
									<option value="">Cualquier categoría</option>
									{#each activeOrgCategories as cat (cat.id)}
										<option value={cat.id}>{cat.name}</option>
									{/each}
									{#if currentInactiveCategory}
										<option value={currentInactiveCategory.id}>
											{currentInactiveCategory.name} (Inactiva)
										</option>
									{/if}
								</select>
							</div>

							<div>
								<label for="sla-priority" class="mb-1 block text-xs font-medium text-slate-300">
									Prioridad
								</label>
								<select
									id="sla-priority"
									bind:value={draft.priority}
									class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
								>
									<option value="">Cualquier prioridad</option>
									<option value="low">Baja</option>
									<option value="medium">Media</option>
									<option value="high">Alta</option>
								</select>
							</div>
						</div>
						<p class="mt-2 text-xs text-slate-400">
							* Una regla específica debe tener seleccionada al menos una categoría o una prioridad.
						</p>
					{/if}
				</div>

				<div class="grid gap-4 sm:grid-cols-2">
					<!-- Tiempo Primera Respuesta -->
					<div class="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
						<span class="mb-2 block text-sm font-medium text-slate-200"> Primera respuesta </span>
						<div class="flex gap-2">
							<input
								type="number"
								min="1"
								required
								bind:value={draft.firstResponseValue}
								aria-label="Valor de primera respuesta"
								class="w-24 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
							/>
							<select
								bind:value={draft.firstResponseUnit}
								aria-label="Unidad de primera respuesta"
								class="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
							>
								<option value="minutes">Minutos</option>
								<option value="hours">Horas</option>
								<option value="days">Días</option>
							</select>
						</div>
					</div>

					<!-- Tiempo Resolución -->
					<div class="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
						<span class="mb-2 block text-sm font-medium text-slate-200"> Resolución </span>
						<div class="flex gap-2">
							<input
								type="number"
								min="1"
								required
								bind:value={draft.resolutionValue}
								aria-label="Valor de resolución"
								class="w-24 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
							/>
							<select
								bind:value={draft.resolutionUnit}
								aria-label="Unidad de resolución"
								class="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
							>
								<option value="minutes">Minutos</option>
								<option value="hours">Horas</option>
								<option value="days">Días</option>
							</select>
						</div>
					</div>
				</div>

				<div class="flex flex-wrap gap-3 pt-2">
					<button
						type="submit"
						class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400"
					>
						Guardar política
					</button>
					<button
						type="button"
						onclick={() => {
							draft = null;
							formError = '';
						}}
						class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
					>
						Cancelar
					</button>
				</div>
			</form>
		{/if}

		{#if ready}
			<ul class="mt-6 grid gap-4 sm:grid-cols-2">
				{#each visiblePolicies as policy (policy.id)}
					<li
						class="flex flex-col justify-between rounded-lg border border-slate-700 bg-slate-950 p-4"
					>
						<div>
							<div class="flex items-start justify-between gap-2">
								<div class="flex flex-wrap items-center gap-2">
									<h3 class="font-medium text-slate-200">{policy.name}</h3>
									{#if policy.isDefault}
										<span class="badge-default-policy"> Predeterminada </span>
									{/if}
								</div>
								<span
									class={`text-xs font-medium ${policy.active ? 'text-emerald-400' : 'text-slate-500'}`}
								>
									{policy.active ? 'Activa' : 'Inactiva'}
								</span>
							</div>

							<div class="mt-2 text-xs text-slate-400">
								<span class="font-medium text-slate-300">Ámbito: </span>
								<span>{formatSlaPolicyScope(policy, categories)}</span>
							</div>

							{#if policy.description}
								<p class="mt-2 text-xs text-slate-400">
									{policy.description}
								</p>
							{/if}

							<div
								class="mt-3 grid grid-cols-2 gap-2 rounded border border-slate-800 bg-slate-900/50 p-2 text-xs"
							>
								<div>
									<span class="text-slate-400">Primera respuesta:</span>
									<p class="font-medium text-slate-200">
										{formatSlaDuration(policy.firstResponseMinutes)}
									</p>
								</div>
								<div>
									<span class="text-slate-400">Resolución:</span>
									<p class="font-medium text-slate-200">
										{formatSlaDuration(policy.resolutionMinutes)}
									</p>
								</div>
							</div>
						</div>

						<div class="mt-4 flex flex-wrap gap-2 border-t border-slate-800/80 pt-3">
							<button
								type="button"
								onclick={() => openEdit(policy)}
								aria-label={`Editar política ${policy.name}`}
								class="rounded border border-slate-700 px-3 py-1.5 text-xs text-cyan-400 hover:bg-slate-800"
							>
								Editar
							</button>
							<button
								type="button"
								onclick={() => handleToggle(policy)}
								aria-label={`${policy.active ? 'Desactivar' : 'Reactivar'} política ${policy.name}`}
								class="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
							>
								{policy.active ? 'Desactivar' : 'Reactivar'}
							</button>
						</div>
					</li>
				{:else}
					<li
						class="col-span-full rounded-lg border border-slate-800 bg-slate-950/40 p-6 text-center text-sm text-slate-400"
					>
						Todavía no hay políticas SLA configuradas para esta organización.
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}

<script lang="ts">
	import { hasPermission, canAccessOrganization } from '$lib/auth/permissions';
	import { canAccessRecord } from '$lib/auth/record-access';
	import { normalizeSearchText } from '$lib/incidents/queue';
	import type { AppUser } from '$lib/types/user';
	import type { IncidentCategory } from '$lib/types/category';

	let {
		actor,
		categories,
		ready = true,
		error = '',
		onchange
	}: {
		actor: AppUser;
		categories: IncidentCategory[];
		ready: boolean;
		error?: string;
		onchange: (next: IncidentCategory[]) => boolean;
	} = $props();

	let draft = $state<{ id?: string; name: string; description: string } | null>(null);
	let formError = $state('');

	const allowed = $derived(hasPermission(actor, 'categories:manage'));
	const visibleCategories = $derived(
		categories.filter((category) => canAccessRecord(actor, category))
	);

	function mayManageCategory(category?: IncidentCategory): boolean {
		return (
			ready &&
			!error &&
			allowed &&
			(category
				? canAccessRecord(actor, category)
				: !!actor.organizationId && canAccessOrganization(actor, actor.organizationId))
		);
	}

	function openCategoryForm(id?: string) {
		const category = id === undefined ? undefined : categories.find((item) => item.id === id);
		if ((id !== undefined && !category) || !mayManageCategory(category)) return;
		formError = '';
		draft = category
			? { id: category.id, name: category.name, description: category.description }
			: { name: '', description: '' };
	}

	function saveCategory(event: SubmitEvent) {
		event.preventDefault();
		if (!draft) return;
		const currentDraft = draft;
		const original =
			currentDraft.id === undefined
				? undefined
				: categories.find((item) => item.id === currentDraft.id);
		if ((currentDraft.id !== undefined && !original) || !mayManageCategory(original)) return;

		const name = currentDraft.name.trim();
		const description = currentDraft.description.trim();
		if (!name) {
			formError = 'Escribe un nombre para la categoría.';
			return;
		}

		// Compare only within the target organization, including legacy data.
		if (
			categories.some(
				(item) =>
					item.id !== original?.id &&
					canAccessRecord(actor, item) &&
					normalizeSearchText(item.name) === normalizeSearchText(name)
			)
		) {
			formError = 'Ya existe una categoría con ese nombre, activa o inactiva.';
			return;
		}

		const category: IncidentCategory = original
			? { ...original, name, description }
			: {
					id: crypto.randomUUID(),
					organizationId: actor.organizationId,
					name,
					description,
					active: true
				};

		const next = original
			? categories.map((item) => (item.id === original.id ? category : item))
			: [...categories, category];

		if (onchange(next)) {
			draft = null;
			formError = '';
		}
	}

	function toggleCategory(id: string) {
		const category = categories.find((item) => item.id === id);
		if (!category || !mayManageCategory(category)) return;
		const next = categories.map((item) =>
			item.id === id ? { ...item, active: !item.active } : item
		);
		onchange(next);
	}
</script>

{#if allowed}
	<section
		aria-labelledby="categories-title"
		class="rounded-xl border border-slate-800 bg-slate-900 p-6"
	>
		<div class="flex flex-wrap items-center justify-between gap-4">
			<div>
				<h2 id="categories-title" class="text-lg font-semibold text-white">
					Categorías de incidencias
				</h2>
				<p class="mt-1 text-sm text-slate-400">
					Catálogo de categorías para clasificar los casos de soporte.
				</p>
			</div>

			{#if ready && !error && actor.organizationId}
				<button
					type="button"
					onclick={() => openCategoryForm()}
					class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
				>
					Nueva categoría
				</button>
			{/if}
		</div>

		{#if error}
			<p role="alert" class="mt-4 text-sm text-red-400">
				{error}
			</p>
		{/if}

		{#if formError}
			<p role="alert" class="mt-4 text-sm text-red-400">
				{formError}
			</p>
		{/if}

		{#if draft && ready && !error}
			<form
				onsubmit={saveCategory}
				class="mt-5 space-y-4 rounded-lg border border-slate-700 bg-slate-950 p-4"
				aria-labelledby="category-form-title"
			>
				<h3 id="category-form-title" class="font-semibold text-white">
					{draft.id ? 'Editar categoría' : 'Nueva categoría'}
				</h3>
				<div>
					<label for="category-name" class="mb-2 block text-sm text-slate-300">
						Nombre (obligatorio)
					</label>
					<input
						id="category-name"
						bind:value={draft.name}
						required
						class="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-white outline-none focus:border-cyan-400"
					/>
				</div>
				<div>
					<label for="category-description" class="mb-2 block text-sm text-slate-300">
						Descripción (opcional)
					</label>
					<textarea
						id="category-description"
						bind:value={draft.description}
						rows="3"
						class="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-white outline-none focus:border-cyan-400"
					></textarea>
				</div>
				<div class="flex gap-3">
					<button
						type="submit"
						class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
					>
						Guardar categoría
					</button>
					<button
						type="button"
						onclick={() => {
							draft = null;
							formError = '';
						}}
						class="rounded-lg px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
					>
						Cancelar
					</button>
				</div>
			</form>
		{/if}

		<ul class="mt-5 grid gap-3 sm:grid-cols-2" aria-label="Lista de categorías">
			{#each visibleCategories as category (category.id)}
				<li class="rounded-lg border border-slate-700 bg-slate-950 p-4">
					<div class="flex items-center justify-between gap-3">
						<h3 class="font-medium text-slate-200">{category.name}</h3>

						<span
							class={`text-xs font-semibold ${category.active ? 'text-emerald-400' : 'text-slate-500'}`}
						>
							{category.active ? 'Activa' : 'Inactiva'}
						</span>
					</div>

					<p class="mt-2 text-sm text-slate-400">
						{category.description || 'Sin descripción'}
					</p>

					{#if ready}
						<div class="mt-4 flex flex-wrap gap-3">
							<button
								type="button"
								onclick={() => openCategoryForm(category.id)}
								aria-label={`Editar categoría ${category.name}`}
								class="rounded-lg border border-slate-700 px-3 py-2 text-sm text-cyan-400 hover:bg-slate-800"
							>
								Editar
							</button>
							<button
								type="button"
								onclick={() => toggleCategory(category.id)}
								aria-label={`${category.active ? 'Desactivar' : 'Reactivar'} categoría ${category.name}`}
								class="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
							>
								{category.active ? 'Desactivar' : 'Reactivar'}
							</button>
						</div>
					{/if}
				</li>
			{:else}
				<li class="col-span-2 text-sm text-slate-400">Todavía no hay categorías configuradas.</li>
			{/each}
		</ul>
	</section>
{/if}

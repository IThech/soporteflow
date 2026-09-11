<script lang="ts">
	import type { AppUser } from '$lib/types/user';
	import type { Incident } from '$lib/types/incident';
	import type { SupportLevelDefinition } from '$lib/types/support';
	import { hasPermission } from '$lib/auth/permissions';
	import {
		createSupportLevel,
		updateSupportLevel,
		toggleSupportLevelActive,
		reorderSupportLevel,
		getOrganizationLevels,
		countSupportLevelReferences
	} from '$lib/support/levels-catalog';

	let {
		actor,
		levels,
		users = [],
		incidents = [],
		ready = true,
		error = '',
		onchange
	}: {
		actor: AppUser;
		levels: SupportLevelDefinition[];
		users?: AppUser[];
		incidents?: Incident[];
		ready: boolean;
		error?: string;
		onchange: (next: SupportLevelDefinition[]) => boolean;
	} = $props();

	const allowed = $derived(hasPermission(actor, 'organization:manage'));

	const orgLevels = $derived(
		actor.organizationId ? getOrganizationLevels(levels, actor.organizationId) : []
	);

	interface LevelDraft {
		id?: string;
		code: string;
		name: string;
		description: string;
		active: boolean;
	}

	let draft = $state<LevelDraft | null>(null);
	let formError = $state('');
	let actionError = $state('');
	let formDialog = $state<HTMLDialogElement | null>(null);

	// Deactivation confirmation modal state
	let pendingDeactivateLevel = $state<SupportLevelDefinition | null>(null);
	let pendingReferences = $state<{ userCount: number; activeIncidentCount: number } | null>(null);
	let confirmDialog = $state<HTMLDialogElement | null>(null);

	function openCreateDialog() {
		if (!allowed || !actor.organizationId) return;
		formError = '';
		actionError = '';
		draft = {
			code: '',
			name: '',
			description: '',
			active: true
		};
		formDialog?.showModal();
	}

	function openEditDialog(level: SupportLevelDefinition) {
		if (!allowed) return;
		formError = '';
		actionError = '';
		draft = {
			id: level.id,
			code: level.code,
			name: level.name,
			description: level.description || '',
			active: level.active
		};
		formDialog?.showModal();
	}

	function closeFormDialog() {
		formDialog?.close();
		draft = null;
		formError = '';
	}

	function handleSave(event: SubmitEvent) {
		event.preventDefault();
		if (!draft || !actor.organizationId) return;

		formError = '';
		actionError = '';

		try {
			let next: SupportLevelDefinition[];
			if (draft.id) {
				next = updateSupportLevel(actor, levels, {
					id: draft.id,
					name: draft.name,
					description: draft.description,
					active: draft.active
				});
			} else {
				next = createSupportLevel(actor, levels, {
					organizationId: actor.organizationId,
					code: draft.code,
					name: draft.name,
					description: draft.description,
					active: draft.active
				});
			}

			if (onchange(next)) {
				closeFormDialog();
			}
		} catch (err) {
			formError = err instanceof Error ? err.message : 'No se pudo guardar el nivel de soporte.';
		}
	}

	function requestToggleActive(level: SupportLevelDefinition) {
		if (!allowed || !actor.organizationId) return;
		actionError = '';

		// If activating, no warning needed
		if (!level.active) {
			try {
				const next = toggleSupportLevelActive(actor, levels, level.id);
				onchange(next);
			} catch (err) {
				actionError =
					err instanceof Error ? err.message : 'No se pudo cambiar el estado del nivel.';
			}
			return;
		}

		// If deactivating, check references (DECISIÓN 4)
		const refs = countSupportLevelReferences(actor.organizationId, level.code, users, incidents);
		if (refs.userCount > 0 || refs.activeIncidentCount > 0) {
			pendingDeactivateLevel = level;
			pendingReferences = refs;
			confirmDialog?.showModal();
		} else {
			// No references, deactivate directly
			try {
				const next = toggleSupportLevelActive(actor, levels, level.id);
				onchange(next);
			} catch (err) {
				actionError =
					err instanceof Error ? err.message : 'No se pudo cambiar el estado del nivel.';
			}
		}
	}

	function confirmDeactivation() {
		if (!pendingDeactivateLevel) return;
		try {
			const next = toggleSupportLevelActive(actor, levels, pendingDeactivateLevel.id);
			onchange(next);
			closeConfirmDialog();
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'No se pudo desactivar el nivel.';
			closeConfirmDialog();
		}
	}

	function closeConfirmDialog() {
		confirmDialog?.close();
		pendingDeactivateLevel = null;
		pendingReferences = null;
	}

	function handleMove(levelId: string, direction: 'up' | 'down') {
		if (!allowed) return;
		actionError = '';
		try {
			const next = reorderSupportLevel(actor, levels, levelId, direction);
			onchange(next);
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'No se pudo reordenar el nivel.';
		}
	}
</script>

{#if allowed}
	<div class="support-level-management space-y-6">
		<section
			aria-labelledby="support-levels-title"
			class="rounded-2xl border border-slate-800 bg-slate-900 p-6"
		>
			<div class="flex flex-wrap items-center justify-between gap-4">
				<div>
					<h2 id="support-levels-title" class="text-lg font-semibold text-white">
						Niveles de soporte
					</h2>
					<p class="mt-1 text-sm text-slate-400">
						Definición, secuencia de escalado y alcance operativo de los niveles de atención
						técnica.
					</p>
				</div>

				{#if ready && !error && actor.organizationId}
					<button
						type="button"
						onclick={openCreateDialog}
						class="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 focus-visible:outline-2 focus-visible:outline-cyan-400"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							class="h-4 w-4"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width="2.5"
							aria-hidden="true"
						>
							<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
						</svg>
						<span>Nuevo nivel</span>
					</button>
				{/if}
			</div>

			{#if error}
				<p
					role="alert"
					class="mt-4 rounded-lg border border-red-800/40 bg-red-950/40 p-3 text-sm text-red-400"
				>
					{error}
				</p>
			{/if}

			{#if actionError}
				<p
					role="alert"
					class="mt-4 rounded-lg border border-red-800/40 bg-red-950/40 p-3 text-sm text-red-400"
				>
					{actionError}
				</p>
			{/if}

			<!-- Desktop Table View -->
			<div class="mt-6 hidden overflow-hidden rounded-xl border border-slate-800 lg:block">
				<table class="w-full table-fixed text-left text-sm text-slate-300">
					<thead
						class="border-b border-slate-800 bg-slate-950 text-xs tracking-wider text-slate-400 uppercase"
					>
						<tr>
							<th scope="col" class="w-[10%] px-3 py-3 text-center font-semibold text-slate-400">
								Orden
							</th>
							<th scope="col" class="w-[12%] px-3 py-3 font-semibold text-slate-400">Código</th>
							<th scope="col" class="w-[25%] px-3 py-3 font-semibold text-slate-400">Nombre</th>
							<th scope="col" class="w-[28%] px-3 py-3 font-semibold text-slate-400">
								Descripción
							</th>
							<th
								scope="col"
								class="w-[10%] px-2 py-3 text-center font-semibold whitespace-nowrap text-slate-400"
							>
								Estado
							</th>
							<th
								scope="col"
								class="w-[15%] px-3 py-3 text-right font-semibold whitespace-nowrap text-slate-400"
							>
								Acciones
							</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-slate-800">
						{#each orgLevels as level, index (level.id)}
							<tr class="transition hover:bg-slate-800/40">
								<td class="px-3 py-3 text-center font-medium whitespace-nowrap text-white">
									<div class="flex items-center justify-center gap-1">
										<span class="inline-block w-4 text-center text-xs font-semibold text-slate-400">
											{level.order}
										</span>
										<div class="flex flex-col">
											<button
												type="button"
												onclick={() => handleMove(level.id, 'up')}
												disabled={index === 0}
												class="rounded p-0.5 text-slate-400 hover:bg-slate-800 hover:text-cyan-300 disabled:opacity-20"
												aria-label={`Subir nivel ${level.code}`}
											>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													class="h-3 w-3"
													viewBox="0 0 20 20"
													fill="currentColor"
												>
													<path
														fill-rule="evenodd"
														d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z"
														clip-rule="evenodd"
													/>
												</svg>
											</button>
											<button
												type="button"
												onclick={() => handleMove(level.id, 'down')}
												disabled={index === orgLevels.length - 1}
												class="rounded p-0.5 text-slate-400 hover:bg-slate-800 hover:text-cyan-300 disabled:opacity-20"
												aria-label={`Bajar nivel ${level.code}`}
											>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													class="h-3 w-3"
													viewBox="0 0 20 20"
													fill="currentColor"
												>
													<path
														fill-rule="evenodd"
														d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
														clip-rule="evenodd"
													/>
												</svg>
											</button>
										</div>
									</div>
								</td>
								<td class="px-3 py-3 font-mono text-xs whitespace-nowrap">
									<span
										class="inline-flex items-center rounded-md bg-slate-800 px-2 py-0.5 font-bold tracking-wider text-cyan-300 ring-1 ring-cyan-500/30"
									>
										{level.code}
									</span>
								</td>
								<td class="px-3 py-3 font-medium text-white">
									<div class="truncate" title={level.name}>{level.name}</div>
								</td>
								<td class="px-3 py-3 text-slate-400">
									<div class="truncate text-xs" title={level.description || ''}>
										{level.description || '—'}
									</div>
								</td>
								<td class="px-2 py-3 text-center whitespace-nowrap">
									<span
										class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap {level.active
											? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
											: 'border border-slate-700 bg-slate-800 text-slate-400'}"
									>
										{level.active ? 'Activo' : 'Inactivo'}
									</span>
								</td>
								<td class="px-3 py-3 text-right whitespace-nowrap">
									<div class="flex items-center justify-end gap-1.5 whitespace-nowrap">
										<button
											type="button"
											onclick={() => openEditDialog(level)}
											class="inline-flex items-center rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-1 text-xs font-medium whitespace-nowrap text-cyan-400 transition hover:bg-slate-700 hover:text-cyan-300 focus-visible:outline-2 focus-visible:outline-cyan-400"
											aria-label={`Editar nivel ${level.code}`}
										>
											Editar
										</button>
										<button
											type="button"
											onclick={() => requestToggleActive(level)}
											class="inline-flex items-center rounded-lg border border-slate-700 px-2 py-1 text-xs font-medium whitespace-nowrap transition hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-cyan-400 {level.active
												? 'bg-slate-900 text-slate-300 hover:border-red-500/40 hover:bg-red-950/30 hover:text-red-300'
												: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'}"
											aria-label={`${level.active ? 'Desactivar' : 'Activar'} nivel ${level.code}`}
										>
											{level.active ? 'Desactivar' : 'Activar'}
										</button>
									</div>
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="6" class="px-4 py-8 text-center text-sm text-slate-400">
									No hay niveles de soporte definidos en esta organización.
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<!-- Mobile & Tablet Cards View -->
			<div class="mt-6 space-y-3 lg:hidden">
				{#each orgLevels as level, index (level.id)}
					<article class="space-y-3 rounded-xl border border-slate-800 bg-slate-950 p-4">
						<div class="flex items-start justify-between gap-2">
							<div class="flex items-center gap-2">
								<span
									class="inline-flex items-center rounded-md bg-slate-800 px-2 py-0.5 font-mono text-xs font-bold text-cyan-300 ring-1 ring-cyan-500/30"
								>
									{level.code}
								</span>
								<h3 class="truncate font-semibold text-white" title={level.name}>
									{level.name}
								</h3>
							</div>
							<span
								class="inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap {level.active
									? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
									: 'border border-slate-700 bg-slate-800 text-slate-400'}"
							>
								{level.active ? 'Activo' : 'Inactivo'}
							</span>
						</div>

						{#if level.description}
							<p class="text-xs text-slate-400">{level.description}</p>
						{/if}

						<div
							class="flex items-center justify-between border-t border-slate-800/80 pt-3 text-xs"
						>
							<div class="flex items-center gap-2 text-slate-400">
								<span>Orden: {level.order}</span>
								<div class="flex items-center gap-1">
									<button
										type="button"
										onclick={() => handleMove(level.id, 'up')}
										disabled={index === 0}
										class="rounded border border-slate-700 bg-slate-900 p-1 text-slate-300 disabled:opacity-20"
										aria-label={`Subir ${level.code}`}
									>
										▲
									</button>
									<button
										type="button"
										onclick={() => handleMove(level.id, 'down')}
										disabled={index === orgLevels.length - 1}
										class="rounded border border-slate-700 bg-slate-900 p-1 text-slate-300 disabled:opacity-20"
										aria-label={`Bajar ${level.code}`}
									>
										▼
									</button>
								</div>
							</div>

							<div class="flex items-center gap-2">
								<button
									type="button"
									onclick={() => openEditDialog(level)}
									class="rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1 font-medium text-cyan-400 transition hover:bg-slate-700"
								>
									Editar
								</button>
								<button
									type="button"
									onclick={() => requestToggleActive(level)}
									class="rounded-lg border border-slate-700 px-2.5 py-1 font-medium transition {level.active
										? 'bg-slate-900 text-slate-300 hover:border-red-500/40 hover:bg-red-950/30 hover:text-red-300'
										: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'}"
								>
									{level.active ? 'Desactivar' : 'Activar'}
								</button>
							</div>
						</div>
					</article>
				{:else}
					<p class="py-6 text-center text-sm text-slate-400">
						No hay niveles de soporte definidos en esta organización.
					</p>
				{/each}
			</div>
		</section>

		<!-- Accessible Creation/Edition Dialog -->
		<dialog
			bind:this={formDialog}
			onclose={closeFormDialog}
			aria-labelledby="level-dialog-title"
			class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
		>
			{#if draft}
				<form onsubmit={handleSave} class="space-y-4">
					<div class="flex items-center justify-between border-b border-slate-800 pb-3">
						<h3 id="level-dialog-title" class="text-base font-semibold text-white">
							{draft.id ? 'Editar nivel de soporte' : 'Nuevo nivel de soporte'}
						</h3>
						<button
							type="button"
							onclick={closeFormDialog}
							class="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
							aria-label="Cerrar ventana"
						>
							✕
						</button>
					</div>

					{#if formError}
						<div
							role="alert"
							class="rounded-lg border border-red-800/40 bg-red-950/40 p-3 text-sm text-red-400"
						>
							{formError}
						</div>
					{/if}

					<div>
						<label for="level-code" class="mb-1 block text-xs font-semibold text-slate-300">
							Código identificador {draft.id ? '(inmutable)' : '(obligatorio)'}
						</label>
						<input
							id="level-code"
							type="text"
							bind:value={draft.code}
							required
							disabled={!!draft.id}
							placeholder="Ej. N1, L1, TIER-1"
							class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-white uppercase placeholder-slate-500 transition outline-none focus:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
						/>
						<p class="mt-1 text-[11px] text-slate-400">
							{draft.id
								? 'El código es la referencia persistente y no puede cambiarse tras su creación.'
								: 'Identificador corto en mayúsculas (ej. N1, N2, TIER-1).'}
						</p>
					</div>

					<div>
						<label for="level-name" class="mb-1 block text-xs font-semibold text-slate-300">
							Nombre del nivel (obligatorio)
						</label>
						<input
							id="level-name"
							type="text"
							bind:value={draft.name}
							required
							placeholder="Ej. Primera línea / Triaje inicial"
							class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 transition outline-none focus:border-cyan-400"
						/>
					</div>

					<div>
						<label for="level-description" class="mb-1 block text-xs font-semibold text-slate-300">
							Descripción (opcional)
						</label>
						<textarea
							id="level-description"
							bind:value={draft.description}
							rows="3"
							placeholder="Criterios de atención o perfil de incidencias atendidas..."
							class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 transition outline-none focus:border-cyan-400"
						></textarea>
					</div>

					{#if draft.id}
						<div class="flex items-center gap-2 pt-1">
							<input
								id="level-active"
								type="checkbox"
								bind:checked={draft.active}
								class="h-4 w-4 rounded border-slate-700 bg-slate-950 text-cyan-500 focus:ring-cyan-400"
							/>
							<label for="level-active" class="text-sm text-slate-300 select-none">
								Nivel activo (disponible para nuevas asignaciones y escalados)
							</label>
						</div>
					{/if}

					<div class="flex items-center justify-end gap-3 border-t border-slate-800 pt-4">
						<button
							type="button"
							onclick={closeFormDialog}
							class="rounded-xl px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white"
						>
							Cancelar
						</button>
						<button
							type="submit"
							class="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 focus-visible:outline-2 focus-visible:outline-cyan-400"
						>
							Guardar nivel
						</button>
					</div>
				</form>
			{/if}
		</dialog>

		<!-- Confirmation Modal for Deactivation with References (DECISIÓN 4) -->
		<dialog
			bind:this={confirmDialog}
			onclose={closeConfirmDialog}
			aria-labelledby="confirm-deactivate-title"
			class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-amber-500/40 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
		>
			{#if pendingDeactivateLevel && pendingReferences}
				<div class="space-y-4">
					<div class="flex items-center gap-3 text-amber-400">
						<svg
							xmlns="http://www.w3.org/2000/svg"
							class="h-6 w-6 shrink-0"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
							/>
						</svg>
						<h3 id="confirm-deactivate-title" class="text-base font-semibold text-white">
							Desactivar nivel {pendingDeactivateLevel.code}
						</h3>
					</div>

					<p class="text-sm text-slate-300">Este nivel está actualmente en uso por:</p>

					<div
						class="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-300"
					>
						<ul class="list-inside list-disc space-y-1">
							<li>
								<strong>{pendingReferences.userCount}</strong>
								{pendingReferences.userCount === 1 ? 'usuario' : 'usuarios'}
							</li>
							<li>
								<strong>{pendingReferences.activeIncidentCount}</strong>
								{pendingReferences.activeIncidentCount === 1
									? 'incidencia activa'
									: 'incidencias activas'}
							</li>
						</ul>
					</div>

					<p class="text-xs text-slate-400">
						Si lo desactivas, seguirá visible en registros existentes, pero no podrá seleccionarse
						para nuevas asignaciones.
					</p>

					<p class="text-xs font-medium text-slate-300">¿Quieres continuar?</p>

					<div class="flex items-center justify-end gap-3 border-t border-slate-800 pt-4">
						<button
							type="button"
							onclick={closeConfirmDialog}
							class="rounded-xl px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white"
						>
							Cancelar
						</button>
						<button
							type="button"
							onclick={confirmDeactivation}
							class="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 focus-visible:outline-2 focus-visible:outline-amber-400"
						>
							Desactivar de todas formas
						</button>
					</div>
				</div>
			{/if}
		</dialog>
	</div>
{/if}

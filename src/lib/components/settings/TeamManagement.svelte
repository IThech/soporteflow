<script lang="ts">
	import type { AppUser } from '$lib/types/user';
	import type { Incident } from '$lib/types/incident';
	import type { SupportTeam } from '$lib/types/support';
	import { hasPermission } from '$lib/auth/permissions';
	import {
		createSupportTeam,
		updateSupportTeam,
		toggleSupportTeamActive,
		getOrganizationTeams,
		countSupportTeamReferences
	} from '$lib/support/teams-catalog';

	let {
		actor,
		teams,
		users = [],
		incidents = [],
		ready = true,
		error = '',
		onchange
	}: {
		actor: AppUser;
		teams: SupportTeam[];
		users?: AppUser[];
		incidents?: Incident[];
		ready: boolean;
		error?: string;
		onchange: (next: SupportTeam[]) => boolean;
	} = $props();

	const allowed = $derived(hasPermission(actor, 'organization:manage'));

	const orgTeams = $derived(
		actor.organizationId ? getOrganizationTeams(teams, actor.organizationId) : []
	);

	let searchQuery = $state('');

	const filteredTeams = $derived(
		orgTeams.filter((t) => {
			if (!searchQuery.trim()) return true;
			const q = searchQuery.trim().toLowerCase();
			return (
				t.name.toLowerCase().includes(q) ||
				(t.description && t.description.toLowerCase().includes(q))
			);
		})
	);

	interface TeamDraft {
		id?: string;
		name: string;
		description: string;
		active: boolean;
	}

	let draft = $state<TeamDraft | null>(null);
	let formError = $state('');
	let actionError = $state('');
	let formDialog = $state<HTMLDialogElement | null>(null);

	// Deactivation confirmation modal state
	let pendingDeactivateTeam = $state<SupportTeam | null>(null);
	let pendingReferences = $state<{ userCount: number; activeIncidentCount: number } | null>(null);
	let confirmDialog = $state<HTMLDialogElement | null>(null);

	function openCreateDialog() {
		if (!allowed || !actor.organizationId) return;
		formError = '';
		actionError = '';
		draft = {
			name: '',
			description: '',
			active: true
		};
		formDialog?.showModal();
	}

	function openEditDialog(team: SupportTeam) {
		if (!allowed) return;
		formError = '';
		actionError = '';
		draft = {
			id: team.id,
			name: team.name,
			description: team.description || '',
			active: team.active
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
			let next: SupportTeam[];
			if (draft.id) {
				next = updateSupportTeam(actor, teams, {
					id: draft.id,
					name: draft.name,
					description: draft.description,
					active: draft.active
				});
			} else {
				next = createSupportTeam(actor, teams, {
					organizationId: actor.organizationId,
					name: draft.name,
					description: draft.description,
					active: draft.active
				});
			}

			if (onchange(next)) {
				closeFormDialog();
			}
		} catch (err) {
			formError = err instanceof Error ? err.message : 'No se pudo guardar el equipo.';
		}
	}

	function requestToggleActive(team: SupportTeam) {
		if (!allowed || !actor.organizationId) return;
		actionError = '';

		// If activating, activate directly
		if (!team.active) {
			try {
				const next = toggleSupportTeamActive(actor, teams, team.id);
				onchange(next);
			} catch (err) {
				actionError =
					err instanceof Error ? err.message : 'No se pudo cambiar el estado del equipo.';
			}
			return;
		}

		// If deactivating, check references (DECISIÓN 4)
		const refs = countSupportTeamReferences(actor.organizationId, team.id, users, incidents);
		if (refs.userCount > 0 || refs.activeIncidentCount > 0) {
			pendingDeactivateTeam = team;
			pendingReferences = refs;
			confirmDialog?.showModal();
		} else {
			try {
				const next = toggleSupportTeamActive(actor, teams, team.id);
				onchange(next);
			} catch (err) {
				actionError =
					err instanceof Error ? err.message : 'No se pudo cambiar el estado del equipo.';
			}
		}
	}

	function confirmDeactivation() {
		if (!pendingDeactivateTeam) return;
		try {
			const next = toggleSupportTeamActive(actor, teams, pendingDeactivateTeam.id);
			onchange(next);
			closeConfirmDialog();
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'No se pudo desactivar el equipo.';
			closeConfirmDialog();
		}
	}

	function closeConfirmDialog() {
		confirmDialog?.close();
		pendingDeactivateTeam = null;
		pendingReferences = null;
	}
</script>

{#if allowed}
	<div class="team-management space-y-6">
		<section
			aria-labelledby="teams-title"
			class="rounded-2xl border border-slate-800 bg-slate-900 p-6"
		>
			<div class="flex flex-wrap items-center justify-between gap-4">
				<div>
					<h2 id="teams-title" class="text-lg font-semibold text-white">Equipos de soporte</h2>
					<p class="mt-1 text-sm text-slate-400">
						Especialidades técnicas, áreas funcionales y distribución organizativa de la carga.
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
						<span>Nuevo equipo</span>
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

			<!-- Search and Counters Bar -->
			<div
				class="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-6"
			>
				<div class="relative max-w-md min-w-[240px] flex-1">
					<div class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
						<svg
							xmlns="http://www.w3.org/2000/svg"
							class="h-4 w-4 text-slate-400"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
							/>
						</svg>
					</div>
					<input
						type="search"
						bind:value={searchQuery}
						placeholder="Buscar equipo por nombre o descripción..."
						class="w-full rounded-xl border border-slate-700 bg-slate-950 py-2 pr-4 pl-9 text-sm text-white placeholder-slate-400 transition outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400"
						aria-label="Buscar equipos"
					/>
				</div>

				<span class="text-xs font-medium text-slate-400">
					{filteredTeams.length}
					{filteredTeams.length === 1 ? 'equipo' : 'equipos'}
				</span>
			</div>

			<!-- Desktop Table View -->
			<div class="mt-6 hidden overflow-hidden rounded-xl border border-slate-800 lg:block">
				<table class="w-full table-fixed text-left text-sm text-slate-300">
					<thead
						class="border-b border-slate-800 bg-slate-950 text-xs tracking-wider text-slate-400 uppercase"
					>
						<tr>
							<th scope="col" class="w-[30%] px-3 py-3 font-semibold text-slate-400">Nombre</th>
							<th scope="col" class="w-[45%] px-3 py-3 font-semibold text-slate-400">Descripción</th
							>
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
						{#each filteredTeams as team (team.id)}
							<tr class="transition hover:bg-slate-800/40">
								<td class="px-3 py-3 font-medium text-white">
									<div class="truncate" title={team.name}>{team.name}</div>
								</td>
								<td class="px-3 py-3 text-slate-400">
									<div class="truncate text-xs" title={team.description || ''}>
										{team.description || '—'}
									</div>
								</td>
								<td class="px-2 py-3 text-center whitespace-nowrap">
									<span
										class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap {team.active
											? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
											: 'border border-slate-700 bg-slate-800 text-slate-400'}"
									>
										{team.active ? 'Activo' : 'Inactivo'}
									</span>
								</td>
								<td class="px-3 py-3 text-right whitespace-nowrap">
									<div class="flex items-center justify-end gap-1.5 whitespace-nowrap">
										<button
											type="button"
											onclick={() => openEditDialog(team)}
											class="inline-flex items-center rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-1 text-xs font-medium whitespace-nowrap text-cyan-400 transition hover:bg-slate-700 hover:text-cyan-300 focus-visible:outline-2 focus-visible:outline-cyan-400"
											aria-label={`Editar equipo ${team.name}`}
										>
											Editar
										</button>
										<button
											type="button"
											onclick={() => requestToggleActive(team)}
											class="inline-flex items-center rounded-lg border border-slate-700 px-2 py-1 text-xs font-medium whitespace-nowrap transition hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-cyan-400 {team.active
												? 'bg-slate-900 text-slate-300 hover:border-red-500/40 hover:bg-red-950/30 hover:text-red-300'
												: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'}"
											aria-label={`${team.active ? 'Desactivar' : 'Activar'} equipo ${team.name}`}
										>
											{team.active ? 'Desactivar' : 'Activar'}
										</button>
									</div>
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="4" class="px-4 py-8 text-center text-sm text-slate-400">
									No hay equipos que coincidan con la búsqueda.
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<!-- Mobile & Tablet Cards View -->
			<div class="mt-6 space-y-3 lg:hidden">
				{#each filteredTeams as team (team.id)}
					<article class="space-y-3 rounded-xl border border-slate-800 bg-slate-950 p-4">
						<div class="flex items-start justify-between gap-2">
							<h3 class="truncate font-semibold text-white" title={team.name}>
								{team.name}
							</h3>
							<span
								class="inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap {team.active
									? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
									: 'border border-slate-700 bg-slate-800 text-slate-400'}"
							>
								{team.active ? 'Activo' : 'Inactivo'}
							</span>
						</div>

						{#if team.description}
							<p class="text-xs text-slate-400">{team.description}</p>
						{/if}

						<div
							class="flex items-center justify-end gap-2 border-t border-slate-800/80 pt-3 text-xs"
						>
							<button
								type="button"
								onclick={() => openEditDialog(team)}
								class="rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1 font-medium text-cyan-400 transition hover:bg-slate-700"
							>
								Editar
							</button>
							<button
								type="button"
								onclick={() => requestToggleActive(team)}
								class="rounded-lg border border-slate-700 px-2.5 py-1 font-medium transition {team.active
									? 'bg-slate-900 text-slate-300 hover:border-red-500/40 hover:bg-red-950/30 hover:text-red-300'
									: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'}"
							>
								{team.active ? 'Desactivar' : 'Activar'}
							</button>
						</div>
					</article>
				{:else}
					<p class="py-6 text-center text-sm text-slate-400">
						No hay equipos que coincidan con la búsqueda.
					</p>
				{/each}
			</div>
		</section>

		<!-- Accessible Creation/Edition Dialog -->
		<dialog
			bind:this={formDialog}
			onclose={closeFormDialog}
			aria-labelledby="team-dialog-title"
			class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
		>
			{#if draft}
				<form onsubmit={handleSave} class="space-y-4">
					<div class="flex items-center justify-between border-b border-slate-800 pb-3">
						<h3 id="team-dialog-title" class="text-base font-semibold text-white">
							{draft.id ? 'Editar equipo' : 'Nuevo equipo'}
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
						<label for="team-name" class="mb-1 block text-xs font-semibold text-slate-300">
							Nombre del equipo (obligatorio)
						</label>
						<input
							id="team-name"
							type="text"
							bind:value={draft.name}
							required
							placeholder="Ej. Soporte, Infraestructura, Aplicaciones"
							class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 transition outline-none focus:border-cyan-400"
						/>
					</div>

					<div>
						<label for="team-description" class="mb-1 block text-xs font-semibold text-slate-300">
							Descripción (opcional)
						</label>
						<textarea
							id="team-description"
							bind:value={draft.description}
							rows="3"
							placeholder="Área de atención, ámbito técnico o funciones..."
							class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 transition outline-none focus:border-cyan-400"
						></textarea>
					</div>

					{#if draft.id}
						<div class="flex items-center gap-2 pt-1">
							<input
								id="team-active"
								type="checkbox"
								bind:checked={draft.active}
								class="h-4 w-4 rounded border-slate-700 bg-slate-950 text-cyan-500 focus:ring-cyan-400"
							/>
							<label for="team-active" class="text-sm text-slate-300 select-none">
								Equipo activo (disponible para nuevas asignaciones y escalados)
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
							Guardar equipo
						</button>
					</div>
				</form>
			{/if}
		</dialog>

		<!-- Confirmation Modal for Deactivation with References (DECISIÓN 4) -->
		<dialog
			bind:this={confirmDialog}
			onclose={closeConfirmDialog}
			aria-labelledby="confirm-team-deactivate-title"
			class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-amber-500/40 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
		>
			{#if pendingDeactivateTeam && pendingReferences}
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
						<h3 id="confirm-team-deactivate-title" class="text-base font-semibold text-white">
							Desactivar equipo {pendingDeactivateTeam.name}
						</h3>
					</div>

					<p class="text-sm text-slate-300">Este equipo está actualmente en uso por:</p>

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

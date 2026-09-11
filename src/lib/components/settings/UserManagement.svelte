<script lang="ts">
	import type { AppUser, AdministrableUserRole } from '$lib/types/user';
	import type { SupportLevel, SupportTeam } from '$lib/types/support';
	import { hasPermission } from '$lib/auth/permissions';
	import {
		createUser,
		updateUser,
		toggleUserActive,
		getOrganizationUsers,
		type SupportContext
	} from '$lib/users/catalog';

	let {
		actor,
		users,
		ready = true,
		error = '',
		availableSupportLevels = [],
		availableTeams = [],
		onchange
	}: {
		actor: AppUser;
		users: AppUser[];
		ready: boolean;
		error?: string;
		availableSupportLevels?: readonly SupportLevel[];
		availableTeams?: readonly SupportTeam[];
		onchange: (next: AppUser[]) => boolean;
	} = $props();

	// Check permission
	const allowed = $derived(hasPermission(actor, 'users:manage'));

	// Filter users belonging to actor's organization (excluding platform_admin)
	const orgUsers = $derived(
		actor.organizationId ? getOrganizationUsers(users, actor.organizationId) : []
	);

	// Filter states
	let searchQuery = $state('');
	let roleFilter = $state<string>('all');
	let statusFilter = $state<string>('all');

	// Form & modal states
	interface UserDraft {
		id?: string;
		name: string;
		email: string;
		role: AdministrableUserRole;
		supportLevel?: SupportLevel | '';
		teamId?: string;
		active: boolean;
	}

	let draft = $state<UserDraft | null>(null);
	let formError = $state('');
	let actionError = $state('');
	let dialogElement = $state<HTMLDialogElement | null>(null);

	const supportContext = $derived<SupportContext>({
		availableLevels: availableSupportLevels,
		availableTeams
	});

	// Filtered users
	const filteredUsers = $derived(
		orgUsers.filter((u) => {
			if (searchQuery.trim()) {
				const query = searchQuery.trim().toLowerCase();
				const matchesName = u.name.toLowerCase().includes(query);
				const matchesEmail = u.email.toLowerCase().includes(query);
				if (!matchesName && !matchesEmail) return false;
			}
			if (roleFilter !== 'all' && u.role !== roleFilter) return false;
			if (statusFilter === 'active' && !u.active) return false;
			if (statusFilter === 'inactive' && u.active) return false;
			return true;
		})
	);

	const roleLabels: Record<AdministrableUserRole, string> = {
		organization_admin: 'Administrador',
		technician: 'Técnico',
		client: 'Cliente'
	};

	function teamName(teamId?: string): string {
		if (!teamId) return '—';
		const team = availableTeams.find((t) => t.id === teamId);
		return team ? team.name : '—';
	}

	function openCreateDialog() {
		if (!allowed || !actor.organizationId) return;
		formError = '';
		actionError = '';
		draft = {
			name: '',
			email: '',
			role: 'technician',
			supportLevel: '',
			teamId: '',
			active: true
		};
		dialogElement?.showModal();
	}

	function openEditDialog(user: AppUser) {
		if (!allowed || user.role === 'platform_admin') return;
		formError = '';
		actionError = '';
		draft = {
			id: user.id,
			name: user.name,
			email: user.email,
			role: user.role as AdministrableUserRole,
			supportLevel:
				user.role === 'technician' || user.role === 'organization_admin'
					? (user.supportLevel ?? '')
					: '',
			teamId:
				user.role === 'technician' || user.role === 'organization_admin' ? (user.teamId ?? '') : '',
			active: user.active
		};
		dialogElement?.showModal();
	}

	function closeDialog() {
		dialogElement?.close();
		draft = null;
		formError = '';
	}

	function handleSave(event: SubmitEvent) {
		event.preventDefault();
		if (!draft || !actor.organizationId) return;

		formError = '';
		actionError = '';

		const isTechnical = draft.role === 'technician' || draft.role === 'organization_admin';

		try {
			let next: AppUser[];
			if (draft.id) {
				next = updateUser(
					actor,
					users,
					{
						id: draft.id,
						name: draft.name,
						email: draft.email,
						role: draft.role,
						supportLevel: isTechnical && draft.supportLevel ? draft.supportLevel : undefined,
						teamId: isTechnical && draft.teamId ? draft.teamId : undefined,
						active: draft.active
					},
					supportContext
				);
			} else {
				next = createUser(
					actor,
					users,
					{
						organizationId: actor.organizationId,
						name: draft.name,
						email: draft.email,
						role: draft.role,
						supportLevel: isTechnical && draft.supportLevel ? draft.supportLevel : undefined,
						teamId: isTechnical && draft.teamId ? draft.teamId : undefined,
						active: draft.active
					},
					supportContext
				);
			}

			if (onchange(next)) {
				closeDialog();
			}
		} catch (err) {
			formError = err instanceof Error ? err.message : 'No se pudo guardar el usuario.';
		}
	}

	function handleToggleActive(user: AppUser) {
		if (!allowed) return;
		actionError = '';
		try {
			const next = toggleUserActive(actor, users, user.id);
			onchange(next);
		} catch (err) {
			actionError =
				err instanceof Error ? err.message : 'No se pudo cambiar el estado del usuario.';
		}
	}
</script>

{#if allowed}
	<div class="user-management space-y-6">
		<!-- Section Header -->
		<section
			aria-labelledby="users-title"
			class="rounded-2xl border border-slate-800 bg-slate-900 p-6"
		>
			<div class="flex flex-wrap items-center justify-between gap-4">
				<div>
					<h2 id="users-title" class="text-lg font-semibold text-white">
						Usuarios de la organización
					</h2>
					<p class="mt-1 text-sm text-slate-400">
						Gestión de técnicos, administradores y clientes de la organización.
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
						<span>Nuevo usuario</span>
					</button>
				{/if}
			</div>

			<!-- Global or Action Error Banner -->
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

			<!-- Filter and Search Bar -->
			<div
				class="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-6"
			>
				<div class="flex min-w-[280px] flex-1 flex-wrap items-center gap-3">
					<!-- Search Input -->
					<div class="relative min-w-[200px] flex-1">
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
							placeholder="Buscar por nombre o email..."
							class="w-full rounded-xl border border-slate-700 bg-slate-950 py-2 pr-4 pl-9 text-sm text-white placeholder-slate-400 transition outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400"
							aria-label="Buscar usuarios"
						/>
					</div>

					<!-- Role Filter -->
					<select
						bind:value={roleFilter}
						class="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white transition outline-none focus:border-cyan-400"
						aria-label="Filtrar por rol"
					>
						<option value="all">Todos los roles</option>
						<option value="organization_admin">Administrador</option>
						<option value="technician">Técnico</option>
						<option value="client">Cliente</option>
					</select>

					<!-- Status Filter -->
					<select
						bind:value={statusFilter}
						class="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white transition outline-none focus:border-cyan-400"
						aria-label="Filtrar por estado"
					>
						<option value="all">Todos los estados</option>
						<option value="active">Activos</option>
						<option value="inactive">Inactivos</option>
					</select>
				</div>

				<span class="text-xs font-medium text-slate-400">
					{filteredUsers.length}
					{filteredUsers.length === 1 ? 'usuario' : 'usuarios'}
				</span>
			</div>

			<!-- Desktop Table View (visible on large screens and up) -->
			<div class="mt-6 hidden overflow-hidden rounded-xl border border-slate-800 lg:block">
				<table class="w-full table-fixed text-left text-sm text-slate-300">
					<thead
						class="border-b border-slate-800 bg-slate-950 text-xs tracking-wider text-slate-400 uppercase"
					>
						<tr>
							<th scope="col" class="w-[18%] px-3 py-3 font-semibold text-slate-400">Nombre</th>
							<th scope="col" class="w-[22%] px-3 py-3 font-semibold text-slate-400">Email</th>
							<th
								scope="col"
								class="w-[15%] px-2.5 py-3 font-semibold whitespace-nowrap text-slate-400"
							>
								Rol
							</th>
							<th
								scope="col"
								class="w-[6%] px-1 py-3 text-center font-semibold whitespace-nowrap text-slate-400"
							>
								Nivel
							</th>
							<th
								scope="col"
								class="w-[12%] px-2.5 py-3 font-semibold whitespace-nowrap text-slate-400"
							>
								Equipo
							</th>
							<th
								scope="col"
								class="w-[9%] px-1.5 py-3 text-center font-semibold whitespace-nowrap text-slate-400"
							>
								Estado
							</th>
							<th
								scope="col"
								class="w-[18%] px-3 py-3 text-right font-semibold whitespace-nowrap text-slate-400"
							>
								Acciones
							</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-slate-800">
						{#each filteredUsers as user (user.id)}
							<tr class="transition hover:bg-slate-800/40">
								<td class="px-3 py-3 font-medium text-white">
									<div class="flex min-w-0 items-center gap-1.5">
										<span class="truncate font-medium text-white" title={user.name}>
											{user.name}
										</span>
										{#if user.id === actor.id}
											<span
												class="inline-flex shrink-0 items-center rounded-md bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-cyan-400 ring-1 ring-cyan-500/30"
											>
												Tú
											</span>
										{/if}
									</div>
								</td>
								<td class="px-3 py-3 text-slate-300">
									<div class="truncate text-slate-300" title={user.email}>
										{user.email}
									</div>
								</td>
								<td class="px-2.5 py-3 whitespace-nowrap">
									<span
										class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap {user.role ===
										'organization_admin'
											? 'border border-purple-500/20 bg-purple-500/10 text-purple-400'
											: user.role === 'technician'
												? 'border border-cyan-500/20 bg-cyan-500/10 text-cyan-400'
												: 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'}"
									>
										{roleLabels[user.role as AdministrableUserRole] ?? user.role}
									</span>
								</td>
								<td class="px-1 py-3 text-center whitespace-nowrap">
									{#if (user.role === 'technician' || user.role === 'organization_admin') && user.supportLevel}
										<span
											class="inline-flex items-center rounded bg-slate-800 px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap text-cyan-300 ring-1 ring-slate-700/50"
										>
											{user.supportLevel}
										</span>
									{:else}
										<span class="whitespace-nowrap text-slate-500">—</span>
									{/if}
								</td>
								<td class="px-2.5 py-3 whitespace-nowrap text-slate-300">
									{#if (user.role === 'technician' || user.role === 'organization_admin') && user.teamId}
										<span class="block truncate align-bottom" title={teamName(user.teamId)}>
											{teamName(user.teamId)}
										</span>
									{:else}
										<span class="whitespace-nowrap text-slate-500">—</span>
									{/if}
								</td>
								<td class="px-1.5 py-3 text-center whitespace-nowrap">
									<span
										class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap {user.active
											? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
											: 'border border-slate-700 bg-slate-800 text-slate-400'}"
									>
										{user.active ? 'Activo' : 'Inactivo'}
									</span>
								</td>
								<td class="px-3 py-3 text-right whitespace-nowrap">
									<div class="flex items-center justify-end gap-1 whitespace-nowrap">
										<button
											type="button"
											onclick={() => openEditDialog(user)}
											class="inline-flex items-center rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-1 text-xs font-medium whitespace-nowrap text-cyan-400 transition hover:bg-slate-700 hover:text-cyan-300 focus-visible:outline-2 focus-visible:outline-cyan-400"
											aria-label={`Editar usuario ${user.name}`}
										>
											Editar
										</button>
										<button
											type="button"
											onclick={() => handleToggleActive(user)}
											disabled={user.id === actor.id && user.active}
											class="inline-flex items-center rounded-lg border border-slate-700 px-2 py-1 text-xs font-medium whitespace-nowrap transition hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:cursor-not-allowed disabled:opacity-40 {user.active
												? 'bg-slate-900 text-slate-300 hover:border-red-500/40 hover:bg-red-950/30 hover:text-red-300'
												: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'}"
											aria-label={`${user.active ? 'Desactivar' : 'Activar'} usuario ${user.name}`}
										>
											{user.active ? 'Desactivar' : 'Activar'}
										</button>
									</div>
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="7" class="px-4 py-8 text-center text-sm text-slate-400">
									No hay usuarios que coincidan con los filtros seleccionados.
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<!-- Mobile & Tablet Cards View (visible below lg breakpoint) -->
			<div class="mt-6 space-y-3 lg:hidden">
				{#each filteredUsers as user (user.id)}
					<article class="space-y-3 rounded-xl border border-slate-800 bg-slate-950 p-4">
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0">
								<h3 class="truncate font-semibold text-white" title={user.name}>
									{user.name}
									{#if user.id === actor.id}
										<span
											class="ml-1.5 inline-flex items-center rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-cyan-400 ring-1 ring-cyan-500/30"
										>
											Tú
										</span>
									{/if}
								</h3>
								<p class="text-xs break-all text-slate-400" title={user.email}>{user.email}</p>
							</div>
							<span
								class="inline-flex shrink-0 items-center rounded-md px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap {user.active
									? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
									: 'border border-slate-700 bg-slate-800 text-slate-400'}"
							>
								{user.active ? 'Activo' : 'Inactivo'}
							</span>
						</div>

						<div class="flex flex-wrap items-center gap-2 pt-1 text-xs text-slate-300">
							<span
								class="inline-flex items-center rounded-md px-2.5 py-0.5 font-semibold whitespace-nowrap {user.role ===
								'organization_admin'
									? 'border border-purple-500/20 bg-purple-500/10 text-purple-400'
									: user.role === 'technician'
										? 'border border-cyan-500/20 bg-cyan-500/10 text-cyan-400'
										: 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'}"
							>
								{roleLabels[user.role as AdministrableUserRole] ?? user.role}
							</span>

							{#if user.role === 'technician' || user.role === 'organization_admin'}
								{#if user.supportLevel}
									<span
										class="inline-flex items-center rounded bg-slate-800 px-2 py-0.5 font-medium whitespace-nowrap text-cyan-300 ring-1 ring-slate-700/50"
									>
										Nivel: {user.supportLevel}
									</span>
								{/if}
								{#if user.teamId}
									<span
										class="inline-flex items-center rounded bg-slate-800 px-2 py-0.5 font-medium whitespace-nowrap text-slate-300 ring-1 ring-slate-700/50"
									>
										{teamName(user.teamId)}
									</span>
								{/if}
							{/if}
						</div>

						<div class="flex items-center justify-end gap-2 border-t border-slate-800/80 pt-3">
							<button
								type="button"
								onclick={() => openEditDialog(user)}
								class="inline-flex items-center rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs font-medium whitespace-nowrap text-cyan-400 transition hover:bg-slate-700 hover:text-cyan-300 focus-visible:outline-2 focus-visible:outline-cyan-400"
								aria-label={`Editar usuario ${user.name}`}
							>
								Editar
							</button>
							<button
								type="button"
								onclick={() => handleToggleActive(user)}
								disabled={user.id === actor.id && user.active}
								class="inline-flex items-center rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium whitespace-nowrap transition hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:cursor-not-allowed disabled:opacity-40 {user.active
									? 'bg-slate-900 text-slate-300 hover:border-red-500/40 hover:bg-red-950/30 hover:text-red-300'
									: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'}"
								aria-label={`${user.active ? 'Desactivar' : 'Activar'} usuario ${user.name}`}
							>
								{user.active ? 'Desactivar' : 'Activar'}
							</button>
						</div>
					</article>
				{:else}
					<p class="py-6 text-center text-sm text-slate-400">
						No hay usuarios que coincidan con los filtros seleccionados.
					</p>
				{/each}
			</div>
		</section>

		<!-- Accessible Creation/Edition Dialog -->
		<dialog
			bind:this={dialogElement}
			onclose={closeDialog}
			aria-labelledby="user-dialog-title"
			class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
		>
			{#if draft}
				<form onsubmit={handleSave} class="space-y-4">
					<div class="flex items-center justify-between border-b border-slate-800 pb-3">
						<h3 id="user-dialog-title" class="text-base font-semibold text-white">
							{draft.id ? 'Editar usuario' : 'Nuevo usuario'}
						</h3>
						<button
							type="button"
							onclick={closeDialog}
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

					{#if formError}
						<div
							role="alert"
							class="rounded-lg border border-red-800/40 bg-red-950/40 p-3 text-sm text-red-400"
						>
							{formError}
						</div>
					{/if}

					<div>
						<label for="user-name" class="mb-1 block text-xs font-semibold text-slate-300">
							Nombre completo (obligatorio)
						</label>
						<input
							id="user-name"
							type="text"
							bind:value={draft.name}
							required
							placeholder="Ej. Laura García"
							class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 transition outline-none focus:border-cyan-400"
						/>
					</div>

					<div>
						<label for="user-email" class="mb-1 block text-xs font-semibold text-slate-300">
							Correo electrónico (obligatorio)
						</label>
						<input
							id="user-email"
							type="email"
							bind:value={draft.email}
							required
							placeholder="Ej. laura@empresa.com"
							class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 transition outline-none focus:border-cyan-400"
						/>
					</div>

					<div>
						<label for="user-role" class="mb-1 block text-xs font-semibold text-slate-300">
							Rol
						</label>
						<select
							id="user-role"
							bind:value={draft.role}
							class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white transition outline-none focus:border-cyan-400"
						>
							<option value="organization_admin">Administrador de organización</option>
							<option value="technician">Técnico</option>
							<option value="client">Cliente</option>
						</select>
					</div>

					<!-- Dynamic technical fields (for technician and organization_admin) -->
					{#if draft.role === 'technician' || draft.role === 'organization_admin'}
						<div class="space-y-4 rounded-xl border border-cyan-500/20 bg-cyan-950/10 p-4">
							<div>
								<p class="text-xs font-semibold tracking-wider text-cyan-300 uppercase">
									Parámetros operativos técnicos
								</p>
								{#if draft.role === 'organization_admin'}
									<p class="mt-1 text-xs text-slate-400">
										Opcional. Permite que este administrador participe también en la atención de
										incidencias.
									</p>
								{/if}
							</div>

							<div>
								<label for="user-level" class="mb-1 block text-xs font-medium text-slate-300">
									Nivel de soporte
								</label>
								<select
									id="user-level"
									bind:value={draft.supportLevel}
									class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white transition outline-none focus:border-cyan-400"
								>
									<option value="">Sin nivel asignado</option>
									{#each availableSupportLevels as level (level)}
										<option value={level}>{level}</option>
									{/each}
								</select>
							</div>

							<div>
								<label for="user-team" class="mb-1 block text-xs font-medium text-slate-300">
									Equipo técnico
								</label>
								<select
									id="user-team"
									bind:value={draft.teamId}
									class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white transition outline-none focus:border-cyan-400"
								>
									<option value="">Sin equipo asignado</option>
									{#each availableTeams.filter((t) => t.active && t.organizationId === actor.organizationId) as team (team.id)}
										<option value={team.id}>{team.name}</option>
									{/each}
								</select>
							</div>
						</div>
					{/if}

					{#if draft.id}
						<div class="flex items-center gap-2 pt-1">
							<input
								id="user-active"
								type="checkbox"
								bind:checked={draft.active}
								disabled={draft.id === actor.id && draft.active}
								class="h-4 w-4 rounded border-slate-700 bg-slate-950 text-cyan-500 focus:ring-cyan-400"
							/>
							<label for="user-active" class="text-sm text-slate-300 select-none">
								Usuario activo
								{#if draft.id === actor.id}
									<span class="text-xs text-slate-500">(no puedes desactivarte a ti mismo)</span>
								{/if}
							</label>
						</div>
					{/if}

					<div class="flex items-center justify-end gap-3 border-t border-slate-800 pt-4">
						<button
							type="button"
							onclick={closeDialog}
							class="rounded-xl px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white"
						>
							Cancelar
						</button>
						<button
							type="submit"
							class="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 focus-visible:outline-2 focus-visible:outline-cyan-400"
						>
							Guardar usuario
						</button>
					</div>
				</form>
			{/if}
		</dialog>
	</div>
{/if}

<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { signOut } from '$lib/api/auth';
	import {
		createClient,
		listClients,
		setClientActive,
		updateClient,
		type Client,
		ClientApiError
	} from '$lib/api/clients';
	import { useOrganizationContext } from '$lib/app/context';
	import { presentApiError } from '$lib/app/error-presentation';
	import { attemptSignOut, SIGN_OUT_FAILED_MESSAGE } from '$lib/app/sign-out';
	import { session } from '$lib/stores/session';
	import AppShell from '$lib/components/shell/AppShell.svelte';
	import OrganizationGate from '$lib/components/shell/OrganizationGate.svelte';
	import Alert from '$lib/ui/Alert.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import Field from '$lib/ui/Field.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import Input from '$lib/ui/Input.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';
	import Textarea from '$lib/ui/Textarea.svelte';

	const context = useOrganizationContext();
	const explicitOrganization = $derived(page.url.searchParams.get('organizationId'));

	let signingOut = $state(false);
	let signOutError = $state<string | null>(null);

	// Client list state
	let clients = $state<Client[]>([]);
	let loading = $state(true);
	let fetchError = $state<string | null>(null);
	let fetchRequestId = $state<string | undefined>(undefined);

	// Filters
	let searchQuery = $state('');
	let statusFilter = $state<'all' | 'active' | 'inactive'>('all');

	// Create/Edit Dialog state
	let dialogMode = $state<'closed' | 'create' | 'edit'>('closed');
	let editingClient = $state<Client | null>(null);
	let formName = $state('');
	let formDescription = $state('');
	let formError = $state<string | null>(null);
	let formSubmitting = $state(false);

	// Action in progress (activation/deactivation by clientId)
	let togglingId = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	let abortController: AbortController | null = null;

	const ready = $derived($context.status === 'ready');
	const capabilities = $derived(ready ? $context.capabilities : []);
	const activeOrg = $derived(ready ? $context.activeOrganization : null);
	const canManage = $derived(capabilities.includes('clients:manage'));

	function expireSession() {
		session.clearSession();
		void goto(resolve('/login?expired=true'));
	}

	async function loadClients(orgId: string) {
		abortController?.abort();
		abortController = new AbortController();
		const signal = abortController.signal;

		loading = true;
		fetchError = null;
		fetchRequestId = undefined;

		try {
			const result = await listClients({ organizationId: orgId, signal });
			if (!signal.aborted) {
				clients = result;
				loading = false;
			}
		} catch (err) {
			if (signal.aborted) return;
			loading = false;
			if (err instanceof ClientApiError && err.status === 401) {
				expireSession();
				return;
			}
			const presented = presentApiError(err);
			fetchError = presented.message;
			fetchRequestId = presented.requestId;
		}
	}

	onDestroy(() => {
		abortController?.abort();
	});

	// Sync organization context from URL
	$effect(() => {
		const explicit = explicitOrganization;
		untrack(() => {
			const current = context.get();
			if (explicit && current.status === 'ready' && current.activeOrganizationId === explicit)
				return;
			void context.load(explicit);
		});
	});

	// Load clients whenever active organization changes
	$effect(() => {
		if ($context.status === 'unauthenticated') {
			expireSession();
			return;
		}
		if (ready && $context.activeOrganizationId && canManage) {
			const orgId = $context.activeOrganizationId;
			untrack(() => {
				void loadClients(orgId);
			});
		}
	});

	const filteredClients = $derived.by(() => {
		let list = clients;
		if (statusFilter === 'active') {
			list = list.filter((c) => c.active);
		} else if (statusFilter === 'inactive') {
			list = list.filter((c) => !c.active);
		}

		const query = searchQuery.trim().toLowerCase();
		if (query) {
			list = list.filter(
				(c) =>
					c.name.toLowerCase().includes(query) ||
					(c.description && c.description.toLowerCase().includes(query))
			);
		}
		return list;
	});

	function openCreateDialog() {
		dialogMode = 'create';
		editingClient = null;
		formName = '';
		formDescription = '';
		formError = null;
	}

	function openEditDialog(client: Client) {
		dialogMode = 'edit';
		editingClient = client;
		formName = client.name;
		formDescription = client.description || '';
		formError = null;
	}

	function closeDialog() {
		if (formSubmitting) return;
		dialogMode = 'closed';
		editingClient = null;
		formName = '';
		formDescription = '';
		formError = null;
	}

	async function handleSaveClient(e: SubmitEvent) {
		e.preventDefault();
		if (!activeOrg) return;
		const nameTrimmed = formName.trim();
		if (!nameTrimmed) {
			formError = 'El nombre del cliente es obligatorio.';
			return;
		}

		formSubmitting = true;
		formError = null;

		try {
			if (dialogMode === 'create') {
				const created = await createClient({
					organizationId: activeOrg.id,
					name: nameTrimmed,
					description: formDescription.trim() || undefined
				});
				clients = [...clients, created].sort((a, b) => a.name.localeCompare(b.name));
				dialogMode = 'closed';
			} else if (dialogMode === 'edit' && editingClient) {
				const updated = await updateClient({
					organizationId: activeOrg.id,
					clientId: editingClient.id,
					name: nameTrimmed,
					description: formDescription.trim() || null
				});
				clients = clients
					.map((c) => (c.id === updated.id ? updated : c))
					.sort((a, b) => a.name.localeCompare(b.name));
				dialogMode = 'closed';
			}
		} catch (err) {
			if (err instanceof ClientApiError && err.status === 401) {
				expireSession();
				return;
			}
			formError = presentApiError(err).message;
		} finally {
			formSubmitting = false;
		}
	}

	async function handleToggleActive(client: Client) {
		if (!activeOrg || !canManage || togglingId) return;
		togglingId = client.id;
		actionError = null;

		try {
			const updated = await setClientActive({
				organizationId: activeOrg.id,
				clientId: client.id,
				active: !client.active
			});
			clients = clients.map((c) => (c.id === updated.id ? updated : c));
		} catch (err) {
			if (err instanceof ClientApiError && err.status === 401) {
				expireSession();
				return;
			}
			actionError = presentApiError(err).message;
		} finally {
			togglingId = null;
		}
	}

	function changeOrganization(id: string) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(resolve('/app/admin/clients') + `?organizationId=${encodeURIComponent(id)}`);
	}

	async function leave() {
		if (signingOut) return;
		signOutError = null;
		signingOut = true;
		const result = await attemptSignOut(() => signOut());
		signingOut = false;
		if (!result.ok) {
			signOutError = SIGN_OUT_FAILED_MESSAGE;
			return;
		}
		session.clearSession();
		await goto(resolve('/login'));
	}

	function formatDate(iso: string) {
		try {
			return new Date(iso).toLocaleDateString('es-ES', {
				year: 'numeric',
				month: 'short',
				day: 'numeric'
			});
		} catch {
			return iso;
		}
	}
</script>

<svelte:head>
	<title>Clientes · SoporteFlow</title>
</svelte:head>

<!-- eslint-disable svelte/no-navigation-without-resolve -- hrefs are built from resolve() -->
<AppShell
	context={$context}
	title="Clientes"
	current="admin-clients"
	{signingOut}
	{signOutError}
	onOrganizationChange={changeOrganization}
	onSignOut={leave}
>
	<OrganizationGate context={$context} onretry={() => void context.load(explicitOrganization)}>
		<div class="sf-clients-container">
			<PageHeader
				title="Clientes"
				description="Gestión y catálogo de cuentas o empresas atendidas en {activeOrg?.name ??
					'la organización'}."
			>
				{#snippet actions()}
					{#if canManage}
						<Button variant="primary" onclick={openCreateDialog}>
							<Icon name="plus" size={16} />
							<span>Nuevo cliente</span>
						</Button>
					{/if}
				{/snippet}
			</PageHeader>

			{#if !canManage}
				<div class="sf-guard-box">
					<EmptyState
						title="Acceso restringido"
						description="No dispones de permisos de administración para gestionar clientes en esta organización."
					/>
				</div>
			{:else}
				{#if actionError}
					<div class="sf-alert-wrap">
						<Alert tone="danger" title="Error en la operación">
							<p>{actionError}</p>
						</Alert>
					</div>
				{/if}

				<!-- Barra de búsqueda y filtros -->
				<div class="sf-toolbar">
					<div class="sf-search-wrap">
						<input
							type="search"
							class="sf-search-input"
							bind:value={searchQuery}
							placeholder="Buscar por nombre o descripción…"
							aria-label="Buscar clientes"
						/>
					</div>
					<div class="sf-segmented-group" role="group" aria-label="Filtro por estado">
						<button
							type="button"
							class="sf-tab-btn"
							class:active={statusFilter === 'all'}
							onclick={() => (statusFilter = 'all')}
						>
							Todos ({clients.length})
						</button>
						<button
							type="button"
							class="sf-tab-btn"
							class:active={statusFilter === 'active'}
							onclick={() => (statusFilter = 'active')}
						>
							Activos ({clients.filter((c) => c.active).length})
						</button>
						<button
							type="button"
							class="sf-tab-btn"
							class:active={statusFilter === 'inactive'}
							onclick={() => (statusFilter = 'inactive')}
						>
							Inactivos ({clients.filter((c) => !c.active).length})
						</button>
					</div>
				</div>

				<!-- Contenido principal: Loading / Error / Empty / Table -->
				{#if loading}
					<div class="sf-loading-box" role="status">
						<Spinner size="md" />
						<p>Cargando catálogo de clientes…</p>
					</div>
				{:else if fetchError}
					<div class="sf-error-box" role="alert">
						<Alert
							tone="danger"
							title="No se pudieron cargar los clientes"
							requestId={fetchRequestId}
						>
							<p>{fetchError}</p>
							{#snippet actions()}
								<Button
									variant="secondary"
									size="sm"
									onclick={() => activeOrg && loadClients(activeOrg.id)}
								>
									Reintentar
								</Button>
							{/snippet}
						</Alert>
					</div>
				{:else if filteredClients.length === 0}
					<div class="sf-empty-box">
						{#if searchQuery.trim() || statusFilter !== 'all'}
							<EmptyState
								title="No se encontraron clientes"
								description="No hay clientes que coincidan con los filtros aplicados."
							>
								{#snippet action()}
									<Button
										variant="secondary"
										size="sm"
										onclick={() => {
											searchQuery = '';
											statusFilter = 'all';
										}}
									>
										Limpiar filtros
									</Button>
								{/snippet}
							</EmptyState>
						{:else}
							<EmptyState
								title="Sin clientes registrados"
								description="Añade los clientes y empresas atendidas para poder seleccionarlos al crear incidencias."
							>
								{#snippet action()}
									{#if canManage}
										<Button variant="primary" onclick={openCreateDialog}>
											<Icon name="plus" size={16} />
											<span>Crear primer cliente</span>
										</Button>
									{/if}
								{/snippet}
							</EmptyState>
						{/if}
					</div>
				{:else}
					<div class="sf-table-wrapper">
						<table class="sf-clients-table">
							<thead>
								<tr>
									<th scope="col">Nombre</th>
									<th scope="col">Descripción</th>
									<th scope="col">Estado</th>
									<th scope="col">Fecha de alta</th>
									{#if canManage}
										<th scope="col" class="sf-col-actions">Acciones</th>
									{/if}
								</tr>
							</thead>
							<tbody>
								{#each filteredClients as client (client.id)}
									<tr class:sf-row-inactive={!client.active}>
										<td class="sf-cell-name">
											<span class="sf-name-text">{client.name}</span>
										</td>
										<td class="sf-cell-desc">
											{#if client.description}
												<span class="sf-desc-text">{client.description}</span>
											{:else}
												<span class="sf-empty-field">—</span>
											{/if}
										</td>
										<td class="sf-cell-status">
											{#if client.active}
												<Badge tone="success">Activo</Badge>
											{:else}
												<Badge tone="neutral">Inactivo</Badge>
											{/if}
										</td>
										<td class="sf-cell-date">
											{formatDate(client.createdAt)}
										</td>
										{#if canManage}
											<td class="sf-cell-actions">
												<div class="sf-actions-group">
													<Button
														variant="secondary"
														size="sm"
														onclick={() => openEditDialog(client)}
														ariaLabel="Editar {client.name}"
													>
														<span>Editar</span>
													</Button>
													<Button
														variant={client.active ? 'secondary' : 'primary'}
														size="sm"
														disabled={togglingId === client.id}
														onclick={() => handleToggleActive(client)}
														ariaLabel={client.active
															? `Desactivar ${client.name}`
															: `Activar ${client.name}`}
													>
														{#if togglingId === client.id}
															<Spinner size="sm" />
														{:else}
															<span>{client.active ? 'Desactivar' : 'Activar'}</span>
														{/if}
													</Button>
												</div>
											</td>
										{/if}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			{/if}
		</div>
	</OrganizationGate>
</AppShell>

<!-- Diálogo modal de Crear / Editar cliente -->
{#if dialogMode !== 'closed'}
	<div
		class="sf-modal-backdrop"
		role="presentation"
		onclick={(e) => e.target === e.currentTarget && closeDialog()}
	>
		<div
			class="sf-modal-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="client-dialog-title"
		>
			<header class="sf-modal-header">
				<h2 id="client-dialog-title" class="sf-modal-title">
					{dialogMode === 'create' ? 'Nuevo cliente' : 'Editar cliente'}
				</h2>
				<button
					type="button"
					class="sf-modal-close"
					aria-label="Cerrar modal"
					onclick={closeDialog}
				>
					✕
				</button>
			</header>

			<form onsubmit={handleSaveClient} class="sf-modal-form">
				{#if formError}
					<Alert tone="danger" title="Error en el formulario">
						<p>{formError}</p>
					</Alert>
				{/if}

				<Field
					label="Nombre del cliente o empresa"
					required
					hint="Nombre representativo (ej. Nodhouses, IV Pediatría)"
				>
					{#snippet children(control)}
						<Input
							{control}
							bind:value={formName}
							placeholder="Introduce el nombre"
							maxlength={255}
							disabled={formSubmitting}
						/>
					{/snippet}
				</Field>

				<Field
					label="Descripción o notas"
					hint="Información de contacto, referencia fiscal o datos adicionales (opcional)"
				>
					{#snippet children(control)}
						<Textarea
							{control}
							bind:value={formDescription}
							placeholder="Notas adicionales…"
							rows={3}
							disabled={formSubmitting}
						/>
					{/snippet}
				</Field>

				<footer class="sf-modal-footer">
					<Button type="button" variant="secondary" disabled={formSubmitting} onclick={closeDialog}>
						Cancelar
					</Button>
					<Button type="submit" variant="primary" disabled={formSubmitting}>
						{#if formSubmitting}
							<Spinner size="sm" />
							<span>Guardando…</span>
						{:else}
							<span>{dialogMode === 'create' ? 'Crear cliente' : 'Guardar cambios'}</span>
						{/if}
					</Button>
				</footer>
			</form>
		</div>
	</div>
{/if}

<style>
	.sf-clients-container {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}

	.sf-guard-box,
	.sf-alert-wrap,
	.sf-error-box,
	.sf-empty-box {
		width: 100%;
	}

	.sf-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
	}

	.sf-search-wrap {
		flex: 1;
		min-width: 260px;
		max-width: 480px;
	}

	.sf-search-input {
		width: 100%;
		height: 2.5rem;
		padding: 0 0.875rem;
		font-size: var(--text-sm);
		color: var(--text);
		background-color: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		transition:
			border-color 0.15s ease-in-out,
			box-shadow 0.15s ease-in-out;
	}

	.sf-search-input:focus {
		outline: none;
		border-color: var(--sf-cyan-500);
		box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.15);
	}

	.sf-segmented-group {
		display: inline-flex;
		padding: 3px;
		background: var(--surface-muted);
		border-radius: var(--radius);
		border: 1px solid var(--border);
	}

	.sf-tab-btn {
		background: transparent;
		border: none;
		border-radius: calc(var(--radius) - 2px);
		padding: var(--space-1) var(--space-3);
		font-size: var(--text-xs);
		font-weight: 500;
		color: var(--text-muted);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.sf-tab-btn:hover {
		color: var(--text);
	}

	.sf-tab-btn.active {
		background: var(--surface-card);
		color: var(--text-emphasis);
		font-weight: 600;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
	}

	.sf-loading-box {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-3);
		padding: var(--space-12) var(--space-4);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	.sf-table-wrapper {
		background: var(--surface-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		overflow: hidden;
		box-shadow: var(--sf-shadow-card);
	}

	.sf-clients-table {
		width: 100%;
		border-collapse: collapse;
		text-align: left;
		font-size: var(--text-sm);
	}

	.sf-clients-table th {
		background: var(--surface-subtle);
		color: var(--text-muted);
		font-weight: 600;
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--border);
	}

	.sf-clients-table td {
		padding: var(--space-3-5) var(--space-4);
		border-bottom: 1px solid var(--border-subtle);
		vertical-align: middle;
	}

	.sf-clients-table tbody tr:last-child td {
		border-bottom: none;
	}

	.sf-clients-table tbody tr:hover {
		background-color: var(--surface-hover);
	}

	.sf-row-inactive {
		opacity: 0.75;
		background: var(--surface-muted);
	}

	.sf-cell-name {
		font-weight: 600;
		color: var(--text-emphasis);
	}

	.sf-cell-desc {
		color: var(--text-muted);
		max-width: 320px;
	}

	.sf-desc-text {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sf-empty-field {
		color: var(--text-subtle);
	}

	.sf-cell-date {
		color: var(--text-muted);
		font-size: var(--text-xs);
		white-space: nowrap;
	}

	.sf-col-actions {
		text-align: right;
	}

	.sf-cell-actions {
		text-align: right;
		white-space: nowrap;
	}

	.sf-actions-group {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
	}

	/* Modal Dialog */
	.sf-modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(15, 23, 42, 0.6);
		backdrop-filter: blur(2px);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		z-index: 50;
	}

	.sf-modal-dialog {
		background: var(--surface-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		box-shadow: var(--sf-shadow-modal);
		width: 100%;
		max-width: 520px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.sf-modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-4) var(--space-6);
		border-bottom: 1px solid var(--border);
	}

	.sf-modal-title {
		font-size: var(--text-lg);
		font-weight: 700;
		color: var(--text-emphasis);
		margin: 0;
	}

	.sf-modal-close {
		background: transparent;
		border: none;
		font-size: 1.25rem;
		color: var(--text-muted);
		cursor: pointer;
		padding: var(--space-1);
		line-height: 1;
		border-radius: var(--radius);
	}

	.sf-modal-close:hover {
		color: var(--text);
	}

	.sf-modal-form {
		padding: var(--space-6);
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.sf-modal-footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-3);
		margin-top: var(--space-4);
		padding-top: var(--space-4);
		border-top: 1px solid var(--border-subtle);
	}
</style>

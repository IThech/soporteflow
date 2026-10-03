<script lang="ts">
	import { focusTrap } from '$lib/ui/focus-trap';
	import { onDestroy, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { signOut } from '$lib/api/auth';
	import {
		createSlaPolicy,
		listSlaPolicies,
		updateSlaPolicy,
		type SlaPolicy,
		SlaPolicyApiError
	} from '$lib/api/sla-policies';
	import { useOrganizationContext } from '$lib/app/context';
	import { presentApiError } from '$lib/app/error-presentation';
	import {
		DURATION_UNITS,
		SLA_CODE_MAX_LENGTH,
		SLA_NAME_MAX_LENGTH,
		SLA_POLICY_FIELD_ORDER,
		draftFromPolicy,
		emptySlaPolicyDraft,
		formatSlaDuration,
		slaPolicyErrorField,
		toCreateSlaPolicy,
		toSlaPolicyPatch,
		validateSlaPolicyDraft,
		type SlaPolicyDraft,
		type SlaPolicyErrors,
		type SlaPolicyField
	} from '$lib/app/sla-policy-form';
	import { sameTenant, tenantIdentityOf } from '$lib/app/tenant-identity';
	import { attemptSignOut, SESSION_EXPIRED_PATH, SIGN_OUT_FAILED_MESSAGE } from '$lib/app/sign-out';
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
	import Select from '$lib/ui/Select.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';
	import Textarea from '$lib/ui/Textarea.svelte';

	/**
	 * Administración -> Políticas SLA (SLA-1A). Same structure and hardening as Clientes/Sedes:
	 * the existing /api/sla-policies is the authority (sla:view lists, sla:manage mutates); no
	 * delete (deactivate instead); code immutable after creation; at most one default policy,
	 * always active, and optional. After a mutation the list is re-read from the server, because a
	 * default switch or deactivating the default also changes other rows (the backend does that
	 * atomically; the UI never re-implements it).
	 */
	const context = useOrganizationContext();
	const explicitOrganization = $derived(page.url.searchParams.get('organizationId'));

	let signingOut = $state(false);
	let signOutError = $state<string | null>(null);

	let policies = $state<SlaPolicy[]>([]);
	let loading = $state(true);
	let fetchError = $state<string | null>(null);
	let fetchRequestId = $state<string | undefined>(undefined);

	let searchQuery = $state('');
	let statusFilter = $state<'all' | 'active' | 'inactive'>('all');

	let dialogMode = $state<'closed' | 'create' | 'edit'>('closed');
	let editingPolicy = $state<SlaPolicy | null>(null);
	let draft = $state<SlaPolicyDraft>(emptySlaPolicyDraft());
	let fieldErrors = $state<SlaPolicyErrors>({});
	let formError = $state<string | null>(null);
	let formSubmitting = $state(false);
	let triggerElement = $state<HTMLElement | null>(null);
	let newPolicyAnchor = $state<HTMLElement | null>(null);
	const controls: Partial<Record<SlaPolicyField, HTMLElement | null>> = $state({});

	let togglingId = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	let abortController: AbortController | null = null;

	const ready = $derived($context.status === 'ready');
	const capabilities = $derived(ready ? $context.capabilities : []);
	const activeOrg = $derived(ready ? $context.activeOrganization : null);
	// Listing needs sla:view (GET /api/sla-policies); mutations also need sla:manage.
	const canView = $derived(capabilities.includes('sla:view'));
	const canManage = $derived(canView && capabilities.includes('sla:manage'));

	function expireSession() {
		session.clearSession();
		void goto(resolve(SESSION_EXPIRED_PATH));
	}

	/** A mutation's outcome (data, error or 401) applies only if user/org/generation are unchanged. */
	function isCurrentTenant(started: ReturnType<typeof tenantIdentityOf>): boolean {
		return started !== null && sameTenant(started, tenantIdentityOf(context.get()));
	}

	/** The open dialog belonged to the previous tenant: drop it instead of re-submitting there. */
	function discardStaleDialog() {
		dialogMode = 'closed';
		editingPolicy = null;
		formError = null;
		fieldErrors = {};
		triggerElement = null;
	}

	/** `silent`: keep the current rows while re-reading after a mutation (no spinner flash). */
	async function loadPolicies(orgId: string, silent = false) {
		abortController?.abort();
		abortController = new AbortController();
		const signal = abortController.signal;
		if (!silent) loading = true;
		fetchError = null;
		fetchRequestId = undefined;
		try {
			const result = await listSlaPolicies({ organizationId: orgId, signal });
			if (!signal.aborted) {
				policies = result;
				loading = false;
			}
		} catch (err) {
			if (signal.aborted) return;
			loading = false;
			if (err instanceof SlaPolicyApiError && err.status === 401) {
				expireSession();
				return;
			}
			const presented = presentApiError(err);
			if (silent) {
				actionError = `Los cambios se guardaron, pero no se pudo actualizar el listado: ${presented.message}`;
			} else {
				fetchError = presented.message;
				fetchRequestId = presented.requestId;
			}
		}
	}

	onDestroy(() => {
		abortController?.abort();
	});

	$effect(() => {
		const explicit = explicitOrganization;
		untrack(() => {
			const current = context.get();
			if (explicit && current.status === 'ready' && current.activeOrganizationId === explicit)
				return;
			void context.load(explicit);
		});
	});

	$effect(() => {
		if ($context.status === 'unauthenticated') {
			expireSession();
			return;
		}
		if (ready && $context.activeOrganizationId && canView) {
			const orgId = $context.activeOrganizationId;
			untrack(() => {
				void loadPolicies(orgId);
			});
		}
	});

	const defaultPolicy = $derived(policies.find((p) => p.isDefault) ?? null);

	const filteredPolicies = $derived.by(() => {
		let list = policies;
		if (statusFilter === 'active') list = list.filter((p) => p.active);
		else if (statusFilter === 'inactive') list = list.filter((p) => !p.active);
		const query = searchQuery.trim().toLowerCase();
		if (query)
			list = list.filter(
				(p) => p.name.toLowerCase().includes(query) || p.code.toLowerCase().includes(query)
			);
		return list;
	});

	function openCreateDialog(e?: MouseEvent) {
		triggerElement = (e?.currentTarget as HTMLElement) ?? null;
		dialogMode = 'create';
		editingPolicy = null;
		draft = emptySlaPolicyDraft();
		fieldErrors = {};
		formError = null;
	}

	function openEditDialog(policy: SlaPolicy, e?: MouseEvent) {
		triggerElement = (e?.currentTarget as HTMLElement) ?? null;
		dialogMode = 'edit';
		editingPolicy = policy;
		draft = draftFromPolicy(policy);
		fieldErrors = {};
		formError = null;
	}

	function closeDialog() {
		if (formSubmitting) return;
		dialogMode = 'closed';
		editingPolicy = null;
		draft = emptySlaPolicyDraft();
		fieldErrors = {};
		formError = null;
		triggerElement?.focus();
		triggerElement = null;
	}

	$effect(() => {
		if (dialogMode !== 'closed') {
			setTimeout(() => {
				controls.name?.focus();
			}, 30);
		}
	});

	// A default policy is always active: unchecking "Activa" also unchecks "Por defecto".
	$effect(() => {
		if (!draft.active && draft.isDefault) draft.isDefault = false;
	});

	/**
	 * After the list is re-read, the element that had the focus may be gone (the empty-state
	 * button once the first policy exists, or a row hidden by the active filter): keep the focus
	 * on the page instead of dropping it to <body>.
	 */
	async function keepFocus(previous: HTMLElement | null) {
		await tick();
		if (previous?.isConnected) return;
		newPolicyAnchor?.querySelector<HTMLElement>('button')?.focus();
	}

	async function focusFirstInvalid(errors: SlaPolicyErrors) {
		const first = SLA_POLICY_FIELD_ORDER.find((field) => errors[field]);
		if (!first) return;
		await tick();
		controls[first]?.focus();
	}

	async function handleSave(e: SubmitEvent) {
		e.preventDefault();
		if (!activeOrg || formSubmitting) return;
		if (!canManage) return;
		const mode = dialogMode === 'edit' ? 'edit' : 'create';
		const checked = validateSlaPolicyDraft(draft, mode);
		if (!checked.ok) {
			fieldErrors = checked.errors;
			formError = null;
			void focusFirstInvalid(checked.errors);
			return;
		}
		fieldErrors = {};
		formError = null;

		let patch: ReturnType<typeof toSlaPolicyPatch> | null = null;
		if (mode === 'edit') {
			if (!editingPolicy) return;
			patch = toSlaPolicyPatch(editingPolicy, checked.value);
			if (Object.keys(patch).length === 0) {
				closeDialog();
				return;
			}
		}

		const tenant = tenantIdentityOf(context.get());
		const orgId = activeOrg.id;
		formSubmitting = true;
		try {
			if (mode === 'create') {
				await createSlaPolicy({ organizationId: orgId, policy: toCreateSlaPolicy(checked.value) });
			} else if (editingPolicy && patch) {
				await updateSlaPolicy({ organizationId: orgId, policyId: editingPolicy.id, patch });
			}
			if (!isCurrentTenant(tenant)) return discardStaleDialog();
			const trigger = triggerElement;
			formSubmitting = false;
			closeDialog();
			await loadPolicies(orgId, true);
			await keepFocus(trigger);
		} catch (err) {
			if (!isCurrentTenant(tenant)) return discardStaleDialog();
			if (err instanceof SlaPolicyApiError && err.status === 401) {
				expireSession();
				return;
			}
			const presented = presentApiError(err);
			const field = err instanceof SlaPolicyApiError ? slaPolicyErrorField(err.code) : null;
			if (field) {
				fieldErrors = { [field]: presented.message };
				void focusFirstInvalid(fieldErrors);
			} else {
				formError = presented.message;
			}
		} finally {
			formSubmitting = false;
		}
	}

	async function handleToggleActive(policy: SlaPolicy, e?: MouseEvent) {
		if (!activeOrg || !canManage || togglingId) return;
		const tenant = tenantIdentityOf(context.get());
		const orgId = activeOrg.id;
		const trigger = (e?.currentTarget as HTMLElement) ?? null;
		togglingId = policy.id;
		actionError = null;
		try {
			await updateSlaPolicy({
				organizationId: orgId,
				policyId: policy.id,
				patch: { active: !policy.active }
			});
			if (!isCurrentTenant(tenant)) return;
			await loadPolicies(orgId, true);
			await keepFocus(trigger);
		} catch (err) {
			if (!isCurrentTenant(tenant)) return;
			if (err instanceof SlaPolicyApiError && err.status === 401) {
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
		void goto(resolve('/app/admin/sla-policies') + `?organizationId=${encodeURIComponent(id)}`);
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

	const adminHref = $derived(
		activeOrg
			? `${resolve('/app/admin')}?organizationId=${encodeURIComponent(activeOrg.id)}`
			: resolve('/app/admin')
	);

	const unitOptions = DURATION_UNITS.map((unit) => ({ value: unit.value, label: unit.label }));
	const uid = $props.id();
</script>

<svelte:head>
	<title>Políticas SLA · SoporteFlow</title>
</svelte:head>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && dialogMode !== 'closed') closeDialog();
	}}
/>

{#snippet duration(
	legend: string,
	hint: string,
	field: 'firstResponse' | 'resolution',
	valueKey: 'firstResponseValue' | 'resolutionValue',
	unitKey: 'firstResponseUnit' | 'resolutionUnit'
)}
	<fieldset class="sf-duration" aria-describedby="{uid}-{field}-hint">
		<legend class="sf-duration-legend">
			{legend}<span class="sf-required" aria-hidden="true">*</span>
		</legend>
		<div class="sf-duration-row">
			<Field label="Valor" required error={fieldErrors[field]}>
				{#snippet children(control)}
					<Input
						{control}
						bind:element={controls[field]}
						bind:value={draft[valueKey]}
						placeholder="Ej. 4"
						maxlength={7}
						disabled={formSubmitting}
					/>
				{/snippet}
			</Field>
			<Field label="Unidad">
				{#snippet children(control)}
					<Select
						{control}
						bind:value={draft[unitKey]}
						options={unitOptions}
						disabled={formSubmitting}
					/>
				{/snippet}
			</Field>
		</div>
		<p class="sf-duration-hint" id="{uid}-{field}-hint">{hint}</p>
	</fieldset>
{/snippet}

<!-- eslint-disable svelte/no-navigation-without-resolve -- hrefs are built from resolve() -->
<AppShell
	context={$context}
	title="Políticas SLA"
	current="admin"
	{signingOut}
	{signOutError}
	onOrganizationChange={changeOrganization}
	onSignOut={leave}
>
	<OrganizationGate context={$context} onretry={() => void context.load(explicitOrganization)}>
		<div class="sf-sla-container">
			<nav class="sf-breadcrumb" aria-label="Ruta de navegación">
				<ol>
					<li><a href={adminHref}>Administración</a></li>
					<li aria-current="page">Políticas SLA</li>
				</ol>
			</nav>
			<PageHeader
				title="Políticas SLA"
				description="Tiempos objetivo de primera respuesta y resolución (24x7) que se aplican a las incidencias de {activeOrg?.name ??
					'la organización'}."
			>
				{#snippet actions()}
					{#if canManage}
						<span class="sf-new-policy" bind:this={newPolicyAnchor}>
							<Button variant="primary" onclick={openCreateDialog}>
								<Icon name="plus" size={16} />
								<span>Nueva política</span>
							</Button>
						</span>
					{/if}
				{/snippet}
			</PageHeader>

			{#if !canView}
				<div class="sf-guard-box">
					<EmptyState
						title="Acceso restringido"
						description="No dispones de permisos para consultar las políticas SLA de esta organización."
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

				{#if !loading && !fetchError && policies.length > 0}
					<p class="sf-default-summary" role="status">
						{#if defaultPolicy}
							Política por defecto: <strong>{defaultPolicy.name}</strong>. Se aplica a las
							incidencias nuevas sin una política elegida.
						{:else}
							Sin política por defecto: las incidencias nuevas no reciben SLA salvo que se elija
							una.
						{/if}
					</p>
				{/if}

				<div class="sf-toolbar">
					<div class="sf-search-wrap">
						<input
							type="search"
							class="sf-search-input"
							bind:value={searchQuery}
							placeholder="Buscar por nombre o código…"
							aria-label="Buscar políticas SLA"
						/>
					</div>
					<div class="sf-segmented-group" role="group" aria-label="Filtro por estado">
						<button
							type="button"
							class="sf-tab-btn"
							class:active={statusFilter === 'all'}
							aria-pressed={statusFilter === 'all'}
							onclick={() => (statusFilter = 'all')}
						>
							Todas ({policies.length})
						</button>
						<button
							type="button"
							class="sf-tab-btn"
							class:active={statusFilter === 'active'}
							aria-pressed={statusFilter === 'active'}
							onclick={() => (statusFilter = 'active')}
						>
							Activas ({policies.filter((p) => p.active).length})
						</button>
						<button
							type="button"
							class="sf-tab-btn"
							class:active={statusFilter === 'inactive'}
							aria-pressed={statusFilter === 'inactive'}
							onclick={() => (statusFilter = 'inactive')}
						>
							Inactivas ({policies.filter((p) => !p.active).length})
						</button>
					</div>
				</div>

				{#if loading}
					<div class="sf-loading-box" role="status">
						<Spinner size="md" />
						<p>Cargando políticas SLA…</p>
					</div>
				{:else if fetchError}
					<div class="sf-error-box" role="alert">
						<Alert
							tone="danger"
							title="No se pudieron cargar las políticas SLA"
							requestId={fetchRequestId}
						>
							<p>{fetchError}</p>
							{#snippet actions()}
								<Button
									variant="secondary"
									size="sm"
									onclick={() => activeOrg && loadPolicies(activeOrg.id)}
								>
									Reintentar
								</Button>
							{/snippet}
						</Alert>
					</div>
				{:else if filteredPolicies.length === 0}
					<div class="sf-empty-box">
						{#if searchQuery.trim() || statusFilter !== 'all'}
							<EmptyState
								title="No se encontraron políticas"
								description="No hay políticas SLA que coincidan con los filtros aplicados."
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
								title="No hay políticas SLA configuradas"
								description="Define los tiempos objetivo de primera respuesta y resolución para poder aplicarlos a las incidencias."
							>
								{#snippet action()}
									{#if canManage}
										<Button variant="primary" onclick={openCreateDialog}>
											<Icon name="plus" size={16} />
											<span>Crear política</span>
										</Button>
									{/if}
								{/snippet}
							</EmptyState>
						{/if}
					</div>
				{:else}
					<div class="sf-table-wrapper">
						<table class="sf-sla-table">
							<thead>
								<tr>
									<th scope="col" class="sf-col-name">Nombre</th>
									<th scope="col" class="sf-col-code">Código</th>
									<th scope="col" class="sf-col-time">Primera respuesta</th>
									<th scope="col" class="sf-col-time">Resolución</th>
									<th scope="col" class="sf-col-status">Estado</th>
									<th scope="col" class="sf-col-default">Por defecto</th>
									{#if canManage}
										<th scope="col" class="sf-col-actions">Acciones</th>
									{/if}
								</tr>
							</thead>
							<tbody>
								{#each filteredPolicies as policy (policy.id)}
									<tr class:sf-row-inactive={!policy.active}>
										<td class="sf-cell-name">
											<span class="sf-name-text">{policy.name}</span>
											{#if policy.description}
												<span class="sf-description-text">{policy.description}</span>
											{/if}
										</td>
										<td class="sf-cell-code"><code>{policy.code}</code></td>
										<td class="sf-cell-time">{formatSlaDuration(policy.firstResponseMinutes)}</td>
										<td class="sf-cell-time">{formatSlaDuration(policy.resolutionMinutes)}</td>
										<td class="sf-cell-status">
											{#if policy.active}
												<Badge tone="success">Activa</Badge>
											{:else}
												<Badge tone="neutral">Inactiva</Badge>
											{/if}
										</td>
										<td class="sf-cell-default">
											{#if policy.isDefault}
												<Badge tone="info">Por defecto</Badge>
											{:else}
												<span class="sf-empty-field">No</span>
											{/if}
										</td>
										{#if canManage}
											<td class="sf-cell-actions">
												<div class="sf-actions-group">
													<Button
														variant="secondary"
														size="sm"
														onclick={(e) => openEditDialog(policy, e)}
														ariaLabel="Editar {policy.name}"
													>
														<span>Editar</span>
													</Button>
													<Button
														variant={policy.active ? 'secondary' : 'primary'}
														size="sm"
														disabled={togglingId === policy.id}
														onclick={(e) => handleToggleActive(policy, e)}
														ariaLabel={policy.active
															? `Desactivar ${policy.name}`
															: `Activar ${policy.name}`}
													>
														{#if togglingId === policy.id}
															<Spinner size="sm" />
														{:else}
															<span>{policy.active ? 'Desactivar' : 'Activar'}</span>
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

			{#if dialogMode !== 'closed'}
				<div
					class="sf-modal-backdrop"
					data-sf-ui
					role="presentation"
					onclick={(e) => e.target === e.currentTarget && closeDialog()}
				>
					<div
						class="sf-modal-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="sla-dialog-title"
						tabindex="-1"
						use:focusTrap
					>
						<header class="sf-modal-header">
							<h2 id="sla-dialog-title" class="sf-modal-title">
								{dialogMode === 'create' ? 'Nueva política SLA' : 'Editar política SLA'}
							</h2>
							<button
								type="button"
								class="sf-modal-close"
								aria-label="Cerrar modal"
								disabled={formSubmitting}
								onclick={closeDialog}
							>
								<svg
									width="18"
									height="18"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<line x1="18" y1="6" x2="6" y2="18"></line>
									<line x1="6" y1="6" x2="18" y2="18"></line>
								</svg>
							</button>
						</header>

						<form onsubmit={handleSave} class="sf-modal-form" novalidate>
							{#if formError}
								<Alert tone="danger" title="Error en el formulario">
									<p>{formError}</p>
								</Alert>
							{/if}

							<Field
								label="Nombre"
								required
								hint="Nombre visible de la política (ej. Soporte estándar)."
								error={fieldErrors.name}
							>
								{#snippet children(control)}
									<Input
										{control}
										bind:element={controls.name}
										bind:value={draft.name}
										placeholder="Introduce el nombre"
										maxlength={SLA_NAME_MAX_LENGTH}
										disabled={formSubmitting}
									/>
								{/snippet}
							</Field>

							{#if dialogMode === 'create'}
								<Field
									label="Código"
									required
									hint="Identificador interno único: minúsculas, números y guiones bajos (ej. soporte_estandar). No se puede cambiar después."
									error={fieldErrors.code}
								>
									{#snippet children(control)}
										<Input
											{control}
											bind:element={controls.code}
											bind:value={draft.code}
											placeholder="soporte_estandar"
											maxlength={SLA_CODE_MAX_LENGTH}
											disabled={formSubmitting}
										/>
									{/snippet}
								</Field>
							{:else}
								<div class="sf-readonly-field">
									<span class="sf-readonly-label">Código</span>
									<code class="sf-readonly-value">{draft.code}</code>
									<p class="sf-readonly-hint">El código no se puede modificar.</p>
								</div>
							{/if}

							<Field label="Descripción" hint="Opcional." error={fieldErrors.description}>
								{#snippet children(control)}
									<Textarea
										{control}
										bind:element={controls.description}
										bind:value={draft.description}
										placeholder="Cuándo se usa esta política…"
										rows={2}
										disabled={formSubmitting}
									/>
								{/snippet}
							</Field>

							<div class="sf-duration-grid">
								{@render duration(
									'Primera respuesta',
									'Tiempo máximo hasta la primera respuesta pública de soporte.',
									'firstResponse',
									'firstResponseValue',
									'firstResponseUnit'
								)}
								{@render duration(
									'Resolución',
									'Tiempo máximo hasta resolver. No puede ser menor que la primera respuesta.',
									'resolution',
									'resolutionValue',
									'resolutionUnit'
								)}
							</div>

							<div class="sf-check-group">
								{#if dialogMode === 'edit'}
									<label class="sf-check">
										<input type="checkbox" bind:checked={draft.active} disabled={formSubmitting} />
										<span>
											<span class="sf-check-label">Activa</span>
											<span class="sf-check-hint">
												Solo las políticas activas pueden aplicarse a incidencias nuevas.
											</span>
										</span>
									</label>
								{/if}
								<label class="sf-check">
									<input
										type="checkbox"
										bind:checked={draft.isDefault}
										disabled={formSubmitting || !draft.active}
									/>
									<span>
										<span class="sf-check-label">Política por defecto</span>
										<span class="sf-check-hint">
											{#if !draft.active}
												Una política inactiva no puede ser la predeterminada.
											{:else if draft.isDefault && defaultPolicy && defaultPolicy.id !== editingPolicy?.id}
												Sustituirá a «{defaultPolicy.name}» como predeterminada.
											{:else}
												Se aplica a las incidencias nuevas sin una política elegida. Es opcional.
											{/if}
										</span>
									</span>
								</label>
							</div>

							<footer class="sf-modal-footer">
								<Button
									type="button"
									variant="secondary"
									disabled={formSubmitting}
									onclick={closeDialog}
								>
									Cancelar
								</Button>
								<Button type="submit" variant="primary" disabled={formSubmitting}>
									{#if formSubmitting}
										<Spinner size="sm" />
										<span>Guardando…</span>
									{:else}
										<span>{dialogMode === 'create' ? 'Crear política' : 'Guardar cambios'}</span>
									{/if}
								</Button>
							</footer>
						</form>
					</div>
				</div>
			{/if}
		</div>
	</OrganizationGate>
</AppShell>

<style>
	.sf-sla-container {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}

	.sf-breadcrumb ol {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}

	.sf-breadcrumb li:not(:last-child)::after {
		content: '/';
		margin-left: var(--space-2);
		color: var(--text-subtle);
	}

	.sf-breadcrumb a {
		color: var(--text-muted);
		text-decoration: none;
	}

	.sf-breadcrumb a:hover {
		color: var(--text);
		text-decoration: underline;
	}

	.sf-breadcrumb [aria-current='page'] {
		color: var(--text);
		font-weight: 600;
	}

	.sf-new-policy {
		display: contents;
	}

	.sf-guard-box,
	.sf-alert-wrap,
	.sf-error-box,
	.sf-empty-box {
		width: 100%;
	}

	.sf-default-summary {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}

	.sf-default-summary strong {
		color: var(--text-emphasis);
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
		padding: var(--space-8) var(--space-4);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	.sf-table-wrapper {
		background: var(--surface-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		box-shadow: var(--sf-shadow-card);
	}

	.sf-sla-table {
		width: 100%;
		/* sum of the column min-widths: below it the wrapper scrolls, the page never does */
		min-width: 1020px;
		border-collapse: collapse;
		text-align: left;
		font-size: var(--text-sm);
	}

	.sf-sla-table th {
		background: var(--surface-subtle);
		color: var(--text-muted);
		font-weight: 600;
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: var(--space-3-5) var(--space-5);
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}

	.sf-sla-table td {
		padding: var(--space-4) var(--space-5);
		border-bottom: 1px solid var(--border-subtle);
		vertical-align: middle;
	}

	.sf-sla-table tbody tr:last-child td {
		border-bottom: none;
	}

	.sf-sla-table tbody tr:hover {
		background-color: var(--surface-hover);
	}

	.sf-row-inactive {
		background: var(--surface-muted);
	}

	/* dim the data, never the action buttons (their contrast must stay AA) */
	.sf-row-inactive td:not(.sf-cell-actions) {
		opacity: 0.75;
	}

	/* Desktop column split (auto layout: shares of the table width; the min-widths keep columns
	   legible, below them the table scrolls inside .sf-table-wrapper). Actions take the rest. */
	.sf-col-name,
	.sf-cell-name {
		width: 22%;
		min-width: 180px;
	}

	.sf-cell-name {
		color: var(--text-emphasis);
	}

	.sf-name-text {
		display: block;
		font-weight: 600;
		overflow-wrap: break-word;
	}

	.sf-description-text {
		display: -webkit-box;
		margin-top: var(--space-1);
		font-size: var(--text-xs);
		color: var(--text-muted);
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.sf-col-code,
	.sf-cell-code {
		width: 16%;
		min-width: 160px;
	}

	.sf-cell-code code {
		font-size: var(--text-xs);
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.sf-col-time,
	.sf-cell-time {
		width: 12%;
		min-width: 120px;
		white-space: nowrap;
	}

	/* the long header ("Primera respuesta") may wrap instead of widening the column */
	.sf-sla-table th.sf-col-time {
		white-space: normal;
	}

	.sf-col-status,
	.sf-cell-status {
		width: 10%;
		min-width: 110px;
	}

	.sf-col-default,
	.sf-cell-default {
		width: 10%;
		min-width: 130px;
	}

	.sf-empty-field {
		color: var(--text-subtle);
	}

	.sf-col-actions,
	.sf-cell-actions {
		min-width: 200px;
		text-align: right;
		white-space: nowrap;
	}

	/* From tablet width the table may scroll inside its card: pin the actions to the visible right
	   edge (opaque backgrounds mirror the row states). Phones keep plain scrolling so the row name,
	   which identifies what an action targets, stays readable. */
	@media (min-width: 640px) {
		.sf-sla-table th.sf-col-actions,
		.sf-sla-table td.sf-cell-actions {
			position: sticky;
			right: 0;
			box-shadow: -1px 0 0 var(--border-subtle);
		}

		.sf-sla-table th.sf-col-actions {
			background: var(--surface-subtle);
		}

		.sf-sla-table td.sf-cell-actions {
			background: var(--surface-card);
		}

		.sf-sla-table .sf-row-inactive td.sf-cell-actions {
			background: var(--surface-muted);
		}

		.sf-sla-table tbody tr:hover td.sf-cell-actions {
			background: var(--surface-hover);
		}
	}

	.sf-actions-group {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-3);
	}

	/* Modal Dialog */
	.sf-modal-backdrop {
		position: fixed;
		inset: 0;
		background: var(--overlay, rgba(7, 13, 30, 0.65));
		backdrop-filter: blur(4px);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		z-index: 50;
	}

	.sf-modal-dialog {
		background: var(--surface-card, var(--surface, #ffffff));
		border: 1px solid var(--border-strong, var(--border));
		border-radius: var(--radius-xl, 1rem);
		box-shadow:
			0 20px 25px -5px rgb(0 0 0 / 0.25),
			0 8px 10px -6px rgb(0 0 0 / 0.25),
			var(--shadow, none);
		width: 100%;
		max-width: 560px;
		/* the form is taller than the others: it scrolls inside the dialog on short screens */
		max-height: calc(100dvh - 2 * var(--space-4));
		display: flex;
		flex-direction: column;
		overflow: hidden;
		color: var(--text-primary, var(--text));
		animation: sf-modal-in var(--duration) var(--ease);
	}

	@keyframes sf-modal-in {
		from {
			opacity: 0;
			transform: scale(0.97) translateY(-4px);
		}
		to {
			opacity: 1;
			transform: scale(1) translateY(0);
		}
	}

	.sf-modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-4) var(--space-6);
		border-bottom: 1px solid var(--border);
		background: var(--surface-subtle, var(--surface));
	}

	.sf-modal-title {
		font-size: var(--text-lg);
		font-weight: 700;
		color: var(--text-primary, var(--text));
		margin: 0;
	}

	.sf-modal-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		background: transparent;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0;
		border-radius: var(--radius);
		transition:
			background-color var(--duration) var(--ease),
			color var(--duration) var(--ease);
	}

	.sf-modal-close:hover {
		background: var(--surface-subtle);
		color: var(--text-primary, var(--text));
	}

	.sf-modal-close:focus-visible {
		outline: 2px solid var(--sf-cyan-500);
		outline-offset: 2px;
	}

	.sf-modal-form {
		padding: var(--space-6);
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		background: var(--surface-card, var(--surface));
		overflow-y: auto;
	}

	.sf-readonly-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.sf-readonly-label {
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary);
	}

	.sf-readonly-value {
		align-self: flex-start;
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius);
		background: var(--surface-subtle);
		font-size: var(--text-sm);
		color: var(--text-emphasis);
		overflow-wrap: anywhere;
	}

	.sf-readonly-hint {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}

	.sf-duration-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-4);
	}

	.sf-duration {
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.sf-duration-legend {
		padding: 0;
		margin-bottom: var(--space-2);
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary);
	}

	.sf-required {
		margin-left: 0.125rem;
		color: var(--danger);
	}

	.sf-duration-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
		gap: var(--space-2);
	}

	.sf-duration-hint {
		margin: 0;
		font-size: var(--text-xs);
		line-height: 1.45;
		color: var(--text-muted);
	}

	.sf-check-group {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.sf-check {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2-5);
		cursor: pointer;
	}

	.sf-check input {
		flex: none;
		width: 1rem;
		height: 1rem;
		margin-top: 0.125rem;
		accent-color: var(--accent);
	}

	.sf-check input:disabled {
		cursor: not-allowed;
	}

	.sf-check input:focus-visible {
		outline: 2px solid var(--sf-cyan-500);
		outline-offset: 2px;
	}

	.sf-check-label {
		display: block;
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary);
	}

	.sf-check-hint {
		display: block;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}

	.sf-modal-footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-3);
		margin-top: var(--space-2);
		padding-top: var(--space-4);
		border-top: 1px solid var(--border-subtle);
	}

	@media (max-width: 639px) {
		.sf-duration-grid {
			grid-template-columns: 1fr;
		}
	}
</style>

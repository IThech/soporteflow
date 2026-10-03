<script lang="ts">
	import { focusTrap } from '$lib/ui/focus-trap';
	import { onDestroy, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { signOut } from '$lib/api/auth';
	import {
		createCategory,
		updateCategory,
		setCategoryActive,
		type Category,
		CategoryApiError
	} from '$lib/api/categories';
	import {
		createSubcategory,
		updateSubcategory,
		setSubcategoryActive,
		getCategoryTree,
		type CategoryWithSubcategories,
		type Subcategory,
		SubcategoryApiError
	} from '$lib/api/subcategories';
	import { useOrganizationContext } from '$lib/app/context';
	import { formatShortDate } from '$lib/app/date-presentation';
	import { presentApiError } from '$lib/app/error-presentation';
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
	import Input from '$lib/ui/Input.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	const context = useOrganizationContext();
	const explicitOrganization = $derived(page.url.searchParams.get('organizationId'));

	let signingOut = $state(false);
	let signOutError = $state<string | null>(null);

	// Categories tree state
	let categories = $state<CategoryWithSubcategories[]>([]);
	let loading = $state(true);
	let fetchError = $state<string | null>(null);
	let fetchRequestId = $state<string | undefined>(undefined);

	// Filters
	let searchQuery = $state('');
	let statusFilter = $state<'all' | 'active' | 'inactive'>('all');

	// Expanded categories tracking
	let collapsedCategoryIds = $state<string[]>([]);

	// Modal Dialog state
	type DialogMode =
		'closed' | 'create_category' | 'edit_category' | 'create_subcategory' | 'edit_subcategory';
	let dialogMode = $state<DialogMode>('closed');
	let editingCategory = $state<Category | null>(null);
	let parentCategoryForSub = $state<Category | null>(null);
	let editingSubcategory = $state<Subcategory | null>(null);

	let formName = $state('');
	let formDescription = $state('');
	let formError = $state<string | null>(null);
	let formSubmitting = $state(false);
	let nameInputElement = $state<HTMLElement | null>(null);
	let triggerElement = $state<HTMLElement | null>(null);

	// Action in progress (activation/deactivation by id)
	let togglingId = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	let abortController: AbortController | null = null;

	const ready = $derived($context.status === 'ready');
	const capabilities = $derived(ready ? $context.capabilities : []);
	const activeOrg = $derived(ready ? $context.activeOrganization : null);
	const canManage = $derived(capabilities.includes('categories:manage'));
	const canView = $derived(canManage || capabilities.includes('categories:view'));

	function expireSession() {
		session.clearSession();
		void goto(resolve(SESSION_EXPIRED_PATH));
	}

	/** A mutation's outcome (data, error or 401) applies only if user/org/generation are unchanged. */
	function isCurrentTenant(started: ReturnType<typeof tenantIdentityOf>): boolean {
		return started !== null && sameTenant(started, tenantIdentityOf(context.get()));
	}

	async function loadCategories(orgId: string) {
		abortController?.abort();
		abortController = new AbortController();
		const signal = abortController.signal;

		loading = true;
		fetchError = null;
		fetchRequestId = undefined;

		try {
			const result = await getCategoryTree({ organizationId: orgId, signal });
			if (!signal.aborted) {
				categories = result;
				loading = false;
			}
		} catch (err) {
			if (signal.aborted) return;
			loading = false;
			if (
				(err instanceof CategoryApiError || err instanceof SubcategoryApiError) &&
				err.status === 401
			) {
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
		}
	});

	$effect(() => {
		if (activeOrg) {
			const orgId = activeOrg.id;
			untrack(() => {
				void loadCategories(orgId);
			});
		}
	});

	function toggleCollapse(categoryId: string) {
		if (collapsedCategoryIds.includes(categoryId)) {
			collapsedCategoryIds = collapsedCategoryIds.filter((id) => id !== categoryId);
		} else {
			collapsedCategoryIds = [...collapsedCategoryIds, categoryId];
		}
	}

	// Filter categories and their subcategories
	const filteredCategories = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();

		return categories
			.map((cat) => {
				const matchesCatStatus =
					statusFilter === 'all' ||
					(statusFilter === 'active' && cat.active) ||
					(statusFilter === 'inactive' && !cat.active);

				const matchesCatName =
					!q ||
					cat.name.toLowerCase().includes(q) ||
					(cat.description?.toLowerCase().includes(q) ?? false);

				const filteredSubs = cat.subcategories.filter((sub) => {
					const matchesSubStatus =
						statusFilter === 'all' ||
						(statusFilter === 'active' && sub.active) ||
						(statusFilter === 'inactive' && !sub.active);

					const matchesSubName =
						!q ||
						sub.name.toLowerCase().includes(q) ||
						(sub.description?.toLowerCase().includes(q) ?? false);

					return matchesSubStatus && (matchesCatName || matchesSubName);
				});

				const catMatches = matchesCatStatus && (matchesCatName || filteredSubs.length > 0);

				if (!catMatches && filteredSubs.length === 0) {
					return null;
				}

				return {
					...cat,
					subcategories: filteredSubs
				};
			})
			.filter((c): c is CategoryWithSubcategories => c !== null);
	});

	// Dialog Handlers
	function openCreateCategoryDialog(event?: MouseEvent) {
		if (event?.currentTarget instanceof HTMLElement) {
			triggerElement = event.currentTarget;
		}
		dialogMode = 'create_category';
		editingCategory = null;
		formName = '';
		formDescription = '';
		formError = null;
		focusNameField();
	}

	function openEditCategoryDialog(cat: Category, event?: MouseEvent) {
		if (event?.currentTarget instanceof HTMLElement) {
			triggerElement = event.currentTarget;
		}
		dialogMode = 'edit_category';
		editingCategory = cat;
		formName = cat.name;
		formDescription = cat.description ?? '';
		formError = null;
		focusNameField();
	}

	function openCreateSubcategoryDialog(parentCat: Category, event?: MouseEvent) {
		if (event?.currentTarget instanceof HTMLElement) {
			triggerElement = event.currentTarget;
		}
		dialogMode = 'create_subcategory';
		parentCategoryForSub = parentCat;
		editingSubcategory = null;
		formName = '';
		formDescription = '';
		formError = null;
		focusNameField();
	}

	function openEditSubcategoryDialog(parentCat: Category, sub: Subcategory, event?: MouseEvent) {
		if (event?.currentTarget instanceof HTMLElement) {
			triggerElement = event.currentTarget;
		}
		dialogMode = 'edit_subcategory';
		parentCategoryForSub = parentCat;
		editingSubcategory = sub;
		formName = sub.name;
		formDescription = sub.description ?? '';
		formError = null;
		focusNameField();
	}

	function closeDialog() {
		// Escape / backdrop / close button must not abandon an in-flight write (double submit).
		if (formSubmitting) return;
		dialogMode = 'closed';
		editingCategory = null;
		parentCategoryForSub = null;
		editingSubcategory = null;
		formName = '';
		formDescription = '';
		formError = null;

		if (triggerElement) {
			triggerElement.focus();
			triggerElement = null;
		}
	}

	function focusNameField() {
		// Input's `element` IS the <input> (bind:this), not a wrapper to search inside
		setTimeout(() => nameInputElement?.focus(), 50);
	}

	async function handleDialogSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (!activeOrg || formSubmitting) return;

		const trimmedName = formName.trim();
		if (!trimmedName) {
			formError = 'El nombre es obligatorio.';
			return;
		}

		const tenant = tenantIdentityOf(context.get());
		formSubmitting = true;
		formError = null;

		try {
			if (dialogMode === 'create_category') {
				await createCategory({
					organizationId: activeOrg.id,
					name: trimmedName,
					description: formDescription.trim() || null
				});
			} else if (dialogMode === 'edit_category' && editingCategory) {
				await updateCategory({
					organizationId: activeOrg.id,
					categoryId: editingCategory.id,
					name: trimmedName,
					description: formDescription.trim() || null
				});
			} else if (dialogMode === 'create_subcategory' && parentCategoryForSub) {
				await createSubcategory({
					organizationId: activeOrg.id,
					categoryId: parentCategoryForSub.id,
					name: trimmedName,
					description: formDescription.trim() || null
				});
			} else if (dialogMode === 'edit_subcategory' && editingSubcategory) {
				await updateSubcategory({
					organizationId: activeOrg.id,
					subcategoryId: editingSubcategory.id,
					name: trimmedName,
					description: formDescription.trim() || null
				});
			}

			formSubmitting = false;
			// a stale outcome still closes the dialog: it belonged to the previous tenant
			closeDialog();
			if (!isCurrentTenant(tenant)) return;
			await loadCategories(activeOrg.id);
		} catch (err) {
			formSubmitting = false;
			if (!isCurrentTenant(tenant)) return closeDialog();
			if (
				(err instanceof CategoryApiError || err instanceof SubcategoryApiError) &&
				err.status === 401
			) {
				expireSession();
				return;
			}
			const presented = presentApiError(err);
			formError = presented.message;
		}
	}

	async function handleToggleCategoryActive(cat: Category) {
		if (!activeOrg || togglingId !== null) return;
		const tenant = tenantIdentityOf(context.get());
		actionError = null;
		togglingId = cat.id;

		try {
			await setCategoryActive({
				organizationId: activeOrg.id,
				categoryId: cat.id,
				active: !cat.active
			});
			if (!isCurrentTenant(tenant)) return;
			await loadCategories(activeOrg.id);
		} catch (err) {
			if (!isCurrentTenant(tenant)) return;
			if (err instanceof CategoryApiError && err.status === 401) {
				expireSession();
				return;
			}
			const presented = presentApiError(err);
			actionError = presented.message;
		} finally {
			togglingId = null;
		}
	}

	async function handleToggleSubcategoryActive(sub: Subcategory) {
		if (!activeOrg || togglingId !== null) return;
		const tenant = tenantIdentityOf(context.get());
		actionError = null;
		togglingId = sub.id;

		try {
			await setSubcategoryActive({
				organizationId: activeOrg.id,
				subcategoryId: sub.id,
				active: !sub.active
			});
			if (!isCurrentTenant(tenant)) return;
			await loadCategories(activeOrg.id);
		} catch (err) {
			if (!isCurrentTenant(tenant)) return;
			if (err instanceof SubcategoryApiError && err.status === 401) {
				expireSession();
				return;
			}
			const presented = presentApiError(err);
			actionError = presented.message;
		} finally {
			togglingId = null;
		}
	}

	function changeOrganization(id: string) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(resolve('/app/admin/categories') + `?organizationId=${encodeURIComponent(id)}`);
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
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && dialogMode !== 'closed') closeDialog();
	}}
/>

<svelte:head>
	<title>Categorías · SoporteFlow</title>
</svelte:head>

<!-- eslint-disable svelte/no-navigation-without-resolve -- hrefs are built from resolve() -->
<AppShell
	context={$context}
	title="Categorías"
	current="admin"
	{signingOut}
	{signOutError}
	onOrganizationChange={changeOrganization}
	onSignOut={leave}
>
	<OrganizationGate context={$context} onretry={() => void context.load(explicitOrganization)}>
		<div class="sf-categories-page">
			<nav class="sf-breadcrumb" aria-label="Ruta de navegación">
				<ol>
					<li><a href={adminHref}>Administración</a></li>
					<li aria-current="page">Categorías</li>
				</ol>
			</nav>
			<PageHeader
				title="Categorías y taxonomía"
				description="Organización jerárquica de soporte: categorías principales y subcategorías para clasificar incidencias."
			>
				{#snippet actions()}
					<div class="sf-header-actions">
						{#if canManage}
							<Button variant="primary" onclick={openCreateCategoryDialog}>
								<svg
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path d="M12 5v14M5 12h14"></path>
								</svg>
								<span>Nueva categoría</span>
							</Button>
						{/if}
					</div>
				{/snippet}
			</PageHeader>

			{#if actionError}
				<div class="sf-banner">
					<Alert tone="danger" title="Error en la operación">
						<p>{actionError}</p>
					</Alert>
				</div>
			{/if}

			{#if !canView}
				<div class="sf-gate-notice">
					<EmptyState
						title="Acceso restringido"
						description="No tienes permisos para consultar ni gestionar el catálogo de categorías de esta organización."
					/>
				</div>
			{:else}
				<div class="sf-toolbar">
					<div class="sf-search-wrap">
						<input
							type="search"
							class="sf-search-input"
							placeholder="Buscar por categoría o subcategoría..."
							bind:value={searchQuery}
							aria-label="Buscar categorías"
						/>
					</div>

					<div class="sf-filters-group">
						<div class="sf-status-tabs" role="group" aria-label="Filtro por estado">
							<button
								type="button"
								class="sf-tab-btn"
								class:active={statusFilter === 'all'}
								aria-pressed={statusFilter === 'all'}
								onclick={() => (statusFilter = 'all')}
							>
								Todas ({categories.length})
							</button>
							<button
								type="button"
								class="sf-tab-btn"
								class:active={statusFilter === 'active'}
								aria-pressed={statusFilter === 'active'}
								onclick={() => (statusFilter = 'active')}
							>
								Activas ({categories.filter((c) => c.active).length})
							</button>
							<button
								type="button"
								class="sf-tab-btn"
								class:active={statusFilter === 'inactive'}
								aria-pressed={statusFilter === 'inactive'}
								onclick={() => (statusFilter = 'inactive')}
							>
								Inactivas ({categories.filter((c) => !c.active).length})
							</button>
						</div>
					</div>
				</div>

				{#if loading}
					<div class="sf-loading-state" role="status">
						<Spinner size="md" />
						<p class="sf-loading-text">Cargando árbol de categorías...</p>
					</div>
				{:else if fetchError}
					<div class="sf-error-card" role="alert">
						<Alert
							tone="danger"
							title="No se pudieron cargar las categorías"
							requestId={fetchRequestId}
						>
							<p>{fetchError}</p>
							{#snippet actions()}
								<Button
									variant="secondary"
									size="sm"
									onclick={() => activeOrg && loadCategories(activeOrg.id)}
								>
									<span>Reintentar</span>
								</Button>
							{/snippet}
						</Alert>
					</div>
				{:else if categories.length === 0}
					<div class="sf-empty-wrap">
						<EmptyState
							title="No hay categorías creadas"
							description="Crea la primera categoría para organizar las incidencias y configurar la taxonomía de soporte."
						>
							{#snippet action()}
								{#if canManage}
									<Button variant="primary" onclick={openCreateCategoryDialog}>
										<span>Crear primera categoría</span>
									</Button>
								{/if}
							{/snippet}
						</EmptyState>
					</div>
				{:else if filteredCategories.length === 0}
					<div class="sf-empty-wrap">
						<EmptyState
							title="Sin resultados coincidentes"
							description="No se encontraron categorías ni subcategorías con los filtros aplicados."
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
									<span>Restablecer filtros</span>
								</Button>
							{/snippet}
						</EmptyState>
					</div>
				{:else}
					<div class="sf-tree-container">
						{#each filteredCategories as category (category.id)}
							{@const isCollapsed = collapsedCategoryIds.includes(category.id)}
							<div class="sf-category-block" class:inactive={!category.active}>
								<!-- Category Header Row -->
								<div class="sf-category-header">
									<div class="sf-category-main">
										<button
											type="button"
											class="sf-collapse-btn"
											onclick={() => toggleCollapse(category.id)}
											aria-label={`${isCollapsed ? 'Desplegar' : 'Plegar'} subcategorías de ${category.name}`}
											aria-expanded={!isCollapsed}
										>
											<svg
												width="16"
												height="16"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												stroke-linecap="round"
												stroke-linejoin="round"
												aria-hidden="true"
												style:transform={isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)'}
												style:transition="transform 0.15s ease"
											>
												<polyline points="6 9 12 15 18 9"></polyline>
											</svg>
										</button>
										<div class="sf-category-info">
											<div class="sf-category-title-row">
												<span class="sf-category-name">{category.name}</span>
												{#if category.active}
													<Badge tone="success">Activa</Badge>
												{:else}
													<Badge tone="neutral">Inactiva</Badge>
												{/if}
												<Badge tone="neutral">
													{category.subcategories.length}
													{category.subcategories.length === 1 ? 'subcategoría' : 'subcategorías'}
												</Badge>
											</div>
											{#if category.description}
												<p class="sf-category-desc">{category.description}</p>
											{/if}
										</div>
									</div>

									<div class="sf-category-actions">
										{#if canManage}
											<Button
												variant="secondary"
												size="sm"
												onclick={(e) => openCreateSubcategoryDialog(category, e)}
												disabled={!category.active}
												ariaLabel={category.active
													? `Añadir subcategoría a ${category.name}`
													: `Activa ${category.name} para añadir subcategorías`}
											>
												<span>+ Subcategoría</span>
											</Button>
											<Button
												variant="secondary"
												size="sm"
												onclick={(e) => openEditCategoryDialog(category, e)}
												ariaLabel="Editar categoría {category.name}"
											>
												<span>Editar</span>
											</Button>
											<Button
												variant={category.active ? 'secondary' : 'primary'}
												size="sm"
												onclick={() => handleToggleCategoryActive(category)}
												disabled={togglingId === category.id}
												ariaLabel={category.active
													? `Desactivar ${category.name}`
													: `Activar ${category.name}`}
											>
												{#if togglingId === category.id}
													<Spinner size="sm" />
												{:else}
													<span>{category.active ? 'Desactivar' : 'Activar'}</span>
												{/if}
											</Button>
										{/if}
									</div>
								</div>

								<!-- Subcategories List (Collapsible) -->
								{#if !isCollapsed}
									<div class="sf-subcategories-list">
										{#if category.subcategories.length === 0}
											<div class="sf-no-subcategories">
												<span class="sf-no-subs-text">Sin subcategorías registradas.</span>
												{#if canManage && category.active}
													<button
														type="button"
														class="sf-inline-add-link"
														aria-label={`Añadir la primera subcategoría a ${category.name}`}
														onclick={(e) => openCreateSubcategoryDialog(category, e)}
													>
														+ Añadir la primera subcategoría
													</button>
												{/if}
											</div>
										{:else}
											{#each category.subcategories as sub (sub.id)}
												<div class="sf-subcategory-row" class:inactive={!sub.active}>
													<div class="sf-subcategory-indicator">
														<svg
															width="14"
															height="14"
															viewBox="0 0 24 24"
															fill="none"
															stroke="currentColor"
															stroke-width="2"
															stroke-linecap="round"
															stroke-linejoin="round"
															aria-hidden="true"
															class="sf-elbow-icon"
														>
															<polyline points="9 10 4 15 9 20"></polyline>
															<path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
														</svg>
													</div>
													<div class="sf-subcategory-info">
														<div class="sf-sub-title-row">
															<span class="sf-sub-name">{sub.name}</span>
															{#if sub.active}
																<Badge tone="success">Activa</Badge>
															{:else}
																<Badge tone="neutral">Inactiva</Badge>
															{/if}
														</div>
														{#if sub.description}
															<p class="sf-sub-desc">{sub.description}</p>
														{/if}
													</div>

													<div class="sf-sub-meta">
														<span class="sf-sub-date">{formatShortDate(sub.updatedAt)}</span>
													</div>

													<div class="sf-subcategory-actions">
														{#if canManage}
															<Button
																variant="secondary"
																size="sm"
																onclick={(e) => openEditSubcategoryDialog(category, sub, e)}
																ariaLabel="Editar subcategoría {sub.name}"
															>
																<span>Editar</span>
															</Button>
															<Button
																variant={sub.active ? 'secondary' : 'primary'}
																size="sm"
																onclick={() => handleToggleSubcategoryActive(sub)}
																disabled={togglingId === sub.id ||
																	(!sub.active && !category.active)}
																ariaLabel={sub.active
																	? `Desactivar ${sub.name}`
																	: `Activar ${sub.name}`}
															>
																{#if togglingId === sub.id}
																	<Spinner size="sm" />
																{:else}
																	<span>{sub.active ? 'Desactivar' : 'Activar'}</span>
																{/if}
															</Button>
														{/if}
													</div>
												</div>
											{/each}
										{/if}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			{/if}
		</div>

		<!-- Dialog Modal: Inside AppShell to inherit data-sf-ui theme context -->
		{#if dialogMode !== 'closed'}
			<div
				class="sf-modal-backdrop"
				data-sf-ui
				role="presentation"
				onclick={(e) => {
					if (e.target === e.currentTarget) closeDialog();
				}}
			>
				<div
					class="sf-modal-dialog"
					role="dialog"
					aria-modal="true"
					aria-labelledby="sf-dialog-title"
					tabindex="-1"
					use:focusTrap
				>
					<div class="sf-modal-header">
						<div>
							<h3 id="sf-dialog-title" class="sf-modal-title">
								{#if dialogMode === 'create_category'}
									Nueva categoría
								{:else if dialogMode === 'edit_category'}
									Editar categoría
								{:else if dialogMode === 'create_subcategory'}
									Nueva subcategoría
								{:else if dialogMode === 'edit_subcategory'}
									Editar subcategoría
								{/if}
							</h3>
							{#if (dialogMode === 'create_subcategory' || dialogMode === 'edit_subcategory') && parentCategoryForSub}
								<p class="sf-dialog-parent-badge">
									Categoría: <strong>{parentCategoryForSub.name}</strong>
								</p>
							{/if}
						</div>
						<button
							type="button"
							class="sf-modal-close"
							onclick={closeDialog}
							aria-label="Cerrar modal"
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
					</div>

					<form class="sf-modal-form" onsubmit={handleDialogSubmit}>
						{#if formError}
							<Alert tone="danger" title="Error">
								<p>{formError}</p>
							</Alert>
						{/if}

						<Field
							label="Nombre"
							required
							hint={dialogMode.includes('subcategory')
								? 'Ej. Portátiles, Routers, Servidores'
								: 'Ej. Hardware, Software, Redes'}
						>
							{#snippet children(control)}
								<Input
									{control}
									bind:element={nameInputElement}
									bind:value={formName}
									placeholder={dialogMode.includes('subcategory')
										? 'Introduce la subcategoría'
										: 'Introduce la categoría'}
									maxlength={100}
									disabled={formSubmitting}
								/>
							{/snippet}
						</Field>

						<Field label="Descripción" hint="Guía o alcance opcional (máx. 1000 caracteres)">
							{#snippet children(control)}
								<textarea
									id={control.id}
									class="sf-textarea"
									bind:value={formDescription}
									placeholder="Descripción detallada o guía sobre el alcance..."
									rows={3}
									maxlength={1000}
									disabled={formSubmitting}></textarea>
							{/snippet}
						</Field>

						<div class="sf-modal-footer">
							<Button variant="secondary" onclick={closeDialog} disabled={formSubmitting}>
								<span>Cancelar</span>
							</Button>
							<Button variant="primary" type="submit" disabled={formSubmitting}>
								{#if formSubmitting}
									<Spinner size="sm" />
									<span>Guardando...</span>
								{:else}
									<span>Guardar</span>
								{/if}
							</Button>
						</div>
					</form>
				</div>
			</div>
		{/if}
	</OrganizationGate>
</AppShell>

<style>
	.sf-categories-page {
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
	}

	.sf-header-actions {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	.sf-banner {
		animation: sf-fade-in var(--duration) var(--ease);
	}

	.sf-gate-notice {
		background: var(--surface-card, var(--surface));
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: var(--space-8) var(--space-6);
	}

	.sf-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
	}

	.sf-search-wrap {
		position: relative;
		display: flex;
		align-items: center;
		flex: 1;
		min-width: 260px;
		max-width: 440px;
	}

	.sf-search-input {
		width: 100%;
		height: 2.25rem;
		padding: 0 var(--space-3);
		background: var(--surface-input, var(--surface));
		border: 1px solid var(--border-strong, var(--border));
		border-radius: var(--radius-md);
		font-size: var(--text-sm);
		color: var(--text-primary, var(--text));
		outline: none;
		transition:
			border-color var(--duration) var(--ease),
			box-shadow var(--duration) var(--ease);
	}

	.sf-search-input:focus {
		border-color: var(--sf-cyan-500);
		box-shadow: var(--focus-ring);
	}

	.sf-filters-group {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.sf-status-tabs {
		display: inline-flex;
		background: var(--surface-subtle, var(--surface));
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 2px;
		gap: 2px;
	}

	.sf-tab-btn {
		background: transparent;
		border: none;
		padding: var(--space-1) var(--space-3);
		font-size: var(--text-xs);
		font-weight: 500;
		color: var(--text-muted);
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition:
			background-color var(--duration) var(--ease),
			color var(--duration) var(--ease);
	}

	.sf-tab-btn:hover {
		color: var(--text-primary, var(--text));
	}

	.sf-tab-btn.active {
		background: var(--surface-card, var(--surface));
		color: var(--text-primary, var(--text));
		font-weight: 600;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
	}

	.sf-loading-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-3);
		padding: var(--space-8) var(--space-4);
		background: var(--surface-card, var(--surface));
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
	}

	.sf-loading-text {
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	.sf-error-card {
		background: var(--surface-card, var(--surface));
		border-radius: var(--radius-lg);
	}

	.sf-empty-wrap {
		background: var(--surface-card, var(--surface));
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: var(--space-8) var(--space-4);
	}

	/* Category Tree Styles */
	.sf-tree-container {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.sf-category-block {
		background: var(--surface-card, var(--surface));
		border: 1px solid var(--border-strong, var(--border));
		border-radius: var(--radius-lg);
		overflow: hidden;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
		transition: border-color var(--duration) var(--ease);
	}

	.sf-category-block.inactive {
		border-color: var(--border-subtle, var(--border));
		opacity: 0.85;
	}

	.sf-category-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-4) var(--space-5);
		background: var(--surface-subtle, var(--surface));
		border-bottom: 1px solid var(--border);
		gap: var(--space-4);
		/* narrow screens: the actions move under the name instead of being clipped by the card */
		flex-wrap: wrap;
	}

	.sf-category-main {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		flex: 1 1 16rem;
		min-width: 0;
	}

	.sf-collapse-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		cursor: pointer;
		margin-top: 2px;
		transition:
			background-color var(--duration) var(--ease),
			color var(--duration) var(--ease);
	}

	.sf-collapse-btn:hover {
		background: var(--surface-card);
		color: var(--text-primary);
	}

	.sf-category-info {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		flex: 1;
	}

	.sf-category-title-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.sf-category-name {
		font-size: var(--text-base);
		font-weight: 700;
		color: var(--text-primary, var(--text));
	}

	.sf-category-desc {
		font-size: var(--text-sm);
		color: var(--text-muted);
		margin: 0;
	}

	.sf-category-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		flex-shrink: 0;
	}

	/* Subcategories list */
	.sf-subcategories-list {
		display: flex;
		flex-direction: column;
		background: var(--surface-card, var(--surface));
	}

	.sf-no-subcategories {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-4) var(--space-6) var(--space-4) 3.5rem;
		color: var(--text-muted);
		font-size: var(--text-xs);
		font-style: italic;
	}

	.sf-inline-add-link {
		background: transparent;
		border: none;
		color: var(--sf-cyan-500, #06b6d4);
		font-size: var(--text-xs);
		font-weight: 600;
		cursor: pointer;
		padding: 0;
	}

	.sf-inline-add-link:hover {
		text-decoration: underline;
	}

	.sf-subcategory-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-3) var(--space-5) var(--space-3) var(--space-4);
		border-top: 1px solid var(--border-subtle, var(--border));
		gap: var(--space-3);
		flex-wrap: wrap;
		transition: background-color var(--duration) var(--ease);
	}

	.sf-subcategory-row:first-child {
		border-top: none;
	}

	.sf-subcategory-row:hover {
		background: var(--surface-subtle, rgba(0, 0, 0, 0.02));
	}

	.sf-subcategory-row.inactive {
		opacity: 0.7;
	}

	.sf-subcategory-indicator {
		display: flex;
		align-items: center;
		padding-left: var(--space-4);
		color: var(--text-muted);
	}

	.sf-subcategory-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1 1 12rem;
		min-width: 0;
	}

	.sf-sub-title-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.sf-sub-name {
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary, var(--text));
	}

	.sf-sub-desc {
		font-size: var(--text-xs);
		color: var(--text-muted);
		margin: 0;
	}

	.sf-sub-meta {
		display: flex;
		align-items: center;
	}

	.sf-sub-date {
		font-size: var(--text-xs);
		color: var(--text-muted);
		white-space: nowrap;
	}

	.sf-subcategory-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		flex-shrink: 0;
	}

	/* Modal Dialog Styles */
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
		max-width: 520px;
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

	.sf-dialog-parent-badge {
		font-size: var(--text-xs);
		color: var(--text-muted);
		margin: 2px 0 0 0;
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
	}

	.sf-textarea {
		width: 100%;
		padding: var(--space-2) var(--space-3);
		background: var(--surface-input, var(--surface));
		border: 1px solid var(--border-strong, var(--border));
		border-radius: var(--radius-md);
		font-size: var(--text-sm);
		font-family: inherit;
		color: var(--text-primary, var(--text));
		outline: none;
		resize: vertical;
		transition:
			border-color var(--duration) var(--ease),
			box-shadow var(--duration) var(--ease);
	}

	.sf-textarea:focus {
		border-color: var(--sf-cyan-500);
		box-shadow: var(--focus-ring);
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
</style>

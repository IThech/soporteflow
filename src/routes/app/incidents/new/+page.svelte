<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { signOut } from '$lib/api/auth';
	import { listCategories } from '$lib/api/categories';
	import { listClients } from '$lib/api/clients';
	import { submitIncidentCreation } from '$lib/api/incident-create';
	import { listSites } from '$lib/api/sites';
	import { listSlaPolicies } from '$lib/api/sla-policies';
	import { navigationModel } from '$lib/app/capabilities';
	import { useOrganizationContext } from '$lib/app/context';
	import { presentMutationFailure, remainingSeconds } from '$lib/app/error-presentation';
	import { catalogsFor, createIncidentCreateCatalogs } from '$lib/app/incident-create-catalogs';
	import { createIncidentCreateController } from '$lib/app/incident-create-controller';
	import {
		checkCreateRequest,
		createFormSections,
		emptyCreateDraft,
		isDraftDirty,
		planCreationFollowUp,
		presentCreateError,
		toCreateRequest,
		validateCreateDraft,
		type CreateFieldErrors
	} from '$lib/app/incident-create-form';
	import {
		createDraftLeaveGuard,
		currentSessionExpiry,
		incidentDetailPath,
		incidentListPath,
		newIncidentPath,
		SESSION_EXPIRED_PATH
	} from '$lib/app/incident-create-navigation';
	import { attemptSignOut, SIGN_OUT_FAILED_MESSAGE } from '$lib/app/sign-out';
	import { tenantIdentityOf, tenantKey, type TenantIdentity } from '$lib/app/tenant-identity';
	import { session } from '$lib/stores/session';
	import AppShell from '$lib/components/shell/AppShell.svelte';
	import OrganizationGate from '$lib/components/shell/OrganizationGate.svelte';
	import IncidentCreateForm from '$lib/components/incidents/IncidentCreateForm.svelte';
	import IncidentCreatedNotice from '$lib/components/incidents/IncidentCreatedNotice.svelte';
	import Alert from '$lib/ui/Alert.svelte';
	import Button from '$lib/ui/Button.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';

	/**
	 * /app/incidents/new (UI-2B). The page owns route/context, composition and navigation only:
	 * - organization context from the URL (the UI-1 OrganizationContext; no own bootstrap);
	 * - gating by the real `incidents:create` capability (the server still authorizes);
	 * - submit through the UI-2A creation controller (pessimistic, single-shot, stale-safe);
	 * - optional catalogs through the tenant-bound cache;
	 * - the draft lives in memory, bound to the tenant it was typed in: another organization or
	 *   user starts from an empty draft (never carried over). Leaving with a dirty draft asks for
	 *   confirmation (organization switch from the sidebar, links, Cancel, back button).
	 */
	const context = useOrganizationContext();
	const creator = createIncidentCreateController({
		submit: (organizationId, input) => submitIncidentCreation(organizationId, input)
	});
	const catalogs = createIncidentCreateCatalogs({
		clients: (organizationId, signal) => listClients({ organizationId, activeOnly: true, signal }),
		sites: (organizationId, signal) => listSites({ organizationId, activeOnly: true, signal }),
		categories: (organizationId, signal) =>
			listCategories({ organizationId, activeOnly: true, signal }),
		slaPolicies: (organizationId, signal) =>
			listSlaPolicies({ organizationId, active: true, signal })
	});
	onDestroy(() => {
		creator.dispose();
		catalogs.dispose();
	});

	const explicitOrganization = $derived(page.url.searchParams.get('organizationId'));
	let signingOut = $state(false);
	let signOutError = $state<string | null>(null);
	let draft = $state(emptyCreateDraft());
	let draftTenant = $state('');
	let errors = $state<CreateFieldErrors>({});
	let cooldownUntil = $state<number | null>(null);
	let now = $state(Date.now());

	/** Session expiry of the CURRENT context: handled once (several 401s may arrive together). */
	let sessionExpired = false;
	function expireSession() {
		if (sessionExpired) return;
		sessionExpired = true;
		session.clearSession();
		guard.allowNextNavigation();
		void goto(resolve(SESSION_EXPIRED_PATH));
	}

	// 1. Organization context from the URL (reloaded only when the organization changes).
	$effect(() => {
		const explicit = explicitOrganization;
		untrack(() => {
			const current = context.get();
			if (explicit && current.status === 'ready' && current.activeOrganizationId === explicit)
				return;
			void context.load(explicit);
		});
	});

	// 2. Session loss and canonical URL (a remembered/single organization is written into it).
	$effect(() => {
		const state = $context;
		if (state.status === 'unauthenticated') {
			expireSession();
			return;
		}
		if (state.status === 'ready' && !explicitOrganization && state.activeOrganizationId)
			void goto(resolve(newIncidentPath(state.activeOrganizationId)), {
				replaceState: true,
				keepFocus: true,
				noScroll: true
			});
	});

	const identity = $derived(tenantIdentityOf($context));
	const capabilities = $derived(identity?.capabilities ?? []);
	const canCreate = $derived(capabilities.includes('incidents:create'));
	const sections = $derived(createFormSections(capabilities));
	const navigation = $derived(navigationModel(capabilities));

	// 3. Tenant binding: another identity resets draft, errors, outcome and catalogs at once.
	$effect(() => {
		const current = identity;
		const key = tenantKey(current);
		untrack(() => {
			creator.setIdentity(current);
			if (key !== draftTenant) {
				draft = emptyCreateDraft();
				errors = {};
				cooldownUntil = null;
				draftTenant = key;
			}
		});
	});
	$effect(() => {
		const current = canCreate ? identity : null;
		const names = canCreate ? catalogsFor(sections) : [];
		untrack(() => catalogs.setIdentity(current, names));
	});

	// 4. A 401 of the CURRENT submission or of a current catalog re-authenticates (stale answers
	//    never reach these states). 403/5xx of a catalog stay local errors.
	$effect(() => {
		if (currentSessionExpiry($creator, $catalogs)) {
			expireSession();
		}
	});
	// 5. 429 cooldown clock (ticks only while a cooldown is active).
	$effect(() => {
		if (cooldownUntil === null) return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});
	const blockedSeconds = $derived(remainingSeconds(cooldownUntil, now));

	const listHref = $derived(
		identity ? resolve(incidentListPath(identity.organizationId)) : resolve('/app/incidents')
	);

	const guard = createDraftLeaveGuard({
		isDirty: () => isDraftDirty(draft),
		isSettled: () => $creator.status === 'created',
		confirm: (message) => window.confirm(message),
		currentUrl: () => page.url
	});
	beforeNavigate((attempt) => guard.onBeforeNavigate(attempt));

	function handleSubmit(): CreateFieldErrors {
		const owner = identity;
		if (!owner || !canCreate) return {};
		const found = validateCreateDraft(draft);
		if (Object.keys(found).length > 0) return (errors = found);
		const request = toCreateRequest(draft, sections);
		const gate = checkCreateRequest(owner.organizationId, request);
		if (Object.keys(gate).length > 0) return (errors = gate);
		errors = {};
		void submitCreation(owner, request);
		return {};
	}

	async function submitCreation(
		owner: TenantIdentity,
		request: ReturnType<typeof toCreateRequest>
	) {
		const result = await creator.submit(request);
		const next = planCreationFollowUp(result, owner, identity);
		switch (next.kind) {
			case 'open-detail':
				guard.allowNextNavigation();
				await goto(resolve(incidentDetailPath(next.organizationId, next.incidentId)));
				return;
			case 'show-created':
				draft = emptyCreateDraft();
				return;
			case 'keep-draft':
				// Draft kept; nothing is resent. 'unknown' shows "verify before resending".
				errors = next.fieldErrors;
				if (next.cooldownSeconds !== null) cooldownUntil = Date.now() + next.cooldownSeconds * 1000;
				return;
			case 'ignore':
				return; // stale: no navigation, message or draft change in the new context
		}
	}

	function createAnother() {
		creator.reset();
		draft = emptyCreateDraft();
		errors = {};
	}

	function cancel() {
		// The guard (beforeNavigate) asks before discarding a dirty draft.
		const organizationId = identity?.organizationId;
		void goto(
			organizationId ? resolve(incidentListPath(organizationId)) : resolve('/app/incidents')
		);
	}

	function changeOrganization(id: string): boolean {
		if (!guard.confirmDiscard()) return false; // the switcher goes back to the current org
		guard.allowNextNavigation();
		void goto(resolve(newIncidentPath(id)));
		return true;
	}

	async function leave() {
		if (!guard.confirmDiscard()) return;
		signOutError = null;
		signingOut = true;
		// A 401 (session already gone) counts as signed out; any other failure keeps the session.
		const result = await attemptSignOut(() => signOut());
		signingOut = false;
		if (!result.ok) {
			signOutError = SIGN_OUT_FAILED_MESSAGE;
			return;
		}
		session.clearSession();
		guard.allowNextNavigation();
		await goto(resolve('/login'));
	}

	const failure = $derived(
		$creator.status === 'unknown' && $creator.error
			? presentMutationFailure({ status: 'unknown', error: $creator.error })
			: null
	);
	const errorView = $derived(
		$creator.status === 'error' && $creator.error ? presentCreateError($creator.error) : null
	);
</script>

<svelte:head><title>Nueva incidencia · SoporteFlow</title></svelte:head>

<!-- eslint-disable svelte/no-navigation-without-resolve -- hrefs are built from resolve() -->
<AppShell
	context={$context}
	title="Nueva incidencia"
	current="new-incident"
	{signingOut}
	{signOutError}
	onOrganizationChange={changeOrganization}
	onSignOut={leave}
>
	<nav class="sf-breadcrumb" aria-label="Ruta de navegación">
		<ol>
			<li><a href={listHref}>Incidencias</a></li>
			<li aria-current="page">Nueva incidencia</li>
		</ol>
	</nav>
	<PageHeader
		eyebrow={$context.status === 'ready' ? $context.activeOrganization?.name : null}
		title="Nueva incidencia"
		description="Registra una nueva solicitud de soporte."
	/>
	<OrganizationGate context={$context} onretry={() => void context.load(explicitOrganization)}>
		{#if !canCreate}
			<EmptyState
				title="No puedes crear incidencias"
				description="Tus permisos en esta organización no incluyen la creación de incidencias."
			>
				{#snippet action()}
					{#if navigation.incidents}
						<Button variant="secondary" href={listHref}>Volver a incidencias</Button>
					{/if}
				{/snippet}
			</EmptyState>
		{:else if $creator.status === 'created' && $creator.created?.readability === 'readable'}
			<p class="sf-opening" role="status">Incidencia creada. Abriendo el detalle…</p>
		{:else if $creator.status === 'created' && $creator.created}
			<IncidentCreatedNotice
				incidentNumber={$creator.created.incident.incidentNumber}
				listHref={navigation.incidents ? listHref : null}
				oncreateanother={createAnother}
			/>
		{:else}
			<div class="sf-create-stack">
				{#if failure}
					<Alert
						tone="warning"
						title="No se pudo confirmar si la incidencia se creó"
						requestId={failure.requestId}
					>
						<p>
							No se pudo confirmar el resultado. Comprueba el estado antes de volver a enviar la
							solicitud.
						</p>
						{#snippet actions()}
							{#if navigation.incidents}
								<Button variant="secondary" size="sm" href={listHref}>Comprobar incidencias</Button>
							{/if}
						{/snippet}
					</Alert>
				{:else if errorView}
					<Alert
						tone={$creator.error?.status === 429 ? 'warning' : 'danger'}
						title={errorView.title}
						requestId={errorView.requestId}
					>
						<p>{errorView.message}</p>
					</Alert>
				{/if}
				<IncidentCreateForm
					bind:draft
					{errors}
					{sections}
					catalogs={$catalogs}
					submitting={$creator.status === 'submitting'}
					submitBlockedSeconds={blockedSeconds}
					onsubmit={handleSubmit}
					oncancel={cancel}
					onretrycatalog={(name) => void catalogs.retry(name)}
				/>
			</div>
		{/if}
	</OrganizationGate>
</AppShell>

<style>
	.sf-breadcrumb {
		margin-bottom: var(--space-3);
	}
	.sf-breadcrumb ol {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.sf-breadcrumb li + li::before {
		content: '/';
		margin-right: var(--space-2);
		color: var(--text-subtle);
	}
	.sf-breadcrumb a {
		color: var(--text-secondary);
		text-decoration: none;
		border-radius: var(--radius-sm);
	}
	.sf-breadcrumb a:hover {
		color: var(--accent);
		text-decoration: underline;
	}
	.sf-breadcrumb a:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	.sf-breadcrumb [aria-current='page'] {
		color: var(--text-primary);
		font-weight: 600;
	}
	.sf-opening {
		margin: 0;
		padding: var(--space-6);
		color: var(--text-secondary);
	}
	.sf-create-stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		max-width: 56rem;
	}
</style>

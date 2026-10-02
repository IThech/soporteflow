<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { signOut } from '$lib/api/auth';
	import { listCategories } from '$lib/api/categories';
	import { getIncidentDetail } from '$lib/api/incident-detail';
	import { assignIncident, listAssignees, listTeams, updateIncident } from '$lib/api/incidents';
	import { listMemberships } from '$lib/api/memberships';
	import { listSites } from '$lib/api/sites';
	import { useOrganizationContext } from '$lib/app/context';
	import {
		presentApiError,
		presentMutationFailure,
		remainingSeconds
	} from '$lib/app/error-presentation';
	import { incidentActions } from '$lib/app/incident-actions';
	import {
		catalogSessionExpiry,
		createIncidentDetailCatalogs,
		nameCatalogsFor,
		namesOf
	} from '$lib/app/incident-detail-catalogs';
	import {
		createIncidentDetailController,
		unauthenticatedError
	} from '$lib/app/incident-detail-controller';
	import {
		incidentDetailPath,
		incidentListPath,
		isIncidentRouteId,
		organizationSwitchTarget
	} from '$lib/app/incident-detail-navigation';
	import { presentDetailError } from '$lib/app/incident-detail-presentation';
	import { SESSION_EXPIRED_PATH } from '$lib/app/incident-create-navigation';
	import { attemptSignOut, SIGN_OUT_FAILED_MESSAGE } from '$lib/app/sign-out';
	import { tenantIdentityOf } from '$lib/app/tenant-identity';
	import { session } from '$lib/stores/session';
	import AppShell from '$lib/components/shell/AppShell.svelte';
	import OrganizationGate from '$lib/components/shell/OrganizationGate.svelte';
	import IncidentHeader from '$lib/components/incidents/IncidentHeader.svelte';
	import IncidentDescription from '$lib/components/incidents/IncidentDescription.svelte';
	import IncidentActivity from '$lib/components/incidents/IncidentActivity.svelte';
	import IncidentAttachments from '$lib/components/incidents/IncidentAttachments.svelte';
	import IncidentStaffContext from '$lib/components/incidents/IncidentStaffContext.svelte';
	import IncidentRequesterContext from '$lib/components/incidents/IncidentRequesterContext.svelte';
	import IncidentActionToolbar from '$lib/components/incidents/IncidentActionToolbar.svelte';
	import IncidentAssignModal from '$lib/components/incidents/IncidentAssignModal.svelte';
	import IncidentConfirmModal from '$lib/components/incidents/IncidentConfirmModal.svelte';
	import type { IncidentPriority, IncidentStatus } from '$lib/api/incident-views';
	import Alert from '$lib/ui/Alert.svelte';
	import Button from '$lib/ui/Button.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	/**
	 * /app/incidents/[id] (UI-2C). The page owns route/context, composition and navigation:
	 * - organization context from the URL (UI-1 OrganizationContext; no own bootstrap);
	 * - the detail through the UI-2A controller: identity = user + organization + generation +
	 *   incident; stale answers never reach the state; access-lost after a mutation;
	 * - staff/requester discriminated once: each audience has its own context component;
	 * - staff names of site/category/requester only from catalogs the user may read.
	 * Temporary (until UI-2E): the legacy edit/assign forms stay available to staff with the
	 * capability; their requests go through the controller's pessimistic `mutate` (single-shot,
	 * stale-safe, detail re-read afterwards).
	 */
	const context = useOrganizationContext();
	const detail = createIncidentDetailController({
		fetchDetail: (organizationId, incidentId, { signal }) =>
			getIncidentDetail(organizationId, incidentId, { signal })
	});
	const named = <T extends { id: string; name: string }>(items: T[]) =>
		items.map(({ id, name }) => ({ id, name }));
	const catalogs = createIncidentDetailCatalogs({
		sites: (organizationId, signal) => listSites({ organizationId, signal }).then(named),
		categories: (organizationId, signal) => listCategories({ organizationId, signal }).then(named),
		memberships: (organizationId, signal) =>
			listMemberships({ organizationId, signal }).then((members) =>
				members
					.filter((member) => member.user.active && member.user.name.trim())
					.map((member) => ({ id: member.user.id, name: member.user.name }))
			),
		teams: (organizationId, signal) => listTeams(organizationId, { signal }).then(named),
		assignees: (organizationId, teamId, signal) =>
			listAssignees(organizationId, { ...(teamId ? { teamId } : {}), signal })
	});
	onDestroy(() => {
		detail.dispose();
		catalogs.dispose();
	});

	const explicitOrganization = $derived(page.url.searchParams.get('organizationId'));
	const incidentId = $derived(page.params.id ?? '');
	const validId = $derived(isIncidentRouteId(incidentId));
	let signingOut = $state(false);
	let signOutError = $state<string | null>(null);
	let assignModalOpen = $state(false);
	let confirmModal = $state<{
		open: boolean;
		action: 'close' | 'reopen';
		title: string;
		description: string;
		confirmLabel: string;
		tone: 'primary' | 'danger' | 'warning';
	}>({
		open: false,
		action: 'close',
		title: '',
		description: '',
		confirmLabel: '',
		tone: 'primary'
	});
	let actionError = $state<string | null>(null);
	let now = $state(Date.now());

	/** Session expiry of the CURRENT context: handled once (several 401s may arrive together). */
	let sessionExpired = false;
	function expireSession() {
		if (sessionExpired) return;
		sessionExpired = true;
		session.clearSession();
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
		if (state.status === 'unauthenticated') return expireSession();
		if (
			state.status === 'ready' &&
			!explicitOrganization &&
			state.activeOrganizationId &&
			isIncidentRouteId(incidentId)
		)
			void goto(resolve(incidentDetailPath(state.activeOrganizationId, incidentId)), {
				replaceState: true,
				keepFocus: true,
				noScroll: true
			});
	});

	const identity = $derived(tenantIdentityOf($context));
	const capabilities = $derived(identity?.capabilities ?? []);

	// 3. Target = identity + incident. A new one clears detail, panels and catalogs at once.
	$effect(() => {
		const current = identity;
		const id = incidentId;
		const target = current && isIncidentRouteId(id) ? { identity: current, incidentId: id } : null;
		untrack(() => {
			const before = detail.get().key;
			detail.setTarget(target);
			catalogs.setIdentity(current);
			if (target && detail.get().key !== before) {
				assignModalOpen = false;
				confirmModal.open = false;
				actionError = null;
				void detail.load();
			}
		});
	});

	// 4. Staff names (site, category, requester member), only with the matching capability.
	$effect(() => {
		const shown = $detail.detail;
		const names = nameCatalogsFor(shown, capabilities, identity?.userId ?? null);
		untrack(() => catalogs.loadNames(names));
	});

	// 5. A 401 of the CURRENT detail, mutation or catalog re-authenticates.
	$effect(() => {
		if (unauthenticatedError($detail) || catalogSessionExpiry($catalogs)) expireSession();
	});

	// 6. 429 cooldown clock (ticks only while a cooldown is active).
	$effect(() => {
		if ($detail.cooldownUntil === null) return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});
	const waitSeconds = $derived(remainingSeconds($detail.cooldownUntil, now));

	const shown = $derived(
		$detail.status === 'ready' || $detail.status === 'refreshing' ? $detail.detail : null
	);
	const available = $derived(shown ? incidentActions(shown, capabilities) : null);
	const listHref = $derived(
		identity ? resolve(incidentListPath(identity.organizationId)) : resolve('/app/incidents')
	);
	const failure = $derived(
		$detail.error && ($detail.status === 'error' || $detail.status === 'access-lost')
			? presentDetailError($detail.error, $detail.status === 'access-lost')
			: null
	);

	const isMutating = $derived(Object.values($detail.mutations).some((m) => m.status === 'pending'));

	async function handleStatusChange(targetStatus: IncidentStatus) {
		actionError = null;
		const result = await detail.mutate('status', (organizationId, id) =>
			updateIncident(organizationId, id, { status: targetStatus })
		);
		if (result.status === 'error' || result.status === 'unknown') {
			actionError = presentMutationFailure(result).message;
		}
	}

	async function handlePriorityChange(priority: IncidentPriority) {
		actionError = null;
		const result = await detail.mutate('priority', (organizationId, id) =>
			updateIncident(organizationId, id, { priority })
		);
		if (result.status === 'error' || result.status === 'unknown') {
			actionError = presentMutationFailure(result).message;
		}
	}

	function openAssign() {
		if (!shown || shown.audience !== 'staff') return;
		assignModalOpen = true;
		actionError = null;
		void catalogs.loadTeams();
		void catalogs.loadAssignees(shown.teamId);
	}

	async function saveAssign(data: {
		teamId?: string | null;
		assignedToUserId?: string | null;
		reason?: string;
	}) {
		if (!shown || shown.audience !== 'staff') return;
		if (
			(data.teamId ?? null) === shown.teamId &&
			(data.assignedToUserId ?? null) === shown.assignedToUserId
		) {
			assignModalOpen = false;
			return;
		}
		actionError = null;
		const result = await detail.mutate('assign', (organizationId, id) =>
			assignIncident(organizationId, id, data)
		);
		if (result.status === 'success') {
			assignModalOpen = false;
		} else if (result.status === 'error' || result.status === 'unknown') {
			actionError = presentMutationFailure(result).message;
		}
	}

	function requestClose() {
		actionError = null;
		confirmModal = {
			open: true,
			action: 'close',
			title: 'Cerrar incidencia',
			description:
				'¿Confirmas el cierre de esta incidencia? Al cerrarla, pasará a modo de solo lectura y no se podrán añadir nuevos comentarios ni notas internas a menos que sea reabierta.',
			confirmLabel: 'Confirmar cierre',
			tone: 'danger'
		};
	}

	function requestReopen() {
		actionError = null;
		confirmModal = {
			open: true,
			action: 'reopen',
			title: 'Reabrir incidencia',
			description:
				'¿Confirmas la reapertura de esta incidencia? La incidencia volverá a estar activa y se reactivarán las opciones de gestión y conversación.',
			confirmLabel: 'Reabrir incidencia',
			tone: 'primary'
		};
	}

	async function executeConfirm() {
		const targetStatus: IncidentStatus = confirmModal.action === 'close' ? 'closed' : 'open';
		actionError = null;
		const result = await detail.mutate('status', (organizationId, id) =>
			updateIncident(organizationId, id, { status: targetStatus })
		);
		if (result.status === 'success') {
			confirmModal.open = false;
		} else if (result.status === 'error' || result.status === 'unknown') {
			actionError = presentMutationFailure(result).message;
		}
	}

	const assignError = $derived(
		actionError ??
			($catalogs.teams.error ? presentApiError($catalogs.teams.error).message : null) ??
			($catalogs.assignees.error ? presentApiError($catalogs.assignees.error).message : null)
	);

	function changeOrganization(id: string): boolean {
		// Never carry this incident id to another tenant: go to the new organization's list.
		void goto(resolve(organizationSwitchTarget(id)));
		return true;
	}

	async function leave() {
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
		await goto(resolve('/login'));
	}
</script>

<svelte:head>
	<title>{shown ? `#${shown.incidentNumber} ${shown.title}` : 'Incidencia'} · SoporteFlow</title>
</svelte:head>

<!-- eslint-disable svelte/no-navigation-without-resolve -- hrefs are built from resolve() -->
<AppShell
	context={$context}
	title={shown ? `#${shown.incidentNumber}` : 'Incidencia'}
	current="incidents"
	{signingOut}
	{signOutError}
	onOrganizationChange={changeOrganization}
	onSignOut={leave}
>
	<nav class="sf-breadcrumb" aria-label="Ruta de navegación">
		<ol>
			<li><a href={listHref}>Incidencias</a></li>
			<li aria-current="page">{shown ? `#${shown.incidentNumber}` : 'Incidencia'}</li>
		</ol>
	</nav>
	<OrganizationGate context={$context} onretry={() => void context.load(explicitOrganization)}>
		{#if !validId}
			<PageHeader title="Incidencia no disponible" />
			<Alert tone="warning" title="Incidencia no disponible">
				<p>El enlace no corresponde a ninguna incidencia.</p>
				{#snippet actions()}
					<Button variant="secondary" size="sm" href={listHref}>Volver a incidencias</Button>
				{/snippet}
			</Alert>
		{:else if shown}
			<IncidentHeader
				incident={shown}
				organizationName={$context.status === 'ready' ? $context.activeOrganization?.name : null}
			>
				{#snippet actions()}
					{#if available}
						<IncidentActionToolbar
							incident={shown}
							{available}
							mutating={isMutating}
							onStatusChange={handleStatusChange}
							onPriorityChange={handlePriorityChange}
							onOpenAssign={openAssign}
							onRequestClose={requestClose}
							onRequestReopen={requestReopen}
						/>
					{/if}
				{/snippet}
			</IncidentHeader>
			<div class="sf-detail-grid" aria-busy={$detail.status === 'refreshing' || undefined}>
				<div class="sf-detail-main">
					{#if actionError}
						<div class="sf-action-error" role="alert">
							<Alert tone="danger" title="Error en la acción">
								<p>{actionError}</p>
								{#snippet actions()}
									<Button variant="secondary" size="sm" onclick={() => (actionError = null)}>
										Descartar
									</Button>
								{/snippet}
							</Alert>
						</div>
					{/if}
					<IncidentDescription description={shown.description} />
					{#key shown.id + (identity ? `${identity.userId}:${identity.organizationId}:${identity.generation}` : '')}
						<IncidentAttachments
							{identity}
							incidentId={shown.id}
							{capabilities}
							closed={shown.status === 'closed'}
							onSessionExpiry={expireSession}
						/>
					{/key}
					<IncidentActivity
						incident={shown}
						{identity}
						{capabilities}
						detailController={detail}
						onSessionExpiry={expireSession}
					/>
				</div>
				<aside class="sf-detail-aside" aria-label="Contexto de la incidencia">
					{#if shown.audience === 'staff'}
						<IncidentStaffContext
							incident={shown}
							selfUserId={identity?.userId ?? null}
							selfName={$context.user?.name ?? null}
							siteNames={namesOf($catalogs.sites)}
							categoryNames={namesOf($catalogs.categories)}
							memberNames={namesOf($catalogs.memberships)}
						/>
					{:else}
						<IncidentRequesterContext incident={shown} />
					{/if}
				</aside>
			</div>

			{#if shown.audience === 'staff'}
				<IncidentAssignModal
					open={assignModalOpen}
					currentTeamId={shown.teamId}
					currentTeamName={shown.teamName}
					currentAssigneeUserId={shown.assignedToUserId}
					currentAssigneeUserName={shown.assignedToUserName}
					teams={$catalogs.teams.items}
					assignees={$catalogs.assignees.items}
					teamsLoading={$catalogs.teams.status === 'loading'}
					assigneesLoading={$catalogs.assignees.status === 'loading'}
					submitting={$detail.mutations.assign?.status === 'pending'}
					error={assignError}
					onTeamChange={(teamId) => void catalogs.loadAssignees(teamId)}
					onSave={saveAssign}
					onCancel={() => {
						assignModalOpen = false;
						actionError = null;
					}}
				/>

				<IncidentConfirmModal
					open={confirmModal.open}
					title={confirmModal.title}
					description={confirmModal.description}
					confirmLabel={confirmModal.confirmLabel}
					tone={confirmModal.tone}
					submitting={$detail.mutations.status?.status === 'pending'}
					onConfirm={executeConfirm}
					onCancel={() => {
						confirmModal.open = false;
						actionError = null;
					}}
				/>
			{/if}
		{:else if failure}
			<PageHeader title="Detalle de incidencia" />
			<Alert tone={failure.tone} title={failure.title} requestId={failure.requestId}>
				<p>{failure.message}</p>
				{#if waitSeconds > 0}<p aria-live="polite">Podrás reintentar en {waitSeconds} s.</p>{/if}
				{#snippet actions()}
					{#if failure.retry}
						<Button
							variant="secondary"
							size="sm"
							disabled={waitSeconds > 0}
							onclick={() => void detail.load()}>Reintentar</Button
						>
					{/if}
					<Button variant="secondary" size="sm" href={listHref}>Volver a incidencias</Button>
				{/snippet}
			</Alert>
		{:else}
			<PageHeader title="Detalle de incidencia" />
			<div class="sf-loading"><Spinner label="Cargando incidencia…" /></div>
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
		font-family: var(--font-mono);
	}
	.sf-detail-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(18rem, 22rem);
		gap: var(--space-5);
		align-items: start;
	}
	.sf-detail-main {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}
	.sf-action-error {
		margin-bottom: var(--space-1);
	}
	.sf-detail-aside {
		min-width: 0;
	}
	.sf-detail-grid[aria-busy='true'] {
		opacity: 0.7;
		transition: opacity var(--duration) var(--ease);
	}
	.sf-loading {
		display: flex;
		justify-content: center;
		padding: var(--space-8) var(--space-5);
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface-card);
		box-shadow: var(--sf-shadow-card);
	}
	@media (max-width: 1023px) {
		.sf-detail-grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>

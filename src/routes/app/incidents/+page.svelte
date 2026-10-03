<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { signOut } from '$lib/api/auth';
	import { attemptSignOut, SESSION_EXPIRED_PATH, SIGN_OUT_FAILED_MESSAGE } from '$lib/app/sign-out';
	import type { IncidentQueue } from '$lib/api/incidents';
	import {
		listIncidentsPage,
		INCIDENT_PRIORITIES,
		INCIDENT_STATUSES
	} from '$lib/api/incident-views';
	import type { IncidentPriority, IncidentStatus } from '$lib/api/incident-views';
	import {
		availableQueues,
		incidentReadScope,
		navigationModel,
		resolveQueue
	} from '$lib/app/capabilities';
	import { useOrganizationContext } from '$lib/app/context';
	import {
		createIncidentListController,
		hasActiveFilters,
		type IncidentListQuery
	} from '$lib/app/incident-list-controller';
	import { session } from '$lib/stores/session';
	import AppShell from '$lib/components/shell/AppShell.svelte';
	import OrganizationGate from '$lib/components/shell/OrganizationGate.svelte';
	import IncidentToolbar from '$lib/components/workspace/IncidentToolbar.svelte';
	import IncidentListPanel from '$lib/components/workspace/IncidentListPanel.svelte';
	import Button from '$lib/ui/Button.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';

	/**
	 * Incidents workspace (UI-2A minimal). Real data only: organization context + keyset incidents
	 * API + real capabilities. No demo module is imported (tested).
	 * URL is the source of truth for organizationId, queue and filters; the cursor history lives
	 * in the list controller and resets on any query or tenant change.
	 */
	const context = useOrganizationContext();
	const list = createIncidentListController({
		fetchPage: (organizationId, query, { signal }) =>
			listIncidentsPage(organizationId, query, { signal })
	});
	onDestroy(() => list.dispose());

	const explicitOrganization = $derived(page.url.searchParams.get('organizationId'));
	let signingOut = $state(false);
	let signOutError = $state<string | null>(null);
	let now = $state(Date.now());

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

	// 2. Canonical URL: a remembered/single organization is written into the URL.
	$effect(() => {
		const state = $context;
		if (state.status === 'unauthenticated') {
			session.clearSession();
			void goto(resolve(SESSION_EXPIRED_PATH));
			return;
		}
		if (state.status === 'ready' && !explicitOrganization && state.activeOrganizationId) {
			void goto(resolve(searchWith({ organizationId: state.activeOrganizationId })), {
				replaceState: true,
				keepFocus: true,
				noScroll: true
			});
		}
	});

	const ready = $derived($context.status === 'ready');
	const capabilities = $derived(ready ? $context.capabilities : []);
	const scope = $derived(incidentReadScope(capabilities));
	const queues = $derived(availableQueues(capabilities));
	const navigation = $derived(navigationModel(capabilities));

	function pick<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
		return value !== null && (allowed as readonly string[]).includes(value)
			? (value as T)
			: undefined;
	}
	const query = $derived.by((): IncidentListQuery | null => {
		if (!ready || !scope.any) return null;
		const params = page.url.searchParams;
		return {
			queue: resolveQueue(params.get('queue'), capabilities),
			status: pick<IncidentStatus>(params.get('status'), INCIDENT_STATUSES),
			priority: pick<IncidentPriority>(params.get('priority'), INCIDENT_PRIORITIES)
		};
	});

	// 3. Tenant context for the list: rows of a previous organization are dropped immediately.
	$effect(() => {
		list.setContext($context.contextKey, ready ? $context.activeOrganizationId : null);
	});
	// 4. Query (queue/filters) -> first page; a new query resets the cursor history.
	$effect(() => {
		const next = query;
		if (next) untrack(() => void list.setQuery(next));
	});
	// 5. A 401 of the CURRENT list request (stale ones never reach the state) re-authenticates.
	$effect(() => {
		if ($list.error?.status === 401) {
			session.clearSession();
			void goto(resolve(SESSION_EXPIRED_PATH));
		}
	});
	// 6. Cooldown clock (429): ticks only while a cooldown is active.
	$effect(() => {
		if ($list.cooldownUntil === null) return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	/** `/app/incidents?…` with the current parameters changed (null/'' removes a key). */
	function searchWith(
		changes: Record<string, string | null>
	): '/app/incidents' | `/app/incidents?${string}` {
		const pairs = [...page.url.searchParams].filter(([key]) => !(key in changes));
		for (const [key, value] of Object.entries(changes))
			if (value !== null && value !== '') pairs.push([key, value]);
		const search = pairs
			.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
			.join('&');
		return search ? `/app/incidents?${search}` : '/app/incidents';
	}
	const queueHref = (queue: IncidentQueue) => resolve(searchWith({ queue }));
	function setFilter(key: 'status' | 'priority', value: string) {
		void goto(resolve(searchWith({ [key]: value || null })), { keepFocus: true, noScroll: true });
	}
	function clearFilters() {
		void goto(resolve(searchWith({ status: null, priority: null })), {
			keepFocus: true,
			noScroll: true
		});
	}
	function changeOrganization(id: string) {
		// Queue/filters are dropped: capabilities may differ in the other organization.
		void goto(resolve(`/app/incidents?organizationId=${encodeURIComponent(id)}`));
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
	const createHref = $derived(
		navigation.newIncident && $context.activeOrganizationId
			? `${resolve('/app/incidents/new')}?organizationId=${encodeURIComponent($context.activeOrganizationId)}`
			: null
	);
</script>

<svelte:head><title>Incidencias · SoporteFlow</title></svelte:head>

<AppShell
	context={$context}
	title="Incidencias"
	current="incidents"
	{signingOut}
	{signOutError}
	onOrganizationChange={changeOrganization}
	onSignOut={leave}
>
	{#snippet actions()}
		{#if createHref}<Button href={createHref} size="sm"
				><Icon name="plus" size={16} />Nueva incidencia</Button
			>{/if}
	{/snippet}
	<PageHeader
		eyebrow={$context.status === 'ready' ? $context.activeOrganization?.name : null}
		title="Incidencias"
		description="Gestiona y da seguimiento a los casos de tu organización."
	/>
	<OrganizationGate context={$context} onretry={() => void context.load(explicitOrganization)}>
		{#if !scope.any}
			<EmptyState
				title="Sin acceso a incidencias"
				description="Tus permisos en esta organización no incluyen la consulta de incidencias."
			/>
		{:else}
			<IncidentToolbar
				{queues}
				activeQueue={query?.queue ?? null}
				{queueHref}
				status={query?.status}
				priority={query?.priority}
				disabled={$list.status === 'loading'}
				onfilter={setFilter}
				onclear={clearFilters}
			/>
			<IncidentListPanel
				state={$list}
				filtersActive={query ? hasActiveFilters(query) : false}
				queue={query?.queue ?? null}
				{createHref}
				{now}
				onretry={() => void list.retry()}
				onnext={() => void list.next()}
				onprevious={() => void list.previous()}
				onclear={clearFilters}
			/>
		{/if}
	</OrganizationGate>
</AppShell>

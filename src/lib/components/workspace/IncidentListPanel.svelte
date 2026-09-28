<script lang="ts">
	import type { IncidentListState } from '$lib/app/incident-list-controller';
	import { presentApiError, remainingSeconds } from '$lib/app/error-presentation';
	import Alert from '$lib/ui/Alert.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import Pagination from '$lib/ui/Pagination.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';
	import EmptyStateIllustration from '$lib/ui/illustrations/EmptyStateIllustration.svelte';
	import type { IncidentQueue } from '$lib/api/incidents';
	import { emptyListCopy } from '$lib/app/incident-presentation';
	import IncidentTable from './IncidentTable.svelte';

	/**
	 * Every list state in one place (UI-2A, C8): initial loading, refreshing, empty, no results,
	 * errors (403/404/429 cooldown/5xx with request id/invalid payload). 401 never renders here:
	 * the page redirects to sign-in for the CURRENT context only.
	 */
	let {
		state,
		filtersActive,
		queue = 'all',
		createHref = null,
		now,
		onretry,
		onnext,
		onprevious,
		onclear
	}: {
		state: IncidentListState;
		filtersActive: boolean;
		/** Active queue (null: requester-only scope); selects honest empty-state copy. */
		queue?: IncidentQueue | null;
		createHref?: string | null;
		now: number;
		onretry: () => void;
		onnext: () => void;
		onprevious: () => void;
		onclear: () => void;
	} = $props();

	const error = $derived(state.error ? presentApiError(state.error) : null);
	const waitSeconds = $derived(remainingSeconds(state.cooldownUntil, now));
	const empty = $derived(emptyListCopy(queue));
	const busy = $derived(state.status === 'loading' || state.status === 'refreshing');
</script>

{#if state.status === 'loading' && state.incidents.length === 0}
	<div class="sf-center" aria-busy="true"><Spinner label="Cargando incidencias…" /></div>
{:else if state.status === 'error' && error}
	<Alert tone={error.tone} title={error.title} requestId={error.requestId}>
		<p>{error.message}</p>
		{#if waitSeconds > 0}
			<p aria-live="polite">Podrás reintentar en {waitSeconds} s.</p>
		{/if}
		{#snippet actions()}
			{#if error.action === 'retry'}
				<Button variant="secondary" size="sm" disabled={waitSeconds > 0} onclick={onretry}
					>Reintentar</Button
				>
			{/if}
		{/snippet}
	</Alert>
{:else if state.status !== 'idle' && state.incidents.length === 0 && state.cursorHistory.length <= 1}
	{#if filtersActive}
		<EmptyState
			title="No hay resultados"
			description="Ninguna incidencia coincide con los filtros aplicados."
		>
			{#snippet action()}
				<Button variant="secondary" onclick={onclear}>Limpiar filtros</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<EmptyState title={empty.title} description={empty.description}>
			{#snippet illustration()}<EmptyStateIllustration />{/snippet}
			{#snippet action()}
				{#if createHref}<Button href={createHref}
						><Icon name="plus" size={16} />{empty.createLabel}</Button
					>{/if}
			{/snippet}
		</EmptyState>
	{/if}
{:else if state.status === 'ready' && state.incidents.length === 0}
	<EmptyState title="No hay más incidencias" description="Has llegado al final del listado." />
	<Pagination
		hasPrevious={state.cursorHistory.length > 1}
		hasNext={false}
		{busy}
		{onprevious}
		{onnext}
		label="Paginación de incidencias"
	/>
{:else if state.incidents.length > 0}
	{#if state.status === 'refreshing'}
		<p class="sf-sr-only" role="status">Actualizando incidencias…</p>
	{/if}
	<IncidentTable incidents={state.incidents} {busy} />
	<Pagination
		hasPrevious={state.cursorHistory.length > 1}
		hasNext={state.nextCursor !== null}
		{busy}
		{onprevious}
		{onnext}
		label="Paginación de incidencias"
	/>
{/if}

<style>
	.sf-center {
		display: flex;
		justify-content: center;
		padding: var(--space-8) var(--space-5);
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface-card);
		box-shadow: var(--sf-shadow-card);
	}
</style>

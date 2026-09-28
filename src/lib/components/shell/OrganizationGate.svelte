<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import type { OrganizationContextState } from '$lib/app/organization-context';
	import { presentApiError } from '$lib/app/error-presentation';
	import Alert from '$lib/ui/Alert.svelte';
	import Button from '$lib/ui/Button.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	/**
	 * Renders every non-ready organization state (UI-1A, A3) and the page content only when the
	 * context is ready. An invalid explicit organization is reported, never replaced: the user
	 * chooses explicitly among their own organizations.
	 */
	let {
		context,
		onretry,
		children
	}: { context: OrganizationContextState; onretry: () => void; children: Snippet } = $props();

	const orgHref = (id: string) =>
		`${resolve('/app/incidents')}?organizationId=${encodeURIComponent(id)}`;
	const error = $derived(context.error ? presentApiError(context.error) : null);
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- hrefs are built from resolve() -->
{#snippet organizationChoices()}
	{#if context.organizations.length > 0}
		<ul class="sf-org-choices" aria-label="Tus organizaciones">
			{#each context.organizations as organization (organization.id)}
				<li><a href={orgHref(organization.id)}>{organization.name}</a></li>
			{/each}
		</ul>
	{/if}
{/snippet}

{#if context.status === 'ready'}
	{@render children()}
{:else if context.status === 'idle' || context.status === 'loading' || context.status === 'unauthenticated'}
	<div class="sf-center"><Spinner label="Cargando organización…" /></div>
{:else if context.status === 'invalid-organization'}
	<Alert tone="warning" title="Organización no disponible">
		<p>
			La organización indicada en el enlace no existe o no tienes acceso a ella. No se ha sustituido
			por otra: elige una de tus organizaciones.
		</p>
	</Alert>
	{@render organizationChoices()}
{:else if context.status === 'selection-required'}
	<EmptyState
		title="Selecciona una organización"
		description="Perteneces a varias organizaciones. Elige con cuál quieres trabajar."
	/>
	{@render organizationChoices()}
{:else if context.status === 'no-organizations'}
	<EmptyState
		title="Sin organizaciones activas"
		description="Tu cuenta no pertenece a ninguna organización operativa. Contacta con tu administrador."
	/>
{:else if context.status === 'forbidden'}
	<Alert tone="warning" title="Acceso no permitido" requestId={error?.requestId}>
		<p>No tienes acceso operativo a esta organización.</p>
	</Alert>
	{@render organizationChoices()}
{:else if error}
	<Alert tone={error.tone} title={error.title} requestId={error.requestId}>
		<p>{error.message}</p>
		{#snippet actions()}
			<Button variant="secondary" size="sm" onclick={onretry}>Reintentar</Button>
		{/snippet}
	</Alert>
{/if}

<style>
	.sf-center {
		display: flex;
		justify-content: center;
		padding: var(--space-6);
	}
	.sf-org-choices {
		list-style: none;
		margin: var(--space-4) 0 0;
		padding: 0;
		display: grid;
		gap: var(--space-2);
		max-width: 28rem;
	}
	.sf-org-choices a {
		display: block;
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font-weight: 600;
		text-decoration: none;
	}
	.sf-org-choices a:hover {
		background: var(--surface-muted);
	}
	.sf-org-choices a:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
</style>

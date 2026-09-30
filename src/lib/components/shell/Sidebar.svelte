<script lang="ts">
	import { resolve } from '$app/paths';
	import type { UserOrganizationSummary } from '$lib/api/auth';
	import type { NavigationModel } from '$lib/app/capabilities';
	import Icon from '$lib/ui/Icon.svelte';
	import OrganizationSwitcher from './OrganizationSwitcher.svelte';

	/**
	 * Dark sidebar: brand, organization, capability-driven navigation. Links exist only for
	 * destinations the user can use (UI is not an authority; the server still authorizes).
	 * The administration area (UI-3) is not linked yet: no dead links.
	 * UI-1C: navy surface, refined isotype, line icons, cyan pill for the active section.
	 */
	let {
		id,
		open = false,
		organizations,
		activeOrganizationId,
		navigation,
		current = null,
		switching = false,
		onOrganizationChange,
		onNavigate
	}: {
		id: string;
		open?: boolean;
		organizations: readonly UserOrganizationSummary[];
		activeOrganizationId: string | null;
		navigation: NavigationModel;
		current?: 'incidents' | 'new-incident' | 'admin-clients' | null;
		switching?: boolean;
		onOrganizationChange: (organizationId: string) => boolean | void;
		onNavigate?: () => void;
	} = $props();

	const query = $derived(
		activeOrganizationId ? `?organizationId=${encodeURIComponent(activeOrganizationId)}` : ''
	);
	const incidentsHref = $derived(resolve('/app/incidents') + query);
	const newIncidentHref = $derived(resolve('/app/incidents/new') + query);
	const adminClientsHref = $derived(resolve('/app/admin/clients') + query);
	const markId = $props.id();
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- hrefs are built from resolve() + query -->
<aside {id} class="sf-sidebar" data-open={open} aria-label="Navegación principal">
	<div class="sf-brand">
		<svg class="sf-brand-mark" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
			<defs>
				<linearGradient id="{markId}-bg" x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" style="stop-color: var(--sf-navy-700)" />
					<stop offset="1" style="stop-color: var(--sf-navy-950)" />
				</linearGradient>
				<linearGradient id="{markId}-flow" x1="0" y1="0" x2="1" y2="0">
					<stop offset="0" style="stop-color: var(--sf-cyan-400)" />
					<stop offset="1" style="stop-color: var(--sf-cyan-600)" />
				</linearGradient>
			</defs>
			<rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="url(#{markId}-bg)" />
			<rect
				x="0.5"
				y="0.5"
				width="31"
				height="31"
				rx="8.5"
				fill="none"
				style="stroke: var(--sf-cyan-border)"
			/>
			<path
				d="M21.5 10.5c-1.4-1.3-3.3-2-5.4-2-3.1 0-5.1 1.6-5.1 3.8 0 4.7 10.8 2.6 10.8 7.5 0 2.3-2.2 3.9-5.6 3.9-2.3 0-4.3-.8-5.7-2.2"
				fill="none"
				stroke="url(#{markId}-flow)"
				stroke-width="2.4"
				stroke-linecap="round"
			/>
			<circle cx="21.6" cy="10.4" r="1.6" style="fill: var(--sf-cyan-400)" />
		</svg>
		<span class="sf-brand-name" aria-hidden="true"
			>Soporte<span class="sf-brand-accent">Flow</span></span
		><span class="sf-sr-only">SoporteFlow</span>
	</div>
	<OrganizationSwitcher
		{organizations}
		{activeOrganizationId}
		disabled={switching}
		onchange={onOrganizationChange}
	/>
	{#if activeOrganizationId}
		<nav class="sf-nav" aria-labelledby="{markId}-nav">
			<p class="sf-nav-label" id="{markId}-nav">Operación</p>
			<ul>
				{#if navigation.incidents}
					<li>
						<a
							href={incidentsHref}
							aria-current={current === 'incidents' ? 'page' : undefined}
							onclick={() => onNavigate?.()}><Icon name="inbox" /><span>Incidencias</span></a
						>
					</li>
				{/if}
				{#if navigation.newIncident}
					<li>
						<a
							href={newIncidentHref}
							aria-current={current === 'new-incident' ? 'page' : undefined}
							onclick={() => onNavigate?.()}
							><Icon name="plus-square" /><span>Nueva incidencia</span></a
						>
					</li>
				{/if}
			</ul>
		</nav>
		{#if navigation.adminClients}
			<nav class="sf-nav" aria-labelledby="{markId}-admin">
				<p class="sf-nav-label" id="{markId}-admin">Administración</p>
				<ul>
					<li>
						<a
							href={adminClientsHref}
							aria-current={current === 'admin-clients' ? 'page' : undefined}
							onclick={() => onNavigate?.()}><Icon name="building" /><span>Clientes</span></a
						>
					</li>
				</ul>
			</nav>
		{/if}
	{/if}
</aside>

<style>
	.sf-sidebar {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		width: 16.5rem;
		min-height: 100%;
		padding: var(--space-4) var(--space-3);
		background:
			radial-gradient(120% 60% at 0% 0%, var(--sf-cyan-faint), transparent 60%),
			linear-gradient(180deg, var(--sf-navy-900), var(--sf-navy-950));
		border-right: 1px solid var(--sf-navy-border);
		color: var(--sidebar-text);
	}
	.sf-brand {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-1) var(--space-2) var(--space-3);
	}
	.sf-brand-mark {
		flex: none;
		filter: drop-shadow(0 0 10px var(--sf-cyan-halo));
	}
	.sf-brand-name {
		font-size: var(--text-lg);
		font-weight: 700;
		letter-spacing: var(--tracking-tight);
		color: var(--sf-navy-text-active);
	}
	.sf-brand-accent {
		color: var(--sf-cyan-400);
	}
	.sf-nav {
		margin-top: var(--space-3);
	}
	.sf-nav-label {
		margin: 0 0 var(--space-2);
		padding: 0 var(--space-3);
		font-size: var(--text-2xs);
		font-weight: 600;
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--sf-navy-text-muted);
	}
	.sf-nav ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
	}
	.sf-nav a {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0.5625rem var(--space-3);
		border-radius: var(--radius);
		border: 1px solid transparent;
		color: var(--sf-navy-text-muted);
		text-decoration: none;
		font-size: var(--text-sm);
		font-weight: 500;
		transition:
			background-color var(--duration) var(--ease),
			color var(--duration) var(--ease),
			border-color var(--duration) var(--ease);
	}
	.sf-nav a:hover {
		background: var(--sf-navy-hover);
		color: var(--sf-navy-text-active);
	}
	.sf-nav a[aria-current='page'] {
		background: linear-gradient(90deg, var(--sf-cyan-glow), var(--sf-cyan-faint));
		border-color: var(--sf-cyan-border);
		color: var(--sf-navy-text-active);
		font-weight: 600;
		box-shadow: var(--sf-shadow-glow-nav);
	}
	.sf-nav a[aria-current='page'] :global(.sf-icon) {
		color: var(--sf-cyan-400);
	}
	.sf-nav a:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring-sidebar);
	}
</style>

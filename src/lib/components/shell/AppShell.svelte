<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { OrganizationContextState } from '$lib/app/organization-context';
	import { navigationModel } from '$lib/app/capabilities';
	import Sidebar from './Sidebar.svelte';
	import Topbar from './Topbar.svelte';

	/**
	 * Application shell (UI-1B). Light workspace + dark sidebar.
	 * - ≥1024px: persistent sidebar.
	 * - <1024px (tablet/mobile): the sidebar becomes a modal navigation opened from the top bar;
	 *   Escape or the backdrop closes it and focus returns to the toggle.
	 * Navigation is derived from the organization context's real capabilities only.
	 * UI-1C: navy sidebar, sticky utility bar, light canvas with a centered content column.
	 */
	let {
		context,
		title,
		current = null,
		signingOut = false,
		signOutError = null,
		onOrganizationChange,
		onSignOut,
		actions,
		children
	}: {
		context: OrganizationContextState;
		title: string;
		current?: 'incidents' | 'new-incident' | null;
		signingOut?: boolean;
		/** Safe message of a failed sign-out (shown in the user menu). */
		signOutError?: string | null;
		/** May return false to refuse the change (e.g. the page keeps an unsaved draft). */
		onOrganizationChange: (organizationId: string) => boolean | void;
		onSignOut: () => void;
		actions?: Snippet;
		children: Snippet;
	} = $props();

	const navId = $props.id();
	let navOpen = $state(false);
	const navigation = $derived(
		navigationModel(context.status === 'ready' ? context.capabilities : [])
	);

	function toggleNav() {
		navOpen = !navOpen;
		if (navOpen)
			queueMicrotask(() =>
				document.getElementById(navId)?.querySelector<HTMLElement>('a, select, button')?.focus()
			);
	}
	function closeNav() {
		if (!navOpen) return;
		navOpen = false;
		document.querySelector<HTMLElement>(`[aria-controls="${navId}"]`)?.focus();
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape') closeNav();
	}}
/>

<div class="sf-shell" data-sf-ui>
	<a class="sf-skip" href="#sf-main">Saltar al contenido</a>
	<div class="sf-sidebar-slot" data-open={navOpen}>
		<Sidebar
			id={navId}
			open={navOpen}
			organizations={context.organizations}
			activeOrganizationId={context.activeOrganizationId}
			{navigation}
			{current}
			switching={context.status === 'loading'}
			onOrganizationChange={(id) => {
				const accepted = onOrganizationChange(id);
				if (accepted !== false) navOpen = false;
				return accepted;
			}}
			onNavigate={() => (navOpen = false)}
		/>
	</div>
	{#if navOpen}
		<button class="sf-backdrop" type="button" onclick={closeNav}>
			<span class="sf-sr-only">Cerrar navegación</span>
		</button>
	{/if}
	<div class="sf-workspace">
		<Topbar
			{title}
			userName={context.user?.name ?? null}
			userEmail={context.user?.email ?? null}
			{navOpen}
			{navId}
			{signingOut}
			{signOutError}
			onToggleNav={toggleNav}
			{onSignOut}
			{actions}
		/>
		<main id="sf-main" class="sf-main" tabindex="-1">
			<div class="sf-content">{@render children()}</div>
		</main>
	</div>
</div>

<style>
	.sf-shell {
		display: flex;
		min-height: 100vh;
		background: var(--canvas);
	}
	.sf-skip {
		position: absolute;
		left: var(--space-2);
		top: -3rem;
		z-index: 50;
		padding: var(--space-2) var(--space-3);
		background: var(--surface);
		color: var(--text);
		border-radius: var(--radius);
	}
	.sf-skip:focus {
		top: var(--space-2);
		box-shadow: var(--focus-ring);
		outline: none;
	}
	.sf-sidebar-slot {
		flex: none;
		position: sticky;
		top: 0;
		height: 100vh;
		overflow-y: auto;
		background: var(--sidebar);
	}
	.sf-workspace {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.sf-main {
		flex: 1;
		padding: var(--space-6) var(--space-6) var(--space-7);
		outline: none;
	}
	.sf-content {
		max-width: 80rem;
		margin: 0 auto;
	}
	.sf-backdrop {
		display: none;
	}
	@media (max-width: 1023px) {
		.sf-sidebar-slot {
			display: none;
			position: fixed;
			inset: 0 auto 0 0;
			z-index: 40;
			height: auto;
			box-shadow: var(--shadow);
		}
		.sf-sidebar-slot[data-open='true'] {
			display: block;
		}
		.sf-backdrop {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 35;
			border: 0;
			background: var(--overlay);
			backdrop-filter: blur(2px);
			cursor: pointer;
		}
		.sf-main {
			padding: var(--space-5) var(--space-4) var(--space-6);
		}
	}
</style>

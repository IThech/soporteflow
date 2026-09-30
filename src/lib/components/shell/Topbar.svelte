<script lang="ts">
	import type { Snippet } from 'svelte';
	import ThemeSelector from '$lib/components/ThemeSelector.svelte';
	import { userInitials } from '$lib/app/user-presentation';
	import Icon from '$lib/ui/Icon.svelte';

	/**
	 * Utility bar (UI-1C): mobile navigation toggle, page actions (e.g. the create CTA the page
	 * passes when `incidents:create` is present), the existing appearance control and the
	 * personal menu with real initials. The page heading lives in the canvas (PageHeader); the
	 * title here is only shown on small screens, where the sidebar is hidden.
	 * No notification center yet (UI-4): no dead controls.
	 */
	let {
		title,
		userName,
		userEmail = null,
		adminHref = null,
		navOpen,
		navId,
		signingOut = false,
		signOutError = null,
		onToggleNav,
		onSignOut,
		actions
	}: {
		title: string;
		userName: string | null;
		userEmail?: string | null;
		adminHref?: string | null;
		navOpen: boolean;
		navId: string;
		signingOut?: boolean;
		/** A failed sign-out: shown in the menu; the session is NOT presented as closed. */
		signOutError?: string | null;
		onToggleNav: () => void;
		onSignOut: () => void;
		actions?: Snippet;
	} = $props();
	const displayName = $derived(userName?.trim() || userEmail?.trim() || 'Usuario');
	const initials = $derived(userInitials(displayName, userEmail));
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- adminHref is resolved in parent -->
<header class="sf-topbar">
	<button
		type="button"
		class="sf-nav-toggle"
		aria-controls={navId}
		aria-expanded={navOpen}
		onclick={onToggleNav}
	>
		<Icon name="menu" size={20} />
		<span class="sf-sr-only">{navOpen ? 'Cerrar navegación' : 'Abrir navegación'}</span>
	</button>
	<p class="sf-context-title">{title}</p>
	<div class="sf-topbar-actions">
		{#if actions}<div class="sf-page-actions">{@render actions()}</div>{/if}
		<ThemeSelector />
		{#if adminHref}
			<a
				href={adminHref}
				class="sf-topbar-admin-btn"
				title="Administración"
				aria-label="Administración"
			>
				<Icon name="building" size={16} />
				<span class="sf-topbar-admin-label">Administración</span>
			</a>
		{/if}
		{#if userName || userEmail}
			<span class="sf-divider" aria-hidden="true"></span>
			<details class="sf-user-menu">
				<summary>
					<span class="sf-sr-only">Menú de usuario:</span>
					<span class="sf-avatar" aria-hidden="true">{initials}</span>
					<span class="sf-user-name">{displayName}</span>
					<span class="sf-user-chevron"><Icon name="chevron-down" size={14} /></span>
				</summary>
				<div class="sf-user-panel">
					<div class="sf-user-identity">
						<span class="sf-avatar sf-avatar-lg" aria-hidden="true">{initials}</span>
						<div>
							<p class="sf-user-panel-name">{displayName}</p>
							{#if userEmail}<p class="sf-user-panel-email">{userEmail}</p>{/if}
						</div>
					</div>
					{#if signOutError}
						<p class="sf-sign-out-error" role="alert">{signOutError}</p>
					{/if}
					<button type="button" onclick={onSignOut} disabled={signingOut} aria-busy={signingOut}>
						<Icon name="log-out" size={16} />
						{signingOut ? 'Cerrando sesión…' : 'Cerrar sesión'}
					</button>
				</div>
			</details>
		{/if}
	</div>
</header>

<style>
	.sf-topbar {
		position: sticky;
		top: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 3.75rem;
		padding: var(--space-2) var(--space-6);
		background: color-mix(in srgb, var(--surface) 82%, transparent);
		backdrop-filter: saturate(1.4) blur(10px);
		border-bottom: 1px solid var(--border);
	}
	.sf-nav-toggle {
		display: none;
		width: 2.375rem;
		height: 2.375rem;
		border-radius: var(--radius);
		border: 1px solid var(--border-strong);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}
	.sf-context-title {
		flex: 1;
		min-width: 0;
		margin: 0;
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		visibility: hidden;
	}
	.sf-topbar-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.sf-page-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-right: var(--space-1);
	}
	.sf-topbar-admin-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
		height: 2.25rem;
		padding: 0 var(--space-2-5);
		border-radius: var(--radius);
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text);
		font-size: var(--text-sm);
		font-weight: 500;
		text-decoration: none;
		line-height: 1;
		transition:
			background-color var(--duration) var(--ease),
			border-color var(--duration) var(--ease),
			color var(--duration) var(--ease);
	}
	.sf-topbar-admin-btn:hover {
		background: var(--surface-subtle);
		border-color: var(--border-emphasis, var(--border));
		color: var(--text-emphasis);
	}
	.sf-topbar-admin-btn:focus-visible {
		outline: 2px solid var(--sf-cyan-500);
		outline-offset: 2px;
	}
	@media (max-width: 640px) {
		.sf-topbar-admin-label {
			display: none;
		}
		.sf-topbar-admin-btn {
			padding: 0 var(--space-2);
		}
	}
	.sf-divider {
		width: 1px;
		height: 1.5rem;
		margin: 0 var(--space-1);
		background: var(--border);
	}
	.sf-user-menu {
		position: relative;
	}
	.sf-user-menu summary {
		list-style: none;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 0.1875rem var(--space-2) 0.1875rem 0.1875rem;
		border-radius: var(--radius-pill);
		border: 1px solid transparent;
		color: var(--text);
		font-size: var(--text-sm);
		font-weight: 500;
		cursor: pointer;
		transition:
			background-color var(--duration) var(--ease),
			border-color var(--duration) var(--ease);
	}
	.sf-user-menu summary:hover,
	.sf-user-menu[open] summary {
		background: var(--surface-subtle);
		border-color: var(--border);
	}
	.sf-user-menu summary::-webkit-details-marker {
		display: none;
	}
	.sf-avatar {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-pill);
		background: linear-gradient(135deg, var(--sf-navy-700), var(--sf-navy-900));
		box-shadow: 0 0 0 1px var(--sf-cyan-border);
		color: var(--sf-navy-text-active);
		font-size: var(--text-xs);
		font-weight: 700;
		letter-spacing: 0.02em;
	}
	.sf-avatar-lg {
		width: 2.5rem;
		height: 2.5rem;
		font-size: var(--text-sm);
	}
	.sf-user-name {
		max-width: 11rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sf-user-chevron {
		color: var(--text-muted);
	}
	.sf-user-panel {
		position: absolute;
		right: 0;
		top: calc(100% + var(--space-2));
		z-index: 30;
		width: 16rem;
		padding: var(--space-2);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow);
	}
	.sf-user-identity {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-2) var(--space-3);
		margin-bottom: var(--space-1);
		border-bottom: 1px solid var(--border);
		min-width: 0;
	}
	.sf-user-identity > div {
		min-width: 0;
	}
	.sf-user-panel-name {
		margin: 0;
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.sf-user-panel-email {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
	.sf-sign-out-error {
		margin: 0 0 var(--space-1);
		padding: var(--space-2);
		border-radius: var(--radius);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: var(--text-xs);
		line-height: 1.45;
	}
	.sf-user-panel button {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		padding: var(--space-2);
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: var(--text-sm);
		cursor: pointer;
	}
	.sf-user-panel button:hover {
		background: var(--surface-subtle);
	}
	.sf-nav-toggle:focus-visible,
	.sf-user-menu summary:focus-visible,
	.sf-user-panel button:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	@media (max-width: 1023px) {
		.sf-topbar {
			padding: var(--space-2) var(--space-4);
		}
		.sf-nav-toggle {
			display: inline-grid;
			place-items: center;
		}
		.sf-context-title {
			visibility: visible;
		}
	}
	@media (max-width: 479px) {
		.sf-context-title {
			visibility: hidden;
		}
	}
	@media (max-width: 639px) {
		.sf-user-name,
		.sf-user-chevron,
		.sf-divider {
			display: none;
		}
		.sf-user-menu summary {
			padding: 0.1875rem;
		}
	}
	/* Existing appearance control (styled for the legacy app only): token-based look here. */
	.sf-topbar-actions :global(.appearance-control) {
		position: relative;
	}
	.sf-topbar-actions :global(.appearance-control summary) {
		list-style: none;
		display: inline-grid;
		place-items: center;
		width: 2.375rem;
		height: 2.375rem;
		border-radius: var(--radius);
		border: 1px solid transparent;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--duration) var(--ease),
			color var(--duration) var(--ease);
	}
	.sf-topbar-actions :global(.appearance-control summary:hover),
	.sf-topbar-actions :global(.appearance-control[open] summary) {
		background: var(--surface-subtle);
		color: var(--text);
	}
	.sf-topbar-actions :global(.appearance-control summary::-webkit-details-marker) {
		display: none;
	}
	.sf-topbar-actions :global(.appearance-control summary:focus-visible) {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	.sf-topbar-actions :global(.appearance-menu) {
		position: absolute;
		right: 0;
		top: calc(100% + var(--space-2));
		z-index: 30;
		min-width: 11rem;
		padding: var(--space-2);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow);
		color: var(--text);
	}
	.sf-topbar-actions :global(.appearance-menu button) {
		display: flex;
		justify-content: space-between;
		width: 100%;
		padding: var(--space-2);
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: var(--text-sm);
		cursor: pointer;
	}
	.sf-topbar-actions :global(.appearance-menu button:hover) {
		background: var(--surface-subtle);
	}
	.sf-topbar-actions :global(.appearance-menu button:focus-visible) {
		outline: none;
		box-shadow: var(--focus-ring);
	}
</style>

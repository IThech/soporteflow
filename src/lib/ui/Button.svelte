<script lang="ts">
	import type { Snippet } from 'svelte';
	import Spinner from './Spinner.svelte';

	/**
	 * Button primitive. Renders <a> when `href` is given (navigation) and <button> otherwise
	 * (actions): links and buttons are never swapped. No domain logic.
	 */
	let {
		variant = 'primary',
		size = 'md',
		type = 'button',
		href,
		disabled = false,
		loading = false,
		ariaLabel,
		onclick,
		children
	}: {
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
		size?: 'sm' | 'md';
		type?: 'button' | 'submit' | 'reset';
		href?: string;
		disabled?: boolean;
		loading?: boolean;
		ariaLabel?: string;
		onclick?: (event: MouseEvent) => void;
		children: Snippet;
	} = $props();
	const inactive = $derived(disabled || loading);
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- callers pass already resolved hrefs -->
{#if href && !inactive}
	<a class="sf-button" data-variant={variant} data-size={size} {href} aria-label={ariaLabel}>
		{@render children()}
	</a>
{:else}
	<button
		class="sf-button"
		data-variant={variant}
		data-size={size}
		{type}
		disabled={inactive}
		aria-busy={loading || undefined}
		aria-label={ariaLabel}
		{onclick}
	>
		{#if loading}<Spinner size="sm" label="Procesando…" />{/if}
		{@render children()}
	</button>
{/if}

<style>
	.sf-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		min-height: 2.375rem;
		padding: 0 var(--space-4);
		border-radius: var(--radius);
		border: 1px solid transparent;
		font: inherit;
		font-size: var(--text-sm);
		font-weight: 600;
		letter-spacing: -0.005em;
		line-height: 1;
		white-space: nowrap;
		text-decoration: none;
		cursor: pointer;
		transition:
			background-color var(--duration) var(--ease),
			border-color var(--duration) var(--ease),
			color var(--duration) var(--ease),
			box-shadow var(--duration) var(--ease);
	}
	.sf-button[data-size='sm'] {
		min-height: 2rem;
		padding: 0 var(--space-3);
		font-size: var(--text-xs);
	}
	.sf-button:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	.sf-button[data-variant='primary'] {
		background: var(--accent);
		color: var(--accent-contrast);
		box-shadow:
			var(--shadow-sm),
			inset 0 1px 0 var(--sf-highlight);
	}
	.sf-button[data-variant='primary']:hover:not(:disabled) {
		background: var(--accent-strong);
		box-shadow: var(--shadow-sm), var(--sf-shadow-glow);
	}
	.sf-button[data-variant='primary']:focus-visible {
		box-shadow: var(--focus-ring);
	}
	.sf-button[data-variant='secondary'] {
		background: var(--surface);
		border-color: var(--border-strong);
		color: var(--text);
		box-shadow: var(--shadow-sm);
	}
	.sf-button[data-variant='secondary']:hover:not(:disabled) {
		background: var(--surface-subtle);
	}
	.sf-button[data-variant='ghost'] {
		background: transparent;
		color: var(--text);
	}
	.sf-button[data-variant='ghost']:hover:not(:disabled) {
		background: var(--surface-subtle);
	}
	.sf-button[data-variant='danger'] {
		background: var(--danger);
		color: var(--surface);
	}
	.sf-button:disabled {
		cursor: not-allowed;
		opacity: 0.5;
		box-shadow: none;
	}
</style>

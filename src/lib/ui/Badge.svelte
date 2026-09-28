<script lang="ts">
	import type { Snippet } from 'svelte';
	/**
	 * Status/label badge. The text itself carries the meaning (never color alone); tones map to
	 * semantic tokens.
	 */
	let {
		tone = 'neutral',
		children
	}: {
		tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';
		children: Snippet;
	} = $props();
</script>

<span class="sf-badge" data-tone={tone}>{@render children()}</span>

<style>
	.sf-badge {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0.125rem var(--space-2);
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--surface-muted);
		color: var(--text);
		font-size: var(--text-xs);
		font-weight: 600;
		white-space: nowrap;
	}
	.sf-badge[data-tone='info'] {
		background: var(--info-soft);
		color: var(--info);
		border-color: transparent;
	}
	.sf-badge[data-tone='success'] {
		background: var(--success-soft);
		color: var(--success);
		border-color: transparent;
	}
	.sf-badge[data-tone='warning'] {
		background: var(--warning-soft);
		color: var(--warning);
		border-color: transparent;
	}
	.sf-badge[data-tone='danger'] {
		background: var(--danger-soft);
		color: var(--danger);
		border-color: transparent;
	}
	.sf-badge[data-tone='accent'] {
		background: var(--accent-soft);
		color: var(--accent);
		border-color: transparent;
	}
</style>

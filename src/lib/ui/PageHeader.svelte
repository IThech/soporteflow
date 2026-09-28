<script lang="ts">
	import type { Snippet } from 'svelte';
	/**
	 * Page heading in the canvas (UI-1C): optional eyebrow (e.g. the active organization), the
	 * page's single <h1>, an optional description and optional actions. No domain logic.
	 */
	let {
		eyebrow,
		title,
		description,
		actions
	}: { eyebrow?: string | null; title: string; description?: string; actions?: Snippet } = $props();
</script>

<header class="sf-page-header">
	<div class="sf-page-heading">
		{#if eyebrow}<p class="sf-eyebrow">{eyebrow}</p>{/if}
		<h1>{title}</h1>
		{#if description}<p class="sf-page-description">{description}</p>{/if}
	</div>
	{#if actions}<div class="sf-page-header-actions">{@render actions()}</div>{/if}
</header>

<style>
	.sf-page-header {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--space-4);
		margin-bottom: var(--space-5);
	}
	.sf-page-heading {
		min-width: 0;
	}
	.sf-eyebrow {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0 0 var(--space-2);
		font-size: var(--text-2xs);
		font-weight: 700;
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--accent);
		overflow-wrap: anywhere;
	}
	.sf-eyebrow::before {
		content: '';
		flex: none;
		width: 0.375rem;
		height: 0.375rem;
		border-radius: var(--radius-pill);
		background: var(--sf-cyan-500);
		box-shadow: 0 0 0 3px var(--sf-cyan-glow);
	}
	h1 {
		margin: 0;
		font-size: var(--text-2xl);
		line-height: 1.2;
		font-weight: 700;
		letter-spacing: var(--tracking-tight);
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}
	.sf-page-description {
		margin: var(--space-1) 0 0;
		max-width: 42rem;
		font-size: var(--text-sm);
		line-height: 1.5;
		color: var(--text-secondary);
	}
	.sf-page-header-actions {
		display: flex;
		gap: var(--space-2);
	}
</style>

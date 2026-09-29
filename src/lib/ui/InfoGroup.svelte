<script lang="ts">
	import type { Snippet } from 'svelte';
	/**
	 * A titled group of facts (UI-2C): <h2> + <dl>. Rows are `<div><dt/><dd/></div>` rendered by
	 * the caller; this primitive only provides semantics and compact styling.
	 */
	let { title, children }: { title: string; children: Snippet } = $props();
	const uid = $props.id();
</script>

<section class="sf-info-group" aria-labelledby="{uid}-title">
	<h2 id="{uid}-title">{title}</h2>
	<dl>{@render children()}</dl>
</section>

<style>
	.sf-info-group + :global(.sf-info-group) {
		margin-top: var(--space-5);
		padding-top: var(--space-5);
		border-top: 1px solid var(--border-subtle);
	}
	h2 {
		margin: 0 0 var(--space-3);
		font-size: var(--text-2xs);
		font-weight: 700;
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--text-muted);
	}
	dl {
		display: grid;
		gap: var(--space-3);
		margin: 0;
	}
	dl :global(> div) {
		display: grid;
		grid-template-columns: minmax(7.5rem, 40%) minmax(0, 1fr);
		gap: var(--space-2);
		align-items: baseline;
	}
	dl :global(dt) {
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	dl :global(dd) {
		margin: 0;
		min-width: 0;
		font-size: var(--text-sm);
		font-weight: 500;
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}
	dl :global(dd.sf-muted) {
		font-weight: 400;
		color: var(--text-muted);
	}
</style>

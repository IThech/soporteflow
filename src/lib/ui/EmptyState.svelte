<script lang="ts">
	import type { Snippet } from 'svelte';
	/**
	 * Neutral "nothing to show" block with an optional decorative illustration and call to action.
	 * `description` may be several short paragraphs. UI-1C: white card surface.
	 */
	let {
		title,
		description,
		illustration,
		action
	}: {
		title: string;
		description?: string | readonly string[];
		illustration?: Snippet;
		action?: Snippet;
	} = $props();
	const paragraphs = $derived(
		description === undefined ? [] : typeof description === 'string' ? [description] : description
	);
</script>

<div class="sf-empty" role="status" data-illustrated={illustration ? 'true' : undefined}>
	{#if illustration}<div class="sf-empty-illustration">{@render illustration()}</div>{/if}
	<p class="sf-empty-title">{title}</p>
	{#each paragraphs as paragraph, index (index)}
		<p class="sf-empty-description">{paragraph}</p>
	{/each}
	{#if action}<div class="sf-empty-action">{@render action()}</div>{/if}
</div>

<style>
	.sf-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface-card);
		box-shadow: var(--sf-shadow-card);
		padding: var(--space-7) var(--space-5);
		text-align: center;
	}
	.sf-empty[data-illustrated='true'] {
		padding: var(--space-8) var(--space-5);
	}
	.sf-empty-illustration {
		margin-bottom: var(--space-5);
	}
	.sf-empty-title {
		margin: 0 0 var(--space-2);
		font-size: var(--text-lg);
		font-weight: 700;
		letter-spacing: var(--tracking-tight);
		color: var(--text-primary);
	}
	.sf-empty-description {
		margin: 0 auto;
		max-width: 30rem;
		font-size: var(--text-sm);
		line-height: 1.55;
		color: var(--text-secondary);
	}
	.sf-empty-action {
		margin-top: var(--space-5);
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: var(--space-2);
	}
</style>

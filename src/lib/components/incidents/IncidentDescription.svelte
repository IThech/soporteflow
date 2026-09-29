<script lang="ts">
	/**
	 * Incident description as plain text (UI-2C): line breaks kept, long words wrap, any markup the
	 * text may contain is rendered literally (text interpolation only; never raw HTML).
	 */
	let { description }: { description: string } = $props();
	const uid = $props.id();
</script>

<section class="sf-description" aria-labelledby="{uid}-title">
	<h2 id="{uid}-title">Descripción</h2>
	{#if description.trim()}
		<p class="sf-description-text">{description}</p>
	{:else}
		<p class="sf-description-empty">Sin descripción.</p>
	{/if}
</section>

<style>
	.sf-description {
		padding: var(--space-6);
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface-card);
		box-shadow: var(--sf-shadow-card);
	}
	h2 {
		margin: 0 0 var(--space-3);
		font-size: var(--text-2xs);
		font-weight: 700;
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.sf-description-text {
		margin: 0;
		max-width: 72ch;
		font-size: var(--text-sm);
		line-height: 1.7;
		color: var(--text-primary);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.sf-description-empty {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	@media (max-width: 639px) {
		.sf-description {
			padding: var(--space-5) var(--space-4);
		}
	}
</style>

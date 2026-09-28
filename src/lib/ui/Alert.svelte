<script lang="ts">
	import type { Snippet } from 'svelte';
	/**
	 * Inline message. danger/warning use role="alert" (announced immediately); info/success use
	 * role="status". The optional request id lets users quote the server reference to support.
	 */
	let {
		tone = 'info',
		title,
		requestId,
		children,
		actions
	}: {
		tone?: 'info' | 'success' | 'warning' | 'danger';
		title: string;
		requestId?: string;
		children?: Snippet;
		actions?: Snippet;
	} = $props();
	const role = $derived(tone === 'danger' || tone === 'warning' ? 'alert' : 'status');
</script>

<div class="sf-alert" data-tone={tone} {role}>
	<p class="sf-alert-title">{title}</p>
	{#if children}<div class="sf-alert-body">{@render children()}</div>{/if}
	{#if requestId}
		<p class="sf-alert-ref">Referencia para soporte: <code>{requestId}</code></p>
	{/if}
	{#if actions}<div class="sf-alert-actions">{@render actions()}</div>{/if}
</div>

<style>
	.sf-alert {
		border: 1px solid var(--border);
		border-left-width: 4px;
		border-radius: var(--radius);
		background: var(--surface);
		padding: var(--space-3) var(--space-4);
		font-size: var(--text-sm);
		color: var(--text);
	}
	.sf-alert[data-tone='info'] {
		border-left-color: var(--info);
	}
	.sf-alert[data-tone='success'] {
		border-left-color: var(--success);
	}
	.sf-alert[data-tone='warning'] {
		border-left-color: var(--warning);
	}
	.sf-alert[data-tone='danger'] {
		border-left-color: var(--danger);
	}
	.sf-alert-title {
		margin: 0;
		font-weight: 700;
	}
	.sf-alert-body {
		margin-top: var(--space-1);
		color: var(--text-muted);
	}
	.sf-alert-ref {
		margin: var(--space-2) 0 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	.sf-alert-ref code {
		font-family: var(--font-mono);
		user-select: all;
	}
	.sf-alert-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}
</style>

<script lang="ts">
	import type { IncidentPublicComment } from '$lib/api/incidents';
	import type { ApiError } from '$lib/api/errors';
	import { formatDetailDate } from '$lib/app/incident-detail-presentation';
	import { presentApiError } from '$lib/app/error-presentation';
	import Alert from '$lib/ui/Alert.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	let {
		items,
		status,
		loadingMore = false,
		nextCursor = null,
		error = null,
		onRetry,
		onLoadMore
	}: {
		items: readonly IncidentPublicComment[];
		status: 'idle' | 'loading' | 'ready' | 'error';
		loadingMore?: boolean;
		nextCursor?: string | null;
		error?: ApiError | null;
		onRetry?: () => void;
		onLoadMore?: () => void;
	} = $props();

	function initials(name: string): string {
		const parts = name.trim().split(/\s+/);
		if (parts.length >= 2 && parts[0] && parts[1]) {
			return (parts[0][0] + parts[1][0]).toUpperCase();
		}
		return name.slice(0, 2).toUpperCase() || '??';
	}
</script>

<div class="sf-comment-list-wrapper">
	{#if status === 'loading' && items.length === 0}
		<div class="sf-feed-loading" role="status">
			<Spinner label="Cargando conversación…" />
		</div>
	{:else if status === 'error' && items.length === 0}
		{@const presented = error ? presentApiError(error) : null}
		<Alert tone={presented?.tone ?? 'danger'} title={presented?.title ?? 'Error de conversación'}>
			<p>{presented?.message ?? 'No se pudieron cargar los mensajes.'}</p>
			{#snippet actions()}
				{#if onRetry}
					<Button variant="secondary" size="sm" onclick={onRetry}>Reintentar</Button>
				{/if}
			{/snippet}
		</Alert>
	{:else if items.length === 0}
		<div class="sf-feed-empty">
			<p>Aún no hay mensajes en esta incidencia.</p>
		</div>
	{:else}
		<ol class="sf-comment-list" aria-label="Lista de comentarios">
			{#each items as item (item.id)}
				<li class="sf-comment-item">
					<article class="sf-comment-card" id="comment-{item.id}">
						<header class="sf-comment-header">
							<div class="sf-comment-author">
								<span class="sf-author-avatar" aria-hidden="true">{initials(item.author.name)}</span
								>
								<span class="sf-author-name">{item.author.name}</span>
							</div>
							<time class="sf-comment-date" datetime={item.createdAt}>
								{formatDetailDate(item.createdAt) ?? item.createdAt}
							</time>
						</header>
						<div class="sf-comment-content">
							<p class="sf-comment-body">{item.body}</p>
						</div>
					</article>
				</li>
			{/each}
		</ol>

		{#if nextCursor}
			<div class="sf-load-more">
				<Button variant="secondary" size="sm" disabled={loadingMore} onclick={onLoadMore}>
					{loadingMore ? 'Cargando anteriores…' : 'Cargar comentarios anteriores'}
				</Button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.sf-comment-list-wrapper {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.sf-feed-loading {
		display: flex;
		justify-content: center;
		padding: var(--space-6) var(--space-4);
	}
	.sf-feed-empty {
		padding: var(--space-6) var(--space-4);
		text-align: center;
		background: var(--surface-card);
		border: 1px dashed var(--border);
		border-radius: var(--radius-lg);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.sf-feed-empty p {
		margin: 0;
	}
	.sf-comment-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.sf-comment-item {
		min-width: 0;
	}
	.sf-comment-card {
		padding: var(--space-4) var(--space-5);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface-card);
		box-shadow: var(--sf-shadow-card);
		transition: border-color var(--duration) var(--ease);
	}
	.sf-comment-card:hover {
		border-color: var(--border-hover, var(--border));
	}
	.sf-comment-header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-bottom: var(--space-2);
	}
	.sf-comment-author {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}
	.sf-author-avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-full, 9999px);
		background: var(--surface-elevated, rgba(148, 163, 184, 0.15));
		color: var(--text-secondary);
		font-size: var(--text-xs);
		font-weight: 600;
		letter-spacing: 0.02em;
		flex-shrink: 0;
	}
	.sf-author-name {
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}
	.sf-comment-date {
		font-size: var(--text-xs);
		color: var(--text-muted);
		white-space: nowrap;
	}
	.sf-comment-content {
		font-size: var(--text-sm);
		line-height: 1.6;
		color: var(--text-primary);
	}
	.sf-comment-body {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.sf-load-more {
		display: flex;
		justify-content: center;
		padding: var(--space-2) 0;
	}
	@media (max-width: 639px) {
		.sf-comment-card {
			padding: var(--space-3) var(--space-4);
		}
	}
</style>

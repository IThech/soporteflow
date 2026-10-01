<script lang="ts">
	import type { IncidentHistoryItem } from '$lib/api/incidents';
	import type { ApiError } from '$lib/api/errors';
	import { formatDetailDate } from '$lib/app/incident-detail-presentation';
	import {
		historyEventTitle,
		historyEventTone,
		describeHistoryChanges
	} from '$lib/app/incident-history-presentation';
	import { STATUS_TONES, PRIORITY_TONES } from '$lib/app/incident-presentation';
	import { presentApiError } from '$lib/app/error-presentation';
	import Alert from '$lib/ui/Alert.svelte';
	import Badge from '$lib/ui/Badge.svelte';
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
		items: readonly IncidentHistoryItem[];
		status: 'idle' | 'loading' | 'ready' | 'error';
		loadingMore?: boolean;
		nextCursor?: string | null;
		error?: ApiError | null;
		onRetry?: () => void;
		onLoadMore?: () => void;
	} = $props();
</script>

<div class="sf-history-list-wrapper">
	{#if status === 'loading' && items.length === 0}
		<div class="sf-feed-loading" role="status">
			<Spinner label="Cargando historial…" />
		</div>
	{:else if status === 'error' && items.length === 0}
		{@const presented = error ? presentApiError(error) : null}
		<Alert tone={presented?.tone ?? 'danger'} title={presented?.title ?? 'Error de historial'}>
			<p>{presented?.message ?? 'No se pudo cargar el historial de la incidencia.'}</p>
			{#snippet actions()}
				{#if onRetry}
					<Button variant="secondary" size="sm" onclick={onRetry}>Reintentar</Button>
				{/if}
			{/snippet}
		</Alert>
	{:else if items.length === 0}
		<div class="sf-feed-empty">
			<p>No hay actividad registrada en esta incidencia.</p>
		</div>
	{:else}
		<ol class="sf-history-timeline" aria-label="Historial de actividad">
			{#each items as item (item.id)}
				{@const changes = describeHistoryChanges(item)}
				{@const tone = historyEventTone(item.type)}
				<li class="sf-timeline-item" id="history-{item.id}">
					<div class="sf-timeline-marker" aria-hidden="true">
						<span class="sf-timeline-dot sf-dot-{tone}"></span>
						<span class="sf-timeline-line"></span>
					</div>

					<article class="sf-history-card">
						<header class="sf-history-header">
							<div class="sf-history-meta">
								<Badge tone={item.actor.type === 'system' ? 'neutral' : 'info'}>
									{item.actor.label}
								</Badge>
								<span class="sf-history-title">{historyEventTitle(item.type)}</span>
							</div>
							<time class="sf-history-date" datetime={item.occurredAt}>
								{formatDetailDate(item.occurredAt) ?? item.occurredAt}
							</time>
						</header>

						{#if changes.statusChange}
							{@const sFrom = item.changes?.status?.from}
							{@const sTo = item.changes?.status?.to}
							<div class="sf-history-change">
								<span class="sf-change-label">Estado:</span>
								{#if sFrom}
									<Badge tone={STATUS_TONES[sFrom]}>{changes.statusChange.fromLabel}</Badge>
								{:else}
									<span class="sf-change-val">{changes.statusChange.fromLabel}</span>
								{/if}
								<span class="sf-change-arrow" aria-hidden="true">→</span>
								{#if sTo}
									<Badge tone={STATUS_TONES[sTo]}>{changes.statusChange.toLabel}</Badge>
								{:else}
									<span class="sf-change-val">{changes.statusChange.toLabel}</span>
								{/if}
							</div>
						{/if}

						{#if changes.priorityChange}
							{@const pFrom = item.changes?.priority?.from}
							{@const pTo = item.changes?.priority?.to}
							<div class="sf-history-change">
								<span class="sf-change-label">Prioridad:</span>
								{#if pFrom}
									<Badge tone={PRIORITY_TONES[pFrom]}>{changes.priorityChange.fromLabel}</Badge>
								{:else}
									<span class="sf-change-val">{changes.priorityChange.fromLabel}</span>
								{/if}
								<span class="sf-change-arrow" aria-hidden="true">→</span>
								{#if pTo}
									<Badge tone={PRIORITY_TONES[pTo]}>{changes.priorityChange.toLabel}</Badge>
								{:else}
									<span class="sf-change-val">{changes.priorityChange.toLabel}</span>
								{/if}
							</div>
						{/if}

						{#if changes.levelChange}
							<div class="sf-history-change">
								<span class="sf-change-label">Nivel:</span>
								<Badge>{changes.levelChange.from}</Badge>
								<span class="sf-change-arrow" aria-hidden="true">→</span>
								<Badge>{changes.levelChange.to}</Badge>
							</div>
						{/if}

						{#if changes.note}
							<p class="sf-history-note">{changes.note}</p>
						{/if}
					</article>
				</li>
			{/each}
		</ol>

		{#if nextCursor}
			<div class="sf-load-more">
				<Button variant="secondary" size="sm" disabled={loadingMore} onclick={onLoadMore}>
					{loadingMore ? 'Cargando eventos anteriores…' : 'Cargar eventos anteriores'}
				</Button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.sf-history-list-wrapper {
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
	.sf-history-timeline {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.sf-timeline-item {
		display: grid;
		grid-template-columns: 1.5rem 1fr;
		gap: var(--space-3);
		position: relative;
	}
	.sf-timeline-marker {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding-top: var(--space-4);
	}
	.sf-timeline-dot {
		width: 0.625rem;
		height: 0.625rem;
		border-radius: var(--radius-full, 9999px);
		flex-shrink: 0;
		background: var(--text-muted);
		border: 2px solid var(--surface-card);
		box-shadow: 0 0 0 1px var(--border);
	}
	.sf-dot-info {
		background: var(--accent);
	}
	.sf-dot-success {
		background: var(--success, #16a34a);
	}
	.sf-dot-warning {
		background: var(--warning, #d97706);
	}
	.sf-dot-danger {
		background: var(--danger, #dc2626);
	}
	.sf-dot-neutral {
		background: var(--text-muted);
	}
	.sf-timeline-line {
		width: 2px;
		flex-grow: 1;
		background: var(--border);
		margin: var(--space-1) 0;
	}
	.sf-timeline-item:last-child .sf-timeline-line {
		display: none;
	}
	.sf-history-card {
		padding: var(--space-3-5, var(--space-3)) var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface-card);
		box-shadow: var(--sf-shadow-card);
		margin-bottom: var(--space-3);
		transition: border-color var(--duration) var(--ease);
	}
	.sf-history-card:hover {
		border-color: var(--border-hover, var(--border));
	}
	.sf-history-header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.sf-history-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}
	.sf-history-title {
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}
	.sf-history-date {
		font-size: var(--text-xs);
		color: var(--text-muted);
		white-space: nowrap;
	}
	.sf-history-change {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-2);
		font-size: var(--text-xs);
	}
	.sf-change-label {
		color: var(--text-muted);
		font-weight: 500;
	}
	.sf-change-val {
		color: var(--text-secondary);
	}
	.sf-change-arrow {
		color: var(--text-muted);
	}
	.sf-history-note {
		margin: var(--space-2) 0 0;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		line-height: 1.5;
	}
	.sf-load-more {
		display: flex;
		justify-content: center;
		padding: var(--space-2) 0;
	}
	@media (max-width: 639px) {
		.sf-history-card {
			padding: var(--space-3);
		}
		.sf-timeline-item {
			grid-template-columns: 1rem 1fr;
			gap: var(--space-2);
		}
	}
</style>

<script lang="ts">
	import { untrack } from 'svelte';
	import type { IncidentQueue } from '$lib/api/incidents';
	import {
		INCIDENT_PRIORITIES,
		INCIDENT_STATUSES,
		type IncidentPriority,
		type IncidentStatus
	} from '$lib/api/incident-views';
	import { QUEUE_LABELS, priorityLabel, statusLabel } from '$lib/app/incident-presentation';
	import Icon from '$lib/ui/Icon.svelte';

	/**
	 * Queues (links: they change the URL) + status/priority filters (selects). Only queues the
	 * user can use are rendered. Changes are reported to the page, which owns the URL.
	 * UI-1C: segmented pill queues (no counters: the API has no totals) and integrated filter
	 * fields (native selects, visible labels). Only the filters UI-1 already exposes.
	 */
	let {
		queues,
		activeQueue,
		queueHref,
		status,
		priority,
		disabled = false,
		onfilter,
		onclear
	}: {
		queues: readonly IncidentQueue[];
		activeQueue: IncidentQueue | null;
		queueHref: (queue: IncidentQueue) => string;
		status: IncidentStatus | undefined;
		priority: IncidentPriority | undefined;
		disabled?: boolean;
		onfilter: (key: 'status' | 'priority', value: string) => void;
		onclear: () => void;
	} = $props();
	const statusId = $props.id();
	const priorityId = `${statusId}-priority`;

	/*
	 * Sliding active indicator (visual only). The links, hrefs and aria-current are unchanged;
	 * the indicator is measured from the link that carries aria-current="page" and moved with
	 * transform + width. Until it is measured (SSR, no JS) the active link keeps its own
	 * background, so the state is never lost. The first placement is not animated.
	 */
	let queuesNav = $state<HTMLElement | null>(null);
	let indicator = $state<{ x: number; width: number } | null>(null);
	let animate = $state(false);

	function measureIndicator() {
		const active = queuesNav?.querySelector<HTMLElement>('a[aria-current="page"]');
		const next = active ? { x: active.offsetLeft, width: active.offsetWidth } : null;
		// Assign only on a real change (no redundant updates on resize).
		if (next?.x !== indicator?.x || next?.width !== indicator?.width) indicator = next;
	}

	// Re-measure when the active queue or the available queues change. The measurement reads and
	// writes `indicator`, so it runs untracked: the effect depends only on the queue props.
	$effect(() => {
		void activeQueue;
		void queues;
		if (!queuesNav) return;
		untrack(measureIndicator);
		if (untrack(() => animate)) return;
		// Enable the transition only after the first placement has been painted.
		const frame = requestAnimationFrame(() => (animate = true));
		return () => cancelAnimationFrame(frame);
	});
</script>

<svelte:window onresize={measureIndicator} />

<!-- eslint-disable svelte/no-navigation-without-resolve -- queueHref builds resolved hrefs -->
<div class="sf-toolbar">
	{#if queues.length > 0}
		<nav
			class="sf-queues"
			aria-label="Colas de incidencias"
			bind:this={queuesNav}
			data-indicator={indicator ? 'ready' : undefined}
		>
			<span
				class="sf-queue-indicator"
				aria-hidden="true"
				data-animate={animate}
				style:transform={indicator ? `translateX(${indicator.x}px)` : undefined}
				style:width={indicator ? `${indicator.width}px` : undefined}
			></span>
			{#each queues as queue (queue)}
				<a href={queueHref(queue)} aria-current={queue === activeQueue ? 'page' : undefined}
					>{QUEUE_LABELS[queue]}</a
				>
			{/each}
		</nav>
	{/if}
	<div class="sf-filters" role="group" aria-label="Filtros">
		<div class="sf-field">
			<label for={statusId}>Estado</label>
			<select
				id={statusId}
				value={status ?? ''}
				{disabled}
				onchange={(event) => onfilter('status', event.currentTarget.value)}
			>
				<option value="">Todos</option>
				{#each INCIDENT_STATUSES as value (value)}
					<option {value}>{statusLabel(value)}</option>
				{/each}
			</select>
			<span class="sf-chevron"><Icon name="chevron-down" size={16} /></span>
		</div>
		<div class="sf-field">
			<label for={priorityId}>Prioridad</label>
			<select
				id={priorityId}
				value={priority ?? ''}
				{disabled}
				onchange={(event) => onfilter('priority', event.currentTarget.value)}
			>
				<option value="">Todas</option>
				{#each INCIDENT_PRIORITIES as value (value)}
					<option {value}>{priorityLabel(value)}</option>
				{/each}
			</select>
			<span class="sf-chevron"><Icon name="chevron-down" size={16} /></span>
		</div>
		{#if status || priority}
			<button type="button" class="sf-clear" {disabled} onclick={onclear}
				><Icon name="filter-x" size={15} />Limpiar filtros</button
			>
		{/if}
	</div>
</div>

<style>
	.sf-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: var(--space-4);
	}
	.sf-queues {
		position: relative;
		display: inline-flex;
		gap: 2px;
		max-width: 100%;
		padding: 3px;
		overflow-x: auto;
		scrollbar-width: none;
		border-radius: var(--radius-pill);
		border: 1px solid var(--border);
		background: var(--surface-subtle);
	}
	.sf-queues::-webkit-scrollbar {
		display: none;
	}
	.sf-queue-indicator {
		position: absolute;
		top: 3px;
		bottom: 3px;
		left: 0;
		width: 0;
		z-index: 0;
		border-radius: var(--radius-pill);
		background: var(--surface);
		box-shadow:
			var(--shadow-sm),
			0 0 0 1px var(--sf-cyan-border);
		opacity: 0;
		pointer-events: none;
		will-change: transform, width;
	}
	.sf-queues[data-indicator='ready'] .sf-queue-indicator {
		opacity: 1;
	}
	.sf-queue-indicator[data-animate='true'] {
		transition:
			transform 200ms cubic-bezier(0.22, 1, 0.36, 1),
			width 200ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	/* Once the indicator is measured it carries the active surface; the link stays transparent. */
	.sf-queues[data-indicator='ready'] a[aria-current='page'] {
		background: transparent;
		box-shadow: none;
		/* hand-over to the indicator is immediate: no double surface fading out */
		transition: color var(--duration) var(--ease);
	}
	.sf-queues[data-indicator='ready'] a[aria-current='page']:focus-visible {
		box-shadow: var(--focus-ring);
	}
	@media (prefers-reduced-motion: reduce) {
		.sf-queue-indicator[data-animate='true'] {
			transition: none;
		}
	}
	.sf-queues a {
		position: relative;
		z-index: 1;
		flex: none;
		padding: 0.4375rem var(--space-4);
		border-radius: var(--radius-pill);
		color: var(--text-secondary);
		font-size: var(--text-sm);
		font-weight: 600;
		text-decoration: none;
		white-space: nowrap;
		transition:
			background-color var(--duration) var(--ease),
			color var(--duration) var(--ease),
			box-shadow var(--duration) var(--ease);
	}
	.sf-queues a:hover:not([aria-current='page']) {
		color: var(--text-primary);
		background: color-mix(in srgb, var(--surface) 60%, transparent);
	}
	.sf-queues a[aria-current='page'] {
		background: var(--surface);
		color: var(--text-primary);
		box-shadow:
			var(--shadow-sm),
			0 0 0 1px var(--sf-cyan-border);
	}
	.sf-filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	.sf-field {
		position: relative;
		display: flex;
		align-items: center;
		min-height: 2.375rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: var(--shadow-sm);
		transition: border-color var(--duration) var(--ease);
	}
	.sf-field:hover {
		border-color: var(--text-subtle);
	}
	.sf-field:focus-within {
		border-color: var(--sf-cyan-600);
		box-shadow: var(--focus-ring);
	}
	.sf-field label {
		padding-left: var(--space-3);
		font-size: var(--text-xs);
		font-weight: 500;
		color: var(--text-muted);
		white-space: nowrap;
	}
	select {
		appearance: none;
		min-height: 2.25rem;
		min-width: 7.5rem;
		padding: 0 2rem 0 var(--space-2);
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		font-size: var(--text-sm);
		font-weight: 600;
		cursor: pointer;
	}
	select:focus-visible {
		outline: none;
	}
	.sf-chevron {
		position: absolute;
		right: var(--space-2);
		color: var(--text-muted);
		pointer-events: none;
	}
	.sf-clear {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: 2.375rem;
		padding: 0 var(--space-3);
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--accent);
		font: inherit;
		font-size: var(--text-sm);
		font-weight: 600;
		cursor: pointer;
	}
	.sf-clear:hover:not(:disabled) {
		background: var(--accent-soft);
	}
	.sf-queues a:focus-visible,
	.sf-clear:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	.sf-clear:disabled,
	select:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	@media (max-width: 639px) {
		.sf-toolbar {
			flex-direction: column;
			align-items: stretch;
		}
		.sf-queues {
			align-self: flex-start;
		}
		.sf-filters {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.sf-field {
			min-width: 0;
		}
		.sf-field select {
			flex: 1;
			min-width: 0;
		}
		.sf-clear {
			grid-column: 1 / -1;
			justify-self: start;
		}
	}
</style>

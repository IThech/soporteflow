<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { IncidentDetailView } from '$lib/api/incident-detail';
	import {
		PRIORITY_TONES,
		STATUS_TONES,
		priorityLabel,
		statusLabel
	} from '$lib/app/incident-presentation';
	import Badge from '$lib/ui/Badge.svelte';

	/**
	 * Incident heading (UI-2C): number, title (the page's single <h1>), status and priority as
	 * text badges (never color alone). Only fields common to every audience are read here.
	 * `actions` holds the controls the page decides to offer (none are invented here).
	 */
	let {
		incident,
		organizationName = null,
		actions
	}: {
		incident: Pick<IncidentDetailView, 'incidentNumber' | 'title' | 'status' | 'priority'>;
		organizationName?: string | null;
		actions?: Snippet;
	} = $props();
</script>

<header class="sf-incident-header">
	<div class="sf-incident-heading">
		<p class="sf-incident-meta">
			<span class="sf-incident-number">#{incident.incidentNumber}</span>
			{#if organizationName}<span class="sf-incident-org">{organizationName}</span>{/if}
		</p>
		<h1>{incident.title}</h1>
		<ul class="sf-incident-badges" aria-label="Estado y prioridad">
			<li>
				<span class="sf-sr-only">Estado:</span>
				<Badge tone={STATUS_TONES[incident.status]}>{statusLabel(incident.status)}</Badge>
			</li>
			<li>
				<span class="sf-sr-only">Prioridad:</span>
				<Badge tone={PRIORITY_TONES[incident.priority]}>
					Prioridad {priorityLabel(incident.priority).toLowerCase()}
				</Badge>
			</li>
		</ul>
	</div>
	{#if actions}<div class="sf-incident-actions">{@render actions()}</div>{/if}
</header>

<style>
	.sf-incident-header {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-4);
		margin-bottom: var(--space-5);
	}
	.sf-incident-heading {
		flex: 1 1 28rem;
		min-width: 0;
	}
	.sf-incident-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin: 0 0 var(--space-2);
		font-size: var(--text-2xs);
		font-weight: 700;
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.sf-incident-number {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		letter-spacing: 0;
		color: var(--accent);
	}
	.sf-incident-org {
		overflow-wrap: anywhere;
	}
	.sf-incident-org::before {
		content: '·';
		margin-right: var(--space-2);
		color: var(--text-subtle);
	}
	h1 {
		margin: 0;
		font-size: var(--text-2xl);
		line-height: 1.25;
		font-weight: 700;
		letter-spacing: var(--tracking-tight);
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}
	.sf-incident-badges {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: var(--space-3) 0 0;
		padding: 0;
		list-style: none;
	}
	.sf-incident-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
</style>

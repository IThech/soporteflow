<script lang="ts">
	import { resolve } from '$app/paths';
	import type { IncidentView } from '$lib/api/incident-views';
	import Badge from '$lib/ui/Badge.svelte';
	import {
		PRIORITY_TONES,
		SLA_LABELS,
		SLA_TONES,
		STATUS_TONES,
		assignmentLabel,
		formatDate,
		incidentHref,
		priorityLabel,
		statusLabel
	} from '$lib/app/incident-presentation';

	/**
	 * Incident table (UI-2A). Columns follow the projection the server sent:
	 * - staff view: number + title, requester label, status, priority, assignment/team, SLA, date;
	 * - requester view (customer): number + title, status, priority, SLA, date — nothing internal.
	 * The mode is decided by the rows themselves (a requester list never contains staff rows).
	 */
	let {
		incidents,
		busy = false,
		caption = 'Incidencias'
	}: { incidents: readonly IncidentView[]; busy?: boolean; caption?: string } = $props();

	const staffMode = $derived(incidents.some((incident) => incident.audience === 'staff'));
	const base = resolve('/app/incidents');
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- hrefs are built from resolve() -->
<div class="sf-table-wrap" aria-busy={busy}>
	<table class="sf-table">
		<caption class="sf-sr-only">{caption}</caption>
		<thead>
			<tr>
				<th scope="col">Incidencia</th>
				{#if staffMode}<th scope="col">Solicitante</th>{/if}
				<th scope="col">Estado</th>
				<th scope="col">Prioridad</th>
				{#if staffMode}<th scope="col">Asignación</th>{/if}
				<th scope="col">SLA</th>
				<th scope="col">Creada</th>
			</tr>
		</thead>
		<tbody>
			{#each incidents as incident (incident.id)}
				<tr>
					<td class="sf-cell-title">
						<a href={incidentHref(base, incident)}>
							<span class="sf-number">#{incident.incidentNumber}</span>
							<span class="sf-title-text">{incident.title}</span>
						</a>
					</td>
					{#if staffMode}
						<td>{incident.audience === 'staff' ? incident.client : ''}</td>
					{/if}
					<td><Badge tone={STATUS_TONES[incident.status]}>{statusLabel(incident.status)}</Badge></td
					>
					<td>
						<Badge tone={PRIORITY_TONES[incident.priority]}
							>{priorityLabel(incident.priority)}</Badge
						>
					</td>
					{#if staffMode}
						<td>
							{#if incident.audience === 'staff'}
								<span>{assignmentLabel(incident)}</span>
								{#if incident.teamName}<span class="sf-muted"> · {incident.teamName}</span>{/if}
							{/if}
						</td>
					{/if}
					<td>
						<Badge tone={SLA_TONES[incident.slaOverallStatus]}>
							{SLA_LABELS[incident.slaOverallStatus]}
						</Badge>
					</td>
					<td class="sf-date"
						><time datetime={incident.createdAt}>{formatDate(incident.createdAt)}</time></td
					>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.sf-table-wrap {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface-card);
		box-shadow: var(--sf-shadow-card);
		transition: opacity var(--duration) var(--ease);
	}
	.sf-table-wrap[aria-busy='true'] {
		opacity: 0.65;
	}
	.sf-table {
		width: 100%;
		min-width: 56rem;
		border-collapse: collapse;
		font-size: var(--text-sm);
		color: var(--text);
	}
	th {
		text-align: left;
		padding: var(--space-3) var(--space-4);
		font-size: var(--text-2xs);
		font-weight: 700;
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--text-muted);
		background: var(--surface-subtle);
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}
	td {
		padding: 0.875rem var(--space-4);
		border-bottom: 1px solid var(--border-subtle);
		vertical-align: middle;
	}
	tbody tr {
		transition: background-color var(--duration) var(--ease);
	}
	tbody tr:last-child td {
		border-bottom: 0;
	}
	tbody tr:hover {
		background: color-mix(in srgb, var(--sf-cyan-500) 4%, var(--surface-card));
	}
	.sf-cell-title a {
		display: inline-flex;
		flex-direction: column;
		gap: 0.125rem;
		color: var(--text);
		text-decoration: none;
		border-radius: var(--radius-sm);
	}
	.sf-cell-title a:hover .sf-title-text {
		text-decoration: underline;
	}
	.sf-cell-title a:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	.sf-number {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--accent);
		font-weight: 700;
	}
	.sf-title-text {
		font-weight: 600;
		overflow-wrap: break-word;
	}
	.sf-cell-title {
		min-width: 16rem;
	}
	.sf-muted {
		color: var(--text-muted);
	}
	.sf-date {
		white-space: nowrap;
		color: var(--text-muted);
	}
</style>

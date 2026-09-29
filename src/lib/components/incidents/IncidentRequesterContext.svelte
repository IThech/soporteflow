<script lang="ts">
	import type { RequesterIncidentDetailView } from '$lib/api/incident-detail';
	import {
		formatDetailDate,
		SLA_OBJECTIVE_LABELS,
		SLA_OBJECTIVE_TONES
	} from '$lib/app/incident-detail-presentation';
	import { SLA_LABELS, SLA_TONES } from '$lib/app/incident-presentation';
	import Badge from '$lib/ui/Badge.svelte';
	import InfoGroup from '$lib/ui/InfoGroup.svelte';

	/**
	 * Context of an incident for its REQUESTER (UI-2C). A separate, simpler component — not the
	 * staff one with hidden rows. It accepts only RequesterIncidentDetailView, which has no
	 * internal field at all (no assignee, team, support level, SLA policy/snapshot, creator, client
	 * label). Site/category ids are not shown: resolving their names would need catalogs a
	 * requester is not meant to read. SLA: only the compliance statuses the projection carries.
	 */
	let { incident }: { incident: RequesterIncidentDetailView } = $props();
	const hasSla = $derived(incident.slaOverallStatus !== 'not_applicable');
</script>

<div class="sf-context" data-audience="requester">
	<InfoGroup title="Seguimiento">
		<div>
			<dt>Creada</dt>
			<dd>
				<time datetime={incident.createdAt}>{formatDetailDate(incident.createdAt)}</time>
			</dd>
		</div>
		<div>
			<dt>Última actualización</dt>
			<dd>
				<time datetime={incident.updatedAt}>{formatDetailDate(incident.updatedAt)}</time>
			</dd>
		</div>
	</InfoGroup>

	{#if hasSla}
		<InfoGroup title="Compromiso de atención">
			<div>
				<dt>Estado</dt>
				<dd>
					<Badge tone={SLA_TONES[incident.slaOverallStatus]}>
						{SLA_LABELS[incident.slaOverallStatus]}
					</Badge>
				</dd>
			</div>
			<div>
				<dt>Primera respuesta</dt>
				<dd>
					<Badge tone={SLA_OBJECTIVE_TONES[incident.slaFirstResponseStatus]}>
						{SLA_OBJECTIVE_LABELS[incident.slaFirstResponseStatus]}
					</Badge>
				</dd>
			</div>
			<div>
				<dt>Resolución</dt>
				<dd>
					<Badge tone={SLA_OBJECTIVE_TONES[incident.slaResolutionStatus]}>
						{SLA_OBJECTIVE_LABELS[incident.slaResolutionStatus]}
					</Badge>
				</dd>
			</div>
		</InfoGroup>
	{/if}
</div>

<style>
	.sf-context {
		padding: var(--space-5);
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface-card);
		box-shadow: var(--sf-shadow-card);
	}
</style>

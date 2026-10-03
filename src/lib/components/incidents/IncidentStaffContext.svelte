<script lang="ts">
	import type { StaffIncidentDetailView } from '$lib/api/incident-detail';
	import {
		catalogName,
		formatDetailDate,
		SLA_OBJECTIVE_LABELS,
		SLA_OBJECTIVE_TONES,
		staffAssigneeLabel,
		staffRequesterLabel,
		staffTeamLabel
	} from '$lib/app/incident-detail-presentation';
	import { SLA_LABELS, SLA_TONES } from '$lib/app/incident-presentation';
	import Badge from '$lib/ui/Badge.svelte';
	import InfoGroup from '$lib/ui/InfoGroup.svelte';

	/**
	 * Operational context of an incident for STAFF (UI-2C). Accepts only StaffIncidentDetailView:
	 * a requester projection can never reach this component. Read-only; values as sent by the
	 * server (SLA statuses are the server's derivation; nothing is recomputed). Names of site,
	 * category and requester come from catalogs the user may read (null map -> "No disponible").
	 */
	let {
		incident,
		selfUserId,
		selfName,
		siteNames,
		categoryNames,
		memberNames
	}: {
		incident: StaffIncidentDetailView;
		selfUserId: string | null;
		selfName: string | null;
		siteNames: ReadonlyMap<string, string> | null;
		categoryNames: ReadonlyMap<string, string> | null;
		memberNames: ReadonlyMap<string, string> | null;
	} = $props();

	const hasSla = $derived(incident.slaOverallStatus !== 'not_applicable');
	const dateRows = $derived([
		['Creada', incident.createdAt],
		['Actualizada', incident.updatedAt],
		['Primera respuesta', incident.firstResponseAt],
		['Primera resolución', incident.firstResolvedAt]
	] as const);
</script>

{#snippet date(value: string | null)}
	{@const text = formatDetailDate(value)}
	{#if text && value}<dd><time datetime={value}>{text}</time></dd>{:else}<dd class="sf-muted">
			Sin registrar
		</dd>{/if}
{/snippet}

<div class="sf-context" data-audience="staff">
	<InfoGroup title="Solicitante">
		<div>
			<dt>Cliente</dt>
			<dd>{incident.client}</dd>
		</div>
		<div>
			<dt>Solicitante</dt>
			<dd>{staffRequesterLabel(incident, selfUserId, selfName, memberNames)}</dd>
		</div>
	</InfoGroup>

	<InfoGroup title="Clasificación">
		<div>
			<dt>Sede</dt>
			<dd>{catalogName(incident.siteId, siteNames, 'Sin sede')}</dd>
		</div>
		<div>
			<dt>Categoría</dt>
			<dd>{catalogName(incident.categoryId, categoryNames, 'Sin categoría')}</dd>
		</div>
		{#if incident.categoryId}
			<div>
				<dt>Subcategoría</dt>
				<dd>{catalogName(incident.subcategoryId, categoryNames, 'Sin subcategoría')}</dd>
			</div>
		{/if}
	</InfoGroup>

	<InfoGroup title="Asignación">
		<div>
			<dt>Equipo</dt>
			<dd>{staffTeamLabel(incident)}</dd>
		</div>
		<div>
			<dt>Técnico</dt>
			<dd>{staffAssigneeLabel(incident)}</dd>
		</div>
		<div>
			<dt>Nivel</dt>
			<dd><Badge>{incident.supportLevel}</Badge></dd>
		</div>
	</InfoGroup>

	<InfoGroup title="SLA">
		<div>
			<dt>Estado general</dt>
			<dd>
				<Badge tone={SLA_TONES[incident.slaOverallStatus]}>
					{SLA_LABELS[incident.slaOverallStatus]}
				</Badge>
			</dd>
		</div>
		{#if hasSla}
			<div>
				<dt>Primera respuesta</dt>
				<dd>
					<Badge tone={SLA_OBJECTIVE_TONES[incident.slaFirstResponseStatus]}>
						{SLA_OBJECTIVE_LABELS[incident.slaFirstResponseStatus]}
					</Badge>
				</dd>
			</div>
			<div>
				<dt>Límite de respuesta</dt>
				{@render date(incident.firstResponseDueAt)}
			</div>
			<div>
				<dt>Resolución</dt>
				<dd>
					<Badge tone={SLA_OBJECTIVE_TONES[incident.slaResolutionStatus]}>
						{SLA_OBJECTIVE_LABELS[incident.slaResolutionStatus]}
					</Badge>
				</dd>
			</div>
			<div>
				<dt>Límite de resolución</dt>
				{@render date(incident.resolutionDueAt)}
			</div>
		{/if}
	</InfoGroup>

	<InfoGroup title="Fechas">
		{#each dateRows as [label, value] (label)}
			<div>
				<dt>{label}</dt>
				{@render date(value)}
			</div>
		{/each}
	</InfoGroup>
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

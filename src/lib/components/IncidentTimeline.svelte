<script lang="ts">
	import { canViewIncident } from '$lib/auth/record-access';
	import { visibleIncidentHistory, describeHistoryEvent } from '$lib/incidents/timeline';
	import type { Incident } from '$lib/types/incident';
	import type { IncidentHistoryEntry } from '$lib/types/incident-history';
	import type { AppUser } from '$lib/types/user';
	import type { IncidentCategory } from '$lib/types/category';
	import type { SupportTeam } from '$lib/types/support';
	let {
		incident,
		viewer,
		entries,
		users,
		categories = [],
		teams = []
	}: {
		incident: Incident;
		viewer: AppUser;
		entries: IncidentHistoryEntry[];
		users: AppUser[];
		categories?: IncidentCategory[];
		teams?: SupportTeam[];
	} = $props();
	const allowed = $derived(viewer.role !== 'client' && canViewIncident(viewer, incident));
	const events = $derived(visibleIncidentHistory(viewer, incident, entries));
	const dateFormat = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'medium' });
	function formatDate(value: string) {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? 'Fecha no disponible' : dateFormat.format(date);
	}
</script>

{#if allowed}
	<section aria-label="Historial de la incidencia" class="mt-8 border-t border-slate-700 pt-6">
		<h3 class="text-lg font-semibold">Historial de la incidencia</h3>
		<p class="mt-1 text-sm text-slate-400">Del primer evento al más reciente. Horas locales.</p>
		<ol class="mt-5 space-y-5 border-l border-slate-700 pl-4">
			{#each events as event (event.id)}
				<li class="break-words">
					<time datetime={event.timestamp} class="text-xs text-slate-400"
						>{formatDate(event.timestamp)}</time
					>
					<p class="mt-1 text-sm text-slate-200">
						{describeHistoryEvent(event, users, categories, teams)}
					</p>
					{#if event.reason?.trim()}<p class="mt-2 text-sm whitespace-pre-wrap text-slate-300">
							<span class="font-semibold">Motivo:</span>
							{event.reason}
						</p>{/if}
					{#if event.comment?.trim()}<p class="mt-2 text-sm whitespace-pre-wrap text-slate-300">
							<span class="font-semibold">Comentario:</span>
							{event.comment}
						</p>{/if}
				</li>
			{:else}<li class="text-sm text-slate-400">
					Esta incidencia todavía no tiene eventos registrados.
				</li>{/each}
		</ol>
	</section>
{/if}

<script lang="ts">
	import type { IncidentListItem } from '$lib/api/incidents';

	interface Props {
		incidents: IncidentListItem[];
		loading?: boolean;
		error?: string | null;
	}

	let { incidents = [], loading = false, error = null }: Props = $props();

	const STATUS_LABELS: Record<string, string> = {
		open: 'Abierta',
		pending: 'Pendiente',
		resolved: 'Resuelta',
		closed: 'Cerrada'
	};

	const STATUS_STYLES: Record<string, string> = {
		open: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
		pending: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
		resolved: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
		closed: 'border-slate-500/30 bg-slate-500/10 text-slate-400'
	};

	const PRIORITY_LABELS: Record<string, string> = {
		low: 'Baja',
		medium: 'Media',
		high: 'Alta',
		urgent: 'Urgente'
	};

	const PRIORITY_STYLES: Record<string, string> = {
		low: 'border-slate-500/20 bg-slate-500/10 text-slate-400',
		medium: 'border-blue-500/20 bg-blue-500/10 text-blue-400',
		high: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
		urgent: 'border-rose-500/20 bg-rose-500/10 font-semibold text-rose-400'
	};

	function formatDate(dateStr: string): string {
		if (!dateStr) return '';
		try {
			const d = new Date(dateStr);
			if (isNaN(d.getTime())) return dateStr;
			return new Intl.DateTimeFormat('es-ES', {
				day: '2-digit',
				month: '2-digit',
				year: 'numeric',
				hour: '2-digit',
				minute: '2-digit'
			}).format(d);
		} catch {
			return dateStr;
		}
	}
</script>

<div class="real-incidents-container">
	{#if loading}
		<div class="flex items-center justify-center p-8 text-center" role="status" aria-live="polite">
			<svg
				class="mr-3 h-5 w-5 animate-spin text-cyan-400"
				xmlns="http://www.w3.org/2000/svg"
				fill="none"
				viewBox="0 0 24 24"
				aria-hidden="true"
			>
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"
				></circle>
				<path
					class="opacity-75"
					fill="currentColor"
					d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
				></path>
			</svg>
			<span class="text-sm font-medium text-slate-300">Cargando incidencias...</span>
		</div>
	{:else if error}
		<div
			class="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300"
			role="alert"
		>
			<p class="font-medium">{error}</p>
		</div>
	{:else if incidents.length === 0}
		<div class="rounded-lg border border-slate-800 bg-slate-950/40 p-8 text-center">
			<p class="text-sm text-slate-400">No hay incidencias en esta organización.</p>
		</div>
	{:else}
		<div class="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/50">
			<table class="w-full text-left text-sm text-slate-300">
				<thead
					class="border-b border-slate-800 bg-slate-900/80 text-xs font-semibold text-slate-400"
				>
					<tr>
						<th scope="col" class="px-4 py-3">Número</th>
						<th scope="col" class="px-4 py-3">Título</th>
						<th scope="col" class="px-4 py-3">Cliente</th>
						<th scope="col" class="px-4 py-3">Estado</th>
						<th scope="col" class="px-4 py-3">Prioridad</th>
						<th scope="col" class="px-4 py-3">Fecha de creación</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-slate-800/60">
					{#each incidents as incident (incident.id)}
						<tr class="transition-colors hover:bg-slate-800/30">
							<td class="px-4 py-3 font-mono text-xs font-bold whitespace-nowrap text-cyan-400">
								#{incident.incidentNumber}
							</td>
							<td class="px-4 py-3 font-medium text-white">
								<span class="line-clamp-2">{incident.title}</span>
							</td>
							<td class="px-4 py-3 whitespace-nowrap text-slate-300">
								{incident.client}
							</td>
							<td class="px-4 py-3 whitespace-nowrap">
								<span
									class={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
										STATUS_STYLES[incident.status] ?? 'border-slate-700 bg-slate-800 text-slate-300'
									}`}
								>
									{STATUS_LABELS[incident.status] ?? incident.status}
								</span>
							</td>
							<td class="px-4 py-3 whitespace-nowrap">
								<span
									class={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
										PRIORITY_STYLES[incident.priority] ??
										'border-slate-700 bg-slate-800 text-slate-300'
									}`}
								>
									{PRIORITY_LABELS[incident.priority] ?? incident.priority}
								</span>
							</td>
							<td class="px-4 py-3 text-xs whitespace-nowrap text-slate-400">
								{formatDate(incident.createdAt)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

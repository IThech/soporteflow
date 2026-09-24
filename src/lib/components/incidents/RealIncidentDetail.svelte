<script lang="ts">
	import type { IncidentListItem } from '$lib/api/incidents';
	import {
		STATUS_LABELS,
		STATUS_STYLES,
		PRIORITY_LABELS,
		PRIORITY_STYLES,
		formatDate
	} from './presentation';

	interface Props {
		incident: IncidentListItem | null;
		loading?: boolean;
		error?: string | null;
		onEdit?: () => void;
		onAssign?: () => void;
	}

	let { incident = null, loading = false, error = null, onEdit, onAssign }: Props = $props();
</script>

<div class="real-incident-detail">
	{#if loading}
		<div class="flex items-center justify-center p-12 text-center" role="status" aria-live="polite">
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
			<span class="text-sm font-medium text-slate-300">Cargando incidencia...</span>
		</div>
	{:else if error}
		<div
			class="rounded-lg border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-300"
			role="alert"
		>
			<p class="font-medium">{error}</p>
		</div>
	{:else if incident}
		<div class="space-y-6 rounded-xl border border-slate-800 bg-slate-900/60 p-6 md:p-8">
			<!-- Header: Ticket Number, Badges, Title, Action Buttons -->
			<div class="space-y-3 border-b border-slate-800 pb-6">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div class="flex flex-wrap items-center gap-3">
						<span class="font-mono text-sm font-bold text-cyan-400">
							#{incident.incidentNumber}
						</span>
						<span
							class={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
								STATUS_STYLES[incident.status] ?? 'border-slate-700 bg-slate-800 text-slate-300'
							}`}
						>
							{STATUS_LABELS[incident.status] ?? incident.status}
						</span>
						<span
							class={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
								PRIORITY_STYLES[incident.priority] ?? 'border-slate-700 bg-slate-800 text-slate-300'
							}`}
						>
							{PRIORITY_LABELS[incident.priority] ?? incident.priority}
						</span>
					</div>
					<div class="flex items-center gap-2">
						{#if onAssign}
							<button
								type="button"
								onclick={onAssign}
								class="inline-flex items-center rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-1.5 text-xs font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-700 hover:text-white focus:ring-2 focus:ring-cyan-500 focus:outline-none"
							>
								{incident.assignedToUserId ? 'Reasignar' : 'Asignar técnico'}
							</button>
						{/if}
						{#if onEdit}
							<button
								type="button"
								onclick={onEdit}
								class="inline-flex items-center rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-1.5 text-xs font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-700 hover:text-white focus:ring-2 focus:ring-cyan-500 focus:outline-none"
							>
								Editar incidencia
							</button>
						{/if}
					</div>
				</div>
				<h1 class="text-xl font-bold tracking-tight text-white md:text-2xl">
					{incident.title}
				</h1>
			</div>

			<!-- Description -->
			<div class="space-y-2">
				<h2 class="text-xs font-semibold tracking-wider text-slate-400 uppercase">Descripción</h2>
				<div
					class="rounded-lg border border-slate-800/80 bg-slate-950/40 p-4 text-sm leading-relaxed whitespace-pre-wrap text-slate-200"
				>
					{incident.description}
				</div>
			</div>

			<!-- Metadata Grid -->
			<div
				class="grid grid-cols-1 gap-4 border-t border-slate-800 pt-6 text-sm sm:grid-cols-2 lg:grid-cols-4"
			>
				<div>
					<span class="block text-xs font-medium text-slate-400">Cliente</span>
					<span class="mt-1 font-medium text-slate-200">{incident.client}</span>
				</div>
				<div>
					<span class="block text-xs font-medium text-slate-400">Asignado a</span>
					<span class="mt-1 font-medium text-slate-200">
						{incident.assignedToUserName ??
							(incident.assignedToUserId ? 'Técnico asignado' : 'Sin asignar')}
					</span>
				</div>
				<div>
					<span class="block text-xs font-medium text-slate-400">Fecha de creación</span>
					<span class="mt-1 text-slate-300">{formatDate(incident.createdAt)}</span>
				</div>
				<div>
					<span class="block text-xs font-medium text-slate-400">Última actualización</span>
					<span class="mt-1 text-slate-300">{formatDate(incident.updatedAt)}</span>
				</div>
			</div>
		</div>
	{/if}
</div>

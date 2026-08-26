<script lang="ts">
	import { incidents as initialIncidents } from '$lib/data/incidents';
	import type { IncidentPriority, IncidentStatus } from '$lib/types/incident';
	import { onMount } from 'svelte';

	let incidentList = $state([...initialIncidents]);
	const summary = $derived([
		{
			label: 'Incidencias abiertas',
			value: incidentList.filter((incident) => incident.status === 'open').length,
			color: 'text-cyan-400'
		},
		{
			label: 'Pendientes',
			value: incidentList.filter((incident) => incident.status === 'pending').length,
			color: 'text-amber-400'
		},
		{
			label: 'Resueltas',
			value: incidentList.filter((incident) => incident.status === 'resolved').length,
			color: 'text-emerald-400'
		}
	]);
	let title = $state('');
	let client = $state('');
	let priority = $state<IncidentPriority>('medium');
	const STORAGE_KEY = 'soporteflow-incidents';
	let selectedStatus = $state<'all' | IncidentStatus>('all');

	const statusFilters = [
		{ value: 'all', label: 'Todas' },
		{ value: 'open', label: 'Abiertas' },
		{ value: 'pending', label: 'Pendientes' },
		{ value: 'resolved', label: 'Resueltas' }
	] satisfies { value: 'all' | IncidentStatus; label: string }[];

	const filteredIncidents = $derived(
		selectedStatus === 'all'
			? incidentList
			: incidentList.filter((incident) => incident.status === selectedStatus)
	);

	onMount(() => {
		const storedIncidents = localStorage.getItem(STORAGE_KEY);

		if (storedIncidents) {
			try {
				incidentList = JSON.parse(storedIncidents);
			} catch {
				localStorage.removeItem(STORAGE_KEY);
			}
		}
	});

	function saveIncidents() {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(incidentList));
	}

	let isFormOpen = $state(false);

	const priorityLabels = {
		low: 'Baja',
		medium: 'Media',
		high: 'Alta'
	};

	const priorityClasses = {
		low: 'text-slate-400',
		medium: 'text-amber-400',
		high: 'text-rose-400'
	};

	function updateIncidentStatus(id: number, status: IncidentStatus) {
		incidentList = incidentList.map((incident) =>
			incident.id === id ? { ...incident, status } : incident
		);
	}

	function createIncident(event: SubmitEvent) {
		event.preventDefault();

		const nextId =
			incidentList.length > 0 ? Math.max(...incidentList.map((incident) => incident.id)) + 1 : 1;

		incidentList.unshift({
			id: nextId,
			title,
			client,
			status: 'open',
			priority,
			createdAt: new Date().toISOString().slice(0, 10)
		});
		saveIncidents();

		title = '';
		client = '';
		priority = 'medium';
		isFormOpen = false;
	}
</script>

<svelte:head>
	<title>Panel | SoporteFlow</title>
	<meta name="description" content="Gestor de incidencias de soporte técnico" />
</svelte:head>

<div class="min-h-screen bg-slate-950 text-white">
	<header class="border-b border-slate-800 bg-slate-900">
		<div class="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
			<div>
				<p class="text-xl font-bold">Soporte<span class="text-cyan-400">Flow</span></p>
				<p class="text-xs text-slate-400">Gestión de soporte técnico</p>
			</div>

			<button
				type="button"
				onclick={() => (isFormOpen = true)}
				class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
			>
				Nueva incidencia
			</button>
		</div>
	</header>

	<main class="mx-auto max-w-7xl px-6 py-10">
		<section>
			<p class="text-sm font-medium text-cyan-400">Panel principal</p>
			<h1 class="mt-1 text-3xl font-bold">Resumen de incidencias</h1>
			<p class="mt-2 text-slate-400">Consulta rápidamente el estado del soporte técnico.</p>
		</section>

		<section class="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each summary as item (item.label)}
				<article class="rounded-xl border border-slate-800 bg-slate-900 p-6">
					<p class="text-sm text-slate-400">{item.label}</p>
					<p class={`mt-2 text-4xl font-bold ${item.color}`}>{item.value}</p>
				</article>
			{/each}
		</section>

		<section class="mt-8 rounded-xl border border-slate-800 bg-slate-900">
			<div class="border-b border-slate-800 px-6 py-5">
				<h2 class="text-lg font-semibold">Incidencias recientes</h2>

				<p class="text-sm text-slate-400">Aquí aparecerán los últimos casos registrados.</p>

				<div class="mt-4 flex flex-wrap gap-2">
					{#each statusFilters as filter (filter.value)}
						<button
							type="button"
							onclick={() => (selectedStatus = filter.value)}
							aria-pressed={selectedStatus === filter.value}
							class={`rounded-lg px-3 py-2 text-sm font-medium transition ${
								selectedStatus === filter.value
									? 'bg-cyan-500 text-slate-950'
									: 'bg-slate-800 text-slate-400 hover:text-white'
							}`}
						>
							{filter.label}
						</button>
					{/each}
				</div>
			</div>

			<div class="overflow-x-auto">
				<table class="w-full text-left">
					<thead class="text-xs text-slate-500 uppercase">
						<tr class="border-b border-slate-800">
							<th class="px-6 py-4 font-medium">Incidencia</th>
							<th class="px-6 py-4 font-medium">Cliente</th>
							<th class="px-6 py-4 font-medium">Prioridad</th>
							<th class="px-6 py-4 font-medium">Estado</th>
							<th class="px-6 py-4 font-medium">Fecha</th>
						</tr>
					</thead>

					<tbody>
						{#each filteredIncidents as incident (incident.id)}
							<tr class="border-b border-slate-800/70 last:border-0 hover:bg-slate-800/30">
								<td class="px-6 py-4">
									<p class="font-medium text-slate-200">{incident.title}</p>
									<p class="mt-1 text-xs text-slate-500">#{incident.id}</p>
								</td>

								<td class="px-6 py-4 text-sm text-slate-400">
									{incident.client}
								</td>

								<td class={`px-6 py-4 text-sm font-medium ${priorityClasses[incident.priority]}`}>
									{priorityLabels[incident.priority]}
								</td>
								<td class="px-6 py-4">
									<select
										value={incident.status}
										onchange={(event) =>
											updateIncidentStatus(
												incident.id,
												(event.currentTarget as HTMLSelectElement).value as IncidentStatus
											)}
										class="rounded-full border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
										aria-label={`Cambiar estado de ${incident.title}`}
									>
										<option value="open">Abierta</option>
										<option value="pending">Pendiente</option>
										<option value="resolved">Resuelta</option>
									</select>
								</td>

								<td class="px-6 py-4 text-sm text-slate-500">
									{new Date(incident.createdAt).toLocaleDateString('es-ES')}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	</main>
	{#if isFormOpen}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4">
			<section
				role="dialog"
				aria-modal="true"
				aria-labelledby="new-incident-title"
				class="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
			>
				<div class="flex items-start justify-between">
					<div>
						<p class="text-sm font-medium text-cyan-400">Soporte técnico</p>
						<h2 id="new-incident-title" class="mt-1 text-2xl font-bold">Nueva incidencia</h2>
					</div>

					<button
						type="button"
						onclick={() => (isFormOpen = false)}
						aria-label="Cerrar formulario"
						class="rounded-lg px-3 py-2 text-slate-400 hover:bg-slate-800 hover:text-white"
					>
						✕
					</button>
				</div>

				<form class="mt-6 space-y-5" onsubmit={createIncident}>
					<div>
						<label for="title" class="mb-2 block text-sm font-medium text-slate-300">
							Título
						</label>
						<input
							id="title"
							bind:value={title}
							required
							placeholder="Ej.: El portátil no se conecta a la red"
							class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-600 focus:border-cyan-400"
						/>
					</div>

					<div>
						<label for="client" class="mb-2 block text-sm font-medium text-slate-300">
							Cliente
						</label>
						<input
							id="client"
							bind:value={client}
							required
							placeholder="Nombre del cliente"
							class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-600 focus:border-cyan-400"
						/>
					</div>

					<div>
						<label for="priority" class="mb-2 block text-sm font-medium text-slate-300">
							Prioridad
						</label>
						<select
							id="priority"
							bind:value={priority}
							class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400"
						>
							<option value="low">Baja</option>
							<option value="medium">Media</option>
							<option value="high">Alta</option>
						</select>
					</div>

					<div class="flex justify-end gap-3 pt-2">
						<button
							type="button"
							onclick={() => (isFormOpen = false)}
							class="rounded-lg px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800"
						>
							Cancelar
						</button>

						<button
							type="submit"
							class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400"
						>
							Crear incidencia
						</button>
					</div>
				</form>
			</section>
		</div>
	{/if}
</div>

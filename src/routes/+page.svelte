<script lang="ts">
	import { incidents } from '$lib/data/incidents';

	const summary = [
		{
			label: 'Incidencias abiertas',
			value: incidents.filter((incident) => incident.status === 'open').length,
			color: 'text-cyan-400'
		},
		{
			label: 'Pendientes',
			value: incidents.filter((incident) => incident.status === 'pending').length,
			color: 'text-amber-400'
		},
		{
			label: 'Resueltas',
			value: incidents.filter((incident) => incident.status === 'resolved').length,
			color: 'text-emerald-400'
		}
	];

	const statusLabels = {
		open: 'Abierta',
		pending: 'Pendiente',
		resolved: 'Resuelta'
	};

	const statusClasses = {
		open: 'bg-cyan-400/10 text-cyan-400',
		pending: 'bg-amber-400/10 text-amber-400',
		resolved: 'bg-emerald-400/10 text-emerald-400'
	};

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
						{#each incidents as incident (incident.id)}
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
									<span
										class={`rounded-full px-3 py-1 text-xs font-semibold ${statusClasses[incident.status]}`}
									>
										{statusLabels[incident.status]}
									</span>
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
</div>

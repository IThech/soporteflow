<script lang="ts">
	const summary = [
		{ label: 'Incidencias abiertas', value: 8, color: 'text-cyan-400' },
		{ label: 'Pendientes', value: 5, color: 'text-amber-400' },
		{ label: 'Resueltas', value: 24, color: 'text-emerald-400' }
	];
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

			<div class="px-6 py-12 text-center text-slate-500">
				Todavía no hay incidencias disponibles.
			</div>
		</section>
	</main>
</div>

<script lang="ts">
	import type { SettingsSectionDefinition } from '$lib/settings/sections';

	let {
		section
	}: {
		section: SettingsSectionDefinition;
	} = $props();
</script>

<section
	aria-labelledby="placeholder-title"
	class="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center sm:p-12"
>
	<div
		class="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-700 bg-slate-800/80 text-cyan-400 shadow-inner"
	>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			class="h-7 w-7"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			stroke-width="1.75"
			aria-hidden="true"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
			/>
		</svg>
	</div>

	<div class="mt-4 flex items-center justify-center gap-2">
		<h2 id="placeholder-title" class="text-xl font-bold text-white">
			{section.label}
		</h2>
		<span
			class="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-xs font-semibold tracking-wide text-amber-400 uppercase"
		>
			Próxima fase
		</span>
	</div>

	<p class="mx-auto mt-2 max-w-md text-sm text-slate-400">
		{section.description}
	</p>

	<div
		class="mx-auto mt-6 max-w-lg rounded-xl border border-slate-800 bg-slate-950/60 p-5 text-left"
	>
		<h3 class="text-xs font-bold tracking-wider text-slate-300 uppercase">Alcance planificado</h3>
		<ul class="mt-3 space-y-2 text-xs text-slate-400">
			{#if section.id === 'users'}
				<li class="flex items-start gap-2">
					<span class="mt-0.5 text-cyan-400">▪</span>
					<span>Alta, edición y desactivación de agentes de soporte y administradores.</span>
				</li>
				<li class="flex items-start gap-2">
					<span class="mt-0.5 text-cyan-400">▪</span>
					<span>Asignación de roles, permisos y pertenencia a organizaciones de clientes.</span>
				</li>
			{:else if section.id === 'locations'}
				<li class="flex items-start gap-2">
					<span class="mt-0.5 text-cyan-400">▪</span>
					<span>Catálogo de oficinas físicas, delegaciones y áreas territoriales.</span>
				</li>
				<li class="flex items-start gap-2">
					<span class="mt-0.5 text-cyan-400">▪</span>
					<span>Asociación de incidencias y técnicos a sedes geográficas específicas.</span>
				</li>
			{:else if section.id === 'support_levels'}
				<li class="flex items-start gap-2">
					<span class="mt-0.5 text-cyan-400">▪</span>
					<span
						>Configuración de tiers operativos N1 (Mesa de ayuda), N2 (Especialistas) y N3
						(Ingeniería).</span
					>
				</li>
				<li class="flex items-start gap-2">
					<span class="mt-0.5 text-cyan-400">▪</span>
					<span>Definición de criterios y flujos automatizados de escalado entre niveles.</span>
				</li>
			{:else if section.id === 'teams'}
				<li class="flex items-start gap-2">
					<span class="mt-0.5 text-cyan-400">▪</span>
					<span>Gestión de grupos funcionales de trabajo (Sistemas, Redes, Software, etc.).</span>
				</li>
				<li class="flex items-start gap-2">
					<span class="mt-0.5 text-cyan-400">▪</span>
					<span>Distribución y balanceo de carga de tickets por equipo.</span>
				</li>
			{/if}
		</ul>
	</div>
</section>

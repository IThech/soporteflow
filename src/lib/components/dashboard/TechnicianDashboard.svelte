<script lang="ts">
	import type { Incident, IncidentPriority } from '$lib/types/incident';
	import type { AppUser } from '$lib/types/user';
	import type { SupportLevelDefinition, SupportTeam } from '$lib/types/support';
	import type { IncidentCategory } from '$lib/types/category';
	import type { Site } from '$lib/types/site';
	import type { IncidentHistoryEntry } from '$lib/types/incident-history';
	import type { IncidentMessage } from '$lib/types/incident-message';
	import type { AttentionReasonType } from '$lib/types/technician-dashboard';
	import SlaBadge from '$lib/components/SlaBadge.svelte';
	import {
		computeTechnicianDashboardSummary,
		getAttentionIncidents,
		getAvailableToAssumeIncidents,
		computeTechnicianActivityMetrics
	} from '$lib/incidents/technician-dashboard';

	let {
		technician,
		incidents,
		history,
		messages = [],
		users,
		levels,
		teams,
		sites = [],
		categories,
		now = new Date(),
		onopenincident,
		onassumeincident,
		onviewallmine
	}: {
		technician: AppUser;
		incidents: Incident[];
		history: IncidentHistoryEntry[];
		messages: IncidentMessage[];
		users: AppUser[];
		levels: SupportLevelDefinition[];
		teams: SupportTeam[];
		sites?: Site[];
		categories: IncidentCategory[];
		now?: Date;
		onopenincident: (incidentId: number) => void;
		onassumeincident: (incident: Incident) => void;
		onviewallmine: () => void;
	} = $props();

	const summary = $derived(
		computeTechnicianDashboardSummary(incidents, technician, history, messages, users, levels, now)
	);

	const attentionItems = $derived(
		getAttentionIncidents(incidents, technician, history, messages, users, levels, now)
	);

	const availableToAssume = $derived(getAvailableToAssumeIncidents(incidents, technician, levels));

	const myActiveIncidents = $derived(
		incidents
			.filter(
				(i) =>
					i.assignedToUserId === technician.id && (i.status === 'open' || i.status === 'pending')
			)
			.sort((a, b) => {
				// Priority: urgent first, then high, then oldest createdAt
				const priorityOrder: Record<IncidentPriority, number> = {
					urgent: 0,
					high: 1,
					medium: 2,
					low: 3
				};
				const pDiff = (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2);
				if (pDiff !== 0) return pDiff;
				return Date.parse(a.createdAt) - Date.parse(b.createdAt);
			})
	);

	const activityMetrics = $derived(
		computeTechnicianActivityMetrics(incidents, technician, history, categories, levels, now, 30)
	);

	function categoryName(categoryId?: string): string {
		if (!categoryId) return 'Sin categoría';
		return categories.find((c) => c.id === categoryId)?.name ?? 'Categoría general';
	}

	function teamName(teamId?: string): string {
		if (!teamId) return 'Sin equipo';
		return teams.find((t) => t.id === teamId)?.name ?? 'Equipo';
	}

	function siteName(siteId?: string): string {
		if (!siteId) return 'Sin sede';
		return sites.find((s) => s.id === siteId)?.name ?? 'Sede';
	}

	const priorityLabels: Record<IncidentPriority, string> = {
		urgent: 'Urgente',
		high: 'Alta',
		medium: 'Media',
		low: 'Baja'
	};

	const priorityBadgeClasses: Record<IncidentPriority, string> = {
		urgent: 'border-purple-500/40 bg-purple-500/15 text-purple-300',
		high: 'border-red-500/40 bg-red-500/15 text-red-300',
		medium: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
		low: 'border-slate-700 bg-slate-800 text-slate-400'
	};

	function getReasonBadgeConfig(type: AttentionReasonType): { label: string; cls: string } {
		switch (type) {
			case 'sla_breached':
				return { label: 'SLA incumplido', cls: 'badge-attention-breached' };
			case 'sla_approaching':
				return { label: 'SLA próximo', cls: 'badge-attention-approaching' };
			case 'reopened':
				return { label: 'Reabierta', cls: 'badge-attention-reopened' };
			case 'client_responded':
				return { label: 'Cliente respondió', cls: 'badge-attention-client' };
			case 'incompatible_level':
				return { label: 'Nivel incompatible', cls: 'badge-attention-incompatible' };
			case 'high_priority':
				return { label: 'Prioridad alta', cls: 'badge-attention-high' };
		}
	}
</script>

<div class="technician-dashboard space-y-8" data-testid="technician-dashboard">
	<!-- Top Bar Greeting & Context -->
	<header class="dashboard-greeting flex flex-wrap items-center justify-between gap-4">
		<div>
			<div class="flex items-center gap-2">
				<span class="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400"></span>
				<p class="text-xs font-semibold tracking-wider text-cyan-400 uppercase">Panel operativo</p>
			</div>
			<h1 class="mt-1 text-2xl font-bold tracking-tight text-white sm:text-3xl">
				Hola, {technician.name}
			</h1>
			<p class="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400 sm:text-sm">
				<span
					>Nivel <strong
						>{technician.supportLevel && technician.supportLevel !== 'none'
							? technician.supportLevel
							: 'Sin nivel'}</strong
					></span
				>
				<span class="text-slate-600">·</span>
				<span>{teamName(technician.teamId)}</span>
				{#if technician.siteIds && technician.siteIds.length > 0}
					<span class="text-slate-600">·</span>
					<span>{technician.siteIds.map((sId) => siteName(sId)).join(', ')}</span>
				{/if}
			</p>
		</div>

		<div class="flex items-center gap-2">
			<button
				type="button"
				onclick={onviewallmine}
				class="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-xs font-semibold text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-700 hover:text-white"
			>
				<svg class="h-4 w-4 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M4 6h16M4 10h16M4 14h16M4 18h16"
					/>
				</svg>
				<span>Ver cola completa</span>
			</button>
		</div>
	</header>

	<!-- KPI Summary Cards -->
	<section
		class="grid grid-cols-2 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4"
		aria-label="Resumen operativo del técnico"
	>
		<!-- 1. Mis incidencias activas -->
		<article
			class="kpi-card flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900 p-4 transition-colors hover:border-slate-700 sm:p-5"
		>
			<div class="flex items-center justify-between gap-2">
				<p class="text-xs font-medium text-slate-400 sm:text-sm">Mis incidencias activas</p>
				<span class="h-2.5 w-2.5 shrink-0 rounded-full bg-cyan-400"></span>
			</div>
			<div class="mt-3 flex items-baseline gap-2">
				<span class="text-3xl font-extrabold text-cyan-400 sm:text-4xl" data-testid="kpi-my-active">
					{summary.myActiveCount}
				</span>
				<span class="text-xs text-slate-500">en curso</span>
			</div>
		</article>

		<!-- 2. Requieren atención -->
		<article
			class={`kpi-card flex flex-col justify-between rounded-xl border p-4 transition-colors sm:p-5 ${
				summary.attentionCount > 0
					? 'border-rose-500/40 bg-rose-950/10'
					: 'border-slate-800 bg-slate-900'
			}`}
		>
			<div class="flex items-center justify-between gap-2">
				<p class="text-xs font-medium text-slate-400 sm:text-sm">Requieren atención</p>
				<span
					class={`h-2.5 w-2.5 shrink-0 rounded-full ${
						summary.attentionCount > 0 ? 'animate-pulse bg-rose-500' : 'bg-slate-600'
					}`}
				></span>
			</div>
			<div class="mt-3 flex items-baseline gap-2">
				<span
					class={`text-3xl font-extrabold sm:text-4xl ${
						summary.attentionCount > 0 ? 'text-rose-400' : 'text-slate-300'
					}`}
					data-testid="kpi-attention"
				>
					{summary.attentionCount}
				</span>
				<span class="text-xs text-slate-500">urgentes</span>
			</div>
		</article>

		<!-- 3. SLA próximo (<15 min) -->
		<article
			class={`kpi-card flex flex-col justify-between rounded-xl border p-4 transition-colors sm:p-5 ${
				summary.slaApproachingCount > 0
					? 'border-amber-500/40 bg-amber-950/10'
					: 'border-slate-800 bg-slate-900'
			}`}
		>
			<div class="flex items-center justify-between gap-2">
				<p class="text-xs font-medium text-slate-400 sm:text-sm">SLA por vencer</p>
				<span
					class={`h-2.5 w-2.5 shrink-0 rounded-full ${
						summary.slaApproachingCount > 0 ? 'animate-pulse bg-amber-400' : 'bg-slate-600'
					}`}
				></span>
			</div>
			<div class="mt-3 flex items-baseline gap-2">
				<span
					class={`text-3xl font-extrabold sm:text-4xl ${
						summary.slaApproachingCount > 0 ? 'text-amber-400' : 'text-slate-300'
					}`}
					data-testid="kpi-sla-approaching"
				>
					{summary.slaApproachingCount}
				</span>
				<span class="text-xs text-slate-500">&le; 15 min</span>
			</div>
		</article>

		<!-- 4. Disponibles para asumir -->
		<article
			class="kpi-card flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900 p-4 transition-colors hover:border-slate-700 sm:p-5"
		>
			<div class="flex items-center justify-between gap-2">
				<p class="text-xs font-medium text-slate-400 sm:text-sm">Disponibles para asumir</p>
				<span class="h-2.5 w-2.5 shrink-0 rounded-full bg-teal-400"></span>
			</div>
			<div class="mt-3 flex items-baseline gap-2">
				<span class="text-3xl font-extrabold text-teal-400 sm:text-4xl" data-testid="kpi-available">
					{summary.availableToAssumeCount}
				</span>
				<span class="text-xs text-slate-500">sin asignar</span>
			</div>
		</article>
	</section>

	<!-- Main Workspace Grid: 2 Columns on Desktop, 1 on Mobile -->
	<div class="grid grid-cols-1 gap-8 lg:grid-cols-12">
		<!-- Left Main Column (8 cols): Requieren atención + Mis incidencias -->
		<div class="space-y-8 lg:col-span-7 xl:col-span-8">
			<!-- Section 1: Requieren tu atención -->
			<section
				class="dashboard-section overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xs"
				aria-labelledby="attention-heading"
			>
				<div class="border-b border-slate-800/80 bg-slate-950/40 px-5 py-4 sm:px-6">
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-2.5">
							<span
								class="flex h-6 w-6 items-center justify-center rounded-lg bg-rose-500/15 text-rose-400"
							>
								<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2.5"
										d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
									/>
								</svg>
							</span>
							<h2 id="attention-heading" class="text-base font-semibold text-white sm:text-lg">
								Requieren tu atención
							</h2>
						</div>
						<span
							class={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
								attentionItems.length > 0
									? 'bg-rose-500/20 text-rose-300'
									: 'bg-slate-800 text-slate-400'
							}`}
							data-testid="attention-counter"
						>
							{attentionItems.length}
						</span>
					</div>
					<p class="mt-1 text-xs text-slate-400">
						Casos asignados a ti con alertas críticas, respuestas de clientes o compromisos de SLA.
					</p>
				</div>

				<div class="p-5 sm:p-6">
					{#if attentionItems.length === 0}
						<div
							class="flex flex-col items-center justify-center py-8 text-center text-slate-400"
							data-testid="attention-empty-state"
						>
							<div
								class="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400"
							>
								<svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M5 13l4 4L19 7"
									/>
								</svg>
							</div>
							<p class="mt-3 text-sm font-medium text-slate-200">
								No tienes incidencias que requieran atención inmediata
							</p>
							<p class="mt-1 text-xs text-slate-500">
								¡Todo al día! No hay SLAs vencidos, respuestas pendientes ni alertas activas en tus
								casos.
							</p>
						</div>
					{:else}
						<div class="space-y-3" data-testid="attention-items-list">
							{#each attentionItems as item (item.incident.id)}
								<article
									class="attention-card group relative rounded-xl border border-slate-800/90 bg-slate-950/40 p-4 transition-all hover:border-slate-700 hover:bg-slate-950/80 sm:p-4.5"
									data-testid={`attention-item-${item.incident.id}`}
								>
									<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
										<div class="min-w-0 flex-1 space-y-2">
											<div class="flex flex-wrap items-center gap-2">
												<span class="text-xs font-bold text-slate-400">#{item.incident.id}</span>
												<button
													type="button"
													onclick={() => onopenincident(item.incident.id)}
													class="cursor-pointer text-left text-sm font-semibold text-white transition-colors group-hover:underline hover:text-cyan-400"
												>
													{item.incident.title}
												</button>
											</div>

											<div
												class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400"
											>
												<span class="font-medium text-slate-300"
													>Cliente: {item.incident.client}</span
												>
												<span>·</span>
												<span>{categoryName(item.incident.categoryId)}</span>
												<span>·</span>
												<span class="text-slate-500">
													{new Date(item.incident.createdAt).toLocaleDateString('es-ES')}
												</span>
											</div>

											<!-- Attention Reason Badges (Unicity: all reasons rendered) -->
											<div
												class="flex flex-wrap items-center gap-1.5 pt-1"
												data-testid="attention-reasons"
											>
												{#each item.reasons as reason (reason.type)}
													{@const badgeConfig = getReasonBadgeConfig(reason.type)}
													<span
														class={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ${badgeConfig.cls}`}
														data-testid={`badge-reason-${reason.type}`}
													>
														{#if reason.type === 'sla_breached' || reason.type === 'sla_approaching'}
															<span class="h-1.5 w-1.5 rounded-full bg-current"></span>
														{/if}
														<span>{reason.label || badgeConfig.label}</span>
														{#if reason.timeAgo}
															<span class="font-normal opacity-80">· {reason.timeAgo}</span>
														{/if}
													</span>
												{/each}

												<!-- Priority Badge -->
												<span
													class={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${
														priorityBadgeClasses[item.incident.priority]
													}`}
												>
													{priorityLabels[item.incident.priority]}
												</span>

												<!-- SLA Live Badge -->
												<SlaBadge incident={item.incident} {now} />
											</div>
										</div>

										<div class="flex shrink-0 items-center justify-end pt-1 sm:pt-0">
											<button
												type="button"
												onclick={() => onopenincident(item.incident.id)}
												class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-cyan-500/30 bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold text-cyan-300 transition-colors hover:bg-cyan-500 hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-cyan-400"
												aria-label={`Atender incidencia #${item.incident.id}: ${item.incident.title}`}
											>
												<span>Atender</span>
												<svg
													class="h-3.5 w-3.5"
													fill="none"
													viewBox="0 0 24 24"
													stroke="currentColor"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M9 5l7 7-7 7"
													/>
												</svg>
											</button>
										</div>
									</div>
								</article>
							{/each}
						</div>
					{/if}
				</div>
			</section>

			<!-- Section 2: Mis incidencias activas -->
			<section
				class="dashboard-section overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xs"
				aria-labelledby="my-incidents-heading"
			>
				<div class="border-b border-slate-800/80 bg-slate-950/40 px-5 py-4 sm:px-6">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div class="flex items-center gap-2.5">
							<span
								class="flex h-6 w-6 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-400"
							>
								<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
									/>
								</svg>
							</span>
							<h2 id="my-incidents-heading" class="text-base font-semibold text-white sm:text-lg">
								Mis incidencias en curso
							</h2>
							<span
								class="rounded-full bg-slate-800 px-2.5 py-0.5 text-xs font-semibold text-slate-300"
							>
								{myActiveIncidents.length}
							</span>
						</div>

						<button
							type="button"
							onclick={onviewallmine}
							class="cursor-pointer text-xs font-semibold text-cyan-400 hover:text-cyan-300 hover:underline"
						>
							Ver todas en la cola &rarr;
						</button>
					</div>
				</div>

				<div class="p-5 sm:p-6">
					{#if myActiveIncidents.length === 0}
						<div class="py-6 text-center text-sm text-slate-400" data-testid="my-incidents-empty">
							No tienes incidencias activas asignadas en este momento.
						</div>
					{:else}
						<div class="divide-y divide-slate-800/60" data-testid="my-incidents-list">
							{#each myActiveIncidents as incident (incident.id)}
								<div
									class="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
								>
									<div class="min-w-0 flex-1">
										<div class="flex items-center gap-2">
											<span class="text-xs font-bold text-slate-500">#{incident.id}</span>
											<button
												type="button"
												onclick={() => onopenincident(incident.id)}
												class="cursor-pointer truncate text-left text-sm font-medium text-slate-200 hover:text-cyan-300 hover:underline"
											>
												{incident.title}
											</button>
										</div>
										<p class="mt-0.5 text-xs text-slate-400">
											{incident.client} · {categoryName(incident.categoryId)} · Nivel {incident.supportLevel ??
												'—'}
										</p>
									</div>

									<div class="flex flex-wrap items-center gap-2">
										<span
											class={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${
												priorityBadgeClasses[incident.priority]
											}`}
										>
											{priorityLabels[incident.priority]}
										</span>
										<SlaBadge {incident} {now} />
										<button
											type="button"
											onclick={() => onopenincident(incident.id)}
											class="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-700 hover:text-white"
										>
											Abrir
										</button>
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			</section>
		</div>

		<!-- Right Column (5 cols): Disponibles para asumir + Mi actividad a 30 días -->
		<div class="space-y-8 lg:col-span-5 xl:col-span-4">
			<!-- Section 3: Disponibles para asumir -->
			<section
				class="dashboard-section overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xs"
				aria-labelledby="available-heading"
			>
				<div class="border-b border-slate-800/80 bg-slate-950/40 px-5 py-4 sm:px-6">
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-2.5">
							<span
								class="flex h-6 w-6 items-center justify-center rounded-lg bg-teal-500/15 text-teal-400"
							>
								<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
									/>
								</svg>
							</span>
							<h2 id="available-heading" class="text-base font-semibold text-white sm:text-lg">
								Disponibles para asumir
							</h2>
						</div>
						<span
							class="rounded-full bg-slate-800 px-2.5 py-0.5 text-xs font-semibold text-slate-300"
							data-testid="available-counter"
						>
							{availableToAssume.length}
						</span>
					</div>
					<p class="mt-1 text-xs text-slate-400">
						Casos sin asignar de tu organización compatibles con tu nivel ({technician.supportLevel ??
							'N1'}).
					</p>
				</div>

				<div class="p-5 sm:p-6">
					{#if availableToAssume.length === 0}
						<div
							class="py-6 text-center text-sm text-slate-400"
							data-testid="available-empty-state"
						>
							No hay incidencias sin asignar disponibles que coincidan con tu capacidad técnica.
						</div>
					{:else}
						<div class="space-y-3" data-testid="available-items-list">
							{#each availableToAssume as incident (incident.id)}
								{@const isMyTeam =
									incident.teamId && technician.teamId && incident.teamId === technician.teamId}
								<article
									class="rounded-xl border border-slate-800/80 bg-slate-950/30 p-3.5 transition-colors hover:border-slate-700"
									data-testid={`available-item-${incident.id}`}
								>
									<div class="flex items-start justify-between gap-3">
										<div class="min-w-0 flex-1 space-y-1.5">
											<div class="flex flex-wrap items-center gap-1.5">
												<span class="text-xs font-bold text-slate-500">#{incident.id}</span>
												<button
													type="button"
													onclick={() => onopenincident(incident.id)}
													class="cursor-pointer truncate text-left text-sm font-medium text-white hover:text-cyan-300 hover:underline"
												>
													{incident.title}
												</button>
											</div>

											<div
												class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400"
											>
												<span>{incident.client}</span>
												<span>·</span>
												<span>{categoryName(incident.categoryId)}</span>
											</div>

											<div class="flex flex-wrap items-center gap-1.5 pt-0.5">
												{#if isMyTeam}
													<span
														class="inline-flex items-center rounded-md border border-cyan-500/30 bg-cyan-500/15 px-2 py-0.5 text-[11px] font-semibold text-cyan-300"
													>
														Tu equipo
													</span>
												{/if}
												<span
													class="inline-flex items-center rounded-md border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-300"
												>
													Req: {incident.supportLevel ?? 'Sin nivel'}
												</span>
												<span
													class={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
														priorityBadgeClasses[incident.priority]
													}`}
												>
													{priorityLabels[incident.priority]}
												</span>
											</div>
										</div>

										<button
											type="button"
											onclick={() => onassumeincident(incident)}
											class="shrink-0 cursor-pointer rounded-lg bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-teal-400 focus-visible:outline-2 focus-visible:outline-teal-400"
											aria-label={`Asumir incidencia #${incident.id}: ${incident.title}`}
											data-testid={`btn-assume-${incident.id}`}
										>
											Asumir
										</button>
									</div>
								</article>
							{/each}
						</div>
					{/if}
				</div>
			</section>

			<!-- Section 4: Mi actividad (Últimos 30 días) -->
			<section
				class="dashboard-section overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xs"
				aria-labelledby="activity-heading"
			>
				<div class="border-b border-slate-800/80 bg-slate-950/40 px-5 py-4 sm:px-6">
					<div class="flex items-center gap-2.5">
						<span
							class="flex h-6 w-6 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-400"
						>
							<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
								/>
							</svg>
						</span>
						<h2 id="activity-heading" class="text-base font-semibold text-white sm:text-lg">
							Mi actividad · 30 días
						</h2>
					</div>
					<p class="mt-1 text-xs text-slate-400">
						Rendimiento operativo atribuido a tus resoluciones en la ventana de 30 días.
					</p>
				</div>

				<div class="space-y-6 p-5 sm:p-6" data-testid="technician-activity-metrics">
					<!-- 3 Stat Metrics -->
					<div class="grid grid-cols-3 gap-2 text-center">
						<div class="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
							<p class="text-[11px] font-medium text-slate-400">Resueltas</p>
							<p
								class="mt-1 text-xl font-bold text-white sm:text-2xl"
								data-testid="metric-resolved-count"
							>
								{activityMetrics.resolvedCount}
							</p>
						</div>

						<div class="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
							<p class="text-[11px] font-medium text-slate-400">% en SLA</p>
							<p
								class="mt-1 text-xl font-bold text-emerald-400 sm:text-2xl"
								data-testid="metric-sla-percentage"
							>
								{activityMetrics.withinSlaPercentage}%
							</p>
							<p class="text-[10px] text-slate-500">
								{activityMetrics.withinSlaCount}/{activityMetrics.resolvedCount}
							</p>
						</div>

						<div class="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
							<p class="text-[11px] font-medium text-slate-400">Reabiertas</p>
							<p
								class="mt-1 text-xl font-bold text-amber-400 sm:text-2xl"
								data-testid="metric-reopened-count"
							>
								{activityMetrics.reopenedCount}
							</p>
							<p class="text-[10px] text-slate-500">
								{activityMetrics.reopenedPercentage}%
							</p>
						</div>
					</div>

					<!-- Breakdown by Category -->
					<div class="space-y-2.5">
						<h3 class="text-xs font-bold tracking-wider text-slate-400 uppercase">
							Resoluciones por categoría
						</h3>
						{#if activityMetrics.categories.length === 0}
							<p class="text-xs text-slate-500 italic">Sin resoluciones en los últimos 30 días</p>
						{:else}
							<div class="space-y-2" data-testid="metrics-categories">
								{#each activityMetrics.categories as cat (cat.categoryId)}
									<div class="space-y-1">
										<div class="flex items-center justify-between text-xs">
											<span class="truncate font-medium text-slate-300">{cat.categoryName}</span>
											<span class="font-semibold text-slate-400">
												{cat.count}
												<span class="font-normal text-slate-500">({cat.percentage}%)</span>
											</span>
										</div>
										<div class="h-2 w-full overflow-hidden rounded-full bg-slate-800">
											<div
												class="h-full rounded-full bg-cyan-500 transition-all duration-300"
												style={`width: ${cat.percentage}%`}
											></div>
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>

					<!-- Breakdown by Level -->
					<div class="space-y-2.5">
						<h3 class="text-xs font-bold tracking-wider text-slate-400 uppercase">
							Resoluciones por nivel
						</h3>
						{#if activityMetrics.levels.length === 0}
							<p class="text-xs text-slate-500 italic">Sin resoluciones en los últimos 30 días</p>
						{:else}
							<div class="space-y-2" data-testid="metrics-levels">
								{#each activityMetrics.levels as lvl (lvl.levelCode)}
									<div class="space-y-1">
										<div class="flex items-center justify-between text-xs">
											<span class="font-medium text-slate-300">
												{#if lvl.levelCode === 'none' || !lvl.levelCode}
													Sin nivel
												{:else}
													{lvl.levelName}
												{/if}
											</span>
											<span class="font-semibold text-slate-400">
												{lvl.count}
												<span class="font-normal text-slate-500">({lvl.percentage}%)</span>
											</span>
										</div>
										<div class="h-2 w-full overflow-hidden rounded-full bg-slate-800">
											<div
												class="h-full rounded-full bg-indigo-500 transition-all duration-300"
												style={`width: ${lvl.percentage}%`}
											></div>
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			</section>
		</div>
	</div>
</div>

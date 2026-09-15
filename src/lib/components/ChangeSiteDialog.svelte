<script lang="ts">
	import type { Incident } from '$lib/types/incident';
	import type { Site } from '$lib/types/site';
	import { incidentOrganizationId } from '$lib/incidents/assignment';

	let {
		incident,
		sites = [],
		error = '',
		onconfirm,
		oncancel
	}: {
		incident: Incident;
		sites?: Site[];
		error?: string;
		onconfirm: (input: { targetSiteId: string | null; reason?: string; comment?: string }) => void;
		oncancel: () => void;
	} = $props();

	let targetSiteId = $state('');
	let reason = $state('');
	let comment = $state('');

	const orgId = $derived(incidentOrganizationId(incident));
	const availableSites = $derived(
		sites.filter((s) => s.active && (!s.organizationId || s.organizationId === orgId))
	);

	const currentSiteDef = $derived(sites.find((s) => s.id === incident.siteId));
	const hasInactiveCurrentSite = $derived(
		!!incident.siteId && !availableSites.some((s) => s.id === incident.siteId)
	);

	const changed = $derived((targetSiteId || null) !== (incident.siteId ?? null));

	function show(dialog: HTMLDialogElement) {
		targetSiteId = incident.siteId ?? '';
		reason = '';
		comment = '';
		dialog.showModal();
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!changed) return;
		onconfirm({
			targetSiteId: targetSiteId ? targetSiteId : null,
			...(reason.trim() ? { reason: reason.trim() } : {}),
			...(comment.trim() ? { comment: comment.trim() } : {})
		});
	}
</script>

<dialog
	{@attach show}
	class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
	aria-labelledby="site-dialog-title"
>
	<form onsubmit={submit} class="space-y-4">
		<div class="flex items-center justify-between border-b border-slate-800 pb-3">
			<div>
				<h2 id="site-dialog-title" class="text-base font-semibold text-white">
					Cambiar sede de la incidencia
				</h2>
				<p class="text-xs text-slate-400">
					#{incident.id} · {incident.title}
				</p>
			</div>
			<button
				type="button"
				onclick={oncancel}
				class="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
				aria-label="Cerrar ventana"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="h-5 w-5"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M6 18L18 6M6 6l12 12"
					/>
				</svg>
			</button>
		</div>

		{#if error}
			<p
				role="alert"
				class="rounded-xl border border-red-500/30 bg-red-950/40 p-3 text-xs text-red-300"
			>
				{error}
			</p>
		{/if}

		<div class="rounded-xl border border-cyan-500/20 bg-cyan-950/20 p-3 text-xs text-cyan-300">
			La sede indica la ubicación física o delegación de la incidencia. Cambiarla no modifica el
			nivel de soporte, equipo, técnico asignado ni SLA.
		</div>

		<div>
			<label for="change-site-select" class="mb-1 block text-xs font-semibold text-slate-300">
				Sede / Ubicación
			</label>
			<select
				id="change-site-select"
				bind:value={targetSiteId}
				class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white transition outline-none focus:border-cyan-400"
			>
				<option value="">Sin sede asignada</option>
				{#if hasInactiveCurrentSite && currentSiteDef}
					<option value={incident.siteId}>
						Mantener: {currentSiteDef.name} (inactiva)
					</option>
				{/if}
				{#each availableSites as site (site.id)}
					<option value={site.id}>{site.name}</option>
				{/each}
			</select>
		</div>

		<div>
			<label for="change-site-reason" class="mb-1 block text-xs font-semibold text-slate-300">
				Motivo del cambio (opcional)
			</label>
			<input
				id="change-site-reason"
				type="text"
				bind:value={reason}
				placeholder="Ej. Traslado de oficina, error al registrar sede..."
				class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 transition outline-none focus:border-cyan-400"
			/>
		</div>

		<div>
			<label for="change-site-comment" class="mb-1 block text-xs font-semibold text-slate-300">
				Comentario adicional (opcional)
			</label>
			<textarea
				id="change-site-comment"
				bind:value={comment}
				rows="3"
				placeholder="Detalles sobre el cambio de ubicación..."
				class="w-full resize-y rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 transition outline-none focus:border-cyan-400"
			></textarea>
		</div>

		<div class="flex items-center justify-end gap-3 border-t border-slate-800 pt-4">
			<button
				type="button"
				onclick={oncancel}
				class="rounded-xl px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white"
			>
				Cancelar
			</button>
			<button
				type="submit"
				disabled={!changed}
				class="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
			>
				Actualizar sede
			</button>
		</div>
	</form>
</dialog>

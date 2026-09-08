<script lang="ts">
	import { hasPermission, canAccessOrganization } from '$lib/auth/permissions';
	import type { AppUser } from '$lib/types/user';
	import type { ReassignmentReason } from '$lib/types/reassignment-reason';
	import type { ReasonChange } from '$lib/reasons/catalog';
	let {
		actor,
		reasons,
		ready,
		error,
		onchange
	}: {
		actor: AppUser;
		reasons: ReassignmentReason[];
		ready: boolean;
		error: string;
		onchange: (change: ReasonChange) => boolean;
	} = $props();
	let draft = $state<{ id?: string; name: string; description: string } | null>(null);
	const allowed = $derived(hasPermission(actor, 'organization:manage'));
	const visible = $derived(
		reasons.filter((reason) => canAccessOrganization(actor, reason.organizationId))
	);
	function edit(reason?: ReassignmentReason) {
		if (!ready || !allowed || (reason && !canAccessOrganization(actor, reason.organizationId)))
			return;
		draft = {
			...(reason ? { id: reason.id } : {}),
			name: reason?.name ?? '',
			description: reason?.description ?? ''
		};
	}
	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (draft && onchange({ type: 'save', ...draft })) draft = null;
	}
</script>

{#if allowed}
	<section
		aria-labelledby="reasons-title"
		class="mt-8 rounded-xl border border-slate-800 bg-slate-900 p-6"
	>
		<h2 id="reasons-title" class="text-lg font-semibold">Motivos de reasignación</h2>
		<p class="mt-1 text-sm text-slate-400">
			Justificaciones compartidas por tu organización. Los cambios no alteran el historial.
		</p>
		{#if error}<p role="alert" class="mt-4 text-sm text-red-300">{error}</p>{/if}
		{#if ready}
			{#if actor.organizationId}<button
					type="button"
					onclick={() => edit()}
					class="mt-4 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950"
					>Nuevo motivo</button
				>{/if}
			{#if draft}<form
					onsubmit={submit}
					class="mt-4 space-y-4 rounded-lg border border-slate-700 p-4"
				>
					<h3 class="font-semibold">{draft.id ? 'Editar motivo' : 'Nuevo motivo'}</h3>
					<div>
						<label for="reason-name" class="mb-2 block text-sm">Nombre (obligatorio)</label><input
							id="reason-name"
							required
							bind:value={draft.name}
							class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3"
						/>
					</div>
					<div>
						<label for="reason-description" class="mb-2 block text-sm">Descripción (opcional)</label
						><textarea
							id="reason-description"
							bind:value={draft.description}
							rows="2"
							class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3"></textarea>
					</div>
					<div class="flex gap-3">
						<button
							type="submit"
							class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950"
							>Guardar motivo</button
						><button
							type="button"
							onclick={() => (draft = null)}
							class="rounded-lg px-4 py-2 text-sm hover:bg-slate-800">Cancelar</button
						>
					</div>
				</form>{/if}
			<ul class="mt-5 grid gap-3 sm:grid-cols-2">
				{#each visible as reason (reason.id)}<li
						class="rounded-lg border border-slate-700 bg-slate-950 p-4"
					>
						<div class="flex justify-between gap-3">
							<h3 class="font-medium">{reason.name}</h3>
							<span class={`text-xs ${reason.active ? 'text-emerald-300' : 'text-slate-400'}`}
								>{reason.active ? 'Activo' : 'Inactivo'}</span
							>
						</div>
						{#if reason.description}<p class="mt-2 text-sm text-slate-400">
								{reason.description}
							</p>{/if}
						<div class="mt-4 flex flex-wrap gap-3">
							<button
								type="button"
								onclick={() => edit(reason)}
								aria-label={`Editar motivo ${reason.name}`}
								class="rounded border border-slate-700 px-3 py-2 text-sm text-cyan-300"
								>Editar</button
							><button
								type="button"
								onclick={() => onchange({ type: 'toggle', id: reason.id })}
								aria-label={`${reason.active ? 'Desactivar' : 'Reactivar'} motivo ${reason.name}`}
								class="rounded border border-slate-700 px-3 py-2 text-sm text-slate-300"
								>{reason.active ? 'Desactivar' : 'Reactivar'}</button
							>
						</div>
					</li>{:else}<li class="text-sm text-slate-400">
						No hay motivos configurados. Otro seguirá disponible al asignar.
					</li>{/each}
			</ul>
		{/if}
	</section>
{/if}

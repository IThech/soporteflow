<script lang="ts">
	import type { UserOrganizationSummary } from '$lib/api/auth';
	let {
		organizations,
		activeOrganizationId,
		disabled = false,
		onchange
	}: {
		organizations: readonly UserOrganizationSummary[];
		activeOrganizationId: string | null;
		disabled?: boolean;
		onchange: (organizationId: string) => void;
	} = $props();
	const controlId = $props.id();
</script>

<div class="mt-2 text-sm">
	{#if organizations.length === 1}
		<p class="text-xs text-slate-400">Organización activa</p>
		<p class="font-medium text-cyan-400">{organizations[0].name}</p>
	{:else if organizations.length > 1}
		<label for={controlId} class="block text-xs text-slate-400">Organización activa</label>
		<select
			id={controlId}
			value={activeOrganizationId ?? ''}
			{disabled}
			onchange={(event) => onchange(event.currentTarget.value)}
			aria-describedby={activeOrganizationId === null ? `${controlId}-hint` : undefined}
			class="mt-1 max-w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-white focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:opacity-50"
		>
			<option value="" disabled>Selecciona una organización</option>
			{#each organizations as organization (organization.id)}
				<option value={organization.id}>{organization.name}</option>
			{/each}
		</select>
		{#if activeOrganizationId === null}
			<p id={`${controlId}-hint`} role="status" class="mt-1 max-w-md text-xs text-slate-300">
				Selecciona una organización para las operaciones reales. Las incidencias siguen en modo
				demo.
			</p>
		{/if}
	{:else}
		<p class="text-xs text-slate-400">Sin organización activa</p>
	{/if}
</div>

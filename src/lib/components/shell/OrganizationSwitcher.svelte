<script lang="ts">
	import type { UserOrganizationSummary } from '$lib/api/auth';
	import Icon from '$lib/ui/Icon.svelte';
	import { applyOrganizationChoice } from '$lib/app/organization-switch';
	/**
	 * Organization switcher for the dark sidebar. Changing the selection only reports the choice;
	 * the page updates the URL and the organization context validates it.
	 * UI-1C: same native <select> (keyboard/screen-reader behavior unchanged), restyled as a card.
	 */
	let {
		organizations,
		activeOrganizationId,
		disabled = false,
		onchange
	}: {
		organizations: readonly UserOrganizationSummary[];
		activeOrganizationId: string | null;
		disabled?: boolean;
		/** Return false to refuse the change (the select then goes back to the active organization). */
		onchange: (organizationId: string) => boolean | void;
	} = $props();
	const controlId = $props.id();
</script>

<div class="sf-org">
	{#if organizations.length === 1}
		<p class="sf-org-label">Organización</p>
		<div class="sf-org-card">
			<span class="sf-org-icon"><Icon name="building-2" size={16} /></span>
			<p class="sf-org-name">{organizations[0].name}</p>
		</div>
	{:else if organizations.length > 1}
		<label class="sf-org-label" for={controlId}>Organización</label>
		<div class="sf-org-card sf-org-card-interactive" data-disabled={disabled}>
			<span class="sf-org-icon"><Icon name="building-2" size={16} /></span>
			<select
				id={controlId}
				class="sf-org-select"
				value={activeOrganizationId ?? ''}
				{disabled}
				onchange={(event) => {
					const select = event.currentTarget;
					const reset = applyOrganizationChoice(onchange, select.value, activeOrganizationId);
					if (reset !== null) select.value = reset;
				}}
			>
				<option value="" disabled>Selecciona una organización</option>
				{#each organizations as organization (organization.id)}
					<option value={organization.id}>{organization.name}</option>
				{/each}
			</select>
			<span class="sf-org-chevron"><Icon name="chevron-down" size={16} /></span>
		</div>
	{/if}
</div>

<style>
	.sf-org {
		margin-top: var(--space-3);
		padding: 0 0 var(--space-4);
		border-bottom: 1px solid var(--sf-navy-border);
	}
	.sf-org-label {
		display: block;
		margin: 0 0 var(--space-2);
		padding: 0 var(--space-1);
		font-size: var(--text-2xs);
		font-weight: 600;
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--sf-navy-text-muted);
	}
	.sf-org-card {
		position: relative;
		display: flex;
		align-items: center;
		min-height: 2.75rem;
		height: 2.75rem;
		border-radius: var(--radius-lg);
		border: 1px solid var(--sf-navy-border);
		background: var(--sf-navy-800);
		color: var(--sf-navy-text-active);
	}
	.sf-org-card:not(.sf-org-card-interactive) {
		gap: var(--space-2-5);
		padding: 0 var(--space-3) 0 var(--space-2-5);
	}
	.sf-org-card-interactive {
		padding: 0;
		transition: border-color var(--duration) var(--ease);
	}
	.sf-org-card-interactive:hover:not([data-disabled='true']) {
		border-color: var(--sf-cyan-border);
	}
	.sf-org-card-interactive:focus-within {
		box-shadow: var(--focus-ring-sidebar);
	}
	.sf-org-icon {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius);
		background: var(--sf-cyan-glow);
		color: var(--sf-cyan-400);
	}
	.sf-org-card-interactive .sf-org-icon {
		position: absolute;
		left: var(--space-2-5);
		top: 50%;
		transform: translateY(-50%);
		pointer-events: none;
	}
	.sf-org-name {
		margin: 0;
		min-width: 0;
		font-size: var(--text-sm);
		font-weight: 600;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}
	.sf-org-select {
		appearance: none;
		width: 100%;
		height: 100%;
		min-height: 2.75rem;
		line-height: 2.75rem;
		padding: 0 2.25rem 0 3.125rem;
		border: 0;
		border-radius: var(--radius-lg);
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: var(--text-sm);
		font-weight: 600;
		text-overflow: ellipsis;
		cursor: pointer;
	}
	.sf-org-select option {
		background: var(--sf-navy-900);
		color: var(--sf-navy-text-active);
	}
	.sf-org-select:focus-visible {
		outline: none;
	}
	.sf-org-select:disabled {
		cursor: progress;
		opacity: 0.7;
	}
	.sf-org-chevron {
		position: absolute;
		right: var(--space-3);
		top: 50%;
		transform: translateY(-50%);
		display: inline-grid;
		place-items: center;
		color: var(--sf-navy-text-muted);
		pointer-events: none;
	}
</style>

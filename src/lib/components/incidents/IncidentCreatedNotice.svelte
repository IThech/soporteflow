<script lang="ts">
	import Button from '$lib/ui/Button.svelte';

	/**
	 * Confirmed creation that the actor cannot read afterwards (incidents:create without a read
	 * scope covering it). A success, never an error: it states what happened and offers only
	 * routes the user can use. No link to the detail (it would answer 403/404).
	 */
	let {
		incidentNumber,
		listHref = null,
		oncreateanother
	}: {
		incidentNumber: number;
		/** Incident list of the current organization, only when the user can read incidents. */
		listHref?: string | null;
		oncreateanother: () => void;
	} = $props();
	const uid = $props.id();
	const titleId = `${uid}-title`;
</script>

<section class="sf-created" role="status" aria-live="polite" aria-labelledby={titleId}>
	<span class="sf-created-mark" aria-hidden="true">
		<svg
			width="22"
			height="22"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg
		>
	</span>
	<h2 class="sf-created-title" id={titleId}>Incidencia creada</h2>
	<p class="sf-created-text">
		La incidencia <strong>#{incidentNumber}</strong> se ha registrado correctamente.
	</p>
	<p class="sf-created-text">
		Tus permisos no incluyen su consulta, por lo que no se abrirá el detalle. El equipo de soporte
		la gestionará.
	</p>
	<div class="sf-created-actions">
		<Button variant="secondary" onclick={oncreateanother}>Crear otra incidencia</Button>
		{#if listHref}<Button href={listHref}>Ir a incidencias</Button>{/if}
	</div>
</section>

<style>
	.sf-created {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: var(--space-8) var(--space-5);
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface-card);
		box-shadow: var(--sf-shadow-card);
		text-align: center;
	}
	.sf-created-mark {
		display: inline-grid;
		place-items: center;
		width: 3rem;
		height: 3rem;
		margin-bottom: var(--space-4);
		border-radius: var(--radius-pill);
		background: var(--success-soft);
		color: var(--success);
	}
	.sf-created-title {
		margin: 0 0 var(--space-2);
		font-size: var(--text-lg);
		font-weight: 700;
		color: var(--text-primary);
	}
	.sf-created-text {
		margin: 0 auto var(--space-1);
		max-width: 32rem;
		font-size: var(--text-sm);
		line-height: 1.55;
		color: var(--text-secondary);
	}
	.sf-created-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: var(--space-2);
		margin-top: var(--space-5);
	}
</style>

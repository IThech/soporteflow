<script lang="ts">
	import { tick } from 'svelte';
	import type { CreateIncidentField } from '$lib/api/incident-create';
	import {
		CREATE_FIELD_ORDER,
		PRIORITY_OPTIONS,
		REQUESTER_SELF,
		SLA_AUTO,
		SLA_NONE,
		type CreateFieldErrors,
		type CreateFormSections,
		type CreateIncidentDraft
	} from '$lib/app/incident-create-form';
	import type {
		CatalogView,
		CreateCatalogName,
		CreateCatalogsState
	} from '$lib/app/incident-create-catalogs';
	import Button from '$lib/ui/Button.svelte';
	import Field from '$lib/ui/Field.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import Input from '$lib/ui/Input.svelte';
	import Select from '$lib/ui/Select.svelte';
	import Textarea from '$lib/ui/Textarea.svelte';
	import { INCIDENT_CLIENT_MAX_LENGTH, INCIDENT_TITLE_MAX_LENGTH } from '$lib/api/incident-detail';

	/**
	 * "New incident" form (UI-2B): rendering, field state and callbacks only. No fetch, no
	 * navigation, no submit logic: `onsubmit` (the page) validates and returns field errors
	 * synchronously; the form then focuses the first invalid field.
	 * Main fields first (title, description, client, priority); the optional context section only
	 * shows the selects the user's capabilities allow, fed exclusively by real catalogs.
	 */
	let {
		draft = $bindable(),
		errors,
		sections,
		catalogs,
		selfName,
		submitting = false,
		submitBlockedSeconds = 0,
		onsubmit,
		oncancel,
		onretrycatalog
	}: {
		draft: CreateIncidentDraft;
		errors: CreateFieldErrors;
		sections: CreateFormSections;
		catalogs: CreateCatalogsState;
		selfName: string | null;
		submitting?: boolean;
		/** 429 cooldown: submitting is disabled for these seconds. */
		submitBlockedSeconds?: number;
		onsubmit: () => CreateFieldErrors;
		oncancel: () => void;
		onretrycatalog: (name: CreateCatalogName) => void;
	} = $props();

	const uid = $props.id();
	const mainHeadingId = `${uid}-main`;
	const contextHeadingId = `${uid}-context`;
	const controls: Partial<Record<CreateIncidentField, HTMLElement | null>> = $state({});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (submitting || submitBlockedSeconds > 0) return;
		const found = onsubmit();
		const first = CREATE_FIELD_ORDER.find((field) => found[field]);
		if (!first) return;
		await tick();
		controls[first]?.focus();
	}

	const withNone = (label: string, view: CatalogView) => [
		{ value: '', label },
		...view.options.map((option) => ({ value: option.value, label: option.label }))
	];
	const requesterOptions = $derived([
		{ value: REQUESTER_SELF, label: selfName ? `Yo (${selfName})` : 'Yo' },
		...catalogs.memberships.options.map((option) => ({
			value: option.value,
			label: option.hint ? `${option.label} · ${option.hint}` : option.label
		}))
	]);
	const slaOptions = $derived([
		{ value: SLA_AUTO, label: 'Automático' },
		...(sections.slaPolicies
			? catalogs.slaPolicies.options.map((option) => ({
					value: option.value,
					label: option.hint ? `${option.label} (${option.hint})` : option.label
				}))
			: []),
		{ value: SLA_NONE, label: 'Sin SLA' }
	]);
</script>

{#snippet catalogState(name: CreateCatalogName, view: CatalogView)}
	{#if view.status === 'loading'}
		<p class="sf-catalog-note" role="status">Cargando opciones…</p>
	{:else if view.status === 'error'}
		<div class="sf-catalog-error" role="alert">
			<p>{view.errorMessage}</p>
			{#if view.error?.requestId}
				<p class="sf-ref">Referencia: <code>{view.error.requestId}</code></p>
			{/if}
			<button type="button" class="sf-link-button" onclick={() => onretrycatalog(name)}>
				Reintentar
			</button>
		</div>
	{/if}
{/snippet}

<form class="sf-create-form" novalidate onsubmit={submit} aria-busy={submitting || undefined}>
	<section class="sf-section" aria-labelledby={mainHeadingId}>
		<h2 class="sf-section-title" id={mainHeadingId}>Información principal</h2>
		<div class="sf-grid">
			<div class="sf-span-full">
				<Field label="Título" required error={errors.title}>
					{#snippet children(control)}
						<Input
							{control}
							bind:value={draft.title}
							bind:element={controls.title}
							placeholder="Introduce un título"
							maxlength={INCIDENT_TITLE_MAX_LENGTH}
							disabled={submitting}
						/>
					{/snippet}
				</Field>
			</div>
			<div class="sf-span-full">
				<Field label="Descripción" required error={errors.description}>
					{#snippet children(control)}
						<Textarea
							{control}
							bind:value={draft.description}
							bind:element={controls.description}
							placeholder="Describe el problema o la solicitud"
							rows={7}
							disabled={submitting}
						/>
					{/snippet}
				</Field>
			</div>
			<div class="sf-span-wide">
				<Field
					label="Cliente"
					required
					hint="Nombre o referencia del cliente asociado a la incidencia."
					error={errors.client}
				>
					{#snippet children(control)}
						<Input
							{control}
							bind:value={draft.client}
							bind:element={controls.client}
							placeholder="Introduce el cliente"
							maxlength={INCIDENT_CLIENT_MAX_LENGTH}
							disabled={submitting}
						/>
					{/snippet}
				</Field>
			</div>
			<div class="sf-span-narrow">
				<Field label="Prioridad" required error={errors.priority}>
					{#snippet children(control)}
						<Select
							{control}
							bind:value={draft.priority}
							bind:element={controls.priority}
							options={PRIORITY_OPTIONS}
							disabled={submitting}
						/>
					{/snippet}
				</Field>
			</div>
		</div>
	</section>

	{#if sections.any}
		<section class="sf-section sf-section-context" aria-labelledby={contextHeadingId}>
			<div class="sf-section-heading">
				<h2 class="sf-section-title" id={contextHeadingId}>Contexto</h2>
				<p class="sf-section-hint">Opcional. Ayuda a clasificar y atender la incidencia.</p>
			</div>
			<div class="sf-grid">
				{#if sections.requester}
					<div>
						<Field
							label="Solicitante"
							hint="Persona de la organización que solicita la atención."
							error={errors.clientUserId}
						>
							{#snippet children(control)}
								<Select
									{control}
									bind:value={draft.requester}
									bind:element={controls.clientUserId}
									options={requesterOptions}
									disabled={submitting}
								/>
							{/snippet}
						</Field>
						{@render catalogState('memberships', catalogs.memberships)}
					</div>
				{/if}
				{#if sections.site}
					<div>
						<Field label="Sede" error={errors.siteId}>
							{#snippet children(control)}
								<Select
									{control}
									bind:value={draft.siteId}
									bind:element={controls.siteId}
									options={withNone('Sin sede', catalogs.sites)}
									disabled={submitting || catalogs.sites.status !== 'ready'}
								/>
							{/snippet}
						</Field>
						{@render catalogState('sites', catalogs.sites)}
					</div>
				{/if}
				{#if sections.category}
					<div>
						<Field label="Categoría" error={errors.categoryId}>
							{#snippet children(control)}
								<Select
									{control}
									bind:value={draft.categoryId}
									bind:element={controls.categoryId}
									options={withNone('Sin categoría', catalogs.categories)}
									disabled={submitting || catalogs.categories.status !== 'ready'}
								/>
							{/snippet}
						</Field>
						{@render catalogState('categories', catalogs.categories)}
					</div>
				{/if}
				{#if sections.sla}
					<div>
						<Field
							label="SLA"
							hint="Automático aplica la política predeterminada de la organización, si existe."
							error={errors.slaPolicyId}
						>
							{#snippet children(control)}
								<Select
									{control}
									bind:value={draft.sla}
									bind:element={controls.slaPolicyId}
									options={slaOptions}
									disabled={submitting}
								/>
							{/snippet}
						</Field>
						{#if sections.slaPolicies}
							{@render catalogState('slaPolicies', catalogs.slaPolicies)}
						{/if}
					</div>
				{/if}
			</div>
		</section>
	{/if}

	<footer class="sf-form-footer">
		<p class="sf-required-note"><span aria-hidden="true">*</span> Campo obligatorio</p>
		<div class="sf-form-actions">
			{#if submitBlockedSeconds > 0}
				<p class="sf-cooldown" aria-live="polite">
					Podrás enviar de nuevo en {submitBlockedSeconds} s.
				</p>
			{/if}
			<Button variant="secondary" onclick={oncancel} disabled={submitting}>Cancelar</Button>
			<Button type="submit" loading={submitting} disabled={submitBlockedSeconds > 0}>
				{#if !submitting}<Icon name="plus" size={16} />{/if}
				{submitting ? 'Creando incidencia…' : 'Crear incidencia'}
			</Button>
		</div>
	</footer>
</form>

<style>
	.sf-create-form {
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface-card);
		box-shadow: var(--sf-shadow-card);
	}
	.sf-section {
		padding: var(--space-6);
	}
	.sf-section-context {
		border-top: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-subtle) 45%, var(--surface-card));
	}
	.sf-section-heading {
		margin-bottom: var(--space-4);
	}
	.sf-section-title {
		margin: 0 0 var(--space-4);
		font-size: var(--text-2xs);
		font-weight: 700;
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.sf-section-heading .sf-section-title {
		margin-bottom: var(--space-1);
	}
	.sf-section-hint {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-secondary);
	}
	.sf-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-5) var(--space-5);
	}
	.sf-span-full {
		grid-column: 1 / -1;
	}
	.sf-grid:has(.sf-span-wide) {
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
	}
	.sf-catalog-note {
		margin: var(--space-2) 0 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	.sf-catalog-error {
		margin-top: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius);
		background: var(--warning-soft);
		color: var(--warning);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}
	.sf-catalog-error p {
		margin: 0;
	}
	.sf-ref {
		margin-top: var(--space-1) !important;
		opacity: 0.85;
	}
	.sf-link-button {
		margin-top: var(--space-1);
		padding: 0.125rem 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		font-weight: 700;
		text-decoration: underline;
		cursor: pointer;
		border-radius: var(--radius-sm);
	}
	.sf-link-button:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	.sf-form-footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-4) var(--space-6);
		border-top: 1px solid var(--border);
	}
	.sf-required-note {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	.sf-required-note span {
		color: var(--danger);
	}
	.sf-form-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
	}
	.sf-cooldown {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--warning);
	}
	@media (max-width: 639px) {
		.sf-section {
			padding: var(--space-5) var(--space-4);
		}
		.sf-grid,
		.sf-grid:has(.sf-span-wide) {
			grid-template-columns: minmax(0, 1fr);
		}
		.sf-form-footer {
			padding: var(--space-4);
		}
		.sf-form-actions {
			width: 100%;
		}
		.sf-form-actions :global(.sf-button) {
			flex: 1 1 auto;
		}
	}
</style>

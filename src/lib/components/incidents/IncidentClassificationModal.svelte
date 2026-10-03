<script lang="ts">
	import { tick, untrack } from 'svelte';
	import {
		classificationChanged,
		reconcileSubcategory,
		subcategoryChoices,
		subcategoryHint,
		toClassification,
		type CategoryChoice
	} from '$lib/app/classification';
	import { focusTrap } from '$lib/ui/focus-trap';
	import Alert from '$lib/ui/Alert.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Field from '$lib/ui/Field.svelte';
	import Select from '$lib/ui/Select.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';
	import Textarea from '$lib/ui/Textarea.svelte';

	/**
	 * Change the classification of an incident: category + OPTIONAL subcategory of that category.
	 * Rendering and local form state only; the page sends the change through the detail
	 * controller (pessimistic, single-shot) and re-reads the incident.
	 * - choices come from the categories tree the page already holds (no request here);
	 * - choosing another category drops a subcategory that does not belong to it;
	 * - the server requires a reason when replacing or removing an existing classification;
	 * - subcategoryId is always explicit: its UUID, or null ("Sin subcategoría").
	 */
	interface Props {
		open: boolean;
		currentCategoryId: string | null;
		currentSubcategoryId: string | null;
		choices: readonly CategoryChoice[];
		loading?: boolean;
		/** Catalog failure (the selects stay unusable, never an empty list). */
		loadError?: string | null;
		submitting?: boolean;
		error?: string | null;
		onSave: (data: {
			categoryId: string | null;
			subcategoryId: string | null;
			reason?: string;
		}) => void | Promise<void>;
		onCancel: () => void;
	}

	let {
		open,
		currentCategoryId,
		currentSubcategoryId,
		choices,
		loading = false,
		loadError = null,
		submitting = false,
		error = null,
		onSave,
		onCancel
	}: Props = $props();

	const uid = $props.id();
	let categoryId = $state('');
	let subcategoryId = $state('');
	let reason = $state('');
	let validationError = $state<string | null>(null);
	let categoryElement = $state<HTMLElement | null>();

	// Each OPENING starts from the incident's current classification (a refresh while open never
	// overwrites what the user is choosing), focus on the category.
	$effect(() => {
		if (!open) return;
		untrack(() => {
			categoryId = currentCategoryId ?? '';
			subcategoryId = currentSubcategoryId ?? '';
			reason = '';
			validationError = null;
		});
		void tick().then(() => categoryElement?.focus());
	});

	const categoryOptions = $derived([
		{ value: '', label: 'Sin categoría' },
		...choices.map((choice) => ({ value: choice.value, label: choice.label }))
	]);
	const subcategories = $derived(subcategoryChoices(choices, categoryId));
	const subcategoryOptions = $derived([
		{ value: '', label: 'Sin subcategoría' },
		...subcategories.map((option) => ({ value: option.value, label: option.label }))
	]);

	function getCategory() {
		return categoryId;
	}
	function setCategory(next: string) {
		categoryId = next;
		subcategoryId = reconcileSubcategory(choices, next, subcategoryId);
		validationError = null;
	}

	const hadClassification = $derived(Boolean(currentCategoryId || currentSubcategoryId));
	const next = $derived(toClassification(categoryId, subcategoryId));
	const changed = $derived(
		classificationChanged(
			{ categoryId: currentCategoryId, subcategoryId: currentSubcategoryId },
			next
		)
	);
	const requiresReason = $derived(hadClassification && changed);
	const blocked = $derived(submitting || loading || Boolean(loadError));

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && !submitting) {
			event.stopPropagation();
			onCancel();
		}
	}

	function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (blocked) return;
		validationError = null;
		if (!changed) {
			onCancel();
			return;
		}
		const cleanReason = reason.trim();
		if (requiresReason && !cleanReason) {
			validationError = 'Indica el motivo del cambio de clasificación.';
			return;
		}
		void onSave({ ...next, ...(cleanReason ? { reason: cleanReason } : {}) });
	}
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
	<div
		class="sf-modal-backdrop"
		data-sf-ui
		role="presentation"
		onclick={(e) => e.target === e.currentTarget && !submitting && onCancel()}
	>
		<div
			class="sf-modal-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="{uid}-title"
			aria-describedby="{uid}-subtitle"
			tabindex="-1"
			use:focusTrap
		>
			<header class="sf-modal-header">
				<div>
					<h2 id="{uid}-title" class="sf-modal-title">Cambiar clasificación</h2>
					<p id="{uid}-subtitle" class="sf-modal-subtitle">
						La subcategoría depende de la categoría elegida.
					</p>
				</div>
				<button
					type="button"
					class="sf-modal-close"
					aria-label="Cerrar modal"
					disabled={submitting}
					onclick={onCancel}
				>
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<line x1="18" y1="6" x2="6" y2="18"></line>
						<line x1="6" y1="6" x2="18" y2="18"></line>
					</svg>
				</button>
			</header>

			<form onsubmit={handleSubmit} class="sf-modal-form">
				{#if loadError}
					<Alert tone="warning" title="No se pudieron cargar las categorías">
						<p>{loadError}</p>
					</Alert>
				{:else if validationError || error}
					<Alert tone="danger" title="Atención">
						<p>{validationError || error}</p>
					</Alert>
				{/if}

				{#if loading}
					<p class="sf-loading" role="status"><Spinner size="sm" /> Cargando categorías…</p>
				{/if}

				<Field label="Categoría">
					{#snippet children(control)}
						<Select
							{control}
							bind:value={getCategory, setCategory}
							bind:element={categoryElement}
							options={categoryOptions}
							disabled={blocked}
						/>
					{/snippet}
				</Field>

				<Field label="Subcategoría" hint={subcategoryHint(categoryId, subcategories)}>
					{#snippet children(control)}
						<Select
							{control}
							bind:value={subcategoryId}
							options={subcategoryOptions}
							disabled={blocked || subcategories.length === 0}
						/>
					{/snippet}
				</Field>

				{#if requiresReason}
					<Field label="Motivo del cambio" required>
						{#snippet children(control)}
							<Textarea
								{control}
								bind:value={reason}
								rows={3}
								placeholder="Explica brevemente por qué cambia la clasificación…"
								disabled={submitting}
							/>
						{/snippet}
					</Field>
				{/if}

				<footer class="sf-modal-footer">
					<Button variant="secondary" size="sm" disabled={submitting} onclick={onCancel}>
						Cancelar
					</Button>
					<Button variant="primary" size="sm" type="submit" disabled={blocked}>
						{#if submitting}
							<Spinner size="sm" label="Guardando…" />
						{/if}
						<span>Guardar clasificación</span>
					</Button>
				</footer>
			</form>
		</div>
	</div>
{/if}

<style>
	/* Same modal shell as IncidentAssignModal (fields come from the shared ui primitives). */
	.sf-modal-backdrop {
		position: fixed;
		inset: 0;
		background: var(--overlay);
		backdrop-filter: blur(4px);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		z-index: 50;
	}

	.sf-modal-dialog {
		background: var(--surface-card);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-xl);
		box-shadow:
			0 20px 25px -5px rgb(0 0 0 / 0.25),
			0 8px 10px -6px rgb(0 0 0 / 0.25);
		width: 100%;
		max-width: 520px;
		max-height: calc(100vh - 2 * var(--space-4));
		display: flex;
		flex-direction: column;
		overflow: auto;
		color: var(--text-primary);
	}

	.sf-modal-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-5) var(--space-6);
		border-bottom: 1px solid var(--border);
		background: var(--surface-subtle);
	}

	.sf-modal-title {
		font-size: var(--text-lg);
		font-weight: 700;
		margin: 0;
	}

	.sf-modal-subtitle {
		margin: var(--space-1) 0 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}

	.sf-modal-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		background: transparent;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0;
		border-radius: var(--radius);
		flex-shrink: 0;
	}

	.sf-modal-close:hover:not(:disabled) {
		background: var(--surface-subtle);
		color: var(--text-primary);
	}

	.sf-modal-close:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.sf-modal-close:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.sf-modal-form {
		padding: var(--space-6);
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.sf-loading {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}

	.sf-modal-footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-3);
		padding-top: var(--space-4);
		border-top: 1px solid var(--border-subtle);
	}

	@media (max-width: 639px) {
		.sf-modal-header,
		.sf-modal-form {
			padding-inline: var(--space-4);
		}
	}
</style>

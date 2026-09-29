<script lang="ts" module>
	/** What a Field hands to its control: ids and ARIA wiring (no domain logic). */
	export interface FieldControl {
		id: string;
		describedBy: string | undefined;
		invalid: boolean;
		required: boolean;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Form field (UI-2B): real <label>, visible required marker (announced by the control's
	 * `required`), helper text and error text, both linked with aria-describedby. The control is
	 * rendered by the caller with the ids given to `children`. Stable ids from $props.id().
	 */
	let {
		label,
		required = false,
		hint,
		error,
		children
	}: {
		label: string;
		required?: boolean;
		hint?: string;
		error?: string | null;
		children: Snippet<[FieldControl]>;
	} = $props();

	const id = $props.id();
	const hintId = `${id}-hint`;
	const errorId = `${id}-error`;
	const describedBy = $derived(
		[hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
	);
</script>

<div class="sf-field" data-invalid={error ? 'true' : undefined}>
	<label class="sf-field-label" for={id}>
		{label}
		{#if required}<span class="sf-required" aria-hidden="true">*</span>{/if}
	</label>
	{@render children({ id, describedBy, invalid: Boolean(error), required })}
	{#if hint}<p class="sf-field-hint" id={hintId}>{hint}</p>{/if}
	{#if error}<p class="sf-field-error" id={errorId}>{error}</p>{/if}
</div>

<style>
	.sf-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}
	.sf-field-label {
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary);
	}
	.sf-required {
		margin-left: 0.125rem;
		color: var(--danger);
	}
	.sf-field-hint {
		margin: 0;
		font-size: var(--text-xs);
		line-height: 1.45;
		color: var(--text-muted);
	}
	.sf-field-error {
		margin: 0;
		font-size: var(--text-xs);
		font-weight: 600;
		line-height: 1.45;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
</style>

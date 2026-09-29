<script lang="ts">
	import type { FieldControl } from './Field.svelte';

	/** Text input bound to a Field's control wiring (label, aria-describedby, aria-invalid). */
	let {
		control,
		value = $bindable(''),
		placeholder,
		maxlength,
		disabled = false,
		autocomplete = 'off',
		element = $bindable()
	}: {
		control: FieldControl;
		value?: string;
		placeholder?: string;
		maxlength?: number;
		disabled?: boolean;
		autocomplete?: HTMLInputElement['autocomplete'];
		/** Element reference for focus management. No fallback: callers may bind a ref that is still undefined. */
		element?: HTMLElement | null | undefined;
	} = $props();
</script>

<input
	bind:this={element}
	bind:value
	class="sf-control"
	type="text"
	id={control.id}
	required={control.required}
	aria-required={control.required || undefined}
	aria-invalid={control.invalid || undefined}
	aria-describedby={control.describedBy}
	{placeholder}
	{maxlength}
	{disabled}
	{autocomplete}
/>

<style>
	.sf-control {
		box-sizing: border-box;
		width: 100%;
		min-height: 2.625rem;
		padding: 0 var(--space-3);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--text-sm);
		box-shadow: var(--shadow-sm);
		transition:
			border-color var(--duration) var(--ease),
			box-shadow var(--duration) var(--ease);
	}
	.sf-control::placeholder {
		color: var(--text-subtle);
	}
	.sf-control:hover:not(:disabled) {
		border-color: var(--text-subtle);
	}
	.sf-control:focus-visible {
		outline: none;
		border-color: var(--sf-cyan-600);
		box-shadow: var(--focus-ring);
	}
	.sf-control[aria-invalid='true'] {
		border-color: var(--danger);
	}
	.sf-control:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
</style>

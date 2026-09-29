<script lang="ts">
	import type { FieldControl } from './Field.svelte';

	/** Multi-line text bound to a Field's control wiring. Vertical resize only. */
	let {
		control,
		value = $bindable(''),
		placeholder,
		rows = 6,
		disabled = false,
		element = $bindable()
	}: {
		control: FieldControl;
		value?: string;
		placeholder?: string;
		rows?: number;
		disabled?: boolean;
		/** Element reference for focus management. No fallback: callers may bind a ref that is still undefined. */
		element?: HTMLElement | null | undefined;
	} = $props();
</script>

<textarea
	bind:this={element}
	bind:value
	class="sf-textarea"
	id={control.id}
	required={control.required}
	aria-required={control.required || undefined}
	aria-invalid={control.invalid || undefined}
	aria-describedby={control.describedBy}
	{placeholder}
	{rows}
	{disabled}></textarea>

<style>
	.sf-textarea {
		box-sizing: border-box;
		width: 100%;
		min-height: 9rem;
		padding: var(--space-3);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--text-sm);
		line-height: 1.55;
		resize: vertical;
		box-shadow: var(--shadow-sm);
		transition:
			border-color var(--duration) var(--ease),
			box-shadow var(--duration) var(--ease);
	}
	.sf-textarea::placeholder {
		color: var(--text-subtle);
	}
	.sf-textarea:hover:not(:disabled) {
		border-color: var(--text-subtle);
	}
	.sf-textarea:focus-visible {
		outline: none;
		border-color: var(--sf-cyan-600);
		box-shadow: var(--focus-ring);
	}
	.sf-textarea[aria-invalid='true'] {
		border-color: var(--danger);
	}
	.sf-textarea:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
</style>

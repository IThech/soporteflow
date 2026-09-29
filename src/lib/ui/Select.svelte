<script lang="ts">
	import type { FieldControl } from './Field.svelte';
	import Icon from './Icon.svelte';

	/**
	 * Native select (keyboard/screen-reader behavior unchanged) with a consistent chevron:
	 * vertically centered, ~16 px from the right border, with padding so text never runs under it.
	 */
	let {
		control,
		value = $bindable(''),
		options,
		disabled = false,
		element = $bindable()
	}: {
		control: FieldControl;
		value?: string;
		options: readonly { value: string; label: string }[];
		disabled?: boolean;
		/** Element reference for focus management. No fallback: callers may bind a ref that is still undefined. */
		element?: HTMLElement | null | undefined;
	} = $props();
</script>

<div class="sf-select-wrap" data-disabled={disabled || undefined}>
	<select
		bind:this={element}
		bind:value
		class="sf-select"
		id={control.id}
		required={control.required}
		aria-required={control.required || undefined}
		aria-invalid={control.invalid || undefined}
		aria-describedby={control.describedBy}
		{disabled}
	>
		{#each options as option (option.value)}
			<option value={option.value}>{option.label}</option>
		{/each}
	</select>
	<span class="sf-select-chevron"><Icon name="chevron-down" size={16} /></span>
</div>

<style>
	.sf-select-wrap {
		position: relative;
		display: flex;
		align-items: center;
		min-width: 0;
	}
	.sf-select {
		appearance: none;
		box-sizing: border-box;
		width: 100%;
		min-height: 2.625rem;
		padding: 0 2.75rem 0 var(--space-3);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--text-sm);
		text-overflow: ellipsis;
		box-shadow: var(--shadow-sm);
		cursor: pointer;
		transition:
			border-color var(--duration) var(--ease),
			box-shadow var(--duration) var(--ease);
	}
	.sf-select:hover:not(:disabled) {
		border-color: var(--text-subtle);
	}
	.sf-select:focus-visible {
		outline: none;
		border-color: var(--sf-cyan-600);
		box-shadow: var(--focus-ring);
	}
	.sf-select[aria-invalid='true'] {
		border-color: var(--danger);
	}
	.sf-select:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.sf-select-chevron {
		position: absolute;
		right: var(--space-4);
		color: var(--text-muted);
		pointer-events: none;
	}
</style>

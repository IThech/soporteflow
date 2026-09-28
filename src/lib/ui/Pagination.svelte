<script lang="ts">
	import Button from './Button.svelte';
	import Icon from './Icon.svelte';
	/**
	 * Keyset pagination: only "previous" and "next" (no page numbers or totals — the server
	 * contract has none). The caller owns the cursor history.
	 */
	let {
		hasPrevious,
		hasNext,
		busy = false,
		onprevious,
		onnext,
		label = 'Paginación'
	}: {
		hasPrevious: boolean;
		hasNext: boolean;
		busy?: boolean;
		onprevious: () => void;
		onnext: () => void;
		label?: string;
	} = $props();
</script>

<nav class="sf-pagination" aria-label={label}>
	<Button variant="secondary" size="sm" disabled={!hasPrevious || busy} onclick={onprevious}>
		<Icon name="chevron-left" size={16} />Anterior
	</Button>
	<Button variant="secondary" size="sm" disabled={!hasNext || busy} onclick={onnext}>
		Siguiente<Icon name="chevron-right" size={16} />
	</Button>
</nav>

<style>
	.sf-pagination {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
		margin-top: var(--space-4);
	}
</style>

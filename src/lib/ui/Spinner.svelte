<script lang="ts">
	/** Busy indicator. The label is announced; the graphic is decorative. */
	let { label = 'Cargando…', size = 'md' }: { label?: string; size?: 'sm' | 'md' } = $props();
</script>

<span class="sf-spinner" data-size={size} role="status">
	<span class="sf-spinner-ring" aria-hidden="true"></span>
	<span class="sf-spinner-label">{label}</span>
</span>

<style>
	.sf-spinner {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.sf-spinner-ring {
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 999px;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		animation: sf-spin 0.8s linear infinite;
	}
	.sf-spinner[data-size='sm'] .sf-spinner-ring {
		width: 0.875rem;
		height: 0.875rem;
	}
	.sf-spinner[data-size='sm'] .sf-spinner-label {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
	}
	@keyframes sf-spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.sf-spinner-ring {
			animation: none;
			border-top-color: var(--border);
			border-left-color: var(--accent);
		}
	}
</style>

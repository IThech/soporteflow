<script lang="ts">
	import Button from '$lib/ui/Button.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	interface Props {
		open: boolean;
		title: string;
		description: string;
		confirmLabel?: string;
		cancelLabel?: string;
		tone?: 'primary' | 'danger' | 'warning';
		submitting?: boolean;
		onConfirm: () => void | Promise<void>;
		onCancel: () => void;
	}

	let {
		open,
		title,
		description,
		confirmLabel = 'Confirmar',
		cancelLabel = 'Cancelar',
		tone = 'primary',
		submitting = false,
		onConfirm,
		onCancel
	}: Props = $props();

	const uid = $props.id();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && !submitting) {
			e.stopPropagation();
			onCancel();
		}
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
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="{uid}-title"
			aria-describedby="{uid}-desc"
			tabindex="-1"
		>
			<header class="sf-modal-header">
				<h2 id="{uid}-title" class="sf-modal-title">{title}</h2>
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

			<div class="sf-modal-body">
				<p id="{uid}-desc" class="sf-modal-desc">{description}</p>
			</div>

			<footer class="sf-modal-footer">
				<Button variant="secondary" size="sm" disabled={submitting} onclick={onCancel}>
					{cancelLabel}
				</Button>
				<button
					type="button"
					class="sf-confirm-btn"
					class:sf-btn-danger={tone === 'danger'}
					class:sf-btn-warning={tone === 'warning'}
					class:sf-btn-primary={tone === 'primary'}
					disabled={submitting}
					onclick={onConfirm}
				>
					{#if submitting}
						<Spinner size="sm" label="Procesando…" />
					{/if}
					<span>{confirmLabel}</span>
				</button>
			</footer>
		</div>
	</div>
{/if}

<style>
	.sf-modal-backdrop {
		position: fixed;
		inset: 0;
		background: var(--overlay, rgba(7, 13, 30, 0.65));
		backdrop-filter: blur(4px);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		z-index: 50;
	}

	.sf-modal-dialog {
		background: var(--surface-card, var(--surface, #ffffff));
		border: 1px solid var(--border-strong, var(--border));
		border-radius: var(--radius-xl, 1rem);
		box-shadow:
			0 20px 25px -5px rgb(0 0 0 / 0.25),
			0 8px 10px -6px rgb(0 0 0 / 0.25),
			var(--shadow, none);
		width: 100%;
		max-width: 480px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		color: var(--text-primary, var(--text));
		animation: sf-modal-in var(--duration) var(--ease);
	}

	@keyframes sf-modal-in {
		from {
			opacity: 0;
			transform: scale(0.97) translateY(-4px);
		}
		to {
			opacity: 1;
			transform: scale(1) translateY(0);
		}
	}

	.sf-modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-4) var(--space-5);
		border-bottom: 1px solid var(--border);
		background: var(--surface-subtle, var(--surface));
	}

	.sf-modal-title {
		font-size: var(--text-base);
		font-weight: 700;
		color: var(--text-primary, var(--text));
		margin: 0;
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
		transition:
			background-color var(--duration) var(--ease),
			color var(--duration) var(--ease);
	}

	.sf-modal-close:hover:not(:disabled) {
		background: var(--surface-subtle);
		color: var(--text-primary, var(--text));
	}

	.sf-modal-close:focus-visible {
		outline: 2px solid var(--sf-cyan-500);
		outline-offset: 2px;
	}

	.sf-modal-close:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.sf-modal-body {
		padding: var(--space-5);
	}

	.sf-modal-desc {
		margin: 0;
		font-size: var(--text-sm);
		line-height: 1.5;
		color: var(--text-secondary);
	}

	.sf-modal-footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-3);
		padding: var(--space-4) var(--space-5);
		border-top: 1px solid var(--border-subtle, var(--border));
		background: var(--surface-subtle, var(--surface));
	}

	.sf-confirm-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius);
		font-family: inherit;
		font-size: var(--text-sm);
		font-weight: 600;
		cursor: pointer;
		border: 1px solid transparent;
		transition: all var(--duration) var(--ease);
	}

	.sf-confirm-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.sf-btn-primary {
		background: var(--sf-cyan-600, #0891b2);
		color: #ffffff;
		border-color: var(--sf-cyan-600, #0891b2);
	}
	.sf-btn-primary:hover:not(:disabled) {
		background: var(--sf-cyan-500, #06b6d4);
	}

	.sf-btn-danger {
		background: var(--danger, #dc2626);
		color: #ffffff;
		border-color: var(--danger, #dc2626);
	}
	.sf-btn-danger:hover:not(:disabled) {
		background: #b91c1c;
	}

	.sf-btn-warning {
		background: var(--warning, #d97706);
		color: #ffffff;
		border-color: var(--warning, #d97706);
	}
	.sf-btn-warning:hover:not(:disabled) {
		background: #b45309;
	}

	.sf-confirm-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>

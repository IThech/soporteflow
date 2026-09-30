<script lang="ts">
	import type { ApiError } from '$lib/api/errors';
	import { UNKNOWN_OUTCOME_MESSAGE } from '$lib/app/mutation';
	import { presentApiError } from '$lib/app/error-presentation';
	import { MESSAGE_MAX_LENGTH } from '$lib/app/incident-conversation';
	import Alert from '$lib/ui/Alert.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	let {
		draft,
		submitting = false,
		error = null,
		outcome = 'idle',
		disabled = false,
		closed = false,
		canAddComment = true,
		onDraftChange,
		onSubmit
	}: {
		draft: string;
		submitting?: boolean;
		error?: ApiError | null;
		outcome?: 'idle' | 'success' | 'error' | 'unknown';
		disabled?: boolean;
		closed?: boolean;
		canAddComment?: boolean;
		onDraftChange?: (val: string) => void;
		onSubmit?: () => void;
	} = $props();

	const uid = $props.id();
	const trimmed = $derived(draft.trim());
	const charCount = $derived(draft.length);
	const isOverLimit = $derived(charCount > MESSAGE_MAX_LENGTH);
	const canSubmit = $derived(
		!disabled && !closed && !submitting && trimmed.length > 0 && !isOverLimit
	);

	function handleInput(e: Event) {
		const target = e.currentTarget as HTMLTextAreaElement;
		onDraftChange?.(target.value);
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
			e.preventDefault();
			if (canSubmit) {
				onSubmit?.();
			}
		}
	}
</script>

<div class="sf-composer-wrapper">
	{#if closed}
		<Alert tone="info" title="Incidencia cerrada">
			<p>La incidencia está cerrada y no admite nuevos comentarios.</p>
		</Alert>
	{:else if canAddComment}
		{#if outcome === 'unknown'}
			<div class="sf-composer-alert">
				<Alert tone="warning" title="Resultado sin confirmar">
					<p>{UNKNOWN_OUTCOME_MESSAGE}</p>
					{#if error?.requestId}
						<p class="sf-req-id">ID de solicitud: {error.requestId}</p>
					{/if}
				</Alert>
			</div>
		{:else if outcome === 'error' && error}
			{@const presented = presentApiError(error)}
			<div class="sf-composer-alert">
				<Alert tone={presented.tone} title={presented.title}>
					<p>{presented.message}</p>
					{#if presented.requestId}
						<p class="sf-req-id">ID de solicitud: {presented.requestId}</p>
					{/if}
				</Alert>
			</div>
		{/if}

		<form
			class="sf-composer-card"
			onsubmit={(e) => {
				e.preventDefault();
				if (canSubmit) onSubmit?.();
			}}
		>
			<label for="{uid}-comment-input" class="sf-sr-only">Escribe un comentario público</label>
			<textarea
				id="{uid}-comment-input"
				class="sf-composer-textarea"
				placeholder="Escribe un comentario público…"
				rows="3"
				value={draft}
				disabled={submitting || disabled}
				aria-invalid={isOverLimit ? 'true' : undefined}
				aria-describedby="{uid}-counter {uid}-shortcut"
				oninput={handleInput}
				onkeydown={handleKeydown}></textarea>

			<footer class="sf-composer-footer">
				<div class="sf-composer-hints">
					<span id="{uid}-shortcut" class="sf-hint-shortcut">
						Pulsa <kbd>Ctrl</kbd>+<kbd>Enter</kbd> para enviar
					</span>
					<span
						id="{uid}-counter"
						class="sf-hint-counter"
						class:sf-counter-warn={charCount > MESSAGE_MAX_LENGTH - 100 && !isOverLimit}
						class:sf-counter-danger={isOverLimit}
					>
						{charCount} / {MESSAGE_MAX_LENGTH}
					</span>
				</div>
				<Button type="submit" variant="primary" size="sm" disabled={!canSubmit}>
					{#if submitting}
						<Spinner size="sm" label="Enviando…" />
						<span>Enviando…</span>
					{:else}
						<span>Enviar comentario</span>
					{/if}
				</Button>
			</footer>
		</form>
	{/if}
</div>

<style>
	.sf-composer-wrapper {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		margin-top: var(--space-2);
	}
	.sf-composer-alert {
		margin-bottom: var(--space-2);
	}
	.sf-req-id {
		margin-top: var(--space-1);
		font-family: var(--font-mono);
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}
	.sf-composer-card {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface-card);
		box-shadow: var(--sf-shadow-card);
		overflow: hidden;
		transition:
			border-color var(--duration) var(--ease),
			box-shadow var(--duration) var(--ease);
	}
	.sf-composer-card:focus-within {
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}
	.sf-composer-textarea {
		width: 100%;
		box-sizing: border-box;
		padding: var(--space-4);
		border: none;
		outline: none;
		resize: vertical;
		min-height: 5.5rem;
		background: transparent;
		color: var(--text-primary);
		font-family: inherit;
		font-size: var(--text-sm);
		line-height: 1.6;
	}
	.sf-composer-textarea::placeholder {
		color: var(--text-muted);
	}
	.sf-composer-textarea:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.sf-composer-footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-4) var(--space-3);
		border-top: 1px solid var(--border);
		background: var(--surface-base, transparent);
	}
	.sf-composer-hints {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
	.sf-hint-shortcut kbd {
		display: inline-block;
		padding: 0.1em 0.35em;
		font-family: var(--font-mono);
		font-size: 0.9em;
		background: var(--surface-elevated, rgba(148, 163, 184, 0.15));
		border: 1px solid var(--border);
		border-radius: var(--radius-xs);
		color: var(--text-secondary);
	}
	.sf-hint-counter {
		font-family: var(--font-mono);
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}
	.sf-counter-warn {
		color: var(--warning-text, #d97706);
		font-weight: 600;
	}
	.sf-counter-danger {
		color: var(--danger-text, #dc2626);
		font-weight: 700;
	}
	@media (max-width: 639px) {
		.sf-hint-shortcut {
			display: none;
		}
		.sf-composer-footer {
			flex-direction: column-reverse;
			align-items: stretch;
		}
		.sf-composer-hints {
			justify-content: flex-end;
		}
	}
</style>

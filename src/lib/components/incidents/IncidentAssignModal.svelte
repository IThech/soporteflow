<script lang="ts">
	import { focusTrap } from '$lib/ui/focus-trap';
	import Button from '$lib/ui/Button.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';
	import Alert from '$lib/ui/Alert.svelte';

	interface Props {
		open: boolean;
		currentTeamId?: string | null;
		currentTeamName?: string | null;
		currentAssigneeUserId?: string | null;
		currentAssigneeUserName?: string | null;
		teams?: readonly { id: string; name: string }[];
		assignees?: readonly { id: string; name: string; email?: string }[];
		teamsLoading?: boolean;
		assigneesLoading?: boolean;
		submitting?: boolean;
		error?: string | null;
		onTeamChange?: (teamId: string | null) => void;
		onSave: (data: {
			teamId?: string | null;
			assignedToUserId?: string | null;
			reason?: string;
		}) => void | Promise<void>;
		onCancel: () => void;
	}

	let {
		open,
		currentTeamId = null,
		currentTeamName = null,
		currentAssigneeUserId = null,
		currentAssigneeUserName = null,
		teams = [],
		assignees = [],
		teamsLoading = false,
		assigneesLoading = false,
		submitting = false,
		error = null,
		onTeamChange,
		onSave,
		onCancel
	}: Props = $props();

	const uid = $props.id();

	let selectedTeamId = $state<string>('');
	let selectedUserId = $state<string>('');
	let reason = $state<string>('');
	let validationError = $state<string | null>(null);

	// Synchronize initial selections when modal opens or current assignment changes
	$effect(() => {
		if (open) {
			selectedTeamId = currentTeamId ?? '';
			selectedUserId = currentAssigneeUserId ?? '';
			reason = '';
			validationError = null;
		}
	});

	// If assignees change and selected user is not present in new list, reset user selection
	$effect(() => {
		if (!assigneesLoading && selectedUserId) {
			const exists = assignees.some((a) => a.id === selectedUserId);
			if (!exists && selectedUserId !== (currentAssigneeUserId ?? '')) {
				selectedUserId = '';
			}
		}
	});

	const wasAssigned = $derived(Boolean(currentTeamId || currentAssigneeUserId));
	const teamChanged = $derived((selectedTeamId || null) !== (currentTeamId || null));
	const assigneeChanged = $derived((selectedUserId || null) !== (currentAssigneeUserId || null));
	const isChanged = $derived(teamChanged || assigneeChanged);
	const requiresReason = $derived(wasAssigned && isChanged);

	function handleTeamChange(e: Event) {
		const val = (e.target as HTMLSelectElement).value;
		selectedTeamId = val;
		validationError = null;
		onTeamChange?.(val ? val : null);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && !submitting) {
			e.stopPropagation();
			onCancel();
		}
	}

	function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (submitting || teamsLoading || assigneesLoading) return;

		validationError = null;

		const targetTeamId = selectedTeamId ? selectedTeamId : null;
		const targetUserId = selectedUserId ? selectedUserId : null;

		// Must select at least a team or technician
		if (!targetTeamId && !targetUserId) {
			validationError = 'Debes seleccionar al menos un equipo o un técnico.';
			return;
		}

		// No effective change: close
		if (
			targetTeamId === (currentTeamId ?? null) &&
			targetUserId === (currentAssigneeUserId ?? null)
		) {
			onCancel();
			return;
		}

		let cleanReason: string | undefined = undefined;
		if (requiresReason) {
			cleanReason = reason.trim();
			if (cleanReason.length === 0) {
				validationError = 'Debes indicar el motivo de la reasignación.';
				return;
			}
		}

		void onSave({
			teamId: targetTeamId,
			assignedToUserId: targetUserId,
			...(cleanReason ? { reason: cleanReason } : {})
		});
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
			tabindex="-1"
			use:focusTrap
		>
			<header class="sf-modal-header">
				<div>
					<h2 id="{uid}-title" class="sf-modal-title">
						{wasAssigned ? 'Reasignar incidencia' : 'Asignar incidencia'}
					</h2>
					<p class="sf-modal-subtitle">
						{wasAssigned
							? 'Modifica el equipo o técnico responsable indicando el motivo.'
							: 'Selecciona un equipo o técnico para atender la incidencia.'}
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
				{#if wasAssigned}
					<div class="sf-current-assignment">
						<span class="sf-current-label">Asignación actual:</span>
						<span class="sf-current-val">
							{currentTeamName ? `Equipo: ${currentTeamName}` : 'Sin equipo'}
							·
							{currentAssigneeUserName ? `Técnico: ${currentAssigneeUserName}` : 'Sin técnico'}
						</span>
					</div>
				{/if}

				{#if validationError || error}
					<Alert tone="danger" title="Atención">
						<p>{validationError || error}</p>
					</Alert>
				{/if}

				<div class="sf-field-group">
					<label for="{uid}-team" class="sf-field-label">Equipo</label>
					<div class="sf-select-wrap">
						<select
							id="{uid}-team"
							class="sf-select"
							value={selectedTeamId}
							disabled={submitting || teamsLoading}
							onchange={handleTeamChange}
						>
							<option value="">(Sin equipo)</option>
							{#each teams as team (team.id)}
								<option value={team.id}>{team.name}</option>
							{/each}
						</select>
						{#if teamsLoading}
							<span class="sf-select-loading"><Spinner size="sm" /></span>
						{/if}
					</div>
				</div>

				<div class="sf-field-group">
					<label for="{uid}-user" class="sf-field-label">Técnico responsable</label>
					<div class="sf-select-wrap">
						<select
							id="{uid}-user"
							class="sf-select"
							bind:value={selectedUserId}
							disabled={submitting || assigneesLoading}
						>
							<option value="">(Sin técnico asignado)</option>
							{#each assignees as assignee (assignee.id)}
								<option value={assignee.id}>
									{assignee.name}
									{assignee.email ? `(${assignee.email})` : ''}
								</option>
							{/each}
						</select>
						{#if assigneesLoading}
							<span class="sf-select-loading"><Spinner size="sm" /></span>
						{/if}
					</div>
				</div>

				{#if requiresReason}
					<div class="sf-field-group">
						<div class="sf-label-row">
							<label for="{uid}-reason" class="sf-field-label">Motivo de la reasignación *</label>
							<span class="sf-char-counter">{1000 - reason.length} caracteres</span>
						</div>
						<textarea
							id="{uid}-reason"
							class="sf-textarea"
							bind:value={reason}
							maxlength={1000}
							rows={3}
							placeholder="Explica brevemente la razón del cambio de responsable…"
							disabled={submitting}
							required></textarea>
					</div>
				{/if}

				<footer class="sf-modal-footer">
					<Button variant="secondary" size="sm" disabled={submitting} onclick={onCancel}>
						Cancelar
					</Button>
					<Button
						variant="primary"
						size="sm"
						type="submit"
						disabled={submitting || teamsLoading || assigneesLoading}
					>
						{#if submitting}
							<Spinner size="sm" label="Guardando…" />
						{/if}
						<span>{wasAssigned ? 'Guardar asignación' : 'Asignar'}</span>
					</Button>
				</footer>
			</form>
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
		max-width: 520px;
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
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-5) var(--space-6);
		border-bottom: 1px solid var(--border);
		background: var(--surface-subtle, var(--surface));
	}

	.sf-modal-title {
		font-size: var(--text-lg);
		font-weight: 700;
		color: var(--text-primary, var(--text));
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
		transition:
			background-color var(--duration) var(--ease),
			color var(--duration) var(--ease);
		flex-shrink: 0;
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

	.sf-modal-form {
		padding: var(--space-6);
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.sf-current-assignment {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		background: var(--surface-subtle, rgba(148, 163, 184, 0.08));
		border: 1px solid var(--border-subtle, var(--border));
		border-radius: var(--radius-md);
		font-size: var(--text-xs);
	}
	.sf-current-label {
		color: var(--text-muted);
		font-weight: 500;
	}
	.sf-current-val {
		color: var(--text-primary);
		font-weight: 600;
	}

	.sf-field-group {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.sf-field-label {
		font-size: var(--text-xs);
		font-weight: 600;
		color: var(--text-secondary);
	}

	.sf-label-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.sf-char-counter {
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}

	.sf-select-wrap {
		position: relative;
		display: flex;
		align-items: center;
	}

	.sf-select {
		width: 100%;
		min-height: 2.5rem;
		padding: 0 var(--space-3);
		border: 1px solid var(--border-strong, var(--border));
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text-primary);
		font-family: inherit;
		font-size: var(--text-sm);
		transition: border-color var(--duration) var(--ease);
	}
	.sf-select:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}
	.sf-select:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.sf-select-loading {
		position: absolute;
		right: var(--space-3);
		pointer-events: none;
	}

	.sf-textarea {
		width: 100%;
		padding: var(--space-2-5, var(--space-2)) var(--space-3);
		border: 1px solid var(--border-strong, var(--border));
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text-primary);
		font-family: inherit;
		font-size: var(--text-sm);
		resize: vertical;
		transition: border-color var(--duration) var(--ease);
	}
	.sf-textarea:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}
	.sf-textarea:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.sf-modal-footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-3);
		margin-top: var(--space-2);
		padding-top: var(--space-4);
		border-top: 1px solid var(--border-subtle, var(--border));
	}
</style>

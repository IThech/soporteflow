<script lang="ts">
	import type { IncidentDetailView } from '$lib/api/incident-detail';
	import type { IncidentPriority, IncidentStatus } from '$lib/api/incident-views';
	import type { IncidentActions } from '$lib/app/incident-actions';
	import Button from '$lib/ui/Button.svelte';
	import Icon from '$lib/ui/Icon.svelte';

	interface Props {
		incident: IncidentDetailView;
		available: IncidentActions;
		mutating?: boolean;
		onStatusChange: (status: IncidentStatus) => void;
		onPriorityChange: (priority: IncidentPriority) => void;
		onOpenAssign: () => void;
		/** Category + subcategory change; omitted when the categories catalog cannot be read. */
		onOpenClassification?: () => void;
		onRequestClose: () => void;
		onRequestReopen: () => void;
	}

	let {
		incident,
		available,
		mutating = false,
		onStatusChange,
		onPriorityChange,
		onOpenAssign,
		onOpenClassification,
		onRequestClose,
		onRequestReopen
	}: Props = $props();

	const uid = $props.id();

	const isStaff = $derived(incident.audience === 'staff');
	const isClosed = $derived(incident.status === 'closed');
	const wasAssigned = $derived(
		isStaff &&
			Boolean(
				('assignedToUserId' in incident && incident.assignedToUserId) ||
				('teamId' in incident && incident.teamId)
			)
	);

	function handlePriorityChange(e: Event) {
		const select = e.target as HTMLSelectElement;
		const nextPriority = select.value as IncidentPriority;
		if (nextPriority !== incident.priority) {
			onPriorityChange(nextPriority);
		}
	}
</script>

{#if isStaff}
	<div class="sf-action-toolbar" role="toolbar" aria-label="Acciones de la incidencia">
		<!-- Prioridad (solo si no está cerrada y cuenta con capability) -->
		{#if available.changePriority.available && !isClosed}
			<div class="sf-action-group">
				<label for="{uid}-priority-select" class="sf-action-label">Prioridad:</label>
				<div class="sf-select-container">
					<select
						id="{uid}-priority-select"
						class="sf-action-select"
						aria-label="Cambiar prioridad"
						value={incident.priority}
						disabled={mutating}
						onchange={handlePriorityChange}
					>
						<option value="low">Baja</option>
						<option value="medium">Media</option>
						<option value="high">Alta</option>
						<option value="urgent">Urgente</option>
					</select>
					<span class="sf-select-chevron" aria-hidden="true">
						<Icon name="chevron-down" size={14} />
					</span>
				</div>
			</div>
		{/if}

		<!-- Asignar / Reasignar -->
		{#if available.assign.available && !isClosed}
			<Button variant="secondary" size="sm" disabled={mutating} onclick={onOpenAssign}>
				<Icon name={wasAssigned ? 'users' : 'user'} size={14} />
				<span>{wasAssigned ? 'Reasignar' : 'Asignar'}</span>
			</Button>
		{/if}

		<!-- Clasificación: categoría + subcategoría -->
		{#if available.changeCategory.available && onOpenClassification}
			<Button variant="secondary" size="sm" disabled={mutating} onclick={onOpenClassification}>
				<span>Clasificar</span>
			</Button>
		{/if}

		<!-- Acciones de Estado -->
		{#if available.changeStatus.available}
			{#if incident.status === 'open'}
				<Button
					variant="secondary"
					size="sm"
					disabled={mutating}
					onclick={() => onStatusChange('pending')}
				>
					<span>Poner en espera</span>
				</Button>
				<Button
					variant="primary"
					size="sm"
					disabled={mutating}
					onclick={() => onStatusChange('resolved')}
				>
					<Icon name="check" size={14} />
					<span>Resolver</span>
				</Button>
			{:else if incident.status === 'pending'}
				<Button
					variant="secondary"
					size="sm"
					disabled={mutating}
					onclick={() => onStatusChange('open')}
				>
					<span>Reanudar</span>
				</Button>
				<Button
					variant="primary"
					size="sm"
					disabled={mutating}
					onclick={() => onStatusChange('resolved')}
				>
					<Icon name="check" size={14} />
					<span>Resolver</span>
				</Button>
			{:else if incident.status === 'resolved'}
				<Button
					variant="secondary"
					size="sm"
					disabled={mutating}
					onclick={() => onStatusChange('open')}
				>
					<Icon name="rotate-ccw" size={14} />
					<span>Reabrir</span>
				</Button>
				<Button variant="secondary" size="sm" disabled={mutating} onclick={onRequestClose}>
					<span>Cerrar</span>
				</Button>
			{:else if incident.status === 'closed'}
				<Button variant="primary" size="sm" disabled={mutating} onclick={onRequestReopen}>
					<Icon name="rotate-ccw" size={14} />
					<span>Reabrir</span>
				</Button>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.sf-action-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.sf-action-group {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
	}

	.sf-action-label {
		font-size: var(--text-xs);
		font-weight: 500;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.sf-select-container {
		position: relative;
		display: inline-flex;
		align-items: center;
	}

	.sf-action-select {
		appearance: none;
		height: 2rem;
		padding: 0 var(--space-6) 0 var(--space-2-5, var(--space-2));
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface-card, var(--surface));
		color: var(--text-primary);
		font-family: inherit;
		font-size: var(--text-xs);
		font-weight: 500;
		cursor: pointer;
		transition: all var(--duration) var(--ease);
	}

	.sf-action-select:hover:not(:disabled) {
		border-color: var(--border-hover, var(--text-muted));
	}

	.sf-action-select:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}

	.sf-action-select:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.sf-select-chevron {
		position: absolute;
		right: var(--space-2);
		color: var(--text-muted);
		pointer-events: none;
		display: flex;
		align-items: center;
	}
</style>

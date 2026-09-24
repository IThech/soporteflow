<script lang="ts">
	import type { CreateIncidentInput } from '$lib/api/incidents';

	interface Props {
		submitting?: boolean;
		error?: string | null;
		onsubmit: (data: CreateIncidentInput) => void;
	}

	let { submitting = false, error = null, onsubmit }: Props = $props();

	let title = $state('');
	let client = $state('');
	let priority = $state<'low' | 'medium' | 'high' | 'urgent'>('medium');
	let description = $state('');
	let clientError = $state<string | null>(null);

	const titleId = 'incident-create-title';
	const clientId = 'incident-create-client';
	const priorityId = 'incident-create-priority';
	const descriptionId = 'incident-create-description';

	const displayError = $derived(clientError || error);

	function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (submitting) return;

		clientError = null;
		const trimmedTitle = title.trim();
		const trimmedClient = client.trim();
		const trimmedDescription = description.trim();

		if (!trimmedTitle) {
			clientError = 'El título es obligatorio.';
			return;
		}
		if (trimmedTitle.length > 255) {
			clientError = 'El título no debe exceder 255 caracteres.';
			return;
		}
		if (!trimmedClient) {
			clientError = 'El cliente es obligatorio.';
			return;
		}
		if (trimmedClient.length > 255) {
			clientError = 'El cliente no debe exceder 255 caracteres.';
			return;
		}
		if (!['low', 'medium', 'high', 'urgent'].includes(priority)) {
			clientError = 'La prioridad seleccionada no es válida.';
			return;
		}
		if (!trimmedDescription) {
			clientError = 'La descripción es obligatoria.';
			return;
		}

		onsubmit({
			title: trimmedTitle,
			client: trimmedClient,
			priority,
			description: trimmedDescription
		});
	}
</script>

<form
	onsubmit={handleSubmit}
	class="space-y-6 rounded-xl border border-slate-800 bg-slate-900/60 p-6 md:p-8"
>
	{#if displayError}
		<div
			class="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300"
			role="alert"
		>
			<p class="font-medium">{displayError}</p>
		</div>
	{/if}

	<div class="space-y-2">
		<label for={titleId} class="block text-sm font-medium text-slate-200">
			Título <span class="text-red-400" aria-hidden="true">*</span>
		</label>
		<input
			id={titleId}
			name="title"
			type="text"
			required
			maxlength="255"
			bind:value={title}
			disabled={submitting}
			aria-invalid={clientError && !title.trim() ? 'true' : undefined}
			class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 transition-colors focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 focus:outline-none disabled:opacity-50"
			placeholder="Ej. Incidencia de conectividad en red troncal"
		/>
	</div>

	<div class="space-y-2">
		<label for={clientId} class="block text-sm font-medium text-slate-200">
			Cliente <span class="text-red-400" aria-hidden="true">*</span>
		</label>
		<input
			id={clientId}
			name="client"
			type="text"
			required
			maxlength="255"
			bind:value={client}
			disabled={submitting}
			aria-invalid={clientError && !client.trim() ? 'true' : undefined}
			class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 transition-colors focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 focus:outline-none disabled:opacity-50"
			placeholder="Ej. Hospital Universitario"
		/>
	</div>

	<div class="space-y-2">
		<label for={priorityId} class="block text-sm font-medium text-slate-200">
			Prioridad <span class="text-red-400" aria-hidden="true">*</span>
		</label>
		<select
			id={priorityId}
			name="priority"
			required
			bind:value={priority}
			disabled={submitting}
			class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-white transition-colors focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 focus:outline-none disabled:opacity-50"
		>
			<option value="low">Baja</option>
			<option value="medium">Media</option>
			<option value="high">Alta</option>
			<option value="urgent">Urgente</option>
		</select>
	</div>

	<div class="space-y-2">
		<label for={descriptionId} class="block text-sm font-medium text-slate-200">
			Descripción <span class="text-red-400" aria-hidden="true">*</span>
		</label>
		<textarea
			id={descriptionId}
			name="description"
			required
			rows="5"
			bind:value={description}
			disabled={submitting}
			aria-invalid={clientError && !description.trim() ? 'true' : undefined}
			class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 transition-colors focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 focus:outline-none disabled:opacity-50"
			placeholder="Describe detalladamente el problema detectado o reportado..."></textarea>
	</div>

	<div class="flex items-center justify-end border-t border-slate-800 pt-4">
		<button
			type="submit"
			disabled={submitting}
			class="inline-flex items-center justify-center rounded-lg bg-cyan-500 px-5 py-2.5 text-sm font-semibold text-slate-950 shadow-sm transition hover:bg-cyan-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
		>
			{#if submitting}
				<svg
					class="mr-2 h-4 w-4 animate-spin text-slate-950"
					xmlns="http://www.w3.org/2000/svg"
					fill="none"
					viewBox="0 0 24 24"
					aria-hidden="true"
				>
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"
					></circle>
					<path
						class="opacity-75"
						fill="currentColor"
						d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
					></path>
				</svg>
				Creando...
			{:else}
				Crear incidencia
			{/if}
		</button>
	</div>
</form>

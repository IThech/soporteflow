<script lang="ts">
	import { incidents as initialIncidents } from '$lib/data/incidents';
	import type { Incident, IncidentPriority, IncidentStatus } from '$lib/types/incident';
	import { onMount } from 'svelte';

	let incidentList = $state<Incident[]>([...initialIncidents]);
	const summary = $derived([
		{
			label: 'Incidencias abiertas',
			value: incidentList.filter((incident) => incident.status === 'open').length,
			color: 'text-cyan-400'
		},
		{
			label: 'Pendientes',
			value: incidentList.filter((incident) => incident.status === 'pending').length,
			color: 'text-amber-400'
		},
		{
			label: 'Resueltas',
			value: incidentList.filter((incident) => incident.status === 'resolved').length,
			color: 'text-emerald-400'
		}
	]);
	let title = $state('');
	let client = $state('');
	let description = $state('');
	let priority = $state<IncidentPriority>('medium');
	const STORAGE_KEY = 'soporteflow-incidents';
	let selectedStatus = $state<'all' | IncidentStatus>('all');

	const statusFilters = [
		{ value: 'all', label: 'Todas' },
		{ value: 'open', label: 'Abiertas' },
		{ value: 'pending', label: 'Pendientes' },
		{ value: 'resolved', label: 'Resueltas' }
	] satisfies { value: 'all' | IncidentStatus; label: string }[];

	let searchQuery = $state('');

	const filteredIncidents = $derived.by(() => {
		const query = searchQuery.trim().toLocaleLowerCase('es');

		return incidentList.filter((incident) => {
			const matchesStatus = selectedStatus === 'all' || incident.status === selectedStatus;

			const matchesSearch =
				incident.title.toLocaleLowerCase('es').includes(query) ||
				incident.client.toLocaleLowerCase('es').includes(query);

			return matchesStatus && matchesSearch;
		});
	});

	onMount(() => {
		const storedIncidents = localStorage.getItem(STORAGE_KEY);

		if (storedIncidents) {
			try {
				incidentList = JSON.parse(storedIncidents);
			} catch {
				localStorage.removeItem(STORAGE_KEY);
			}
		}
	});

	function saveIncidents() {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(incidentList));
	}

	let isFormOpen = $state(false);

	const priorityLabels = {
		low: 'Baja',
		medium: 'Media',
		high: 'Alta'
	};

	const priorityClasses = {
		low: 'text-slate-400',
		medium: 'text-amber-400',
		high: 'text-rose-400'
	};

	function updateIncidentStatus(id: number, event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		const status = select.value as IncidentStatus;
		const incident = incidentList.find((item) => item.id === id);

		if (!incident) return;

		const missingDescription = !incident.description?.trim();
		const missingSolution = status === 'resolved' && !incident.solution?.trim();

		if (missingDescription || missingSolution) {
			select.value = incident.status;

			window.alert(
				missingDescription
					? 'Completa la descripción del problema antes de cambiar el estado.'
					: 'Para resolver esta incidencia, indica la solución aplicada.'
			);

			openEditIncident(id);

			if (editingIncident) {
				editingIncident.status = status;
			}

			return;
		}

		incidentList = incidentList.map((item) => (item.id === id ? { ...item, status } : item));

		saveIncidents();
	}

	function deleteIncident(id: number) {
		const incident = incidentList.find((item) => item.id === id);

		if (!incident) return;

		const confirmed = window.confirm(
			`¿Seguro que quieres eliminar la incidencia "${incident.title}"?`
		);

		if (!confirmed) return;

		incidentList = incidentList.filter((item) => item.id !== id);
		saveIncidents();
	}

	function createIncident(event: SubmitEvent) {
		event.preventDefault();

		const cleanTitle = title.trim();
		const cleanClient = client.trim();
		const cleanDescription = description.trim();

		if (!cleanTitle || !cleanClient || !cleanDescription) {
			window.alert('Completa el título, el cliente y la descripción del problema.');
			return;
		}

		const nextId =
			incidentList.length > 0 ? Math.max(...incidentList.map((incident) => incident.id)) + 1 : 1;

		incidentList.unshift({
			id: nextId,
			title: cleanTitle,
			client: cleanClient,
			description: cleanDescription,
			solution: '',
			status: 'open',
			priority,
			createdAt: new Date().toISOString().slice(0, 10)
		});

		saveIncidents();

		title = '';
		client = '';
		description = '';
		priority = 'medium';
		isFormOpen = false;
	}

	type EditableIncident = Incident;

	let editingIncident = $state<EditableIncident | null>(null);

	function openEditIncident(id: number) {
		const incident = incidentList.find((item) => item.id === id);

		if (!incident) return;

		editingIncident = {
			...incident,
			description: incident.description ?? '',
			solution: incident.solution ?? ''
		};
	}

	function showEditDialog(dialog: HTMLDialogElement) {
		dialog.showModal();
	}

	function saveEditedIncident(event: SubmitEvent) {
		event.preventDefault();

		if (!editingIncident) return;

		const updatedIncident: Incident = {
			...editingIncident,
			title: editingIncident.title.trim(),
			client: editingIncident.client.trim(),
			description: (editingIncident.description ?? '').trim(),
			solution: (editingIncident.solution ?? '').trim()
		};

		if (!updatedIncident.title || !updatedIncident.client) {
			window.alert('Completa el título y el cliente.');
			return;
		}

		if (!updatedIncident.description) {
			window.alert('Describe el problema antes de guardar la incidencia.');
			return;
		}

		if (updatedIncident.status === 'resolved' && !updatedIncident.solution) {
			window.alert('Para resolver esta incidencia, indica qué hiciste y cuál fue el resultado.');
			return;
		}

		incidentList = incidentList.map((incident) =>
			incident.id === updatedIncident.id ? updatedIncident : incident
		);

		saveIncidents();
		editingIncident = null;
	}
</script>

<svelte:head>
	<title>Panel | SoporteFlow</title>
	<meta name="description" content="Gestor de incidencias de soporte técnico" />
</svelte:head>

<div class="min-h-screen bg-slate-950 text-white">
	<header class="border-b border-slate-800 bg-slate-900">
		<div class="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
			<div>
				<p class="text-xl font-bold">Soporte<span class="text-cyan-400">Flow</span></p>
				<p class="text-xs text-slate-400">Gestión de soporte técnico</p>
			</div>

			<button
				type="button"
				onclick={() => (isFormOpen = true)}
				class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
			>
				Nueva incidencia
			</button>
		</div>
	</header>

	<main class="mx-auto max-w-7xl px-6 py-10">
		<section>
			<p class="text-sm font-medium text-cyan-400">Panel principal</p>
			<h1 class="mt-1 text-3xl font-bold">Resumen de incidencias</h1>
			<p class="mt-2 text-slate-400">Consulta rápidamente el estado del soporte técnico.</p>
		</section>

		<section class="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each summary as item (item.label)}
				<article class="rounded-xl border border-slate-800 bg-slate-900 p-6">
					<p class="text-sm text-slate-400">{item.label}</p>
					<p class={`mt-2 text-4xl font-bold ${item.color}`}>{item.value}</p>
				</article>
			{/each}
		</section>

		<section class="mt-8 rounded-xl border border-slate-800 bg-slate-900">
			<div class="border-b border-slate-800 px-6 py-5">
				<h2 class="text-lg font-semibold">Incidencias recientes</h2>

				<p class="text-sm text-slate-400">Aquí aparecerán los últimos casos registrados.</p>
				<div class="mt-4">
					<label for="incident-search" class="mb-2 block text-sm font-medium text-slate-300">
						Buscar incidencias
					</label>

					<input
						id="incident-search"
						type="search"
						bind:value={searchQuery}
						placeholder="Escribe un título o cliente..."
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-500 focus:border-cyan-400"
					/>

					<p class="mt-2 text-xs text-slate-400" role="status">
						Resultados: {filteredIncidents.length} de {incidentList.length}
					</p>
				</div>

				<div class="mt-4 flex flex-wrap gap-2">
					{#each statusFilters as filter (filter.value)}
						<button
							type="button"
							onclick={() => (selectedStatus = filter.value)}
							aria-pressed={selectedStatus === filter.value}
							class={`rounded-lg px-3 py-2 text-sm font-medium transition ${
								selectedStatus === filter.value
									? 'bg-cyan-500 text-slate-950'
									: 'bg-slate-800 text-slate-400 hover:text-white'
							}`}
						>
							{filter.label}
						</button>
					{/each}
				</div>
			</div>

			<div class="overflow-x-auto">
				<table class="w-full text-left">
					<thead class="text-xs text-slate-500 uppercase">
						<tr class="border-b border-slate-800">
							<th class="px-6 py-4 font-medium">Incidencia</th>
							<th class="px-6 py-4 font-medium">Cliente</th>
							<th class="px-6 py-4 font-medium">Prioridad</th>
							<th class="px-6 py-4 font-medium">Estado</th>
							<th class="px-6 py-4 font-medium">Fecha</th>
						</tr>
					</thead>

					<tbody>
						{#each filteredIncidents as incident (incident.id)}
							<tr class="border-b border-slate-800/70 last:border-0 hover:bg-slate-800/30">
								<td class="px-6 py-4">
									<button
										type="button"
										onclick={() => openEditIncident(incident.id)}
										aria-label={`Editar incidencia ${incident.id}: ${incident.title}`}
										class="rounded text-left font-medium text-cyan-400 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-400"
									>
										{incident.title}
									</button>
									<p class="mt-1 text-xs text-slate-500">#{incident.id}</p>
								</td>

								<td class="px-6 py-4 text-sm text-slate-400">
									{incident.client}
								</td>

								<td class={`px-6 py-4 text-sm font-medium ${priorityClasses[incident.priority]}`}>
									{priorityLabels[incident.priority]}
								</td>
								<td class="px-6 py-4">
									<select
										value={incident.status}
										onchange={(event) => updateIncidentStatus(incident.id, event)}
										class="rounded-full border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
										aria-label={`Cambiar estado de ${incident.title}`}
									>
										<option value="open">Abierta</option>
										<option value="pending">Pendiente</option>
										<option value="resolved">Resuelta</option>
									</select>

									<button
										type="button"
										onclick={() => deleteIncident(incident.id)}
										class="mt-2 block text-xs font-medium text-red-400 transition hover:text-red-300"
									>
										Eliminar
									</button>
								</td>

								<td class="px-6 py-4 text-sm text-slate-500">
									{new Date(incident.createdAt).toLocaleDateString('es-ES')}
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="5" class="px-6 py-10 text-center text-sm text-slate-400">
									No hay incidencias que coincidan con los filtros actuales.
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	</main>
	{#if isFormOpen}
		<dialog
			use:showEditDialog
			onclose={() => (isFormOpen = false)}
			aria-labelledby="new-incident-title"
			class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
		>
			<div class="flex items-start justify-between">
				<div>
					<p class="text-sm font-medium text-cyan-400">Soporte técnico</p>
					<h2 id="new-incident-title" class="mt-1 text-2xl font-bold">Nueva incidencia</h2>
				</div>

				<button
					type="button"
					onclick={() => (isFormOpen = false)}
					aria-label="Cerrar formulario"
					class="rounded-lg px-3 py-2 text-slate-400 hover:bg-slate-800 hover:text-white"
				>
					✕
				</button>
			</div>

			<form class="mt-6 space-y-5" onsubmit={createIncident}>
				<div>
					<label for="new-description" class="mb-2 block text-sm font-medium text-slate-300">
						Descripción del problema (obligatoria)
					</label>

					<textarea
						id="new-description"
						bind:value={description}
						required
						rows="3"
						placeholder="¿Qué ocurre, desde cuándo y a quién afecta?"
						class="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-500 focus:border-cyan-400"
					></textarea>
				</div>
				<div>
					<label for="title" class="mb-2 block text-sm font-medium text-slate-300"> Título </label>
					<input
						id="title"
						bind:value={title}
						required
						placeholder="Ej.: El portátil no se conecta a la red"
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-600 focus:border-cyan-400"
					/>
				</div>

				<div>
					<label for="client" class="mb-2 block text-sm font-medium text-slate-300">
						Cliente
					</label>
					<input
						id="client"
						bind:value={client}
						required
						placeholder="Nombre del cliente"
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-600 focus:border-cyan-400"
					/>
				</div>

				<div>
					<label for="priority" class="mb-2 block text-sm font-medium text-slate-300">
						Prioridad
					</label>
					<select
						id="priority"
						bind:value={priority}
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400"
					>
						<option value="low">Baja</option>
						<option value="medium">Media</option>
						<option value="high">Alta</option>
					</select>
				</div>

				<div class="flex justify-end gap-3 pt-2">
					<button
						type="button"
						onclick={() => (isFormOpen = false)}
						class="rounded-lg px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800"
					>
						Cancelar
					</button>

					<button
						type="submit"
						class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400"
					>
						Crear incidencia
					</button>
				</div>
			</form>
		</dialog>
	{/if}
	{#if editingIncident}
		<dialog
			use:showEditDialog
			onclose={() => (editingIncident = null)}
			aria-labelledby="edit-incident-title"
			class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-white shadow-2xl backdrop:bg-slate-950/80"
		>
			<div class="flex items-start justify-between gap-4">
				<div>
					<p class="text-sm font-medium text-cyan-400">
						Incidencia #{editingIncident.id}
					</p>
					<h2 id="edit-incident-title" class="mt-1 text-2xl font-bold">Editar incidencia</h2>
				</div>

				<button
					type="button"
					onclick={() => (editingIncident = null)}
					aria-label="Cerrar edición"
					class="rounded-lg px-3 py-2 text-slate-400 hover:bg-slate-800 hover:text-white"
				>
					✕
				</button>
			</div>

			<form class="mt-6 space-y-5" onsubmit={saveEditedIncident}>
				<div>
					<label for="edit-description" class="mb-2 block text-sm font-medium text-slate-300">
						Descripción del problema
					</label>
					<textarea
						id="edit-description"
						bind:value={editingIncident.description}
						rows="3"
						placeholder="¿Qué ocurre, desde cuándo y a quién afecta?"
						class="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-500 focus:border-cyan-400"
						required={editingIncident.status === 'resolved'}></textarea>
				</div>

				<div>
					<label for="edit-solution" class="mb-2 block text-sm font-medium text-slate-300">
						Solución aplicada
					</label>
					<textarea
						id="edit-solution"
						bind:value={editingIncident.solution}
						rows="3"
						placeholder="Describe las acciones realizadas y el resultado."
						class="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-500 focus:border-cyan-400"
					></textarea>
				</div>
				<div>
					<label for="edit-title" class="mb-2 block text-sm font-medium text-slate-300">
						Título
					</label>
					<input
						id="edit-title"
						bind:value={editingIncident.title}
						required
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400"
					/>
				</div>

				<div>
					<label for="edit-client" class="mb-2 block text-sm font-medium text-slate-300">
						Cliente
					</label>
					<input
						id="edit-client"
						bind:value={editingIncident.client}
						required
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400"
					/>
				</div>

				<div>
					<label for="edit-priority" class="mb-2 block text-sm font-medium text-slate-300">
						Prioridad
					</label>
					<select
						id="edit-priority"
						bind:value={editingIncident.priority}
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400"
					>
						<option value="low">Baja</option>
						<option value="medium">Media</option>
						<option value="high">Alta</option>
					</select>
				</div>

				<div>
					<label for="edit-status" class="mb-2 block text-sm font-medium text-slate-300">
						Estado
					</label>
					<select
						id="edit-status"
						bind:value={editingIncident.status}
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-cyan-400"
					>
						<option value="open">Abierta</option>
						<option value="pending">Pendiente</option>
						<option value="resolved">Resuelta</option>
					</select>
				</div>

				<div class="flex justify-end gap-3 pt-2">
					<button
						type="button"
						onclick={() => (editingIncident = null)}
						class="rounded-lg px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800"
					>
						Cancelar
					</button>

					<button
						type="submit"
						class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400"
					>
						Guardar cambios
					</button>
				</div>
			</form>
		</dialog>
	{/if}
</div>

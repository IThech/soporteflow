<script lang="ts">
	import {
		queueIncidents,
		filterIncidentQueue,
		normalizeSearchText,
		validQueue,
		type IncidentQueue
	} from '$lib/incidents/queue';
	import { isIncidentList } from '$lib/incidents/validation';
	import {
		assignmentCandidates,
		prepareAssignment,
		incidentOrganizationId
	} from '$lib/incidents/assignment';
	import {
		loadHistory,
		recoverAssignment,
		commitAssignment,
		INCIDENTS_KEY,
		HISTORY_KEY,
		RECOVERY_KEY
	} from '$lib/storage/assignment';
	import { demoOrganization } from '$lib/data/organizations';
	import { demoUsers } from '$lib/data/users';
	import type { IncidentHistoryEntry } from '$lib/types/incident-history';
	import IncidentTimeline from '$lib/components/IncidentTimeline.svelte';
	import { demoSupportTeams } from '$lib/data/teams';
	import AssignmentDialog from '$lib/components/AssignmentDialog.svelte';
	import { incidents as initialIncidents } from '$lib/data/incidents';
	import type { Incident, IncidentPriority, IncidentStatus } from '$lib/types/incident';
	import { onMount } from 'svelte';
	import { initialCategories } from '$lib/data/categories';
	import type { IncidentCategory } from '$lib/types/category';
	import { SvelteSet } from 'svelte/reactivity';

	import DemoSessionSelector from '$lib/components/DemoSessionSelector.svelte';
	import { defaultDemoUser, demoSessionUsers } from '$lib/auth/demo-session';
	import { hasPermission, canAccessOrganization } from '$lib/auth/permissions';
	import { canViewIncident, canActOnIncident, canAccessRecord } from '$lib/auth/record-access';
	import type { AppUser } from '$lib/types/user';

	let incidentList = $state<Incident[]>([...initialIncidents]);
	let categoryList = $state<IncidentCategory[]>(
		initialCategories.map((category) => ({ ...category }))
	);
	let activeUser = $state<AppUser>(defaultDemoUser);
	const visibleIncidents = $derived(
		incidentList.filter((incident) => canViewIncident(activeUser, incident))
	);
	const visibleCategories = $derived(
		categoryList.filter((category) => canAccessRecord(activeUser, category))
	);
	let selectedQueue = $state<IncidentQueue>('all');
	const queueOptions = [
		{ value: 'all', label: 'Todas' },
		{ value: 'mine', label: 'Mis incidencias' },
		{ value: 'unassigned', label: 'Sin asignar' }
	] satisfies { value: IncidentQueue; label: string }[];
	const currentQueue = $derived(queueIncidents(activeUser, incidentList, selectedQueue));
	const mineCount = $derived(
		activeUser.role === 'technician' ? queueIncidents(activeUser, incidentList, 'mine').length : 0
	);
	const unassignedCount = $derived(
		activeUser.role === 'technician'
			? queueIncidents(activeUser, incidentList, 'unassigned').length
			: 0
	);
	function categoryName(incident: Incident): string {
		if (!incident.categoryId) return 'Sin categoría';
		return (
			categoryList.find(
				(category) =>
					category.id === incident.categoryId &&
					(category.organizationId ?? demoOrganization.id) === incidentOrganizationId(incident)
			)?.name ?? 'Categoría no disponible'
		);
	}
	const canEdit = $derived(hasPermission(activeUser, 'incidents:edit'));
	const canDelete = $derived(hasPermission(activeUser, 'incidents:delete'));
	const canCreate = $derived(hasPermission(activeUser, 'incidents:create'));
	const canManageCategories = $derived(hasPermission(activeUser, 'categories:manage'));

	function changeDemoUser(user: AppUser) {
		if (!demoSessionUsers.includes(user)) return;
		editingIncident = null;
		assignmentIncident = null;
		assignmentError = '';
		categoryDraft = null;
		categorySaveError = '';
		isFormOpen = false;
		title = '';
		client = '';
		description = '';
		priority = 'medium';
		searchQuery = '';
		selectedStatus = 'all';
		selectedQueue = validQueue(user, 'all');
		activeUser = user;
	}

	const summary = $derived([
		{
			label: 'Incidencias abiertas',
			value: visibleIncidents.filter((incident) => incident.status === 'open').length,
			color: 'text-cyan-400'
		},
		{
			label: 'Pendientes',
			value: visibleIncidents.filter((incident) => incident.status === 'pending').length,
			color: 'text-amber-400'
		},
		{
			label: 'Resueltas',
			value: visibleIncidents.filter((incident) => incident.status === 'resolved').length,
			color: 'text-emerald-400'
		}
	]);

	let title = $state('');
	let client = $state('');
	let description = $state('');
	let priority = $state<IncidentPriority>('medium');

	const STORAGE_KEY = INCIDENTS_KEY;

	let selectedStatus = $state<'all' | IncidentStatus>('all');

	const statusFilters = [
		{ value: 'all', label: 'Todas' },
		{ value: 'open', label: 'Abiertas' },
		{ value: 'pending', label: 'Pendientes' },
		{ value: 'resolved', label: 'Resueltas' }
	] satisfies { value: 'all' | IncidentStatus; label: string }[];

	let searchQuery = $state('');
	const filteredIncidents = $derived(
		filterIncidentQueue(activeUser, incidentList, selectedQueue, selectedStatus, searchQuery)
	);

	let incidentLoadError = $state('');
	let history = $state<IncidentHistoryEntry[]>([]);
	let assignmentReady = $state(false);
	let assignmentError = $state('');
	let assignmentIncident = $state<Incident | null>(null);
	let assignmentTarget = $state('');
	let storedIncidentSnapshot: string | null = null;
	let storedHistorySnapshot: string | null = null;
	function assigneeName(incident: Incident): string {
		if (!incident.assignedToUserId) return 'Sin asignar';
		const user = demoUsers.find(
			(item) =>
				item.id === incident.assignedToUserId &&
				item.organizationId === incidentOrganizationId(incident)
		);
		return user ? user.name + (user.active ? '' : ' (inactivo)') : 'Técnico no disponible';
	}
	function openAssignment(incident: Incident, self = false) {
		if (
			!assignmentReady ||
			incidentLoadError ||
			!canActOnIncident(activeUser, incident, 'incidents:assign')
		)
			return;
		assignmentError = '';
		assignmentTarget = self ? activeUser.id : (incident.assignedToUserId ?? '');
		assignmentIncident = incident;
	}
	function confirmAssignment(targetId: string, reason: string, comment: string) {
		if (!assignmentReady || incidentLoadError || !assignmentIncident) return;
		try {
			const id = assignmentIncident.id;
			const original = incidentList.find((item) => item.id === id);
			if (!original) throw new Error('La incidencia ya no existe.');
			const change = prepareAssignment(activeUser, original, demoUsers, targetId, reason, comment);
			if (!change) {
				assignmentIncident = null;
				return;
			}
			const next = incidentList.map((item) => (item.id === id ? change.incident : item));
			const nextHistory = [...history, change.event];
			commitAssignment(
				localStorage,
				next,
				nextHistory,
				storedIncidentSnapshot,
				storedHistorySnapshot
			);
			incidentList = next;
			history = nextHistory;
			storedIncidentSnapshot = JSON.stringify(next);
			storedHistorySnapshot = JSON.stringify(nextHistory);
			assignmentIncident = null;
		} catch (error) {
			assignmentError =
				error instanceof Error ? error.message : 'No se pudo guardar la asignación.';
		}
	}

	onMount(() => {
		try {
			recoverAssignment(localStorage);
			const stored = localStorage.getItem(STORAGE_KEY);
			storedIncidentSnapshot = stored;
			storedHistorySnapshot = localStorage.getItem(HISTORY_KEY);
			history = loadHistory(storedHistorySnapshot);
			if (stored !== null) {
				const parsed: unknown = JSON.parse(stored);
				if (!isIncidentList(parsed)) {
					throw new Error('Formato de incidencias no válido');
				}
				incidentList = parsed;
			}
			assignmentReady = true;
		} catch {
			incidentLoadError =
				'No se pudieron cargar las incidencias o su historial. Se ha bloqueado la edición para conservar los datos guardados.';
			incidentList = [];
		}
	});

	function saveIncidents() {
		if (incidentLoadError) return;
		try {
			if (
				localStorage.getItem(STORAGE_KEY) !== storedIncidentSnapshot ||
				localStorage.getItem(HISTORY_KEY) !== storedHistorySnapshot ||
				localStorage.getItem(RECOVERY_KEY) !== null
			)
				throw new Error('Los datos han cambiado en otra pestaña. Recarga antes de continuar.');
			localStorage.setItem(STORAGE_KEY, JSON.stringify(incidentList));
			storedIncidentSnapshot = JSON.stringify(incidentList);
		} catch {
			incidentLoadError =
				'No se pudieron guardar los cambios o los datos han cambiado en otra pestaña. Recarga antes de continuar.';
			window.alert(incidentLoadError);
		}
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

		if (!incident || incidentLoadError || !canActOnIncident(activeUser, incident, 'incidents:edit'))
			return;

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

		if (
			!incident ||
			incidentLoadError ||
			!canActOnIncident(activeUser, incident, 'incidents:delete')
		)
			return;

		const confirmed = window.confirm(
			`¿Seguro que quieres eliminar la incidencia "${incident.title}"?`
		);

		if (!confirmed) return;

		incidentList = incidentList.filter((item) => item.id !== id);
		saveIncidents();
	}

	function createIncident(event: SubmitEvent) {
		event.preventDefault();

		if (
			incidentLoadError ||
			!hasPermission(activeUser, 'incidents:create') ||
			!activeUser.organizationId ||
			!canAccessOrganization(activeUser, activeUser.organizationId)
		)
			return;
		const cleanTitle = title.trim();
		const cleanClient = activeUser.role === 'client' ? activeUser.name : client.trim();
		const cleanDescription = description.trim();

		if (!cleanTitle || !cleanClient || !cleanDescription) {
			window.alert('Completa el título, el cliente y la descripción del problema.');
			return;
		}

		const nextId =
			Math.max(
				0,
				...incidentList.map((incident) => incident.id),
				...history.map((entry) => entry.incidentId)
			) + 1;

		incidentList.unshift({
			id: nextId,
			organizationId: activeUser.organizationId,
			createdByUserId: activeUser.id,
			...(activeUser.role === 'client' ? { clientUserId: activeUser.id } : {}),
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

		if (!incident || incidentLoadError || !canActOnIncident(activeUser, incident, 'incidents:edit'))
			return;

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

		if (!editingIncident || incidentLoadError) return;
		const editingId = editingIncident.id;
		const original = incidentList.find((item) => item.id === editingId);
		if (!original || !canActOnIncident(activeUser, original, 'incidents:edit')) return;

		const updatedIncident: Incident = {
			...original,
			priority: editingIncident.priority,
			status: editingIncident.status,
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

	const CATEGORY_STORAGE_KEY = 'soporteflow-categories';

	let categoryLoaded = $state(false);
	let categoryLoadError = $state('');
	let categorySaveError = $state('');
	let categoryDraft = $state<{ id?: string; name: string; description: string } | null>(null);

	function mayManageCategory(category?: IncidentCategory): boolean {
		return (
			categoryLoaded &&
			!categoryLoadError &&
			hasPermission(activeUser, 'categories:manage') &&
			(category
				? canAccessRecord(activeUser, category)
				: !!activeUser.organizationId &&
					canAccessOrganization(activeUser, activeUser.organizationId))
		);
	}

	function openCategoryForm(id?: string) {
		const category = id === undefined ? undefined : categoryList.find((item) => item.id === id);
		if ((id !== undefined && !category) || !mayManageCategory(category)) return;
		categorySaveError = '';
		categoryDraft = category
			? { id: category.id, name: category.name, description: category.description }
			: { name: '', description: '' };
	}

	function persistCategories(next: IncidentCategory[]): boolean {
		if (!categoryLoaded || categoryLoadError || !hasPermission(activeUser, 'categories:manage'))
			return false;
		try {
			localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(next));
			categoryList = next;
			categorySaveError = '';
			return true;
		} catch {
			categorySaveError =
				'No se pudieron guardar los cambios. El catálogo no se ha modificado. Inténtalo de nuevo.';
			return false;
		}
	}

	function saveCategory(event: SubmitEvent) {
		event.preventDefault();
		if (!categoryDraft) return;
		const draft = categoryDraft;
		const original =
			draft.id === undefined ? undefined : categoryList.find((item) => item.id === draft.id);
		if ((draft.id !== undefined && !original) || !mayManageCategory(original)) return;
		const name = draft.name.trim();
		const description = draft.description.trim();
		if (!name) {
			categorySaveError = 'Escribe un nombre para la categoría.';
			return;
		}
		// Compare only within the target organization, including legacy Nodhouses data.
		if (
			categoryList.some(
				(item) =>
					item.id !== original?.id &&
					canAccessRecord(activeUser, item) &&
					normalizeSearchText(item.name) === normalizeSearchText(name)
			)
		) {
			categorySaveError = 'Ya existe una categoría con ese nombre, activa o inactiva.';
			return;
		}
		const category: IncidentCategory = original
			? { ...original, name, description }
			: {
					id: crypto.randomUUID(),
					organizationId: activeUser.organizationId,
					name,
					description,
					active: true
				};
		const next = original
			? categoryList.map((item) => (item.id === original.id ? category : item))
			: [...categoryList, category];
		if (persistCategories(next)) categoryDraft = null;
	}

	function toggleCategory(id: string) {
		const category = categoryList.find((item) => item.id === id);
		if (!category || !mayManageCategory(category)) return;
		persistCategories(
			categoryList.map((item) => (item.id === id ? { ...item, active: !item.active } : item))
		);
	}

	function isCategoryList(value: unknown): value is IncidentCategory[] {
		if (!Array.isArray(value)) return false;

		const ids = new SvelteSet<string>();

		return value.every((item: unknown) => {
			if (typeof item !== 'object' || item === null) return false;

			const category = item as Record<string, unknown>;

			if (
				typeof category.id !== 'string' ||
				!category.id.trim() ||
				typeof category.name !== 'string' ||
				!category.name.trim() ||
				typeof category.description !== 'string' ||
				typeof category.active !== 'boolean' ||
				(category.organizationId !== undefined && typeof category.organizationId !== 'string')
			) {
				return false;
			}

			if (ids.has(category.id)) return false;

			ids.add(category.id);
			return true;
		});
	}

	onMount(() => {
		try {
			const storedCategories = localStorage.getItem(CATEGORY_STORAGE_KEY);

			if (storedCategories !== null) {
				const parsedCategories: unknown = JSON.parse(storedCategories);

				if (!isCategoryList(parsedCategories)) {
					throw new Error('El catálogo guardado no tiene un formato válido.');
				}

				categoryList = parsedCategories;
			}
		} catch {
			categoryLoadError =
				'No se pudo cargar el catálogo. No se han modificado los datos guardados.';
		} finally {
			categoryLoaded = true;
		}
	});
</script>

<svelte:head>
	<title>Panel | SoporteFlow</title>
	<meta name="description" content="Gestor de incidencias de soporte técnico" />
</svelte:head>

<div class="min-h-screen bg-slate-950 text-white">
	<DemoSessionSelector user={activeUser} onchange={changeDemoUser} />
	<header class="border-b border-slate-800 bg-slate-900">
		<div class="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
			<div>
				<p class="text-xl font-bold">Soporte<span class="text-cyan-400">Flow</span></p>
				<p class="text-xs text-slate-400">Gestión de soporte técnico</p>
			</div>

			{#if canCreate && !incidentLoadError}
				<button
					type="button"
					onclick={() => (isFormOpen = true)}
					class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
				>
					Nueva incidencia
				</button>
			{/if}
		</div>
	</header>

	<main class="mx-auto max-w-7xl px-6 py-10">
		{#if incidentLoadError}<p role="alert" class="mb-6 text-red-400">{incidentLoadError}</p>{/if}
		{#if activeUser.role === 'client'}<p class="mb-6 text-sm text-cyan-300">
				Solo se muestran tus incidencias. Las antiguas sin un cliente vinculado no se incluyen.
			</p>{/if}
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
				<h2 class="text-lg font-semibold">
					{activeUser.role === 'technician'
						? queueOptions.find((option) => option.value === selectedQueue)?.label
						: 'Incidencias recientes'}
				</h2>
				{#if activeUser.role === 'technician'}
					<div class="mt-4 flex flex-wrap gap-2" role="group" aria-label="Cola de trabajo">
						{#each queueOptions as option (option.value)}<button
								type="button"
								aria-pressed={selectedQueue === option.value}
								onclick={() => (selectedQueue = option.value)}
								class={`rounded-lg border px-4 py-2 text-sm font-semibold ${selectedQueue === option.value ? 'border-cyan-400 bg-cyan-500 text-slate-950' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}
								>{option.label}</button
							>{/each}
					</div>
					<p class="mt-3 text-sm text-slate-300" role="status">
						Asignadas a mí: {mineCount} · Sin asignar: {unassignedCount}
					</p>
					<p class="mt-1 text-xs text-slate-400">
						Totales de tu organización, sin aplicar búsqueda ni estado.
					</p>
					{#if selectedQueue === 'mine'}<p class="mt-2 text-sm text-slate-400">
							Primero abiertas y pendientes, después resueltas. En cada grupo: prioridad alta
							primero y las más antiguas antes.
						</p>{/if}
				{/if}

				<p class="text-sm text-slate-400">Aquí aparecerán los últimos casos registrados.</p>

				<div class="mt-4">
					<label for="incident-search" class="mb-2 block text-sm font-medium text-slate-300">
						Buscar incidencias
					</label>

					<input
						id="incident-search"
						type="search"
						bind:value={searchQuery}
						placeholder="Buscar por ID, título o cliente..."
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-500 focus:border-cyan-400"
					/>

					<p class="mt-2 text-xs text-slate-400" role="status">
						Resultados: {filteredIncidents.length} de {currentQueue.length}
					</p>
				</div>

				<div class="mt-4 flex flex-wrap gap-2" role="group" aria-label="Estado de la incidencia">
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
									{#if canEdit}
										<button
											type="button"
											onclick={() => openEditIncident(incident.id)}
											aria-label={`Editar incidencia ${incident.id}: ${incident.title}`}
											class="rounded text-left font-medium text-cyan-400 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-400"
										>
											{incident.title}
										</button>
									{:else}<p class="font-medium">{incident.title}</p>
										<p class="mt-2 text-sm text-slate-400">
											{incident.description ?? 'Sin descripción'}
										</p>
										{#if incident.solution}<p class="mt-1 text-sm text-slate-400">
												Solución: {incident.solution}
											</p>{/if}{/if}
									<p class="mt-1 text-xs text-slate-500">#{incident.id}</p>
									<p class="mt-2 text-sm text-slate-400">Categoría: {categoryName(incident)}</p>
									<p class="mt-2 text-sm text-slate-300">
										{incident.assignedToUserId ? 'Asignado a: ' : ''}{assigneeName(incident)}
									</p>
									{#if assignmentReady && !incidentLoadError && canActOnIncident(activeUser, incident, 'incidents:assign')}
										<div class="mt-2 flex flex-wrap gap-3">
											<button
												type="button"
												onclick={() => openAssignment(incident)}
												class="rounded border border-slate-700 px-3 py-2 text-sm text-cyan-300 hover:bg-slate-800"
												>{incident.assignedToUserId ? 'Reasignar' : 'Asignar'}</button
											>
											{#if activeUser.role === 'technician' && activeUser.id !== incident.assignedToUserId && assignmentCandidates(incident, demoUsers).some((user) => user.id === activeUser.id)}
												<button
													type="button"
													onclick={() => openAssignment(incident, true)}
													class="rounded border border-slate-700 px-3 py-2 text-sm text-cyan-300 hover:bg-slate-800"
													>Asignarme</button
												>
											{/if}
										</div>
									{/if}
								</td>

								<td class="px-6 py-4 text-sm text-slate-400">
									{incident.client}
								</td>

								<td class={`px-6 py-4 text-sm font-medium ${priorityClasses[incident.priority]}`}>
									{priorityLabels[incident.priority]}
								</td>

								<td class="px-6 py-4">
									{#if canEdit}
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
									{:else}<span class="text-sm text-slate-300"
											>{statusFilters.find((filter) => filter.value === incident.status)
												?.label}</span
										>{/if}

									{#if canDelete}
										<button
											type="button"
											onclick={() => deleteIncident(incident.id)}
											class="mt-2 block text-xs font-medium text-red-400 transition hover:text-red-300"
										>
											Eliminar
										</button>
									{/if}
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

		{#if canManageCategories}
			<section
				aria-labelledby="categories-title"
				class="mt-8 rounded-xl border border-slate-800 bg-slate-900 p-6"
			>
				<h2 id="categories-title" class="text-lg font-semibold">Categorías de incidencias</h2>

				<p class="mt-1 text-sm text-slate-400">
					Catálogo de categorías para clasificar los casos de soporte.
				</p>

				{#if categoryLoaded && !categoryLoadError}
					<button
						type="button"
						onclick={() => openCategoryForm()}
						class="mt-4 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400"
						>Nueva categoría</button
					>
				{/if}
				{#if categorySaveError}<p role="alert" class="mt-4 text-sm text-red-400">
						{categorySaveError}
					</p>{/if}
				{#if categoryDraft && categoryLoaded && !categoryLoadError}
					<form
						onsubmit={saveCategory}
						class="mt-4 space-y-4 rounded-lg border border-slate-700 bg-slate-950 p-4"
						aria-labelledby="category-form-title"
					>
						<h3 id="category-form-title" class="font-semibold">
							{categoryDraft.id ? 'Editar categoría' : 'Nueva categoría'}
						</h3>
						<div>
							<label for="category-name" class="mb-2 block text-sm text-slate-300"
								>Nombre (obligatorio)</label
							>
							<input
								id="category-name"
								bind:value={categoryDraft.name}
								required
								class="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-white outline-none focus:border-cyan-400"
							/>
						</div>
						<div>
							<label for="category-description" class="mb-2 block text-sm text-slate-300"
								>Descripción (opcional)</label
							>
							<textarea
								id="category-description"
								bind:value={categoryDraft.description}
								rows="3"
								class="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-white outline-none focus:border-cyan-400"
							></textarea>
						</div>
						<div class="flex gap-3">
							<button
								type="submit"
								class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400"
								>Guardar categoría</button
							>
							<button
								type="button"
								onclick={() => {
									categoryDraft = null;
									categorySaveError = '';
								}}
								class="rounded-lg px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
								>Cancelar</button
							>
						</div>
					</form>
				{/if}
				{#if categoryLoadError}
					<p role="alert" class="mt-4 text-sm text-red-400">
						{categoryLoadError}
					</p>
				{:else}
					<ul class="mt-5 grid gap-3 sm:grid-cols-2">
						{#each visibleCategories as category (category.id)}
							<li class="rounded-lg border border-slate-700 bg-slate-950 p-4">
								<div class="flex items-center justify-between gap-3">
									<h3 class="font-medium text-slate-200">{category.name}</h3>

									<span
										class={`text-xs ${category.active ? 'text-emerald-400' : 'text-slate-500'}`}
									>
										{category.active ? 'Activa' : 'Inactiva'}
									</span>
								</div>

								<p class="mt-2 text-sm text-slate-400">
									{category.description}
								</p>
								{#if categoryLoaded}
									<div class="mt-4 flex flex-wrap gap-3">
										<button
											type="button"
											onclick={() => openCategoryForm(category.id)}
											aria-label={`Editar categoría ${category.name}`}
											class="rounded-lg border border-slate-700 px-3 py-2 text-sm text-cyan-400 hover:bg-slate-800"
											>Editar</button
										>
										<button
											type="button"
											onclick={() => toggleCategory(category.id)}
											aria-label={`${category.active ? 'Desactivar' : 'Reactivar'} categoría ${category.name}`}
											class="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
											>{category.active ? 'Desactivar' : 'Reactivar'}</button
										>
									</div>
								{/if}
							</li>
						{:else}
							<li class="text-sm text-slate-400">Todavía no hay categorías configuradas.</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	</main>

	{#if assignmentIncident && assignmentReady && !incidentLoadError && canActOnIncident(activeUser, assignmentIncident, 'incidents:assign')}
		<AssignmentDialog
			actor={activeUser}
			incident={assignmentIncident}
			candidates={assignmentCandidates(assignmentIncident, demoUsers)}
			currentName={assigneeName(assignmentIncident)}
			initialTarget={assignmentTarget}
			error={assignmentError}
			onconfirm={confirmAssignment}
			oncancel={() => {
				assignmentIncident = null;
				assignmentError = '';
			}}
		/>
	{/if}
	{#if isFormOpen && canCreate && !incidentLoadError}
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
					<label for="title" class="mb-2 block text-sm font-medium text-slate-300">Título</label>
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
						disabled={activeUser.role === 'client'}
						placeholder={activeUser.role === 'client' ? activeUser.name : 'Nombre del cliente'}
						required
						class="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-600 focus:border-cyan-400"
					/>
				</div>

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

	{#if editingIncident && canEdit}
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
					<label for="edit-description" class="mb-2 block text-sm font-medium text-slate-300">
						Descripción del problema (obligatoria)
					</label>
					<textarea
						id="edit-description"
						bind:value={editingIncident.description}
						required
						rows="3"
						placeholder="¿Qué ocurre, desde cuándo y a quién afecta?"
						class="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-500 focus:border-cyan-400"
					></textarea>
				</div>

				<div class="grid gap-5 sm:grid-cols-2">
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
				</div>

				<div>
					<label for="edit-solution" class="mb-2 block text-sm font-medium text-slate-300">
						Solución aplicada
						{editingIncident.status === 'resolved' ? '(obligatoria)' : '(opcional)'}
					</label>
					<textarea
						id="edit-solution"
						bind:value={editingIncident.solution}
						required={editingIncident.status === 'resolved'}
						aria-describedby="edit-solution-help"
						rows="3"
						placeholder="Describe las acciones realizadas y el resultado."
						class="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none placeholder:text-slate-500 focus:border-cyan-400"
					></textarea>
					<p id="edit-solution-help" class="mt-2 text-xs text-slate-400">
						Para marcar la incidencia como resuelta debes documentar la solución. No incluyas
						contraseñas ni credenciales.
					</p>
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
			<IncidentTimeline
				incident={editingIncident}
				viewer={activeUser}
				entries={history}
				users={demoUsers}
				categories={categoryList}
				teams={demoSupportTeams}
			/>
		</dialog>
	{/if}
</div>

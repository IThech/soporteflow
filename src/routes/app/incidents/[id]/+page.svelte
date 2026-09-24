<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/stores';
	import { getMe, AuthApiError } from '$lib/api/auth';
	import {
		getIncident,
		updateIncident,
		listAssignees,
		assignIncident,
		IncidentApiError,
		type IncidentListItem,
		type IncidentAssignee
	} from '$lib/api/incidents';
	import { session } from '$lib/stores/session';
	import RealIncidentDetail from '$lib/components/incidents/RealIncidentDetail.svelte';
	import RealIncidentEditForm from '$lib/components/incidents/RealIncidentEditForm.svelte';
	import RealIncidentAssignForm from '$lib/components/incidents/RealIncidentAssignForm.svelte';

	let sessionLoading = $state(!$session.isAuthenticated);
	let incident = $state<IncidentListItem | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let isEditing = $state(false);
	let submitting = $state(false);
	let updateError = $state<string | null>(null);
	let editAbortController: AbortController | null = null;

	let isAssigning = $state(false);
	let assignees = $state<IncidentAssignee[]>([]);
	let assigneesLoading = $state(false);
	let assignmentSubmitting = $state(false);
	let assignmentError = $state<string | null>(null);
	let assignAbortController: AbortController | null = null;

	let detailRequestId = 0;
	let detailAbortController: AbortController | null = null;

	onMount(async () => {
		if (!$session.isAuthenticated) {
			sessionLoading = true;
			try {
				const context = await getMe();
				session.setSession(context);
			} catch (err) {
				if (err instanceof AuthApiError && err.status === 401) {
					session.clearSession();
					await goto(resolve('/login?expired=true'));
					return;
				}
				session.setError(
					err instanceof AuthApiError ? err.message : 'Error al conectar con el servidor.'
				);
			} finally {
				sessionLoading = false;
			}
		}

		// Re-validate and sync activeOrganization with URL organizationId
		const orgIdParam = $page.url.searchParams.get('organizationId');
		if (!orgIdParam || !$session.organizations.some((org) => org.id === orgIdParam)) {
			// Unauthorized or missing organizationId -> navigate to /app
			await goto(resolve('/app'));
			return;
		}

		session.setActiveOrganization(orgIdParam);
	});

	$effect(() => {
		const isAuth = $session.isAuthenticated;
		const currentOrg = $session.activeOrganization;
		const currentUserId = $session.user?.id;
		const targetIncidentId = $page.params.id;
		const targetOrgId = $page.url.searchParams.get('organizationId');

		detailRequestId += 1;
		const thisRequestId = detailRequestId;

		if (detailAbortController) {
			detailAbortController.abort();
			detailAbortController = null;
		}

		// Wait until session is ready and targetOrgId matches active organization
		if (
			!isAuth ||
			!currentOrg ||
			!targetOrgId ||
			currentOrg.id !== targetOrgId ||
			!targetIncidentId
		) {
			incident = null;
			loading = false;
			error = null;
			return;
		}

		incident = null;
		error = null;
		loading = true;

		const controller = new AbortController();
		detailAbortController = controller;

		(async () => {
			try {
				const data = await getIncident(targetOrgId, targetIncidentId, {
					signal: controller.signal
				});

				if (
					thisRequestId !== detailRequestId ||
					$session.activeOrganization?.id !== targetOrgId ||
					$session.user?.id !== currentUserId ||
					$page.params.id !== targetIncidentId
				) {
					return;
				}

				incident = data;
				error = null;
			} catch (err: unknown) {
				if (
					thisRequestId !== detailRequestId ||
					$session.activeOrganization?.id !== targetOrgId ||
					$session.user?.id !== currentUserId ||
					$page.params.id !== targetIncidentId
				) {
					return;
				}

				if ((err as Error)?.name === 'AbortError' || controller.signal.aborted) {
					return;
				}

				if (err instanceof IncidentApiError && err.status === 401) {
					session.clearSession();
					incident = null;
					error = null;
					loading = false;
					await goto(resolve('/login?expired=true'));
					return;
				}

				if (err instanceof IncidentApiError) {
					if (err.status === 403) {
						error = 'No tienes permisos para consultar esta incidencia.';
					} else if (err.status === 404) {
						error = 'La incidencia no está disponible.';
					} else {
						error = err.message;
					}
				} else {
					error = 'No se pudo cargar la incidencia. Inténtalo de nuevo.';
				}
			} finally {
				if (
					thisRequestId === detailRequestId &&
					$session.activeOrganization?.id === targetOrgId &&
					$session.user?.id === currentUserId &&
					$page.params.id === targetIncidentId
				) {
					loading = false;
				}
			}
		})();

		return () => {
			controller.abort();
		};
	});

	onDestroy(() => {
		if (editAbortController) {
			editAbortController.abort();
		}
		if (assignAbortController) {
			assignAbortController.abort();
		}
	});

	async function handleSaveEdit(changes: {
		status?: 'open' | 'pending' | 'resolved' | 'closed';
		priority?: 'low' | 'medium' | 'high' | 'urgent';
	}) {
		if (submitting || !incident) return;
		const targetOrgId = $session.activeOrganization?.id;
		if (!targetOrgId) return;

		submitting = true;
		updateError = null;

		if (editAbortController) {
			editAbortController.abort();
		}
		const controller = new AbortController();
		editAbortController = controller;

		try {
			const updated = await updateIncident(targetOrgId, incident.id, changes, {
				signal: controller.signal
			});
			incident = updated;
			isEditing = false;
			updateError = null;
		} catch (err: unknown) {
			if ((err as Error)?.name === 'AbortError' || controller.signal.aborted) {
				return;
			}

			if (err instanceof IncidentApiError && err.status === 401) {
				session.clearSession();
				await goto(resolve('/login?expired=true'));
				return;
			}

			if (err instanceof IncidentApiError) {
				updateError = err.message;
			} else {
				updateError = 'No se pudo actualizar la incidencia. Inténtalo de nuevo.';
			}
		} finally {
			submitting = false;
		}
	}

	function handleCancelEdit() {
		if (submitting) return;
		isEditing = false;
		updateError = null;
	}

	async function handleOpenAssign() {
		if (assignmentSubmitting) return;
		isEditing = false;
		isAssigning = true;
		assignmentError = null;

		const targetOrgId = $session.activeOrganization?.id;
		if (!targetOrgId) return;

		// Load assignees on demand if not cached yet
		if (assignees.length === 0) {
			assigneesLoading = true;
			try {
				const list = await listAssignees(targetOrgId);
				assignees = list;
			} catch (err: unknown) {
				if (err instanceof IncidentApiError && err.status === 401) {
					session.clearSession();
					await goto(resolve('/login?expired=true'));
					return;
				}
				if (err instanceof IncidentApiError) {
					if (err.status === 403) {
						assignmentError = 'No tienes permisos para asignar incidencias.';
					} else {
						assignmentError = err.message;
					}
				} else {
					assignmentError = 'No se pudieron cargar los técnicos disponibles.';
				}
			} finally {
				assigneesLoading = false;
			}
		}
	}

	async function handleSaveAssign(data: { assignedToUserId: string; reason?: string }) {
		if (assignmentSubmitting || !incident) return;
		const targetOrgId = $session.activeOrganization?.id;
		if (!targetOrgId) return;

		assignmentSubmitting = true;
		assignmentError = null;

		if (assignAbortController) {
			assignAbortController.abort();
		}
		const controller = new AbortController();
		assignAbortController = controller;

		try {
			const updated = await assignIncident(targetOrgId, incident.id, data, {
				signal: controller.signal
			});

			// Resolve readable technician name from assignees catalog if not returned in response
			const techName =
				updated.assignedToUserName ??
				assignees.find((a) => a.id === updated.assignedToUserId)?.name ??
				null;

			incident = {
				...updated,
				assignedToUserName: techName
			};
			isAssigning = false;
			assignmentError = null;
		} catch (err: unknown) {
			if ((err as Error)?.name === 'AbortError' || controller.signal.aborted) {
				return;
			}

			if (err instanceof IncidentApiError && err.status === 401) {
				session.clearSession();
				await goto(resolve('/login?expired=true'));
				return;
			}

			if (err instanceof IncidentApiError) {
				if (err.status === 403) {
					assignmentError = 'No tienes permisos para asignar esta incidencia.';
				} else if (err.status === 404) {
					assignmentError = 'No se pudo realizar la asignación.';
				} else {
					assignmentError = err.message;
				}
			} else {
				assignmentError = 'No se pudo asignar la incidencia. Inténtalo de nuevo.';
			}
		} finally {
			assignmentSubmitting = false;
		}
	}

	function handleCancelAssign() {
		if (assignmentSubmitting) return;
		isAssigning = false;
		assignmentError = null;
	}
</script>

<div class="min-h-screen bg-slate-950 text-slate-100 antialiased">
	<!-- Autonomous minimal header -->
	<header class="border-b border-slate-800 bg-slate-900/80 px-4 py-4 backdrop-blur sm:px-6 lg:px-8">
		<div class="mx-auto flex max-w-5xl items-center justify-between">
			<div class="flex items-center space-x-3">
				<span class="text-lg font-bold tracking-tight text-white">SoporteFlow</span>
				<span
					class="rounded-full border border-slate-700 bg-slate-800 px-2.5 py-0.5 text-xs text-slate-300"
				>
					Datos reales
				</span>
			</div>
			{#if $session.activeOrganization}
				<div class="text-xs text-slate-400">
					Organización: <span class="font-medium text-slate-200"
						>{$session.activeOrganization.name}</span
					>
				</div>
			{/if}
		</div>
	</header>

	<main class="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
		<!-- Back to incidents link -->
		<div class="mb-6">
			<a
				href={resolve('/app')}
				class="inline-flex items-center text-sm font-medium text-cyan-400 transition-colors hover:text-cyan-300"
			>
				&larr; Volver a incidencias
			</a>
		</div>

		{#if sessionLoading}
			<div
				class="flex items-center justify-center p-12 text-center"
				role="status"
				aria-live="polite"
			>
				<span class="text-sm font-medium text-slate-400">Verificando sesión...</span>
			</div>
		{:else if isEditing && incident}
			<RealIncidentEditForm
				{incident}
				{submitting}
				error={updateError}
				onSave={handleSaveEdit}
				onCancel={handleCancelEdit}
			/>
		{:else if isAssigning && incident}
			<RealIncidentAssignForm
				currentAssigneeUserId={incident.assignedToUserId}
				currentAssigneeUserName={incident.assignedToUserName}
				{assignees}
				loading={assigneesLoading}
				submitting={assignmentSubmitting}
				error={assignmentError}
				onSave={handleSaveAssign}
				onCancel={handleCancelAssign}
			/>
		{:else}
			<RealIncidentDetail
				{incident}
				{loading}
				{error}
				onEdit={() => {
					isEditing = true;
					isAssigning = false;
					updateError = null;
				}}
				onAssign={handleOpenAssign}
			/>
		{/if}
	</main>
</div>

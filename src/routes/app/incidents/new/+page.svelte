<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/stores';
	import { getMe, AuthApiError } from '$lib/api/auth';
	import { createIncident, IncidentApiError, type CreateIncidentInput } from '$lib/api/incidents';
	import { session } from '$lib/stores/session';
	import RealIncidentCreateForm from '$lib/components/incidents/RealIncidentCreateForm.svelte';

	let sessionLoading = $state(!$session.isAuthenticated);
	let submitting = $state(false);
	let error = $state<string | null>(null);

	let abortController: AbortController | null = null;

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

		const orgIdParam = $page.url.searchParams.get('organizationId');
		if (!orgIdParam || !$session.organizations.some((org) => org.id === orgIdParam)) {
			await goto(resolve('/app'));
			return;
		}

		session.setActiveOrganization(orgIdParam);
	});

	onDestroy(() => {
		if (abortController) {
			abortController.abort();
			abortController = null;
		}
	});

	async function handleCreate(input: CreateIncidentInput) {
		if (submitting) return;

		const orgIdParam = $page.url.searchParams.get('organizationId');
		if (!orgIdParam || !$session.organizations.some((org) => org.id === orgIdParam)) {
			await goto(resolve('/app'));
			return;
		}

		submitting = true;
		error = null;

		if (abortController) {
			abortController.abort();
		}
		const controller = new AbortController();
		abortController = controller;

		try {
			const incident = await createIncident(orgIdParam, input, {
				signal: controller.signal
			});

			await goto(
				resolve(
					`/app/incidents/${encodeURIComponent(incident.id)}?organizationId=${encodeURIComponent(incident.organizationId)}`
				)
			);
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
					error = 'No tienes permisos para crear incidencias en esta organización.';
				} else {
					error = err.message;
				}
			} else {
				error = 'No se pudo crear la incidencia. Inténtalo de nuevo.';
			}
		} finally {
			submitting = false;
		}
	}
</script>

<div class="min-h-screen bg-slate-950 text-slate-100 antialiased">
	<!-- Autonomous minimal header -->
	<header class="border-b border-slate-800 bg-slate-900/80 px-4 py-4 backdrop-blur sm:px-6 lg:px-8">
		<div class="mx-auto flex max-w-3xl items-center justify-between">
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

	<main class="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
		<!-- Back to incidents link -->
		<div class="mb-6">
			<a
				href={resolve('/app')}
				class="inline-flex items-center text-sm font-medium text-cyan-400 transition-colors hover:text-cyan-300"
			>
				&larr; Volver a incidencias
			</a>
		</div>

		<div class="mb-6">
			<h1 class="text-xl font-bold tracking-tight text-white">Nueva incidencia</h1>
			<p class="mt-1 text-sm text-slate-400">
				Crea una nueva incidencia real registrada en PostgreSQL.
			</p>
		</div>

		{#if sessionLoading}
			<div
				class="flex items-center justify-center p-12 text-center"
				role="status"
				aria-live="polite"
			>
				<span class="text-sm font-medium text-slate-400">Verificando sesión...</span>
			</div>
		{:else}
			<RealIncidentCreateForm {submitting} {error} onsubmit={handleCreate} />
		{/if}
	</main>
</div>

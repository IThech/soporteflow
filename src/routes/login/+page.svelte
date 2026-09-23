<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/stores';
	import { signIn, signOut, getMe, AuthApiError } from '$lib/api/auth';
	import { session } from '$lib/stores/session';

	let email = $state('');
	let password = $state('');
	let loading = $state(false);
	let errorMessage = $state('');

	const isExpired = $derived($page.url.searchParams.get('expired') === 'true');
	const hasNoOrg = $derived($page.url.searchParams.get('no_org') === 'true');

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		errorMessage = '';
		const trimmedEmail = email.trim();
		if (!trimmedEmail || !password) {
			errorMessage = 'Por favor, completa todos los campos.';
			return;
		}

		// Clear previous selection only when starting a new credential attempt.
		session.clearSession();
		loading = true;
		session.setLoading(true);

		try {
			// 1. Authenticate with credentials against Better Auth
			await signIn({ email: trimmedEmail, password });

			// 2. Fetch authenticated identity and active organizations
			const context = await getMe();

			// 3. Handle organization membership requirement
			if (context.organizations.length === 0) {
				try {
					await signOut();
				} catch {
					// Fallback if signOut encounters network issue
				} finally {
					session.clearSession();
				}
				errorMessage =
					'Tu cuenta no tiene ninguna organización activa asignada. Contacta con tu administrador.';
				return;
			}

			// 4. Populate in-memory session store
			session.setSession(context);

			// 5. Navigate to /app if at least 1 active organization exists
			await goto(resolve('/app'));
		} catch (err) {
			if (err instanceof AuthApiError) {
				errorMessage = err.message;
			} else {
				errorMessage = 'No se pudo conectar con el servidor.';
			}
			session.setError(errorMessage);
		} finally {
			loading = false;
			session.setLoading(false);
		}
	}
</script>

<svelte:head>
	<title>Iniciar sesión | SoporteFlow</title>
	<meta
		name="description"
		content="Inicia sesión en SoporteFlow para gestionar tu soporte técnico."
	/>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-12 text-white">
	<div
		class="w-full max-w-md space-y-8 rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-xl"
	>
		<div class="text-center">
			<a href={resolve('/')} class="text-2xl font-bold tracking-tight text-white">
				Soporte<span class="text-cyan-400">Flow</span>
			</a>
			<h1 class="mt-4 text-xl font-semibold text-slate-100">Iniciar sesión</h1>
			<p class="mt-1 text-sm text-slate-400">Accede a tu panel de soporte técnico</p>
		</div>

		{#if isExpired}
			<div
				role="status"
				class="rounded-lg border border-amber-500/40 bg-amber-950/50 p-3 text-sm text-amber-300"
			>
				Tu sesión ha expirado o no es válida. Por favor, inicia sesión de nuevo.
			</div>
		{/if}

		{#if hasNoOrg}
			<div
				role="status"
				class="rounded-lg border border-amber-500/40 bg-amber-950/50 p-3 text-sm text-amber-300"
			>
				Tu cuenta no tiene ninguna organización activa asignada. Contacta con tu administrador.
			</div>
		{/if}

		<form onsubmit={handleSubmit} class="space-y-5">
			<div>
				<label for="email" class="block text-sm font-medium text-slate-300">
					Correo electrónico
				</label>
				<input
					id="email"
					name="email"
					type="email"
					autocomplete="username"
					required
					bind:value={email}
					disabled={loading}
					placeholder="nombre@empresa.com"
					class="mt-1.5 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-white placeholder-slate-500 transition focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 focus:outline-hidden disabled:opacity-50"
				/>
			</div>

			<div>
				<label for="password" class="block text-sm font-medium text-slate-300"> Contraseña </label>
				<input
					id="password"
					name="password"
					type="password"
					autocomplete="current-password"
					required
					bind:value={password}
					disabled={loading}
					class="mt-1.5 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-white placeholder-slate-500 transition focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 focus:outline-hidden disabled:opacity-50"
				/>
			</div>

			{#if errorMessage}
				<div
					role="alert"
					aria-live="polite"
					class="rounded-lg border border-red-500/40 bg-red-950/50 p-3 text-sm text-red-300"
				>
					{errorMessage}
				</div>
			{/if}

			<button
				type="submit"
				disabled={loading}
				aria-busy={loading}
				class="w-full rounded-lg bg-cyan-500 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{#if loading}
					Iniciando sesión...
				{:else}
					Iniciar sesión
				{/if}
			</button>
		</form>

		<div class="pt-2 text-center">
			<a href={resolve('/')} class="text-xs text-slate-400 transition hover:text-cyan-400">
				← Volver al inicio
			</a>
		</div>
	</div>
</div>

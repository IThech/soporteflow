<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { signOut } from '$lib/api/auth';
	import { attemptSignOut, SESSION_EXPIRED_PATH, SIGN_OUT_FAILED_MESSAGE } from '$lib/app/sign-out';
	import { navigationModel } from '$lib/app/capabilities';
	import { useOrganizationContext } from '$lib/app/context';
	import { session } from '$lib/stores/session';
	import AppShell from '$lib/components/shell/AppShell.svelte';
	import OrganizationGate from '$lib/components/shell/OrganizationGate.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';

	/**
	 * /app entry (UI-2A, C1). No invented dashboard: once the organization context is valid and
	 * the user can read incidents, it redirects to /app/incidents preserving organizationId.
	 * Otherwise it shows the exact organization state (selection, invalid link, no access).
	 * The legacy demo lives, isolated, at /app/demo and is not linked from here.
	 */
	const context = useOrganizationContext();
	const explicitOrganization = $derived(page.url.searchParams.get('organizationId'));
	let signingOut = $state(false);
	let signOutError = $state<string | null>(null);

	$effect(() => {
		void context.load(explicitOrganization);
	});

	$effect(() => {
		const state = $context;
		if (state.status === 'unauthenticated') {
			session.clearSession();
			void goto(resolve(SESSION_EXPIRED_PATH));
			return;
		}
		if (
			state.status === 'ready' &&
			state.activeOrganizationId &&
			navigationModel(state.capabilities).incidents
		)
			void goto(
				resolve(`/app/incidents?organizationId=${encodeURIComponent(state.activeOrganizationId)}`),
				{ replaceState: true }
			);
	});

	function changeOrganization(id: string) {
		void goto(resolve(`/app/incidents?organizationId=${encodeURIComponent(id)}`));
	}
	async function leave() {
		signOutError = null;
		signingOut = true;
		// A 401 (session already gone) counts as signed out; any other failure keeps the session.
		const result = await attemptSignOut(() => signOut());
		signingOut = false;
		if (!result.ok) {
			signOutError = SIGN_OUT_FAILED_MESSAGE;
			return;
		}
		session.clearSession();
		await goto(resolve('/login'));
	}
</script>

<svelte:head><title>SoporteFlow</title></svelte:head>

<AppShell
	context={$context}
	title="Inicio"
	{signingOut}
	{signOutError}
	onOrganizationChange={changeOrganization}
	onSignOut={leave}
>
	<PageHeader
		eyebrow={$context.status === 'ready' ? $context.activeOrganization?.name : null}
		title="Inicio"
	/>
	<OrganizationGate context={$context} onretry={() => void context.load(explicitOrganization)}>
		<EmptyState
			title="Sin acceso a incidencias"
			description="Tus permisos en esta organización no incluyen la consulta de incidencias."
		/>
	</OrganizationGate>
</AppShell>

<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { signOut } from '$lib/api/auth';
	import { useOrganizationContext } from '$lib/app/context';
	import { attemptSignOut, SESSION_EXPIRED_PATH, SIGN_OUT_FAILED_MESSAGE } from '$lib/app/sign-out';
	import { session } from '$lib/stores/session';
	import AppShell from '$lib/components/shell/AppShell.svelte';
	import OrganizationGate from '$lib/components/shell/OrganizationGate.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';

	const context = useOrganizationContext();
	const explicitOrganization = $derived(page.url.searchParams.get('organizationId'));

	let signingOut = $state(false);
	let signOutError = $state<string | null>(null);

	const ready = $derived($context.status === 'ready');
	const capabilities = $derived(ready ? $context.capabilities : []);
	const activeOrg = $derived(ready ? $context.activeOrganization : null);
	const canManage = $derived(
		capabilities.includes('clients:manage') ||
			capabilities.includes('sites:manage') ||
			capabilities.includes('categories:manage')
	);

	function expireSession() {
		session.clearSession();
		void goto(resolve(SESSION_EXPIRED_PATH));
	}

	$effect(() => {
		const explicit = explicitOrganization;
		untrack(() => {
			const current = context.get();
			if (explicit && current.status === 'ready' && current.activeOrganizationId === explicit)
				return;
			void context.load(explicit);
		});
	});

	$effect(() => {
		if ($context.status === 'unauthenticated') {
			expireSession();
		}
	});

	function changeOrganization(id: string) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(resolve('/app/admin') + `?organizationId=${encodeURIComponent(id)}`);
	}

	async function leave() {
		if (signingOut) return;
		signOutError = null;
		signingOut = true;
		const result = await attemptSignOut(() => signOut());
		signingOut = false;
		if (!result.ok) {
			signOutError = SIGN_OUT_FAILED_MESSAGE;
			return;
		}
		session.clearSession();
		await goto(resolve('/login'));
	}

	const clientsHref = $derived(
		activeOrg
			? `${resolve('/app/admin/clients')}?organizationId=${encodeURIComponent(activeOrg.id)}`
			: resolve('/app/admin/clients')
	);

	const sitesHref = $derived(
		activeOrg
			? `${resolve('/app/admin/sites')}?organizationId=${encodeURIComponent(activeOrg.id)}`
			: resolve('/app/admin/sites')
	);

	const categoriesHref = $derived(
		activeOrg
			? `${resolve('/app/admin/categories')}?organizationId=${encodeURIComponent(activeOrg.id)}`
			: resolve('/app/admin/categories')
	);

	interface AdminModule {
		title: string;
		description: string;
		active: boolean;
		href?: string;
		actionLabel?: string;
	}

	const modules: readonly AdminModule[] = $derived([
		{
			title: 'Clientes',
			description:
				'Gestión del catálogo de empresas, cuentas y clientes atendidos por la organización.',
			active: true,
			href: clientsHref,
			actionLabel: 'Gestionar clientes'
		},
		{
			title: 'Sedes',
			description:
				'Ubicaciones físicas, centros de trabajo y delegaciones asociadas a las incidencias.',
			active: true,
			href: sitesHref,
			actionLabel: 'Gestionar sedes'
		},
		{
			title: 'Usuarios y miembros',
			description: 'Control de accesos, gestión de miembros e invitaciones a la organización.',
			active: false
		},
		{
			title: 'Roles y permisos',
			description:
				'Definición de plantillas de roles del sistema y asignación de capacidades de seguridad.',
			active: false
		},
		{
			title: 'Categorías',
			description: 'Taxonomía de soporte, árbol de subcategorías y clasificación de incidencias.',
			active: true,
			href: categoriesHref,
			actionLabel: 'Gestionar categorías'
		},
		{
			title: 'Políticas SLA',
			description:
				'Acuerdos de nivel de servicio, tiempos máximos de primera respuesta y resolución.',
			active: false
		},
		{
			title: 'Webhooks',
			description:
				'Suscripciones a eventos de la organización para integración y automatización externa.',
			active: false
		},
		{
			title: 'Preferencias de organización',
			description:
				'Identidad visual, ajustes generales y parámetros operativos de la organización.',
			active: false
		}
	]);
</script>

<svelte:head>
	<title>Administración · SoporteFlow</title>
</svelte:head>

<!-- eslint-disable svelte/no-navigation-without-resolve -- hrefs are built from resolve() -->
<AppShell
	context={$context}
	title="Administración"
	current="admin"
	{signingOut}
	{signOutError}
	onOrganizationChange={changeOrganization}
	onSignOut={leave}
>
	<OrganizationGate context={$context} onretry={() => void context.load(explicitOrganization)}>
		<div class="sf-admin-hub">
			<PageHeader
				title="Administración"
				description="Centro de control, configuración y catálogos de {activeOrg?.name ??
					'la organización'}."
			/>

			{#if !canManage}
				<div class="sf-guard-box">
					<EmptyState
						title="Acceso restringido"
						description="No dispones de permisos de administración en esta organización."
					/>
				</div>
			{:else}
				<div class="sf-modules-grid">
					{#each modules as mod (mod.title)}
						<article class="sf-module-card" class:sf-module-card-disabled={!mod.active}>
							<div class="sf-card-header">
								<div class="sf-card-icon" aria-hidden="true">
									<Icon name="building" size={20} />
								</div>
								{#if mod.active}
									<Badge tone="success">Activo</Badge>
								{:else}
									<Badge tone="neutral">Próximamente</Badge>
								{/if}
							</div>
							<div class="sf-card-body">
								<h2 class="sf-card-title">{mod.title}</h2>
								<p class="sf-card-description">{mod.description}</p>
							</div>
							<div class="sf-card-footer">
								{#if mod.active && mod.href}
									<Button variant="secondary" size="sm" href={mod.href}>
										{mod.actionLabel ?? 'Acceder'}
									</Button>
								{:else}
									<span class="sf-card-inactive-label">No disponible</span>
								{/if}
							</div>
						</article>
					{/each}
				</div>
			{/if}
		</div>
	</OrganizationGate>
</AppShell>

<style>
	.sf-admin-hub {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}

	.sf-guard-box {
		width: 100%;
	}

	.sf-modules-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		/* every row as tall as the tallest card: footers line up across the whole grid */
		grid-auto-rows: 1fr;
		gap: var(--space-4);
	}

	.sf-module-card {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		padding: var(--space-5);
		background: var(--surface-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		box-shadow: var(--sf-shadow-card);
		transition:
			border-color var(--duration) var(--ease),
			box-shadow var(--duration) var(--ease);
	}

	.sf-module-card:not(.sf-module-card-disabled):hover {
		border-color: var(--sf-cyan-500);
		box-shadow: 0 4px 12px rgba(6, 182, 212, 0.08);
	}

	.sf-module-card-disabled {
		opacity: 0.65;
		background: var(--surface-muted);
	}

	.sf-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: var(--space-3);
	}

	.sf-card-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius);
		background: var(--surface-subtle);
		color: var(--text);
	}

	.sf-card-body {
		flex: 1;
		margin-bottom: var(--space-4);
	}

	.sf-card-title {
		font-size: var(--text-base);
		font-weight: 600;
		color: var(--text-emphasis);
		margin: 0 0 var(--space-1-5);
	}

	.sf-card-description {
		font-size: var(--text-sm);
		color: var(--text-muted);
		line-height: 1.5;
		margin: 0;
	}

	.sf-card-footer {
		display: flex;
		align-items: center;
		padding-top: var(--space-3);
		border-top: 1px solid var(--border-subtle);
	}

	.sf-card-inactive-label {
		/* same box as the small Button of active cards (min-height 2rem): equal footers */
		display: inline-flex;
		align-items: center;
		min-height: 2rem;
		font-size: var(--text-xs);
		color: var(--text-subtle);
		font-style: italic;
	}
</style>

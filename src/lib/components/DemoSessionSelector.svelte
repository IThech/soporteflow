<script lang="ts">
	import { demoSessionUsers } from '$lib/auth/demo-session';
	import { organizations, demoOrganization } from '$lib/data/organizations';
	import type { AppUser, UserRole } from '$lib/types/user';

	let {
		user,
		users,
		onchange
	}: {
		user: AppUser;
		users?: AppUser[];
		onchange: (user: AppUser) => void;
	} = $props();

	const roles: Record<UserRole, string> = {
		platform_admin: 'Administrador de plataforma',
		organization_admin: 'Administrador de organización',
		technician: 'Técnico',
		client: 'Cliente'
	};

	const organization = $derived(organizations.find((item) => item.id === user.organizationId));

	const selectableUsers = $derived(
		users
			? users.filter(
					(u) =>
						u.active &&
						u.organizationId === (user.organizationId ?? demoOrganization.id) &&
						['organization_admin', 'technician', 'client'].includes(u.role)
				)
			: demoSessionUsers
	);
</script>

<section
	aria-label="Sesión de demostración"
	class="demo-session border-b border-amber-500/30 bg-slate-900 px-6 py-4"
>
	<div class="demo-session-inner mx-auto max-w-7xl">
		<p class="text-sm font-semibold text-amber-300">
			Sesión demo temporal · Sin autenticación real
		</p>
		<label for="demo-user" class="block text-sm text-slate-300">Usuario activo</label>
		<select
			id="demo-user"
			value={user.id}
			onchange={(event) => {
				const selected = selectableUsers.find((item) => item.id === event.currentTarget.value);
				if (selected) onchange(selected);
			}}
			class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white sm:w-auto"
		>
			{#each selectableUsers as option (option.id)}<option value={option.id}>{option.name}</option
				>{/each}
		</select>
		<p class="text-sm text-slate-400">
			{user.name} · {roles[user.role]}{organization ? ` · ${organization.name}` : ''}
		</p>
		<p class="text-xs text-slate-500">
			Al recargar se restablece el administrador. Los cambios en incidencias se conservan en este
			navegador.
		</p>
	</div>
</section>

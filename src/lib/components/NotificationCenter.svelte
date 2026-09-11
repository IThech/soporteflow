<script lang="ts">
	import type { AppUser } from '$lib/types/user';
	import type { Incident } from '$lib/types/incident';
	import type { Notification, DynamicSlaAlert } from '$lib/types/notification';
	import { filterUserNotifications, deriveDynamicSlaAlerts } from '$lib/incidents/notifications';

	let {
		user,
		incidents,
		now = new Date(),
		notifications,
		notificationError = '',
		onopenincident,
		onmarkread,
		onmarkallread
	}: {
		user: AppUser;
		incidents: Incident[];
		now?: Date | string | number;
		notifications: Notification[];
		notificationError?: string;
		onopenincident: (incidentId: number) => void;
		onmarkread: (notificationId: string) => void;
		onmarkallread: () => void;
	} = $props();

	let isOpen = $state(false);
	let warningMessage = $state('');
	let panelElement = $state<HTMLDivElement | null>(null);
	let triggerElement = $state<HTMLButtonElement | null>(null);

	const userNotifications = $derived(filterUserNotifications(user, notifications));
	const unreadCount = $derived(userNotifications.filter((n) => n.readAt === null).length);
	const dynamicAlerts = $derived(deriveDynamicSlaAlerts(user, incidents, now));

	const timeFormatter = new Intl.DateTimeFormat('es-ES', {
		dateStyle: 'short',
		timeStyle: 'short'
	});

	function formatTimestamp(iso: string): string {
		try {
			const parsed = new Date(iso);
			if (isNaN(parsed.getTime())) return iso;
			const diffMinutes = Math.floor((Date.now() - parsed.getTime()) / 60000);
			if (diffMinutes < 1) return 'Ahora mismo';
			if (diffMinutes < 60) return `Hace ${diffMinutes} min`;
			if (diffMinutes < 1440) {
				const hours = Math.floor(diffMinutes / 60);
				return `Hace ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
			}
			return timeFormatter.format(parsed);
		} catch {
			return iso;
		}
	}

	function handleOpen(incidentId: number) {
		const exists = incidents.some((item) => item.id === incidentId);
		if (exists) {
			isOpen = false;
			warningMessage = '';
			onopenincident(incidentId);
		} else {
			warningMessage = `La incidencia #${incidentId} ya no está disponible o ha sido eliminada.`;
		}
	}

	function handlePersistentClick(notification: Notification) {
		if (notification.readAt === null) {
			onmarkread(notification.id);
		}
		handleOpen(notification.incidentId);
	}

	function handleDynamicClick(alert: DynamicSlaAlert) {
		handleOpen(alert.incidentId);
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && isOpen) {
			isOpen = false;
			warningMessage = '';
			triggerElement?.focus();
		}
	}}
	onclick={(event) => {
		if (
			isOpen &&
			event.target instanceof Node &&
			!panelElement?.contains(event.target) &&
			!triggerElement?.contains(event.target)
		) {
			isOpen = false;
			warningMessage = '';
		}
	}}
/>

<div class="notification-center relative inline-block">
	<button
		type="button"
		bind:this={triggerElement}
		class="relative grid h-11 w-11 place-items-center rounded-[0.65rem] border border-slate-700 bg-slate-900 text-slate-300 transition hover:bg-slate-800 hover:text-white focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
		aria-label={unreadCount > 0 ? `Notificaciones (${unreadCount} no leídas)` : 'Notificaciones'}
		aria-expanded={isOpen}
		aria-haspopup="dialog"
		onclick={() => {
			isOpen = !isOpen;
			warningMessage = '';
		}}
	>
		<!-- Bell SVG -->
		<svg
			xmlns="http://www.w3.org/2000/svg"
			class="h-5 w-5"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			stroke-width="2"
			aria-hidden="true"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
			/>
		</svg>

		{#if unreadCount > 0}
			<span
				class="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-500 px-1 text-[10px] font-bold text-slate-950 ring-2 ring-slate-900"
				aria-hidden="true"
			>
				{unreadCount > 99 ? '99+' : unreadCount}
			</span>
		{/if}
	</button>

	{#if isOpen}
		<div
			bind:this={panelElement}
			class="notification-panel absolute right-0 z-50 mt-2 w-80 max-w-[90vw] rounded-xl border border-slate-700 bg-slate-900 shadow-2xl sm:w-96"
			role="dialog"
			aria-label="Centro de notificaciones"
		>
			<header class="flex items-center justify-between border-b border-slate-800 px-4 py-3">
				<div class="flex items-center gap-2">
					<h2 class="text-sm font-semibold text-white">Notificaciones</h2>
					{#if unreadCount > 0}
						<span
							class="rounded-full bg-cyan-500/20 px-2 py-0.5 text-[11px] font-medium text-cyan-300"
						>
							{unreadCount} nueva{unreadCount === 1 ? '' : 's'}
						</span>
					{/if}
				</div>
				{#if unreadCount > 0}
					<button
						type="button"
						onclick={onmarkallread}
						class="text-xs font-medium text-cyan-400 transition hover:text-cyan-300"
					>
						Marcar todas como leídas
					</button>
				{/if}
			</header>

			{#if notificationError}
				<div
					role="alert"
					class="border-b border-slate-800 bg-red-950/40 px-4 py-2.5 text-xs text-red-300"
				>
					{notificationError}
				</div>
			{/if}

			{#if warningMessage}
				<div
					role="alert"
					class="border-b border-slate-800 bg-amber-950/50 px-4 py-2.5 text-xs text-amber-300"
				>
					{warningMessage}
				</div>
			{/if}

			<div class="max-h-[60vh] divide-y divide-slate-800 overflow-y-auto">
				<!-- Dynamic SLA Alerts Section -->
				{#if dynamicAlerts.length > 0}
					<div class="space-y-2 bg-slate-950/40 p-2">
						{#each dynamicAlerts as alert (alert.id)}
							{@const isBreached = alert.stage === 'breached'}
							<button
								type="button"
								onclick={() => handleDynamicClick(alert)}
								class="w-full rounded-lg border p-3 text-left transition {isBreached
									? 'border-red-500/30 bg-red-950/20 text-red-200 hover:bg-red-950/30'
									: 'border-amber-500/30 bg-amber-950/20 text-amber-200 hover:bg-amber-950/30'}"
							>
								<div class="flex items-center justify-between gap-2">
									<span
										class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase {isBreached
											? 'bg-red-500/20 text-red-400'
											: 'bg-amber-500/20 text-amber-400'}"
									>
										{isBreached ? 'SLA incumplido' : 'SLA próximo a vencer'}
									</span>
									<span class="text-xs font-semibold text-slate-400">#{alert.incidentId}</span>
								</div>
								<p class="mt-1.5 text-xs font-medium text-slate-200">
									{alert.message}
								</p>
							</button>
						{/each}
					</div>
				{/if}

				<!-- Persistent Notifications List -->
				{#if userNotifications.length > 0}
					<ul class="divide-y divide-slate-800" aria-label="Lista de notificaciones">
						{#each userNotifications as notification (notification.id)}
							{@const isUnread = notification.readAt === null}
							<li>
								<button
									type="button"
									onclick={() => handlePersistentClick(notification)}
									class="flex w-full items-start gap-3 p-3 text-left transition hover:bg-slate-800/60 {isUnread
										? 'bg-slate-850/50'
										: 'opacity-75'}"
								>
									<div class="mt-1 flex-shrink-0">
										{#if isUnread}
											<span
												class="block h-2 w-2 rounded-full bg-cyan-400 shadow-sm shadow-cyan-400"
												aria-label="No leída"
											></span>
										{:else}
											<span class="block h-2 w-2 rounded-full bg-transparent" aria-hidden="true"
											></span>
										{/if}
									</div>
									<div class="min-w-0 flex-1">
										<div class="flex items-baseline justify-between gap-2">
											<p
												class="truncate text-xs font-semibold {isUnread
													? 'text-white'
													: 'text-slate-300'}"
											>
												{notification.title}
											</p>
											<time
												datetime={notification.createdAt}
												class="text-[10px] whitespace-nowrap text-slate-400"
											>
												{formatTimestamp(notification.createdAt)}
											</time>
										</div>
										<p class="mt-0.5 line-clamp-2 text-xs text-slate-400">
											{notification.message}
										</p>
									</div>
								</button>
							</li>
						{/each}
					</ul>
				{:else if dynamicAlerts.length === 0}
					<div class="p-6 text-center text-xs text-slate-400">
						No tienes notificaciones pendientes.
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

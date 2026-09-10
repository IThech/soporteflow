<script lang="ts">
	import { onMount } from 'svelte';
	import IncidentTimeline from './IncidentTimeline.svelte';
	import {
		canUseMessages,
		visibleMessages,
		createMessage,
		messageAuthor
	} from '$lib/incidents/messages';
	import { loadMessages, MESSAGES_KEY } from '$lib/storage/messages';
	import type { IncidentMessage, IncidentMessageVisibility } from '$lib/types/incident-message';
	import type { Incident } from '$lib/types/incident';
	import type { AppUser } from '$lib/types/user';
	import type { IncidentHistoryEntry } from '$lib/types/incident-history';
	import type { IncidentCategory } from '$lib/types/category';
	import type { SupportTeam } from '$lib/types/support';
	import { sendIncidentMessage } from '$lib/storage/first-response';
	let {
		incident,
		actor,
		users,
		history,
		categories,
		teams,
		incidents,
		incidentsSnapshot,
		onincidentupdate
	}: {
		incident: Incident;
		actor: AppUser;
		users: AppUser[];
		history: IncidentHistoryEntry[];
		categories: IncidentCategory[];
		teams: SupportTeam[];
		incidents?: Incident[];
		incidentsSnapshot?: string | null;
		onincidentupdate?: (updatedIncident: Incident) => void;
	} = $props();
	let messages = $state<IncidentMessage[]>([]);
	let ready = $state(false);
	let error = $state('');
	let announcement = $state('');
	let publicDraft = $state('');
	let internalDraft = $state('');
	let selected = $state('public');
	let snapshot: string | null = null;
	const internalAllowed = $derived(canUseMessages(actor, incident, 'internal'));
	const visible = $derived(visibleMessages(actor, incident, messages));
	const tabs = $derived(
		internalAllowed
			? [
					{ id: 'public', label: 'Comentarios' },
					{ id: 'internal', label: 'Notas internas' },
					{ id: 'history', label: 'Historial' }
				]
			: [{ id: 'public', label: 'Comentarios' }]
	);
	const date = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
	onMount(() => {
		try {
			snapshot = localStorage.getItem(MESSAGES_KEY);
			messages = loadMessages(snapshot);
			ready = true;
		} catch {
			error = 'No se pudieron cargar los mensajes. Los datos guardados se han conservado.';
		}
	});
	function send(event: SubmitEvent, visibility: IncidentMessageVisibility) {
		event.preventDefault();
		if (!ready) return;
		error = '';
		announcement = '';
		try {
			const message = createMessage(
				actor,
				incident,
				visibility,
				visibility === 'public' ? publicDraft : internalDraft,
				messages
			);
			const result = sendIncidentMessage(
				localStorage,
				actor,
				incident,
				message,
				snapshot,
				incidents,
				incidentsSnapshot
			);
			messages = result.nextMessages;
			snapshot = JSON.stringify(result.nextMessages);
			if (result.updatedIncident) {
				onincidentupdate?.(result.updatedIncident);
			}
			if (visibility === 'public') publicDraft = '';
			else internalDraft = '';
			announcement = visibility === 'public' ? 'Comentario enviado.' : 'Nota interna añadida.';
		} catch (cause) {
			error =
				cause instanceof Error
					? cause.message
					: 'No se pudo guardar el mensaje. Conservamos tu texto para reintentarlo.';
		}
	}
	function keyboard(event: KeyboardEvent, index: number) {
		const next =
			event.key === 'ArrowRight'
				? (index + 1) % tabs.length
				: event.key === 'ArrowLeft'
					? (index + tabs.length - 1) % tabs.length
					: event.key === 'Home'
						? 0
						: event.key === 'End'
							? tabs.length - 1
							: -1;
		if (next < 0) return;
		event.preventDefault();
		selected = tabs[next].id;
		const target = event.currentTarget as HTMLButtonElement;
		target.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
	}
</script>

{#snippet conversation(visibility: IncidentMessageVisibility)}
	<ol
		class="message-list mt-4 space-y-3"
		aria-label={visibility === 'public' ? 'Comentarios de la incidencia' : 'Notas del equipo'}
	>
		{#each visible.filter((message) => message.visibility === visibility) as message (message.id)}
			<li class="rounded-lg border border-slate-700 p-3">
				<div class="flex flex-wrap justify-between gap-2 text-xs text-slate-400">
					<span class="font-semibold text-slate-300">{messageAuthor(message, users)}</span><time
						datetime={message.createdAt}>{date.format(new Date(message.createdAt))}</time
					>
				</div>
				<p class="mt-2 text-sm whitespace-pre-wrap text-slate-200">{message.content}</p>
			</li>
		{:else}<li class="text-sm text-slate-400">
				{ready
					? visibility === 'public'
						? 'Todavía no hay comentarios.'
						: 'Todavía no hay notas internas.'
					: 'Mensajes no disponibles.'}
			</li>{/each}
	</ol>
{/snippet}

<section
	class="incident-messages mt-5 border-t border-slate-700 pt-4"
	aria-label="Comunicación de la incidencia"
>
	<div role="tablist" aria-label="Comunicación e historial" class="flex flex-wrap gap-2">
		{#each tabs as tab, index (tab.id)}
			{@const count = visible.filter((message) => message.visibility === tab.id).length}
			<button
				type="button"
				role="tab"
				id={`message-tab-${tab.id}`}
				aria-controls={`message-panel-${tab.id}`}
				aria-selected={selected === tab.id}
				tabindex={selected === tab.id ? 0 : -1}
				onclick={() => (selected = tab.id)}
				onkeydown={(event) => keyboard(event, index)}
				class="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300"
				>{tab.label}{count ? ` (${count})` : ''}</button
			>
		{/each}
	</div>
	{#if error}<p role="alert" class="mt-3 text-sm text-red-300">{error}</p>{/if}
	<p role="status" class="sr-only">{announcement}</p>
	<div
		role="tabpanel"
		id="message-panel-public"
		aria-labelledby="message-tab-public"
		hidden={selected !== 'public'}
		tabindex="0"
	>
		{@render conversation('public')}
		<form class="mt-4 space-y-2" onsubmit={(event) => send(event, 'public')}>
			<label for="public-message" class="block text-sm text-slate-300">Escribe un comentario</label>
			<textarea
				id="public-message"
				bind:value={publicDraft}
				required
				disabled={!ready}
				rows="3"
				class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3"
				aria-describedby="public-message-help"></textarea>
			<div class="flex flex-wrap items-center justify-between gap-3">
				<p id="public-message-help" class="text-xs text-slate-400">
					Visible para el cliente y el equipo. No se podrá editar ni eliminar.
				</p>
				<button
					type="submit"
					disabled={!ready || !publicDraft.trim()}
					class="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold">Enviar</button
				>
			</div>
		</form>
	</div>
	{#if internalAllowed}
		<div
			role="tabpanel"
			id="message-panel-internal"
			aria-labelledby="message-tab-internal"
			hidden={selected !== 'internal'}
			tabindex="0"
			class="internal-messages mt-3 rounded-lg border border-amber-500/30 p-3"
		>
			<p class="text-sm font-semibold text-amber-300">Solo visible para el equipo</p>
			{@render conversation('internal')}
			<form class="mt-4 space-y-2" onsubmit={(event) => send(event, 'internal')}>
				<label for="internal-message" class="block text-sm text-slate-300"
					>Escribe una nota interna</label
				>
				<textarea
					id="internal-message"
					bind:value={internalDraft}
					required
					disabled={!ready}
					rows="3"
					class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3"></textarea>
				<div class="flex flex-wrap items-center justify-between gap-3">
					<p class="text-xs text-slate-400">No se podrá editar ni eliminar.</p>
					<button
						type="submit"
						disabled={!ready || !internalDraft.trim()}
						class="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-amber-300"
						>Añadir nota</button
					>
				</div>
			</form>
		</div>
		<div
			role="tabpanel"
			id="message-panel-history"
			aria-labelledby="message-tab-history"
			hidden={selected !== 'history'}
			tabindex="0"
		>
			<IncidentTimeline {incident} viewer={actor} entries={history} {users} {categories} {teams} />
		</div>
	{/if}
</section>

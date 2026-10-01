<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import type { IncidentDetailView } from '$lib/api/incident-detail';
	import type { IncidentDetailController } from '$lib/app/incident-detail-controller';
	import { incidentActions } from '$lib/app/incident-actions';
	import {
		createIncidentConversation,
		unauthenticatedConversationError,
		type IncidentConversationController
	} from '$lib/app/incident-conversation';
	import type { TenantIdentity } from '$lib/app/tenant-identity';
	import Icon from '$lib/ui/Icon.svelte';
	import IncidentCommentList from './IncidentCommentList.svelte';
	import IncidentCommentComposer from './IncidentCommentComposer.svelte';
	import IncidentInternalNoteList from './IncidentInternalNoteList.svelte';
	import IncidentInternalNoteComposer from './IncidentInternalNoteComposer.svelte';
	import IncidentHistoryList from './IncidentHistoryList.svelte';

	let {
		incident,
		identity,
		capabilities = [],
		detailController,
		conversationController = null,
		onSessionExpiry
	}: {
		incident: IncidentDetailView;
		identity: TenantIdentity | null;
		capabilities?: readonly string[];
		detailController?: IncidentDetailController;
		conversationController?: IncidentConversationController | null;
		onSessionExpiry?: () => void;
	} = $props();

	const uid = $props.id();

	// svelte-ignore state_referenced_locally
	// If no external conversation controller was provided (e.g. from tests or parent), create own
	const conv: IncidentConversationController =
		conversationController ?? createIncidentConversation();
	onDestroy(() => {
		if (!conversationController) {
			conv.dispose();
		}
	});

	const convState = $derived($conv);
	const available = $derived(incidentActions(incident, capabilities));
	const isStaff = $derived(incident.audience === 'staff');
	const canViewInternalNotes = $derived(isStaff && available.readInternalNotes.available);
	const canAddComment = $derived(available.addComment.available);
	const canAddInternalNote = $derived(isStaff && available.addInternalNote.available);
	const isClosed = $derived(incident.status === 'closed');

	type ActivityTab = 'comments' | 'internalNotes' | 'history';

	const visibleTabs = $derived<ActivityTab[]>([
		'comments',
		...(canViewInternalNotes ? (['internalNotes'] as const) : []),
		'history'
	]);

	// Synchronize target with conversation controller
	$effect(() => {
		const id = incident.id;
		const aud = incident.audience;
		const idn = identity;
		const caps = capabilities;
		untrack(() => {
			if (idn && id) {
				const before = conv.get().targetKey;
				conv.setTarget({
					identity: idn,
					incidentId: id,
					audience: aud,
					capabilities: caps
				});
				if (conv.get().targetKey !== before) {
					void conv.loadComments();
				}
			} else {
				conv.setTarget(null);
			}
		});
	});

	// Re-load history if loaded and incident is updated via mutation
	let lastUpdatedAt: string | null = null;
	$effect(() => {
		const current = incident.updatedAt;
		untrack(() => {
			if (lastUpdatedAt && current !== lastUpdatedAt) {
				lastUpdatedAt = current;
				if (conv.get().history.status !== 'idle') {
					void conv.loadHistory({ reset: true });
				}
			} else {
				lastUpdatedAt = current;
			}
		});
	});

	// Session expiry check on 401
	$effect(() => {
		if (unauthenticatedConversationError(convState)) {
			onSessionExpiry?.();
		}
	});

	function handleTabSelect(tab: 'comments' | 'internalNotes' | 'history') {
		conv.setActiveTab(tab);
		if (
			tab === 'internalNotes' &&
			canViewInternalNotes &&
			convState.internalNotes.status === 'idle'
		) {
			void conv.loadInternalNotes();
		} else if (tab === 'history' && convState.history.status === 'idle') {
			void conv.loadHistory();
		}
	}

	function handleTabKeydown(e: KeyboardEvent, current: 'comments' | 'internalNotes' | 'history') {
		const tabs = visibleTabs;
		const currentIndex = tabs.indexOf(current);
		if (currentIndex === -1) return;

		let nextIndex = -1;
		if (e.key === 'ArrowRight') {
			nextIndex = (currentIndex + 1) % tabs.length;
		} else if (e.key === 'ArrowLeft') {
			nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
		} else if (e.key === 'Home') {
			nextIndex = 0;
		} else if (e.key === 'End') {
			nextIndex = tabs.length - 1;
		}

		if (nextIndex !== -1) {
			e.preventDefault();
			const nextTab = tabs[nextIndex];
			handleTabSelect(nextTab);
			const el = document.getElementById(`${uid}-tab-${nextTab}`);
			el?.focus();
		}
	}
</script>

<section class="sf-activity-section" aria-labelledby="{uid}-heading">
	<header class="sf-activity-header">
		<h2 id="{uid}-heading" class="sf-sr-only">Actividad, notas e historial de la incidencia</h2>
		<div class="sf-activity-tabs" role="tablist" aria-label="Vistas de actividad">
			<button
				type="button"
				role="tab"
				id="{uid}-tab-comments"
				class="sf-tab-btn"
				class:sf-tab-active={convState.activeTab === 'comments'}
				aria-selected={convState.activeTab === 'comments'}
				aria-controls="{uid}-panel-comments"
				tabindex={convState.activeTab === 'comments' ? 0 : -1}
				onclick={() => handleTabSelect('comments')}
				onkeydown={(e) => handleTabKeydown(e, 'comments')}
			>
				<Icon name="message-square" size={16} />
				<span>Conversación</span>
				{#if convState.comments.items.length > 0}
					<span class="sf-tab-counter">{convState.comments.items.length}</span>
				{/if}
			</button>

			{#if canViewInternalNotes}
				<button
					type="button"
					role="tab"
					id="{uid}-tab-internalNotes"
					class="sf-tab-btn sf-tab-note"
					class:sf-tab-active={convState.activeTab === 'internalNotes'}
					aria-selected={convState.activeTab === 'internalNotes'}
					aria-controls="{uid}-panel-internalNotes"
					tabindex={convState.activeTab === 'internalNotes' ? 0 : -1}
					onclick={() => handleTabSelect('internalNotes')}
					onkeydown={(e) => handleTabKeydown(e, 'internalNotes')}
				>
					<Icon name="lock" size={14} />
					<span>Notas internas</span>
					{#if convState.internalNotes.items.length > 0}
						<span class="sf-tab-counter sf-tab-counter-warn">
							{convState.internalNotes.items.length}
						</span>
					{/if}
				</button>
			{/if}

			<button
				type="button"
				role="tab"
				id="{uid}-tab-history"
				class="sf-tab-btn"
				class:sf-tab-active={convState.activeTab === 'history'}
				aria-selected={convState.activeTab === 'history'}
				aria-controls="{uid}-panel-history"
				tabindex={convState.activeTab === 'history' ? 0 : -1}
				onclick={() => handleTabSelect('history')}
				onkeydown={(e) => handleTabKeydown(e, 'history')}
			>
				<Icon name="history" size={16} />
				<span>Historial</span>
				{#if convState.history.items.length > 0}
					<span class="sf-tab-counter">{convState.history.items.length}</span>
				{/if}
			</button>
		</div>
	</header>

	<div class="sf-activity-content">
		{#if convState.activeTab === 'comments'}
			<div
				id="{uid}-panel-comments"
				role="tabpanel"
				aria-labelledby="{uid}-tab-comments"
				class="sf-tabpanel"
			>
				<IncidentCommentList
					items={convState.comments.items}
					status={convState.comments.status}
					loadingMore={convState.comments.loadingMore}
					nextCursor={convState.comments.nextCursor}
					error={convState.comments.error}
					onRetry={() => void conv.loadComments({ reset: true })}
					onLoadMore={() => void conv.loadComments({ reset: false })}
				/>

				<IncidentCommentComposer
					draft={convState.commentComposer.draft}
					submitting={convState.commentComposer.submitting}
					error={convState.commentComposer.error}
					outcome={convState.commentComposer.outcome}
					closed={isClosed}
					{canAddComment}
					onDraftChange={(d) => conv.setCommentDraft(d)}
					onSubmit={() => void conv.addComment(undefined, detailController)}
				/>
			</div>
		{:else if canViewInternalNotes && convState.activeTab === 'internalNotes'}
			<div
				id="{uid}-panel-internalNotes"
				role="tabpanel"
				aria-labelledby="{uid}-tab-internalNotes"
				class="sf-tabpanel"
			>
				<IncidentInternalNoteList
					items={convState.internalNotes.items}
					status={convState.internalNotes.status}
					loadingMore={convState.internalNotes.loadingMore}
					nextCursor={convState.internalNotes.nextCursor}
					error={convState.internalNotes.error}
					onRetry={() => void conv.loadInternalNotes({ reset: true })}
					onLoadMore={() => void conv.loadInternalNotes({ reset: false })}
				/>

				<IncidentInternalNoteComposer
					draft={convState.internalNoteComposer.draft}
					submitting={convState.internalNoteComposer.submitting}
					error={convState.internalNoteComposer.error}
					outcome={convState.internalNoteComposer.outcome}
					closed={isClosed}
					canAddNote={canAddInternalNote}
					onDraftChange={(d) => conv.setInternalNoteDraft(d)}
					onSubmit={() => void conv.addInternalNote(undefined, detailController)}
				/>
			</div>
		{:else if convState.activeTab === 'history'}
			<div
				id="{uid}-panel-history"
				role="tabpanel"
				aria-labelledby="{uid}-tab-history"
				class="sf-tabpanel"
			>
				<IncidentHistoryList
					items={convState.history.items}
					status={convState.history.status}
					loadingMore={convState.history.loadingMore}
					nextCursor={convState.history.nextCursor}
					error={convState.history.error}
					onRetry={() => void conv.loadHistory({ reset: true })}
					onLoadMore={() => void conv.loadHistory({ reset: false })}
				/>
			</div>
		{/if}
	</div>
</section>

<style>
	.sf-activity-section {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-6);
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface-card);
		box-shadow: var(--sf-shadow-card);
	}
	.sf-activity-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		border-bottom: 1px solid var(--border);
		padding-bottom: var(--space-3);
	}
	.sf-activity-tabs {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.sf-tab-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-secondary);
		font-family: inherit;
		font-size: var(--text-sm);
		font-weight: 500;
		cursor: pointer;
		transition: all var(--duration) var(--ease);
	}
	.sf-tab-btn:hover {
		color: var(--text-primary);
		background: var(--surface-hover, rgba(148, 163, 184, 0.08));
	}
	.sf-tab-btn:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	.sf-tab-active {
		color: var(--accent);
		background: var(--surface-elevated, rgba(148, 163, 184, 0.12));
		border-color: var(--border);
		font-weight: 600;
	}
	.sf-tab-note.sf-tab-active {
		color: var(--warning-text, #d97706);
		border-color: rgba(245, 158, 11, 0.3);
		background: rgba(245, 158, 11, 0.08);
	}
	.sf-tab-counter {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.35rem;
		border-radius: var(--radius-full, 9999px);
		background: var(--surface-elevated, rgba(148, 163, 184, 0.2));
		font-size: var(--text-2xs);
		font-weight: 600;
	}
	.sf-tab-counter-warn {
		background: rgba(245, 158, 11, 0.2);
		color: var(--warning-text, #d97706);
	}
	.sf-activity-content {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.sf-tabpanel {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	@media (max-width: 639px) {
		.sf-activity-section {
			padding: var(--space-5) var(--space-4);
		}
	}
</style>

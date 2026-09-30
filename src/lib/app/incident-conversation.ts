import { ApiError, isApiError, networkApiError } from '../api/errors.ts';
import {
	createIncidentComment,
	createIncidentInternalNote,
	listIncidentComments,
	listIncidentInternalNotes,
	type IncidentCommentPage,
	type IncidentInternalNote,
	type IncidentInternalNotePage,
	type IncidentPublicComment
} from '../api/incidents.ts';
import type { IncidentDetailController } from './incident-detail-controller.ts';
import { createMutationChannel, type MutationChannel, type MutationResult } from './mutation.ts';
import { createRequestChannels, type RequestChannels } from './request-channels.ts';
import { isStaleRequest } from './request-scope.ts';
import { tenantKey, type TenantIdentity } from './tenant-identity.ts';

export const MESSAGE_MAX_LENGTH = 4000;

export interface IncidentConversationTarget {
	identity: TenantIdentity;
	incidentId: string;
	audience: 'requester' | 'staff';
	capabilities: readonly string[];
}

export interface FeedState<T> {
	readonly status: 'idle' | 'loading' | 'ready' | 'error';
	readonly items: readonly T[];
	readonly nextCursor: string | null;
	readonly loadingMore: boolean;
	readonly error: ApiError | null;
}

export interface ComposerState {
	readonly draft: string;
	readonly submitting: boolean;
	readonly error: ApiError | null;
	readonly outcome: 'idle' | 'success' | 'error' | 'unknown';
}

export interface IncidentConversationState {
	readonly targetKey: string;
	readonly organizationId: string | null;
	readonly incidentId: string | null;
	readonly audience: 'requester' | 'staff' | null;
	readonly activeTab: 'comments' | 'internalNotes';
	readonly comments: FeedState<IncidentPublicComment>;
	readonly internalNotes: FeedState<IncidentInternalNote>;
	readonly commentComposer: ComposerState;
	readonly internalNoteComposer: ComposerState;
}

export interface IncidentConversationController {
	subscribe(run: (state: IncidentConversationState) => void): () => void;
	get(): IncidentConversationState;
	setTarget(target: IncidentConversationTarget | null): void;
	loadComments(options?: { reset?: boolean }): Promise<void>;
	loadInternalNotes(options?: { reset?: boolean }): Promise<void>;
	setCommentDraft(draft: string): void;
	setInternalNoteDraft(draft: string): void;
	clearCommentOutcome(): void;
	clearInternalNoteOutcome(): void;
	setActiveTab(tab: 'comments' | 'internalNotes'): void;
	addComment(
		body?: string,
		detailController?: IncidentDetailController
	): Promise<MutationResult<IncidentPublicComment>>;
	addInternalNote(
		body?: string,
		detailController?: IncidentDetailController
	): Promise<MutationResult<IncidentInternalNote>>;
	dispose(): void;
}

const EMPTY_FEED = Object.freeze({
	status: 'idle' as const,
	items: Object.freeze([]) as readonly never[],
	nextCursor: null,
	loadingMore: false,
	error: null
});

const EMPTY_COMPOSER = Object.freeze({
	draft: '',
	submitting: false,
	error: null,
	outcome: 'idle' as const
});

const EMPTY_STATE: IncidentConversationState = Object.freeze({
	targetKey: '',
	organizationId: null,
	incidentId: null,
	audience: null,
	activeTab: 'comments',
	comments: EMPTY_FEED,
	internalNotes: EMPTY_FEED,
	commentComposer: EMPTY_COMPOSER,
	internalNoteComposer: EMPTY_COMPOSER
});

export function conversationTargetKey(target: IncidentConversationTarget | null): string {
	return target ? `${tenantKey(target.identity)}|i:${target.incidentId}|a:${target.audience}` : '';
}

export function unauthenticatedConversationError(
	state: IncidentConversationState
): ApiError | null {
	const candidates: (ApiError | null)[] = [
		state.comments.error,
		state.internalNotes.error,
		state.commentComposer.error,
		state.internalNoteComposer.error
	];
	return candidates.find((err) => err?.status === 401) ?? null;
}

function toApiError(error: unknown): ApiError {
	return isApiError(error) ? error : networkApiError();
}

function deduplicate<T extends { id: string }>(
	existing: readonly T[],
	incoming: readonly T[]
): T[] {
	const seen = new Set(existing.map((item) => item.id));
	const out = [...existing];
	for (const item of incoming) {
		if (!seen.has(item.id)) {
			seen.add(item.id);
			out.push(item);
		}
	}
	return out;
}

export function createIncidentConversation(deps?: {
	listComments?: (options: {
		organizationId: string;
		incidentId: string;
		cursor?: string;
		signal: AbortSignal;
	}) => Promise<IncidentCommentPage>;
	listInternalNotes?: (options: {
		organizationId: string;
		incidentId: string;
		cursor?: string;
		signal: AbortSignal;
	}) => Promise<IncidentInternalNotePage>;
	createComment?: (options: {
		organizationId: string;
		incidentId: string;
		body: string;
	}) => Promise<IncidentPublicComment>;
	createInternalNote?: (options: {
		organizationId: string;
		incidentId: string;
		body: string;
	}) => Promise<IncidentInternalNote>;
}): IncidentConversationController {
	const fetchComments =
		deps?.listComments ??
		((opts) =>
			listIncidentComments({
				organizationId: opts.organizationId,
				incidentId: opts.incidentId,
				cursor: opts.cursor,
				signal: opts.signal
			}));
	const fetchInternalNotes =
		deps?.listInternalNotes ??
		((opts) =>
			listIncidentInternalNotes({
				organizationId: opts.organizationId,
				incidentId: opts.incidentId,
				cursor: opts.cursor,
				signal: opts.signal
			}));
	const sendComment =
		deps?.createComment ??
		((opts) =>
			createIncidentComment({
				organizationId: opts.organizationId,
				incidentId: opts.incidentId,
				body: opts.body
			}));
	const sendInternalNote =
		deps?.createInternalNote ??
		((opts) =>
			createIncidentInternalNote({
				organizationId: opts.organizationId,
				incidentId: opts.incidentId,
				body: opts.body
			}));

	const channels: RequestChannels = createRequestChannels();
	const commentMutation: MutationChannel = createMutationChannel();
	const noteMutation: MutationChannel = createMutationChannel();

	const listeners = new Set<(state: IncidentConversationState) => void>();
	let state: IncidentConversationState = EMPTY_STATE;
	let currentTarget: IncidentConversationTarget | null = null;

	function set(patch: Partial<IncidentConversationState>) {
		state = { ...state, ...patch };
		for (const listener of listeners) listener(state);
	}

	function canViewInternalNotes(): boolean {
		return (
			currentTarget !== null &&
			currentTarget.audience === 'staff' &&
			currentTarget.capabilities.includes('incidents:view_internal_notes')
		);
	}

	function canAddInternalNote(): boolean {
		return (
			currentTarget !== null &&
			currentTarget.audience === 'staff' &&
			currentTarget.capabilities.includes('incidents:add_internal_note')
		);
	}

	const controller: IncidentConversationController = {
		subscribe(run) {
			listeners.add(run);
			run(state);
			return () => listeners.delete(run);
		},
		get: () => state,
		setTarget(next) {
			const key = conversationTargetKey(next);
			if (key === state.targetKey) {
				// Target identity unchanged, but capabilities or target reference may have updated
				currentTarget = next;
				return;
			}
			currentTarget = next;
			channels.setContext(key);
			commentMutation.setContext(key);
			noteMutation.setContext(key);

			// Identity changed: clear feed items, reset tab, keep safe empty state
			set({
				targetKey: key,
				organizationId: next?.identity.organizationId ?? null,
				incidentId: next?.incidentId ?? null,
				audience: next?.audience ?? null,
				activeTab: 'comments',
				comments: EMPTY_FEED,
				internalNotes: EMPTY_FEED,
				commentComposer: EMPTY_COMPOSER,
				internalNoteComposer: EMPTY_COMPOSER
			});
		},
		setActiveTab(tab) {
			if (tab === 'internalNotes' && !canViewInternalNotes()) {
				// Requester or unauthorized staff can never switch to internal notes
				return;
			}
			if (state.activeTab !== tab) {
				set({ activeTab: tab });
			}
		},
		setCommentDraft(draft) {
			set({ commentComposer: { ...state.commentComposer, draft } });
		},
		setInternalNoteDraft(draft) {
			set({ internalNoteComposer: { ...state.internalNoteComposer, draft } });
		},
		clearCommentOutcome() {
			set({ commentComposer: { ...state.commentComposer, outcome: 'idle', error: null } });
		},
		clearInternalNoteOutcome() {
			set({
				internalNoteComposer: { ...state.internalNoteComposer, outcome: 'idle', error: null }
			});
		},
		async loadComments(options = {}) {
			const target = currentTarget;
			if (!target) return;
			const isReset = options.reset === true || state.comments.status === 'idle';
			const cursor = isReset ? undefined : (state.comments.nextCursor ?? undefined);

			if (!isReset && !cursor) return; // No more items

			set({
				comments: {
					...state.comments,
					status: isReset ? 'loading' : state.comments.status,
					loadingMore: !isReset,
					error: isReset ? null : state.comments.error
				}
			});

			try {
				const page = await channels.channel('comments').run((signal) =>
					fetchComments({
						organizationId: target.identity.organizationId,
						incidentId: target.incidentId,
						cursor,
						signal
					})
				);
				const merged = isReset ? page.items : deduplicate(state.comments.items, page.items);
				set({
					comments: {
						status: 'ready',
						items: merged,
						nextCursor: page.nextCursor,
						loadingMore: false,
						error: null
					}
				});
			} catch (err: unknown) {
				if (isStaleRequest(err)) return;
				const apiError = toApiError(err);
				set({
					comments: {
						status: isReset ? 'error' : state.comments.status,
						items: isReset ? [] : state.comments.items,
						nextCursor: isReset ? null : state.comments.nextCursor,
						loadingMore: false,
						error: apiError
					}
				});
			}
		},
		async loadInternalNotes(options = {}) {
			const target = currentTarget;
			if (!target || !canViewInternalNotes()) {
				// Critical: requesters and unauthorized staff never load internal notes
				return;
			}
			const isReset = options.reset === true || state.internalNotes.status === 'idle';
			const cursor = isReset ? undefined : (state.internalNotes.nextCursor ?? undefined);

			if (!isReset && !cursor) return;

			set({
				internalNotes: {
					...state.internalNotes,
					status: isReset ? 'loading' : state.internalNotes.status,
					loadingMore: !isReset,
					error: isReset ? null : state.internalNotes.error
				}
			});

			try {
				const page = await channels.channel('internalNotes').run((signal) =>
					fetchInternalNotes({
						organizationId: target.identity.organizationId,
						incidentId: target.incidentId,
						cursor,
						signal
					})
				);
				const merged = isReset ? page.items : deduplicate(state.internalNotes.items, page.items);
				set({
					internalNotes: {
						status: 'ready',
						items: merged,
						nextCursor: page.nextCursor,
						loadingMore: false,
						error: null
					}
				});
			} catch (err: unknown) {
				if (isStaleRequest(err)) return;
				const apiError = toApiError(err);
				set({
					internalNotes: {
						status: isReset ? 'error' : state.internalNotes.status,
						items: isReset ? [] : state.internalNotes.items,
						nextCursor: isReset ? null : state.internalNotes.nextCursor,
						loadingMore: false,
						error: apiError
					}
				});
			}
		},
		async addComment(bodyText, detailController) {
			const target = currentTarget;
			if (!target) return { status: 'stale' };

			if (!target.capabilities.includes('incidents:add_comment')) {
				const err = new ApiError(403, 'FORBIDDEN', 'No tienes permisos para añadir comentarios.');
				set({ commentComposer: { ...state.commentComposer, error: err, outcome: 'error' } });
				return { status: 'error', error: err };
			}

			const text = (bodyText !== undefined ? bodyText : state.commentComposer.draft).trim();
			if (!text) {
				const err = new ApiError(0, 'INVALID_INPUT', 'El comentario no puede estar vacío.');
				set({ commentComposer: { ...state.commentComposer, error: err, outcome: 'error' } });
				return { status: 'error', error: err };
			}
			if (text.length > MESSAGE_MAX_LENGTH) {
				const err = new ApiError(
					0,
					'INVALID_INPUT',
					`El comentario no puede superar los ${MESSAGE_MAX_LENGTH} caracteres.`
				);
				set({ commentComposer: { ...state.commentComposer, error: err, outcome: 'error' } });
				return { status: 'error', error: err };
			}

			set({
				commentComposer: {
					...state.commentComposer,
					submitting: true,
					error: null,
					outcome: 'idle'
				}
			});

			const mutateFn = async (orgId: string, incId: string) => {
				return await sendComment({ organizationId: orgId, incidentId: incId, body: text });
			};

			const result = detailController
				? await detailController.mutate('addComment', mutateFn)
				: await commentMutation.run(() =>
						mutateFn(target.identity.organizationId, target.incidentId)
					);

			if (result.status === 'stale') return result;
			if (result.status === 'busy') {
				set({ commentComposer: { ...state.commentComposer, submitting: false } });
				return result;
			}

			if (result.status === 'success') {
				set({
					commentComposer: {
						draft: '',
						submitting: false,
						error: null,
						outcome: 'success'
					}
				});
				await controller.loadComments({ reset: true });
				return result;
			}

			// Unknown or Error: preserve draft so user does not lose typed content
			set({
				commentComposer: {
					...state.commentComposer,
					submitting: false,
					error: result.error,
					outcome: result.status
				}
			});
			return result;
		},
		async addInternalNote(bodyText, detailController) {
			const target = currentTarget;
			if (!target || !canAddInternalNote()) {
				const err = new ApiError(
					403,
					'FORBIDDEN',
					'No tienes permisos para añadir notas internas.'
				);
				set({
					internalNoteComposer: { ...state.internalNoteComposer, error: err, outcome: 'error' }
				});
				return { status: 'error', error: err };
			}

			const text = (bodyText !== undefined ? bodyText : state.internalNoteComposer.draft).trim();
			if (!text) {
				const err = new ApiError(0, 'INVALID_INPUT', 'La nota interna no puede estar vacía.');
				set({
					internalNoteComposer: { ...state.internalNoteComposer, error: err, outcome: 'error' }
				});
				return { status: 'error', error: err };
			}
			if (text.length > MESSAGE_MAX_LENGTH) {
				const err = new ApiError(
					0,
					'INVALID_INPUT',
					`La nota interna no puede superar los ${MESSAGE_MAX_LENGTH} caracteres.`
				);
				set({
					internalNoteComposer: { ...state.internalNoteComposer, error: err, outcome: 'error' }
				});
				return { status: 'error', error: err };
			}

			set({
				internalNoteComposer: {
					...state.internalNoteComposer,
					submitting: true,
					error: null,
					outcome: 'idle'
				}
			});

			const mutateFn = async (orgId: string, incId: string) => {
				return await sendInternalNote({
					organizationId: orgId,
					incidentId: incId,
					body: text
				});
			};

			const result = detailController
				? await detailController.mutate('addInternalNote', mutateFn)
				: await noteMutation.run(() => mutateFn(target.identity.organizationId, target.incidentId));

			if (result.status === 'stale') return result;
			if (result.status === 'busy') {
				set({ internalNoteComposer: { ...state.internalNoteComposer, submitting: false } });
				return result;
			}

			if (result.status === 'success') {
				set({
					internalNoteComposer: {
						draft: '',
						submitting: false,
						error: null,
						outcome: 'success'
					}
				});
				await controller.loadInternalNotes({ reset: true });
				return result;
			}

			set({
				internalNoteComposer: {
					...state.internalNoteComposer,
					submitting: false,
					error: result.error,
					outcome: result.status
				}
			});
			return result;
		},
		dispose() {
			channels.invalidate();
			commentMutation.dispose();
			noteMutation.dispose();
			listeners.clear();
			currentTarget = null;
			state = EMPTY_STATE;
		}
	};

	return controller;
}

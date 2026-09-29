import { ApiError, isApiError, networkApiError } from '../api/errors.ts';
import type { IncidentDetailView } from '../api/incident-detail.ts';
import {
	createMutationChannel,
	type MutationChannel,
	type MutationResult,
	type MutationState
} from './mutation.ts';
import { createRequestChannels } from './request-channels.ts';
import { isStaleRequest } from './request-scope.ts';
import { tenantKey, type TenantIdentity } from './tenant-identity.ts';

/**
 * UI-2A — incident detail coordination (no UI). Pure TypeScript, unit-tested in Node.
 *
 * Identity of everything it holds: user + organization + context generation + incident id.
 * - setTarget() with another identity clears detail, channels and mutation states AT ONCE and
 *   makes every in-flight read or mutation stale: nothing of tenant/user/incident A can reach B,
 *   and A -> B -> A never resurrects an old answer (the generation differs).
 * - Independent channels: the detail and each secondary resource (comments, internal notes,
 *   history — loaders are injected, UI-2D/2F) have their own request scope, so they never
 *   cancel each other; a new request of the SAME channel supersedes the previous one.
 * - Mutations are pessimistic (mutation.ts): sent once, never retried, `unknown` when the answer
 *   is lost. A confirmed or unknown mutation re-reads the detail: the server decides whether the
 *   actor can still read it (e.g. a view_own technician who reassigned the incident) —
 *   `access-lost` then, never an assumed success view.
 * - Stale answers (including a stale 401) never touch the state; the page reacts to a 401 only
 *   through `unauthenticatedError(state)`, i.e. only for the CURRENT identity.
 */

export interface IncidentDetailTarget {
	identity: TenantIdentity;
	incidentId: string;
}

export type IncidentDetailStatus =
	| 'idle'
	| 'loading'
	| 'refreshing'
	| 'ready'
	| 'error'
	/** A confirmed/unknown mutation was followed by a read that is no longer allowed (403/404). */
	| 'access-lost';

export interface ChannelView<T = unknown> {
	readonly status: 'loading' | 'ready' | 'error';
	readonly data: T | null;
	readonly error: ApiError | null;
}

export interface IncidentDetailState {
	readonly status: IncidentDetailStatus;
	/** Identity key of the target ('' when none). */
	readonly key: string;
	readonly organizationId: string | null;
	readonly incidentId: string | null;
	readonly detail: IncidentDetailView | null;
	readonly error: ApiError | null;
	/** Epoch ms until which a manual retry of the READ is pointless (429). */
	readonly cooldownUntil: number | null;
	readonly channels: Readonly<Record<string, ChannelView>>;
	readonly mutations: Readonly<Record<string, MutationState<unknown>>>;
}

export type FetchIncidentDetail = (
	organizationId: string,
	incidentId: string,
	options: { signal: AbortSignal }
) => Promise<IncidentDetailView>;

export type ChannelLoader<T> = (
	organizationId: string,
	incidentId: string,
	signal: AbortSignal
) => Promise<T>;

export type MutationSender<T> = (organizationId: string, incidentId: string) => Promise<T>;

export interface IncidentDetailController {
	subscribe(run: (state: IncidentDetailState) => void): () => void;
	get(): IncidentDetailState;
	setTarget(target: IncidentDetailTarget | null): void;
	/** (Re)loads the detail. A manual retry is refused during a 429 cooldown. */
	load(): Promise<void>;
	/** Loads a secondary channel ('comments', 'internalNotes', 'history', …) in its own scope. */
	loadChannel<T>(name: string, loader: ChannelLoader<T>): Promise<void>;
	/** Runs one pessimistic mutation of `kind` (never retried) and re-reads the detail after it. */
	mutate<T>(kind: string, send: MutationSender<T>): Promise<MutationResult<T>>;
	/** Forgets the outcome of `kind` (e.g. after the UI showed it). */
	clearMutation(kind: string): void;
	dispose(): void;
}

export const DETAIL_CHANNEL = 'detail';

export function detailTargetKey(target: IncidentDetailTarget | null): string {
	return target ? `${tenantKey(target.identity)}|i:${target.incidentId}` : '';
}

/** The 401 of the CURRENT identity, if any (stale 401s never reach the state). */
export function unauthenticatedError(state: IncidentDetailState): ApiError | null {
	const candidates: (ApiError | null)[] = [
		state.error,
		...Object.values(state.channels).map((channel) => channel.error),
		...Object.values(state.mutations).map((mutation) =>
			mutation.status === 'error' || mutation.status === 'unknown' ? mutation.error : null
		)
	];
	return candidates.find((error) => error?.status === 401) ?? null;
}

const EMPTY: IncidentDetailState = Object.freeze({
	status: 'idle',
	key: '',
	organizationId: null,
	incidentId: null,
	detail: null,
	error: null,
	cooldownUntil: null,
	channels: Object.freeze({}),
	mutations: Object.freeze({})
});

const toApiError = (error: unknown): ApiError => (isApiError(error) ? error : networkApiError());

export function createIncidentDetailController(deps: {
	fetchDetail: FetchIncidentDetail;
	now?: () => number;
}): IncidentDetailController {
	const now = deps.now ?? (() => Date.now());
	const channels = createRequestChannels();
	const mutationChannels = new Map<string, MutationChannel>();
	const listeners = new Set<(state: IncidentDetailState) => void>();
	let state: IncidentDetailState = EMPTY;
	let target: IncidentDetailTarget | null = null;

	function set(patch: Partial<IncidentDetailState>) {
		state = { ...state, ...patch };
		for (const listener of listeners) listener(state);
	}

	function mutationChannel(kind: string): MutationChannel {
		let channel = mutationChannels.get(kind);
		if (!channel) {
			channel = createMutationChannel(state.key);
			mutationChannels.set(kind, channel);
		}
		return channel;
	}

	/** Reads the detail; `afterMutation` turns a lost read access into `access-lost`. */
	async function readDetail(afterMutation: boolean) {
		const current = target;
		if (!current) return;
		const { organizationId } = current.identity;
		set({ status: state.detail ? 'refreshing' : 'loading', error: null });
		try {
			const detail = await channels
				.channel(DETAIL_CHANNEL)
				.run((signal) => deps.fetchDetail(organizationId, current.incidentId, { signal }));
			set({ status: 'ready', detail, error: null, cooldownUntil: null });
		} catch (error) {
			if (isStaleRequest(error)) return;
			const apiError = toApiError(error);
			if (afterMutation && (apiError.status === 403 || apiError.status === 404)) {
				// The server no longer lets this actor read it: drop every tenant datum it held.
				set({ status: 'access-lost', detail: null, error: apiError, channels: {} });
				return;
			}
			const cooldownUntil =
				apiError.status === 429 && apiError.retryAfterSeconds !== undefined
					? now() + apiError.retryAfterSeconds * 1000
					: null;
			// A failed read never keeps the previous detail as if it were current.
			set({ status: 'error', detail: null, error: apiError, cooldownUntil, channels: {} });
		}
	}

	const controller: IncidentDetailController = {
		subscribe(run) {
			listeners.add(run);
			run(state);
			return () => listeners.delete(run);
		},
		get: () => state,
		setTarget(next) {
			const key = detailTargetKey(next);
			if (key === state.key) return;
			target = next;
			channels.setContext(key);
			for (const channel of mutationChannels.values()) channel.setContext(key);
			set({
				...EMPTY,
				key,
				organizationId: next?.identity.organizationId ?? null,
				incidentId: next?.incidentId ?? null
			});
		},
		async load() {
			if (state.cooldownUntil !== null && now() < state.cooldownUntil) return;
			await readDetail(false);
		},
		async loadChannel(name, loader) {
			if (name === DETAIL_CHANNEL) throw new Error('The detail has its own loader.');
			const current = target;
			if (!current) return;
			const previous = state.channels[name];
			set({
				channels: {
					...state.channels,
					[name]: { status: 'loading', data: previous?.data ?? null, error: null }
				}
			});
			try {
				const data = await channels
					.channel(name)
					.run((signal) => loader(current.identity.organizationId, current.incidentId, signal));
				set({ channels: { ...state.channels, [name]: { status: 'ready', data, error: null } } });
			} catch (error) {
				if (isStaleRequest(error)) return;
				// A failed channel shows its error, never an empty list.
				set({
					channels: {
						...state.channels,
						[name]: { status: 'error', data: null, error: toApiError(error) }
					}
				});
			}
		},
		async mutate(kind, send) {
			const current = target;
			if (!current) return { status: 'stale' };
			const channel = mutationChannel(kind);
			if (channel.pending) return { status: 'busy' };
			const key = state.key;
			set({ mutations: { ...state.mutations, [kind]: { status: 'pending' } } });
			const result = await channel.run(() =>
				send(current.identity.organizationId, current.incidentId)
			);
			if (result.status === 'stale' || result.status === 'busy' || state.key !== key)
				return result.status === 'busy' ? result : { status: 'stale' };
			set({ mutations: { ...state.mutations, [kind]: result } });
			// Confirmed or unconfirmable: re-read the real state (and the actor's access to it).
			if (result.status === 'success' || result.status === 'unknown') await readDetail(true);
			return result;
		},
		clearMutation(kind) {
			if (!(kind in state.mutations)) return;
			const rest = { ...state.mutations };
			delete rest[kind];
			set({ mutations: rest });
		},
		dispose() {
			channels.invalidate();
			for (const channel of mutationChannels.values()) channel.dispose();
			mutationChannels.clear();
			listeners.clear();
			target = null;
			state = EMPTY;
		}
	};
	return controller;
}

import type { IncidentQueue } from '../api/incidents.ts';
import type {
	IncidentPage,
	IncidentPageQuery,
	IncidentPriority,
	IncidentStatus,
	IncidentView
} from '../api/incident-views.ts';
import { ApiError, isApiError, networkApiError } from '../api/errors.ts';
import { createRequestScope, isStaleRequest } from './request-scope.ts';

/**
 * Incident list state machine (UI-2A minimal). Pure TypeScript (unit-tested in Node).
 *
 * - Keyset pagination only: `next` follows the server's opaque nextCursor; `previous` walks back
 *   through the cursor history of THIS query (no page numbers, no totals).
 * - A new query (queue/filters) or a new tenant context resets the history and the rows.
 * - Tenant switch clears rows immediately (never show the previous organization's data) and
 *   makes in-flight responses stale.
 * - 429 sets a cooldown from Retry-After; retry is refused until it elapses (no automatic retry).
 */

export interface IncidentListFilters {
	status?: IncidentStatus;
	priority?: IncidentPriority;
	siteId?: string;
	categoryId?: string;
}

export interface IncidentListQuery extends IncidentListFilters {
	/** null: requester scope (no queue parameter). */
	queue: IncidentQueue | null;
}

export type IncidentListStatus = 'idle' | 'loading' | 'refreshing' | 'ready' | 'error';

export interface IncidentListState {
	status: IncidentListStatus;
	incidents: readonly IncidentView[];
	nextCursor: string | null;
	/** Cursor used for each visited page of the current query; [null] = first page. */
	cursorHistory: readonly (string | null)[];
	error: ApiError | null;
	/** Epoch ms until which retry is disabled (429). */
	cooldownUntil: number | null;
	organizationId: string | null;
	contextKey: string;
	queryKey: string;
}

export type FetchIncidentPage = (
	organizationId: string,
	query: IncidentPageQuery,
	options: { signal: AbortSignal }
) => Promise<IncidentPage>;

export interface IncidentListController {
	subscribe(run: (state: IncidentListState) => void): () => void;
	get(): IncidentListState;
	/** New tenant context: rows cleared at once; nothing loads until setQuery. */
	setContext(contextKey: string, organizationId: string | null): void;
	/** Applies a query; a different query restarts from the first page. */
	setQuery(query: IncidentListQuery): Promise<void>;
	next(): Promise<void>;
	previous(): Promise<void>;
	/** Reloads the current page (refused during a 429 cooldown). */
	retry(): Promise<void>;
	dispose(): void;
}

export function hasActiveFilters(query: IncidentListFilters): boolean {
	return (
		query.status !== undefined ||
		query.priority !== undefined ||
		query.siteId !== undefined ||
		query.categoryId !== undefined
	);
}

export function queryKeyOf(query: IncidentListQuery): string {
	return JSON.stringify([
		query.queue,
		query.status ?? null,
		query.priority ?? null,
		query.siteId ?? null,
		query.categoryId ?? null
	]);
}

const EMPTY: IncidentListState = {
	status: 'idle',
	incidents: [],
	nextCursor: null,
	cursorHistory: [null],
	error: null,
	cooldownUntil: null,
	organizationId: null,
	contextKey: '',
	queryKey: ''
};

export function createIncidentListController(deps: {
	fetchPage: FetchIncidentPage;
	limit?: number;
	now?: () => number;
}): IncidentListController {
	const now = deps.now ?? (() => Date.now());
	const scope = createRequestScope();
	const listeners = new Set<(s: IncidentListState) => void>();
	let state: IncidentListState = { ...EMPTY };
	let query: IncidentListQuery | null = null;
	/** Page the last load attempted (retry repeats exactly that one). */
	let lastAttempt: { cursor: string | null; history: (string | null)[] } = {
		cursor: null,
		history: [null]
	};

	function set(patch: Partial<IncidentListState>) {
		state = { ...state, ...patch };
		for (const listener of listeners) listener(state);
	}

	async function load(cursor: string | null, history: (string | null)[]) {
		const organizationId = state.organizationId;
		if (!organizationId || !query) return;
		const current = query;
		lastAttempt = { cursor, history };
		set({
			status: state.incidents.length > 0 ? 'refreshing' : 'loading',
			error: null
		});
		try {
			const page = await scope.run((signal) =>
				deps.fetchPage(
					organizationId,
					{
						...(current.queue ? { queue: current.queue } : {}),
						status: current.status,
						priority: current.priority,
						siteId: current.siteId,
						categoryId: current.categoryId,
						limit: deps.limit,
						cursor
					},
					{ signal }
				)
			);
			set({
				status: 'ready',
				incidents: page.incidents,
				nextCursor: page.nextCursor,
				cursorHistory: history,
				error: null,
				cooldownUntil: null
			});
		} catch (error) {
			if (isStaleRequest(error)) return;
			const apiError = isApiError(error) ? error : networkApiError();
			const cooldownUntil =
				apiError.status === 429 && apiError.retryAfterSeconds !== undefined
					? now() + apiError.retryAfterSeconds * 1000
					: null;
			// Errors never keep rows of a failed query visible as if they were current.
			set({ status: 'error', error: apiError, cooldownUntil, incidents: [], nextCursor: null });
		}
	}

	const controller: IncidentListController = {
		subscribe(run) {
			listeners.add(run);
			run(state);
			return () => listeners.delete(run);
		},
		get: () => state,
		setContext(contextKey, organizationId) {
			if (contextKey === state.contextKey && organizationId === state.organizationId) return;
			scope.setContext(contextKey);
			query = null;
			lastAttempt = { cursor: null, history: [null] };
			set({ ...EMPTY, contextKey, organizationId });
		},
		async setQuery(next) {
			const key = queryKeyOf(next);
			if (key === state.queryKey && query !== null && state.status !== 'error') return;
			query = next;
			set({ queryKey: key, incidents: [], nextCursor: null, cursorHistory: [null] });
			await load(null, [null]);
		},
		async next() {
			if (!state.nextCursor || state.status === 'loading' || state.status === 'refreshing') return;
			const history = [...state.cursorHistory, state.nextCursor];
			await load(state.nextCursor, history);
		},
		async previous() {
			if (
				state.cursorHistory.length < 2 ||
				state.status === 'loading' ||
				state.status === 'refreshing'
			)
				return;
			const history = state.cursorHistory.slice(0, -1);
			await load(history[history.length - 1], history);
		},
		async retry() {
			if (state.cooldownUntil !== null && now() < state.cooldownUntil) return;
			await load(lastAttempt.cursor, [...lastAttempt.history]);
		},
		dispose() {
			scope.invalidate();
			listeners.clear();
			state = { ...EMPTY };
			query = null;
		}
	};
	return controller;
}

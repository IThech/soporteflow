/**
 * Request staleness guard (UI-1A, A2).
 *
 * Problem: a request started for organization A can resolve after the user switched to B; its
 * data, capabilities or 401 must then be ignored. AbortController alone is not enough (a response
 * may already be resolving, and fetch implementations differ), so every request carries:
 * - an AbortSignal (cancel network work early);
 * - a generation number (monotonic, bumped on every invalidation);
 * - the context key it belongs to (`<userId>:<organizationId>`).
 * A result is accepted only if its generation is still current AND the scope's context key is
 * unchanged. Pure TypeScript, no Svelte: unit-testable in Node.
 */

export class StaleRequestError extends Error {
	constructor() {
		super('STALE_REQUEST');
		this.name = 'StaleRequestError';
	}
}

export function isStaleRequest(error: unknown): boolean {
	return (
		error instanceof StaleRequestError ||
		(error as { name?: unknown } | null)?.name === 'StaleRequestError' ||
		(error as { name?: unknown } | null)?.name === 'AbortError'
	);
}

export interface RequestTicket {
	readonly generation: number;
	readonly contextKey: string;
	readonly signal: AbortSignal;
	/** true while no newer request/invalidation happened and the context is unchanged. */
	isCurrent(): boolean;
}

export interface RequestScope {
	/** Current context key ('' before any context). */
	readonly contextKey: string;
	/**
	 * Switches context (e.g. organization change): aborts in-flight work and bumps the generation
	 * so every older ticket becomes stale, even if its response is already in hand.
	 */
	setContext(contextKey: string): void;
	/** Starts a request in the current context; aborts the previous one of this scope. */
	begin(): RequestTicket;
	/** Aborts everything and makes every ticket stale (unmount, sign-out). */
	invalidate(): void;
	/**
	 * Runs `task` and returns its result only if still current; otherwise throws
	 * StaleRequestError (callers ignore it silently).
	 */
	run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export function createRequestScope(initialContextKey = ''): RequestScope {
	let generation = 0;
	let contextKey = initialContextKey;
	let controller: AbortController | null = null;

	function abortInFlight() {
		controller?.abort();
		controller = null;
	}

	const scope: RequestScope = {
		get contextKey() {
			return contextKey;
		},
		setContext(next) {
			if (next === contextKey) return;
			contextKey = next;
			generation++;
			abortInFlight();
		},
		begin() {
			abortInFlight();
			const mine = ++generation;
			const key = contextKey;
			const own = new AbortController();
			controller = own;
			return {
				generation: mine,
				contextKey: key,
				signal: own.signal,
				isCurrent: () => mine === generation && key === contextKey && !own.signal.aborted
			};
		},
		invalidate() {
			generation++;
			abortInFlight();
		},
		async run(task) {
			const ticket = scope.begin();
			try {
				const result = await task(ticket.signal);
				if (!ticket.isCurrent()) throw new StaleRequestError();
				return result;
			} catch (error) {
				if (!ticket.isCurrent()) throw new StaleRequestError();
				throw error;
			}
		}
	};
	return scope;
}

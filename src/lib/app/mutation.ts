import { ApiError, isApiError, networkApiError } from '../api/errors.ts';

/**
 * UI-2A — pessimistic mutations with an explicit UNKNOWN outcome.
 *
 * Contracts of the backend (POST/PATCH of incidents, comments, notes): no idempotency key. So:
 * - a mutation is sent ONCE; nothing here ever retries it (not even on 5xx/429/network);
 * - the request is NOT tied to an AbortSignal: aborting a fetch the server already received
 *   does not undo it, it only loses the answer. A context switch makes the result stale instead;
 * - a definite answer from the server is `success` or `error` (the server did not apply it);
 * - a lost/unreadable answer after sending is `unknown`: the UI must say "No se pudo confirmar el
 *   resultado. Comprueba el estado antes de repetir la acción." and never claim success;
 * - a result whose context (user/org/generation/incident) changed meanwhile is `stale`: the caller
 *   applies NOTHING (no data, error, 401 handling, navigation or draft change).
 */

export type MutationState<T> =
	| { readonly status: 'idle' }
	| { readonly status: 'pending' }
	| { readonly status: 'success'; readonly value: T }
	| { readonly status: 'error'; readonly error: ApiError }
	| { readonly status: 'unknown'; readonly error: ApiError };

export type MutationResult<T> =
	| Exclude<MutationState<T>, { status: 'idle' } | { status: 'pending' }>
	/** The context changed while the request was in flight: apply nothing. */
	| { readonly status: 'stale' }
	/** Another mutation of this channel is still pending: nothing was sent. */
	| { readonly status: 'busy' };

export const UNKNOWN_OUTCOME_MESSAGE =
	'No se pudo confirmar el resultado. Comprueba el estado antes de repetir la acción.';

/**
 * true when the request may have reached the server but its answer is unusable:
 * - network failure / timeout / abort after sending (status 0, not a pre-send INVALID_INPUT);
 * - 502/504 (a gateway lost the upstream answer);
 * - a 2xx whose body could not be validated (the server applied it; we cannot show it).
 * Any other HTTP error is a definite answer of the application (its transaction did not commit).
 */
export function isUncertainMutationFailure(error: unknown): boolean {
	if (!isApiError(error)) return true;
	if (error.code === 'INVALID_PAYLOAD') return true;
	if (error.status === 0) return error.code !== 'INVALID_INPUT';
	return error.status === 502 || error.status === 504;
}

function asApiError(error: unknown): ApiError {
	return isApiError(error) ? error : networkApiError();
}

export interface MutationChannel {
	/** Context of the channel (tenant + resource key); a change makes pending results stale. */
	setContext(contextKey: string): void;
	readonly pending: boolean;
	/**
	 * Runs `send` once in the current context. Pre-send validation errors (ApiError status 0
	 * INVALID_INPUT thrown before any request) are `error`: nothing was sent.
	 */
	run<T>(send: () => Promise<T>): Promise<MutationResult<T>>;
	/** Unmount: every pending result becomes stale. */
	dispose(): void;
}

export function createMutationChannel(initialContextKey = ''): MutationChannel {
	let contextKey = initialContextKey;
	let epoch = 0;
	/** Pending mutations of the CURRENT context only (an old context never blocks a new one). */
	let inFlight = 0;
	return {
		setContext(next) {
			if (next === contextKey) return;
			contextKey = next;
			epoch++;
			inFlight = 0;
		},
		get pending() {
			return inFlight > 0;
		},
		async run(send) {
			if (inFlight > 0) return { status: 'busy' };
			const mine = epoch;
			const current = () => mine === epoch;
			inFlight++;
			try {
				const value = await send();
				return current() ? { status: 'success', value } : { status: 'stale' };
			} catch (error) {
				if (!current()) return { status: 'stale' };
				const apiError = asApiError(error);
				return isUncertainMutationFailure(error)
					? { status: 'unknown', error: apiError }
					: { status: 'error', error: apiError };
			} finally {
				if (current()) inFlight--;
			}
		},
		dispose() {
			epoch++;
			inFlight = 0;
		}
	};
}

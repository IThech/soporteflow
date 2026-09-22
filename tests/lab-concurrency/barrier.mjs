/**
 * Deterministic synchronization primitives for concurrent multi-transaction testing.
 * Replaces unreliable setTimeout/sleep with strict Promise-based rendezvous and latches.
 */

/**
 * Creates a rendezvous barrier where N parties must arrive before any party proceeds.
 * Times out if all parties do not arrive within timeoutMs. Supports explicit abort to
 * avoid dangling asynchronous waiters on early errors.
 *
 * @param {string} name - Diagnostic name for the barrier
 * @param {number} parties - Number of concurrent operations that must arrive (default 2)
 * @param {number} timeoutMs - Max wait time before failing (default 8000ms)
 */
export function createBarrier(name, parties = 2, timeoutMs = 8000) {
	let arrived = 0;
	let settled = false;
	const waiters = [];
	const rejecters = [];

	let timer = null;
	const timeoutPromise = new Promise((_, reject) => {
		timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				reject(
					new Error(
						`[BARRIER TIMEOUT] Barrier '${name}' timed out after ${timeoutMs}ms (${arrived}/${parties} arrived)`
					)
				);
			}
		}, timeoutMs);
	});

	async function wait() {
		if (settled) {
			throw new Error(`[BARRIER ERROR] Barrier '${name}' already settled or timed out.`);
		}

		arrived++;
		if (arrived === parties) {
			settled = true;
			clearTimeout(timer);
			for (const resolver of waiters) {
				resolver();
			}
			return;
		}

		const waitPromise = new Promise((resolve, reject) => {
			waiters.push(resolve);
			rejecters.push(reject);
		});

		await Promise.race([waitPromise, timeoutPromise]);
	}

	function abort(err = new Error(`[BARRIER ABORTED] Barrier '${name}' was aborted.`)) {
		if (!settled) {
			settled = true;
			clearTimeout(timer);
			for (const rejectFn of rejecters) {
				rejectFn(err);
			}
		}
	}

	function reset() {
		clearTimeout(timer);
		arrived = 0;
		settled = false;
		waiters.length = 0;
		rejecters.length = 0;
	}

	return {
		name,
		wait,
		abort,
		reset,
		get arrived() {
			return arrived;
		},
		get settled() {
			return settled;
		}
	};
}

/**
 * Creates a single-shot coordination signal between two asynchronous routines.
 * Routine A can wait() until Routine B calls notify() or abort().
 *
 * @param {string} name - Diagnostic name for the signal
 * @param {number} timeoutMs - Max wait time before failing (default 8000ms)
 */
export function createSignal(name, timeoutMs = 8000) {
	let resolved = false;
	let resolver = null;
	let rejecter = null;

	let timer = null;
	const timeoutPromise = new Promise((_, reject) => {
		timer = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				reject(new Error(`[SIGNAL TIMEOUT] Signal '${name}' timed out after ${timeoutMs}ms`));
			}
		}, timeoutMs);
	});

	const signalPromise = new Promise((resolve, reject) => {
		resolver = resolve;
		rejecter = reject;
	});

	function notify(value) {
		if (!resolved) {
			resolved = true;
			clearTimeout(timer);
			resolver(value);
		}
	}

	function abort(err = new Error(`[SIGNAL ABORTED] Signal '${name}' was aborted.`)) {
		if (!resolved) {
			resolved = true;
			clearTimeout(timer);
			rejecter(err);
		}
	}

	async function wait() {
		return Promise.race([signalPromise, timeoutPromise]);
	}

	return {
		name,
		notify,
		abort,
		wait,
		get settled() {
			return resolved;
		}
	};
}

/**
 * Immediately dispatches a postgres.js query over the wire.
 * In postgres.js, Query is lazy and does not transmit over the socket until
 * .then() or .execute() is attached. This function attaches handlers immediately,
 * ensuring the query packet is sent to PostgreSQL before lock polling begins,
 * while returning a Promise that resolves or rejects when the query completes.
 *
 * @param {Promise<any> & { execute?: Function }} query - The postgres.js Query object
 * @returns {Promise<any>}
 */
export function dispatchQuery(query) {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});

	// Attaching .then immediately triggers query.handle() and transmission to PostgreSQL
	query.then(resolve, reject);

	return promise;
}

/**
 * Polls pg_stat_activity using an independent observer connection to verify
 * that a target query is genuinely in a lock wait state (wait_event_type = 'Lock')
 * in the PostgreSQL engine, rather than merely queued in the Node.js event loop.
 *
 * @param {import('postgres').Sql} sqlObserver - Dedicated observer connection
 * @param {string} querySubstring - Substring matching the blocked query
 * @param {number} timeoutMs - Max polling duration (default 3000ms)
 * @returns {Promise<Object>} The row in pg_stat_activity confirming the active lock wait
 */
export async function pollPgLock(sqlObserver, querySubstring, timeoutMs = 3000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const rows = await sqlObserver`
			SELECT pid, wait_event_type, wait_event, state, query
			FROM pg_stat_activity
			WHERE datname = 'soporteflow_concurrency_lab'
			  AND pid <> pg_backend_pid()
			  AND query LIKE ${'%' + querySubstring + '%'}
		`;

		const waitingRow = rows.find((r) => r.wait_event_type === 'Lock');
		if (waitingRow) {
			return waitingRow;
		}

		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	throw new Error(
		`[LOCK VERIFICATION FAILED] Query '${querySubstring}' was not observed in wait_event_type='Lock' in pg_stat_activity within ${timeoutMs}ms.`
	);
}

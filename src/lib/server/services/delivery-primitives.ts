/**
 * Small primitives shared by the delivery outboxes (5.4X-C). Deliberately not a generic outbox:
 * each outbox keeps its own claim/mark SQL (different tables, states and terminal semantics);
 * only the pure, identical pieces live here. Used by the invitation outbox; the notification and
 * webhook outboxes keep their CT 105-validated inline copies (behavior identical).
 */

/** Delay after failed attempt n (1-based) before attempt n + 1: 1 min, 5 min, 30 min, 2 h. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
	60_000,
	5 * 60_000,
	30 * 60_000,
	2 * 60 * 60_000
]);

/** Next attempt after failed attempt `attemptCount`, or null when attempts are exhausted. */
export function nextRetryAt(
	attemptCount: number,
	maxAttempts: number,
	delaysMs: readonly number[],
	now: Date
): Date | null {
	if (attemptCount >= maxAttempts) return null;
	const delay = delaysMs[attemptCount - 1];
	return delay === undefined ? null : new Date(now.getTime() + delay);
}

/** Races `work` against a timer; the timer is always cleared. */
export async function withTimeout<T>(
	work: Promise<T>,
	timeoutMs: number,
	onTimeout: () => Error
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(onTimeout()), timeoutMs);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

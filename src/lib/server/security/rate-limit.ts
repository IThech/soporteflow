/**
 * Minimal fixed-window rate limiter (5.4S-D) for the public invitation endpoints.
 *
 * LIMITATION (by design, to be replaced in 5.4W): state lives in this process's memory. It is
 * reset on restart and NOT shared between instances, so it is a per-instance brake, not a
 * distributed guarantee. Memory is bounded: expired windows are swept and, above maxKeys, the
 * oldest keys are evicted. Keys must never contain raw secrets (callers pass hashes).
 */

export interface RateLimitDecision {
	readonly allowed: boolean;
	/** Seconds until the current window resets (0 when allowed). */
	readonly retryAfterSeconds: number;
}

export interface RateLimiterOptions {
	readonly limit: number;
	readonly windowMs: number;
	readonly maxKeys?: number;
	/** Injectable clock for tests. */
	readonly now?: () => number;
}

export class FixedWindowRateLimiter {
	readonly limit: number;
	readonly windowMs: number;
	private readonly maxKeys: number;
	private readonly now: () => number;
	private readonly windows = new Map<string, { count: number; resetAt: number }>();

	constructor(options: RateLimiterOptions) {
		if (!Number.isInteger(options.limit) || options.limit < 1)
			throw new Error('limit must be a positive integer');
		if (!Number.isFinite(options.windowMs) || options.windowMs <= 0)
			throw new Error('windowMs must be positive');
		this.limit = options.limit;
		this.windowMs = options.windowMs;
		this.maxKeys = options.maxKeys ?? 10_000;
		this.now = options.now ?? (() => Date.now());
	}

	/** Counts one attempt for key and says whether it is within the limit. */
	consume(key: string): RateLimitDecision {
		const now = this.now();
		let window = this.windows.get(key);
		if (!window || window.resetAt <= now) {
			if (!window) this.makeRoom(now);
			window = { count: 0, resetAt: now + this.windowMs };
			this.windows.set(key, window);
		}
		window.count += 1;
		if (window.count > this.limit)
			return {
				allowed: false,
				retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000))
			};
		return { allowed: true, retryAfterSeconds: 0 };
	}

	get size(): number {
		return this.windows.size;
	}

	reset(): void {
		this.windows.clear();
	}

	private makeRoom(now: number): void {
		if (this.windows.size < this.maxKeys) return;
		for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
		// Still full: evict the oldest windows (Map keeps insertion order).
		for (const key of this.windows.keys()) {
			if (this.windows.size < this.maxKeys) break;
			this.windows.delete(key);
		}
	}
}

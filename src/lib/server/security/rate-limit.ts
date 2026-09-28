/** Single-process fixed windows. No timers, raw identifiers or live-window eviction. */
export interface RateLimitDecision {
	readonly allowed: boolean;
	readonly retryAfterSeconds: number;
}
export interface RateLimiterOptions {
	readonly limit: number;
	readonly windowMs: number;
	readonly maxKeys?: number;
	readonly now?: () => number;
}
export class FixedWindowRateLimiter {
	readonly limit: number;
	readonly windowMs: number;
	private readonly maxKeys: number;
	private readonly now: () => number;
	private lastNow = 0;
	private readonly windows = new Map<string, { count: number; resetAt: number }>();
	constructor(options: RateLimiterOptions) {
		if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('INVALID_LIMIT');
		if (!Number.isFinite(options.windowMs) || options.windowMs <= 0)
			throw new Error('INVALID_WINDOW');
		if (!Number.isInteger(options.maxKeys ?? 10000) || (options.maxKeys ?? 10000) < 1)
			throw new Error('INVALID_CAPACITY');
		this.limit = options.limit;
		this.windowMs = options.windowMs;
		this.maxKeys = options.maxKeys ?? 10000;
		this.now = options.now ?? (() => Date.now());
	}
	consume(key: string): RateLimitDecision {
		if (typeof key !== 'string' || key.length > 256) throw new Error('INVALID_KEY');
		const rawNow = this.now();
		if (!Number.isFinite(rawNow)) throw new Error('INVALID_CLOCK');
		const now = (this.lastNow = Math.max(this.lastNow, rawNow));
		// Equal window lengths + monotonic insertion times mean expired entries form a prefix.
		for (const [id, item] of this.windows) {
			if (item.resetAt > now) break;
			this.windows.delete(id);
		}
		let window = this.windows.get(key);
		if (!window) {
			if (this.windows.size >= this.maxKeys) {
				const earliest = this.windows.values().next().value!;
				return {
					allowed: false,
					retryAfterSeconds: Math.max(1, Math.ceil((earliest.resetAt - now) / 1000))
				};
			}
			window = { count: 0, resetAt: now + this.windowMs };
			this.windows.set(key, window);
		}
		if (window.count >= this.limit)
			return {
				allowed: false,
				retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000))
			};
		window.count++;
		return { allowed: true, retryAfterSeconds: 0 };
	}
	get size() {
		return this.windows.size;
	}
	reset() {
		this.windows.clear();
		this.lastNow = 0;
	}
}
export function rateLimitedResponse(seconds: number): Response {
	return Response.json(
		{ error: { code: 'RATE_LIMITED', message: 'Too many requests.' } },
		{
			status: 429,
			headers: {
				'Retry-After': String(Math.max(1, Math.ceil(seconds))),
				'Cache-Control': 'private, no-store'
			}
		}
	);
}

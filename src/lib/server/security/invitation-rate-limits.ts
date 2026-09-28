import { createHmac, randomBytes } from 'node:crypto';
const salt = randomBytes(32);
import { FixedWindowRateLimiter, type RateLimitDecision } from './rate-limit';

/**
 * Rate limits of the public invitation endpoints (5.4S-D). In-memory, per instance: see
 * FixedWindowRateLimiter; distributed storage is required before horizontal scaling.
 *
 * Two keys per request, both must pass:
 * - per submitted token (its process-salted HMAC-SHA-256, never the raw value): stops hammering one invitation;
 * - per client address, provided by the platform (unknown shares a bucket) (event.getClientAddress, configured
 *   by the adapter; X-Forwarded-For is never read here): slows token guessing across tokens.
 */
const MINUTE = 60_000;

function build(now?: () => number) {
	return {
		verifyToken: new FixedWindowRateLimiter({ limit: 10, windowMs: MINUTE, now }),
		verifyClient: new FixedWindowRateLimiter({ limit: 60, windowMs: MINUTE, now }),
		acceptToken: new FixedWindowRateLimiter({ limit: 5, windowMs: 15 * MINUTE, now }),
		acceptClient: new FixedWindowRateLimiter({ limit: 20, windowMs: 15 * MINUTE, now })
	};
}

let limiters = build();

/** Tests only: fresh windows and an optional controllable clock. */
export function resetInvitationRateLimits(now?: () => number): void {
	limiters = build(now);
}

function tokenKey(token: unknown): string {
	return createHmac('sha256', salt)
		.update(typeof token === 'string' ? token.trim() : '')
		.digest('hex');
}

function check(
	tokenLimiter: FixedWindowRateLimiter,
	clientLimiter: FixedWindowRateLimiter,
	token: unknown,
	clientAddress: string | null
): RateLimitDecision {
	const clientDecision = clientLimiter.consume(tokenKey(clientAddress ?? 'unknown'));
	if (!clientDecision.allowed) return clientDecision;
	const decisions = [tokenLimiter.consume(tokenKey(token))];
	const denied = decisions.filter((decision) => !decision.allowed);
	if (denied.length === 0) return { allowed: true, retryAfterSeconds: 0 };
	return {
		allowed: false,
		retryAfterSeconds: Math.max(...denied.map((decision) => decision.retryAfterSeconds))
	};
}

export function limitInvitationVerify(
	token: unknown,
	clientAddress: string | null
): RateLimitDecision {
	return check(limiters.verifyToken, limiters.verifyClient, token, clientAddress);
}

export function limitInvitationAccept(
	token: unknown,
	clientAddress: string | null
): RateLimitDecision {
	return check(limiters.acceptToken, limiters.acceptClient, token, clientAddress);
}

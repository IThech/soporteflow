import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { RequestEvent } from '@sveltejs/kit';
import { FixedWindowRateLimiter, rateLimitedResponse, type RateLimitDecision } from './rate-limit';
import { resolvePrincipal } from '../auth/principal';
import { verifyOrganizationMembership } from '../auth/authorization';

const MINUTE = 60000;
export const ABUSE_POLICIES = {
	flood: { limit: 600, windowMs: MINUTE },
	loginBurst: { limit: 5, windowMs: 10000 },
	loginIp: { limit: 20, windowMs: 15 * MINUTE },
	loginIdentity: { limit: 10, windowMs: 15 * MINUTE },
	readUser: { limit: 120, windowMs: MINUTE },
	readOrg: { limit: 600, windowMs: MINUTE },
	writeUser: { limit: 60, windowMs: MINUTE },
	writeOrg: { limit: 300, windowMs: MINUTE },
	incidentUser: { limit: 20, windowMs: MINUTE },
	incidentOrg: { limit: 100, windowMs: MINUTE },
	messageUser: { limit: 30, windowMs: MINUTE },
	messageOrg: { limit: 200, windowMs: MINUTE },
	invitationUser: { limit: 10, windowMs: 15 * MINUTE },
	invitationOrg: { limit: 50, windowMs: 15 * MINUTE },
	adminUser: { limit: 30, windowMs: MINUTE },
	adminOrg: { limit: 120, windowMs: MINUTE }
} as const;
type Policy = keyof typeof ABUSE_POLICIES;
/** A distributed replacement must implement atomic consume, TTL and capacity behavior. */
export interface AbuseStore {
	consume(policy: Policy, key: string): RateLimitDecision | Promise<RateLimitDecision>;
}
export function memoryAbuseStore(now?: () => number, maxKeys = 10000): AbuseStore {
	const maps = new Map<Policy, FixedWindowRateLimiter>();
	return {
		consume(policy, key) {
			let limiter = maps.get(policy);
			if (!limiter) {
				limiter = new FixedWindowRateLimiter({ ...ABUSE_POLICIES[policy], now, maxKeys });
				maps.set(policy, limiter);
			}
			return limiter.consume(key);
		}
	};
}
const salt = randomBytes(32);
export function abuseKey(...parts: string[]): string {
	return createHmac('sha256', salt).update(JSON.stringify(parts)).digest('hex');
}
/** Adapter peer only. Forwarded headers are never read. Missing address shares a restrictive bucket. */
export function trustedClientAddress(event: Pick<RequestEvent, 'getClientAddress'>): string {
	try {
		const address = event.getClientAddress();
		if (!isIP(address)) return 'unknown';
		if (address.toLowerCase().startsWith('::ffff:') && isIP(address.slice(7)) === 4)
			return address.slice(7);
		return isIP(address) === 6 ? new URL('http://[' + address + ']/').hostname : address;
	} catch {
		return 'unknown';
	}
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface AbuseDependencies {
	store?: AbuseStore;
	principal?: typeof resolvePrincipal;
	membership?: typeof verifyOrganizationMembership;
}
/** Runs AFTER W-C structural/Origin validation, BEFORE handlers. Never grants authorization. */
export function createApiAbuseGuard(deps: AbuseDependencies = {}) {
	const store = deps.store ?? memoryAbuseStore();
	const principal = deps.principal ?? resolvePrincipal;
	const membership = deps.membership ?? verifyOrganizationMembership;
	async function check(entries: [Policy, string][], closed: boolean): Promise<Response | null> {
		try {
			// Consume in order; a denied IP/user never spends another identity/tenant's budget.
			for (const [policy, key] of entries) {
				const result = await store.consume(policy, key);
				if (!result.allowed) return rateLimitedResponse(result.retryAfterSeconds);
			}
			return null;
		} catch {
			return closed
				? Response.json(
						{ error: { code: 'LIMITER_UNAVAILABLE', message: 'Service temporarily unavailable.' } },
						{ status: 503, headers: { 'Retry-After': '30', 'Cache-Control': 'private, no-store' } }
					)
				: null;
		}
	}
	return async (event: RequestEvent): Promise<Response | null> => {
		let path: string;
		try {
			path = decodeURIComponent(event.url.pathname).replace(/\/+$/, '');
		} catch {
			return null;
		}
		if (!path.startsWith('/api/')) return null;
		const method = event.request.method;
		const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
		const ip = abuseKey('ip', trustedClientAddress(event));
		const flood = await check([['flood', ip]], mutation);
		if (flood) return flood;
		if (path.startsWith('/api/auth/')) {
			if (method !== 'POST' || path !== '/api/auth/sign-in/email') return null;
			const denied = await check(
				[
					['loginBurst', ip],
					['loginIp', ip]
				],
				true
			);
			if (denied) return denied;
			const body = await event.request
				.clone()
				.json()
				.catch(() => null);
			if (typeof body?.email !== 'string' || body.email.length > 320) return null;
			return check([['loginIdentity', abuseKey('email', body.email.trim().toLowerCase())]], true);
		}
		if (path === '/api/invitations/verify' || path === '/api/invitations/accept') return null;
		const actor = await principal(event.request.headers);
		if (!actor) return null; // Authoritative route retains its existing 401/403 behavior.
		let org = event.url.searchParams.get('organizationId');
		if (path === '/api/incidents' && method === 'POST') {
			const body = await event.request
				.clone()
				.json()
				.catch(() => null);
			org = typeof body?.organizationId === 'string' ? body.organizationId : null;
		}
		if (org !== null) {
			if (!uuid.test(org)) return null;
			const member = await membership(event.request.headers, org);
			if (!member || member.userId !== actor.userId) return null;
		}
		let pair: [Policy, Policy] = mutation ? ['writeUser', 'writeOrg'] : ['readUser', 'readOrg'];
		if (mutation && path.startsWith('/api/invitations')) pair = ['invitationUser', 'invitationOrg'];
		else if (method === 'POST' && path === '/api/incidents') pair = ['incidentUser', 'incidentOrg'];
		else if (mutation && /\/(comments|internal-notes)$/.test(path))
			pair = ['messageUser', 'messageOrg'];
		else if (
			mutation &&
			/^\/api\/(webhooks|automations|roles|memberships|sla-policies|sites|categories)(\/|$)/.test(
				path
			)
		)
			pair = ['adminUser', 'adminOrg'];
		const entries: [Policy, string][] = [[pair[0], abuseKey('user', actor.userId)]];
		if (org) entries.push([pair[1], abuseKey('org', org.toLowerCase())]);
		return check(entries, mutation);
	};
}
export const limitApiAbuse = createApiAbuseGuard();

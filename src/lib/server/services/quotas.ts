/**
 * Technical resource limits per organization (5.4X-D). NOT billing and NOT commercial plans.
 *
 * Each limit has a hard TECHNICAL CEILING — the maximum the Core supports safely for abuse/cost
 * reasons (e.g. every active webhook multiplies outbound fan-out per event; every active rule is
 * evaluated per event). Operators may LOWER a limit with an env variable (future commercial plans
 * plug in here); a value above the ceiling is rejected at startup, never silently raised.
 *
 * Ceilings reuse the precedent already in production code (100 active automation rules since
 * 5.4V-C); webhooks get the same ceiling. Enforcement counts ACTIVE rows inside the mutating
 * transaction; under concurrent creations the count is a soft limit (it can be exceeded by the
 * number of simultaneous requests), acceptable for a technical guard.
 */

export const QUOTAS = {
	activeWebhooks: { env: 'QUOTA_MAX_ACTIVE_WEBHOOKS', ceiling: 100 },
	activeAutomationRules: { env: 'QUOTA_MAX_ACTIVE_AUTOMATION_RULES', ceiling: 100 }
} as const;
export type QuotaKind = keyof typeof QUOTAS;

export class QuotaConfigurationError extends Error {
	constructor(readonly variable: string) {
		super(`${variable} must be an integer between 1 and its technical ceiling`);
		this.name = 'QuotaConfigurationError';
	}
}

/** Effective limit: env override (1..ceiling) or the ceiling. Throws on an invalid override. */
export function quotaLimit(
	kind: QuotaKind,
	env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {}
): number {
	const { env: variable, ceiling } = QUOTAS[kind];
	const raw = env[variable]?.trim();
	if (!raw) return ceiling;
	if (!/^\d{1,6}$/.test(raw)) throw new QuotaConfigurationError(variable);
	const value = Number(raw);
	if (value < 1 || value > ceiling) throw new QuotaConfigurationError(variable);
	return value;
}

/** Startup validation helper: names of misconfigured quota variables (never values). */
export function invalidQuotaVariables(env: Record<string, string | undefined>): string[] {
	const invalid: string[] = [];
	for (const kind of Object.keys(QUOTAS) as QuotaKind[]) {
		try {
			quotaLimit(kind, env);
		} catch {
			invalid.push(QUOTAS[kind].env);
		}
	}
	return invalid;
}

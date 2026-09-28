/** Private configuration: never import from client code. */
export class AuthConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AuthConfigurationError';
	}
}
/** Well-known defaults/placeholders, compared on the whole trimmed value. */
const PLACEHOLDER_SECRET =
	/^(change[-_ ]?me|secret|password|default|example|test(ing)?|dummy|placeholder|your[-_ ]?secret|x+|0+|1+|a+|1234567890*)$/i;
/** Minimum distinct characters: 32 random base64/hex characters comfortably exceed it. */
export const MIN_SECRET_DISTINCT_CHARS = 10;
/**
 * 5.4W-E: trivial or default secrets are rejected in every mode (never logged or echoed). A
 * random 32+ character value always passes; `aaaa…`, `changeme…` repeated or `1234…` do not.
 */
export function isTrivialSecret(secret: string): boolean {
	const value = secret.trim();
	return (
		PLACEHOLDER_SECRET.test(value) ||
		new Set(value).size < MIN_SECRET_DISTINCT_CHARS ||
		// a short unit repeated 3+ times from the start (e.g. `1234567890` x3, `changeme` x4)
		/^(.{1,16})\1{2,}/.test(value)
	);
}
export type AuthConfig =
	{ enabled: false } | { enabled: true; secret: string; origin: string; secureCookies: boolean };
export function readAuthConfig(
	env: Record<string, string | undefined>,
	development = false
): AuthConfig {
	const flag = env.BETTER_AUTH_ENABLED;
	if (flag === undefined || flag === '' || flag === 'false') return { enabled: false };
	if (flag !== 'true')
		throw new AuthConfigurationError('BETTER_AUTH_ENABLED debe ser true o false.');
	const secret = env.BETTER_AUTH_SECRET;
	if (!secret || secret.trim().length < 32 || isTrivialSecret(secret))
		throw new AuthConfigurationError(
			'BETTER_AUTH_SECRET requiere al menos 32 caracteres y generación aleatoria.'
		);
	let url: URL;
	try {
		url = new URL(env.BETTER_AUTH_URL ?? '');
	} catch {
		throw new AuthConfigurationError('BETTER_AUTH_URL no es válida.');
	}
	const localHttp =
		development &&
		url.protocol === 'http:' &&
		['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if (
		(url.protocol !== 'https:' && !localHttp) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/'
	) {
		throw new AuthConfigurationError(
			'BETTER_AUTH_URL debe ser un origen HTTPS; HTTP local solo en desarrollo.'
		);
	}
	try {
		const database = new URL(env.DATABASE_URL ?? '');
		if (
			!['postgres:', 'postgresql:'].includes(database.protocol) ||
			!database.hostname ||
			database.pathname.length < 2
		)
			throw new Error();
	} catch {
		throw new AuthConfigurationError('DATABASE_URL de PostgreSQL no es válida.');
	}
	return { enabled: true, secret, origin: url.origin, secureCookies: url.protocol === 'https:' };
}

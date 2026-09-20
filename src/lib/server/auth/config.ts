/** Private configuration: never import from client code. */
export class AuthConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AuthConfigurationError';
	}
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
	if (!secret || secret.trim().length < 32)
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

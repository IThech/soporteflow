import { building, dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getDb } from '../db';
import { authUsers, authAccounts, authSessions, authVerifications } from '../db/schema';
import { readAuthConfig } from './config';

export type AuthTransaction = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];
function createInstance(
	config: Extract<ReturnType<typeof readAuthConfig>, { enabled: true }>,
	database: ReturnType<typeof getDb> | AuthTransaction = getDb()
) {
	return betterAuth({
		secret: config.secret,
		baseURL: config.origin,
		trustedOrigins: [config.origin],
		database: drizzleAdapter(database, {
			provider: 'pg',
			transaction: true,
			schema: {
				user: authUsers,
				account: authAccounts,
				session: authSessions,
				verification: authVerifications
			}
		}),
		advanced: {
			database: { generateId: 'uuid' },
			useSecureCookies: config.secureCookies,
			cookiePrefix: 'soporteflow-auth',
			defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
			disableCSRFCheck: false,
			disableOriginCheck: false
		},
		emailAndPassword: { enabled: false, disableSignUp: true },
		user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },
		session: { cookieCache: { enabled: false } },
		disabledPaths: [
			'/get-session',
			'/sign-up/email',
			'/request-password-reset',
			'/reset-password',
			'/change-email',
			'/delete-user',
			'/delete-user/callback'
		],
		// Phase B permits only a direct, uncached, non-renewing server session lookup.
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (
					ctx.path === '/get-session' &&
					!ctx.request &&
					ctx.query?.disableCookieCache === true &&
					ctx.query?.disableRefresh === true
				)
					return;
				throw new APIError('FORBIDDEN', { message: 'Autenticación no habilitada en esta fase.' });
			})
		},
		rateLimit: { enabled: true },
		telemetry: { enabled: false },
		// Do not forward driver errors, tokens or SQL parameters to application logs.
		logger: { disabled: true }
	});
}
let instance: ReturnType<typeof createInstance> | undefined;
/** No instance, environment validation or database access at module import/build time. */
export function getAuth() {
	if (building) return null;
	const config = readAuthConfig(
		{ ...env, DATABASE_URL: env.DATABASE_URL || process.env.DATABASE_URL },
		dev
	);
	if (!config.enabled) return null;
	return (instance ??= createInstance(config));
}

/** Internal: never cached; all adapter operations use the supplied transaction. */
export function getTransactionAuth(tx: AuthTransaction) {
	if (building) return null;
	const config = readAuthConfig(
		{ ...env, DATABASE_URL: env.DATABASE_URL || process.env.DATABASE_URL },
		dev
	);
	return config.enabled ? createInstance(config, tx) : null;
}

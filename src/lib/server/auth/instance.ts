import { building, dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getDb } from '../db';
import { authUsers, authAccounts, authSessions, authVerifications } from '../db/schema';
import { readAuthConfig } from './config';

function createInstance(config: Extract<ReturnType<typeof readAuthConfig>, { enabled: true }>) {
	return betterAuth({
		secret: config.secret,
		baseURL: config.origin,
		trustedOrigins: [config.origin],
		database: drizzleAdapter(getDb(), {
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
			'/sign-up/email',
			'/request-password-reset',
			'/reset-password',
			'/change-email',
			'/delete-user',
			'/delete-user/callback'
		],
		// Phase A creates configuration only. Even direct server API calls must remain closed.
		hooks: {
			before: createAuthMiddleware(async () => {
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

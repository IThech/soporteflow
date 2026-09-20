import { and, eq } from 'drizzle-orm';
import { getAuth, getTransactionAuth, type AuthTransaction } from './instance';
import { getDb } from '../db';
import { users, authSessions } from '../db/schema';

/** Identity only: does not grant organization access or permissions. */
export type AuthenticatedPrincipal = Readonly<{ userId: string }>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server request headers only. Never accepts a demo user or a client-supplied userId. */
export async function resolvePrincipal(headers: Headers): Promise<AuthenticatedPrincipal | null> {
	try {
		if (!(headers instanceof Headers)) return null;
		const cookie = headers.get('cookie');
		if (!cookie) return null;
		const auth = getAuth();
		if (!auth) return null;
		// Forward only the credential cookie, not browser-selected identity/role headers.
		const validated = await auth.api.getSession({
			headers: new Headers({ cookie }),
			query: { disableCookieCache: true, disableRefresh: true }
		});
		if (!validated?.session || !validated.user) return null;
		const { userId, id, expiresAt } = validated.session;
		const expiry = new Date(expiresAt).getTime();
		if (
			typeof userId !== 'string' ||
			!uuid.test(userId) ||
			typeof id !== 'string' ||
			!uuid.test(id) ||
			validated.user.id !== userId ||
			!Number.isFinite(expiry) ||
			expiry <= Date.now()
		)
			return null;
		const [user] = await getDb()
			.select({ id: users.id })
			.from(users)
			.where(and(eq(users.id, userId), eq(users.active, true)))
			.limit(1);
		if (!user || user.id !== userId || expiry <= Date.now()) return null;
		return Object.freeze({ userId: user.id });
	} catch {
		// Deny on configuration, session, network or database errors; never leak driver details.
		return null;
	}
}

/** Transaction-only identity. Locks prevent deletion/deactivation until transaction completion. */
export async function resolveTransactionPrincipal(
	headers: Headers,
	tx: AuthTransaction
): Promise<AuthenticatedPrincipal | null> {
	try {
		if (!(headers instanceof Headers) || !headers.get('cookie')) return null;
		const auth = getTransactionAuth(tx);
		if (!auth) return null;
		const result = await auth.api.getSession({
			headers: new Headers({ cookie: headers.get('cookie')! }),
			query: { disableCookieCache: true, disableRefresh: true }
		});
		if (
			!result?.session ||
			!result.user ||
			result.user.id !== result.session.userId ||
			!uuid.test(result.user.id) ||
			!uuid.test(result.session.id)
		)
			return null;
		const [session] = await tx
			.select({ userId: authSessions.userId, expiresAt: authSessions.expiresAt })
			.from(authSessions)
			.where(
				and(
					eq(authSessions.id, result.session.id),
					eq(authSessions.token, result.session.token),
					eq(authSessions.userId, result.user.id)
				)
			)
			.for('share');
		if (
			!session ||
			!Number.isFinite(session.expiresAt.getTime()) ||
			session.expiresAt.getTime() <= Date.now()
		)
			return null;
		const [user] = await tx
			.select({ id: users.id })
			.from(users)
			.where(and(eq(users.id, session.userId), eq(users.active, true)))
			.for('share');
		if (!user || session.expiresAt.getTime() <= Date.now()) return null;
		return Object.freeze({ userId: user.id });
	} catch {
		return null;
	}
}

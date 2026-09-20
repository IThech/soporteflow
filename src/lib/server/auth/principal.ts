import { and, eq } from 'drizzle-orm';
import { getAuth } from './instance';
import { getDb } from '../db';
import { users } from '../db/schema';

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

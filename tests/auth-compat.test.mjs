import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { fixture, identity } from './helpers/auth-fixture.mjs';

// Mandatory local dependency: missing package fails module loading, never skips.
test('Better Auth 1.7.5 public API with the actual 0001 credential constraint', async (t) => {
	const metadata = JSON.parse(
		fs.readFileSync(new URL('../package.json', import.meta.resolve('better-auth')), 'utf8')
	);
	assert.equal(metadata.version, '1.7.5');
	const f = await fixture(t),
		p = await identity(f);
	const password = 'Synthetic-only-password-0001!';
	await f.db.transaction(async (tx) => {
		await tx.insert(f.schema.authAccounts).values({
			userId: p.id,
			providerId: 'credential',
			accountId: p.id,
			password: await hashPassword(password)
		});
	});
	const auth = betterAuth({
		baseURL: 'https://auth.test',
		secret: 'synthetic-test-only-secret-0001-0123456789',
		database: drizzleAdapter(f.db, {
			provider: 'pg',
			transaction: true,
			schema: {
				user: f.schema.authUsers,
				account: f.schema.authAccounts,
				session: f.schema.authSessions,
				verification: f.schema.authVerifications
			}
		}),
		advanced: { database: { generateId: 'uuid' }, useSecureCookies: true },
		emailAndPassword: { enabled: true, disableSignUp: true },
		disabledPaths: ['/request-password-reset', '/reset-password', '/reset-password/:token'],
		session: { cookieCache: { enabled: false } },
		telemetry: { enabled: false },
		rateLimit: { enabled: false },
		logger: { disabled: true },
		onAPIError: { throw: true }
	});
	await assert.rejects(
		auth.api.signUpEmail({ body: { email: 'public@example.test', name: 'Public', password } })
	);
	await assert.rejects(
		auth.api.signInEmail({ body: { email: p.email, password: password + 'wrong' } })
	);
	const response = await auth.api.signInEmail({
		body: { email: p.email, password },
		asResponse: true
	});
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.user.id, p.id);
	const headers = new Headers({
		cookie: response.headers
			.getSetCookie()
			.map((v) => v.split(';')[0])
			.join('; ')
	});
	assert.ok(await auth.api.getSession({ headers }));
	const changed = password + 'new';
	await auth.api.changePassword({
		headers,
		body: { currentPassword: password, newPassword: changed, revokeOtherSessions: true }
	});
	const [account] = await f.db
		.select()
		.from(f.schema.authAccounts)
		.where(eq(f.schema.authAccounts.userId, p.id));
	assert.equal(account.accountId, p.id);
	assert.equal(account.providerId, 'credential');
	assert.ok(await verifyPassword({ hash: account.password, password: changed }));
	await assert.rejects(auth.api.signInEmail({ body: { email: p.email, password } }));
	const next = await auth.api.signInEmail({
		body: { email: p.email, password: changed },
		asResponse: true
	});
	assert.equal(next.status, 200);
	const nextHeaders = new Headers({
		cookie: next.headers
			.getSetCookie()
			.map((v) => v.split(';')[0])
			.join('; ')
	});
	await auth.api.signOut({ headers: nextHeaders });
	assert.equal(await auth.api.getSession({ headers: nextHeaders }), null);
	for (const route of ['request-password-reset', 'reset-password']) {
		const denied = await auth.handler(
			new Request('https://auth.test/api/auth/' + route, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: 'https://auth.test' },
				body: JSON.stringify({ email: p.email, token: 'synthetic', newPassword: changed })
			})
		);
		assert.equal(denied.status, 404);
	}
	assert.equal((await f.db.select().from(f.schema.authVerifications)).length, 0);
});

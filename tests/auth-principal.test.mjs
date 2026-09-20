import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createHmac, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { fixture, identity } from './helpers/auth-fixture.mjs';

// Explicit imports and isolated environment: no real PostgreSQL driver or .env can load.
function load(file, imports) {
	const module = { exports: {} };
	const source = ts.transpileModule(
		fs.readFileSync(new URL('../src/lib/server/auth/' + file, import.meta.url), 'utf8'),
		{
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
		}
	).outputText;
	vm.runInNewContext(
		source,
		{
			module,
			exports: module.exports,
			Headers,
			URL,
			process: { env: {} },
			require(id) {
				if (!Object.hasOwn(imports, id)) throw new Error('Unexpected dependency: ' + id);
				return imports[id];
			}
		},
		{ timeout: 1000 }
	);
	return module.exports;
}
const uid = randomUUID();
const sample = () => ({
	session: {
		id: randomUUID(),
		userId: uid,
		expiresAt: new Date(Date.now() + 60000),
		token: 'never-expose-token'
	},
	user: { id: uid, email: 'never-expose@example.test', name: 'Private name' }
});
const headers = () =>
	new Headers({
		cookie: 'synthetic-cookie',
		'x-user-id': 'demo-admin',
		'x-role': 'platform_admin'
	});
function resolver(getAuth, getDb, schema = { users: { id: {}, active: {} } }) {
	return load('principal.ts', {
		'./instance': { getAuth },
		'../db': { getDb },
		'../db/schema': schema,
		'drizzle-orm': { and, eq }
	}).resolvePrincipal;
}
function fake(result = sample(), rows = [{ id: uid }], error) {
	let authCalls = 0,
		dbCalls = 0,
		input;
	const resolve = resolver(
		() => {
			authCalls++;
			return {
				api: {
					getSession: async (args) => {
						input = args;
						if (error === 'session') throw new Error('secret-database-url');
						return result;
					}
				}
			};
		},
		() => {
			dbCalls++;
			if (error === 'database') throw new Error('password-token-private-query');
			return { select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }) };
		}
	);
	return { resolve, authCalls: () => authCalls, dbCalls: () => dbCalls, input: () => input };
}
test('Importing principal performs no auth initialization or database access', () => {
	const f = fake();
	assert.equal(f.authCalls(), 0);
	assert.equal(f.dbCalls(), 0);
});
test('Valid session produces only immutable userId and requires fresh non-renewing validation', async () => {
	const f = fake();
	const principal = await f.resolve(headers());
	assert.equal(JSON.stringify(principal), JSON.stringify({ userId: uid }));
	assert.ok(Object.isFrozen(principal));
	assert.equal(f.input().query.disableCookieCache, true);
	assert.equal(f.input().query.disableRefresh, true);
	assert.equal(f.input().headers.get('x-user-id'), null);
	assert.equal(f.input().headers.get('x-role'), null);
	assert.equal(Object.keys(principal).length, 1);
});
test('Missing session is denied before identity lookup', async () => {
	const f = fake(null);
	assert.equal(await f.resolve(headers()), null);
	assert.equal(f.dbCalls(), 0);
});
test('Expired or malformed expiry is denied before identity lookup', async () => {
	for (const expiry of [new Date(0), 'invalid']) {
		const s = sample();
		s.session.expiresAt = expiry;
		const f = fake(s);
		assert.equal(await f.resolve(headers()), null);
		assert.equal(f.dbCalls(), 0);
	}
});
test('Invalid or mismatched session identifiers are rejected', async () => {
	for (const change of [
		(s) => {
			s.session.userId = 'demo-admin';
		},
		(s) => {
			s.user.id = randomUUID();
		},
		(s) => {
			s.session.id = 'invalid';
		}
	]) {
		const s = sample();
		change(s);
		const f = fake(s);
		assert.equal(await f.resolve(headers()), null);
		assert.equal(f.dbCalls(), 0);
	}
});
test('Missing Core user is denied despite a validated session', async () => {
	const f = fake(sample(), []);
	assert.equal(await f.resolve(headers()), null);
});
test('Session and PostgreSQL failures deny access without exposing errors', async () => {
	for (const error of ['session', 'database']) {
		const f = fake(sample(), [{ id: uid }], error);
		assert.equal(await f.resolve(headers()), null);
	}
});
test('Demo objects, userId and forged identity headers cannot authenticate', async () => {
	const f = fake();
	for (const value of [
		{ id: uid, role: 'platform_admin' },
		uid,
		null,
		new Headers({ 'x-user-id': uid })
	])
		assert.equal(await f.resolve(value), null);
	assert.equal(f.authCalls(), 0);
	assert.equal(f.dbCalls(), 0);
});
test('Disabled or invalid configuration denies authentication without a fallback', async () => {
	const noDb = () => {
		throw new Error('Database must not be reached');
	};
	assert.equal(await resolver(() => null, noDb)(headers()), null);
	assert.equal(
		await resolver(() => {
			throw new Error('Private config');
		}, noDb)(headers()),
		null
	);
});

test('Real Better Auth 1.7.5 and migrated PGlite enforce session validity and operation isolation', async (t) => {
	const f = await fixture(t);
	const p = await identity(f);
	const secret = 'synthetic-phase-b-only-secret-123456789';
	const config = load('config.ts', {});
	const { getAuth } = load('instance.ts', {
		'$app/environment': { building: false, dev: false },
		'$env/dynamic/private': {
			env: {
				BETTER_AUTH_ENABLED: 'true',
				BETTER_AUTH_SECRET: secret,
				BETTER_AUTH_URL: 'https://auth.example.test',
				DATABASE_URL: 'postgresql://synthetic:synthetic@invalid.example/test'
			}
		},
		'better-auth': { betterAuth },
		'better-auth/api': { APIError, createAuthMiddleware },
		'better-auth/adapters/drizzle': { drizzleAdapter },
		'../db': { getDb: () => f.db },
		'../db/schema': f.schema,
		'./config': config
	});
	const auth = getAuth();
	const resolve = resolver(getAuth, () => f.db, f.schema);
	const token = randomUUID();
	const [session] = await f.db
		.insert(f.schema.authSessions)
		.values({
			userId: p.id,
			token,
			expiresAt: new Date(Date.now() + 60000),
			createdAt: new Date(Date.now() - 86400000 * 2),
			updatedAt: new Date(Date.now() - 86400000 * 2)
		})
		.returning();
	// Synthetic signed fixture follows the installed Better Call HMAC-SHA256 cookie format.
	const signed = encodeURIComponent(
		token + '.' + createHmac('sha256', secret).update(token).digest('base64')
	);
	const credential = new Headers({ cookie: '__Secure-soporteflow-auth.session_token=' + signed });
	const query = { disableCookieCache: true, disableRefresh: true };
	await t.test(
		'Only explicit internal session lookup succeeds; missing flags are rejected',
		async () => {
			for (const query of [
				undefined,
				{},
				{ disableCookieCache: true },
				{ disableRefresh: true },
				{ disableCookieCache: false, disableRefresh: true }
			])
				await assert.rejects(auth.api.getSession({ headers: credential, query }));
			const result = await auth.api.getSession({ headers: credential, query });
			assert.equal(result.user.id, p.id);
			assert.equal(JSON.stringify(await resolve(credential)), JSON.stringify({ userId: p.id }));
		}
	);
	await t.test('Valid lookup neither renews session nor emits credential cookies', async () => {
		const result = await auth.api.getSession({ headers: credential, query, returnHeaders: true });
		assert.equal(result.headers.get('set-cookie'), null);
		const [after] = await f.db
			.select()
			.from(f.schema.authSessions)
			.where(eq(f.schema.authSessions.id, session.id));
		assert.deepEqual(after, session);
	});
	await t.test('Every other direct Better Auth operation remains rejected', async () => {
		for (const [name, operation] of Object.entries(auth.api)) {
			if (name === 'getSession') continue;
			await assert.rejects(operation({ headers: credential, query, body: {} }), name);
		}
	});
	await t.test(
		'Session HTTP handler remains blocked even with a valid cookie and flags',
		async () => {
			for (const method of ['GET', 'POST']) {
				const response = await auth.handler(
					new Request(
						'https://auth.example.test/api/auth/get-session?disableCookieCache=true&disableRefresh=true',
						{ method, headers: credential }
					)
				);
				assert.equal(response.status, 404);
				assert.equal(response.headers.get('set-cookie'), null);
			}
		}
	);
	await t.test(
		'Inactive user is denied and reactivation is checked without principal cache',
		async () => {
			await f.db.update(f.schema.users).set({ active: false }).where(eq(f.schema.users.id, p.id));
			assert.equal(await resolve(credential), null);
			await f.db.update(f.schema.users).set({ active: true }).where(eq(f.schema.users.id, p.id));
			assert.equal((await resolve(credential)).userId, p.id);
		}
	);
	await t.test(
		'Invalid signatures, unsigned cookies and demo headers cannot authenticate',
		async () => {
			for (const cookie of [
				'__Secure-soporteflow-auth.session_token=' + token,
				'__Secure-soporteflow-auth.session_token=' + signed + 'tampered',
				'demoUser=' + p.id
			]) {
				assert.equal(
					await resolve(new Headers({ cookie, 'x-user-id': p.id, 'x-role': 'platform_admin' })),
					null
				);
			}
		}
	);
	await t.test(
		'Deleting the session revokes the same previously valid cookie immediately on next lookup',
		async () => {
			await f.db.delete(f.schema.authSessions).where(eq(f.schema.authSessions.id, session.id));
			assert.equal(await resolve(credential), null);
		}
	);
	await t.test('Expired persisted session cannot authenticate', async () => {
		await f.db
			.insert(f.schema.authSessions)
			.values({ userId: p.id, token, expiresAt: new Date(0) });
		assert.equal(await resolve(credential), null);
	});
});

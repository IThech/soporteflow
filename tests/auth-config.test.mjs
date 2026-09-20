import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { fixture } from './helpers/auth-fixture.mjs';

function evaluate(file, imports) {
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
			URL,
			process: { env: {} },
			require(id) {
				if (!Object.hasOwn(imports, id)) throw new Error('Unexpected import: ' + id);
				return imports[id];
			}
		},
		{ timeout: 1000 }
	);
	return module.exports;
}
const config = evaluate('config.ts', {});
const valid = {
	BETTER_AUTH_ENABLED: 'true',
	BETTER_AUTH_SECRET: 'synthetic-phase-a-only-secret-123456789',
	BETTER_AUTH_URL: 'https://auth.example.test',
	DATABASE_URL: 'postgresql://synthetic:synthetic@invalid.example/test'
};
function instance(env = {}, building = false, real) {
	let calls = 0,
		options;
	const schema = real?.schema ?? {
		authUsers: {},
		authAccounts: {},
		authSessions: {},
		authVerifications: {}
	};
	const api = evaluate('instance.ts', {
		'$app/environment': { building, dev: false },
		'$env/dynamic/private': { env: { ...env } },
		'better-auth': {
			betterAuth: real
				? betterAuth
				: (o) => {
						options = o;
						return { options: o };
					}
		},
		'better-auth/api': { APIError, createAuthMiddleware },
		'better-auth/adapters/drizzle': { drizzleAdapter: real ? drizzleAdapter : (_db, o) => o },
		'../db': {
			getDb() {
				calls++;
				if (real) return real.db;
				return {};
			}
		},
		'../db/schema': schema,
		'./config': config
	});
	return { api, calls: () => calls, options: () => options, schema };
}
test('Disabled by default, including absent secrets and database', () => {
	for (const env of [{}, { BETTER_AUTH_ENABLED: 'false' }, { BETTER_AUTH_ENABLED: '' }]) {
		assert.equal(config.readAuthConfig(env).enabled, false);
		const f = instance(env);
		assert.equal(f.api.getAuth(), null);
		assert.equal(f.calls(), 0);
	}
});
test('Activation flag rejects accidental values', () => {
	for (const flag of ['TRUE', '1', 'yes', ' true '])
		assert.throws(
			() => config.readAuthConfig({ ...valid, BETTER_AUTH_ENABLED: flag }),
			config.AuthConfigurationError
		);
});
test('Missing or short secret fails before database access without echoing it', () => {
	for (const secret of [undefined, '', 'short-sensitive-value']) {
		const f = instance({ ...valid, BETTER_AUTH_SECRET: secret });
		assert.throws(
			() => f.api.getAuth(),
			(e) => e.name === 'AuthConfigurationError' && !e.message.includes('short-sensitive-value')
		);
		assert.equal(f.calls(), 0);
	}
});
test('Invalid or unsafe public origins are rejected', () => {
	for (const url of [
		'',
		'invalid',
		'ftp://example.test',
		'http://example.test',
		'https://user:password@example.test',
		'https://example.test/path',
		'https://example.test/?token=sensitive',
		'https://example.test/#fragment'
	]) {
		assert.throws(
			() => config.readAuthConfig({ ...valid, BETTER_AUTH_URL: url }),
			config.AuthConfigurationError
		);
	}
});
test('HTTP is allowed only for loopback in explicit development mode', () => {
	const env = { ...valid, BETTER_AUTH_URL: 'http://127.0.0.1:5173' };
	assert.throws(() => config.readAuthConfig(env), config.AuthConfigurationError);
	assert.equal(config.readAuthConfig(env, true).secureCookies, false);
	assert.throws(
		() => config.readAuthConfig({ ...env, BETTER_AUTH_URL: 'http://example.test' }, true),
		config.AuthConfigurationError
	);
});
test('Database configuration is validated with sanitized errors', () => {
	for (const url of ['', 'sensitive-value', 'https://example.test/db', 'postgresql://localhost']) {
		assert.throws(
			() => config.readAuthConfig({ ...valid, DATABASE_URL: url }),
			(e) => e.name === 'AuthConfigurationError' && !e.message.includes(url || 'NEVER')
		);
	}
});
test('Module import does not initialize auth or call the database', () => {
	const f = instance(valid);
	assert.equal(f.calls(), 0);
	assert.equal(f.options(), undefined);
});
test('Build cannot initialize auth even when activation is explicitly configured', () => {
	for (const env of [valid, { BETTER_AUTH_ENABLED: 'true' }]) {
		const f = instance(env, true);
		assert.equal(f.api.getAuth(), null);
		assert.equal(f.calls(), 0);
		assert.equal(f.options(), undefined);
	}
});
test('Explicit lazy construction reuses the instance and maps all four tables', () => {
	const f = instance(valid),
		first = f.api.getAuth();
	assert.equal(f.api.getAuth(), first);
	assert.equal(f.calls(), 1);
	const s = f.options().database.schema;
	assert.equal(s.user, f.schema.authUsers);
	assert.equal(s.account, f.schema.authAccounts);
	assert.equal(s.session, f.schema.authSessions);
	assert.equal(s.verification, f.schema.authVerifications);
});
test('Security options keep authentication closed and CSRF/origin checks enabled', () => {
	const f = instance(valid);
	f.api.getAuth();
	const o = f.options();
	assert.equal(o.emailAndPassword.enabled, false);
	assert.equal(o.emailAndPassword.disableSignUp, true);
	assert.equal(o.user.changeEmail.enabled, false);
	assert.equal(o.user.deleteUser.enabled, false);
	assert.equal(o.session.cookieCache.enabled, false);
	assert.equal(o.rateLimit.enabled, true);
	assert.equal(o.advanced.disableCSRFCheck, false);
	assert.equal(o.advanced.disableOriginCheck, false);
	assert.equal(o.advanced.useSecureCookies, true);
	assert.equal(o.advanced.defaultCookieAttributes.httpOnly, true);
	assert.equal(o.trustedOrigins.length, 1);
	assert.equal(o.trustedOrigins[0], valid.BETTER_AUTH_URL);
});
test('Actual Better Auth instance with migrated PGlite keeps login and account operations blocked', async (t) => {
	const f = await fixture(t);
	const auth = instance(valid, false, f).api.getAuth();
	for (const route of [
		'sign-in/email',
		'sign-up/email',
		'request-password-reset',
		'reset-password',
		'reset-password/synthetic',
		'change-email',
		'delete-user'
	]) {
		const response = await auth.handler(
			new Request(valid.BETTER_AUTH_URL + '/api/auth/' + route, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: valid.BETTER_AUTH_URL },
				body: '{}'
			})
		);
		assert.ok(response.status >= 400 && response.status < 500, route);
		assert.equal(response.headers.get('set-cookie'), null);
	}
	await assert.rejects(
		auth.api.signInEmail({
			body: { email: 'synthetic@example.test', password: 'synthetic-password' }
		})
	);
	for (const table of ['auth_users', 'auth_accounts', 'auth_sessions', 'auth_verifications'])
		assert.equal((await f.pg.query('select count(*)::int as n from ' + table)).rows[0].n, 0);
});

test('Transaction factory stays disabled during build/default config and never populates singleton', () => {
	for (const f of [instance(), instance(valid, true)]) {
		assert.equal(f.api.getTransactionAuth({}), null);
		assert.equal(f.calls(), 0);
	}
	const f = instance(valid);
	const one = f.api.getTransactionAuth({});
	const two = f.api.getTransactionAuth({});
	assert.notEqual(one, two);
	assert.equal(f.calls(), 0);
	f.api.getAuth();
	assert.equal(f.calls(), 1);
});

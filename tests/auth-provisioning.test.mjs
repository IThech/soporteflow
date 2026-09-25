import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createHmac, randomUUID } from 'node:crypto';
import * as orm from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { fixture, identity } from './helpers/auth-fixture.mjs';

function load(name, imports) {
	const module = { exports: {} };
	const js = ts.transpileModule(
		fs.readFileSync(new URL('../src/lib/server/auth/' + name + '.ts', import.meta.url), 'utf8'),
		{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
	).outputText;
	vm.runInNewContext(
		js,
		{
			module,
			exports: module.exports,
			Headers,
			URL,
			process: { env: {} },
			require(key) {
				assert.ok(Object.hasOwn(imports, key), key);
				return imports[key];
			}
		},
		{ timeout: 1000 }
	);
	return module.exports;
}
const secret = 'synthetic-phase-d-only-secret-0123456789';
async function setup(t) {
	const f = await fixture(t),
		s = f.schema,
		queries = [];
	const db = drizzle(f.pg, {
		schema: s,
		logger: {
			logQuery(query) {
				queries.push(query);
			}
		}
	});
	let globalCalls = 0,
		failTable = null,
		failHash = false;
	const forbidden = () => {
		globalCalls++;
		throw Error('GENERAL_DATABASE_MUST_NOT_BE_USED');
	};
	const config = load('config', {});
	const instance = load('instance', {
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
		'../db': { getDb: forbidden },
		'../db/schema': s,
		'./config': config
	});
	const principal = load('principal', {
		'./instance': instance,
		'../db': { getDb: forbidden },
		'../db/schema': s,
		'drizzle-orm': orm
	});
	const authorization = load('authorization', {
		'./principal': principal,
		'../db': { getDb: forbidden },
		'../db/schema': s,
		'drizzle-orm': orm
	});
	const api = load('provisioning', {
		'drizzle-orm': orm,
		'better-auth/crypto': {
			hashPassword: async (p) => {
				if (failHash) throw Error('synthetic-password-must-not-leak');
				return hashPassword(p);
			}
		},
		'../db': {
			getDb: () => ({
				transaction: (fn) =>
					db.transaction((tx) =>
						fn(
							new Proxy(tx, {
								get(target, key) {
									if (key === 'insert')
										return (table) => {
											if (table === failTable) throw Error('synthetic-driver-secret');
											return target.insert(table);
										};
									const v = Reflect.get(target, key);
									return typeof v === 'function' ? v.bind(target) : v;
								}
							})
						)
					)
			})
		},
		'../db/schema': s,
		'./authorization': authorization,
		'./principal': principal
	});
	const actor = await identity({ ...f, db });
	const [org, otherOrg] = await db
		.insert(s.organizations)
		.values([
			{ name: 'A', slug: randomUUID(), status: 'active' },
			{ name: 'B', slug: randomUUID(), status: 'active' }
		])
		.returning();
	const [member] = await db
		.insert(s.memberships)
		.values({ organizationId: org.id, userId: actor.id })
		.returning();
	const [role] = await db
		.insert(s.roles)
		.values({ organizationId: org.id, name: 'Synthetic', code: randomUUID() })
		.returning();
	for (const key of [...Object.values(api.provisioningPermissions), 'synthetic:read']) {
		await db
			.insert(s.permissions)
			.values({ id: key, name: key, category: 'test', allowedScopeTypes: ['organization'] })
			// 5.4Q-B: the canonical provisioning permissions are already seeded by migration 0011
			.onConflictDoNothing();
		await db.insert(s.rolePermissions).values({ roleId: role.id, permissionId: key });
	}
	await db.insert(s.roleAssignments).values({
		organizationId: org.id,
		membershipId: member.id,
		roleId: role.id,
		scopeType: 'organization'
	});
	const token = randomUUID();
	const [session] = await db
		.insert(s.authSessions)
		.values({ userId: actor.id, token, expiresAt: new Date(Date.now() + 3600000) })
		.returning();
	const headers = new Headers({
		cookie:
			'__Secure-soporteflow-auth.session_token=' +
			encodeURIComponent(token + '.' + createHmac('sha256', secret).update(token).digest('base64'))
	});
	const input = () => ({
		name: 'New synthetic',
		email: randomUUID() + '@example.test',
		password: 'Synthetic-new-password-only!'
	});
	const count = async (table) => (await db.select().from(table)).length;
	return {
		f,
		s,
		db,
		api,
		principal,
		authorization,
		instance,
		actor,
		org,
		otherOrg,
		member,
		role,
		session,
		headers,
		input,
		count,
		queries,
		globalCalls: () => globalCalls,
		fail: (table) => {
			failTable = table;
		},
		failHash: () => {
			failHash = true;
		}
	};
}

test('Transactional provisioning: identity, authorization and writes use only supplied transaction', async (t) => {
	const x = await setup(t);
	const { db, s, api, org, headers } = x;
	const data = x.input();
	const created = await api.provisionIdentity(headers, org.id, data);
	assert.equal(created.ok, true);
	const uid = created.value.userId;
	const [account] = await db
		.select()
		.from(s.authAccounts)
		.where(orm.eq(s.authAccounts.userId, uid));
	assert.notEqual(account.password, data.password);
	assert.ok(await verifyPassword({ hash: account.password, password: data.password }));
	const [profile] = await db.select().from(s.authUsers).where(orm.eq(s.authUsers.id, uid));
	const [email] = await db.select().from(s.userEmails).where(orm.eq(s.userEmails.userId, uid));
	assert.equal(profile.emailVerified, false);
	assert.equal(email.verifiedAt, null);
	assert.equal(
		(await db.select().from(s.memberships).where(orm.eq(s.memberships.userId, uid))).length,
		0
	);
	assert.equal(JSON.stringify(created).includes(data.password), false);
	assert.equal(Object.keys(created.value).join(','), 'userId');
	assert.equal(x.globalCalls(), 0);
	assert.ok(x.queries.some((q) => q.includes('auth_sessions') && q.includes('for share')));
	assert.ok(x.queries.some((q) => q.includes('role_assignments') && q.includes('for share')));
	const added = await api.provisionMembership(headers, org.id, uid, [x.role.id]);
	assert.equal(added.ok, true);
	const [after] = await db
		.select()
		.from(s.authAccounts)
		.where(orm.eq(s.authAccounts.id, account.id));
	assert.deepEqual(after, account);
	assert.equal(x.globalCalls(), 0);
});

for (const name of ['userEmails', 'authUsers', 'authAccounts', 'hash'])
	test('Complete rollback on ' + name + ' failure', async (t) => {
		const x = await setup(t);
		const before = await Promise.all(
			[x.s.users, x.s.userEmails, x.s.authUsers, x.s.authAccounts].map(x.count)
		);
		if (name === 'hash') x.failHash();
		else x.fail(x.s[name]);
		const result = await x.api.provisionIdentity(x.headers, x.org.id, x.input());
		assert.equal(result.ok, false);
		assert.equal(result.error, 'FAILED');
		assert.deepEqual(
			await Promise.all([x.s.users, x.s.userEmails, x.s.authUsers, x.s.authAccounts].map(x.count)),
			before
		);
		assert.equal(JSON.stringify(result).includes('synthetic'), false);
	});
for (const existing of ['with-profile', 'without-profile'])
	test('Existing email ' + existing + ' cannot acquire or replace credentials', async (t) => {
		const x = await setup(t),
			p = await identity(x.f, existing === 'with-profile');
		const n = await x.count(x.s.users);
		const result = await x.api.provisionIdentity(x.headers, x.org.id, {
			...x.input(),
			email: p.email.toUpperCase()
		});
		assert.equal(result.error, 'CONFLICT');
		assert.equal(await x.count(x.s.users), n);
		assert.equal(await x.count(x.s.authAccounts), 0);
	});
for (const reason of [
	'session-revoked',
	'session-expired',
	'actor-inactive',
	'membership-inactive',
	'membership-revoked',
	'permission-removed',
	'organization-missing',
	'trial',
	'suspended',
	'no-cookie',
	'demo'
])
	test('Deny ' + reason, async (t) => {
		const x = await setup(t);
		let headers = x.headers,
			org = x.org.id;
		const { db, s } = x;
		if (reason === 'session-revoked') await db.delete(s.authSessions);
		if (reason === 'session-expired')
			await db.update(s.authSessions).set({ expiresAt: new Date(0) });
		if (reason === 'actor-inactive') await db.update(s.users).set({ active: false });
		if (reason === 'membership-inactive') await db.update(s.memberships).set({ active: false });
		if (reason === 'membership-revoked') await db.delete(s.memberships);
		if (reason === 'permission-removed') await db.delete(s.rolePermissions);
		if (reason === 'organization-missing') org = randomUUID();
		if (['trial', 'suspended'].includes(reason))
			await db.update(s.organizations).set({ status: reason });
		if (reason === 'no-cookie') headers = new Headers();
		if (reason === 'demo') headers = { userId: x.actor.id, role: 'platform_admin' };
		const n = await x.count(s.users);
		const result = await x.api.provisionIdentity(headers, org, x.input());
		assert.equal(result.error, 'DENIED');
		assert.equal(await x.count(s.users), n);
		assert.equal(x.globalCalls(), 0);
	});
for (const reason of [
	'inactive-target',
	'duplicate-membership',
	'foreign-role',
	'missing-role-permission',
	'privilege-escalation',
	'role-write-failure'
])
	test('Membership safety ' + reason, async (t) => {
		const x = await setup(t),
			target = await identity(x.f);
		const { db, s } = x;
		let role = x.role.id;
		if (reason === 'inactive-target')
			await db.update(s.users).set({ active: false }).where(orm.eq(s.users.id, target.id));
		if (reason === 'duplicate-membership')
			await db.insert(s.memberships).values({ organizationId: x.org.id, userId: target.id });
		if (reason === 'foreign-role') {
			const [r] = await db
				.insert(s.roles)
				.values({ organizationId: x.otherOrg.id, name: 'foreign', code: randomUUID() })
				.returning();
			role = r.id;
		}
		if (reason === 'missing-role-permission')
			await db
				.delete(s.rolePermissions)
				.where(orm.eq(s.rolePermissions.permissionId, x.api.provisioningPermissions.roles));
		if (reason === 'privilege-escalation') {
			const [r] = await db
				.insert(s.roles)
				.values({ organizationId: x.org.id, name: 'platform_admin', code: randomUUID() })
				.returning();
			role = r.id;
			await db.insert(s.permissions).values({
				id: 'unheld:permission',
				name: 'Unheld',
				category: 'test',
				allowedScopeTypes: ['organization']
			});
			await db
				.insert(s.rolePermissions)
				.values({ roleId: role, permissionId: 'unheld:permission' });
		}
		if (reason === 'role-write-failure') x.fail(s.roleAssignments);
		const n = await x.count(s.memberships);
		const result = await x.api.provisionMembership(x.headers, x.org.id, target.id, [role]);
		assert.equal(result.ok, false);
		assert.equal(await x.count(s.memberships), n);
	});
test('Transaction auth is not singleton and every other API remains blocked', async (t) => {
	const x = await setup(t);
	await x.db.transaction(async (tx) => {
		const a = x.instance.getTransactionAuth(tx),
			b = x.instance.getTransactionAuth(tx);
		assert.notEqual(a, b);
		assert.equal((await x.principal.resolveTransactionPrincipal(x.headers, tx)).userId, x.actor.id);
		for (const [name, fn] of Object.entries(a.api))
			if (name !== 'getSession') await assert.rejects(fn({ headers: x.headers, body: {} }));
		await assert.rejects(a.api.getSession({ headers: x.headers }));
		assert.equal(
			(
				await a.handler(
					new Request('https://auth.example.test/api/auth/get-session', { headers: x.headers })
				)
			).status,
			404
		);
	});
	assert.equal(x.globalCalls(), 0);
});
test('Uncommitted session and grants are visible and outer rollback removes them', async (t) => {
	const x = await setup(t);
	await assert.rejects(
		x.db.transaction(async (tx) => {
			await tx
				.update(x.s.organizations)
				.set({ status: 'suspended' })
				.where(orm.eq(x.s.organizations.id, x.org.id));
			assert.equal(
				await x.authorization.authorizeTransaction(x.headers, x.org.id, 'identities:create', tx),
				null
			);
			throw Error('ROLLBACK');
		}),
		/ROLLBACK/
	);
	assert.equal((await x.api.provisionIdentity(x.headers, x.org.id, x.input())).ok, true);
});
test('Overlapping duplicate submissions serialize in PGlite; only one identity survives', async (t) => {
	const x = await setup(t),
		data = x.input(),
		n = await x.count(x.s.users);
	const results = await Promise.all([
		x.api.provisionIdentity(x.headers, x.org.id, data),
		x.api.provisionIdentity(x.headers, x.org.id, data)
	]);
	assert.equal(results.filter((r) => r.ok).length, 1);
	assert.equal(results.filter((r) => r.error === 'CONFLICT').length, 1);
	assert.equal(await x.count(x.s.users), n + 1);
});

test('Public getSession sees newly inserted session on transaction and rollback removes it', async (t) => {
	const x = await setup(t),
		token = randomUUID();
	const headers = new Headers({
		cookie:
			'__Secure-soporteflow-auth.session_token=' +
			encodeURIComponent(token + '.' + createHmac('sha256', secret).update(token).digest('base64'))
	});
	const before = await x.count(x.s.authSessions);
	await assert.rejects(
		x.db.transaction(async (tx) => {
			await tx
				.insert(x.s.authSessions)
				.values({ userId: x.actor.id, token, expiresAt: new Date(Date.now() + 60000) });
			assert.equal((await x.principal.resolveTransactionPrincipal(headers, tx)).userId, x.actor.id);
			throw Error('EXPECTED_ROLLBACK');
		}),
		/EXPECTED_ROLLBACK/
	);
	assert.equal(await x.count(x.s.authSessions), before);
	assert.equal(x.globalCalls(), 0);
});
test('Independent role assignment succeeds only on an authorized organization membership', async (t) => {
	const x = await setup(t),
		target = await identity(x.f);
	const member = await x.api.provisionMembership(x.headers, x.org.id, target.id);
	assert.equal(member.ok, true);
	assert.equal(
		(await x.api.assignMembershipRoles(x.headers, x.org.id, member.value.membershipId, [x.role.id]))
			.ok,
		true
	);
	assert.equal(
		(
			await x.api.assignMembershipRoles(x.headers, x.otherOrg.id, member.value.membershipId, [
				x.role.id
			])
		).error,
		'DENIED'
	);
	assert.equal(
		(await x.api.assignMembershipRoles(x.headers, x.org.id, member.value.membershipId, [x.role.id]))
			.error,
		'CONFLICT'
	);
});
test('Overlapping membership attempts leave one membership in serialized PGlite', async (t) => {
	const x = await setup(t),
		target = await identity(x.f),
		n = await x.count(x.s.memberships);
	const results = await Promise.all([
		x.api.provisionMembership(x.headers, x.org.id, target.id),
		x.api.provisionMembership(x.headers, x.org.id, target.id)
	]);
	assert.equal(results.filter((r) => r.ok).length, 1);
	assert.equal(results.filter((r) => r.error === 'CONFLICT').length, 1);
	assert.equal(await x.count(x.s.memberships), n + 1);
});
test('Permission held only in a narrower scope cannot authorize identity provisioning', async (t) => {
	const x = await setup(t);
	const [team] = await x.db
		.insert(x.s.teams)
		.values({ organizationId: x.org.id, name: 'Scoped' })
		.returning();
	await x.db.update(x.s.permissions).set({ allowedScopeTypes: ['organization', 'team'] });
	await x.db.update(x.s.roleAssignments).set({ scopeType: 'team', teamId: team.id });
	assert.equal((await x.api.provisionIdentity(x.headers, x.org.id, x.input())).error, 'DENIED');
});
test('Invalid input rolls back without partial identity', async (t) => {
	const x = await setup(t),
		n = await x.count(x.s.users);
	assert.equal(
		(await x.api.provisionIdentity(x.headers, x.org.id, { ...x.input(), password: 'short' })).error,
		'INVALID_INPUT'
	);
	assert.equal(await x.count(x.s.users), n);
});

test('Nonfinite persisted expiry denies transaction identity', async (t) => {
	const x = await setup(t);
	await x.db.execute(orm.sql`update auth_sessions set expires_at = 'infinity'::timestamptz`);
	assert.equal((await x.api.provisionIdentity(x.headers, x.org.id, x.input())).ok, false);
});

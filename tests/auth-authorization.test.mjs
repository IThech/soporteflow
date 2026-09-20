import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { fixture, identity } from './helpers/auth-fixture.mjs';

function load(resolvePrincipal, getDb, schema, resolveTransactionPrincipal = async () => null) {
	const module = { exports: {} };
	const source = ts.transpileModule(
		fs.readFileSync(new URL('../src/lib/server/auth/authorization.ts', import.meta.url), 'utf8'),
		{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
	).outputText;
	const imports = {
		'./principal': { resolvePrincipal, resolveTransactionPrincipal },
		'../db': { getDb },
		'../db/schema': schema,
		'drizzle-orm': { and, eq }
	};
	vm.runInNewContext(
		source,
		{
			module,
			exports: module.exports,
			Headers,
			require(id) {
				if (!Object.hasOwn(imports, id)) throw new Error('Unexpected import: ' + id);
				return imports[id];
			}
		},
		{ timeout: 1000 }
	);
	return module.exports;
}
const headers = () =>
	new Headers({ cookie: 'synthetic-only', 'x-user-id': 'demo-admin', 'x-role': 'platform_admin' });
test('Import is lazy and rejected identities never obtain a database client', async () => {
	let calls = 0;
	const api = load(
		async () => null,
		() => {
			calls++;
			throw new Error('No database');
		},
		{}
	);
	assert.equal(calls, 0);
	assert.equal(
		await api.authorizeAction(headers(), { organizationId: randomUUID(), permissionId: 'read' }),
		false
	);
	assert.equal(calls, 0);
});
test('Database and identity errors deny all public entry points without leaking details', async () => {
	for (const source of ['principal', 'db']) {
		const api = load(
			async () => {
				if (source === 'principal') throw new Error('private-token');
				return { userId: randomUUID() };
			},
			() => {
				throw new Error('private-connection-string');
			},
			{}
		);
		assert.equal(await api.verifyOrganizationMembership(headers(), randomUUID()), null);
		assert.equal((await api.resolveOrganizationPermissions(headers(), randomUUID())).length, 0);
		assert.equal(
			await api.authorizeAction(headers(), { organizationId: randomUUID(), permissionId: 'read' }),
			false
		);
	}
});
test('Organization authorization on the migrated Core, with SQL tenant filters', async (t) => {
	const f = await fixture(t);
	const s = f.schema;
	const queries = [];
	const db = drizzle(f.pg, {
		schema: s,
		logger: {
			logQuery(query, params) {
				queries.push({ query, params });
			}
		}
	});
	async function scenario() {
		const p = await identity(f);
		const other = await identity(f);
		const [a, b] = await db
			.insert(s.organizations)
			.values([
				{ name: 'A', slug: randomUUID(), status: 'active' },
				{ name: 'B', slug: randomUUID(), status: 'active' }
			])
			.returning();
		const [m] = await db
			.insert(s.memberships)
			.values({ userId: p.id, organizationId: a.id })
			.returning();
		const [role] = await db
			.insert(s.roles)
			.values({ organizationId: a.id, name: 'Role', code: randomUUID() })
			.returning();
		const [permission] = await db
			.insert(s.permissions)
			.values({
				id: 'test:' + randomUUID(),
				name: 'Read',
				category: 'test',
				allowedScopeTypes: ['organization', 'department', 'team', 'site', 'personal']
			})
			.returning();
		const [rp] = await db
			.insert(s.rolePermissions)
			.values({ roleId: role.id, permissionId: permission.id })
			.returning();
		const [assignment] = await db
			.insert(s.roleAssignments)
			.values({
				organizationId: a.id,
				membershipId: m.id,
				roleId: role.id,
				scopeType: 'organization'
			})
			.returning();
		const [teamA, teamB] = await db
			.insert(s.teams)
			.values([
				{ organizationId: a.id, name: 'A' },
				{ organizationId: b.id, name: 'B' }
			])
			.returning();
		let principal = { userId: p.id },
			identityCalls = 0;
		const api = load(
			async () => {
				identityCalls++;
				return principal;
			},
			() => db,
			s
		);
		const action = (resource) => ({
			organizationId: a.id,
			permissionId: permission.id,
			...(resource === undefined ? {} : { resource })
		});
		return {
			p,
			other,
			a,
			b,
			m,
			role,
			permission,
			rp,
			assignment,
			teamA,
			teamB,
			api,
			action,
			identityCalls: () => identityCalls,
			setPrincipal: (value) => {
				principal = value;
			}
		};
	}
	await t.test(
		'Active user, membership, organization and assigned permission authorize',
		async () => {
			const x = await scenario();
			assert.equal(await x.api.authorizeAction(headers(), x.action()), true);
			const member = await x.api.verifyOrganizationMembership(headers(), x.a.id);
			assert.equal(member.userId, x.p.id);
			const grants = await x.api.resolveOrganizationPermissions(headers(), x.a.id);
			assert.equal(grants.length, 1);
			assert.equal(grants[0].roleId, x.role.id);
			assert.equal(x.identityCalls(), 3);
		}
	);
	await t.test('No membership denies even with a valid global identity', async () => {
		const x = await scenario();
		x.setPrincipal({ userId: x.other.id });
		assert.equal(await x.api.authorizeAction(headers(), x.action()), false);
	});
	await t.test('Inactive membership denies', async () => {
		const x = await scenario();
		await db.update(s.memberships).set({ active: false }).where(eq(s.memberships.id, x.m.id));
		assert.equal(await x.api.authorizeAction(headers(), x.action()), false);
	});
	await t.test(
		'Suspended and trial organizations deny by explicit conservative policy',
		async () => {
			const x = await scenario();
			for (const status of ['suspended', 'trial']) {
				await db.update(s.organizations).set({ status }).where(eq(s.organizations.id, x.a.id));
				assert.equal(await x.api.authorizeAction(headers(), x.action()), false);
			}
		}
	);
	await t.test('Multiple organizations do not transfer roles or permissions', async () => {
		const x = await scenario();
		const [mb] = await db
			.insert(s.memberships)
			.values({ userId: x.p.id, organizationId: x.b.id })
			.returning();
		assert.equal(
			await x.api.authorizeAction(headers(), { ...x.action(), organizationId: x.b.id }),
			false
		);
		const [rb] = await db
			.insert(s.roles)
			.values({ organizationId: x.b.id, name: 'Other', code: randomUUID() })
			.returning();
		await db.insert(s.rolePermissions).values({ roleId: rb.id, permissionId: x.permission.id });
		await db.insert(s.roleAssignments).values({
			organizationId: x.b.id,
			membershipId: mb.id,
			roleId: rb.id,
			scopeType: 'organization'
		});
		assert.equal(
			await x.api.authorizeAction(headers(), { ...x.action(), organizationId: x.b.id }),
			true
		);
		assert.equal(await x.api.authorizeAction(headers(), x.action()), true);
	});
	await t.test('Several roles contribute only their explicit grants', async () => {
		const x = await scenario();
		const [r] = await db
			.insert(s.roles)
			.values({ organizationId: x.a.id, name: 'Second', code: randomUUID() })
			.returning();
		const [p] = await db
			.insert(s.permissions)
			.values({
				id: 'second:' + randomUUID(),
				name: 'Second',
				category: 'test',
				allowedScopeTypes: ['organization']
			})
			.returning();
		await db.insert(s.rolePermissions).values({ roleId: r.id, permissionId: p.id });
		await db.insert(s.roleAssignments).values({
			organizationId: x.a.id,
			membershipId: x.m.id,
			roleId: r.id,
			scopeType: 'organization'
		});
		assert.equal(
			await x.api.authorizeAction(headers(), { ...x.action(), permissionId: p.id }),
			true
		);
		assert.equal((await x.api.resolveOrganizationPermissions(headers(), x.a.id)).length, 2);
	});
	await t.test('Unknown and removed permissions deny with no cached grant', async () => {
		const x = await scenario();
		assert.equal(
			await x.api.authorizeAction(headers(), { ...x.action(), permissionId: 'missing' }),
			false
		);
		assert.equal(await x.api.authorizeAction(headers(), x.action()), true);
		await db.delete(s.rolePermissions).where(eq(s.rolePermissions.id, x.rp.id));
		assert.equal(await x.api.authorizeAction(headers(), x.action()), false);
	});
	await t.test('Inactive or unassigned role denies', async () => {
		const x = await scenario();
		await db.update(s.roles).set({ active: false }).where(eq(s.roles.id, x.role.id));
		assert.equal(await x.api.authorizeAction(headers(), x.action()), false);
		await db.update(s.roles).set({ active: true }).where(eq(s.roles.id, x.role.id));
		await db.delete(s.roleAssignments).where(eq(s.roleAssignments.id, x.assignment.id));
		assert.equal(await x.api.authorizeAction(headers(), x.action()), false);
	});
	await t.test('Manipulated organization selection is not authorization', async () => {
		const x = await scenario();
		assert.equal(
			await x.api.authorizeAction(headers(), { ...x.action(), organizationId: x.b.id }),
			false
		);
		assert.equal(
			await x.api.authorizeAction(headers(), { ...x.action(), organizationId: 'invalid' }),
			false
		);
	});
	await t.test(
		'Cross-tenant and missing resources deny identically; SQL filters precede results',
		async () => {
			const x = await scenario();
			queries.length = 0;
			assert.equal(
				await x.api.authorizeAction(headers(), x.action({ kind: 'team', id: x.teamB.id })),
				false
			);
			const resourceQueries = queries.filter((q) => q.query.includes('from "teams"'));
			assert.equal(resourceQueries.length, 1);
			assert.match(resourceQueries[0].query, /where.*"teams"."organization_id" =/);
			assert.ok(resourceQueries[0].params.includes(x.a.id));
			assert.ok(resourceQueries[0].params.includes(x.teamB.id));
			assert.equal(
				await x.api.authorizeAction(headers(), x.action({ kind: 'team', id: randomUUID() })),
				false
			);
			assert.equal(
				await x.api.authorizeAction(headers(), x.action({ kind: 'team', id: x.teamA.id })),
				true
			);
		}
	);
	await t.test(
		'Grant SQL binds organization and membership before returning permissions',
		async () => {
			const x = await scenario();
			queries.length = 0;
			await x.api.resolveOrganizationPermissions(headers(), x.a.id);
			const q = queries.find((q) => q.query.includes('from "role_assignments"'));
			assert.ok(q);
			assert.match(q.query, /where.*"role_assignments"."organization_id" =/);
			assert.ok(q.params.includes(x.a.id));
			assert.ok(q.params.includes(x.m.id));
		}
	);
	await t.test(
		'Global user deactivation is rechecked even if principal resolution returns an identity',
		async () => {
			const x = await scenario();
			await db.update(s.users).set({ active: false }).where(eq(s.users.id, x.p.id));
			assert.equal(await x.api.authorizeAction(headers(), x.action()), false);
		}
	);
	await t.test('Missing authentication and demo objects cannot supply identity', async () => {
		const x = await scenario();
		x.setPrincipal(null);
		assert.equal(await x.api.authorizeAction(headers(), x.action()), false);
		assert.equal(
			await x.api.authorizeAction({ userId: x.p.id, role: 'platform_admin' }, x.action()),
			false
		);
	});
	await t.test(
		'Platform role names, platform permission keys and templates confer no global authority',
		async () => {
			const x = await scenario();
			await db
				.update(s.roles)
				.set({ code: 'platform_admin', name: 'platform_admin' })
				.where(eq(s.roles.id, x.role.id));
			assert.equal(
				await x.api.authorizeAction(headers(), { ...x.action(), organizationId: x.b.id }),
				false
			);
			await db
				.insert(s.permissions)
				.values({
					id: 'platform:' + randomUUID(),
					name: 'Platform',
					category: 'test',
					allowedScopeTypes: ['organization']
				})
				.returning()
				.then(async ([p]) => {
					await db.insert(s.rolePermissions).values({ roleId: x.role.id, permissionId: p.id });
					assert.equal(
						await x.api.authorizeAction(headers(), { ...x.action(), permissionId: p.id }),
						false
					);
				});
			const [template] = await db
				.insert(s.roleTemplates)
				.values({ id: randomUUID(), code: randomUUID(), name: 'Template' })
				.returning();
			await db.update(s.roles).set({ templateId: template.id }).where(eq(s.roles.id, x.role.id));
			await db
				.insert(s.roleTemplatePermissions)
				.values({ roleTemplateId: template.id, permissionId: x.permission.id });
			await db.delete(s.rolePermissions).where(eq(s.rolePermissions.id, x.rp.id));
			assert.equal(await x.api.authorizeAction(headers(), x.action()), false);
		}
	);
	await t.test('Team leadership and membership do not create implicit permission', async () => {
		const x = await scenario();
		await db.delete(s.rolePermissions).where(eq(s.rolePermissions.id, x.rp.id));
		await db
			.insert(s.teamMemberships)
			.values({ organizationId: x.a.id, teamId: x.teamA.id, membershipId: x.m.id, isLead: true });
		assert.equal(
			await x.api.authorizeAction(headers(), x.action({ kind: 'team', id: x.teamA.id })),
			false
		);
	});
	for (const kind of ['team', 'department', 'site'])
		await t.test(
			'Explicit ' + kind + ' scope applies only to that active Core record',
			async () => {
				const x = await scenario();
				const table = kind === 'team' ? s.teams : kind === 'site' ? s.sites : s.departments;
				const [one, two] = await db
					.insert(table)
					.values([
						{ organizationId: x.a.id, name: randomUUID() },
						{ organizationId: x.a.id, name: randomUUID() }
					])
					.returning();
				await db
					.update(s.roleAssignments)
					.set({ scopeType: kind, [kind + 'Id']: one.id })
					.where(eq(s.roleAssignments.id, x.assignment.id));
				assert.equal(await x.api.authorizeAction(headers(), x.action()), false);
				assert.equal(await x.api.authorizeAction(headers(), x.action({ kind, id: one.id })), true);
				assert.equal(await x.api.authorizeAction(headers(), x.action({ kind, id: two.id })), false);
				await db.update(table).set({ active: false }).where(eq(table.id, one.id));
				assert.equal(await x.api.authorizeAction(headers(), x.action({ kind, id: one.id })), false);
			}
		);
	await t.test('Scope forbidden by permission catalog denies', async () => {
		const x = await scenario();
		await db
			.update(s.permissions)
			.set({ allowedScopeTypes: ['team'] })
			.where(eq(s.permissions.id, x.permission.id));
		assert.equal(await x.api.authorizeAction(headers(), x.action()), false);
	});
	await t.test('Personal scope and unsupported resource types deny', async () => {
		const x = await scenario();
		await db
			.update(s.roleAssignments)
			.set({ scopeType: 'personal' })
			.where(eq(s.roleAssignments.id, x.assignment.id));
		assert.equal(await x.api.authorizeAction(headers(), x.action()), false);
		assert.equal(
			await x.api.authorizeAction(headers(), x.action({ kind: 'incident', id: randomUUID() })),
			false
		);
	});
});

test('Transactional authorization rejects missing identity without a general database lookup', async () => {
	const api = load(
		async () => {
			throw Error('General principal forbidden');
		},
		() => {
			throw Error('General database forbidden');
		},
		{}
	);
	assert.equal(
		await api.authorizeTransaction(headers(), randomUUID(), 'identities:create', {}),
		null
	);
});

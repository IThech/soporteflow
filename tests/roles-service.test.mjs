import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

test('SoporteFlow — Etapa 5.4Q-C: ensureOrganizationRoles', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, pg, server } = f;
	const { ensureOrganizationRoles } = await server.ssrLoadModule(
		'/src/lib/server/services/roles.ts'
	);
	const { ROLE_TEMPLATES } = await server.ssrLoadModule('/src/lib/server/auth/role-templates.ts');
	const { PERMISSION_IDS } = await server.ssrLoadModule('/src/lib/server/auth/permissions.ts');
	const { IncidentServiceError } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);
	const auth = await server.ssrLoadModule('/src/lib/server/auth/authorization.ts');
	const provisioning = await server.ssrLoadModule('/src/lib/server/auth/provisioning.ts');

	const ADMIN = [...ROLE_TEMPLATES[0].permissionIds].sort();
	const TECHNICIAN = [...ROLE_TEMPLATES[1].permissionIds].sort();
	const CUSTOMER = [...ROLE_TEMPLATES[2].permissionIds].sort();
	const DTO_KEYS = ['active', 'code', 'id', 'isCustom', 'name', 'templateId'];

	async function rejectsWith(operation, code) {
		await assert.rejects(operation, (error) => {
			assert.ok(error instanceof IncidentServiceError, `esperado IncidentServiceError: ${error}`);
			assert.equal(error.code, code);
			return true;
		});
	}
	async function organization(status = 'active') {
		const [org] = await db
			.insert(s.organizations)
			.values({ name: 'Roles', slug: 'roles-' + randomUUID(), status })
			.returning();
		return org;
	}
	async function rolesOf(org) {
		return db.select().from(s.roles).where(eq(s.roles.organizationId, org.id));
	}
	async function permissionsOf(roleId) {
		return (await db.select().from(s.rolePermissions).where(eq(s.rolePermissions.roleId, roleId)))
			.map((r) => r.permissionId)
			.sort();
	}
	async function countAll() {
		const { rows } = await pg.query(
			`SELECT (SELECT count(*) FROM roles)::int AS roles, (SELECT count(*) FROM role_permissions)::int AS rp,
			        (SELECT count(*) FROM role_templates)::int AS tpl, (SELECT count(*) FROM role_template_permissions)::int AS tp,
			        (SELECT count(*) FROM role_assignments)::int AS ra`
		);
		return rows[0];
	}

	await t.test(
		'11-18. crea organization_admin, technician y customer como roles de sistema con permisos exactos',
		async () => {
			const org = await organization();
			const result = await ensureOrganizationRoles(db, org.id);
			assert.deepEqual(Object.keys(result), ['roles']);
			assert.deepEqual(
				result.roles.map((r) => r.code),
				['customer', 'organization_admin', 'technician']
			);
			for (const role of result.roles) {
				assert.deepEqual(Object.keys(role).sort(), DTO_KEYS);
				assert.equal(role.isCustom, false);
				assert.equal(role.active, true);
			}
			const byCode = (code) => result.roles.find((r) => r.code === code);
			const [admin, tech, customer] = ['organization_admin', 'technician', 'customer'].map(byCode);
			assert.equal(customer.templateId, 'tpl_customer');
			assert.equal(customer.name, 'Cliente');
			assert.deepEqual(await permissionsOf(customer.id), CUSTOMER);
			assert.equal(admin.templateId, 'tpl_organization_admin');
			assert.equal(admin.name, 'Administrador de organización');
			assert.equal(tech.templateId, 'tpl_technician');
			assert.equal(tech.name, 'Técnico de soporte');
			assert.deepEqual(await permissionsOf(admin.id), ADMIN);
			assert.deepEqual(await permissionsOf(tech.id), TECHNICIAN);
			for (const forbidden of [
				'sites:manage',
				'categories:manage',
				'roles:assign',
				'memberships:create',
				'identities:create',
				'incidents:view_own'
			])
				assert.ok(!(await permissionsOf(tech.id)).includes(forbidden), forbidden);
			assert.equal((await rolesOf(org)).length, 3);
			assert.equal((await countAll()).ra, 0, 'crear roles no asigna nada a nadie');
		}
	);

	await t.test('19-22. idempotente: 3 ejecuciones, mismos ids y sin duplicados', async () => {
		const org = await organization();
		const first = await ensureOrganizationRoles(db, org.id);
		const counts = await countAll();
		const second = await ensureOrganizationRoles(db, org.id);
		const third = await ensureOrganizationRoles(db, org.id);
		assert.deepEqual(second, first);
		assert.deepEqual(third, first);
		assert.deepEqual(await countAll(), counts);
		const dups = await pg.query(
			`SELECT 1 FROM role_permissions GROUP BY role_id, permission_id HAVING count(*) > 1`
		);
		assert.equal(dups.rows.length, 0);
		// un permiso extra añadido a mano se conserva; uno quitado se repone
		const tech = first.roles.find((r) => r.code === 'technician');
		await db.insert(s.rolePermissions).values({ roleId: tech.id, permissionId: 'sites:manage' });
		await db
			.delete(s.rolePermissions)
			.where(
				and(eq(s.rolePermissions.roleId, tech.id), eq(s.rolePermissions.permissionId, 'teams:view'))
			);
		await ensureOrganizationRoles(db, org.id);
		assert.deepEqual(await permissionsOf(tech.id), [...TECHNICIAN, 'sites:manage'].sort());
	});

	await t.test('23-24. aislamiento A/B y coexistencia con roles custom', async () => {
		const orgA = await organization();
		const orgB = await organization();
		const [custom] = await db
			.insert(s.roles)
			.values({ organizationId: orgA.id, name: 'Auditor', code: 'auditor', isCustom: true })
			.returning();
		await db.insert(s.rolePermissions).values({ roleId: custom.id, permissionId: 'sites:view' });
		const a = await ensureOrganizationRoles(db, orgA.id);
		const b = await ensureOrganizationRoles(db, orgB.id);
		const idsA = a.roles.map((r) => r.id);
		const idsB = b.roles.map((r) => r.id);
		assert.equal(new Set([...idsA, ...idsB]).size, 6);
		for (const role of await rolesOf(orgB)) assert.ok(idsB.includes(role.id));
		const [customAfter] = await db.select().from(s.roles).where(eq(s.roles.id, custom.id));
		assert.deepEqual(customAfter, custom);
		assert.deepEqual(await permissionsOf(custom.id), ['sites:view']);
		assert.ok(!a.roles.some((r) => r.id === custom.id));
		const { rows } = await pg.query(
			`SELECT count(*)::int AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.id = ANY($1::uuid[]) AND r.organization_id <> $2`,
			[idsA, orgA.id]
		);
		assert.equal(rows[0].n, 0);
	});

	await t.test(
		'25-26, 30. colisión con custom o con otra plantilla -> ROLE_CODE_CONFLICT y rollback total',
		async () => {
			for (const values of [
				{ code: 'technician', isCustom: true, templateId: null },
				{ code: 'technician', isCustom: false, templateId: null },
				{ code: 'technician', isCustom: false, templateId: 'tpl_organization_admin' },
				// 5.4S-A: customer preexistente custom / de otra plantilla nunca se adopta
				{ code: 'customer', isCustom: true, templateId: null },
				{ code: 'customer', isCustom: false, templateId: null },
				{ code: 'customer', isCustom: false, templateId: 'tpl_technician' }
			]) {
				const org = await organization();
				const [conflicting] = await db
					.insert(s.roles)
					.values({ organizationId: org.id, name: 'Mío', ...values })
					.returning();
				const before = await countAll();
				await rejectsWith(ensureOrganizationRoles(db, org.id), 'ROLE_CODE_CONFLICT');
				// las demás plantillas procesadas antes también se revierten
				assert.deepEqual(await countAll(), before);
				const roles = await rolesOf(org);
				assert.equal(roles.length, 1);
				assert.deepEqual(roles[0], conflicting, 'no se apropia ni modifica el rol existente');
			}
		}
	);

	await t.test(
		'27. plantilla inactiva: no crea rol nuevo ni desactiva los existentes',
		async () => {
			const existingOrg = await organization();
			await ensureOrganizationRoles(db, existingOrg.id);
			await db
				.update(s.roleTemplates)
				.set({ active: false })
				.where(eq(s.roleTemplates.id, 'tpl_technician'));
			try {
				const org = await organization();
				const result = await ensureOrganizationRoles(db, org.id);
				assert.deepEqual(
					result.roles.map((r) => r.code),
					['customer', 'organization_admin']
				);
				const existing = await ensureOrganizationRoles(db, existingOrg.id);
				const tech = existing.roles.find((r) => r.code === 'technician');
				assert.ok(tech && tech.active, 'el rol existente sigue activo');
			} finally {
				await db
					.update(s.roleTemplates)
					.set({ active: true })
					.where(eq(s.roleTemplates.id, 'tpl_technician'));
			}
		}
	);

	await t.test(
		'28-29, 34. org inválida, inexistente o no operativa; plantilla ausente',
		async () => {
			for (const value of ['x', '', null, 42])
				await rejectsWith(ensureOrganizationRoles(db, value), 'INVALID_INPUT');
			await rejectsWith(ensureOrganizationRoles(db, randomUUID()), 'ORGANIZATION_NOT_FOUND');
			for (const status of ['suspended', 'trial']) {
				const org = await organization(status);
				await rejectsWith(ensureOrganizationRoles(db, org.id), 'ORGANIZATION_NOT_OPERATIONAL');
				assert.equal((await rolesOf(org)).length, 0);
			}
			// plantilla canónica ausente (simulado dentro de una transacción que se revierte)
			const org = await organization();
			await pg.exec('BEGIN');
			try {
				await pg.exec(
					`DELETE FROM role_template_permissions WHERE role_template_id = 'tpl_technician'`
				);
				await pg.exec(`UPDATE roles SET template_id = NULL WHERE template_id = 'tpl_technician'`);
				await pg.exec(`DELETE FROM role_templates WHERE id = 'tpl_technician'`);
				const txDb = drizzle(pg, { schema: s });
				await assert.rejects(
					ensureOrganizationRoles(
						{
							...txDb,
							transaction: undefined,
							select: txDb.select.bind(txDb),
							insert: txDb.insert.bind(txDb)
						},
						org.id
					),
					(e) => e.code === 'ROLE_TEMPLATE_NOT_FOUND'
				);
			} finally {
				await pg.exec('ROLLBACK');
			}
			assert.equal(
				(await db.select().from(s.roleTemplates).where(eq(s.roleTemplates.id, 'tpl_technician')))
					.length,
				1
			);
		}
	);

	await t.test('30. fallo a mitad (role_permissions) -> rollback completo', async () => {
		const org = await organization();
		await pg.exec(`
			CREATE FUNCTION test_fail_rp() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'forced'; END $$;
			CREATE TRIGGER test_fail_rp BEFORE INSERT ON role_permissions
			FOR EACH ROW WHEN (NEW.permission_id = 'teams:view') EXECUTE FUNCTION test_fail_rp();`);
		try {
			await assert.rejects(ensureOrganizationRoles(db, org.id));
		} finally {
			await pg.exec('DROP TRIGGER test_fail_rp ON role_permissions; DROP FUNCTION test_fail_rp();');
		}
		assert.equal((await rolesOf(org)).length, 0);
		assert.equal((await ensureOrganizationRoles(db, org.id)).roles.length, 3);
	});

	// =========================================================================
	// Sin grants por defecto, grants efectivos y delegación monotónica
	// =========================================================================
	const org = await organization();
	const { roles } = await ensureOrganizationRoles(db, org.id);
	const adminRole = roles.find((r) => r.code === 'organization_admin');
	const techRole = roles.find((r) => r.code === 'technician');
	async function member(role) {
		const user = await createCredentialUser(f);
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
		if (role)
			await db.insert(s.roleAssignments).values({
				organizationId: org.id,
				membershipId: membership.id,
				roleId: role.id,
				scopeType: 'organization'
			});
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, headers: session.headers };
	}
	const can = (who, permissionId) =>
		auth.authorizeAction(who.headers, { organizationId: org.id, permissionId });

	await t.test('44. roles creados no conceden nada sin role_assignment', async () => {
		const plain = await member();
		for (const permission of PERMISSION_IDS)
			assert.equal(await can(plain, permission), false, permission);
		assert.equal(
			(
				await db
					.select()
					.from(s.roleAssignments)
					.where(eq(s.roleAssignments.membershipId, plain.membership.id))
			).length,
			0
		);
		const { GET } = await server.ssrLoadModule('/src/routes/api/incidents/+server.ts');
		const url = new URL(`http://localhost/api/incidents?organizationId=${org.id}`);
		assert.equal(
			(await GET({ url, request: new Request(url, { headers: plain.headers }) })).status,
			403
		);
	});

	await t.test('45. grants efectivos de organization_admin y technician asignados', async () => {
		const admin = await member(adminRole);
		const tech = await member(techRole);
		for (const permission of PERMISSION_IDS) {
			assert.equal(await can(admin, permission), ADMIN.includes(permission), `admin ${permission}`);
			assert.equal(
				await can(tech, permission),
				TECHNICIAN.includes(permission),
				`tech ${permission}`
			);
		}
		for (const denied of [
			'sites:manage',
			'categories:manage',
			'roles:assign',
			'memberships:create',
			'identities:create'
		])
			assert.equal(await can(tech, denied), false, denied);
	});

	await t.test(
		'46. delegación monotónica: technician no puede asignar organization_admin',
		async () => {
			const target = await member();
			// technician sin roles:assign
			const tech = await member(techRole);
			const denied = await provisioning.assignMembershipRoles(
				tech.headers,
				org.id,
				target.membership.id,
				[adminRole.id]
			);
			assert.deepEqual(denied, { ok: false, error: 'DENIED' });
			// technician + roles:assign (rol custom) puede asignar technician pero no organization_admin
			const [delegator] = await db
				.insert(s.roles)
				.values({ organizationId: org.id, name: 'Delegador', code: 'delegator', isCustom: true })
				.returning();
			await db
				.insert(s.rolePermissions)
				.values({ roleId: delegator.id, permissionId: 'roles:assign' });
			const techPlus = await member(techRole);
			await db.insert(s.roleAssignments).values({
				organizationId: org.id,
				membershipId: techPlus.membership.id,
				roleId: delegator.id,
				scopeType: 'organization'
			});
			assert.deepEqual(
				await provisioning.assignMembershipRoles(techPlus.headers, org.id, target.membership.id, [
					adminRole.id
				]),
				{ ok: false, error: 'DENIED' }
			);
			assert.equal(await can(target, 'sites:manage'), false, 'no hubo escalada');
			const granted = await provisioning.assignMembershipRoles(
				techPlus.headers,
				org.id,
				target.membership.id,
				[techRole.id]
			);
			assert.equal(granted.ok, true);
			assert.equal(await can(target, 'incidents:view_all'), true);
			// organization_admin sí puede asignar organization_admin
			const admin = await member(adminRole);
			const other = await member();
			assert.equal(
				(
					await provisioning.assignMembershipRoles(admin.headers, org.id, other.membership.id, [
						adminRole.id
					])
				).ok,
				true
			);
			assert.equal(await can(other, 'roles:assign'), true);
		}
	);

	await t.test('37. SQL: todo dentro de una transacción con ON CONFLICT y FOR UPDATE', async () => {
		const fresh = await organization();
		const queries = [];
		const logged = drizzle(pg, {
			schema: s,
			logger: { logQuery: (q) => queries.push(q.toLowerCase()) }
		});
		const original = pg.transaction.bind(pg);
		let transactions = 0;
		pg.transaction = async (fn) => {
			transactions++;
			return original(fn);
		};
		try {
			await ensureOrganizationRoles(logged, fresh.id);
		} finally {
			pg.transaction = original;
		}
		assert.equal(transactions, 1);
		assert.ok(
			queries.some(
				(q) =>
					q.startsWith('insert into "roles"') &&
					q.includes('on conflict ("organization_id","code") do nothing')
			)
		);
		assert.ok(
			queries.some(
				(q) =>
					q.startsWith('insert into "role_permissions"') &&
					q.includes('on conflict ("role_id","permission_id") do nothing')
			)
		);
		assert.ok(queries.some((q) => q.includes('from "roles"') && q.includes('for update')));
		assert.ok(!queries.some((q) => q.includes('role_assignments')), 'nunca toca assignments');
		assert.ok(!queries.some((q) => q.startsWith('delete')), 'nunca borra');
	});
});

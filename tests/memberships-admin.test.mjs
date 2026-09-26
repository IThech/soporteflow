import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import {
	fixture,
	directory,
	createCredentialUser,
	createSession
} from './helpers/auth-fixture.mjs';

async function applyRange(pg, from, to) {
	const journal = JSON.parse(fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8'));
	for (const entry of journal.entries.slice(from, to + 1)) {
		const sql = fs.readFileSync(path.join(directory, entry.tag + '.sql'), 'utf8');
		await pg.exec('BEGIN');
		try {
			for (const statement of sql.split('--> statement-breakpoint'))
				if (statement.trim()) await pg.exec(statement);
			await pg.exec('COMMIT');
		} catch (error) {
			await pg.exec('ROLLBACK');
			throw error;
		}
	}
}
function journalIndex(tag) {
	const journal = JSON.parse(fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8'));
	return journal.entries.findIndex((e) => e.tag === tag);
}

test('SoporteFlow — Etapa 5.4R-C/D: memberships, asignación y revocación de roles', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server, pg } = f;
	const {
		listOrganizationMemberships,
		getOrganizationMembership,
		assignRoleToMembership,
		revokeRoleFromMembership
	} = await server.ssrLoadModule('/src/lib/server/services/memberships.ts');
	const {
		ensureOrganizationRoles,
		createCustomRole,
		updateCustomRole,
		getOrganizationRole,
		countTenantAdministrators
	} = await server.ssrLoadModule('/src/lib/server/services/roles.ts');
	const { PERMISSION_IDS } = await server.ssrLoadModule('/src/lib/server/auth/permissions.ts');
	const { ROLE_TEMPLATES } = await server.ssrLoadModule('/src/lib/server/auth/role-templates.ts');
	const { resolveEffectivePermissions } = await server.ssrLoadModule(
		'/src/lib/server/auth/effective-permissions.ts'
	);
	const { IncidentServiceError } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);
	const listRoute = await server.ssrLoadModule('/src/routes/api/memberships/+server.ts');
	const detailRoute = await server.ssrLoadModule('/src/routes/api/memberships/[id]/+server.ts');
	const assignRoute = await server.ssrLoadModule(
		'/src/routes/api/memberships/[id]/roles/+server.ts'
	);
	const revokeRoute = await server.ssrLoadModule(
		'/src/routes/api/memberships/[id]/roles/[roleId]/+server.ts'
	);
	const { GET: meGET } = await server.ssrLoadModule('/src/routes/api/me/+server.ts');

	const catalogOrder = (ids) => PERMISSION_IDS.filter((id) => ids.includes(id));
	const ADMIN = catalogOrder([...ROLE_TEMPLATES[0].permissionIds]);
	const TECHNICIAN = catalogOrder([...ROLE_TEMPLATES[1].permissionIds]);
	const MEMBERSHIP_KEYS = ['active', 'id', 'roles', 'user'];
	const USER_KEYS = ['active', 'email', 'id', 'name'];
	const ROLE_KEYS = ['active', 'code', 'id', 'isCustom', 'name'];
	let seq = 0;
	const code = () => `c${++seq}_${randomUUID().slice(0, 6)}`;

	async function rejectsWith(operation, expected) {
		await assert.rejects(operation, (error) => {
			assert.ok(error instanceof IncidentServiceError, `esperado IncidentServiceError: ${error}`);
			assert.equal(error.code, expected);
			return true;
		});
	}
	async function organization(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'rc-' + randomUUID(), status: 'active' })
			.returning();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		return {
			org,
			admin: roles.find((r) => r.code === 'organization_admin'),
			tech: roles.find((r) => r.code === 'technician')
		};
	}
	async function rawRole(org, permissionIds, values = {}) {
		const [role] = await db
			.insert(s.roles)
			.values({ organizationId: org.id, name: 'Raw', code: code(), isCustom: true, ...values })
			.returning();
		for (const permissionId of permissionIds)
			await db.insert(s.rolePermissions).values({ roleId: role.id, permissionId });
		return role;
	}
	async function member(org, roles = [], { name, membershipActive = true, userActive } = {}) {
		const user = await createCredentialUser(f, { name, active: userActive });
		await db.update(s.userEmails).set({ isPrimary: true }).where(eq(s.userEmails.userId, user.id));
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id, active: membershipActive })
			.returning();
		for (const role of roles)
			await db.insert(s.roleAssignments).values({
				organizationId: org.id,
				membershipId: membership.id,
				roleId: role.id,
				scopeType: 'organization'
			});
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, headers: session.headers, cookie: session.cookieHeader };
	}
	const effective = (who, org) => resolveEffectivePermissions(who.headers, org.id);
	async function assignments(membershipId) {
		return (
			await db
				.select({ roleId: s.roleAssignments.roleId })
				.from(s.roleAssignments)
				.where(eq(s.roleAssignments.membershipId, membershipId))
		)
			.map((r) => r.roleId)
			.sort();
	}
	async function call(
		handler,
		{ method = 'GET', path: p, cookie, organizationId, query = '', params = {}, body, rawBody }
	) {
		const qs = organizationId === null ? '' : `organizationId=${organizationId}`;
		const url = new URL(`http://localhost${p}?${qs}${query}`);
		const headers = new Headers();
		if (cookie) headers.set('cookie', cookie);
		const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
		if (payload !== undefined) headers.set('content-type', 'application/json');
		const response = await handler({
			url,
			params,
			request: new Request(url, { method, headers, body: payload })
		});
		const text = await response.text();
		return {
			status: response.status,
			json: text ? JSON.parse(text) : null,
			text,
			headers: response.headers
		};
	}
	const list = (who, organizationId, extra = {}) =>
		call(listRoute.GET, {
			path: '/api/memberships',
			cookie: who?.cookie,
			organizationId,
			...extra
		});
	const detail = (who, organizationId, id, extra = {}) =>
		call(detailRoute.GET, {
			path: `/api/memberships/${id}`,
			cookie: who?.cookie,
			organizationId,
			params: { id },
			...extra
		});
	const assign = (who, organizationId, id, roleId, extra = {}) =>
		call(assignRoute.POST, {
			method: 'POST',
			path: `/api/memberships/${id}/roles`,
			cookie: who?.cookie,
			organizationId,
			params: { id },
			body: roleId === undefined ? undefined : { roleId },
			...extra
		});
	const revoke = (who, organizationId, id, roleId, extra = {}) =>
		call(revokeRoute.DELETE, {
			method: 'DELETE',
			path: `/api/memberships/${id}/roles/${roleId}`,
			cookie: who?.cookie,
			organizationId,
			params: { id, roleId },
			...extra
		});
	async function me(who, org) {
		const url = new URL(`http://localhost/api/me?organizationId=${org.id}`);
		const response = await meGET({
			url,
			request: new Request(url, { headers: { cookie: who.cookie } })
		});
		return (await response.json()).activeOrganization.capabilities;
	}

	const A = await organization('Alfa');
	const B = await organization('Beta');
	const adminA = await member(A.org, [A.admin], { name: 'Ana Admin' });
	const adminA2 = await member(A.org, [A.admin], { name: 'Zoe Admin' });
	const techA = await member(A.org, [A.tech], { name: 'Teo Técnico' });
	const adminB = await member(B.org, [B.admin], { name: 'Beto Admin' });

	// =========================================================================
	// Migración 0014 y permisos
	// =========================================================================
	await t.test('0014: memberships:view en catálogo y Admin; no en Technician', async () => {
		const [row] = await db
			.select()
			.from(s.permissions)
			.where(eq(s.permissions.id, 'memberships:view'));
		assert.ok(row);
		assert.deepEqual(row.allowedScopeTypes, ['organization']);
		assert.ok(ADMIN.includes('memberships:view'));
		assert.ok(!TECHNICIAN.includes('memberships:view'));
		assert.deepEqual((await getOrganizationRole(db, A.org.id, A.admin.id)).permissions, ADMIN);
		assert.ok(!PERMISSION_IDS.includes('memberships:manage'), 'sin memberships:manage (decisión)');
		assert.ok((await effective(adminA, A.org)).includes('memberships:view'));
		assert.ok(!(await effective(techA, A.org)).includes('memberships:view'));
	});

	await t.test(
		'upgrade 0013 -> 0014: Admin existente recibe memberships:view; idempotente',
		async () => {
			const up = new PGlite();
			try {
				const index = journalIndex('0014_memberships_admin_permissions');
				assert.ok(index > 0);
				await applyRange(up, 0, index - 1);
				const org = randomUUID();
				await up.query(
					`INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Up', $2, 'active')`,
					[org, 'up-' + org]
				);
				const {
					rows: [admin]
				} = await up.query(
					`INSERT INTO roles (organization_id, name, code, template_id, is_custom)
				 VALUES ($1, 'Admin', 'organization_admin', 'tpl_organization_admin', false) RETURNING id`,
					[org]
				);
				const {
					rows: [tech]
				} = await up.query(
					`INSERT INTO roles (organization_id, name, code, template_id, is_custom)
				 VALUES ($1, 'Tech', 'technician', 'tpl_technician', false) RETURNING id`,
					[org]
				);
				const {
					rows: [custom]
				} = await up.query(
					`INSERT INTO roles (organization_id, name, code, is_custom)
				 VALUES ($1, 'Custom', 'organization_admin_like', true) RETURNING id`,
					[org]
				);
				await applyRange(up, index, index);
				await applyRange(up, index, index);
				const perms = async (roleId) =>
					(
						await up.query(`SELECT permission_id FROM role_permissions WHERE role_id = $1`, [
							roleId
						])
					).rows.map((r) => r.permission_id);
				assert.deepEqual(await perms(admin.id), ['memberships:view']);
				assert.deepEqual(await perms(tech.id), []);
				assert.deepEqual(await perms(custom.id), []);
				const tpl = (
					await up.query(
						`SELECT role_template_id FROM role_template_permissions WHERE permission_id = 'memberships:view'`
					)
				).rows.map((r) => r.role_template_id);
				assert.deepEqual(tpl, ['tpl_organization_admin']);
				const { rows: assigned } = await up.query(
					`SELECT count(*)::int AS n FROM role_assignments`
				);
				assert.equal(assigned[0].n, 0);
			} finally {
				await up.close();
			}
		}
	);

	// =========================================================================
	// Read model (1-8)
	// =========================================================================
	await t.test('1-3. lista memberships con usuario seguro y roles asignados', async () => {
		const members = await listOrganizationMemberships(db, A.org.id);
		const ana = members.find((m) => m.id === adminA.membership.id);
		// dos administradores en Alfa: las pruebas de revocación nunca dejan el tenant sin admin
		assert.equal(members.find((m) => m.id === adminA2.membership.id).user.name, 'Zoe Admin');
		assert.equal(await countTenantAdministrators(db, A.org.id), 2);
		assert.deepEqual(Object.keys(ana).sort(), MEMBERSHIP_KEYS);
		assert.deepEqual(Object.keys(ana.user).sort(), USER_KEYS);
		assert.deepEqual(ana.user, {
			id: adminA.user.id,
			name: 'Ana Admin',
			email: `${adminA.user.id}@example.test`,
			active: true
		});
		assert.equal(ana.active, true);
		assert.deepEqual(ana.roles, [
			{
				id: A.admin.id,
				code: 'organization_admin',
				name: A.admin.name,
				active: true,
				isCustom: false
			}
		]);
		for (const m of members)
			for (const r of m.roles) assert.deepEqual(Object.keys(r).sort(), ROLE_KEYS);
		const serialized = JSON.stringify(members);
		for (const leak of [
			'password',
			'token',
			'session',
			'providerId',
			'accountId',
			'organizationId',
			'hash'
		])
			assert.ok(!serialized.includes(leak), leak);
	});

	await t.test('4-5. rol inactivo y membership/usuario inactivos visibles', async () => {
		const off = await rawRole(A.org, ['sites:view'], { active: false, name: 'Apagado' });
		const idle = await member(A.org, [off], { name: 'Ivo Inactivo', membershipActive: false });
		const gone = await member(A.org, [], { name: 'Uma Usuario', userActive: false });
		const row = await getOrganizationMembership(db, A.org.id, idle.membership.id);
		assert.equal(row.active, false);
		assert.deepEqual(
			row.roles.map((r) => [r.id, r.active]),
			[[off.id, false]]
		);
		assert.deepEqual(await effective(idle, A.org), null, 'membership inactiva no concede nada');
		const user = await getOrganizationMembership(db, A.org.id, gone.membership.id);
		assert.equal(user.user.active, false);
		assert.equal(user.active, true);
	});

	await t.test('6. aislamiento de tenant: listado y detalle', async () => {
		const ids = (await listOrganizationMemberships(db, B.org.id)).map((m) => m.id);
		assert.deepEqual(ids, [adminB.membership.id]);
		await rejectsWith(
			getOrganizationMembership(db, A.org.id, adminB.membership.id),
			'MEMBERSHIP_NOT_FOUND'
		);
		await rejectsWith(
			getOrganizationMembership(db, A.org.id, randomUUID()),
			'MEMBERSHIP_NOT_FOUND'
		);
		await rejectsWith(getOrganizationMembership(db, A.org.id, 'nope'), 'INVALID_INPUT');
		await rejectsWith(listOrganizationMemberships(db, 'nope'), 'INVALID_INPUT');
	});

	await t.test('7. sin N+1: número de consultas constante con 3 o 40 miembros', async () => {
		const C = await organization('Conteo');
		const count = async (org) => {
			let n = 0;
			const original = { query: pg.query, exec: pg.exec };
			pg.query = function (...args) {
				n++;
				return original.query.apply(this, args);
			};
			pg.exec = function (...args) {
				n++;
				return original.exec.apply(this, args);
			};
			try {
				await listOrganizationMemberships(db, org.id);
			} finally {
				pg.query = original.query;
				pg.exec = original.exec;
			}
			return n;
		};
		for (let i = 0; i < 3; i++) await member(C.org, [C.tech]);
		const small = await count(C.org);
		for (let i = 0; i < 37; i++) await member(C.org, [C.tech, C.admin]);
		const large = await count(C.org);
		assert.equal(large, small);
		assert.ok(small <= 3, `consultas: ${small}`);
		assert.equal((await listOrganizationMemberships(db, C.org.id)).length, 40);
	});

	await t.test('8. orden determinista: nombre de usuario y luego id; roles por code', async () => {
		const D = await organization('Orden');
		const custom = await rawRole(D.org, [], { code: 'aaa_first' });
		const b = await member(D.org, [D.tech, custom, D.admin], { name: 'Bruno' });
		const a1 = await member(D.org, [], { name: 'Alba' });
		const a2 = await member(D.org, [], { name: 'Alba' });
		const listed = await listOrganizationMemberships(db, D.org.id);
		const albas = [a1.membership.id, a2.membership.id].sort();
		assert.deepEqual(
			listed.map((m) => m.id),
			[...albas, b.membership.id]
		);
		assert.deepEqual(
			listed[2].roles.map((r) => r.code),
			['aaa_first', 'organization_admin', 'technician']
		);
		assert.deepEqual(await listOrganizationMemberships(db, D.org.id), listed);
	});

	// =========================================================================
	// Assign (9-20)
	// =========================================================================
	await t.test('9-10. Admin asigna technician y rol custom; efecto inmediato (20)', async () => {
		const target = await member(A.org);
		assert.deepEqual(await effective(target, A.org), []);
		const r1 = await assignRoleToMembership(db, A.org.id, target.membership.id, A.tech.id, ADMIN);
		assert.equal(r1.created, true);
		assert.equal(r1.role.id, A.tech.id);
		assert.deepEqual(await effective(target, A.org), TECHNICIAN);
		const custom = await createCustomRole(db, A.org.id, ADMIN, {
			name: 'Sedes',
			code: code(),
			permissions: ['sites:manage']
		});
		const r2 = await assignRoleToMembership(db, A.org.id, target.membership.id, custom.id, ADMIN);
		assert.equal(r2.role.isCustom, true);
		assert.deepEqual(await effective(target, A.org), catalogOrder([...TECHNICIAN, 'sites:manage']));
	});

	await t.test('11-12. Technician denegado (HTTP) y gestor custom limitado', async () => {
		const target = await member(A.org);
		const denied = await assign(techA, A.org.id, target.membership.id, A.tech.id);
		assert.equal(denied.status, 403);
		assert.equal(denied.json.error.code, 'FORBIDDEN');
		const managerRole = await rawRole(A.org, ['roles:assign', 'sites:view', 'categories:view']);
		const manager = await member(A.org, [managerRole]);
		const limited = await rawRole(A.org, ['sites:view']);
		const ok = await assign(manager, A.org.id, target.membership.id, limited.id);
		assert.equal(ok.status, 201);
		const superior = await assign(manager, A.org.id, target.membership.id, A.tech.id);
		assert.equal(superior.status, 403);
		assert.equal(superior.json.error.code, 'PERMISSION_NOT_DELEGABLE');
		assert.deepEqual(await assignments(target.membership.id), [limited.id]);
	});

	await t.test('13-14. rol inactivo y membership/usuario inactivos no asignables', async () => {
		const off = await rawRole(A.org, ['sites:view'], { active: false });
		const target = await member(A.org);
		await rejectsWith(
			assignRoleToMembership(db, A.org.id, target.membership.id, off.id, ADMIN),
			'ROLE_INACTIVE'
		);
		const idle = await member(A.org, [], { membershipActive: false });
		await rejectsWith(
			assignRoleToMembership(db, A.org.id, idle.membership.id, A.tech.id, ADMIN),
			'MEMBERSHIP_INACTIVE'
		);
		const gone = await member(A.org, [], { userActive: false });
		await rejectsWith(
			assignRoleToMembership(db, A.org.id, gone.membership.id, A.tech.id, ADMIN),
			'MEMBERSHIP_INACTIVE'
		);
		assert.deepEqual(await assignments(target.membership.id), []);
		assert.deepEqual(await assignments(idle.membership.id), []);
	});

	await t.test('15-16. membership o rol de otro tenant: *_NOT_FOUND, nada escrito', async () => {
		const target = await member(A.org);
		await rejectsWith(
			assignRoleToMembership(db, A.org.id, adminB.membership.id, A.tech.id, ADMIN),
			'MEMBERSHIP_NOT_FOUND'
		);
		await rejectsWith(
			assignRoleToMembership(db, A.org.id, target.membership.id, B.tech.id, ADMIN),
			'ROLE_NOT_FOUND'
		);
		await rejectsWith(
			assignRoleToMembership(db, B.org.id, target.membership.id, B.tech.id, ADMIN),
			'MEMBERSHIP_NOT_FOUND'
		);
		assert.deepEqual(await assignments(target.membership.id), []);
		assert.deepEqual(await assignments(adminB.membership.id), [B.admin.id]);
	});

	await t.test('17. asignación duplicada: idempotente, sin filas duplicadas', async () => {
		const target = await member(A.org, [A.tech]);
		const again = await assignRoleToMembership(
			db,
			A.org.id,
			target.membership.id,
			A.tech.id,
			ADMIN
		);
		assert.equal(again.created, false);
		assert.deepEqual(await assignments(target.membership.id), [A.tech.id]);
		const http = await assign(adminA, A.org.id, target.membership.id, A.tech.id);
		assert.equal(http.status, 200);
		assert.equal(http.json.assignment.created, false);
		assert.deepEqual(await assignments(target.membership.id), [A.tech.id]);
	});

	await t.test(
		'18. no puede asignar un rol superior (ni Admin a sí mismo sin tenerlo)',
		async () => {
			const target = await member(A.org);
			await rejectsWith(
				assignRoleToMembership(db, A.org.id, target.membership.id, A.admin.id, TECHNICIAN),
				'PERMISSION_NOT_DELEGABLE'
			);
			const legacy = await rawRole(A.org, []);
			await db
				.insert(s.permissions)
				.values({
					id: 'legacy:power',
					name: 'Legacy',
					description: 'Legacy',
					category: 'legacy',
					allowedScopeTypes: ['organization']
				})
				.onConflictDoNothing();
			await db
				.insert(s.rolePermissions)
				.values({ roleId: legacy.id, permissionId: 'legacy:power' });
			await rejectsWith(
				assignRoleToMembership(db, A.org.id, target.membership.id, legacy.id, ADMIN),
				'PERMISSION_NOT_DELEGABLE'
			);
			assert.deepEqual(await assignments(target.membership.id), []);
		}
	);

	await t.test(
		'19. divergencia de Admin: se usan sus permisos reales, no la plantilla',
		async () => {
			const D = await organization('Divergente');
			await db
				.delete(s.rolePermissions)
				.where(
					and(
						eq(s.rolePermissions.roleId, D.admin.id),
						eq(s.rolePermissions.permissionId, 'teams:view')
					)
				);
			const actor = await member(D.org, [D.admin]);
			const target = await member(D.org);
			const actorPermissions = await effective(actor, D.org);
			assert.ok(!actorPermissions.includes('teams:view'));
			const denied = await assign(actor, D.org.id, target.membership.id, D.tech.id);
			assert.equal(denied.status, 403);
			assert.equal(denied.json.error.code, 'PERMISSION_NOT_DELEGABLE');
			// el propio rol Admin (divergente) sí es delegable: es subconjunto de sus permisos
			assert.equal((await assign(actor, D.org.id, target.membership.id, D.admin.id)).status, 201);
		}
	);

	// =========================================================================
	// Revoke (21-30)
	// =========================================================================
	await t.test('21, 26-29. revoca rol custom: sólo esa asignación, efecto inmediato', async () => {
		const custom = await rawRole(A.org, ['categories:manage']);
		const target = await member(A.org, [A.tech, custom]);
		assert.ok((await effective(target, A.org)).includes('categories:manage'));
		await revokeRoleFromMembership(db, A.org.id, target.membership.id, custom.id, ADMIN);
		assert.deepEqual(await assignments(target.membership.id), [A.tech.id]);
		assert.deepEqual(await effective(target, A.org), TECHNICIAN);
		assert.ok(await getOrganizationRole(db, A.org.id, custom.id), 'el rol sigue existiendo');
		assert.equal(
			(await getOrganizationMembership(db, A.org.id, target.membership.id)).active,
			true
		);
	});

	await t.test('22. revoca technician', async () => {
		const target = await member(A.org, [A.tech]);
		await revokeRoleFromMembership(db, A.org.id, target.membership.id, A.tech.id, ADMIN);
		assert.deepEqual(await effective(target, A.org), []);
		assert.deepEqual(await assignments(target.membership.id), []);
	});

	await t.test('23. asignación inexistente -> ROLE_ASSIGNMENT_NOT_FOUND', async () => {
		const target = await member(A.org);
		await rejectsWith(
			revokeRoleFromMembership(db, A.org.id, target.membership.id, A.tech.id, ADMIN),
			'ROLE_ASSIGNMENT_NOT_FOUND'
		);
	});

	await t.test('24. tenant equivocado -> *_NOT_FOUND y nada borrado', async () => {
		await rejectsWith(
			revokeRoleFromMembership(db, A.org.id, adminB.membership.id, B.admin.id, ADMIN),
			'MEMBERSHIP_NOT_FOUND'
		);
		await rejectsWith(
			revokeRoleFromMembership(db, A.org.id, adminA.membership.id, B.admin.id, ADMIN),
			'ROLE_NOT_FOUND'
		);
		assert.deepEqual(await assignments(adminB.membership.id), [B.admin.id]);
	});

	await t.test('25. actor inferior no puede revocar un rol superior', async () => {
		const target = await member(A.org, [A.tech]);
		const managerRole = await rawRole(A.org, ['roles:assign', 'sites:view']);
		const manager = await member(A.org, [managerRole]);
		const r = await revoke(manager, A.org.id, target.membership.id, A.tech.id);
		assert.equal(r.status, 403);
		assert.equal(r.json.error.code, 'PERMISSION_NOT_DELEGABLE');
		const adminRevoke = await revoke(manager, A.org.id, adminA.membership.id, A.admin.id);
		assert.equal(adminRevoke.status, 403);
		assert.deepEqual(await assignments(target.membership.id), [A.tech.id]);
	});

	await t.test('revoca en membership o rol inactivos (limpieza permitida)', async () => {
		const off = await rawRole(A.org, ['sites:view'], { active: false });
		const idle = await member(A.org, [off, A.tech], { membershipActive: false });
		await revokeRoleFromMembership(db, A.org.id, idle.membership.id, off.id, ADMIN);
		await revokeRoleFromMembership(db, A.org.id, idle.membership.id, A.tech.id, ADMIN);
		assert.deepEqual(await assignments(idle.membership.id), []);
	});

	await t.test('30. último admin: no revocable; con dos admins sí', async () => {
		const L = await organization('Último');
		const only = await member(L.org, [L.admin]);
		assert.equal(await countTenantAdministrators(db, L.org.id), 1);
		await rejectsWith(
			revokeRoleFromMembership(db, L.org.id, only.membership.id, L.admin.id, ADMIN),
			'LAST_ADMIN_REQUIRED'
		);
		assert.deepEqual(await assignments(only.membership.id), [L.admin.id]);
		const second = await member(L.org, [L.admin]);
		await revokeRoleFromMembership(db, L.org.id, only.membership.id, L.admin.id, ADMIN);
		assert.equal(await countTenantAdministrators(db, L.org.id), 1);
		const http = await revoke(second, L.org.id, second.membership.id, L.admin.id);
		assert.equal(http.status, 409);
		assert.equal(http.json.error.code, 'LAST_ADMIN_REQUIRED');
		assert.deepEqual(await effective(second, L.org), ADMIN);
	});

	await t.test(
		'30b. último admin: inactivos no cuentan; rol custom admin-like sí cuenta',
		async () => {
			const L = await organization('Último 2');
			const main = await member(L.org, [L.admin]);
			await member(L.org, [L.admin], { membershipActive: false });
			await member(L.org, [L.admin], { userActive: false });
			assert.equal(await countTenantAdministrators(db, L.org.id), 1);
			await rejectsWith(
				revokeRoleFromMembership(db, L.org.id, main.membership.id, L.admin.id, ADMIN),
				'LAST_ADMIN_REQUIRED'
			);
			const adminLike = await createCustomRole(db, L.org.id, ADMIN, {
				name: 'Super',
				code: 'super_admin',
				permissions: ADMIN
			});
			const backup = await member(L.org, [adminLike]);
			assert.equal(await countTenantAdministrators(db, L.org.id), 2);
			await revokeRoleFromMembership(db, L.org.id, main.membership.id, L.admin.id, ADMIN);
			// R-B: desactivar o recortar el último rol admin-like también está protegido
			await rejectsWith(
				updateCustomRole(db, L.org.id, adminLike.id, ADMIN, { active: false }),
				'LAST_ADMIN_REQUIRED'
			);
			await rejectsWith(
				updateCustomRole(db, L.org.id, adminLike.id, ADMIN, {
					permissions: ADMIN.filter((p) => p !== 'roles:assign')
				}),
				'LAST_ADMIN_REQUIRED'
			);
			assert.equal((await getOrganizationRole(db, L.org.id, adminLike.id)).active, true);
			assert.deepEqual(await effective(backup, L.org), ADMIN);
			// renombrar sigue permitido
			assert.equal(
				(await updateCustomRole(db, L.org.id, adminLike.id, ADMIN, { name: 'Súper' })).name,
				'Súper'
			);
		}
	);

	await t.test('30c. org sin administradores previos: no se bloquean mutaciones', async () => {
		const Z = await organization('Sin admin');
		const who = await member(Z.org, [Z.tech]);
		assert.equal(await countTenantAdministrators(db, Z.org.id), 0);
		await revokeRoleFromMembership(db, Z.org.id, who.membership.id, Z.tech.id, ADMIN);
		assert.deepEqual(await assignments(who.membership.id), []);
	});

	// =========================================================================
	// HTTP (31-40)
	// =========================================================================
	await t.test('31. sin sesión -> 401 en todas las rutas', async () => {
		const id = techA.membership.id;
		assert.equal((await list(null, A.org.id)).status, 401);
		assert.equal((await detail(null, A.org.id, id)).status, 401);
		assert.equal((await assign(null, A.org.id, id, A.tech.id)).status, 401);
		assert.equal((await revoke(null, A.org.id, id, A.tech.id)).status, 401);
	});

	await t.test(
		'32-33. UUID mal formado, query desconocida/duplicada o body inválido -> 400',
		async () => {
			const id = techA.membership.id;
			for (const r of [
				await list(adminA, 'nope'),
				await list(adminA, null),
				await list(adminA, A.org.id, { query: '&x=1' }),
				await list(adminA, A.org.id, { query: `&organizationId=${A.org.id}` }),
				await detail(adminA, A.org.id, 'nope'),
				await detail(adminA, A.org.id, id, { query: '&active=true' }),
				await assign(adminA, A.org.id, 'nope', A.tech.id),
				await assign(adminA, A.org.id, id, 'nope'),
				await assign(adminA, A.org.id, id, undefined),
				await assign(adminA, A.org.id, id, undefined, { rawBody: '{bad' }),
				await assign(adminA, A.org.id, id, undefined, {
					body: { roleId: A.tech.id, scopeType: 'site' }
				}),
				await assign(adminA, A.org.id, id, undefined, { body: [A.tech.id] }),
				await assign(adminA, A.org.id, id, A.tech.id, { query: '&x=1' }),
				await revoke(adminA, A.org.id, id, 'nope'),
				await revoke(adminA, A.org.id, 'nope', A.tech.id),
				await revoke(adminA, A.org.id, id, A.tech.id, { query: '&x=1' })
			]) {
				assert.equal(r.status, 400, r.text);
				assert.equal(r.json.error.code, 'INVALID_INPUT');
			}
			assert.deepEqual(await assignments(id), [A.tech.id]);
		}
	);

	await t.test('34-35. list 200 y detail 200 con DTO y no-store', async () => {
		const l = await list(adminA, A.org.id);
		assert.equal(l.status, 200);
		assert.equal(l.headers.get('cache-control'), 'private, no-store');
		assert.deepEqual(Object.keys(l.json), ['memberships']);
		assert.deepEqual(l.json.memberships, await listOrganizationMemberships(db, A.org.id));
		assert.ok(!l.text.includes(A.org.id));
		const d = await detail(adminA, A.org.id, techA.membership.id);
		assert.equal(d.status, 200);
		assert.deepEqual(Object.keys(d.json), ['membership']);
		assert.deepEqual(Object.keys(d.json.membership).sort(), MEMBERSHIP_KEYS);
		assert.deepEqual(
			d.json.membership.roles.map((r) => r.id),
			[A.tech.id]
		);
	});

	await t.test('36-37. assign 201/200 y revoke 204 por HTTP', async () => {
		const target = await member(A.org);
		const created = await assign(adminA, A.org.id, target.membership.id, A.tech.id);
		assert.equal(created.status, 201);
		assert.equal(created.headers.get('cache-control'), 'private, no-store');
		assert.deepEqual(created.json, {
			assignment: {
				membershipId: target.membership.id,
				role: {
					id: A.tech.id,
					code: 'technician',
					name: A.tech.name,
					active: true,
					isCustom: false
				},
				created: true
			}
		});
		assert.ok(!created.text.includes('@'), 'sin datos de perfil en la respuesta de asignación');
		const removed = await revoke(adminA, A.org.id, target.membership.id, A.tech.id);
		assert.equal(removed.status, 204);
		assert.equal(removed.text, '');
		assert.equal(removed.headers.get('cache-control'), 'private, no-store');
		assert.deepEqual(await assignments(target.membership.id), []);
	});

	await t.test(
		'38. 403 org inaccesible/sin capability; 404 recurso ajeno o inexistente',
		async () => {
			const target = await member(A.org);
			assert.equal((await list(techA, A.org.id)).status, 403);
			assert.equal((await detail(techA, A.org.id, target.membership.id)).status, 403);
			assert.equal((await list(adminA, B.org.id)).status, 403);
			assert.equal((await list(adminA, randomUUID())).status, 403);
			assert.equal((await assign(adminA, B.org.id, adminB.membership.id, B.tech.id)).status, 403);
			assert.equal((await revoke(adminA, B.org.id, adminB.membership.id, B.admin.id)).status, 403);
			const viewer = await member(A.org, [await rawRole(A.org, ['memberships:view'])]);
			assert.equal((await list(viewer, A.org.id)).status, 200);
			assert.equal((await assign(viewer, A.org.id, target.membership.id, A.tech.id)).status, 403);
			const foreign = await detail(adminA, A.org.id, adminB.membership.id);
			const missing = await detail(adminA, A.org.id, randomUUID());
			assert.equal(foreign.status, 404);
			assert.deepEqual(foreign.json, missing.json);
			assert.ok(!foreign.text.includes('Beto'));
			const foreignMember = await assign(adminA, A.org.id, adminB.membership.id, A.tech.id);
			const missingMember = await assign(adminA, A.org.id, randomUUID(), A.tech.id);
			assert.equal(foreignMember.status, 404);
			assert.deepEqual(foreignMember.json, missingMember.json);
			const foreignRole = await assign(adminA, A.org.id, target.membership.id, B.tech.id);
			const missingRole = await assign(adminA, A.org.id, target.membership.id, randomUUID());
			assert.equal(foreignRole.status, 404);
			assert.deepEqual(foreignRole.json, missingRole.json);
			assert.equal(foreignRole.json.error.code, 'ROLE_NOT_FOUND');
			const noAssignment = await revoke(adminA, A.org.id, target.membership.id, A.tech.id);
			assert.equal(noAssignment.status, 404);
			assert.equal(noAssignment.json.error.code, 'ROLE_ASSIGNMENT_NOT_FOUND');
			assert.deepEqual(await assignments(adminB.membership.id), [B.admin.id]);
		}
	);

	await t.test(
		'39. estados inactivos por HTTP: 409 MEMBERSHIP_INACTIVE / ROLE_INACTIVE',
		async () => {
			const idle = await member(A.org, [], { membershipActive: false });
			const r1 = await assign(adminA, A.org.id, idle.membership.id, A.tech.id);
			assert.equal(r1.status, 409);
			assert.equal(r1.json.error.code, 'MEMBERSHIP_INACTIVE');
			const off = await rawRole(A.org, [], { active: false });
			const target = await member(A.org);
			const r2 = await assign(adminA, A.org.id, target.membership.id, off.id);
			assert.equal(r2.status, 409);
			assert.equal(r2.json.error.code, 'ROLE_INACTIVE');
			// el actor inactivo no puede administrar nada
			const idleAdmin = await member(A.org, [A.admin], { membershipActive: false });
			assert.equal((await list(idleAdmin, A.org.id)).status, 403);
			assert.equal(
				(await assign(idleAdmin, A.org.id, target.membership.id, A.tech.id)).status,
				403
			);
			const suspended = await organization('Suspendida');
			const suspendedAdmin = await member(suspended.org, [suspended.admin]);
			await db
				.update(s.organizations)
				.set({ status: 'suspended' })
				.where(eq(s.organizations.id, suspended.org.id));
			assert.equal((await list(suspendedAdmin, suspended.org.id)).status, 403);
			await rejectsWith(
				assignRoleToMembership(
					db,
					suspended.org.id,
					suspendedAdmin.membership.id,
					suspended.tech.id,
					ADMIN
				),
				'ORGANIZATION_NOT_OPERATIONAL'
			);
		}
	);

	await t.test(
		'40. errores seguros: sin SQL, stack, constraints ni email; métodos acotados',
		async () => {
			const L = await organization('Errores');
			const only = await member(L.org, [L.admin]);
			const responses = [
				await revoke(only, L.org.id, only.membership.id, L.admin.id),
				await assign(adminA, A.org.id, randomUUID(), A.tech.id),
				await assign(adminA, A.org.id, techA.membership.id, randomUUID()),
				await detail(adminA, A.org.id, randomUUID())
			];
			for (const r of responses) {
				assert.deepEqual(Object.keys(r.json), ['error']);
				assert.deepEqual(Object.keys(r.json.error).sort(), ['code', 'message']);
				for (const leak of [
					'select',
					'insert',
					'delete from',
					'constraint',
					'role_assignments',
					'stack',
					'@example'
				])
					assert.ok(!r.text.toLowerCase().includes(leak), leak);
			}
			assert.deepEqual(Object.keys(listRoute).sort(), ['GET']);
			assert.deepEqual(Object.keys(detailRoute).sort(), ['GET']);
			assert.deepEqual(Object.keys(assignRoute).sort(), ['POST']);
			assert.deepEqual(Object.keys(revokeRoute).sort(), ['DELETE']);
		}
	);

	// =========================================================================
	// R-D: revisión de escalada
	// =========================================================================
	await t.test('R-D. auto-asignación: superior denegada; igual/subconjunto permitido', async () => {
		const own = await rawRole(A.org, ['roles:assign', 'sites:view']);
		const actor = await member(A.org, [own]);
		const denied = await assign(actor, A.org.id, actor.membership.id, A.admin.id);
		assert.equal(denied.status, 403);
		assert.equal(denied.json.error.code, 'PERMISSION_NOT_DELEGABLE');
		const subset = await rawRole(A.org, ['sites:view']);
		assert.equal((await assign(actor, A.org.id, actor.membership.id, subset.id)).status, 201);
		assert.deepEqual(await effective(actor, A.org), catalogOrder(['roles:assign', 'sites:view']));
	});

	await t.test('R-D. escalada vía rol propio: roles:manage sin permisos no amplía', async () => {
		const own = await rawRole(A.org, ['roles:manage', 'roles:assign', 'roles:view']);
		const actor = await member(A.org, [own]);
		const actorPermissions = await effective(actor, A.org);
		await rejectsWith(
			updateCustomRole(db, A.org.id, own.id, actorPermissions, {
				permissions: [...actorPermissions, 'memberships:view']
			}),
			'PERMISSION_NOT_DELEGABLE'
		);
		await rejectsWith(
			createCustomRole(db, A.org.id, actorPermissions, {
				name: 'X',
				code: code(),
				permissions: ['incidents:view_all']
			}),
			'PERMISSION_NOT_DELEGABLE'
		);
		assert.deepEqual(await effective(actor, A.org), actorPermissions);
	});

	await t.test(
		'R-D. spoof: code "organization_admin" custom imposible; autorización nunca por code',
		async () => {
			await rejectsWith(
				createCustomRole(db, A.org.id, ADMIN, {
					name: 'X',
					code: 'organization_admin',
					permissions: []
				}),
				'ROLE_CODE_CONFLICT'
			);
			// un rol llamado como admin pero sin permisos no concede nada
			const fake = await rawRole(A.org, [], {
				name: 'Administrador de organización',
				code: code()
			});
			const who = await member(A.org, [fake]);
			assert.deepEqual(await effective(who, A.org), []);
			assert.equal((await list(who, A.org.id)).status, 403);
		}
	);

	await t.test('R-D. asignación de rol desactivado después no concede capabilities', async () => {
		const role = await createCustomRole(db, A.org.id, ADMIN, {
			name: 'Temporal',
			code: code(),
			permissions: ['sites:manage']
		});
		const who = await member(A.org);
		await assignRoleToMembership(db, A.org.id, who.membership.id, role.id, ADMIN);
		assert.deepEqual(await effective(who, A.org), ['sites:manage']);
		await updateCustomRole(db, A.org.id, role.id, ADMIN, { active: false });
		assert.deepEqual(await effective(who, A.org), []);
		assert.deepEqual(await assignments(who.membership.id), [role.id], 'la asignación se conserva');
		const row = await getOrganizationMembership(db, A.org.id, who.membership.id);
		assert.deepEqual(
			row.roles.map((r) => [r.id, r.active]),
			[[role.id, false]]
		);
	});

	await t.test(
		'R-D. no se reutilizan asignaciones de otro tenant ni scopes no organizativos',
		async () => {
			const target = await member(A.org);
			await assert.rejects(
				db.insert(s.roleAssignments).values({
					organizationId: A.org.id,
					membershipId: target.membership.id,
					roleId: B.tech.id,
					scopeType: 'organization'
				})
			);
			const [site] = await db
				.insert(s.sites)
				.values({ organizationId: A.org.id, name: 'Sede ' + code() })
				.returning();
			await db.insert(s.roleAssignments).values({
				organizationId: A.org.id,
				membershipId: target.membership.id,
				roleId: A.tech.id,
				scopeType: 'site',
				siteId: site.id
			});
			const row = await getOrganizationMembership(db, A.org.id, target.membership.id);
			assert.deepEqual(row.roles, [], 'asignaciones con scope no organizativo no se exponen');
			await rejectsWith(
				revokeRoleFromMembership(db, A.org.id, target.membership.id, A.tech.id, ADMIN),
				'ROLE_ASSIGNMENT_NOT_FOUND'
			);
			const created = await assignRoleToMembership(
				db,
				A.org.id,
				target.membership.id,
				A.tech.id,
				ADMIN
			);
			assert.equal(created.created, true, 'scope organization es una asignación distinta');
		}
	);

	await t.test('R-D. atomicidad: rollback externo revierte asignación y revocación', async () => {
		const target = await member(A.org, [A.tech]);
		const custom = await rawRole(A.org, ['sites:view']);
		await assert.rejects(
			db.transaction(async (tx) => {
				await assignRoleToMembership(tx, A.org.id, target.membership.id, custom.id, ADMIN);
				await revokeRoleFromMembership(tx, A.org.id, target.membership.id, A.tech.id, ADMIN);
				throw new Error('rollback');
			}),
			/rollback/
		);
		assert.deepEqual(await assignments(target.membership.id), [A.tech.id]);
	});

	await t.test(
		'R-D. sin frontend trust: no hay cabeceras de identidad ni organizationId en body',
		async () => {
			for (const file of [
				'src/routes/api/memberships/+server.ts',
				'src/routes/api/memberships/[id]/+server.ts',
				'src/routes/api/memberships/[id]/roles/+server.ts',
				'src/routes/api/memberships/[id]/roles/[roleId]/+server.ts',
				'src/lib/server/services/memberships.ts'
			]) {
				const source = fs.readFileSync(file, 'utf8');
				for (const forbidden of [
					'x-user-id',
					'x-organization-id',
					'x-membership-id',
					"code === 'organization_admin'"
				])
					assert.ok(!source.includes(forbidden), `${file}: ${forbidden}`);
			}
			const target = await member(A.org);
			const spoof = await assign(adminA, A.org.id, target.membership.id, undefined, {
				body: { roleId: A.tech.id, organizationId: B.org.id }
			});
			assert.equal(spoof.status, 400);
		}
	);

	// =========================================================================
	// E2E
	// =========================================================================
	await t.test(
		'E2E: Admin lista, asigna custom, /api/me cambia, revoca, último admin protegido',
		async () => {
			const E = await organization('E2E');
			const admin = await member(E.org, [E.admin], { name: 'Admin E2E' });
			const worker = await member(E.org, [], { name: 'Worker E2E' });
			const listed = await list(admin, E.org.id);
			assert.equal(listed.status, 200);
			assert.deepEqual(
				listed.json.memberships.map((m) => m.user.name),
				['Admin E2E', 'Worker E2E']
			);
			assert.deepEqual(await me(worker, E.org), []);
			const role = await createCustomRole(db, E.org.id, ADMIN, {
				name: 'Consultor',
				code: 'consultor',
				permissions: ['sites:view', 'categories:view']
			});
			const assigned = await assign(admin, E.org.id, worker.membership.id, role.id);
			assert.equal(assigned.status, 201);
			assert.deepEqual(await me(worker, E.org), ['sites:view', 'categories:view']);
			const shown = await detail(admin, E.org.id, worker.membership.id);
			assert.deepEqual(
				shown.json.membership.roles.map((r) => r.code),
				['consultor']
			);
			assert.equal((await revoke(admin, E.org.id, worker.membership.id, role.id)).status, 204);
			assert.deepEqual(await me(worker, E.org), []);
			const last = await revoke(admin, E.org.id, admin.membership.id, E.admin.id);
			assert.equal(last.status, 409);
			assert.equal(last.json.error.code, 'LAST_ADMIN_REQUIRED');
			assert.deepEqual(await me(admin, E.org), ADMIN);
		}
	);
});

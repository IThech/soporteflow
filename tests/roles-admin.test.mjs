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
	createSession,
	createTamperedCookie
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

test('SoporteFlow — Etapa 5.4R-A: read model de administración de roles', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;
	const service = await server.ssrLoadModule('/src/lib/server/services/roles.ts');
	const {
		ensureOrganizationRoles,
		listOrganizationRoles,
		getOrganizationRole,
		listCanonicalPermissions
	} = service;
	const { PERMISSION_CATALOG, PERMISSION_IDS } = await server.ssrLoadModule(
		'/src/lib/server/auth/permissions.ts'
	);
	const { ROLE_TEMPLATES } = await server.ssrLoadModule('/src/lib/server/auth/role-templates.ts');
	const { IncidentServiceError } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);
	const rolesRoute = await server.ssrLoadModule('/src/routes/api/roles/+server.ts');
	const roleRoute = await server.ssrLoadModule('/src/routes/api/roles/[id]/+server.ts');
	const permissionsRoute = await server.ssrLoadModule('/src/routes/api/permissions/+server.ts');

	const catalogOrder = (ids) => PERMISSION_IDS.filter((id) => ids.includes(id));
	const ADMIN = catalogOrder([...ROLE_TEMPLATES[0].permissionIds]);
	const TECHNICIAN = catalogOrder([...ROLE_TEMPLATES[1].permissionIds]);
	const ROLE_KEYS = [
		'active',
		'code',
		'description',
		'id',
		'isCustom',
		'name',
		'permissions',
		'templateId'
	];

	async function rejectsWith(operation, code) {
		await assert.rejects(operation, (error) => {
			assert.ok(error instanceof IncidentServiceError, `esperado IncidentServiceError: ${error}`);
			assert.equal(error.code, code);
			return true;
		});
	}
	async function organization(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'ra-' + randomUUID(), status: 'active' })
			.returning();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		return {
			org,
			admin: roles.find((r) => r.code === 'organization_admin'),
			tech: roles.find((r) => r.code === 'technician')
		};
	}
	async function customRole(org, permissionIds, values = {}) {
		const [role] = await db
			.insert(s.roles)
			.values({
				organizationId: org.id,
				name: 'Custom',
				code: 'custom_' + randomUUID().slice(0, 8),
				isCustom: true,
				...values
			})
			.returning();
		for (const permissionId of permissionIds)
			await db.insert(s.rolePermissions).values({ roleId: role.id, permissionId });
		return role;
	}
	async function member(org, roles = []) {
		const user = await createCredentialUser(f);
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
		for (const role of roles)
			await db.insert(s.roleAssignments).values({
				organizationId: org.id,
				membershipId: membership.id,
				roleId: role.id,
				scopeType: 'organization'
			});
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, cookie: session.cookieHeader };
	}
	async function call(
		handler,
		path,
		{ cookie, organizationId, query = '', id, headers: extra } = {}
	) {
		const qs = organizationId === null ? '' : `organizationId=${organizationId}`;
		const url = new URL(`http://localhost${path}?${qs}${query}`);
		const headers = new Headers(extra);
		if (cookie) headers.set('cookie', cookie);
		const response = await handler({
			url,
			params: id === undefined ? {} : { id },
			request: new Request(url, { headers })
		});
		const text = await response.text();
		return {
			status: response.status,
			json: text ? JSON.parse(text) : null,
			text,
			headers: response.headers
		};
	}

	const A = await organization('Alfa');
	const B = await organization('Beta');
	const admin = await member(A.org, [A.admin]);
	const tech = await member(A.org, [A.tech]);

	// =========================================================================
	// Migración 0013
	// =========================================================================
	await t.test(
		'DB nueva: roles:view/roles:manage en catálogo y plantilla Admin, no en Technician',
		async () => {
			const perms = await db.select().from(s.permissions);
			for (const id of ['roles:view', 'roles:manage']) {
				const row = perms.find((p) => p.id === id);
				const canonical = PERMISSION_CATALOG.find((p) => p.id === id);
				assert.ok(row, id);
				assert.equal(row.name, canonical.name);
				assert.deepEqual(row.allowedScopeTypes, ['organization']);
			}
			const templatePerms = async (id) =>
				(
					await db
						.select()
						.from(s.roleTemplatePermissions)
						.where(eq(s.roleTemplatePermissions.roleTemplateId, id))
				).map((r) => r.permissionId);
			assert.ok((await templatePerms('tpl_organization_admin')).includes('roles:view'));
			assert.ok((await templatePerms('tpl_organization_admin')).includes('roles:manage'));
			assert.ok(!(await templatePerms('tpl_technician')).some((p) => p.startsWith('roles:')));
			assert.ok(ADMIN.includes('roles:view') && ADMIN.includes('roles:manage'));
			assert.ok(!TECHNICIAN.some((p) => p.startsWith('roles:')));
			// una org inicializada después recibe Admin con los nuevos permisos
			assert.deepEqual((await getOrganizationRole(db, A.org.id, A.admin.id)).permissions, ADMIN);
			assert.deepEqual(
				(await getOrganizationRole(db, A.org.id, A.tech.id)).permissions,
				TECHNICIAN
			);
		}
	);

	await t.test(
		'upgrade 0012 -> 0013: Admin existente recibe roles:*, conserva id, asignaciones y extras',
		async () => {
			const up = new PGlite();
			try {
				const index = journalIndex('0013_roles_admin_permissions');
				await applyRange(up, 0, index - 1);
				const org = randomUUID();
				const user = randomUUID();
				await up.query(
					`INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Up', $2, 'active')`,
					[org, 'up-' + org]
				);
				await up.query(`INSERT INTO users (id, name) VALUES ($1, 'U')`, [user]);
				const {
					rows: [m]
				} = await up.query(
					`INSERT INTO memberships (organization_id, user_id) VALUES ($1, $2) RETURNING id`,
					[org, user]
				);
				// roles creados por la lógica de 0012 (misma SQL que ensureOrganizationRoles)
				await up.exec(`INSERT INTO roles (organization_id, name, code, description, template_id, is_custom, active)
				SELECT '${org}', t.name, t.code, t.description, t.id, false, true FROM role_templates t;
				INSERT INTO role_permissions (role_id, permission_id)
				SELECT r.id, tp.permission_id FROM roles r JOIN role_template_permissions tp ON tp.role_template_id = r.template_id;`);
				const {
					rows: [adminRole]
				} = await up.query(
					`SELECT id FROM roles WHERE organization_id = $1 AND code = 'organization_admin'`,
					[org]
				);
				const {
					rows: [techRole]
				} = await up.query(
					`SELECT id FROM roles WHERE organization_id = $1 AND code = 'technician'`,
					[org]
				);
				await up.query(
					`INSERT INTO role_assignments (organization_id, membership_id, role_id, scope_type) VALUES ($1, $2, $3, 'organization')`,
					[org, m.id, adminRole.id]
				);
				await up.query(
					`DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = 'teams:view'`,
					[adminRole.id]
				);
				const perms = async (id) =>
					(
						await up.query(
							`SELECT permission_id FROM role_permissions WHERE role_id = $1 ORDER BY permission_id`,
							[id]
						)
					).rows.map((r) => r.permission_id);
				const before = await perms(adminRole.id);
				assert.ok(!before.includes('roles:view'));

				await applyRange(up, index, index);
				const after = await perms(adminRole.id);
				assert.deepEqual(
					after,
					[...before, 'roles:manage', 'roles:view'].sort(),
					'solo añade; divergencia (sin teams:view) preservada'
				);
				assert.ok(!(await perms(techRole.id)).some((p) => p.startsWith('roles:')));
				const { rows: assignments } = await up.query(`SELECT role_id FROM role_assignments`);
				assert.deepEqual(
					assignments.map((a) => a.role_id),
					[adminRole.id]
				);
				// idempotente
				await applyRange(up, index, index);
				assert.deepEqual(await perms(adminRole.id), after);
			} finally {
				await up.close();
			}
		}
	);

	// =========================================================================
	// Servicio (1-10)
	// =========================================================================
	await t.test(
		'servicio 1-5, 10: lista vacía, roles de sistema, custom, inactivo y orden',
		async () => {
			const [empty] = await db
				.insert(s.organizations)
				.values({ name: 'Vacía', slug: 'v-' + randomUUID(), status: 'active' })
				.returning();
			assert.deepEqual(await listOrganizationRoles(db, empty.id), []);
			const custom = await customRole(A.org, ['sites:view', 'teams:view'], {
				code: 'auditor',
				name: 'Auditor',
				description: 'Solo lectura'
			});
			const inactive = await customRole(A.org, ['categories:view'], {
				code: 'zz_old',
				active: false
			});
			const roles = await listOrganizationRoles(db, A.org.id);
			assert.deepEqual(
				roles.map((r) => r.code),
				[...roles.map((r) => r.code)].sort()
			);
			const byCode = Object.fromEntries(roles.map((r) => [r.code, r]));
			assert.deepEqual(Object.keys(byCode.organization_admin).sort(), ROLE_KEYS);
			assert.deepEqual(byCode.organization_admin, {
				id: A.admin.id,
				code: 'organization_admin',
				name: 'Administrador de organización',
				description: byCode.organization_admin.description,
				templateId: 'tpl_organization_admin',
				isCustom: false,
				active: true,
				permissions: ADMIN
			});
			assert.equal(byCode.technician.templateId, 'tpl_technician');
			assert.deepEqual(byCode.technician.permissions, TECHNICIAN);
			assert.deepEqual(byCode.auditor, {
				id: custom.id,
				code: 'auditor',
				name: 'Auditor',
				description: 'Solo lectura',
				templateId: null,
				isCustom: true,
				active: true,
				permissions: ['sites:view', 'teams:view']
			});
			assert.equal(byCode.zz_old.active, false);
			assert.deepEqual(byCode.zz_old.permissions, ['categories:view']);
			assert.ok(
				!(await listOrganizationRoles(db, A.org.id, { activeOnly: true })).some(
					(r) => r.id === inactive.id
				)
			);
		}
	);

	await t.test(
		'servicio 6-9: cross-tenant, inexistente, divergencia y plantilla no usada en runtime',
		async () => {
			await rejectsWith(getOrganizationRole(db, A.org.id, B.admin.id), 'ROLE_NOT_FOUND');
			await rejectsWith(getOrganizationRole(db, A.org.id, randomUUID()), 'ROLE_NOT_FOUND');
			await rejectsWith(getOrganizationRole(db, A.org.id, 'x'), 'INVALID_INPUT');
			await rejectsWith(listOrganizationRoles(db, 'x'), 'INVALID_INPUT');
			const C = await organization('Gamma');
			await db
				.insert(s.rolePermissions)
				.values({ roleId: C.tech.id, permissionId: 'sites:manage' });
			await db
				.delete(s.rolePermissions)
				.where(
					and(
						eq(s.rolePermissions.roleId, C.tech.id),
						eq(s.rolePermissions.permissionId, 'teams:view')
					)
				);
			await db
				.insert(s.permissions)
				.values({
					id: 'custom:thing',
					name: 'X',
					category: 'x',
					allowedScopeTypes: ['organization']
				})
				.onConflictDoNothing();
			await db
				.insert(s.rolePermissions)
				.values({ roleId: C.tech.id, permissionId: 'custom:thing' });
			const role = await getOrganizationRole(db, C.org.id, C.tech.id);
			assert.deepEqual(
				role.permissions,
				catalogOrder([...TECHNICIAN.filter((p) => p !== 'teams:view'), 'sites:manage'])
			);
			assert.ok(!role.permissions.includes('custom:thing'));
			// la plantilla sigue teniendo teams:view: el read model no la usa
			const tp = await db
				.select()
				.from(s.roleTemplatePermissions)
				.where(
					and(
						eq(s.roleTemplatePermissions.roleTemplateId, 'tpl_technician'),
						eq(s.roleTemplatePermissions.permissionId, 'teams:view')
					)
				);
			assert.equal(tp.length, 1);
			assert.deepEqual(
				listCanonicalPermissions().map((p) => p.id),
				[...PERMISSION_IDS]
			);
		}
	);

	// =========================================================================
	// /api/permissions (11-20)
	// =========================================================================
	await t.test('/api/permissions 11-20', async () => {
		const path = '/api/permissions';
		const ok = await call(permissionsRoute.GET, path, {
			cookie: admin.cookie,
			organizationId: A.org.id
		});
		assert.equal(ok.status, 200);
		assert.equal(ok.headers.get('cache-control'), 'private, no-store');
		assert.deepEqual(Object.keys(ok.json), ['permissions']);
		assert.deepEqual(
			ok.json.permissions,
			PERMISSION_CATALOG.map((p) => ({
				id: p.id,
				name: p.name,
				description: p.description,
				category: p.category,
				allowedScopeTypes: [...p.allowedScopeTypes]
			}))
		);
		const ids = ok.json.permissions.map((p) => p.id);
		assert.ok(ids.includes('roles:view') && ids.includes('roles:manage'));
		assert.ok(!ids.some((id) => id.startsWith('platform:')) && !ids.includes('custom:thing'));
		assert.ok(!ok.text.includes('createdAt') && !ok.text.includes('created_at'));
		assert.equal(
			(await call(permissionsRoute.GET, path, { cookie: tech.cookie, organizationId: A.org.id }))
				.status,
			403
		);
		const viewer = await member(A.org, [await customRole(A.org, ['roles:view'])]);
		assert.equal(
			(await call(permissionsRoute.GET, path, { cookie: viewer.cookie, organizationId: A.org.id }))
				.status,
			200
		);
		for (const cookie of ['', createTamperedCookie()])
			assert.equal(
				(await call(permissionsRoute.GET, path, { cookie, organizationId: A.org.id })).status,
				401
			);
		for (const orgId of [B.org.id, randomUUID()]) {
			const res = await call(permissionsRoute.GET, path, {
				cookie: admin.cookie,
				organizationId: orgId
			});
			assert.equal(res.status, 403);
			assert.deepEqual(res.json, { error: { code: 'FORBIDDEN', message: 'Permission denied.' } });
		}
		for (const options of [
			{ organizationId: null },
			{ organizationId: 'x' },
			{ organizationId: A.org.id, query: '&x=1' }
		])
			assert.equal(
				(await call(permissionsRoute.GET, path, { cookie: admin.cookie, ...options })).status,
				400
			);
		assert.deepEqual(Object.keys(permissionsRoute).sort(), ['GET']);
	});

	// =========================================================================
	// /api/roles (21-30)
	// =========================================================================
	await t.test(
		'/api/roles 21, 25: lista con permisos reales, inactivos visibles y activeOnly',
		async () => {
			const res = await call(rolesRoute.GET, '/api/roles', {
				cookie: admin.cookie,
				organizationId: A.org.id
			});
			assert.equal(res.status, 200);
			assert.deepEqual(Object.keys(res.json), ['roles']);
			const codes = res.json.roles.map((r) => r.code);
			assert.ok(
				codes.includes('organization_admin') &&
					codes.includes('technician') &&
					codes.includes('auditor') &&
					codes.includes('zz_old')
			);
			for (const role of res.json.roles) assert.deepEqual(Object.keys(role).sort(), ROLE_KEYS);
			assert.deepEqual(
				res.json.roles,
				(await listOrganizationRoles(db, A.org.id)).map((r) => ({ ...r }))
			);
			const active = await call(rolesRoute.GET, '/api/roles', {
				cookie: admin.cookie,
				organizationId: A.org.id,
				query: '&activeOnly=true'
			});
			assert.ok(active.json.roles.every((r) => r.active));
			assert.ok(!active.json.roles.some((r) => r.code === 'zz_old'));
			for (const query of [
				'&activeOnly=1',
				'&activeOnly=',
				'&x=1',
				'&activeOnly=true&activeOnly=false'
			])
				assert.equal(
					(
						await call(rolesRoute.GET, '/api/roles', {
							cookie: admin.cookie,
							organizationId: A.org.id,
							query
						})
					).status,
					400
				);
			for (const leak of [A.org.id, 'organizationId', 'membershipId', 'assignment', 'createdAt'])
				assert.ok(!res.text.includes(leak), leak);
		}
	);

	await t.test(
		'/api/roles/[id] 22-24, 26-30: detalle Admin/Technician/custom, tenant ajeno, inexistente',
		async () => {
			const detail = (id, cookie = admin.cookie, organizationId = A.org.id) =>
				call(roleRoute.GET, `/api/roles/${id}`, { id, cookie, organizationId });
			const a = await detail(A.admin.id);
			assert.equal(a.status, 200);
			assert.deepEqual(Object.keys(a.json), ['role']);
			assert.deepEqual(a.json.role.permissions, ADMIN);
			const tRes = await detail(A.tech.id);
			assert.deepEqual(tRes.json.role.permissions, TECHNICIAN);
			const custom = (await listOrganizationRoles(db, A.org.id)).find((r) => r.code === 'auditor');
			const c = await detail(custom.id);
			assert.equal(c.json.role.isCustom, true);
			assert.equal(c.json.role.templateId, null);
			const foreign = await detail(B.admin.id);
			const missing = await detail(randomUUID());
			assert.equal(foreign.status, 404);
			assert.deepEqual(foreign.json, {
				error: { code: 'ROLE_NOT_FOUND', message: 'Role not found.' }
			});
			assert.deepEqual(foreign.json, missing.json);
			assert.ok(!foreign.text.includes(B.org.id) && !foreign.text.includes('Beta'));
			assert.equal((await detail('x')).status, 400);
			assert.equal((await detail(A.admin.id, tech.cookie)).status, 403);
			assert.equal((await detail(A.admin.id, '')).status, 401);
			// 5.4R-B añade POST (lista) y PATCH (detalle); nunca DELETE
			assert.deepEqual(Object.keys(roleRoute).sort(), ['GET', 'PATCH']);
			assert.deepEqual(Object.keys(rolesRoute).sort(), ['GET', 'POST']);
		}
	);

	await t.test(
		'autorización por capability, no por código de rol; cabeceras ignoradas; roles inactivos sin runtime',
		async () => {
			// custom role con roles:view accede; technician no
			const viewer = await member(A.org, [
				await customRole(A.org, ['roles:view'], { code: 'technician_like' })
			]);
			assert.equal(
				(
					await call(rolesRoute.GET, '/api/roles', {
						cookie: viewer.cookie,
						organizationId: A.org.id
					})
				).status,
				200
			);
			assert.equal(
				(
					await call(rolesRoute.GET, '/api/roles', {
						cookie: tech.cookie,
						organizationId: A.org.id
					})
				).status,
				403
			);
			// roles:manage sin roles:view no basta
			const managerOnly = await member(A.org, [await customRole(A.org, ['roles:manage'])]);
			assert.equal(
				(
					await call(rolesRoute.GET, '/api/roles', {
						cookie: managerOnly.cookie,
						organizationId: A.org.id
					})
				).status,
				403
			);
			// cabeceras de identidad/tenant ignoradas
			const spoof = { 'x-user-id': admin.user.id, 'x-organization-id': A.org.id };
			assert.equal(
				(
					await call(rolesRoute.GET, '/api/roles', {
						cookie: tech.cookie,
						organizationId: A.org.id,
						headers: spoof
					})
				).status,
				403
			);
			// rol Admin inactivo: sigue visible en administración pero ya no concede roles:view
			const D = await organization('Delta');
			const dAdmin = await member(D.org, [D.admin]);
			assert.equal(
				(
					await call(rolesRoute.GET, '/api/roles', {
						cookie: dAdmin.cookie,
						organizationId: D.org.id
					})
				).status,
				200
			);
			await db.update(s.roles).set({ active: false }).where(eq(s.roles.id, D.admin.id));
			assert.equal(
				(
					await call(rolesRoute.GET, '/api/roles', {
						cookie: dAdmin.cookie,
						organizationId: D.org.id
					})
				).status,
				403
			);
			const listed = await listOrganizationRoles(db, D.org.id);
			const inactiveAdmin = listed.find((r) => r.id === D.admin.id);
			assert.equal(inactiveAdmin.active, false);
			assert.deepEqual(inactiveAdmin.permissions, ADMIN);
		}
	);
});

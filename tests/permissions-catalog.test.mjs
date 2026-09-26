import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import {
	fixture,
	directory,
	expectedMigrations,
	createCredentialUser,
	createSession,
	grantPermission
} from './helpers/auth-fixture.mjs';
import { applyMigrations } from './helpers/persistence-migrations.mjs';

/** Ids seeded by migration 0011 (5.4Q-B). */
const IDS_0011 = [
	'incidents:create',
	'incidents:view_all',
	'incidents:view_own',
	'incidents:edit',
	'incidents:assign',
	'incidents:add_comment',
	'incidents:view_internal_notes',
	'incidents:add_internal_note',
	'sites:view',
	'sites:manage',
	'categories:view',
	'categories:manage',
	'teams:view',
	'identities:create',
	'memberships:create',
	'roles:assign'
];
/** 5.4S permissions seeded by migration 0015 (5.4S-A). */
const IDS_0015 = [
	'incidents:view_requested',
	'invitations:create',
	'invitations:view',
	'invitations:revoke'
];
/**
 * Current canonical catalog, in catalog order: 0011 + role administration (0013, 5.4R-A) +
 * memberships:view (0014, 5.4R-C) + 5.4S (0015) + sla:view/sla:manage (0017, 5.4T-A);
 * view_requested sits in the incidents group.
 */
const EXPECTED_IDS = [
	'incidents:create',
	'incidents:view_all',
	'incidents:view_own',
	'incidents:view_requested',
	...IDS_0011.slice(3),
	'roles:view',
	'roles:manage',
	'memberships:view',
	'invitations:create',
	'invitations:view',
	'invitations:revoke',
	'sla:view',
	'sla:manage'
];
const ID_PATTERN = /^[a-z][a-z_]*:[a-z][a-z_]*$/;
const SCOPES = ['organization', 'department', 'team', 'site', 'personal'];

/** Applies the journal migrations whose index is within [from, to] (inclusive). */
async function applyRange(pg, from, to) {
	const journal = JSON.parse(fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8'));
	for (const entry of journal.entries.slice(from, to + 1)) {
		const sql = fs.readFileSync(path.join(directory, entry.tag + '.sql'), 'utf8');
		for (const statement of sql.split('--> statement-breakpoint'))
			if (statement.trim()) await pg.exec(statement);
	}
}

async function permissionRows(pg) {
	return (
		await pg.query(
			`SELECT id, name, description, category, allowed_scope_types FROM permissions ORDER BY id`
		)
	).rows;
}

test('SoporteFlow — Etapa 5.4Q-B: catálogo canónico de permisos', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, pg, server } = f;
	const catalogModule = await server.ssrLoadModule('/src/lib/server/auth/permissions.ts');
	const { PERMISSION_CATALOG, PERMISSION_IDS, isPermissionId } = catalogModule;
	const auth = await server.ssrLoadModule('/src/lib/server/auth/authorization.ts');

	// =========================================================================
	// Catálogo TypeScript (1-26)
	// =========================================================================
	await t.test('1-3. no vacío, ids únicos y formato resource:action', () => {
		assert.ok(PERMISSION_CATALOG.length > 0);
		assert.equal(new Set(PERMISSION_IDS).size, PERMISSION_IDS.length);
		for (const permission of PERMISSION_CATALOG) {
			assert.match(permission.id, ID_PATTERN, permission.id);
			assert.equal(permission.id, permission.id.trim());
			assert.ok(permission.name.trim().length > 0);
			assert.ok(permission.description.trim().length > 0);
			assert.ok(permission.category.trim().length > 0 && permission.category.length <= 50);
			assert.ok(permission.id.length <= 100 && permission.name.length <= 255);
		}
		assert.deepEqual(
			[...PERMISSION_IDS],
			PERMISSION_CATALOG.map((p) => p.id)
		);
	});

	await t.test('4-19. contiene exactamente los permisos canónicos Core v1', () => {
		for (const id of EXPECTED_IDS) assert.ok(PERMISSION_IDS.includes(id), id);
		assert.deepEqual([...PERMISSION_IDS].sort(), [...EXPECTED_IDS].sort());
		assert.deepEqual([...PERMISSION_IDS], EXPECTED_IDS, 'orden determinista del catálogo');
		assert.equal(new Set(PERMISSION_IDS).size, PERMISSION_IDS.length);
		for (const id of EXPECTED_IDS) assert.equal(isPermissionId(id), true);
		for (const value of ['foo:bar', 'incidents:view_all ', '', null, 42])
			assert.equal(isPermissionId(value), false);
	});

	await t.test('20-24. excluye legacy y futuros (view_requested entra en 0015)', () => {
		for (const id of [
			'platform:manage',
			'incidents:delete',
			'incidents:classify',
			'incidents:override_priority',
			'memberships:manage',
			'invitations:accept',
			'organization:manage',
			'users:manage',
			'users:view'
		])
			assert.ok(!PERMISSION_IDS.includes(id), id);
		assert.ok(!PERMISSION_IDS.some((id) => id.startsWith('platform:')));
	});

	await t.test(
		'5.4S-A: metadata de los permisos 0015 (DB = catálogo, scope organization)',
		async () => {
			const rows = (
				await pg.query(
					`SELECT id, name, description, category, allowed_scope_types FROM permissions WHERE id = ANY($1) ORDER BY id`,
					[IDS_0015]
				)
			).rows;
			assert.equal(rows.length, 4);
			for (const row of rows) {
				const canonical = PERMISSION_CATALOG.find((p) => p.id === row.id);
				assert.equal(row.name, canonical.name);
				assert.equal(row.description, canonical.description);
				assert.equal(row.category, canonical.category);
				assert.deepEqual(row.allowed_scope_types, ['organization']);
			}
			assert.equal(
				PERMISSION_CATALOG.find((p) => p.id === 'incidents:view_requested').category,
				'incidents'
			);
			for (const id of IDS_0015.slice(1))
				assert.equal(PERMISSION_CATALOG.find((p) => p.id === id).category, 'invitations');
		}
	);

	await t.test(
		'25-26. allowed scopes válidos; organization en todos (sin scopes granulares)',
		() => {
			for (const permission of PERMISSION_CATALOG) {
				assert.ok(permission.allowedScopeTypes.length > 0);
				for (const scope of permission.allowedScopeTypes) assert.ok(SCOPES.includes(scope), scope);
				assert.deepEqual([...permission.allowedScopeTypes], ['organization'], permission.id);
			}
		}
	);

	// =========================================================================
	// Migración sobre DB vacía y sobre DB existente
	// =========================================================================
	await t.test(
		'DB vacía: tras migrar, permissions == catálogo exacto (ya no hay 0 permisos)',
		async () => {
			const clean = new PGlite();
			try {
				const applied = await applyMigrations(clean, directory);
				assert.deepEqual(applied, expectedMigrations);
				assert.ok(applied.includes('0011_permissions_catalog.sql'));
				const rows = await permissionRows(clean);
				assert.equal(rows.length, PERMISSION_CATALOG.length);
				assert.deepEqual(
					rows,
					[...PERMISSION_CATALOG]
						.map((p) => ({
							id: p.id,
							name: p.name,
							description: p.description,
							category: p.category,
							allowed_scope_types: [...p.allowedScopeTypes]
						}))
						.sort((a, b) => (a.id < b.id ? -1 : 1))
				);
				// 5.4Q-C: 0012 seeds role_templates; with no organizations there are no tenant roles.
				for (const table of ['roles', 'role_permissions', 'role_assignments']) {
					const { rows: count } = await clean.query(`SELECT count(*)::int AS n FROM ${table}`);
					assert.equal(count[0].n, 0, `${table} sigue vacía (sin roles base ni grants)`);
				}
			} finally {
				await clean.close();
			}
		}
	);

	await t.test(
		'DB existente: 0011 no borra, no rompe relaciones y solo estrecha scopes',
		async () => {
			const upgrade = new PGlite();
			try {
				const journal = JSON.parse(
					fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')
				);
				const index0011 = journal.entries.findIndex((e) => e.tag === '0011_permissions_catalog');
				await applyRange(upgrade, 0, index0011 - 1);
				const org = randomUUID();
				const role = randomUUID();
				await upgrade.query(
					`INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Up', $2, 'active')`,
					[org, 'up-' + org]
				);
				await upgrade.query(
					`INSERT INTO roles (id, organization_id, name, code) VALUES ($1, $2, 'Legacy', 'legacy')`,
					[role, org]
				);
				// compatible existente, uno con scopes más amplios, uno sin organization y uno custom
				await upgrade.query(`INSERT INTO permissions (id, name, category, allowed_scope_types) VALUES
				('incidents:view_all', 'Nombre viejo', 'old', ARRAY['organization']),
				('incidents:edit', 'Editar viejo', 'old', ARRAY['organization','team','site']),
				('sites:view', 'Solo equipo', 'old', ARRAY['team']),
				('custom:thing', 'Custom', 'custom', ARRAY['organization','team'])`);
				for (const permission of [
					'incidents:view_all',
					'incidents:edit',
					'sites:view',
					'custom:thing'
				])
					await upgrade.query(
						`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`,
						[role, permission]
					);

				await applyRange(upgrade, index0011, index0011);
				// idempotente: re-aplicar no duplica ni cambia nada
				const once = await permissionRows(upgrade);
				await applyRange(upgrade, index0011, index0011);
				assert.deepEqual(await permissionRows(upgrade), once);

				const byId = Object.fromEntries(once.map((r) => [r.id, r]));
				for (const id of IDS_0011) assert.ok(byId[id], `canónico ${id} presente (0011)`);
				assert.deepEqual(
					byId['custom:thing'],
					{
						id: 'custom:thing',
						name: 'Custom',
						description: null,
						category: 'custom',
						allowed_scope_types: ['organization', 'team']
					},
					'desconocido intacto'
				);
				assert.equal(
					byId['incidents:view_all'].name,
					'Ver todas las incidencias',
					'metadata corregida'
				);
				assert.deepEqual(
					byId['incidents:edit'].allowed_scope_types,
					['organization'],
					'scopes estrechados'
				);
				assert.deepEqual(
					byId['sites:view'].allowed_scope_types,
					[],
					'nunca se amplía: sin organization previo queda vacío (fail-closed)'
				);
				const { rows: links } = await upgrade.query(
					`SELECT permission_id FROM role_permissions WHERE role_id = $1 ORDER BY permission_id`,
					[role]
				);
				assert.deepEqual(
					links.map((l) => l.permission_id),
					['custom:thing', 'incidents:edit', 'incidents:view_all', 'sites:view']
				);
				assert.equal(once.length, IDS_0011.length + 1);
			} finally {
				await upgrade.close();
			}
		}
	);

	// =========================================================================
	// Sin grants por defecto, fail-closed y compatibilidad con grantPermission
	// =========================================================================
	const [org] = await db
		.insert(s.organizations)
		.values({ name: 'Catálogo', slug: randomUUID(), status: 'active' })
		.returning();
	async function member(organization = org) {
		const user = await createCredentialUser(f);
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: organization.id, userId: user.id })
			.returning();
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, session };
	}
	const can = (who, permissionId, organization = org) =>
		auth.authorizeAction(who.session.headers, { organizationId: organization.id, permissionId });

	await t.test(
		'sin grants por defecto: un membership sin roles no obtiene ningún permiso',
		async () => {
			const plain = await member();
			for (const id of PERMISSION_IDS) assert.equal(await can(plain, id), false, id);
			assert.deepEqual(
				await auth.resolveOrganizationPermissions(plain.session.headers, org.id),
				[]
			);
			const { GET } = await server.ssrLoadModule('/src/routes/api/sites/+server.ts');
			const url = new URL(`http://localhost/api/sites?organizationId=${org.id}`);
			assert.equal(
				(await GET({ url, request: new Request(url, { headers: plain.session.headers }) })).status,
				403
			);
			const { rows } = await pg.query(
				`SELECT count(*)::int AS n FROM role_assignments WHERE membership_id = $1`,
				[plain.membership.id]
			);
			assert.equal(rows[0].n, 0);
		}
	);

	await t.test(
		'grantPermission reutiliza la fila canónica sin duplicarla ni ampliar scopes',
		async () => {
			const before = await permissionRows(pg);
			const holder = await member();
			await grantPermission(f, {
				organizationId: org.id,
				membershipId: holder.membership.id,
				permissionId: 'teams:view'
			});
			await grantPermission(f, {
				organizationId: org.id,
				membershipId: holder.membership.id,
				permissionId: 'teams:view'
			});
			const after = await permissionRows(pg);
			assert.deepEqual(
				after.filter((r) => EXPECTED_IDS.includes(r.id)),
				before.filter((r) => EXPECTED_IDS.includes(r.id))
			);
			assert.equal(await can(holder, 'teams:view'), true);
			assert.equal(await can(holder, 'incidents:assign'), false, 'sin herencia implícita');
		}
	);

	await t.test('fail-closed intacto con el catálogo sembrado', async () => {
		async function roleWith(permissionIds, { active = true } = {}) {
			const [role] = await db
				.insert(s.roles)
				.values({ organizationId: org.id, name: 'R', code: 'R' + randomUUID(), active })
				.returning();
			for (const permissionId of permissionIds)
				await db.insert(s.rolePermissions).values({ roleId: role.id, permissionId });
			return role;
		}
		async function assign(who, role) {
			await db.insert(s.roleAssignments).values({
				organizationId: org.id,
				membershipId: who.membership.id,
				roleId: role.id,
				scopeType: 'organization'
			});
		}
		const ok = await member();
		await assign(ok, await roleWith(['sites:view']));
		assert.equal(await can(ok, 'sites:view'), true, 'control positivo');
		assert.equal(await can(ok, 'foo:bar'), false, 'permiso inexistente');
		assert.equal(await can(ok, 'sites:manage'), false, 'permiso no concedido');

		const empty = await member();
		await assign(empty, await roleWith([]));
		assert.equal(await can(empty, 'sites:view'), false, 'rol sin permisos');

		assert.equal(await can(await member(), 'sites:view'), false, 'membership sin rol');

		const inactiveRole = await member();
		await assign(inactiveRole, await roleWith(['sites:view'], { active: false }));
		assert.equal(await can(inactiveRole, 'sites:view'), false, 'rol inactivo');

		const inactiveMember = await member();
		await assign(inactiveMember, await roleWith(['sites:view']));
		await db
			.update(s.memberships)
			.set({ active: false })
			.where(eq(s.memberships.id, inactiveMember.membership.id));
		assert.equal(await can(inactiveMember, 'sites:view'), false, 'membership inactiva');

		const [suspended] = await db
			.insert(s.organizations)
			.values({ name: 'Susp', slug: randomUUID(), status: 'active' })
			.returning();
		const suspendedMember = await member(suspended);
		const [roleS] = await db
			.insert(s.roles)
			.values({ organizationId: suspended.id, name: 'R', code: 'RS' })
			.returning();
		await db.insert(s.rolePermissions).values({ roleId: roleS.id, permissionId: 'sites:view' });
		await db.insert(s.roleAssignments).values({
			organizationId: suspended.id,
			membershipId: suspendedMember.membership.id,
			roleId: roleS.id,
			scopeType: 'organization'
		});
		assert.equal(await can(suspendedMember, 'sites:view', suspended), true);
		await db
			.update(s.organizations)
			.set({ status: 'suspended' })
			.where(eq(s.organizations.id, suspended.id));
		assert.equal(await can(suspendedMember, 'sites:view', suspended), false, 'org no activa');

		// platform:* sigue ignorado aunque exista y esté concedido
		await db
			.insert(s.permissions)
			.values({
				id: 'platform:manage',
				name: 'P',
				category: 'platform',
				allowedScopeTypes: ['organization']
			})
			.onConflictDoNothing();
		const platform = await member();
		await assign(platform, await roleWith(['platform:manage']));
		assert.equal(await can(platform, 'platform:manage'), false);
		assert.ok(
			fs
				.readFileSync('src/lib/server/auth/authorization.ts', 'utf8')
				.includes("startsWith('platform:')")
		);
	});

	// =========================================================================
	// Paridad backend ↔ catálogo (guardrail estático + tipado)
	// =========================================================================
	await t.test('paridad: todo permiso literal del backend está en el catálogo', () => {
		const roots = ['src/lib/server', 'src/routes/api'];
		const files = roots.flatMap((root) =>
			fs
				.readdirSync(root, { recursive: true })
				.filter((file) => file.endsWith('.ts'))
				.map((file) => path.join(root, file))
		);
		const found = new Map();
		for (const file of files) {
			if (file.split(path.sep).join('/').endsWith('src/lib/server/auth/permissions.ts')) continue;
			const source = fs.readFileSync(file, 'utf8');
			for (const match of source.matchAll(/'([a-z][a-z_]*:[a-z][a-z_]*)'/g))
				// Node built-in import specifiers ('node:crypto') are not permission literals.
				if (!match[1].startsWith('node:')) found.set(match[1], file);
		}
		assert.ok(found.size >= EXPECTED_IDS.length - 1, 'el escaneo encuentra los permisos usados');
		for (const [id, file] of found)
			assert.ok(PERMISSION_IDS.includes(id), `${id} (${file}) no está en el catálogo`);
		// guardrail principal: el tipo exige ids del catálogo en authorizeAction / authorizeTransaction
		const authSource = fs.readFileSync('src/lib/server/auth/authorization.ts', 'utf8');
		assert.match(authSource, /permissionId: PermissionId;/);
		assert.match(authSource, /permissionId: PermissionId,\n\ttx: AuthTransaction/);
		// /api/teams usa teams:view
		const teams = fs.readFileSync('src/routes/api/teams/+server.ts', 'utf8');
		assert.ok(teams.includes("permissionId: 'teams:view'"));
		assert.ok(!teams.includes("'incidents:assign'"));
	});
});

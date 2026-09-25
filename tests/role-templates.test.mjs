import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { fixture, directory, expectedMigrations } from './helpers/auth-fixture.mjs';
import { applyMigrations } from './helpers/persistence-migrations.mjs';

/** organization_admin permissions as seeded by migration 0012 (5.4Q-C). */
const ADMIN_0012 = [
	'incidents:view_all',
	'incidents:create',
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
].sort();
/** Current organization_admin template: 0012 + roles:view / roles:manage (0013, 5.4R-A). */
const ADMIN = [...ADMIN_0012, 'roles:view', 'roles:manage'].sort();
const TECHNICIAN = [
	'incidents:view_all',
	'incidents:create',
	'incidents:edit',
	'incidents:assign',
	'incidents:add_comment',
	'incidents:view_internal_notes',
	'incidents:add_internal_note',
	'sites:view',
	'categories:view',
	'teams:view'
].sort();

function errorCode(error) {
	return error?.code ?? error?.cause?.code;
}

function journalIndex(tag) {
	const journal = JSON.parse(fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8'));
	return { journal, index: journal.entries.findIndex((e) => e.tag === tag) };
}

/** Applies journal migrations [from, to]; each file's statements run inside one transaction. */
async function applyRange(pg, from, to) {
	const { journal } = journalIndex('0012_role_templates');
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

async function templatePermissions(pg, templateId) {
	return (
		await pg.query(
			`SELECT permission_id FROM role_template_permissions WHERE role_template_id = $1 ORDER BY permission_id`,
			[templateId]
		)
	).rows.map((r) => r.permission_id);
}

async function rolePermissionsOf(pg, roleId) {
	return (
		await pg.query(
			`SELECT permission_id FROM role_permissions WHERE role_id = $1 ORDER BY permission_id`,
			[roleId]
		)
	).rows.map((r) => r.permission_id);
}

test('SoporteFlow — Etapa 5.4Q-C: plantillas de rol canónicas', async (t) => {
	const f = await fixture(t);
	const { pg, server } = f;
	const { ROLE_TEMPLATES } = await server.ssrLoadModule('/src/lib/server/auth/role-templates.ts');
	const { PERMISSION_IDS } = await server.ssrLoadModule('/src/lib/server/auth/permissions.ts');

	await t.test('registry: 2 plantillas, sin Customer, permisos canónicos sin duplicados', () => {
		assert.deepEqual(
			ROLE_TEMPLATES.map((t) => [t.id, t.code]),
			[
				['tpl_organization_admin', 'organization_admin'],
				['tpl_technician', 'technician']
			]
		);
		for (const template of ROLE_TEMPLATES) {
			assert.equal(new Set(template.permissionIds).size, template.permissionIds.length);
			for (const permission of template.permissionIds)
				assert.ok(PERMISSION_IDS.includes(permission), permission);
			assert.ok(!template.permissionIds.includes('incidents:view_own'));
			assert.ok(!template.permissionIds.includes('incidents:view_requested'));
		}
		assert.deepEqual([...ROLE_TEMPLATES[0].permissionIds].sort(), ADMIN);
		assert.deepEqual([...ROLE_TEMPLATES[1].permissionIds].sort(), TECHNICIAN);
	});

	await t.test(
		'1-10. tras migrar: 2 plantillas canónicas exactas, activas, sin Customer',
		async () => {
			const { rows } = await pg.query(
				`SELECT id, code, name, description, active FROM role_templates ORDER BY id`
			);
			assert.deepEqual(
				rows.map((r) => [r.id, r.code, r.name, r.active]),
				[
					['tpl_organization_admin', 'organization_admin', 'Administrador de organización', true],
					['tpl_technician', 'technician', 'Técnico de soporte', true]
				]
			);
			for (const row of rows) assert.ok(row.description.trim().length > 0);
			assert.deepEqual(await templatePermissions(pg, 'tpl_organization_admin'), ADMIN);
			assert.deepEqual(await templatePermissions(pg, 'tpl_technician'), TECHNICIAN);
			const customer = await pg.query(
				`SELECT 1 FROM role_templates WHERE code = 'customer' OR id = 'tpl_customer'`
			);
			assert.equal(customer.rows.length, 0);
			const orphans = await pg.query(
				`SELECT 1 FROM role_template_permissions tp LEFT JOIN permissions p ON p.id = tp.permission_id WHERE p.id IS NULL`
			);
			assert.equal(orphans.rows.length, 0);
			const dups = await pg.query(
				`SELECT role_template_id, permission_id FROM role_template_permissions GROUP BY 1, 2 HAVING count(*) > 1`
			);
			assert.equal(dups.rows.length, 0);
		}
	);

	await t.test('35. la FK impide mapear una plantilla a un permiso inexistente', async () => {
		await assert.rejects(
			pg.query(
				`INSERT INTO role_template_permissions (role_template_id, permission_id) VALUES ('tpl_technician', 'ghost:permission')`
			),
			(e) => errorCode(e) === '23503'
		);
	});

	await t.test(
		'backfill 0012: orgs existentes reciben roles base; custom intactos; sin assignments',
		async () => {
			const up = new PGlite();
			try {
				const { index } = journalIndex('0012_role_templates');
				await applyRange(up, 0, index - 1);
				const orgA = randomUUID();
				const orgB = randomUUID();
				const orgS = randomUUID();
				await up.query(
					`INSERT INTO organizations (id, name, slug, status) VALUES ($1,'A',$4,'active'), ($2,'B',$5,'active'), ($3,'S',$6,'suspended')`,
					[orgA, orgB, orgS, 'a-' + orgA, 'b-' + orgB, 's-' + orgS]
				);
				// rol custom con otro code
				const custom = randomUUID();
				await up.query(
					`INSERT INTO roles (id, organization_id, name, code, is_custom) VALUES ($1, $2, 'Auditor', 'auditor', true)`,
					[custom, orgA]
				);
				await up.query(
					`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, 'sites:view')`,
					[custom]
				);
				// plantilla technician preexistente y rol canónico válido en B con un permiso extra
				await up.query(
					`INSERT INTO role_templates (id, code, name, active) VALUES ('tpl_technician', 'technician', 'Viejo', true)`
				);
				await up.query(
					`INSERT INTO role_template_permissions (role_template_id, permission_id) VALUES ('tpl_technician', 'sites:manage')`
				);
				const existing = randomUUID();
				await up.query(
					`INSERT INTO roles (id, organization_id, name, code, template_id, is_custom) VALUES ($1, $2, 'Técnico B', 'technician', 'tpl_technician', false)`,
					[existing, orgB]
				);
				await up.query(
					`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, 'sites:manage')`,
					[existing]
				);

				await applyRange(up, index, index);
				const snapshot = async () =>
					(
						await up.query(
							`SELECT organization_id, code, id, template_id, is_custom, active, name FROM roles ORDER BY organization_id, code`
						)
					).rows;
				const first = await snapshot();
				for (const org of [orgA, orgB, orgS]) {
					const codes = first
						.filter((r) => r.organization_id === org && !r.is_custom)
						.map((r) => r.code);
					assert.deepEqual(codes, ['organization_admin', 'technician'], org);
				}
				const adminA = first.find(
					(r) => r.organization_id === orgA && r.code === 'organization_admin'
				);
				assert.equal(adminA.template_id, 'tpl_organization_admin');
				assert.equal(adminA.active, true);
				assert.equal(adminA.name, 'Administrador de organización');
				assert.deepEqual(await rolePermissionsOf(up, adminA.id), ADMIN_0012);
				// rol canónico preexistente reutilizado: mismo id, conserva su permiso extra y recibe los que faltan
				const techB = first.find((r) => r.organization_id === orgB && r.code === 'technician');
				assert.equal(techB.id, existing);
				assert.equal(techB.name, 'Técnico B', 'no se renombra');
				assert.deepEqual(
					await rolePermissionsOf(up, existing),
					[...TECHNICIAN, 'sites:manage'].sort()
				);
				// la plantilla sí se sincroniza de forma exacta
				assert.deepEqual(await templatePermissions(up, 'tpl_technician'), TECHNICIAN);
				// custom intacto
				const customRow = first.find((r) => r.id === custom);
				assert.equal(customRow.is_custom, true);
				assert.deepEqual(await rolePermissionsOf(up, custom), ['sites:view']);
				// sin assignments
				assert.equal(
					(await up.query(`SELECT count(*)::int AS n FROM role_assignments`)).rows[0].n,
					0
				);
				// re-aplicar no duplica
				await applyRange(up, index, index);
				assert.deepEqual(await snapshot(), first);
				assert.equal(
					(
						await up.query(
							`SELECT count(*)::int AS n FROM role_permissions GROUP BY role_id, permission_id HAVING count(*) > 1`
						)
					).rows.length,
					0
				);
			} finally {
				await up.close();
			}
		}
	);

	for (const [name, setup, message] of [
		[
			'rol custom con code technician',
			async (up, org) =>
				up.query(
					`INSERT INTO roles (organization_id, name, code, is_custom) VALUES ($1, 'Mi técnico', 'technician', true)`,
					[org]
				),
			/role code collision/
		],
		[
			'rol no custom sin plantilla con code organization_admin',
			async (up, org) =>
				up.query(
					`INSERT INTO roles (organization_id, name, code, is_custom) VALUES ($1, 'Admin', 'organization_admin', false)`,
					[org]
				),
			/role code collision/
		],
		[
			'plantilla ajena con code canónico',
			async (up) =>
				up.query(
					`INSERT INTO role_templates (id, code, name) VALUES ('tpl_other', 'technician', 'Otra')`
				),
			/role template code collision/
		]
	]) {
		await t.test(`conflicto 0012 (${name}): aborta con error claro y no escribe nada`, async () => {
			const up = new PGlite();
			try {
				const { index } = journalIndex('0012_role_templates');
				await applyRange(up, 0, index - 1);
				const org = randomUUID();
				await up.query(
					`INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'C', $2, 'active')`,
					[org, 'c-' + org]
				);
				await setup(up, org);
				const before = {
					templates: (await up.query(`SELECT * FROM role_templates ORDER BY id`)).rows,
					roles: (await up.query(`SELECT * FROM roles ORDER BY id`)).rows,
					perms: (await up.query(`SELECT count(*)::int AS n FROM role_permissions`)).rows[0].n
				};
				await assert.rejects(applyRange(up, index, index), (e) => message.test(String(e.message)));
				assert.deepEqual(
					(await up.query(`SELECT * FROM role_templates ORDER BY id`)).rows,
					before.templates
				);
				assert.deepEqual((await up.query(`SELECT * FROM roles ORDER BY id`)).rows, before.roles);
				assert.equal(
					(await up.query(`SELECT count(*)::int AS n FROM role_permissions`)).rows[0].n,
					before.perms
				);
			} finally {
				await up.close();
			}
		});
	}

	await t.test('migración completa sobre DB vacía: 0012 aplicada y sin roles tenant', async () => {
		const clean = new PGlite();
		try {
			const applied = await applyMigrations(clean, directory);
			assert.deepEqual(applied, expectedMigrations);
			assert.ok(applied.includes('0012_role_templates.sql'));
			assert.equal(
				(await clean.query(`SELECT count(*)::int AS n FROM role_templates`)).rows[0].n,
				2
			);
			assert.equal((await clean.query(`SELECT count(*)::int AS n FROM roles`)).rows[0].n, 0);
		} finally {
			await clean.close();
		}
	});
});

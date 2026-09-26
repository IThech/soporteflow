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
	createSession
} from './helpers/auth-fixture.mjs';
import { applyMigrations } from './helpers/persistence-migrations.mjs';

const CUSTOMER = [
	'incidents:create',
	'incidents:view_requested',
	'incidents:add_comment',
	'sites:view',
	'categories:view'
].sort();
const ADMIN_0015_ADDITIONS = [
	'incidents:view_requested',
	'invitations:create',
	'invitations:revoke',
	'invitations:view'
];

function errorCode(error) {
	return error?.code ?? error?.cause?.code;
}
function journalIndex(tag) {
	const journal = JSON.parse(fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8'));
	return journal.entries.findIndex((e) => e.tag === tag);
}
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
const hash = () => (randomUUID() + randomUUID()).replace(/-/g, '');

test('SoporteFlow — Etapa 5.4S-A: invitations, permisos 5.4S y rol Customer', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, pg, server } = f;
	const { ensureOrganizationRoles, updateCustomRole, createCustomRole, getOrganizationRole } =
		await server.ssrLoadModule('/src/lib/server/services/roles.ts');
	const { assignRoleToMembership } = await server.ssrLoadModule(
		'/src/lib/server/services/memberships.ts'
	);
	const { ROLE_TEMPLATES } = await server.ssrLoadModule('/src/lib/server/auth/role-templates.ts');
	const { PERMISSION_IDS } = await server.ssrLoadModule('/src/lib/server/auth/permissions.ts');
	const { resolveEffectivePermissions } = await server.ssrLoadModule(
		'/src/lib/server/auth/effective-permissions.ts'
	);
	const { resolveIncidentAccess } = await server.ssrLoadModule(
		'/src/lib/server/auth/incident-access.ts'
	);
	const { IncidentServiceError } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);
	const catalogOrder = (ids) => PERMISSION_IDS.filter((id) => ids.includes(id));
	const ADMIN = catalogOrder([...ROLE_TEMPLATES[0].permissionIds]);

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
			.values({ name, slug: 'sa-' + randomUUID(), status: 'active' })
			.returning();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		const byCode = (code) => roles.find((r) => r.code === code);
		return {
			org,
			admin: byCode('organization_admin'),
			tech: byCode('technician'),
			customer: byCode('customer')
		};
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
		return { user, membership, headers: session.headers };
	}
	async function invite(org, role, inviter, values = {}) {
		const [row] = await db
			.insert(s.invitations)
			.values({
				organizationId: org.id,
				email: `p${randomUUID().slice(0, 8)}@example.test`,
				roleId: role.id,
				tokenHash: hash(),
				invitedByUserId: inviter.user.id,
				expiresAt: new Date(Date.now() + 86400000),
				...values
			})
			.returning();
		return row;
	}
	const rawInsert = (org, role, inviter, overrides = {}) => {
		const v = {
			organization_id: org.id,
			email: `r${randomUUID().slice(0, 8)}@example.test`,
			role_id: role.id,
			token_hash: hash(),
			status: 'pending',
			invited_by_user_id: inviter.user.id,
			accepted_at: null,
			...overrides
		};
		return pg.query(
			`INSERT INTO invitations (organization_id, email, role_id, token_hash, status, invited_by_user_id, expires_at, accepted_at)
			 VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 day', $7)`,
			[
				v.organization_id,
				v.email,
				v.role_id,
				v.token_hash,
				v.status,
				v.invited_by_user_id,
				v.accepted_at
			]
		);
	};

	const A = await organization('Alfa');
	const B = await organization('Beta');
	const adminA = await member(A.org, [A.admin]);
	const adminB = await member(B.org, [B.admin]);

	// =========================================================================
	// Schema invitations
	// =========================================================================
	await t.test('schema: columnas, tipos, nulabilidad y defaults', async () => {
		const { rows } = await pg.query(
			`SELECT column_name, data_type, character_maximum_length AS len, is_nullable, column_default
			 FROM information_schema.columns WHERE table_name = 'invitations' ORDER BY ordinal_position`
		);
		const cols = Object.fromEntries(rows.map((r) => [r.column_name, r]));
		assert.deepEqual(
			rows.map((r) => r.column_name),
			[
				'id',
				'organization_id',
				'email',
				'role_id',
				'token_hash',
				'status',
				'invited_by_user_id',
				'expires_at',
				'accepted_at',
				'created_at',
				'updated_at'
			]
		);
		assert.equal(cols.id.data_type, 'uuid');
		assert.match(cols.id.column_default, /gen_random_uuid\(\)/);
		assert.equal(cols.email.len, 255);
		assert.equal(cols.token_hash.len, 64);
		assert.equal(cols.status.len, 20);
		assert.match(cols.status.column_default, /'pending'/);
		for (const c of ['expires_at', 'accepted_at', 'created_at', 'updated_at'])
			assert.equal(cols[c].data_type, 'timestamp with time zone', c);
		for (const c of ['created_at', 'updated_at']) assert.match(cols[c].column_default, /now\(\)/);
		for (const [name, col] of Object.entries(cols))
			assert.equal(col.is_nullable, name === 'accepted_at' ? 'YES' : 'NO', name);

		const row = await invite(A.org, A.customer, adminA);
		assert.equal(row.status, 'pending');
		assert.equal(row.acceptedAt, null);
		assert.ok(row.createdAt instanceof Date && row.updatedAt instanceof Date);
		assert.ok(Math.abs(row.createdAt.getTime() - Date.now()) < 60000);
	});

	await t.test('schema: CHECK de status, email normalizado y accepted_at coherente', async () => {
		await assert.rejects(rawInsert(A.org, A.customer, adminA, { status: 'sent' }), (e) =>
			/invitations_status_check/.test(e.message)
		);
		for (const email of ['Ana@Example.test', ' ana@example.test', 'ana@example.test ', ''])
			await assert.rejects(rawInsert(A.org, A.customer, adminA, { email }), (e) =>
				/invitations_email_normalized_check/.test(e.message)
			);
		await assert.rejects(
			rawInsert(A.org, A.customer, adminA, { status: 'accepted', accepted_at: null }),
			(e) => /invitations_accepted_at_check/.test(e.message)
		);
		await assert.rejects(
			rawInsert(A.org, A.customer, adminA, { status: 'pending', accepted_at: new Date() }),
			(e) => /invitations_accepted_at_check/.test(e.message)
		);
		for (const status of ['pending', 'revoked', 'expired'])
			await rawInsert(A.org, A.customer, adminA, { status });
		await rawInsert(A.org, A.customer, adminA, { status: 'accepted', accepted_at: new Date() });
	});

	await t.test('schema: FKs (org cascade, invitador restrict) y role tenant-safe', async () => {
		const { rows } = await pg.query(
			`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
			 WHERE conrelid = 'invitations'::regclass AND contype = 'f' ORDER BY conname`
		);
		const defs = Object.fromEntries(rows.map((r) => [r.conname, r.def]));
		assert.deepEqual(Object.keys(defs), [
			'invitations_invited_by_user_id_users_id_fk',
			'invitations_organization_id_organizations_id_fk',
			'invitations_role_org_fk'
		]);
		assert.match(defs.invitations_organization_id_organizations_id_fk, /ON DELETE CASCADE/);
		assert.match(defs.invitations_invited_by_user_id_users_id_fk, /ON DELETE RESTRICT/);
		assert.match(
			defs.invitations_role_org_fk,
			/FOREIGN KEY \(role_id, organization_id\) REFERENCES roles\(id, organization_id\)/
		);
		// rol de otro tenant: rechazado por la FK compuesta
		await assert.rejects(rawInsert(A.org, B.customer, adminA), (e) => errorCode(e) === '23503');
		await assert.rejects(
			invite(A.org, { id: randomUUID() }, adminA),
			(e) => errorCode(e) === '23503'
		);
		// invitador inexistente / borrado protegido
		await assert.rejects(
			invite(A.org, A.customer, { user: { id: randomUUID() } }),
			(e) => errorCode(e) === '23503'
		);
		// identidad sin cuenta de auth: sólo la FK de invitations puede impedir el borrado
		const [bare] = await db.insert(s.users).values({ name: 'Invitador' }).returning();
		const pendingByBare = await invite(A.org, A.customer, { user: bare });
		await assert.rejects(db.delete(s.users).where(eq(s.users.id, bare.id)), (e) =>
			/invitations_invited_by_user_id_users_id_fk/.test(e.cause?.message ?? e.message)
		);
		await db.delete(s.invitations).where(eq(s.invitations.id, pendingByBare.id));
		await db.delete(s.users).where(eq(s.users.id, bare.id));
		// borrar la organización borra sus invitaciones
		const C = await organization('Cascada');
		const adminC = await member(C.org, [C.admin]);
		const row = await invite(C.org, C.customer, adminC);
		await db.delete(s.organizations).where(eq(s.organizations.id, C.org.id));
		assert.equal(
			(await db.select().from(s.invitations).where(eq(s.invitations.id, row.id))).length,
			0
		);
	});

	await t.test('schema: token_hash único y una sola pending por (org, email)', async () => {
		const first = await invite(A.org, A.customer, adminA);
		await assert.rejects(
			invite(A.org, A.customer, adminA, { tokenHash: first.tokenHash }),
			(e) => errorCode(e) === '23505'
		);
		await assert.rejects(
			invite(B.org, B.customer, adminB, { tokenHash: first.tokenHash }),
			(e) => errorCode(e) === '23505',
			'token_hash es único globalmente'
		);
		const email = `dup-${randomUUID().slice(0, 8)}@example.test`;
		const pending = await invite(A.org, A.customer, adminA, { email });
		await assert.rejects(invite(A.org, A.tech, adminA, { email }), (e) => errorCode(e) === '23505');
		// otra org, o tras revocar la anterior: permitido
		await invite(B.org, B.customer, adminB, { email });
		await db
			.update(s.invitations)
			.set({ status: 'revoked' })
			.where(eq(s.invitations.id, pending.id));
		await invite(A.org, A.customer, adminA, { email });
		await invite(A.org, A.customer, adminA, { email, status: 'expired' });
	});

	await t.test('schema: índices esperados y sin redundancia', async () => {
		const { rows } = await pg.query(
			`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'invitations' ORDER BY indexname`
		);
		const idx = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
		assert.deepEqual(Object.keys(idx), [
			'invitations_org_email_pending_unique_idx',
			'invitations_org_status_idx',
			'invitations_pkey',
			'invitations_token_hash_unique'
		]);
		assert.match(
			idx.invitations_org_email_pending_unique_idx,
			/UNIQUE INDEX .* \(organization_id, email\) WHERE \(\(status\)::text = 'pending'::text\)/
		);
		assert.match(idx.invitations_org_status_idx, /\(organization_id, status\)/);
		assert.match(idx.invitations_token_hash_unique, /UNIQUE INDEX .* \(token_hash\)/);
	});

	// =========================================================================
	// Customer role y permisos
	// =========================================================================
	await t.test('Customer: rol de sistema en org nueva con permisos exactos', async () => {
		const role = await getOrganizationRole(db, A.org.id, A.customer.id);
		assert.equal(role.code, 'customer');
		assert.equal(role.name, 'Cliente');
		assert.equal(role.templateId, 'tpl_customer');
		assert.equal(role.isCustom, false);
		assert.equal(role.active, true);
		assert.deepEqual([...role.permissions].sort(), CUSTOMER);
		assert.deepEqual(
			(await getOrganizationRole(db, A.org.id, A.admin.id)).permissions,
			ADMIN,
			'Admin incluye invitations:* y view_requested'
		);
		for (const p of ADMIN_0015_ADDITIONS) assert.ok(ADMIN.includes(p), p);
		const tech = await getOrganizationRole(db, A.org.id, A.tech.id);
		assert.ok(
			!tech.permissions.some(
				(p) => p.startsWith('invitations:') || p === 'incidents:view_requested'
			)
		);
		const again = await ensureOrganizationRoles(db, A.org.id);
		assert.deepEqual(
			again.roles.map((r) => r.code),
			['customer', 'organization_admin', 'technician']
		);
		const all = await db.select().from(s.roles).where(eq(s.roles.organizationId, A.org.id));
		assert.equal(all.filter((r) => r.code === 'customer').length, 1);
	});

	await t.test('Customer: inmutable como rol de sistema y code reservado', async () => {
		for (const change of [
			{ name: 'Otro' },
			{ active: false },
			{ permissions: [] },
			{ description: 'x' }
		])
			await rejectsWith(
				updateCustomRole(db, A.org.id, A.customer.id, ADMIN, change),
				'SYSTEM_ROLE_IMMUTABLE'
			);
		await rejectsWith(
			createCustomRole(db, A.org.id, ADMIN, {
				name: 'Cliente 2',
				code: 'customer',
				permissions: []
			}),
			'ROLE_CODE_CONFLICT'
		);
		assert.deepEqual(
			[...(await getOrganizationRole(db, A.org.id, A.customer.id)).permissions].sort(),
			CUSTOMER
		);
	});

	await t.test('Customer: sin auto-asignación; Admin puede delegarlo (monotonía)', async () => {
		const { rows } = await pg.query(
			`SELECT count(*)::int AS n FROM role_assignments WHERE role_id = $1`,
			[A.customer.id]
		);
		assert.equal(rows[0].n, 0);
		const target = await member(A.org);
		const result = await assignRoleToMembership(
			db,
			A.org.id,
			target.membership.id,
			A.customer.id,
			await resolveEffectivePermissions(adminA.headers, A.org.id)
		);
		assert.equal(result.created, true);
		// un técnico no puede delegarlo: no tiene view_requested
		const techPermissions = await resolveEffectivePermissions(
			(await member(A.org, [A.tech])).headers,
			A.org.id
		);
		await rejectsWith(
			assignRoleToMembership(db, A.org.id, (await member(A.org)).membership.id, A.customer.id, [
				...techPermissions,
				'roles:assign'
			]),
			'PERMISSION_NOT_DELEGABLE'
		);
	});

	await t.test('Customer: acceso de solicitante (5.4S-B); Admin view_all domina', async () => {
		const customer = await member(A.org, [A.customer]);
		const effective = await resolveEffectivePermissions(customer.headers, A.org.id);
		assert.deepEqual([...effective].sort(), CUSTOMER);
		assert.deepEqual(await resolveIncidentAccess(customer.headers, A.org.id, customer.user.id), {
			clientUserId: customer.user.id
		});
		assert.deepEqual(await resolveIncidentAccess(adminA.headers, A.org.id, adminA.user.id), {
			viewAll: true
		});
	});

	await t.test('Better Auth sigue cerrado: disableSignUp true, sin flujos nuevos', () => {
		const source = fs.readFileSync('src/lib/server/auth/instance.ts', 'utf8');
		assert.match(source, /emailAndPassword: \{ enabled: true, disableSignUp: true \}/);
		for (const flow of ['sendResetPassword', 'sendVerificationEmail', 'emailVerification'])
			assert.ok(!source.includes(flow), flow);
		// 5.4S-C añade la administración de invitaciones; la aceptación pública es 5.4S-D
		for (const route of ['verify', 'accept'])
			assert.ok(!fs.existsSync(`src/routes/api/invitations/${route}`), route);
	});

	// =========================================================================
	// Migración 0015
	// =========================================================================
	await t.test(
		'DB vacía -> latest: 0015 aplicada, tabla creada, sin roles ni invitaciones',
		async () => {
			const clean = new PGlite();
			try {
				assert.deepEqual(await applyMigrations(clean, directory), expectedMigrations);
				const { rows } = await clean.query(
					`SELECT (SELECT count(*) FROM invitations)::int AS inv, (SELECT count(*) FROM roles)::int AS roles,
				        (SELECT count(*) FROM role_templates WHERE id = 'tpl_customer')::int AS tpl`
				);
				assert.deepEqual(rows[0], { inv: 0, roles: 0, tpl: 1 });
			} finally {
				await clean.close();
			}
		}
	);

	await t.test(
		'upgrade 0014 -> 0015: backfill Customer, Admin +4, Technician intacto, sin assignments; idempotente',
		async () => {
			const up = new PGlite();
			try {
				const index = journalIndex('0015_invitations_customer');
				assert.ok(index > 0);
				await applyRange(up, 0, index - 1);
				const orgA = randomUUID();
				const orgB = randomUUID();
				const orgS = randomUUID();
				await up.query(
					`INSERT INTO organizations (id, name, slug, status) VALUES ($1,'A',$4,'active'), ($2,'B',$5,'active'), ($3,'S',$6,'suspended')`,
					[orgA, orgB, orgS, 'a-' + orgA, 'b-' + orgB, 's-' + orgS]
				);
				const roleIds = {};
				for (const org of [orgA, orgB]) {
					for (const [code, tpl] of [
						['organization_admin', 'tpl_organization_admin'],
						['technician', 'tpl_technician']
					]) {
						const {
							rows: [r]
						} = await up.query(
							`INSERT INTO roles (organization_id, name, code, template_id, is_custom) VALUES ($1, $2, $2, $3, false) RETURNING id`,
							[org, code, tpl]
						);
						roleIds[`${org}:${code}`] = r.id;
						await up.query(
							`INSERT INTO role_permissions (role_id, permission_id)
							 SELECT $1, permission_id FROM role_template_permissions WHERE role_template_id = $2`,
							[r.id, tpl]
						);
					}
				}
				const {
					rows: [custom]
				} = await up.query(
					`INSERT INTO roles (organization_id, name, code, is_custom) VALUES ($1, 'Auditor', 'auditor', true) RETURNING id`,
					[orgA]
				);
				await up.query(
					`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, 'sites:view')`,
					[custom.id]
				);
				const {
					rows: [user]
				} = await up.query(`INSERT INTO users (name) VALUES ('U') RETURNING id`);
				const {
					rows: [m]
				} = await up.query(
					`INSERT INTO memberships (organization_id, user_id) VALUES ($1, $2) RETURNING id`,
					[orgA, user.id]
				);
				await up.query(
					`INSERT INTO role_assignments (organization_id, membership_id, role_id, scope_type) VALUES ($1, $2, $3, 'organization')`,
					[orgA, m.id, roleIds[`${orgA}:technician`]]
				);
				const perms = async (roleId) =>
					(
						await up.query(
							`SELECT permission_id FROM role_permissions WHERE role_id = $1 ORDER BY permission_id`,
							[roleId]
						)
					).rows.map((r) => r.permission_id);
				const techBefore = await perms(roleIds[`${orgA}:technician`]);
				const adminBefore = await perms(roleIds[`${orgA}:organization_admin`]);
				const assignmentsBefore = (await up.query(`SELECT * FROM role_assignments ORDER BY id`))
					.rows;

				await applyRange(up, index, index);
				const snapshot = async () => ({
					roles: (
						await up.query(
							`SELECT id, organization_id, code, name, template_id, is_custom, active FROM roles ORDER BY organization_id, code`
						)
					).rows,
					rp: (
						await up.query(
							`SELECT role_id, permission_id FROM role_permissions ORDER BY role_id, permission_id`
						)
					).rows,
					tpl: (
						await up.query(
							`SELECT role_template_id, permission_id FROM role_template_permissions ORDER BY 1, 2`
						)
					).rows,
					perms: (
						await up.query(
							`SELECT id, name, category, allowed_scope_types FROM permissions ORDER BY id`
						)
					).rows,
					ra: (await up.query(`SELECT * FROM role_assignments ORDER BY id`)).rows
				});
				const first = await snapshot();

				for (const org of [orgA, orgB, orgS]) {
					const customers = first.roles.filter(
						(r) => r.organization_id === org && r.code === 'customer'
					);
					assert.equal(
						customers.length,
						1,
						'cada org existente recibe customer (también suspendida)'
					);
					const [c] = customers;
					assert.equal(c.template_id, 'tpl_customer');
					assert.equal(c.is_custom, false);
					assert.equal(c.active, true);
					assert.equal(c.name, 'Cliente');
					assert.deepEqual(await perms(c.id), CUSTOMER);
				}
				assert.deepEqual(
					await perms(roleIds[`${orgA}:organization_admin`]),
					[...adminBefore, ...ADMIN_0015_ADDITIONS].sort()
				);
				assert.deepEqual(await perms(roleIds[`${orgA}:technician`]), techBefore);
				assert.deepEqual(await perms(custom.id), ['sites:view']);
				assert.deepEqual(first.ra, assignmentsBefore, 'ninguna role_assignment nueva');
				assert.equal((await up.query(`SELECT count(*)::int AS n FROM invitations`)).rows[0].n, 0);

				// segunda ejecución: sin cambios
				await applyRange(up, index, index);
				assert.deepEqual(await snapshot(), first);
			} finally {
				await up.close();
			}
		}
	);

	await t.test(
		'colisiones: customer custom o de otra plantilla -> la migración falla sin escribir nada',
		async () => {
			const cases = [
				[
					`INSERT INTO roles (organization_id, name, code, is_custom) VALUES ($1, 'Mi cliente', 'customer', true)`
				],
				[
					`INSERT INTO roles (organization_id, name, code, is_custom) VALUES ($1, 'Mi cliente', 'customer', false)`
				],
				[
					`INSERT INTO roles (organization_id, name, code, template_id, is_custom) VALUES ($1, 'Mi cliente', 'customer', 'tpl_technician', false)`
				],
				[
					`INSERT INTO role_templates (id, code, name, active) VALUES ('tpl_cliente_legacy', 'customer', 'Legacy', true)`,
					true
				]
			];
			for (const [sql, templateOnly] of cases) {
				const up = new PGlite();
				try {
					const index = journalIndex('0015_invitations_customer');
					await applyRange(up, 0, index - 1);
					const org = randomUUID();
					await up.query(
						`INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'C', $2, 'active')`,
						[org, 'c-' + org]
					);
					await up.query(sql, templateOnly ? [] : [org]);
					const before = (await up.query(`SELECT * FROM roles ORDER BY id`)).rows;
					await assert.rejects(applyRange(up, index, index), /collision/);
					assert.deepEqual((await up.query(`SELECT * FROM roles ORDER BY id`)).rows, before);
					assert.equal(
						(await up.query(`SELECT to_regclass('invitations') AS t`)).rows[0].t,
						null,
						'rollback completo: la tabla no se crea'
					);
					assert.equal(
						(
							await up.query(
								`SELECT count(*)::int AS n FROM permissions WHERE id LIKE 'invitations:%'`
							)
						).rows[0].n,
						0
					);
				} finally {
					await up.close();
				}
			}
		}
	);
});

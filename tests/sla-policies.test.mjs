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
const errorCode = (e) => e?.code ?? e?.cause?.code;

test('SoporteFlow — Etapa 5.4T-A: políticas SLA (configuración)', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server, pg } = f;
	const { ensureOrganizationRoles, getOrganizationRole } = await server.ssrLoadModule(
		'/src/lib/server/services/roles.ts'
	);
	const service = await server.ssrLoadModule('/src/lib/server/services/sla-policies.ts');
	const { createSlaPolicy, updateSlaPolicy, listSlaPolicies } = service;
	const { IncidentServiceError } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);
	const listRoute = await server.ssrLoadModule('/src/routes/api/sla-policies/+server.ts');
	const itemRoute = await server.ssrLoadModule('/src/routes/api/sla-policies/[id]/+server.ts');

	const DTO_KEYS = [
		'active',
		'code',
		'createdAt',
		'description',
		'firstResponseMinutes',
		'id',
		'isDefault',
		'name',
		'resolutionMinutes',
		'updatedAt'
	];
	let seq = 0;
	const code = () => `sla_${++seq}`;
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
			.values({ name, slug: 'ta-' + randomUUID(), status: 'active' })
			.returning();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		const byCode = (c) => roles.find((r) => r.code === c);
		return {
			org,
			admin: byCode('organization_admin'),
			tech: byCode('technician'),
			customer: byCode('customer')
		};
	}
	async function member(org, roles = []) {
		const user = await createCredentialUser(f, { email: `ta-${randomUUID()}@example.test` });
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
		return { user, cookie: session.cookieHeader };
	}
	async function call(
		handler,
		{ method = 'GET', path: p, who, query = '', params = {}, body, rawBody }
	) {
		const url = new URL(`http://localhost${p}?${query}`);
		const headers = new Headers();
		if (who) headers.set('cookie', who.cookie);
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
	const list = (who, org, query = '') =>
		call(listRoute.GET, {
			path: '/api/sla-policies',
			who,
			query: `organizationId=${org.id}${query}`
		});
	const create = (who, org, body, query = '') =>
		call(listRoute.POST, {
			method: 'POST',
			path: '/api/sla-policies',
			who,
			query: `organizationId=${org.id}${query}`,
			body
		});
	const detail = (who, org, id, query = '') =>
		call(itemRoute.GET, {
			path: `/api/sla-policies/${id}`,
			who,
			query: `organizationId=${org.id}${query}`,
			params: { id }
		});
	const patch = (who, org, id, body) =>
		call(itemRoute.PATCH, {
			method: 'PATCH',
			path: `/api/sla-policies/${id}`,
			who,
			query: `organizationId=${org.id}`,
			params: { id },
			body
		});
	const policy = (extra = {}) => ({
		code: code(),
		name: 'Estándar',
		firstResponseMinutes: 60,
		resolutionMinutes: 480,
		...extra
	});
	async function defaults(org) {
		return (await db.select().from(s.slaPolicies).where(eq(s.slaPolicies.organizationId, org.id)))
			.filter((p) => p.isDefault)
			.map((p) => p.id);
	}

	const A = await organization('Alfa');
	const B = await organization('Beta');
	const admin = await member(A.org, [A.admin]);
	const tech = await member(A.org, [A.tech]);
	const customer = await member(A.org, [A.customer]);
	const adminB = await member(B.org, [B.admin]);

	// =========================================================================
	// Schema (38)
	// =========================================================================
	await t.test(
		'38. schema: columnas, defaults, FK org cascade, unicidades e índice parcial',
		async () => {
			const { rows } = await pg.query(
				`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
			 WHERE table_name = 'sla_policies' ORDER BY ordinal_position`
			);
			assert.deepEqual(
				rows.map((r) => r.column_name),
				[
					'id',
					'organization_id',
					'code',
					'name',
					'description',
					'active',
					'is_default',
					'first_response_minutes',
					'resolution_minutes',
					'created_at',
					'updated_at'
				]
			);
			const cols = Object.fromEntries(rows.map((r) => [r.column_name, r]));
			assert.equal(cols.first_response_minutes.data_type, 'integer');
			assert.match(cols.active.column_default, /true/);
			assert.match(cols.is_default.column_default, /false/);
			for (const c of ['created_at', 'updated_at']) {
				assert.equal(cols[c].data_type, 'timestamp with time zone');
				assert.match(cols[c].column_default, /now\(\)/);
			}
			for (const [name, col] of Object.entries(cols))
				assert.equal(col.is_nullable, name === 'description' ? 'YES' : 'NO', name);
			const fks = (
				await pg.query(
					`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'sla_policies'::regclass AND contype = 'f'`
				)
			).rows.map((r) => r.def);
			assert.equal(fks.length, 1);
			assert.match(fks[0], /REFERENCES organizations\(id\) ON DELETE CASCADE/);
			const idx = (
				await pg.query(
					`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'sla_policies' ORDER BY 1`
				)
			).rows;
			assert.deepEqual(
				idx.map((r) => r.indexname),
				[
					'sla_policies_id_org_unique',
					'sla_policies_org_code_unique',
					'sla_policies_org_default_unique_idx',
					'sla_policies_pkey'
				]
			);
			assert.match(
				idx[2].indexdef,
				/UNIQUE INDEX .* \(organization_id\) WHERE \(is_default = true\)/
			);
		}
	);

	await t.test(
		'38. schema: CHECK de targets, code, nombre, default activo; unicidad por tenant',
		async () => {
			const insert = (values) =>
				pg.query(
					`INSERT INTO sla_policies (organization_id, code, name, first_response_minutes, resolution_minutes, active, is_default)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
					[
						values.org ?? A.org.id,
						values.code ?? code(),
						values.name ?? 'N',
						values.first ?? 10,
						values.resolution ?? 20,
						values.active ?? true,
						values.isDefault ?? false
					]
				);
			for (const [values, constraint] of [
				[{ first: 0 }, 'targets'],
				[{ first: -5 }, 'targets'],
				[{ resolution: 5256001 }, 'targets'],
				[{ first: 30, resolution: 20 }, 'targets'],
				[{ code: 'Bad Code' }, 'code'],
				[{ code: 'ab' }, 'code'],
				[{ name: '   ' }, 'name'],
				[{ active: false, isDefault: true }, 'default_active']
			])
				await assert.rejects(insert(values), (e) =>
					new RegExp(`sla_policies_${constraint}_check`).test(e.message)
				);
			const dup = code();
			await insert({ code: dup });
			await assert.rejects(insert({ code: dup }), (e) => errorCode(e) === '23505');
			await insert({ code: dup, org: B.org.id });
			const T = await organization('Defaults');
			await insert({ org: T.org.id, isDefault: true });
			await assert.rejects(
				insert({ org: T.org.id, isDefault: true }),
				(e) => errorCode(e) === '23505'
			);
			await insert({ org: T.org.id, first: 5256000, resolution: 5256000 });
			await db.delete(s.organizations).where(eq(s.organizations.id, T.org.id));
			assert.equal(
				(await db.select().from(s.slaPolicies).where(eq(s.slaPolicies.organizationId, T.org.id)))
					.length,
				0,
				'cascade al borrar la organización'
			);
		}
	);

	// =========================================================================
	// Permisos y plantillas (39)
	// =========================================================================
	await t.test(
		'39. permisos: Admin view+manage, Technician solo view, Customer ninguno',
		async () => {
			const perms = async (role) => (await getOrganizationRole(db, A.org.id, role.id)).permissions;
			assert.ok((await perms(A.admin)).includes('sla:view'));
			assert.ok((await perms(A.admin)).includes('sla:manage'));
			assert.ok((await perms(A.tech)).includes('sla:view'));
			assert.ok(!(await perms(A.tech)).includes('sla:manage'));
			assert.ok(!(await perms(A.customer)).some((p) => p.startsWith('sla:')));
			const rows = await db.select().from(s.permissions);
			for (const id of ['sla:view', 'sla:manage']) {
				const row = rows.find((r) => r.id === id);
				assert.deepEqual(row.allowedScopeTypes, ['organization']);
				assert.equal(row.category, 'sla');
			}
		}
	);

	await t.test(
		'46. upgrade 0016 -> 0017: backfill solo de roles de sistema; sin políticas; idempotente',
		async () => {
			const up = new PGlite();
			try {
				const journal = JSON.parse(
					fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')
				);
				const index = journal.entries.findIndex((e) => e.tag === '0017_sla_policies');
				assert.ok(index > 0);
				await applyRange(up, 0, index - 1);
				const org = randomUUID();
				await up.query(
					`INSERT INTO organizations (id, name, slug, status) VALUES ($1,'U',$2,'active')`,
					[org, 'u-' + org]
				);
				const ids = {};
				for (const [c, tpl, custom] of [
					['organization_admin', 'tpl_organization_admin', false],
					['technician', 'tpl_technician', false],
					['customer', 'tpl_customer', false],
					['auditor', null, true]
				]) {
					const {
						rows: [r]
					} = await up.query(
						`INSERT INTO roles (organization_id, name, code, template_id, is_custom) VALUES ($1,$2,$2,$3,$4) RETURNING id`,
						[org, c, tpl, custom]
					);
					ids[c] = r.id;
				}
				await applyRange(up, index, index);
				await applyRange(up, index, index);
				const perms = async (id) =>
					(
						await up.query(
							`SELECT permission_id FROM role_permissions WHERE role_id = $1 ORDER BY 1`,
							[id]
						)
					).rows.map((r) => r.permission_id);
				assert.deepEqual(await perms(ids.organization_admin), ['sla:manage', 'sla:view']);
				assert.deepEqual(await perms(ids.technician), ['sla:view']);
				assert.deepEqual(await perms(ids.customer), []);
				assert.deepEqual(await perms(ids.auditor), [], 'roles custom intactos');
				assert.equal((await up.query(`SELECT count(*)::int AS n FROM sla_policies`)).rows[0].n, 0);
				assert.equal(
					(await up.query(`SELECT count(*)::int AS n FROM role_assignments`)).rows[0].n,
					0
				);
				const tpl = (
					await up.query(
						`SELECT role_template_id, permission_id FROM role_template_permissions WHERE permission_id LIKE 'sla:%' ORDER BY 1, 2`
					)
				).rows.map((r) => `${r.role_template_id}:${r.permission_id}`);
				assert.deepEqual(tpl, [
					'tpl_organization_admin:sla:manage',
					'tpl_organization_admin:sla:view',
					'tpl_technician:sla:view'
				]);
			} finally {
				await up.close();
			}
		}
	);

	// =========================================================================
	// Create (40)
	// =========================================================================
	await t.test(
		'40. Admin crea: 201, DTO seguro, activa, code inmutable; Technician/Customer 403',
		async () => {
			const body = policy({ description: '  Horario 24x7  ' });
			const res = await create(admin, A.org, body);
			assert.equal(res.status, 201, res.text);
			assert.equal(res.headers.get('cache-control'), 'private, no-store');
			const dto = res.json.slaPolicy;
			assert.deepEqual(Object.keys(dto).sort(), DTO_KEYS);
			assert.equal(dto.code, body.code);
			assert.equal(dto.description, 'Horario 24x7');
			assert.equal(dto.active, true);
			assert.equal(dto.isDefault, false);
			assert.equal(dto.firstResponseMinutes, 60);
			assert.ok(!res.text.includes(A.org.id));
			assert.equal((await create(tech, A.org, policy())).status, 403);
			assert.equal((await create(customer, A.org, policy())).status, 403);
			assert.equal((await create(null, A.org, policy())).status, 401);
			assert.equal((await create(admin, B.org, policy())).status, 403, 'org ajena');
		}
	);

	await t.test(
		'40. validación: targets inválidos 400 SLA_POLICY_INVALID_TARGET; entrada 400',
		async () => {
			for (const targets of [
				{ firstResponseMinutes: 0 },
				{ firstResponseMinutes: -1 },
				{ firstResponseMinutes: 1.5 },
				{ firstResponseMinutes: '60' },
				{ resolutionMinutes: 5256001 },
				{ firstResponseMinutes: 500, resolutionMinutes: 400 },
				{ resolutionMinutes: null }
			]) {
				const res = await create(admin, A.org, policy(targets));
				assert.equal(res.status, 400, JSON.stringify(targets));
				assert.equal(res.json.error.code, 'SLA_POLICY_INVALID_TARGET');
			}
			for (const bad of [
				policy({ code: 'Mayúsculas' }),
				policy({ code: 'ab' }),
				policy({ name: '   ' }),
				policy({ description: 'x'.repeat(1001) }),
				policy({ isDefault: 'true' }),
				policy({ active: false }),
				policy({ organizationId: B.org.id }),
				policy({ id: randomUUID() }),
				policy({ createdAt: new Date().toISOString() })
			]) {
				const res = await create(admin, A.org, bad);
				assert.equal(res.status, 400);
				assert.equal(res.json.error.code, 'INVALID_INPUT');
			}
			assert.equal((await create(admin, A.org, policy(), '&x=1')).status, 400);
			assert.equal(
				(
					await call(listRoute.POST, {
						method: 'POST',
						path: '/api/sla-policies',
						who: admin,
						query: `organizationId=${A.org.id}`,
						rawBody: '{bad'
					})
				).status,
				400
			);
			// JSON no admite Infinity/NaN: llegan como null y se rechazan
			assert.equal(
				(await create(admin, A.org, { ...policy(), firstResponseMinutes: Infinity })).json.error
					.code,
				'SLA_POLICY_INVALID_TARGET'
			);
		}
	);

	await t.test(
		'40. code duplicado en el tenant 409; mismo code en otra org permitido',
		async () => {
			const body = policy();
			assert.equal((await create(admin, A.org, body)).status, 201);
			const dup = await create(admin, A.org, { ...body, name: 'Otro' });
			assert.equal(dup.status, 409);
			assert.equal(dup.json.error.code, 'SLA_POLICY_CODE_CONFLICT');
			assert.ok(!/constraint|sla_policies_/i.test(dup.text));
			assert.equal((await create(adminB, B.org, body)).status, 201);
		}
	);

	await t.test(
		'20. default: crear un segundo default retira el anterior de forma atómica',
		async () => {
			const C = await organization('Default');
			const adminC = await member(C.org, [C.admin]);
			const first = (await create(adminC, C.org, policy({ isDefault: true }))).json.slaPolicy;
			assert.equal(first.isDefault, true);
			const second = (await create(adminC, C.org, policy({ isDefault: true }))).json.slaPolicy;
			assert.deepEqual(await defaults(C.org), [second.id]);
			assert.equal((await detail(adminC, C.org, first.id)).json.slaPolicy.isDefault, false);
			// un default en otra org no se ve afectado
			const other = (await create(adminB, B.org, policy({ isDefault: true }))).json.slaPolicy;
			await create(adminC, C.org, policy({ isDefault: true }));
			assert.deepEqual(await defaults(B.org), [other.id]);
		}
	);

	// =========================================================================
	// List / detail (41, 42)
	// =========================================================================
	await t.test(
		'41. listado: Admin y Technician; Customer 403; tenant; filtros; orden por code',
		async () => {
			const L = await organization('Listado');
			const adminL = await member(L.org, [L.admin]);
			const techL = await member(L.org, [L.tech]);
			const zeta = (await create(adminL, L.org, policy({ code: 'zeta_policy' }))).json.slaPolicy;
			const alpha = (await create(adminL, L.org, policy({ code: 'alpha_policy', isDefault: true })))
				.json.slaPolicy;
			const mid = (await create(adminL, L.org, policy({ code: 'mid_policy' }))).json.slaPolicy;
			await patch(adminL, L.org, mid.id, { active: false });
			const res = await list(techL, L.org);
			assert.equal(res.status, 200);
			assert.deepEqual(
				res.json.slaPolicies.map((p) => p.code),
				['alpha_policy', 'mid_policy', 'zeta_policy']
			);
			assert.deepEqual(
				(await list(adminL, L.org, '&active=true')).json.slaPolicies.map((p) => p.id),
				[alpha.id, zeta.id]
			);
			assert.deepEqual(
				(await list(adminL, L.org, '&active=false')).json.slaPolicies.map((p) => p.id),
				[mid.id]
			);
			assert.deepEqual(
				(await list(adminL, L.org, '&isDefault=true')).json.slaPolicies.map((p) => p.id),
				[alpha.id]
			);
			for (const q of ['&active=yes', '&sort=name', '&active=true&active=false', '&isDefault=1'])
				assert.equal((await list(adminL, L.org, q)).status, 400, q);
			const customerL = await member(L.org, [L.customer]);
			assert.equal((await list(customerL, L.org)).status, 403);
			assert.equal((await list(adminL, A.org)).status, 403, 'org ajena');
			assert.ok(!(await list(admin, A.org)).json.slaPolicies.some((p) => p.id === alpha.id));
		}
	);

	await t.test(
		'42. detalle: 200; otro tenant 404 idéntico a inexistente; inactiva legible',
		async () => {
			const p = (await create(admin, A.org, policy())).json.slaPolicy;
			await patch(admin, A.org, p.id, { active: false });
			const ok = await detail(tech, A.org, p.id);
			assert.equal(ok.status, 200);
			assert.equal(ok.json.slaPolicy.active, false);
			const foreign = (await create(adminB, B.org, policy())).json.slaPolicy;
			const cross = await detail(admin, A.org, foreign.id);
			const missing = await detail(admin, A.org, randomUUID());
			assert.equal(cross.status, 404);
			assert.deepEqual(cross.json, missing.json);
			assert.equal(cross.json.error.code, 'SLA_POLICY_NOT_FOUND');
			assert.equal((await detail(admin, A.org, 'x')).status, 400);
			assert.equal((await detail(admin, A.org, p.id, '&x=1')).status, 400);
			assert.equal((await detail(customer, A.org, p.id)).status, 403);
		}
	);

	// =========================================================================
	// Update (43)
	// =========================================================================
	await t.test(
		'43. PATCH: Admin actualiza campos y targets; Technician 403; code inmutable',
		async () => {
			const p = (await create(admin, A.org, policy())).json.slaPolicy;
			const res = await patch(admin, A.org, p.id, {
				name: ' Premium ',
				description: null,
				firstResponseMinutes: 30,
				resolutionMinutes: 240
			});
			assert.equal(res.status, 200, res.text);
			assert.equal(res.json.slaPolicy.name, 'Premium');
			assert.equal(res.json.slaPolicy.firstResponseMinutes, 30);
			assert.equal(res.json.slaPolicy.code, p.code);
			assert.ok(res.json.slaPolicy.updatedAt >= p.updatedAt);
			// parcial: resolución menor que la primera respuesta actual -> 400
			const bad = await patch(admin, A.org, p.id, { resolutionMinutes: 10 });
			assert.equal(bad.status, 400);
			assert.equal(bad.json.error.code, 'SLA_POLICY_INVALID_TARGET');
			assert.equal((await patch(tech, A.org, p.id, { name: 'X' })).status, 403);
			assert.equal((await patch(customer, A.org, p.id, { name: 'X' })).status, 403);
			for (const body of [
				{},
				{ code: 'nuevo_code' },
				{ organizationId: B.org.id },
				{ x: 1 },
				{ active: 'no' }
			])
				assert.equal((await patch(admin, A.org, p.id, body)).status, 400, JSON.stringify(body));
			const foreign = (await create(adminB, B.org, policy())).json.slaPolicy;
			assert.equal((await patch(admin, A.org, foreign.id, { name: 'X' })).status, 404);
			assert.equal((await detail(adminB, B.org, foreign.id)).json.slaPolicy.name, 'Estándar');
		}
	);

	await t.test(
		'22/43. default por PATCH; desactivar el default lo retira; inactiva no puede ser default',
		async () => {
			const D = await organization('Defaults 2');
			const adminD = await member(D.org, [D.admin]);
			const a = (await create(adminD, D.org, policy({ isDefault: true }))).json.slaPolicy;
			const b = (await create(adminD, D.org, policy())).json.slaPolicy;
			assert.equal(
				(await patch(adminD, D.org, b.id, { isDefault: true })).json.slaPolicy.isDefault,
				true
			);
			assert.deepEqual(await defaults(D.org), [b.id]);
			const off = await patch(adminD, D.org, b.id, { active: false });
			assert.equal(off.json.slaPolicy.active, false);
			assert.equal(off.json.slaPolicy.isDefault, false, 'desactivar retira el default');
			assert.deepEqual(await defaults(D.org), []);
			const invalid = await patch(adminD, D.org, b.id, { isDefault: true });
			assert.equal(invalid.status, 409);
			assert.equal(invalid.json.error.code, 'SLA_POLICY_INVALID_DEFAULT');
			const both = await patch(adminD, D.org, a.id, { isDefault: true, active: false });
			assert.equal(both.json.error.code, 'SLA_POLICY_INVALID_DEFAULT');
			const reactivate = await patch(adminD, D.org, b.id, { active: true, isDefault: true });
			assert.equal(reactivate.status, 200);
			assert.deepEqual(await defaults(D.org), [b.id]);
			assert.equal(
				(await patch(adminD, D.org, b.id, { isDefault: false })).json.slaPolicy.isDefault,
				false
			);
			assert.deepEqual(await defaults(D.org), []);
		}
	);

	// =========================================================================
	// Concurrencia (44), servicio y límites de T-A
	// =========================================================================
	await t.test(
		'44. dos cambios de default "simultáneos" (PGlite, serializados): un único default',
		async () => {
			const E = await organization('Carrera');
			const p1 = await createSlaPolicy(db, E.org.id, policy());
			const p2 = await createSlaPolicy(db, E.org.id, policy());
			const p3 = await createSlaPolicy(db, E.org.id, policy());
			await Promise.all([
				updateSlaPolicy(db, E.org.id, p1.id, { isDefault: true }),
				updateSlaPolicy(db, E.org.id, p2.id, { isDefault: true }),
				createSlaPolicy(db, E.org.id, policy({ isDefault: true })),
				updateSlaPolicy(db, E.org.id, p3.id, { isDefault: true })
			]);
			assert.equal((await defaults(E.org)).length, 1);
			assert.equal((await listSlaPolicies(db, E.org.id, { isDefault: true })).length, 1);
		}
	);

	await t.test(
		'servicio: validación fail-closed, org no operativa, sin borrado físico',
		async () => {
			await rejectsWith(createSlaPolicy(db, 'x', policy()), 'INVALID_INPUT');
			await rejectsWith(createSlaPolicy(db, randomUUID(), policy()), 'ORGANIZATION_NOT_FOUND');
			const S = await organization('Suspendida');
			await db
				.update(s.organizations)
				.set({ status: 'suspended' })
				.where(eq(s.organizations.id, S.org.id));
			await rejectsWith(createSlaPolicy(db, S.org.id, policy()), 'ORGANIZATION_NOT_OPERATIONAL');
			await rejectsWith(
				updateSlaPolicy(db, A.org.id, randomUUID(), { name: 'X' }),
				'SLA_POLICY_NOT_FOUND'
			);
			await rejectsWith(updateSlaPolicy(db, A.org.id, randomUUID(), {}), 'INVALID_INPUT');
			assert.deepEqual(Object.keys(listRoute).sort(), ['GET', 'POST']);
			assert.deepEqual(Object.keys(itemRoute).sort(), ['GET', 'PATCH'], 'sin DELETE');
		}
	);

	await t.test('34-37. sin integración prematura con incidencias', () => {
		const incidentsSchema = fs.readFileSync('src/lib/server/db/schema/incidents.ts', 'utf8');
		for (const field of [
			'slaPolicyId',
			'firstResponseDueAt',
			'resolutionDueAt',
			'breachedAt',
			'slaStatus'
		])
			assert.ok(!incidentsSchema.includes(field), field);
		for (const file of [
			'src/lib/server/services/incidents.ts',
			'src/lib/server/services/incident-history.ts'
		])
			assert.ok(!fs.readFileSync(file, 'utf8').includes('sla_policies'), file);
		const history = fs.readFileSync('src/lib/server/services/incident-history.ts', 'utf8');
		assert.ok(!/sla_(started|breached|paused)/.test(history));
	});
});

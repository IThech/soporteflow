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
const MIN = 60_000;

test('SoporteFlow — Etapa 5.4T-B: SLA aplicado a incidencias', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server, pg } = f;
	const { ensureOrganizationRoles } = await server.ssrLoadModule(
		'/src/lib/server/services/roles.ts'
	);
	const { createSlaPolicy, updateSlaPolicy } = await server.ssrLoadModule(
		'/src/lib/server/services/sla-policies.ts'
	);
	const { createIncidentRecord, changeIncidentSla } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);
	const { createPublicComment, createInternalNote } = await server.ssrLoadModule(
		'/src/lib/server/services/incident-messages.ts'
	);
	const { SAFE_HISTORY_TYPES } = await server.ssrLoadModule(
		'/src/lib/server/services/incident-history.ts'
	);
	const routes = {
		incidents: await server.ssrLoadModule('/src/routes/api/incidents/+server.ts'),
		detail: await server.ssrLoadModule('/src/routes/api/incidents/[id]/+server.ts'),
		comments: await server.ssrLoadModule('/src/routes/api/incidents/[id]/comments/+server.ts'),
		notes: await server.ssrLoadModule('/src/routes/api/incidents/[id]/internal-notes/+server.ts'),
		sla: await server.ssrLoadModule('/src/routes/api/incidents/[id]/sla/+server.ts'),
		me: await server.ssrLoadModule('/src/routes/api/me/+server.ts')
	};

	let seq = 0;
	async function organization(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'tb-' + randomUUID(), status: 'active' })
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
	async function rawRole(org, permissionIds) {
		const [role] = await db
			.insert(s.roles)
			.values({ organizationId: org.id, name: 'Raw', code: `raw_${++seq}`, isCustom: true })
			.returning();
		for (const permissionId of permissionIds)
			await db.insert(s.rolePermissions).values({ roleId: role.id, permissionId });
		return role;
	}
	async function member(org, roles = []) {
		const user = await createCredentialUser(f, { email: `tb-${randomUUID()}@example.test` });
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
	async function call(handler, { method = 'GET', path: p, who, query = '', params = {}, body }) {
		const url = new URL(`http://localhost${p}?${query}`);
		const headers = new Headers();
		if (who) headers.set('cookie', who.cookie);
		if (body !== undefined) headers.set('content-type', 'application/json');
		const response = await handler({
			url,
			params,
			request: new Request(url, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body)
			})
		});
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null, text };
	}
	const create = (who, org, extra = {}) =>
		call(routes.incidents.POST, {
			method: 'POST',
			path: '/api/incidents',
			who,
			body: { organizationId: org.id, title: 'SLA', description: 'D', client: 'C', ...extra }
		});
	const detail = (who, org, id) =>
		call(routes.detail.GET, {
			path: `/api/incidents/${id}`,
			who,
			query: `organizationId=${org.id}`,
			params: { id }
		});
	const list = (who, org, query = '') =>
		call(routes.incidents.GET, {
			path: '/api/incidents',
			who,
			query: `organizationId=${org.id}${query}`
		});
	const comment = (who, org, id, body = 'Respuesta') =>
		call(routes.comments.POST, {
			method: 'POST',
			path: `/api/incidents/${id}/comments`,
			who,
			query: `organizationId=${org.id}`,
			params: { id },
			body: { body }
		});
	const note = (who, org, id) =>
		call(routes.notes.POST, {
			method: 'POST',
			path: `/api/incidents/${id}/internal-notes`,
			who,
			query: `organizationId=${org.id}`,
			params: { id },
			body: { body: 'Nota interna' }
		});
	const changeSla = (who, org, id, body) =>
		call(routes.sla.PATCH, {
			method: 'PATCH',
			path: `/api/incidents/${id}/sla`,
			who,
			query: `organizationId=${org.id}`,
			params: { id },
			body
		});
	async function row(id) {
		const [r] = await db.select().from(s.incidents).where(eq(s.incidents.id, id));
		return r;
	}
	const policyInput = (fr, res, extra = {}) => ({
		code: `p_${++seq}`,
		name: 'Política',
		firstResponseMinutes: fr,
		resolutionMinutes: res,
		...extra
	});
	const iso = (d) => new Date(d).toISOString();

	const A = await organization('Alfa');
	const B = await organization('Beta');
	const N = await organization('Sin default');
	const admin = await member(A.org, [A.admin]);
	const tech = await member(A.org, [A.tech]);
	const customer = await member(A.org, [A.customer]);
	const adminB = await member(B.org, [B.admin]);
	const adminN = await member(N.org, [N.admin]);
	const defaultA = await createSlaPolicy(db, A.org.id, policyInput(60, 480, { isDefault: true }));
	const premiumA = await createSlaPolicy(db, A.org.id, policyInput(15, 120));
	const inactiveA = await createSlaPolicy(db, A.org.id, policyInput(30, 60));
	await updateSlaPolicy(db, A.org.id, inactiveA.id, { active: false });
	const policyB = await createSlaPolicy(db, B.org.id, policyInput(10, 20, { isDefault: true }));

	// =========================================================================
	// Migración y schema (48)
	// =========================================================================
	await t.test(
		'48. upgrade 0017 -> 0018: columnas NULL en incidencias existentes, sla:assign, idempotente',
		async () => {
			const up = new PGlite();
			try {
				const journal = JSON.parse(
					fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')
				);
				const index = journal.entries.findIndex((e) => e.tag === '0018_incident_sla');
				assert.ok(index > 0);
				await applyRange(up, 0, index - 1);
				const org = randomUUID();
				const user = randomUUID();
				await up.query(
					`INSERT INTO organizations (id, name, slug, status) VALUES ($1,'U',$2,'active')`,
					[org, 'u-' + org]
				);
				await up.query(`INSERT INTO users (id, name) VALUES ($1, 'U')`, [user]);
				await up.query(`INSERT INTO memberships (organization_id, user_id) VALUES ($1, $2)`, [
					org,
					user
				]);
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
				await up.query(
					`INSERT INTO sla_policies (organization_id, code, name, first_response_minutes, resolution_minutes, is_default) VALUES ($1,'std','Std',60,120,true)`,
					[org]
				);
				await up.query(
					`INSERT INTO incidents (organization_id, incident_number, title, description, client, created_by_user_id)
				 VALUES ($1, 1, 'Vieja', 'D', 'C', $2)`,
					[org, user]
				);
				await applyRange(up, index, index);
				await applyRange(up, index, index);
				const {
					rows: [old]
				} = await up.query(
					`SELECT sla_policy_id, sla_applied_at, first_response_due_at, first_response_at FROM incidents`
				);
				assert.deepEqual(
					old,
					{
						sla_policy_id: null,
						sla_applied_at: null,
						first_response_due_at: null,
						first_response_at: null
					},
					'sin SLA retroactivo'
				);
				const perms = async (id) =>
					(
						await up.query(
							`SELECT permission_id FROM role_permissions WHERE role_id = $1 AND permission_id = 'sla:assign'`,
							[id]
						)
					).rows.length;
				assert.equal(await perms(ids.organization_admin), 1);
				assert.equal(await perms(ids.technician), 1);
				assert.equal(await perms(ids.customer), 0);
				assert.equal(await perms(ids.auditor), 0, 'custom intacto');
			} finally {
				await up.close();
			}
		}
	);

	await t.test(
		'5-6. FK compuesta (política de otro tenant imposible) y CHECK de coherencia',
		async () => {
			const inc = await create(admin, A.org);
			const id = inc.json.incident.id;
			// política de B en incidencia de A: rechazada por la FK compuesta
			await assert.rejects(
				pg.query(
					`UPDATE incidents SET sla_policy_id = $1, sla_first_response_minutes = 10, sla_resolution_minutes = 20,
				   sla_applied_at = now(), first_response_due_at = now() + interval '10 minutes', resolution_due_at = now() + interval '20 minutes'
				 WHERE id = $2`,
					[policyB.id, id]
				),
				(e) => /incidents_sla_policy_org_fk/.test(e.message)
			);
			for (const sql of [
				// snapshot parcial
				`UPDATE incidents SET sla_policy_id = NULL WHERE id = $1`,
				// deadline que no cuadra con applied_at + minutos (spoof)
				`UPDATE incidents SET first_response_due_at = first_response_due_at + interval '1 day' WHERE id = $1`,
				`UPDATE incidents SET sla_resolution_minutes = 1 WHERE id = $1`
			])
				await assert.rejects(
					pg.query(sql, [id]),
					(e) => /incidents_sla_snapshot_check/.test(e.message),
					sql
				);
			const idx = (
				await pg.query(
					`SELECT indexname FROM pg_indexes WHERE tablename = 'incidents' AND indexname LIKE '%due%' ORDER BY 1`
				)
			).rows.map((r) => r.indexname);
			assert.deepEqual(idx, [
				'incidents_org_first_response_due_idx',
				'incidents_org_resolution_due_idx'
			]);
		}
	);

	// =========================================================================
	// Creación (49-51)
	// =========================================================================
	await t.test(
		'49. sin slaPolicyId: se aplica el default con snapshot exacto y deadlines 24x7',
		async () => {
			const res = await create(customer, A.org);
			assert.equal(res.status, 201, res.text);
			const inc = res.json.incident;
			assert.equal(inc.slaPolicyId, defaultA.id);
			assert.equal(inc.slaFirstResponseMinutes, 60);
			assert.equal(inc.slaResolutionMinutes, 480);
			assert.equal(inc.slaAppliedAt, inc.createdAt, 'aplicada en la creación');
			assert.equal(inc.firstResponseDueAt, iso(Date.parse(inc.createdAt) + 60 * MIN));
			assert.equal(inc.resolutionDueAt, iso(Date.parse(inc.createdAt) + 480 * MIN));
			assert.equal(inc.firstResponseAt, null);
		}
	);

	await t.test('50. org sin default: incidencia sin SLA y sin fallo', async () => {
		const res = await create(adminN, N.org);
		assert.equal(res.status, 201);
		for (const key of [
			'slaPolicyId',
			'slaFirstResponseMinutes',
			'slaResolutionMinutes',
			'slaAppliedAt',
			'firstResponseDueAt',
			'resolutionDueAt',
			'firstResponseAt'
		])
			assert.equal(res.json.incident[key], null, key);
	});

	await t.test(
		'51. staff con sla:assign elige política activa; null = sin SLA; ajena/inactiva denegada',
		async () => {
			const chosen = await create(tech, A.org, { slaPolicyId: premiumA.id });
			assert.equal(chosen.status, 201);
			assert.equal(chosen.json.incident.slaPolicyId, premiumA.id);
			assert.equal(chosen.json.incident.slaFirstResponseMinutes, 15);
			const none = await create(admin, A.org, { slaPolicyId: null });
			assert.equal(none.json.incident.slaPolicyId, null);
			const before = (await db.select().from(s.incidents)).length;
			const foreign = await create(admin, A.org, { slaPolicyId: policyB.id });
			const missing = await create(admin, A.org, { slaPolicyId: randomUUID() });
			assert.equal(foreign.status, 404);
			assert.deepEqual(foreign.json, missing.json);
			assert.equal(foreign.json.error.code, 'SLA_POLICY_NOT_FOUND');
			const inactive = await create(admin, A.org, { slaPolicyId: inactiveA.id });
			assert.equal(inactive.status, 409);
			assert.equal(inactive.json.error.code, 'SLA_POLICY_INACTIVE');
			assert.equal((await create(admin, A.org, { slaPolicyId: 'x' })).status, 400);
			assert.equal((await db.select().from(s.incidents)).length, before, 'nada creado');
		}
	);

	await t.test(
		'9/31. Customer no puede elegir SLA (403 sin escribir); campos SLA del servidor rechazados',
		async () => {
			const before = (await db.select().from(s.incidents)).length;
			for (const slaPolicyId of [premiumA.id, null]) {
				const res = await create(customer, A.org, { slaPolicyId });
				assert.equal(res.status, 403);
				assert.equal(res.json.error.code, 'FORBIDDEN');
			}
			const noAssign = await member(A.org, [
				await rawRole(A.org, ['incidents:create', 'incidents:view_all'])
			]);
			assert.equal((await create(noAssign, A.org, { slaPolicyId: premiumA.id })).status, 403);
			for (const field of [
				'slaFirstResponseMinutes',
				'slaResolutionMinutes',
				'slaAppliedAt',
				'firstResponseAt',
				'firstResponseDueAt',
				'resolutionDueAt'
			]) {
				const res = await create(admin, A.org, {
					[field]: field.endsWith('Minutes') ? 1 : new Date().toISOString()
				});
				assert.equal(res.status, 400, field);
			}
			assert.equal((await db.select().from(s.incidents)).length, before);
		}
	);

	// =========================================================================
	// Snapshot (52, 25-26)
	// =========================================================================
	await t.test(
		'52/25-26. editar o desactivar la política no altera incidencias existentes',
		async () => {
			const p = await createSlaPolicy(db, A.org.id, policyInput(20, 200));
			const inc = (await create(admin, A.org, { slaPolicyId: p.id })).json.incident;
			const snapshot = await row(inc.id);
			await updateSlaPolicy(db, A.org.id, p.id, { firstResponseMinutes: 5, resolutionMinutes: 9 });
			await updateSlaPolicy(db, A.org.id, p.id, { active: false });
			const after = await row(inc.id);
			for (const key of [
				'slaPolicyId',
				'slaFirstResponseMinutes',
				'slaResolutionMinutes',
				'slaAppliedAt',
				'firstResponseDueAt',
				'resolutionDueAt'
			])
				assert.deepEqual(after[key], snapshot[key], key);
			assert.equal(after.slaFirstResponseMinutes, 20);
		}
	);

	// =========================================================================
	// Reasignación / quitar (53-54, 21-24)
	// =========================================================================
	await t.test(
		'53. reasignar: snapshot nuevo, appliedAt = ahora y deadlines desde ahora; misma política no-op',
		async () => {
			const inc = (await create(admin, A.org)).json.incident;
			const backdated = new Date(Date.now() - 3 * 3600 * 1000);
			await pg.query(
				`UPDATE incidents SET created_at = $1, sla_applied_at = $1, first_response_due_at = $1::timestamptz + interval '60 minutes',
			   resolution_due_at = $1::timestamptz + interval '480 minutes' WHERE id = $2`,
				[backdated, inc.id]
			);
			const before = Date.now();
			const res = await changeSla(tech, A.org, inc.id, { slaPolicyId: premiumA.id });
			assert.equal(res.status, 200, res.text);
			const updated = res.json.incident;
			assert.equal(updated.slaPolicyId, premiumA.id);
			assert.equal(updated.slaFirstResponseMinutes, 15);
			const applied = Date.parse(updated.slaAppliedAt);
			assert.ok(applied >= before - 1000, 'aplicada ahora, no en created_at');
			assert.equal(updated.firstResponseDueAt, iso(applied + 15 * MIN));
			assert.equal(updated.resolutionDueAt, iso(applied + 120 * MIN));
			assert.ok(Date.parse(updated.firstResponseDueAt) > Date.now(), 'sin deadline nacido vencido');
			const again = await changeSla(tech, A.org, inc.id, { slaPolicyId: premiumA.id });
			assert.equal(again.json.incident.slaAppliedAt, updated.slaAppliedAt, 'no reinicia el reloj');
		}
	);

	await t.test(
		'54/23-24. quitar SLA limpia snapshot y deadlines; firstResponseAt se conserva',
		async () => {
			const inc = (await create(customer, A.org)).json.incident;
			assert.equal((await comment(tech, A.org, inc.id)).status, 201);
			const answered = await row(inc.id);
			assert.ok(answered.firstResponseAt instanceof Date);
			const cleared = await changeSla(admin, A.org, inc.id, { slaPolicyId: null });
			assert.equal(cleared.status, 200);
			for (const key of [
				'slaPolicyId',
				'slaFirstResponseMinutes',
				'slaResolutionMinutes',
				'slaAppliedAt',
				'firstResponseDueAt',
				'resolutionDueAt'
			])
				assert.equal(cleared.json.incident[key], null, key);
			assert.equal(cleared.json.incident.firstResponseAt, answered.firstResponseAt.toISOString());
			const reapplied = await changeSla(admin, A.org, inc.id, { slaPolicyId: defaultA.id });
			assert.equal(
				reapplied.json.incident.firstResponseAt,
				answered.firstResponseAt.toISOString(),
				'hecho histórico'
			);
		}
	);

	await t.test(
		'36-38. PATCH /sla: permisos, acceso de mutación, tenant, inactiva, cerrada y cuerpo estricto',
		async () => {
			const own = (await create(customer, A.org)).json.incident;
			assert.equal(
				(await changeSla(customer, A.org, own.id, { slaPolicyId: premiumA.id })).status,
				403,
				'Customer con acceso requested'
			);
			const noAssign = await member(A.org, [
				await rawRole(A.org, ['incidents:view_all', 'incidents:edit'])
			]);
			assert.equal(
				(await changeSla(noAssign, A.org, own.id, { slaPolicyId: premiumA.id })).status,
				403
			);
			// sla:assign sin acceso de mutación a esa incidencia (view_own, no asignada)
			const ownScope = await member(A.org, [
				await rawRole(A.org, ['sla:assign', 'incidents:view_own'])
			]);
			assert.equal(
				(await changeSla(ownScope, A.org, own.id, { slaPolicyId: premiumA.id })).status,
				403
			);
			assert.equal((await changeSla(null, A.org, own.id, { slaPolicyId: null })).status, 401);
			const before = await row(own.id);
			const foreign = await changeSla(admin, A.org, own.id, { slaPolicyId: policyB.id });
			assert.equal(foreign.status, 404);
			assert.equal(foreign.json.error.code, 'SLA_POLICY_NOT_FOUND');
			const inactive = await changeSla(admin, A.org, own.id, { slaPolicyId: inactiveA.id });
			assert.equal(inactive.status, 409);
			assert.equal(inactive.json.error.code, 'SLA_POLICY_INACTIVE');
			for (const body of [
				{},
				{ slaPolicyId: 'x' },
				{ slaPolicyId: premiumA.id, extra: 1 },
				{ firstResponseDueAt: null }
			])
				assert.equal(
					(await changeSla(admin, A.org, own.id, body)).status,
					400,
					JSON.stringify(body)
				);
			assert.deepEqual(await row(own.id), before, 'sin escrituras');
			const incB = (await create(adminB, B.org)).json.incident;
			assert.equal(
				(await changeSla(admin, A.org, incB.id, { slaPolicyId: premiumA.id })).status,
				404,
				'incidencia ajena'
			);
			await db.update(s.incidents).set({ status: 'closed' }).where(eq(s.incidents.id, own.id));
			const closed = await changeSla(admin, A.org, own.id, { slaPolicyId: premiumA.id });
			assert.equal(closed.status, 409);
			assert.equal(closed.json.error.code, 'INCIDENT_CLOSED');
		}
	);

	await t.test(
		'45 (5.4T-C). cambios de SLA auditados: sla_applied al crear y sla_changed al reasignar',
		async () => {
			assert.ok(SAFE_HISTORY_TYPES.includes('sla_changed'));
			const inc = (await create(admin, A.org)).json.incident;
			await changeSla(admin, A.org, inc.id, { slaPolicyId: premiumA.id });
			const events = await db
				.select()
				.from(s.incidentHistory)
				.where(eq(s.incidentHistory.incidentId, inc.id));
			assert.deepEqual(events.map((e) => e.eventType).sort(), [
				'created',
				'sla_applied',
				'sla_changed'
			]);
		}
	);

	// =========================================================================
	// Primera respuesta (55-57)
	// =========================================================================
	await t.test(
		'55/42. comentario del Customer no cuenta; el de soporte sí, una sola vez',
		async () => {
			const inc = (await create(customer, A.org)).json.incident;
			assert.equal((await comment(customer, A.org, inc.id, 'Hola?')).status, 201);
			assert.equal((await row(inc.id)).firstResponseAt, null);
			assert.equal((await comment(tech, A.org, inc.id, 'Lo miramos')).status, 201);
			const first = (await row(inc.id)).firstResponseAt;
			assert.ok(first instanceof Date);
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal((await comment(admin, A.org, inc.id, 'Seguimos')).status, 201);
			assert.equal(
				(await row(inc.id)).firstResponseAt.getTime(),
				first.getTime(),
				'first write wins'
			);
		}
	);

	await t.test('43. nota interna no cuenta como primera respuesta', async () => {
		const inc = (await create(customer, A.org)).json.incident;
		assert.equal((await note(tech, A.org, inc.id)).status, 201);
		assert.equal((await row(inc.id)).firstResponseAt, null);
	});

	await t.test(
		'56. multi-rol por capability: técnico+cliente cuenta en ajenas, no en su propia solicitud',
		async () => {
			const both = await member(A.org, [A.tech, A.customer]);
			const mine = (await create(both, A.org, { slaPolicyId: premiumA.id })).json.incident;
			assert.equal(mine.clientUserId, null, 'staff con view_all no se fija como solicitante');
			const requested = (
				await createIncidentRecord(
					db,
					{ organizationId: A.org.id, creatorUserId: admin.user.id },
					{
						title: 'Mía',
						description: 'D',
						client: 'C',
						clientUserId: both.user.id
					}
				)
			).incident;
			assert.equal((await comment(both, A.org, requested.id, 'Soy yo')).status, 201);
			assert.equal(
				(await row(requested.id)).firstResponseAt,
				null,
				'el solicitante no se responde a sí mismo'
			);
			const other = (await create(customer, A.org)).json.incident;
			assert.equal((await comment(both, A.org, other.id, 'Ayuda')).status, 201);
			assert.ok((await row(other.id)).firstResponseAt instanceof Date);
			// view_own (asignado) también es scope de soporte
			const assignee = await member(A.org, [
				await rawRole(A.org, ['incidents:view_own', 'incidents:add_comment'])
			]);
			const assigned = (await create(customer, A.org)).json.incident;
			await db
				.update(s.incidents)
				.set({ assignedToUserId: assignee.user.id })
				.where(eq(s.incidents.id, assigned.id));
			assert.equal((await comment(assignee, A.org, assigned.id)).status, 201);
			assert.ok((await row(assigned.id)).firstResponseAt instanceof Date);
		}
	);

	await t.test(
		'primera respuesta sin SLA también se registra (hecho general); servicio sin flag no cuenta',
		async () => {
			const inc = (await create(adminN, N.org)).json.incident;
			const staffN = await member(N.org, [N.tech]);
			assert.equal((await comment(staffN, N.org, inc.id)).status, 201);
			assert.ok((await row(inc.id)).firstResponseAt instanceof Date);
			const quiet = (await create(adminN, N.org)).json.incident;
			await createPublicComment(
				db,
				{ organizationId: N.org.id, incidentId: quiet.id, actorUserId: adminN.user.id },
				'x'
			);
			await createInternalNote(
				db,
				{ organizationId: N.org.id, incidentId: quiet.id, actorUserId: adminN.user.id },
				'y'
			);
			assert.equal((await row(quiet.id)).firstResponseAt, null);
		}
	);

	await t.test('57/18. cerrada: comentario sigue 409, SLA persistido', async () => {
		const inc = (await create(customer, A.org)).json.incident;
		await db.update(s.incidents).set({ status: 'closed' }).where(eq(s.incidents.id, inc.id));
		const res = await comment(tech, A.org, inc.id);
		assert.equal(res.status, 409);
		const r = await row(inc.id);
		assert.equal(r.firstResponseAt, null);
		assert.equal(r.slaPolicyId, defaultA.id);
	});

	await t.test(
		'41. carrera de respuestas (PGlite, serializadas): un único firstResponseAt estable',
		async () => {
			const inc = (await create(customer, A.org)).json.incident;
			const results = await Promise.all([
				comment(tech, A.org, inc.id, 'a'),
				comment(admin, A.org, inc.id, 'b'),
				comment(tech, A.org, inc.id, 'c')
			]);
			assert.deepEqual(
				results.map((r) => r.status),
				[201, 201, 201]
			);
			const first = (await row(inc.id)).firstResponseAt;
			assert.ok(first instanceof Date);
			await comment(admin, A.org, inc.id, 'd');
			assert.equal((await row(inc.id)).firstResponseAt.getTime(), first.getTime());
		}
	);

	await t.test(
		'carrera de reasignaciones (PGlite): estado final coherente con el CHECK',
		async () => {
			const inc = (await create(admin, A.org)).json.incident;
			await Promise.all([
				changeIncidentSla(
					db,
					{ organizationId: A.org.id, actorUserId: admin.user.id, access: { viewAll: true } },
					inc.id,
					{ slaPolicyId: premiumA.id }
				),
				changeIncidentSla(
					db,
					{ organizationId: A.org.id, actorUserId: admin.user.id, access: { viewAll: true } },
					inc.id,
					{ slaPolicyId: null }
				),
				changeIncidentSla(
					db,
					{ organizationId: A.org.id, actorUserId: admin.user.id, access: { viewAll: true } },
					inc.id,
					{ slaPolicyId: defaultA.id }
				)
			]);
			const r = await row(inc.id);
			assert.ok([premiumA.id, defaultA.id, null].includes(r.slaPolicyId));
		}
	);

	// =========================================================================
	// DTO (58)
	// =========================================================================
	await t.test(
		'58. listado y detalle exponen SLA; Customer ve SLA de su incidencia; sin fugas de tenant',
		async () => {
			const inc = (await create(customer, A.org)).json.incident;
			const d = await detail(customer, A.org, inc.id);
			assert.equal(d.status, 200);
			assert.equal(d.json.incident.slaPolicyId, defaultA.id);
			assert.equal(d.json.incident.firstResponseDueAt, inc.firstResponseDueAt);
			const l = await list(customer, A.org);
			const item = l.json.incidents.find((i) => i.id === inc.id);
			assert.equal(item.resolutionDueAt, inc.resolutionDueAt);
			assert.ok(!l.text.includes(policyB.id), 'nada de otro tenant');
			const staff = await list(admin, A.org, '&queue=all');
			assert.ok(staff.json.incidents.every((i) => 'firstResponseAt' in i && 'slaPolicyId' in i));
			assert.ok(!/breach|slaStatus/i.test(staff.text), 'sin estado de incumplimiento (T-C)');
		}
	);

	await t.test('capabilities: Admin y Technician tienen sla:assign; Customer no', async () => {
		const caps = async (who) => {
			const url = new URL(`http://localhost/api/me?organizationId=${A.org.id}`);
			const res = await routes.me.GET({
				url,
				request: new Request(url, { headers: { cookie: who.cookie } })
			});
			return (await res.json()).activeOrganization.capabilities;
		};
		assert.ok((await caps(admin)).includes('sla:assign'));
		assert.ok((await caps(tech)).includes('sla:assign'));
		assert.ok(!(await caps(customer)).some((c) => c.startsWith('sla:')));
	});
});

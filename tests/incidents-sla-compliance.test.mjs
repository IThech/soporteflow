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

test('SoporteFlow — Etapa 5.4T-C: cumplimiento SLA, incumplimiento y operación', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server, pg } = f;
	const { ensureOrganizationRoles } = await server.ssrLoadModule(
		'/src/lib/server/services/roles.ts'
	);
	const { createSlaPolicy } = await server.ssrLoadModule(
		'/src/lib/server/services/sla-policies.ts'
	);
	const { listIncidents } = await server.ssrLoadModule('/src/lib/server/services/incidents.ts');
	const compliance = await server.ssrLoadModule('/src/lib/server/services/sla-compliance.ts');
	const { computeIncidentSlaCompliance, objectiveStatus } = compliance;
	const routes = {
		incidents: await server.ssrLoadModule('/src/routes/api/incidents/+server.ts'),
		detail: await server.ssrLoadModule('/src/routes/api/incidents/[id]/+server.ts'),
		comments: await server.ssrLoadModule('/src/routes/api/incidents/[id]/comments/+server.ts'),
		history: await server.ssrLoadModule('/src/routes/api/incidents/[id]/history/+server.ts'),
		sla: await server.ssrLoadModule('/src/routes/api/incidents/[id]/sla/+server.ts')
	};

	let seq = 0;
	async function organization(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'tc-' + randomUUID(), status: 'active' })
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
		const user = await createCredentialUser(f, { email: `tc-${randomUUID()}@example.test` });
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
	const setStatus = (who, org, id, status) =>
		call(routes.detail.PATCH, {
			method: 'PATCH',
			path: `/api/incidents/${id}`,
			who,
			query: `organizationId=${org.id}`,
			params: { id },
			body: { status }
		});
	const comment = (who, org, id) =>
		call(routes.comments.POST, {
			method: 'POST',
			path: `/api/incidents/${id}/comments`,
			who,
			query: `organizationId=${org.id}`,
			params: { id },
			body: { body: 'Respuesta' }
		});
	const history = (who, org, id) =>
		call(routes.history.GET, {
			path: `/api/incidents/${id}/history`,
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
	async function row(id) {
		const [r] = await db.select().from(s.incidents).where(eq(s.incidents.id, id));
		return r;
	}
	async function events(id) {
		return (await db.select().from(s.incidentHistory).where(eq(s.incidentHistory.incidentId, id)))
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((e) => e.eventType);
	}
	/** Moves the SLA clock back (consistently with the snapshot CHECK). */
	async function backdate(id, minutesAgo) {
		await pg.query(
			`UPDATE incidents SET sla_applied_at = t.a, created_at = t.a,
			   first_response_due_at = t.a + sla_first_response_minutes * interval '1 minute',
			   resolution_due_at = t.a + sla_resolution_minutes * interval '1 minute'
			 FROM (SELECT now() - make_interval(mins => $2) AS a) t WHERE incidents.id = $1`,
			[id, minutesAgo]
		);
	}

	const A = await organization('Alfa');
	const B = await organization('Beta');
	const N = await organization('Sin SLA');
	const admin = await member(A.org, [A.admin]);
	const tech = await member(A.org, [A.tech]);
	const customer = await member(A.org, [A.customer]);
	const otherCustomer = await member(A.org, [A.customer]);
	const adminB = await member(B.org, [B.admin]);
	const adminN = await member(N.org, [N.admin]);
	// 60 min primera respuesta, 120 min resolución
	await createSlaPolicy(db, A.org.id, {
		code: 'std',
		name: 'Std',
		firstResponseMinutes: 60,
		resolutionMinutes: 120,
		isDefault: true
	});
	await createSlaPolicy(db, B.org.id, {
		code: 'std',
		name: 'Std',
		firstResponseMinutes: 60,
		resolutionMinutes: 120,
		isDefault: true
	});

	// =========================================================================
	// Matriz pura (44-52)
	// =========================================================================
	await t.test('44-52. helper puro: objetivos y estado global con now inyectado', () => {
		const base = new Date('2026-01-01T00:00:00Z');
		const at = (m) => new Date(base.getTime() + m * MIN);
		const due1 = at(60);
		assert.equal(objectiveStatus(due1, at(30), at(500)), 'met', '44');
		assert.equal(objectiveStatus(due1, at(90), at(500)), 'breached', '45');
		assert.equal(objectiveStatus(due1, null, at(59)), 'pending', '46');
		assert.equal(objectiveStatus(due1, null, at(60)), 'pending', 'en el límite exacto: pending');
		assert.equal(objectiveStatus(due1, null, at(61)), 'breached', '47 sin worker');
		assert.equal(objectiveStatus(due1, at(60), at(500)), 'met', 'a la hora exacta: met');
		assert.equal(objectiveStatus(null, at(1), at(2)), 'not_applicable');
		const inc = (over) => ({
			slaPolicyId: 'p',
			firstResponseDueAt: at(60),
			resolutionDueAt: at(120),
			firstResponseAt: null,
			firstResolvedAt: null,
			...over
		});
		const overall = (over, now) => computeIncidentSlaCompliance(inc(over), now);
		assert.deepEqual(overall({}, at(10)), {
			slaOverallStatus: 'on_track',
			slaFirstResponseStatus: 'pending',
			slaResolutionStatus: 'pending'
		});
		assert.equal(overall({ firstResponseAt: at(30) }, at(90)).slaOverallStatus, 'on_track');
		assert.equal(overall({}, at(90)).slaOverallStatus, 'breached');
		assert.equal(
			overall({ firstResponseAt: at(30), firstResolvedAt: at(100) }, at(999)).slaOverallStatus,
			'met'
		);
		assert.equal(
			overall({ firstResponseAt: at(30), firstResolvedAt: at(130) }, at(999)).slaOverallStatus,
			'breached'
		);
		assert.equal(
			overall({ firstResponseAt: at(30) }, at(121)).slaResolutionStatus,
			'breached',
			'51'
		);
		assert.equal(
			overall({ firstResponseAt: at(30), firstResolvedAt: at(100) }, at(999)).slaResolutionStatus,
			'met',
			'48'
		);
		assert.deepEqual(
			computeIncidentSlaCompliance(
				{
					slaPolicyId: null,
					firstResponseDueAt: null,
					resolutionDueAt: null,
					firstResponseAt: at(1),
					firstResolvedAt: at(2)
				},
				at(3)
			),
			{
				slaOverallStatus: 'not_applicable',
				slaFirstResponseStatus: 'not_applicable',
				slaResolutionStatus: 'not_applicable'
			},
			'43: sin SLA aunque haya firstResponseAt'
		);
	});

	// =========================================================================
	// Migración (56)
	// =========================================================================
	await t.test(
		'56. upgrade 0018 -> 0019: backfill desde historial real, sin inventar; tipos SLA admitidos',
		async () => {
			const up = new PGlite();
			try {
				const journal = JSON.parse(
					fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')
				);
				const index = journal.entries.findIndex((e) => e.tag === '0019_incident_sla_compliance');
				assert.ok(index > 0);
				await applyRange(up, 0, index - 1);
				const org = randomUUID();
				const user = randomUUID();
				await up.query(
					`INSERT INTO organizations (id, name, slug, status) VALUES ($1,'U',$2,'active')`,
					[org, 'u-' + org]
				);
				await up.query(`INSERT INTO users (id, name) VALUES ($1,'U')`, [user]);
				await up.query(`INSERT INTO memberships (organization_id, user_id) VALUES ($1,$2)`, [
					org,
					user
				]);
				const ids = [];
				for (let n = 1; n <= 3; n++) {
					const {
						rows: [r]
					} = await up.query(
						`INSERT INTO incidents (organization_id, incident_number, title, description, client, created_by_user_id)
					 VALUES ($1,$2,'I','D','C',$3) RETURNING id`,
						[org, n, user]
					);
					ids.push(r.id);
				}
				const ev = (id, type, at) =>
					up.query(
						`INSERT INTO incident_history (incident_id, organization_id, event_type, actor_type, actor_user_id, created_at)
					 VALUES ($1,$2,$3,'user',$4,$5)`,
						[id, org, type, user, at]
					);
				await ev(ids[0], 'resolved', '2026-01-02T10:00:00Z');
				await ev(ids[0], 'reopened', '2026-01-03T10:00:00Z');
				await ev(ids[0], 'resolved', '2026-01-04T10:00:00Z');
				await ev(ids[1], 'status_changed', '2026-01-02T10:00:00Z');
				await applyRange(up, index, index);
				await applyRange(up, index, index);
				const { rows } = await up.query(
					`SELECT id, first_resolved_at FROM incidents ORDER BY incident_number`
				);
				assert.equal(
					rows[0].first_resolved_at.toISOString(),
					'2026-01-02T10:00:00.000Z',
					'primera resolución real'
				);
				assert.equal(rows[1].first_resolved_at, null, 'sin evento: no se inventa');
				assert.equal(rows[2].first_resolved_at, null);
				await ev(ids[2], 'sla_resolution_met', '2026-01-05T10:00:00Z');
				await assert.rejects(
					ev(ids[2], 'sla_bogus', '2026-01-05T10:00:00Z'),
					/incident_history_event_type_check/
				);
			} finally {
				await up.close();
			}
		}
	);

	// =========================================================================
	// Resolución y reopen (40-42, 13-14)
	// =========================================================================
	await t.test(
		'40. resuelta a tiempo -> reabierta: sigue met; primera resolución fija',
		async () => {
			const inc = (await create(customer, A.org)).json.incident;
			assert.equal((await comment(tech, A.org, inc.id)).status, 201);
			const resolved = await setStatus(tech, A.org, inc.id, 'resolved');
			assert.equal(resolved.status, 200, resolved.text);
			const first = (await row(inc.id)).firstResolvedAt;
			assert.ok(first instanceof Date);
			assert.equal(resolved.json.incident.slaResolutionStatus, 'met');
			assert.equal(resolved.json.incident.slaOverallStatus, 'met');
			assert.equal((await setStatus(tech, A.org, inc.id, 'open')).status, 200);
			const reopened = await detail(customer, A.org, inc.id);
			assert.equal(reopened.json.incident.status, 'open');
			assert.equal(reopened.json.incident.slaResolutionStatus, 'met', 'reopen no reinicia el SLA');
			assert.equal(reopened.json.incident.firstResolvedAt, first.toISOString());
			// 42: resolved -> reopen -> resolved -> closed: la marca no cambia
			await setStatus(tech, A.org, inc.id, 'resolved');
			await setStatus(tech, A.org, inc.id, 'closed');
			const final = await row(inc.id);
			assert.equal(final.firstResolvedAt.getTime(), first.getTime());
			assert.equal(
				final.resolutionDueAt.getTime(),
				(await row(inc.id)).resolutionDueAt.getTime(),
				'sin recálculo'
			);
			const types = await events(inc.id);
			assert.equal(
				types.filter((x) => x === 'sla_resolution_met').length,
				1,
				'resultado registrado una vez'
			);
			assert.ok(!types.includes('sla_resolution_breached'));
		}
	);

	await t.test('40b/49. resuelta tarde -> reabierta: sigue breached', async () => {
		const inc = (await create(customer, A.org)).json.incident;
		await backdate(inc.id, 300);
		await setStatus(tech, A.org, inc.id, 'resolved');
		const r = await detail(tech, A.org, inc.id);
		assert.equal(r.json.incident.slaResolutionStatus, 'breached');
		assert.equal(r.json.incident.slaFirstResponseStatus, 'breached', 'sin respuesta y vencida');
		assert.equal(r.json.incident.slaOverallStatus, 'breached');
		await setStatus(tech, A.org, inc.id, 'open');
		assert.equal((await detail(tech, A.org, inc.id)).json.incident.slaResolutionStatus, 'breached');
		assert.ok((await events(inc.id)).includes('sla_resolution_breached'));
	});

	await t.test(
		'41. cierre directo no existe en el dominio (open -> closed rechazado); closed tras resolved no mueve la marca',
		async () => {
			const inc = (await create(customer, A.org)).json.incident;
			assert.equal((await setStatus(tech, A.org, inc.id, 'closed')).status, 400);
			assert.equal((await row(inc.id)).firstResolvedAt, null);
			await setStatus(tech, A.org, inc.id, 'resolved');
			const t1 = (await row(inc.id)).firstResolvedAt;
			await setStatus(tech, A.org, inc.id, 'closed');
			assert.equal((await row(inc.id)).firstResolvedAt.getTime(), t1.getTime());
		}
	);

	await t.test(
		'sin SLA: marcas registradas como hechos, estados not_applicable y sin eventos SLA',
		async () => {
			const inc = (await create(adminN, N.org)).json.incident;
			const staffN = await member(N.org, [N.tech]);
			await comment(staffN, N.org, inc.id);
			await setStatus(staffN, N.org, inc.id, 'resolved');
			const d = (await detail(adminN, N.org, inc.id)).json.incident;
			assert.ok(d.firstResponseAt && d.firstResolvedAt);
			assert.equal(d.slaOverallStatus, 'not_applicable');
			assert.equal(d.slaFirstResponseStatus, 'not_applicable');
			assert.equal(d.slaResolutionStatus, 'not_applicable');
			assert.ok(!(await events(inc.id)).some((x) => x.startsWith('sla_')));
		}
	);

	// =========================================================================
	// Primera respuesta (31, 44-47)
	// =========================================================================
	await t.test(
		'31/44-45. primera respuesta: evento met en plazo, breached fuera; una sola vez',
		async () => {
			const onTime = (await create(customer, A.org)).json.incident;
			await comment(tech, A.org, onTime.id);
			await comment(admin, A.org, onTime.id);
			const typesOnTime = await events(onTime.id);
			assert.equal(typesOnTime.filter((x) => x.startsWith('sla_first_response')).length, 1);
			assert.ok(typesOnTime.includes('sla_first_response_met'));
			assert.equal(
				(await detail(customer, A.org, onTime.id)).json.incident.slaFirstResponseStatus,
				'met'
			);
			const late = (await create(customer, A.org)).json.incident;
			await backdate(late.id, 90);
			assert.equal(
				(await detail(customer, A.org, late.id)).json.incident.slaFirstResponseStatus,
				'breached',
				'47: sin worker'
			);
			await comment(tech, A.org, late.id);
			assert.ok((await events(late.id)).includes('sla_first_response_breached'));
			assert.equal(
				(await detail(customer, A.org, late.id)).json.incident.slaFirstResponseStatus,
				'breached'
			);
			// comentario del Customer: ni marca ni evento
			const quiet = (await create(customer, A.org)).json.incident;
			await comment(customer, A.org, quiet.id);
			assert.ok(!(await events(quiet.id)).some((x) => x.startsWith('sla_first')));
			assert.equal(
				(await detail(customer, A.org, quiet.id)).json.incident.slaFirstResponseStatus,
				'pending'
			);
		}
	);

	// =========================================================================
	// Auditoría de cambios de SLA (33-37)
	// =========================================================================
	await t.test(
		'33-37. sla_applied al crear, sla_changed al reiniciar y sla_cleared, con payload de auditoría',
		async () => {
			const premium = await createSlaPolicy(db, A.org.id, {
				code: `prem_${++seq}`,
				name: 'P',
				firstResponseMinutes: 10,
				resolutionMinutes: 20
			});
			const inc = (await create(customer, A.org)).json.incident;
			const change = (slaPolicyId) =>
				call(routes.sla.PATCH, {
					method: 'PATCH',
					path: `/api/incidents/${inc.id}/sla`,
					who: tech,
					query: `organizationId=${A.org.id}`,
					params: { id: inc.id },
					body: { slaPolicyId }
				});
			await change(premium.id);
			await change(null);
			await change(premium.id);
			const rows = (
				await db.select().from(s.incidentHistory).where(eq(s.incidentHistory.incidentId, inc.id))
			)
				.filter((e) => e.eventType.startsWith('sla_'))
				.sort((a, b) => a.createdAt - b.createdAt);
			assert.deepEqual(
				rows.map((e) => e.eventType),
				['sla_applied', 'sla_changed', 'sla_cleared', 'sla_applied']
			);
			const changed = rows[1];
			assert.equal(changed.actorUserId, tech.user.id);
			assert.equal(changed.payload.toPolicyId, premium.id);
			assert.ok(changed.payload.fromPolicyId, 'origen registrado');
			assert.ok(
				changed.payload.appliedAt && changed.payload.resolutionDueAt,
				'reinicio del reloj trazable'
			);
			assert.equal(rows[2].payload.toPolicyId, null);
			assert.equal(rows[0].actorUserId, customer.user.id, 'aplicada al crear por el creador');
		}
	);

	await t.test(
		'34/58. proyección segura: el Customer ve solo el tipo de los eventos SLA, sin payload',
		async () => {
			const inc = (await create(customer, A.org)).json.incident;
			await comment(tech, A.org, inc.id);
			await setStatus(tech, A.org, inc.id, 'resolved');
			const res = await history(customer, A.org, inc.id);
			assert.equal(res.status, 200);
			const types = res.json.items.map((i) => i.type);
			for (const t2 of ['sla_applied', 'sla_first_response_met', 'sla_resolution_met'])
				assert.ok(types.includes(t2), t2);
			for (const item of res.json.items.filter((i) => i.type.startsWith('sla_')))
				assert.deepEqual(Object.keys(item).sort(), ['actor', 'id', 'occurredAt', 'type']);
			const policyId = (await row(inc.id)).slaPolicyId;
			assert.ok(
				!res.text.includes(policyId) && !res.text.includes('dueAt') && !res.text.includes('Minutes')
			);
		}
	);

	// =========================================================================
	// Filtros operativos (23-26, 53)
	// =========================================================================
	await t.test('23-26/53. filtros SQL por estado SLA; tenant y alcance intactos', async () => {
		const O = await organization('Filtros');
		const adminO = await member(O.org, [O.admin]);
		const techO = await member(O.org, [O.tech]);
		const custO = await member(O.org, [O.customer]);
		const cust2O = await member(O.org, [O.customer]);
		await createSlaPolicy(db, O.org.id, {
			code: 'std',
			name: 'Std',
			firstResponseMinutes: 60,
			resolutionMinutes: 120,
			isDefault: true
		});
		const mk = async (who) => (await create(who, O.org)).json.incident.id;
		const onTrack = await mk(custO);
		const frBreached = await mk(custO);
		await backdate(frBreached, 90);
		const met = await mk(custO);
		await comment(techO, O.org, met);
		await setStatus(techO, O.org, met, 'resolved');
		const resBreached = await mk(cust2O);
		await backdate(resBreached, 30);
		await comment(techO, O.org, resBreached);
		await backdate(resBreached, 200);
		// respuesta dentro de plazo (10 min tras aplicar); la resolución sigue sin hacerse y vence
		await pg.query(
			`UPDATE incidents SET first_response_at = sla_applied_at + interval '10 minutes' WHERE id = $1`,
			[resBreached]
		);
		const noSla = (await create(adminO, O.org, { slaPolicyId: null })).json.incident.id;
		const ids = async (who, q) => {
			const r = await list(who, O.org, q);
			assert.equal(r.status, 200, r.text);
			return r.json.incidents.map((i) => i.id).sort();
		};
		const sorted = (...x) => x.sort();
		assert.deepEqual(await ids(adminO, '&slaStatus=breached'), sorted(frBreached, resBreached));
		assert.deepEqual(await ids(adminO, '&slaStatus=on_track'), [onTrack]);
		assert.deepEqual(await ids(adminO, '&slaStatus=met'), [met]);
		assert.deepEqual(await ids(adminO, '&slaStatus=not_applicable'), [noSla]);
		assert.deepEqual(await ids(adminO, '&slaFirstResponseStatus=breached'), [frBreached]);
		assert.deepEqual(await ids(adminO, '&slaFirstResponseStatus=pending'), [onTrack]);
		// frBreached (90 min) sigue dentro de su plazo de resolución (120 min): pending
		assert.deepEqual(await ids(adminO, '&slaResolutionStatus=breached'), [resBreached]);
		assert.deepEqual(
			await ids(adminO, '&slaResolutionStatus=pending'),
			sorted(onTrack, frBreached)
		);
		assert.deepEqual(await ids(adminO, '&slaResolutionStatus=met'), [met]);
		assert.deepEqual(await ids(adminO, '&slaStatus=breached&slaFirstResponseStatus=met'), [
			resBreached
		]);
		// el DTO coincide con el filtro
		for (const i of (await list(adminO, O.org, '&slaStatus=breached')).json.incidents)
			assert.equal(i.slaOverallStatus, 'breached');
		// Customer: solo sus incidencias, aunque filtre
		assert.deepEqual(await ids(custO, '&slaStatus=breached'), [frBreached]);
		assert.deepEqual(await ids(cust2O, '&slaStatus=breached'), [resBreached]);
		// view_own: solo asignadas
		const own = await member(O.org, [await rawRole(O.org, ['incidents:view_own'])]);
		await db
			.update(s.incidents)
			.set({ assignedToUserId: own.user.id })
			.where(eq(s.incidents.id, frBreached));
		assert.deepEqual(await ids(own, '&queue=mine&slaStatus=breached'), [frBreached]);
		// otro tenant nunca aparece
		assert.equal((await list(adminB, O.org, '&slaStatus=breached')).status, 403);
		const fromB = await list(adminB, B.org, '&slaStatus=breached');
		assert.equal(fromB.status, 200);
		assert.ok(!fromB.json.incidents.some((i) => [frBreached, resBreached].includes(i.id)));
		for (const q of [
			'&slaStatus=late',
			'&slaStatus=breached&slaStatus=met',
			'&slaResolutionStatus=on_track',
			'&slaFirstResponseStatus='
		])
			assert.equal((await list(adminO, O.org, q)).status, 400, q);
		assert.equal(
			(await list(custO, O.org, '&queue=all&slaStatus=breached')).status,
			403,
			'no amplía acceso'
		);
	});

	await t.test('servicio: listIncidents con now inyectado es determinista', async () => {
		const inc = (await create(customer, A.org)).json.incident;
		const before = await listIncidents(
			db,
			{ organizationId: A.org.id, now: new Date(Date.parse(inc.createdAt) + 30 * MIN) },
			{ slaFirstResponseStatus: 'pending' }
		);
		const after = await listIncidents(
			db,
			{ organizationId: A.org.id, now: new Date(Date.parse(inc.createdAt) + 61 * MIN) },
			{ slaFirstResponseStatus: 'breached' }
		);
		assert.ok(before.some((i) => i.id === inc.id));
		assert.ok(after.some((i) => i.id === inc.id));
	});

	// =========================================================================
	// Atomicidad (38) y visibilidad (28-29)
	// =========================================================================
	await t.test(
		'38. el evento SLA va en la misma transacción: si falla, la resolución se revierte',
		async () => {
			const inc = (await create(customer, A.org)).json.incident;
			await pg.exec(`
			CREATE FUNCTION test_fail_sla() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'forced'; END $$;
			CREATE TRIGGER test_fail_sla BEFORE INSERT ON incident_history
			FOR EACH ROW WHEN (NEW.event_type LIKE 'sla_resolution%') EXECUTE FUNCTION test_fail_sla();`);
			let res;
			try {
				res = await setStatus(tech, A.org, inc.id, 'resolved');
			} finally {
				await pg.exec(
					'DROP TRIGGER test_fail_sla ON incident_history; DROP FUNCTION test_fail_sla();'
				);
			}
			assert.equal(res.status, 500);
			assert.ok(!/forced|incident_history/.test(res.text));
			const r = await row(inc.id);
			assert.equal(r.status, 'open');
			assert.equal(r.firstResolvedAt, null);
			assert.ok(!(await events(inc.id)).includes('resolved'));
		}
	);

	await t.test(
		'28-29. Customer ve el cumplimiento de su incidencia sin permisos nuevos; no la ajena',
		async () => {
			const inc = (await create(customer, A.org)).json.incident;
			const mine = await detail(customer, A.org, inc.id);
			assert.equal(mine.json.incident.slaOverallStatus, 'on_track');
			assert.equal((await detail(otherCustomer, A.org, inc.id)).status, 403);
			assert.equal((await detail(adminB, A.org, inc.id)).status, 403);
			const created = await create(customer, A.org);
			for (const key of [
				'slaOverallStatus',
				'slaFirstResponseStatus',
				'slaResolutionStatus',
				'firstResolvedAt'
			])
				assert.ok(key in created.json.incident, key);
		}
	);

	await t.test('62-63. sin notificaciones, colas ni workers', () => {
		for (const dir of ['src/lib/server/services', 'src/routes/api'])
			for (const file of fs.readdirSync(dir, { recursive: true }))
				assert.ok(!/notification|webhook|worker|cron/i.test(String(file)), String(file));
		const source = fs.readFileSync('src/lib/server/services/sla-compliance.ts', 'utf8');
		assert.ok(!/setInterval|setTimeout|import /.test(source), 'función pura, sin dependencias');
	});
	// =========================================================================
	// Corrección final: dominios objective vs overall y paridad helper/SQL
	// =========================================================================
	await t.test(
		'overall: matriz completa (on_track, met, breached, not_applicable); nunca pending',
		() => {
			const base = new Date('2026-01-01T00:00:00Z');
			const at = (m) => new Date(base.getTime() + m * MIN);
			const inc = (over) => ({
				slaPolicyId: 'p',
				firstResponseDueAt: at(60),
				resolutionDueAt: at(120),
				firstResponseAt: null,
				firstResolvedAt: null,
				...over
			});
			const cases = [
				// [descripción, overrides, now, first, resolution, overall]
				['pending + pending', {}, at(10), 'pending', 'pending', 'on_track'],
				['met + pending', { firstResponseAt: at(30) }, at(90), 'met', 'pending', 'on_track'],
				['pending + met', { firstResolvedAt: at(40) }, at(50), 'pending', 'met', 'on_track'],
				[
					'met + met',
					{ firstResponseAt: at(30), firstResolvedAt: at(100) },
					at(999),
					'met',
					'met',
					'met'
				],
				['breached + pending', {}, at(90), 'breached', 'pending', 'breached'],
				[
					'breached + met',
					{ firstResponseAt: at(70), firstResolvedAt: at(100) },
					at(999),
					'breached',
					'met',
					'breached'
				],
				[
					'met + breached',
					{ firstResponseAt: at(30), firstResolvedAt: at(130) },
					at(999),
					'met',
					'breached',
					'breached'
				],
				['breached + breached', {}, at(999), 'breached', 'breached', 'breached']
			];
			for (const [label, over, now, first, resolution, overall] of cases)
				assert.deepEqual(
					computeIncidentSlaCompliance(inc(over), now),
					{
						slaOverallStatus: overall,
						slaFirstResponseStatus: first,
						slaResolutionStatus: resolution
					},
					label
				);
			assert.equal(
				computeIncidentSlaCompliance(
					{
						slaPolicyId: null,
						firstResponseDueAt: null,
						resolutionDueAt: null,
						firstResponseAt: null,
						firstResolvedAt: null
					},
					at(1)
				).slaOverallStatus,
				'not_applicable'
			);
			assert.deepEqual(
				[...compliance.SLA_OVERALL_STATUSES],
				['not_applicable', 'on_track', 'met', 'breached']
			);
			assert.deepEqual(
				[...compliance.SLA_OBJECTIVE_STATUSES],
				['not_applicable', 'pending', 'met', 'breached']
			);
			assert.ok(!compliance.SLA_OVERALL_STATUSES.includes('pending'));
			assert.ok(!compliance.SLA_OBJECTIVE_STATUSES.includes('on_track'));
		}
	);

	await t.test(
		'filtros: overall on_track funciona y pending -> 400; objetivos aceptan pending',
		async () => {
			const P = await organization('Paridad filtros');
			const adminP = await member(P.org, [P.admin]);
			await createSlaPolicy(db, P.org.id, {
				code: 'std',
				name: 'Std',
				firstResponseMinutes: 60,
				resolutionMinutes: 120,
				isDefault: true
			});
			const fresh = (await create(adminP, P.org)).json.incident.id;
			const listed = async (q) => {
				const r = await list(adminP, P.org, q);
				assert.equal(r.status, 200, q);
				return r.json.incidents.map((i) => i.id);
			};
			assert.deepEqual(await listed('&slaStatus=on_track'), [fresh]);
			assert.deepEqual(await listed('&slaFirstResponseStatus=pending'), [fresh]);
			assert.deepEqual(await listed('&slaResolutionStatus=pending'), [fresh]);
			for (const q of [
				'&slaStatus=pending',
				'&slaFirstResponseStatus=on_track',
				'&slaResolutionStatus=on_track'
			]) {
				const r = await list(adminP, P.org, q);
				assert.equal(r.status, 400, q);
				assert.equal(r.json.error.code, 'INVALID_INPUT');
			}
			await assert.rejects(
				listIncidents(db, { organizationId: P.org.id }, { slaStatus: 'pending' }),
				(e) => e.code === 'INVALID_INPUT'
			);
		}
	);

	await t.test(
		'paridad helper/SQL: cada filtro devuelve exactamente las filas cuyo DTO tiene ese estado',
		async () => {
			const Q = await organization('Paridad');
			const adminQ = await member(Q.org, [Q.admin]);
			const techQ = await member(Q.org, [Q.tech]);
			await createSlaPolicy(db, Q.org.id, {
				code: 'std',
				name: 'Std',
				firstResponseMinutes: 60,
				resolutionMinutes: 120,
				isDefault: true
			});
			const mk = async (extra) => (await create(adminQ, Q.org, extra)).json.incident.id;
			// variedad de estados: fresca, respondida, resuelta, vencidas, resuelta tarde, sin SLA
			const freshId = await mk();
			const answered = await mk();
			await comment(techQ, Q.org, answered);
			const resolvedOnly = await mk();
			await setStatus(techQ, Q.org, resolvedOnly, 'resolved');
			const bothMet = await mk();
			await comment(techQ, Q.org, bothMet);
			await setStatus(techQ, Q.org, bothMet, 'resolved');
			const frLate = await mk();
			await backdate(frLate, 90);
			const allLate = await mk();
			await backdate(allLate, 500);
			const resolvedLate = await mk();
			await backdate(resolvedLate, 300);
			await setStatus(techQ, Q.org, resolvedLate, 'resolved');
			await mk({ slaPolicyId: null });
			const now = new Date();
			const all = await listIncidents(db, { organizationId: Q.org.id, now }, {});
			const dto = new Map(all.map((i) => [i.id, compliance.withSlaCompliance(i, now)]));
			assert.equal(dto.get(freshId).slaOverallStatus, 'on_track');
			assert.equal(dto.get(answered).slaOverallStatus, 'on_track');
			assert.equal(dto.get(resolvedOnly).slaOverallStatus, 'on_track', 'pending + met');
			assert.equal(dto.get(bothMet).slaOverallStatus, 'met');
			const checks = [
				['slaStatus', 'slaOverallStatus', compliance.SLA_OVERALL_STATUSES],
				['slaFirstResponseStatus', 'slaFirstResponseStatus', compliance.SLA_OBJECTIVE_STATUSES],
				['slaResolutionStatus', 'slaResolutionStatus', compliance.SLA_OBJECTIVE_STATUSES]
			];
			for (const [filter, field, values] of checks) {
				const seen = [];
				for (const value of values) {
					const rows = await listIncidents(
						db,
						{ organizationId: Q.org.id, now },
						{ [filter]: value }
					);
					const expected = [...dto.values()]
						.filter((i) => i[field] === value)
						.map((i) => i.id)
						.sort();
					assert.deepEqual(rows.map((r) => r.id).sort(), expected, `${filter}=${value}`);
					seen.push(...expected);
				}
				assert.deepEqual(seen.sort(), [...dto.keys()].sort(), `${filter}: partición completa`);
			}
		}
	);
});

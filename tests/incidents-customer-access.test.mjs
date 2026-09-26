import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

test('SoporteFlow — Etapa 5.4S-B: acceso Customer por incidents:view_requested', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;
	const { ensureOrganizationRoles } = await server.ssrLoadModule(
		'/src/lib/server/services/roles.ts'
	);
	const incidentsService = await server.ssrLoadModule('/src/lib/server/services/incidents.ts');
	const { createIncidentRecord, incidentAccessAllows, listIncidents } = incidentsService;
	const { createInternalNote } = await server.ssrLoadModule(
		'/src/lib/server/services/incident-messages.ts'
	);
	const {
		resolveIncidentAccess,
		resolveIncidentMutationAccess,
		canAccessIncident,
		incidentAccessRestriction
	} = await server.ssrLoadModule('/src/lib/server/auth/incident-access.ts');
	const listRoute = await server.ssrLoadModule('/src/routes/api/incidents/+server.ts');
	const detailRoute = await server.ssrLoadModule('/src/routes/api/incidents/[id]/+server.ts');
	const commentsRoute = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/comments/+server.ts'
	);
	const historyRoute = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/history/+server.ts'
	);
	const notesRoute = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/internal-notes/+server.ts'
	);
	const { GET: meGET } = await server.ssrLoadModule('/src/routes/api/me/+server.ts');

	let seq = 0;
	async function organization(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'sb-' + randomUUID(), status: 'active' })
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
		const user = await createCredentialUser(f, { email: `sb-${randomUUID()}@example.test` });
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
		return { user, membership, headers: session.headers, cookie: session.cookieHeader };
	}
	async function incident(org, creator, values = {}, patch = {}) {
		const { incident: row } = await createIncidentRecord(
			db,
			{ organizationId: org.id, creatorUserId: creator.user.id },
			{
				title: 'Incidencia ' + ++seq,
				description: 'Sintética',
				client: 'Cliente texto',
				...values
			}
		);
		if (Object.keys(patch).length)
			await db.update(s.incidents).set(patch).where(eq(s.incidents.id, row.id));
		return { ...row, ...patch };
	}
	async function call(handler, { method = 'GET', path, who, query = '', params = {}, body }) {
		const url = new URL(`http://localhost${path}?${query}`);
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
			}),
			route: { id: path }
		});
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null, text };
	}
	const list = (who, org, query = '') =>
		call(listRoute.GET, { path: '/api/incidents', who, query: `organizationId=${org.id}${query}` });
	const ids = (res) => res.json.incidents.map((i) => i.id).sort();
	const detail = (who, org, id) =>
		call(detailRoute.GET, {
			path: `/api/incidents/${id}`,
			who,
			query: `organizationId=${org.id}`,
			params: { id }
		});
	const comments = (who, org, id, body) =>
		call(commentsRoute[body === undefined ? 'GET' : 'POST'], {
			method: body === undefined ? 'GET' : 'POST',
			path: `/api/incidents/${id}/comments`,
			who,
			query: `organizationId=${org.id}`,
			params: { id },
			body: body === undefined ? undefined : { body }
		});
	const notes = (who, org, id, body) =>
		call(notesRoute[body === undefined ? 'GET' : 'POST'], {
			method: body === undefined ? 'GET' : 'POST',
			path: `/api/incidents/${id}/internal-notes`,
			who,
			query: `organizationId=${org.id}`,
			params: { id },
			body: body === undefined ? undefined : { body }
		});
	const history = (who, org, id) =>
		call(historyRoute.GET, {
			path: `/api/incidents/${id}/history`,
			who,
			query: `organizationId=${org.id}`,
			params: { id }
		});
	const create = (who, extra = {}, org = A.org) =>
		call(listRoute.POST, {
			method: 'POST',
			path: '/api/incidents',
			who,
			body: {
				organizationId: org.id,
				title: 'Desde HTTP',
				description: 'Sintética',
				client: 'Cliente texto',
				...extra
			}
		});

	// ---------------------------------------------------------------------
	// Fixture
	// ---------------------------------------------------------------------
	const A = await organization('Alfa');
	const B = await organization('Beta');
	const admin = await member(A.org, [A.admin]);
	const tech = await member(A.org, [A.tech]);
	const cust1 = await member(A.org, [A.customer]);
	const cust2 = await member(A.org, [A.customer]);
	const staffOwn = await member(A.org, [await rawRole(A.org, ['incidents:view_own'])]);
	const multi = await member(A.org, [
		await rawRole(A.org, ['incidents:view_own', 'incidents:edit']),
		A.customer
	]);
	const createOnly = await member(A.org, [await rawRole(A.org, ['incidents:create'])]);
	const nobody = await member(A.org);
	const custB = await member(B.org, [B.customer]);
	const adminB = await member(B.org, [B.admin]);
	const [site] = await db
		.insert(s.sites)
		.values({ organizationId: A.org.id, name: 'Sede SB' })
		.returning();

	const own1 = await incident(A.org, tech, { clientUserId: cust1.user.id }); // técnico en su nombre
	const own1Pending = await incident(
		A.org,
		admin,
		{ clientUserId: cust1.user.id, priority: 'high', siteId: site.id },
		{ status: 'pending' }
	);
	const other = await incident(A.org, admin, { clientUserId: cust2.user.id });
	const nullClient = await incident(A.org, cust1, { clientUserId: null }); // creado por cust1, sin solicitante
	const createdForOther = await incident(A.org, cust1, { clientUserId: cust2.user.id });
	const assignedToMulti = await incident(A.org, admin, {}, { assignedToUserId: multi.user.id });
	const requestedByMulti = await incident(A.org, admin, { clientUserId: multi.user.id });
	const closedOwn = await incident(
		A.org,
		admin,
		{ clientUserId: cust1.user.id },
		{ status: 'closed' }
	);
	const foreign = await incident(B.org, adminB, { clientUserId: custB.user.id });
	const allA = [
		own1,
		own1Pending,
		other,
		nullClient,
		createdForOther,
		assignedToMulti,
		requestedByMulti,
		closedOwn
	]
		.map((i) => i.id)
		.sort();

	// =====================================================================
	// Resolución de acceso (31)
	// =====================================================================
	await t.test(
		'31. resolveIncidentAccess: view_all, view_own, view_requested, unión y ninguno',
		async () => {
			assert.deepEqual(await resolveIncidentAccess(admin.headers, A.org.id, admin.user.id), {
				viewAll: true
			});
			assert.deepEqual(await resolveIncidentAccess(tech.headers, A.org.id, tech.user.id), {
				viewAll: true
			});
			assert.deepEqual(await resolveIncidentAccess(staffOwn.headers, A.org.id, staffOwn.user.id), {
				assignedToUserId: staffOwn.user.id
			});
			assert.deepEqual(await resolveIncidentAccess(cust1.headers, A.org.id, cust1.user.id), {
				clientUserId: cust1.user.id
			});
			assert.deepEqual(await resolveIncidentAccess(multi.headers, A.org.id, multi.user.id), {
				assignedToUserId: multi.user.id,
				clientUserId: multi.user.id
			});
			assert.equal(await resolveIncidentAccess(nobody.headers, A.org.id, nobody.user.id), null);
			assert.equal(await resolveIncidentAccess(cust1.headers, B.org.id, cust1.user.id), null);
			// mutaciones: la rama de solicitante nunca amplía edición/asignación
			assert.deepEqual(
				await resolveIncidentMutationAccess(multi.headers, A.org.id, multi.user.id),
				{ assignedToUserId: multi.user.id }
			);
			assert.equal(
				await resolveIncidentMutationAccess(cust1.headers, A.org.id, cust1.user.id),
				null
			);
			assert.deepEqual(
				await resolveIncidentMutationAccess(admin.headers, A.org.id, admin.user.id),
				{ viewAll: true }
			);
		}
	);

	await t.test('31b. evaluación OR (no AND), null nunca coincide, fail-closed', () => {
		const me = randomUUID();
		const x = randomUUID();
		const both = { assignedToUserId: me, clientUserId: me };
		assert.equal(incidentAccessAllows(both, { assignedToUserId: me, clientUserId: x }), true);
		assert.equal(incidentAccessAllows(both, { assignedToUserId: x, clientUserId: me }), true);
		assert.equal(incidentAccessAllows(both, { assignedToUserId: null, clientUserId: null }), false);
		assert.equal(
			incidentAccessAllows({ clientUserId: me }, { assignedToUserId: me, clientUserId: null }),
			false,
			'view_requested no concede la rama técnica'
		);
		assert.equal(
			incidentAccessAllows({ assignedToUserId: me }, { assignedToUserId: null, clientUserId: me }),
			false,
			'view_own no concede la rama cliente'
		);
		assert.equal(incidentAccessAllows({}, { assignedToUserId: me, clientUserId: me }), false);
		assert.equal(
			incidentAccessAllows({ viewAll: true }, { assignedToUserId: null, clientUserId: null }),
			true
		);
		assert.equal(
			canAccessIncident({ clientUserId: me }, { assignedToUserId: null, clientUserId: me }),
			true
		);
		assert.deepEqual(incidentAccessRestriction({ viewAll: true }), {});
		assert.deepEqual(incidentAccessRestriction(both), both);
	});

	// =====================================================================
	// Listado (32)
	// =====================================================================
	await t.test(
		'32. Customer: sin queue ve solo sus solicitadas (SQL), nunca null/ajenas/otro tenant',
		async () => {
			const res = await list(cust1, A.org);
			assert.equal(res.status, 200);
			assert.deepEqual(ids(res), [own1.id, own1Pending.id, closedOwn.id].sort());
			for (const i of res.json.incidents) assert.equal(i.clientUserId, cust1.user.id);
			assert.ok(!ids(res).includes(nullClient.id), 'creado por él con clientUserId null: no');
			assert.ok(!ids(res).includes(createdForOther.id), 'creado por él para otro: no');
			assert.deepEqual(ids(await list(cust2, A.org)), [other.id, createdForOther.id].sort());
			assert.deepEqual(ids(await list(custB, B.org)), [foreign.id]);
			assert.equal((await list(cust1, B.org)).status, 403);
		}
	);

	await t.test('32. Customer: queues all/unassigned/mine no amplían acceso (403)', async () => {
		for (const q of ['all', 'unassigned', 'mine']) {
			const res = await list(cust1, A.org, `&queue=${q}`);
			assert.equal(res.status, 403, q);
			assert.equal(res.json.error.code, 'FORBIDDEN');
		}
		assert.equal((await list(cust1, A.org, '&queue=requested')).status, 400);
	});

	await t.test('32. Customer: filtros normales dentro de su subconjunto', async () => {
		assert.deepEqual(ids(await list(cust1, A.org, '&status=pending')), [own1Pending.id]);
		assert.deepEqual(ids(await list(cust1, A.org, '&priority=high')), [own1Pending.id]);
		assert.deepEqual(ids(await list(cust1, A.org, `&siteId=${site.id}`)), [own1Pending.id]);
		assert.deepEqual(ids(await list(cust1, A.org, '&status=closed')), [closedOwn.id]);
		// el filtro de otro cliente no existe: no se puede pedir clientUserId
		const spoof = await list(cust1, A.org, `&clientUserId=${cust2.user.id}`);
		assert.equal(spoof.status, 200);
		assert.ok(ids(spoof).every((id) => [own1.id, own1Pending.id, closedOwn.id].includes(id)));
		// status sobre incidencias ajenas: vacío
		assert.deepEqual(ids(await list(cust2, A.org, '&priority=high')), []);
	});

	await t.test('32. Admin y Technician: sin regresión (todas, queues intactas)', async () => {
		assert.deepEqual(ids(await list(admin, A.org)), allA);
		assert.deepEqual(ids(await list(admin, A.org, '&queue=all')), allA);
		assert.deepEqual(ids(await list(tech, A.org)), allA);
		assert.deepEqual(ids(await list(tech, A.org, '&queue=mine')), []);
		assert.equal((await list(tech, A.org, '&queue=unassigned')).status, 200);
		// view_own solo mantiene su contrato 5.4N-0
		assert.equal((await list(staffOwn, A.org)).status, 403);
		assert.equal((await list(staffOwn, A.org, '&queue=mine')).status, 200);
		assert.equal((await list(nobody, A.org)).status, 403);
	});

	await t.test('32/38. multi-rol view_own + view_requested: unión en el listado', async () => {
		assert.deepEqual(
			ids(await list(multi, A.org)),
			[assignedToMulti.id, requestedByMulti.id].sort()
		);
		assert.deepEqual(ids(await list(multi, A.org, '&queue=mine')), [assignedToMulti.id]);
		assert.equal((await list(multi, A.org, '&queue=all')).status, 403);
		// servicio: la condición SQL es OR y se combina con filtros por AND
		const scoped = await listIncidents(
			db,
			{
				organizationId: A.org.id,
				actorUserId: multi.user.id,
				access: { assignedToUserId: multi.user.id, clientUserId: multi.user.id }
			},
			{ status: 'open' }
		);
		assert.deepEqual(
			scoped.map((i) => i.id).sort(),
			[assignedToMulti.id, requestedByMulti.id].sort()
		);
		assert.deepEqual(
			await listIncidents(db, { organizationId: A.org.id, access: {} }, {}),
			[],
			'acceso restringido vacío -> nada'
		);
	});

	// =====================================================================
	// Detalle (33)
	// =====================================================================
	await t.test(
		'33. detalle: propia (aunque la creó un técnico) sí; ajena, null y creada-para-otro no',
		async () => {
			const ok = await detail(cust1, A.org, own1.id);
			assert.equal(ok.status, 200);
			assert.equal(ok.json.incident.id, own1.id);
			assert.equal(ok.json.incident.createdByUserId, tech.user.id);
			for (const id of [other.id, nullClient.id, createdForOther.id, assignedToMulti.id]) {
				const res = await detail(cust1, A.org, id);
				assert.equal(res.status, 403, id);
				assert.deepEqual(res.json, { error: { code: 'FORBIDDEN', message: 'Permission denied.' } });
			}
			assert.equal((await detail(cust2, A.org, createdForOther.id)).status, 200);
			assert.equal((await detail(cust1, A.org, closedOwn.id)).status, 200, 'cerrada: legible');
		}
	);

	await t.test(
		'33/21. detalle multi-tenant: incidencia de otra org indistinguible de inexistente',
		async () => {
			const foreignRes = await detail(cust1, A.org, foreign.id);
			const missing = await detail(cust1, A.org, randomUUID());
			assert.equal(foreignRes.status, 404);
			assert.deepEqual(foreignRes.json, missing.json);
			assert.equal((await detail(cust1, B.org, foreign.id)).status, 403, 'org ajena: sin acceso');
			assert.equal((await detail(custB, B.org, foreign.id)).status, 200);
		}
	);

	await t.test('38. detalle multi-rol: asignada y solicitada, sin view_all', async () => {
		assert.equal((await detail(multi, A.org, assignedToMulti.id)).status, 200);
		assert.equal((await detail(multi, A.org, requestedByMulti.id)).status, 200);
		assert.equal((await detail(multi, A.org, own1.id)).status, 403);
		assert.equal((await detail(admin, A.org, own1.id)).status, 200, 'Admin: view_all domina');
	});

	// =====================================================================
	// Comentarios (34)
	// =====================================================================
	await t.test(
		'34. comentarios: lee y escribe en la propia; hilo completo sin filtrar por autor',
		async () => {
			const staffComment = await comments(tech, A.org, own1.id, 'Hola, lo revisamos');
			assert.equal(staffComment.status, 201);
			const mine = await comments(cust1, A.org, own1.id, 'Gracias');
			assert.equal(mine.status, 201);
			const thread = await comments(cust1, A.org, own1.id);
			assert.equal(thread.status, 200);
			assert.deepEqual(
				thread.json.items.map((i) => i.body),
				['Gracias', 'Hola, lo revisamos']
			);
			assert.ok(!thread.text.includes(cust1.user.id) && !thread.text.includes('@'));
		}
	);

	await t.test(
		'34. comentarios: nunca en incidencia ajena, null, de otro tenant; cerrada 409',
		async () => {
			for (const id of [other.id, nullClient.id, createdForOther.id]) {
				assert.equal((await comments(cust1, A.org, id)).status, 403, id);
				assert.equal((await comments(cust1, A.org, id, 'intruso')).status, 403, id);
			}
			assert.equal((await comments(cust1, A.org, foreign.id)).status, 404);
			assert.equal((await comments(cust1, A.org, foreign.id, 'x')).status, 404);
			assert.equal((await comments(cust1, B.org, foreign.id, 'x')).status, 403);
			const closed = await comments(cust1, A.org, closedOwn.id, 'reabrid');
			assert.equal(closed.status, 409, 'misma política de cerradas que el personal');
			assert.equal((await comments(admin, A.org, closedOwn.id, 'x')).status, 409);
			assert.equal((await comments(cust1, A.org, closedOwn.id)).status, 200, 'cerrada: legible');
			const { rows } = await f.pg.query(
				`SELECT count(*)::int AS n FROM incident_messages WHERE body = 'intruso'`
			);
			assert.equal(rows[0].n, 0);
		}
	);

	await t.test('34. multi-rol comenta en asignada y solicitada', async () => {
		assert.equal((await comments(multi, A.org, assignedToMulti.id, 'a')).status, 201);
		assert.equal((await comments(multi, A.org, requestedByMulti.id, 'b')).status, 201);
		assert.equal((await comments(multi, A.org, own1.id, 'c')).status, 403);
	});

	// =====================================================================
	// Notas internas (35)
	// =====================================================================
	await t.test(
		'35. notas internas: Customer 403 en GET y POST, también en su propia incidencia',
		async () => {
			await createInternalNote(
				db,
				{ organizationId: A.org.id, incidentId: own1.id, actorUserId: admin.user.id },
				'Nota secreta interna'
			);
			const get = await notes(cust1, A.org, own1.id);
			const post = await notes(cust1, A.org, own1.id, 'intento');
			assert.equal(get.status, 403);
			assert.equal(post.status, 403);
			assert.ok(!get.text.includes('secreta'));
			assert.equal((await notes(multi, A.org, requestedByMulti.id)).status, 403);
			assert.equal((await notes(admin, A.org, own1.id)).status, 200);
			const thread = await comments(cust1, A.org, own1.id);
			assert.ok(!thread.text.includes('secreta'), 'las notas no se filtran a los comentarios');
		}
	);

	// =====================================================================
	// Historial (36)
	// =====================================================================
	await t.test(
		'36. historial: seguro en la propia; ajena 404; internal_note_added nunca',
		async () => {
			const res = await history(cust1, A.org, own1.id);
			assert.equal(res.status, 200);
			const types = res.json.items.map((i) => i.type);
			assert.ok(types.includes('created'));
			assert.ok(!types.includes('internal_note_added'));
			assert.ok(!res.text.includes('secreta') && !res.text.includes(admin.user.id));
			for (const id of [other.id, nullClient.id, createdForOther.id]) {
				const denied = await history(cust1, A.org, id);
				assert.equal(denied.status, 404, id);
			}
			const foreignRes = await history(cust1, A.org, foreign.id);
			const missing = await history(cust1, A.org, randomUUID());
			assert.equal(foreignRes.status, 404);
			assert.deepEqual(foreignRes.json, missing.json);
			assert.equal((await history(multi, A.org, requestedByMulti.id)).status, 200);
			assert.equal((await history(multi, A.org, assignedToMulti.id)).status, 200);
			assert.equal((await history(nobody, A.org, own1.id)).status, 403);
		}
	);

	// =====================================================================
	// Mutaciones: view_requested nunca amplía edición
	// =====================================================================
	await t.test(
		'mutaciones: Customer sin edit; multi-rol con edit no edita la solicitada',
		async () => {
			const patch = (who, id, body) =>
				call(detailRoute.PATCH, {
					method: 'PATCH',
					path: `/api/incidents/${id}`,
					who,
					query: `organizationId=${A.org.id}`,
					params: { id },
					body
				});
			assert.equal((await patch(cust1, own1.id, { priority: 'low' })).status, 403);
			assert.equal((await patch(multi, requestedByMulti.id, { priority: 'low' })).status, 403);
			assert.equal((await patch(multi, assignedToMulti.id, { priority: 'low' })).status, 200);
			const [row] = await db
				.select()
				.from(s.incidents)
				.where(eq(s.incidents.id, requestedByMulti.id));
			assert.equal(row.priority, 'medium');
		}
	);

	// =====================================================================
	// Creación (37)
	// =====================================================================
	await t.test(
		'37. Customer crea: createdBy y clientUserId = principal; spoof rechazado',
		async () => {
			const res = await create(cust1);
			assert.equal(res.status, 201);
			assert.equal(res.json.incident.createdByUserId, cust1.user.id);
			assert.equal(res.json.incident.clientUserId, cust1.user.id);
			assert.equal((await detail(cust1, A.org, res.json.incident.id)).status, 200);
			const self = await create(cust1, { clientUserId: cust1.user.id });
			assert.equal(self.status, 201);
			const asNull = await create(cust1, { clientUserId: null });
			assert.equal(asNull.json.incident.clientUserId, cust1.user.id);
			const before = (await db.select().from(s.incidents)).length;
			const spoof = await create(cust1, { clientUserId: cust2.user.id });
			assert.equal(spoof.status, 403);
			assert.deepEqual(spoof.json, { error: { code: 'FORBIDDEN', message: 'Permission denied.' } });
			assert.equal((await db.select().from(s.incidents)).length, before, 'nada creado');
			assert.equal((await create(cust1, { clientUserId: custB.user.id })).status, 403);
		}
	);

	await t.test(
		'37. creación por capability, no por rol: create-only también crea para sí',
		async () => {
			const res = await create(createOnly);
			assert.equal(res.status, 201);
			assert.equal(res.json.incident.clientUserId, createOnly.user.id);
			assert.equal((await create(createOnly, { clientUserId: cust1.user.id })).status, 403);
			// view_all (personal) conserva el flujo en nombre de un cliente
			const onBehalf = await create(tech, { clientUserId: cust1.user.id });
			assert.equal(onBehalf.status, 201);
			assert.equal(onBehalf.json.incident.clientUserId, cust1.user.id);
			assert.equal(onBehalf.json.incident.createdByUserId, tech.user.id);
			assert.equal((await detail(cust1, A.org, onBehalf.json.incident.id)).status, 200);
			const noClient = await create(admin);
			assert.equal(noClient.json.incident.clientUserId, null, 'personal sin solicitante: null');
			assert.equal((await create(nobody)).status, 403);
		}
	);

	// =====================================================================
	// /api/me (39)
	// =====================================================================
	await t.test('39. /api/me: capabilities exactas de Customer, sin administración', async () => {
		const url = new URL(`http://localhost/api/me?organizationId=${A.org.id}`);
		const response = await meGET({
			url,
			request: new Request(url, { headers: { cookie: cust1.cookie } })
		});
		const body = await response.json();
		assert.deepEqual(body.activeOrganization.capabilities, [
			'incidents:create',
			'incidents:view_requested',
			'incidents:add_comment',
			'sites:view',
			'categories:view'
		]);
	});

	// =====================================================================
	// Errores seguros (40)
	// =====================================================================
	await t.test('40. errores seguros: sin SQL, stack, ids ni emails ajenos', async () => {
		const responses = [
			await detail(cust1, A.org, other.id),
			await detail(cust1, A.org, foreign.id),
			await comments(cust1, A.org, other.id, 'x'),
			await history(cust1, A.org, other.id),
			await notes(cust1, A.org, own1.id),
			await create(cust1, { clientUserId: cust2.user.id }),
			await list(cust1, A.org, '&queue=all')
		];
		for (const r of responses) {
			assert.deepEqual(Object.keys(r.json), ['error']);
			for (const leak of [
				'select',
				'client_user_id',
				'constraint',
				'stack',
				'@example',
				cust2.user.id
			])
				assert.ok(!r.text.toLowerCase().includes(leak.toLowerCase()), leak);
		}
	});
});

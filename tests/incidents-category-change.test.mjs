import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import {
	fixture,
	directory,
	expectedMigrations,
	createCredentialUser,
	createSession,
	createTamperedCookie,
	grantPermission
} from './helpers/auth-fixture.mjs';
import { applyMigrations } from './helpers/persistence-migrations.mjs';

function errorCode(error) {
	return error?.code ?? error?.cause?.code;
}

test('SoporteFlow — Etapa 5.4P-C: categorías reales en incidencias', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, pg, server } = f;
	const service = await server.ssrLoadModule('/src/lib/server/services/incidents.ts');
	const {
		changeIncidentCategory,
		createIncidentRecord,
		listIncidents,
		getIncidentById,
		IncidentServiceError
	} = service;
	const { setCategoryActive } = await server.ssrLoadModule(
		'/src/lib/server/services/categories.ts'
	);
	const collectionRoute = await server.ssrLoadModule('/src/routes/api/incidents/+server.ts');
	const detailRoute = await server.ssrLoadModule('/src/routes/api/incidents/[id]/+server.ts');
	const categoryRoute = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/category/+server.ts'
	);
	const historyRoute = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/history/+server.ts'
	);

	async function rejectsWith(operation, code) {
		await assert.rejects(operation, (error) => {
			assert.ok(error instanceof IncidentServiceError, `esperado IncidentServiceError: ${error}`);
			assert.equal(error.code, code);
			return true;
		});
	}

	const [orgA, orgB] = await db
		.insert(s.organizations)
		.values([
			{ name: 'Cat inc A', slug: randomUUID(), status: 'active' },
			{ name: 'Cat inc B', slug: randomUUID(), status: 'active' }
		])
		.returning();

	async function actor(organization, permissions) {
		const user = await createCredentialUser(f);
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: organization.id, userId: user.id })
			.returning();
		for (const permissionId of permissions)
			await grantPermission(f, {
				organizationId: organization.id,
				membershipId: membership.id,
				permissionId
			});
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, cookie: session.cookieHeader };
	}

	const editor = await actor(orgA, ['incidents:edit', 'incidents:view_all', 'incidents:create']);
	const editOwn = await actor(orgA, ['incidents:edit', 'incidents:view_own']);
	const otherTech = await actor(orgA, ['incidents:view_own']);
	const editNone = await actor(orgA, ['incidents:edit']);
	const viewer = await actor(orgA, ['incidents:view_all']);
	const catalogManager = await actor(orgA, [
		'categories:manage',
		'categories:view',
		'incidents:view_all'
	]);
	const editorB = await actor(orgB, ['incidents:edit', 'incidents:view_all', 'incidents:create']);

	async function category(organization, name, active = true) {
		const [row] = await db
			.insert(s.categories)
			.values({ organizationId: organization.id, name, active })
			.returning();
		return row;
	}
	const hardware = await category(orgA, 'Hardware');
	const software = await category(orgA, 'Software');
	const retired = await category(orgA, 'Retirada', false);
	const categoryB = await category(orgB, 'Hardware');

	async function incident(values = {}, organization = orgA) {
		const creator = organization.id === orgA.id ? editor : editorB;
		return (
			await createIncidentRecord(
				db,
				{ organizationId: organization.id, creatorUserId: creator.user.id },
				{ title: 'Con categoría', description: 'Desc', client: 'Cliente', ...values }
			)
		).incident;
	}
	async function categoryEvents(target) {
		return db
			.select()
			.from(s.incidentHistory)
			.where(
				and(
					eq(s.incidentHistory.incidentId, target.id),
					eq(s.incidentHistory.eventType, 'category_changed')
				)
			);
	}
	async function snapshot(target) {
		const [row] = await db.select().from(s.incidents).where(eq(s.incidents.id, target.id));
		const history = await db
			.select()
			.from(s.incidentHistory)
			.where(eq(s.incidentHistory.incidentId, target.id));
		return { row, historyCount: history.length };
	}

	async function http(
		route,
		method,
		{
			path = '',
			id,
			organizationId = orgA.id,
			cookie = editor.cookie,
			query = '',
			body,
			headers: extra
		} = {}
	) {
		const base = id === undefined ? '/api/incidents' : `/api/incidents/${id}${path}`;
		const url = new URL(`http://localhost${base}?organizationId=${organizationId}${query}`);
		const headers = new Headers(extra);
		if (cookie) headers.set('cookie', cookie);
		const init = { method, headers };
		if (body !== undefined) {
			headers.set('content-type', 'application/json');
			init.body = JSON.stringify(body);
		}
		const response = await route[method]({
			url,
			params: id === undefined ? {} : { id },
			request: new Request(url, init)
		});
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null, text };
	}
	const change = (target, body, options = {}) =>
		http(categoryRoute, 'PATCH', { id: target.id, path: '/category', body, ...options });

	// =========================================================================
	// Schema / migración
	// =========================================================================
	await t.test(
		'schema: category_id nullable, FK compuesta RESTRICT, índice, CHECK y 0010',
		async () => {
			const clean = new PGlite();
			try {
				const applied = await applyMigrations(clean, directory);
				assert.deepEqual(applied, expectedMigrations);
				assert.ok(applied.includes('0010_odd_angel.sql'));
			} finally {
				await clean.close();
			}
			const column = await pg.query(
				`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'incidents' AND column_name = 'category_id'`
			);
			assert.deepEqual(column.rows, [{ data_type: 'uuid', is_nullable: 'YES' }]);
			const fk = await pg.query(
				`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'incidents_category_org_fk'`
			);
			assert.match(
				fk.rows[0].def,
				/FOREIGN KEY \(category_id, organization_id\) REFERENCES categories\(id, organization_id\) ON DELETE RESTRICT/
			);
			const index = await pg.query(
				`SELECT indexdef FROM pg_indexes WHERE indexname = 'incidents_org_category_idx'`
			);
			assert.match(index.rows[0].indexdef, /\(organization_id, category_id\)/);
			const check = await pg.query(
				`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'incident_history_event_type_check'`
			);
			assert.match(check.rows[0].def, /'category_changed'/);
			assert.match(check.rows[0].def, /'reclassified'/);
			// la FK impide referencias cross-tenant e inexistentes a nivel de base de datos
			const target = await incident();
			for (const categoryId of [categoryB.id, randomUUID()])
				await assert.rejects(
					db.update(s.incidents).set({ categoryId }).where(eq(s.incidents.id, target.id)),
					(e) => errorCode(e) === '23503'
				);
			// RESTRICT: una categoría referenciada no se puede borrar
			await db
				.update(s.incidents)
				.set({ categoryId: hardware.id })
				.where(eq(s.incidents.id, target.id));
			await assert.rejects(db.delete(s.categories).where(eq(s.categories.id, hardware.id)), (e) =>
				['23001', '23503'].includes(errorCode(e))
			);
		}
	);

	// =========================================================================
	// Creación
	// =========================================================================
	await t.test(
		'1-6. crear sin/null/activa y categoryId en respuesta, detalle y listado',
		async () => {
			assert.equal((await incident()).categoryId, null);
			assert.equal((await incident({ categoryId: null })).categoryId, null);
			const res = await http(collectionRoute, 'POST', {
				organizationId: '',
				body: {
					organizationId: orgA.id,
					title: 'API',
					description: 'Desc',
					client: 'C',
					categoryId: hardware.id
				}
			});
			assert.equal(res.status, 201, res.text);
			assert.equal(res.json.incident.categoryId, hardware.id);
			assert.ok(!('history' in res.json));
			const detail = await http(detailRoute, 'GET', { id: res.json.incident.id });
			assert.equal(detail.json.incident.categoryId, hardware.id);
			const list = await http(collectionRoute, 'GET', {});
			assert.equal(
				list.json.incidents.find((i) => i.id === res.json.incident.id).categoryId,
				hardware.id
			);
			assert.ok(list.json.incidents.every((i) => 'categoryId' in i));
			const service = await getIncidentById(db, { organizationId: orgA.id }, res.json.incident.id);
			assert.equal(service.incident.categoryId, hardware.id);
		}
	);

	await t.test(
		'7-12. crear con categoría inexistente, ajena o inactiva; campos prohibidos',
		async () => {
			const before = (
				await db.select().from(s.incidents).where(eq(s.incidents.organizationId, orgA.id))
			).length;
			await rejectsWith(incident({ categoryId: randomUUID() }), 'CATEGORY_NOT_FOUND');
			await rejectsWith(incident({ categoryId: categoryB.id }), 'CATEGORY_NOT_FOUND');
			await rejectsWith(incident({ categoryId: retired.id }), 'CATEGORY_INACTIVE');
			await rejectsWith(incident({ categoryId: 'nope' }), 'INVALID_INPUT');
			const post = (extra) =>
				http(collectionRoute, 'POST', {
					organizationId: '',
					body: {
						organizationId: orgA.id,
						title: 'API',
						description: 'Desc',
						client: 'C',
						...extra
					}
				});
			for (const [categoryId, status, code] of [
				[randomUUID(), 404, 'CATEGORY_NOT_FOUND'],
				[categoryB.id, 404, 'CATEGORY_NOT_FOUND'],
				[retired.id, 409, 'CATEGORY_INACTIVE'],
				['nope', 400, 'INVALID_INPUT']
			]) {
				const res = await post({ categoryId });
				assert.equal(res.status, status);
				assert.equal(res.json.error.code, code);
				assert.ok(!res.text.includes(orgB.id) && !res.text.includes('23503'));
			}
			for (const key of [
				'categoryName',
				'category',
				'subcategoryId',
				'classification',
				'routing',
				'defaultTeamId',
				'impact',
				'criticality'
			])
				assert.equal((await post({ [key]: 'x' })).status, 400, key);
			const after = (
				await db.select().from(s.incidents).where(eq(s.incidents.organizationId, orgA.id))
			).length;
			assert.equal(after, before, 'ninguna incidencia parcial');
			const orphans = await pg.query(
				`SELECT count(*)::int AS n FROM incident_history h WHERE NOT EXISTS (SELECT 1 FROM incidents i WHERE i.id = h.incident_id)`
			);
			assert.equal(orphans.rows[0].n, 0);
		}
	);

	await t.test('10. rollback: fallo en history al crear no deja la incidencia', async () => {
		const before = (await db.select().from(s.incidents)).length;
		await pg.exec(`
			CREATE FUNCTION test_fail_created() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'forced'; END $$;
			CREATE TRIGGER test_fail_created BEFORE INSERT ON incident_history
			FOR EACH ROW EXECUTE FUNCTION test_fail_created();`);
		try {
			await assert.rejects(incident({ categoryId: hardware.id }));
		} finally {
			await pg.exec(
				'DROP TRIGGER test_fail_created ON incident_history; DROP FUNCTION test_fail_created();'
			);
		}
		assert.equal((await db.select().from(s.incidents)).length, before);
	});

	// =========================================================================
	// Filtro
	// =========================================================================
	await t.test(
		'13-20. filtro categoryId: por categoría, inválido, duplicado, cross-tenant, inactiva y queue',
		async () => {
			const orgF = (
				await db
					.insert(s.organizations)
					.values({ name: 'Filtro', slug: randomUUID(), status: 'active' })
					.returning()
			)[0];
			const who = await actor(orgF, ['incidents:view_all', 'incidents:view_own']);
			const [catA, catB2] = await db
				.insert(s.categories)
				.values([
					{ organizationId: orgF.id, name: 'A' },
					{ organizationId: orgF.id, name: 'B' }
				])
				.returning();
			const make = (categoryId, extra = {}) =>
				createIncidentRecord(
					db,
					{ organizationId: orgF.id, creatorUserId: who.user.id },
					{ title: 'F', description: 'F', client: 'F', categoryId, ...extra }
				).then((r) => r.incident);
			const a1 = await make(catA.id);
			const a2 = await make(catA.id);
			const b1 = await make(catB2.id);
			const none = await make(null);
			const mineA = await make(catA.id);
			await db
				.update(s.incidents)
				.set({ assignedToUserId: who.user.id })
				.where(eq(s.incidents.id, mineA.id));
			const get = (query) =>
				http(collectionRoute, 'GET', { organizationId: orgF.id, cookie: who.cookie, query });
			const ids = (res) => res.json.incidents.map((i) => i.id).sort();

			assert.deepEqual(ids(await get('')), [a1.id, a2.id, b1.id, none.id, mineA.id].sort());
			assert.deepEqual(ids(await get('&categoryId=' + catA.id)), [a1.id, a2.id, mineA.id].sort());
			assert.deepEqual(ids(await get('&categoryId=' + catB2.id)), [b1.id]);
			for (const query of [
				'&categoryId=nope',
				'&categoryId=',
				`&categoryId=${catA.id}&categoryId=${catB2.id}`,
				'&categoryId=' + catA.id + '&categoryId=' + catA.id
			])
				assert.equal((await get(query)).status, 400, query);
			// cross-tenant: categoría de otra org -> 0 filas, sin revelar nada
			const foreign = await get('&categoryId=' + hardware.id);
			assert.equal(foreign.status, 200);
			assert.deepEqual(foreign.json.incidents, []);
			assert.deepEqual((await get('&categoryId=' + randomUUID())).json.incidents, []);
			// 19. categoría inactiva histórica sigue filtrable
			await setCategoryActive(db, orgF.id, catA.id, false);
			assert.deepEqual(ids(await get('&categoryId=' + catA.id)), [a1.id, a2.id, mineA.id].sort());
			// 20. combina con queue
			assert.deepEqual(ids(await get('&queue=mine&categoryId=' + catA.id)), [mineA.id]);
			assert.deepEqual(
				ids(await get('&queue=unassigned&categoryId=' + catA.id)),
				[a1.id, a2.id].sort()
			);
			// servicio
			assert.equal(
				(await listIncidents(db, { organizationId: orgF.id }, { categoryId: catB2.id })).length,
				1
			);
			await rejectsWith(
				listIncidents(db, { organizationId: orgF.id }, { categoryId: 'x' }),
				'INVALID_INPUT'
			);
		}
	);

	// =========================================================================
	// Cambio de categoría (servicio)
	// =========================================================================
	const ctx = (who = editor, access = {}) => ({
		organizationId: orgA.id,
		actorUserId: who.user.id,
		access
	});

	await t.test('21-26, 31, 37, 39. null -> A con razón opcional; history mínimo', async () => {
		for (const reason of [undefined, '', 'Primera categoría']) {
			const target = await incident();
			const result = await changeIncidentCategory(db, ctx(), target.id, {
				categoryId: hardware.id,
				...(reason === undefined ? {} : { reason })
			});
			assert.equal(result.incident.categoryId, hardware.id);
			const [event] = await categoryEvents(target);
			assert.deepEqual(event.payload, { fromCategoryId: null, toCategoryId: hardware.id });
			assert.deepEqual(Object.keys(event.payload).sort(), ['fromCategoryId', 'toCategoryId']);
			assert.equal(event.actorUserId, editor.user.id);
			assert.equal(event.comment, null);
			assert.equal(event.reason, reason?.trim() ? reason : null);
			assert.ok(!JSON.stringify(event.payload).includes('Hardware'));
		}
	});

	await t.test('22-23, 32-36. A -> B y A -> null exigen razón válida', async () => {
		const target = await incident({ categoryId: hardware.id });
		for (const reason of [undefined, '', '   '])
			for (const categoryId of [software.id, null])
				await rejectsWith(
					changeIncidentCategory(db, ctx(), target.id, { categoryId, reason }),
					'INVALID_INPUT'
				);
		for (const reason of ['x'.repeat(1001), 'a\u0000b', 5])
			await rejectsWith(
				changeIncidentCategory(db, ctx(), target.id, { categoryId: software.id, reason }),
				'INVALID_INPUT'
			);
		assert.equal((await categoryEvents(target)).length, 0);
		await changeIncidentCategory(db, ctx(), target.id, {
			categoryId: software.id,
			reason: ' Reclasificación manual '
		});
		await changeIncidentCategory(db, ctx(), target.id, {
			categoryId: null,
			reason: 'Sin categoría'
		});
		const events = (await categoryEvents(target)).sort((a, b) => a.createdAt - b.createdAt);
		assert.deepEqual(
			events.map((e) => [e.payload, e.reason]),
			[
				[{ fromCategoryId: hardware.id, toCategoryId: software.id }, 'Reclasificación manual'],
				[{ fromCategoryId: software.id, toCategoryId: null }, 'Sin categoría']
			]
		);
		// nunca se escribe reclassified
		const reclassified = await pg.query(
			`SELECT count(*)::int AS n FROM incident_history WHERE event_type = 'reclassified'`
		);
		assert.equal(reclassified.rows[0].n, 0);
	});

	await t.test('24-25, 38. no-op null -> null y A -> A sin history ni updatedAt', async () => {
		for (const [values, categoryId] of [
			[{}, null],
			[{ categoryId: hardware.id }, hardware.id]
		]) {
			const target = await incident(values);
			const before = await snapshot(target);
			const result = await changeIncidentCategory(db, ctx(), target.id, { categoryId });
			assert.equal(result.history, undefined);
			assert.deepEqual(await snapshot(target), before);
		}
	});

	await t.test('27-30. categoría inactiva, inexistente, ajena e incidencia ajena', async () => {
		const target = await incident();
		await rejectsWith(
			changeIncidentCategory(db, ctx(), target.id, { categoryId: retired.id }),
			'CATEGORY_INACTIVE'
		);
		for (const categoryId of [randomUUID(), categoryB.id]) {
			await assert.rejects(changeIncidentCategory(db, ctx(), target.id, { categoryId }), (e) => {
				assert.equal(e.code, 'CATEGORY_NOT_FOUND');
				assert.equal(e.message, 'Category not found');
				return true;
			});
		}
		const targetB = await incident({}, orgB);
		await rejectsWith(
			changeIncidentCategory(db, ctx(), targetB.id, { categoryId: hardware.id }),
			'INCIDENT_NOT_FOUND'
		);
		assert.equal((await categoryEvents(target)).length, 0);
	});

	await t.test(
		'23. categoría desactivada después: histórica legible, quitable y no reasignable',
		async () => {
			const temp = await category(orgA, 'Temporal');
			const target = await incident({ categoryId: temp.id });
			await setCategoryActive(db, orgA.id, temp.id, false);
			assert.equal(
				(await getIncidentById(db, { organizationId: orgA.id }, target.id)).incident.categoryId,
				temp.id
			);
			const other = await incident();
			await rejectsWith(
				changeIncidentCategory(db, ctx(), other.id, { categoryId: temp.id }),
				'CATEGORY_INACTIVE'
			);
			await rejectsWith(incident({ categoryId: temp.id }), 'CATEGORY_INACTIVE');
			// A -> A con A inactiva es no-op (no revalida)
			assert.equal(
				(await changeIncidentCategory(db, ctx(), target.id, { categoryId: temp.id })).history,
				undefined
			);
			assert.equal(
				(
					await changeIncidentCategory(db, ctx(), target.id, {
						categoryId: software.id,
						reason: 'Cambio'
					})
				).incident.categoryId,
				software.id
			);
			const second = await db
				.update(s.incidents)
				.set({ categoryId: temp.id })
				.where(eq(s.incidents.id, other.id))
				.returning();
			assert.equal(
				(
					await changeIncidentCategory(db, ctx(), second[0].id, {
						categoryId: null,
						reason: 'Retirada'
					})
				).incident.categoryId,
				null
			);
		}
	);

	await t.test('40. rollback si falla el history', async () => {
		const target = await incident({ categoryId: hardware.id });
		await pg.exec(`
			CREATE FUNCTION test_fail_cat() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'forced'; END $$;
			CREATE TRIGGER test_fail_cat BEFORE INSERT ON incident_history
			FOR EACH ROW WHEN (NEW.event_type = 'category_changed') EXECUTE FUNCTION test_fail_cat();`);
		try {
			await assert.rejects(
				changeIncidentCategory(db, ctx(), target.id, { categoryId: software.id, reason: 'x' })
			);
		} finally {
			await pg.exec(
				'DROP TRIGGER test_fail_cat ON incident_history; DROP FUNCTION test_fail_cat();'
			);
		}
		assert.equal((await snapshot(target)).row.categoryId, hardware.id);
		assert.equal((await categoryEvents(target)).length, 0);
	});

	// =========================================================================
	// API: closed, autorización, spoofing
	// =========================================================================
	await t.test('41-42. closed -> 409 (también con el mismo valor)', async () => {
		for (const [values, body] of [
			[{}, { categoryId: hardware.id }],
			[{ categoryId: hardware.id }, { categoryId: hardware.id }],
			[{}, { categoryId: null }]
		]) {
			const target = await incident(values);
			await db.update(s.incidents).set({ status: 'closed' }).where(eq(s.incidents.id, target.id));
			const before = await snapshot(target);
			const res = await change(target, body);
			assert.equal(res.status, 409);
			assert.deepEqual(res.json, {
				error: { code: 'INCIDENT_CLOSED', message: 'La incidencia está cerrada.' }
			});
			assert.deepEqual(await snapshot(target), before);
		}
	});

	await t.test('43-47. matriz edit + view', async () => {
		const ok = await change(await incident(), { categoryId: hardware.id });
		assert.equal(ok.status, 200);
		assert.deepEqual(Object.keys(ok.json), ['incident']);
		assert.equal(ok.json.incident.categoryId, hardware.id);
		const own = await incident();
		await db
			.update(s.incidents)
			.set({ assignedToUserId: editOwn.user.id })
			.where(eq(s.incidents.id, own.id));
		assert.equal(
			(await change(own, { categoryId: hardware.id }, { cookie: editOwn.cookie })).status,
			200
		);
		for (const [who, assignee] of [
			[editOwn, otherTech.user.id],
			[editOwn, null],
			[editNone, null],
			[viewer, null],
			[catalogManager, null]
		]) {
			const target = await incident();
			if (assignee)
				await db
					.update(s.incidents)
					.set({ assignedToUserId: assignee })
					.where(eq(s.incidents.id, target.id));
			const before = await snapshot(target);
			const res = await change(target, { categoryId: hardware.id }, { cookie: who.cookie });
			assert.equal(res.status, 403);
			assert.deepEqual(await snapshot(target), before);
		}
		for (const cookie of ['', createTamperedCookie()])
			assert.equal(
				(await change(await incident(), { categoryId: hardware.id }, { cookie })).status,
				401
			);
	});

	await t.test('API 404/409/400 y mass assignment', async () => {
		const target = await incident();
		for (const categoryId of [randomUUID(), categoryB.id]) {
			const res = await change(target, { categoryId });
			assert.equal(res.status, 404);
			assert.deepEqual(res.json, {
				error: { code: 'CATEGORY_NOT_FOUND', message: 'Category not found.' }
			});
			assert.ok(!res.text.includes(orgB.id) && !res.text.includes('Hardware'));
		}
		assert.equal((await change(target, { categoryId: retired.id })).status, 409);
		for (const id of [randomUUID(), (await incident({}, orgB)).id]) {
			const res = await http(categoryRoute, 'PATCH', {
				id,
				path: '/category',
				body: { categoryId: hardware.id }
			});
			assert.equal(res.status, 404);
			assert.equal(res.json.error.code, 'INCIDENT_NOT_FOUND');
		}
		for (const body of [
			{},
			{ reason: 'x' },
			{ categoryId: 'nope' },
			{ categoryId: 5 },
			{ categoryId: hardware.id, reason: 5 },
			...[
				'organizationId',
				'actorUserId',
				'categoryName',
				'eventType',
				'classification',
				'subcategoryId',
				'priority',
				'routing'
			].map((k) => ({ categoryId: hardware.id, [k]: 'x' }))
		]) {
			const res = await change(target, body);
			assert.equal(res.status, 400, JSON.stringify(body));
		}
		assert.equal(
			(await change(target, { categoryId: hardware.id }, { query: '&categoryId=' + software.id }))
				.status,
			400
		);
		assert.equal((await snapshot(target)).row.categoryId, null);
	});

	await t.test('48-50. spoofing de tenant/identidad y 500 seguro', async () => {
		const target = await incident();
		const spoof = { 'x-user-id': viewer.user.id, 'x-organization-id': orgB.id };
		assert.equal(
			(await change(target, { categoryId: hardware.id }, { headers: spoof })).status,
			200
		);
		const [event] = await categoryEvents(target);
		assert.equal(event.actorUserId, editor.user.id);
		assert.equal(event.organizationId, orgA.id);
		assert.equal(
			(await change(target, { categoryId: null }, { cookie: '', headers: spoof })).status,
			401
		);
		// org B manipulada con sesión de A -> 403
		assert.equal(
			(await change(target, { categoryId: null, reason: 'x' }, { organizationId: orgB.id })).status,
			403
		);
		await pg.exec(`
			CREATE FUNCTION test_boom_cat() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'SECRET-DETAIL /srv/x.sql'; END $$;
			CREATE TRIGGER test_boom_cat BEFORE UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION test_boom_cat();`);
		let boom;
		try {
			boom = await change(target, { categoryId: software.id, reason: 'x' });
		} finally {
			await pg.exec('DROP TRIGGER test_boom_cat ON incidents; DROP FUNCTION test_boom_cat();');
		}
		assert.equal(boom.status, 500);
		assert.deepEqual(boom.json, {
			error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' }
		});
		assert.ok(!boom.text.includes('SECRET'));
		assert.equal((await snapshot(target)).row.categoryId, hardware.id);
	});

	await t.test(
		'history seguro: category_changed visible solo como changes.categoryChanged',
		async () => {
			const target = await incident();
			await change(target, { categoryId: hardware.id });
			await change(target, { categoryId: software.id, reason: 'MOTIVO-PRIVADO' });
			const res = await http(historyRoute, 'GET', { id: target.id, path: '/history' });
			assert.equal(res.status, 200);
			const items = res.json.items.filter((i) => i.type === 'category_changed');
			assert.equal(items.length, 2);
			for (const item of items) assert.deepEqual(item.changes, { categoryChanged: true });
			for (const hidden of [
				hardware.id,
				software.id,
				'fromCategoryId',
				'toCategoryId',
				'MOTIVO-PRIVADO',
				'Hardware',
				'payload'
			])
				assert.ok(!res.text.includes(hidden), hidden);
		}
	);

	// =========================================================================
	// Locks (verificación estática: PGlite es de una sola conexión)
	// =========================================================================
	await t.test(
		'SQL: create y change bloquean la categoría FOR SHARE por id + org; incidencia FOR UPDATE',
		async () => {
			const target = await incident();
			const queries = [];
			const logged = drizzle(pg, { schema: s, logger: { logQuery: (q) => queries.push(q) } });
			const original = pg.transaction.bind(pg);
			pg.transaction = async (fn) => {
				queries.push('begin');
				try {
					return await original(fn);
				} finally {
					queries.push('commit');
				}
			};
			try {
				await createIncidentRecord(
					logged,
					{ organizationId: orgA.id, creatorUserId: editor.user.id },
					{ title: 'L', description: 'L', client: 'L', categoryId: hardware.id }
				);
				await changeIncidentCategory(logged, ctx(), target.id, { categoryId: software.id });
			} finally {
				pg.transaction = original;
			}
			const blocks = [];
			let current = null;
			for (const q of queries.map((x) => x.toLowerCase())) {
				if (q === 'begin') current = [];
				else if (q === 'commit') {
					blocks.push(current);
					current = null;
				} else if (current) current.push(q);
			}
			assert.equal(blocks.length, 2);
			for (const [name, tx, write] of [
				['create', blocks[0], 'insert into "incidents"'],
				['change', blocks[1], 'update "incidents"']
			]) {
				const lock = tx.findIndex((q) => q.includes('from "categories"'));
				assert.ok(lock >= 0, name);
				assert.match(
					tx[lock],
					/"categories"\."id" = \$\d+ and "categories"\."organization_id" = \$\d+/
				);
				assert.match(tx[lock], /for share/);
				assert.ok(tx.findIndex((q) => q.startsWith(write)) > lock, `${name}: escribe tras el lock`);
			}
			const incidentLock = blocks[1].findIndex(
				(q) => q.includes('from "incidents"') && q.includes('for update')
			);
			const categoryLock = blocks[1].findIndex((q) => q.includes('from "categories"'));
			assert.ok(incidentLock >= 0 && incidentLock < categoryLock, 'orden: incidencia -> categoría');
			for (const q of queries.filter((x) => x.toLowerCase().includes('from "categories"')))
				assert.match(q.toLowerCase(), /"organization_id"/);
		}
	);
});

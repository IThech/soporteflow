import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import {
	fixture,
	createCredentialUser,
	createSession,
	createTamperedCookie,
	grantPermission
} from './helpers/auth-fixture.mjs';

test('SoporteFlow — Etapa 5.4O-C: cambio de sede de incidencias', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, pg, server } = f;
	const service = await server.ssrLoadModule('/src/lib/server/services/incidents.ts');
	const { changeIncidentSite, createIncidentRecord, getIncidentById, IncidentServiceError } =
		service;
	const { setSiteActive } = await server.ssrLoadModule('/src/lib/server/services/sites.ts');
	const route = await server.ssrLoadModule('/src/routes/api/incidents/[id]/site/+server.ts');
	const { GET: historyGET } = await server.ssrLoadModule(
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
			{ name: 'Site change A', slug: randomUUID(), status: 'active' },
			{ name: 'Site change B', slug: randomUUID(), status: 'active' }
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

	const editor = await actor(orgA, ['incidents:edit', 'incidents:view_all']);
	const viewer = await actor(orgA, ['incidents:view_all', 'incidents:view_own']);
	const siteManager = await actor(orgA, ['sites:manage', 'sites:view']);
	const editorB = await actor(orgB, ['incidents:edit', 'incidents:view_all']);

	async function site(organization, name, active = true) {
		const [row] = await db
			.insert(s.sites)
			.values({ organizationId: organization.id, name, active })
			.returning();
		return row;
	}
	const valencia = await site(orgA, 'Valencia');
	const madrid = await site(orgA, 'Madrid');
	const cerrada = await site(orgA, 'Cerrada', false);
	const siteB = await site(orgB, 'Valencia');

	async function incident(organization = orgA, siteId = null) {
		const creator = organization.id === orgA.id ? editor : editorB;
		return (
			await createIncidentRecord(
				db,
				{ organizationId: organization.id, creatorUserId: creator.user.id },
				{ title: 'Sede', description: 'Desc', client: 'Cliente', siteId }
			)
		).incident;
	}

	function change(target, siteId, reason, organization = orgA, who = editor) {
		const input = { siteId };
		if (reason !== undefined) input.reason = reason;
		return changeIncidentSite(
			db,
			{ organizationId: organization.id, actorUserId: who.user.id },
			target.id,
			input
		);
	}

	async function siteEvents(target) {
		return db
			.select()
			.from(s.incidentHistory)
			.where(
				and(
					eq(s.incidentHistory.incidentId, target.id),
					eq(s.incidentHistory.eventType, 'site_changed')
				)
			);
	}

	async function currentSite(target) {
		const [row] = await db.select().from(s.incidents).where(eq(s.incidents.id, target.id));
		return row.siteId;
	}

	// =========================================================================
	// Servicio
	// =========================================================================
	await t.test('1, 6, 12, 14-16. asignar desde null con razón opcional', async () => {
		for (const reason of [undefined, '', '  ', 'Primera sede']) {
			const target = await incident();
			const result = await change(target, valencia.id, reason);
			assert.equal(result.incident.siteId, valencia.id);
			const events = await siteEvents(target);
			assert.equal(events.length, 1);
			assert.deepEqual(events[0].payload, { fromSiteId: null, toSiteId: valencia.id });
			assert.equal(events[0].actorType, 'user');
			assert.equal(events[0].actorUserId, editor.user.id);
			assert.equal(events[0].organizationId, orgA.id);
			assert.equal(events[0].comment, null);
			assert.equal(events[0].reason, reason?.trim() ? reason.trim() : null);
			assert.equal(result.history.id, events[0].id);
		}
	});

	await t.test('2-3, 14-15, 17-18. A -> B y A -> null exigen razón', async () => {
		const target = await incident(orgA, valencia.id);
		for (const reason of [undefined, '', '   ']) {
			await rejectsWith(change(target, madrid.id, reason), 'INVALID_INPUT');
			await rejectsWith(change(target, null, reason), 'INVALID_INPUT');
		}
		assert.equal(await currentSite(target), valencia.id);
		assert.equal((await siteEvents(target)).length, 0);

		const moved = await change(target, madrid.id, '  Traslado a Madrid ');
		assert.equal(moved.incident.siteId, madrid.id);
		const removed = await change(target, null, 'Sin sede física');
		assert.equal(removed.incident.siteId, null);
		const events = (await siteEvents(target)).sort((a, b) => a.createdAt - b.createdAt);
		assert.deepEqual(
			events.map((e) => [e.payload, e.reason]),
			[
				[{ fromSiteId: valencia.id, toSiteId: madrid.id }, 'Traslado a Madrid'],
				[{ fromSiteId: madrid.id, toSiteId: null }, 'Sin sede física']
			]
		);
		// payload mínimo: ni nombres, ni organización, ni actor
		for (const event of events) {
			assert.deepEqual(Object.keys(event.payload).sort(), ['fromSiteId', 'toSiteId']);
			const raw = JSON.stringify(event.payload);
			assert.ok(!raw.includes('Madrid') && !raw.includes(orgA.id));
		}
	});

	await t.test('4-5, 13. no-op null -> null y A -> A sin history ni updatedAt', async () => {
		const empty = await incident();
		const withSite = await incident(orgA, valencia.id);
		for (const [target, siteId] of [
			[empty, null],
			[withSite, valencia.id]
		]) {
			const [before] = await db.select().from(s.incidents).where(eq(s.incidents.id, target.id));
			const result = await change(target, siteId);
			assert.equal(result.history, undefined);
			assert.equal(result.incident.siteId, siteId);
			const [after] = await db.select().from(s.incidents).where(eq(s.incidents.id, target.id));
			assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
			assert.equal((await siteEvents(target)).length, 0);
		}
		// el no-op tampoco exige razón aunque haya sede
		assert.equal((await change(withSite, valencia.id)).history, undefined);
	});

	await t.test('7-9. sede inactiva, inexistente o de otro tenant', async () => {
		const target = await incident();
		await rejectsWith(change(target, cerrada.id), 'SITE_INACTIVE');
		for (const siteId of [randomUUID(), siteB.id]) {
			await assert.rejects(change(target, siteId), (error) => {
				assert.equal(error.code, 'SITE_NOT_FOUND');
				assert.equal(error.message, 'Site does not exist or belongs to another organization');
				return true;
			});
		}
		assert.equal(await currentSite(target), null);
		assert.equal((await siteEvents(target)).length, 0);
	});

	await t.test('10-11. incidencia de otro tenant y aislamiento', async () => {
		const targetB = await incident(orgB, siteB.id);
		// actor de A sobre incidencia de B declarando A
		await rejectsWith(change(targetB, valencia.id, 'x'), 'INCIDENT_NOT_FOUND');
		// actor de B declarando B pero con sede de A
		await rejectsWith(change(targetB, valencia.id, 'x', orgB, editorB), 'SITE_NOT_FOUND');
		// actor de A declarando B (sin membresía en B)
		await rejectsWith(change(targetB, null, 'x', orgB, editor), 'CREATOR_MEMBERSHIP_NOT_FOUND');
		assert.equal(await currentSite(targetB), siteB.id);
		assert.equal((await siteEvents(targetB)).length, 0);
	});

	await t.test('19. razón o entrada inválidas', async () => {
		const target = await incident(orgA, valencia.id);
		for (const reason of [42, null, { r: 1 }, 'x'.repeat(1001), 'a\u0000b'])
			await rejectsWith(change(target, madrid.id, reason), 'INVALID_INPUT');
		for (const siteId of ['not-a-uuid', '', undefined, 42])
			await rejectsWith(change(target, siteId, 'x'), 'INVALID_INPUT');
		await rejectsWith(
			changeIncidentSite(db, { organizationId: orgA.id, actorUserId: editor.user.id }, 'x', {
				siteId: null
			}),
			'INVALID_INPUT'
		);
		assert.ok((await change(target, madrid.id, 'y'.repeat(1000))).history);
	});

	await t.test('20. rollback si falla el insert del history', async () => {
		const target = await incident(orgA, valencia.id);
		await pg.exec(`
			CREATE FUNCTION test_fail_site_history() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'forced history failure'; END $$;
			CREATE TRIGGER test_fail_site_history BEFORE INSERT ON incident_history
			FOR EACH ROW WHEN (NEW.event_type = 'site_changed')
			EXECUTE FUNCTION test_fail_site_history();`);
		try {
			await assert.rejects(change(target, madrid.id, 'Rollback'));
		} finally {
			await pg.exec(`DROP TRIGGER test_fail_site_history ON incident_history;
				DROP FUNCTION test_fail_site_history();`);
		}
		assert.equal(await currentSite(target), valencia.id);
		assert.equal((await siteEvents(target)).length, 0);
	});

	await t.test(
		'21-22. SQL: sede por id + organización con FOR SHARE dentro de la transacción',
		async () => {
			// PGlite es de una sola conexión: se verifica el SQL emitido, no una carrera real.
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
				await changeIncidentSite(
					logged,
					{ organizationId: orgA.id, actorUserId: editor.user.id },
					target.id,
					{ siteId: valencia.id }
				);
				await createIncidentRecord(
					logged,
					{ organizationId: orgA.id, creatorUserId: editor.user.id },
					{ title: 'Nueva', description: 'Desc', client: 'Cliente', siteId: madrid.id }
				);
			} finally {
				pg.transaction = original;
			}
			const statements = queries.map((q) => q.toLowerCase());
			const blocks = [];
			let current = null;
			for (const q of statements) {
				if (q === 'begin') current = [];
				else if (q === 'commit') {
					blocks.push(current);
					current = null;
				} else if (current) current.push(q);
			}
			assert.equal(blocks.length, 2, 'dos transacciones reales');
			for (const [name, tx, writePattern] of [
				['change', blocks[0], 'update "incidents"'],
				['create', blocks[1], 'insert into "incidents"']
			]) {
				const siteLock = tx.findIndex((q) => q.includes('from "sites"'));
				assert.ok(siteLock >= 0, `${name}: consulta la sede`);
				assert.match(tx[siteLock], /"sites"\."id" = \$\d+ and "sites"\."organization_id" = \$\d+/);
				assert.match(tx[siteLock], /for share/);
				const write = tx.findIndex((q) => q.startsWith(writePattern));
				assert.ok(write > siteLock, `${name}: escribe después de bloquear la sede`);
			}
			// el cambio bloquea además la incidencia FOR UPDATE por id + organización
			assert.ok(
				blocks[0].some(
					(q) =>
						q.includes('from "incidents"') &&
						q.includes('for update') &&
						q.includes('"organization_id"')
				)
			);
			// ningún lookup de sede es global por id
			for (const q of statements.filter((q) => q.includes('from "sites"')))
				assert.match(q, /"organization_id"/);
		}
	);

	await t.test(
		'22b, 23. desactivar después no altera la histórica, que sigue legible',
		async () => {
			const target = await incident(orgA, madrid.id);
			await setSiteActive(db, orgA.id, madrid.id, false);
			const detail = await getIncidentById(db, { organizationId: orgA.id }, target.id);
			assert.equal(detail.incident.siteId, madrid.id);
			// no se puede reasignar a la inactiva ni crear nuevas con ella
			const other = await incident();
			await rejectsWith(change(other, madrid.id), 'SITE_INACTIVE');
			await rejectsWith(
				createIncidentRecord(
					db,
					{ organizationId: orgA.id, creatorUserId: editor.user.id },
					{ title: 'x', description: 'x', client: 'x', siteId: madrid.id }
				),
				'SITE_INACTIVE'
			);
			// quitarla sí es posible (con razón)
			assert.equal((await change(target, null, 'Sede cerrada')).incident.siteId, null);
			await setSiteActive(db, orgA.id, madrid.id, true);
		}
	);

	// =========================================================================
	// API
	// =========================================================================
	async function call({
		id,
		organizationId = orgA.id,
		cookie = editor.cookie,
		query = '',
		body,
		rawBody,
		headers: extra
	} = {}) {
		const url = new URL(
			`http://localhost/api/incidents/${id}/site?organizationId=${organizationId}${query}`
		);
		const headers = new Headers(extra);
		if (cookie) headers.set('cookie', cookie);
		const init = { method: 'PATCH', headers };
		if (rawBody !== undefined || body !== undefined) {
			headers.set('content-type', 'application/json');
			init.body = rawBody !== undefined ? rawBody : JSON.stringify(body);
		}
		const response = await route.PATCH({ url, params: { id }, request: new Request(url, init) });
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null, text };
	}

	await t.test(
		'API 24-25. 401 sin sesión; 403 sin incidents:edit (sites:manage no basta)',
		async () => {
			const target = await incident();
			for (const cookie of ['', createTamperedCookie()])
				assert.equal(
					(await call({ id: target.id, cookie, body: { siteId: valencia.id } })).status,
					401
				);
			for (const who of [viewer, siteManager, editorB]) {
				const res = await call({
					id: target.id,
					cookie: who.cookie,
					body: { siteId: valencia.id }
				});
				assert.equal(res.status, 403);
				assert.equal(res.json.error.code, 'FORBIDDEN');
				// 403 antes de validar el body
				assert.equal(
					(await call({ id: target.id, cookie: who.cookie, rawBody: '{bad' })).status,
					403
				);
			}
			assert.equal(await currentSite(target), null);
		}
	);

	await t.test('API 200. cambio efectivo, no-op y DTO sin history', async () => {
		const target = await incident();
		const res = await call({ id: target.id, body: { siteId: valencia.id } });
		assert.equal(res.status, 200);
		assert.deepEqual(Object.keys(res.json), ['incident']);
		assert.equal(res.json.incident.siteId, valencia.id);
		assert.ok(!res.text.includes('site_changed'));
		assert.ok(!('history' in res.json));
		const events = await siteEvents(target);
		assert.equal(events[0].actorUserId, editor.user.id, '28. actor de la sesión');

		const again = await call({ id: target.id, body: { siteId: valencia.id } });
		assert.equal(again.status, 200);
		assert.equal((await siteEvents(target)).length, 1);

		const moved = await call({ id: target.id, body: { siteId: madrid.id, reason: 'Traslado' } });
		assert.equal(moved.json.incident.siteId, madrid.id);
		const removed = await call({ id: target.id, body: { siteId: null, reason: 'Retirada' } });
		assert.equal(removed.json.incident.siteId, null);
	});

	await t.test('API 26-27. 404 incidencia/sede y 409 sede inactiva', async () => {
		const target = await incident();
		for (const id of [randomUUID(), (await incident(orgB)).id]) {
			const res = await call({ id, body: { siteId: valencia.id } });
			assert.equal(res.status, 404);
			assert.deepEqual(res.json, {
				error: { code: 'INCIDENT_NOT_FOUND', message: 'Incident not found.' }
			});
		}
		for (const siteId of [randomUUID(), siteB.id]) {
			const res = await call({ id: target.id, body: { siteId } });
			assert.equal(res.status, 404);
			assert.deepEqual(res.json, { error: { code: 'SITE_NOT_FOUND', message: 'Site not found.' } });
			assert.ok(!res.text.includes(orgB.id) && !res.text.includes('Valencia'));
		}
		const inactive = await call({ id: target.id, body: { siteId: cerrada.id } });
		assert.equal(inactive.status, 409);
		assert.equal(inactive.json.error.code, 'SITE_INACTIVE');
		const noReason = await call({
			id: (await incident(orgA, valencia.id)).id,
			body: { siteId: madrid.id }
		});
		assert.equal(noReason.status, 400);
	});

	await t.test('API 400. body, query e ids inválidos', async () => {
		const target = await incident(orgA, valencia.id);
		const cases = [
			{ rawBody: '{bad' },
			{ body: [] },
			{ body: {} },
			{ body: { reason: 'x' } },
			{ body: { siteId: 'nope', reason: 'x' } },
			{ body: { siteId: 5, reason: 'x' } },
			{ body: { siteId: madrid.id, reason: 5 } },
			{ body: { siteId: madrid.id, reason: 'x', organizationId: orgB.id } },
			{ body: { siteId: madrid.id, reason: 'x', actorUserId: viewer.user.id } },
			{ body: { siteId: madrid.id, reason: 'x', eventType: 'created' } },
			{ body: { siteId: madrid.id, reason: 'x', teamId: randomUUID() } },
			{ body: { siteId: madrid.id, reason: 'x' }, query: '&siteId=' + siteB.id },
			{ body: { siteId: madrid.id, reason: 'x' }, query: '&organizationId=' + orgB.id }
		];
		for (const options of cases) {
			const res = await call({ id: target.id, ...options });
			assert.equal(res.status, 400, JSON.stringify(options).slice(0, 80));
			assert.equal(res.json.error.code, 'INVALID_INPUT');
		}
		assert.equal((await call({ id: 'nope', body: { siteId: null } })).status, 400);
		assert.equal(
			(await call({ id: target.id, organizationId: 'nope', body: { siteId: null } })).status,
			400
		);
		assert.equal(await currentSite(target), valencia.id);
	});

	await t.test('API 28-30. spoofing de identidad/tenant y sin fugas SQL', async () => {
		const target = await incident();
		const spoof = { 'x-user-id': viewer.user.id, 'x-organization-id': orgB.id };
		const res = await call({ id: target.id, headers: spoof, body: { siteId: valencia.id } });
		assert.equal(res.status, 200);
		const [event] = await siteEvents(target);
		assert.equal(event.actorUserId, editor.user.id);
		assert.equal(event.organizationId, orgA.id);
		assert.equal(
			(await call({ id: target.id, cookie: '', headers: spoof, body: { siteId: null } })).status,
			401
		);

		await pg.exec(`
			CREATE FUNCTION test_boom_incident() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'SECRET-DETAIL /srv/x.sql'; END $$;
			CREATE TRIGGER test_boom_incident BEFORE UPDATE ON incidents
			FOR EACH ROW EXECUTE FUNCTION test_boom_incident();`);
		let boom;
		try {
			boom = await call({ id: target.id, body: { siteId: madrid.id, reason: 'x' } });
		} finally {
			await pg.exec(
				'DROP TRIGGER test_boom_incident ON incidents; DROP FUNCTION test_boom_incident();'
			);
		}
		assert.equal(boom.status, 500);
		assert.deepEqual(boom.json, {
			error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' }
		});
		assert.ok(!boom.text.includes('SECRET') && !boom.text.includes('update'));
		assert.equal(await currentSite(target), valencia.id);
	});

	await t.test(
		'History API (5.4O-D): site_changed visible solo como changes.siteChanged',
		async () => {
			const target = await incident();
			await call({ id: target.id, body: { siteId: valencia.id } });
			await call({ id: target.id, body: { siteId: madrid.id, reason: 'MOTIVO-PRIVADO' } });
			const url = new URL(
				`http://localhost/api/incidents/${target.id}/history?organizationId=${orgA.id}`
			);
			const response = await historyGET({
				url,
				params: { id: target.id },
				request: new Request(url, { headers: { cookie: editor.cookie } })
			});
			assert.equal(response.status, 200);
			const text = await response.text();
			const items = JSON.parse(text).items.filter((i) => i.type === 'site_changed');
			assert.equal(items.length, 2);
			for (const item of items) assert.deepEqual(item.changes, { siteChanged: true });
			for (const hidden of [
				valencia.id,
				madrid.id,
				'fromSiteId',
				'toSiteId',
				'MOTIVO-PRIVADO',
				'Valencia'
			])
				assert.ok(!text.includes(hidden), hidden);
			assert.equal((await siteEvents(target)).length, 2);
		}
	);
});

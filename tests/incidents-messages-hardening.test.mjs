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

const VIEW_ALL = 'incidents:view_all';
const VIEW_OWN = 'incidents:view_own';
const ADD_COMMENT = 'incidents:add_comment';
const VIEW_NOTES = 'incidents:view_internal_notes';
const ADD_NOTE = 'incidents:add_internal_note';

test('SoporteFlow — Etapa 5.4N-E: hardening de mensajes de incidencias', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, pg, server } = f;
	const comments = await server.ssrLoadModule('/src/routes/api/incidents/[id]/comments/+server.ts');
	const notes = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/internal-notes/+server.ts'
	);
	const history = await server.ssrLoadModule('/src/routes/api/incidents/[id]/history/+server.ts');
	const detail = await server.ssrLoadModule('/src/routes/api/incidents/[id]/+server.ts');
	const incidentsRoute = await server.ssrLoadModule('/src/routes/api/incidents/+server.ts');
	const messages = await server.ssrLoadModule('/src/lib/server/services/incident-messages.ts');

	const [orgA, orgB] = await db
		.insert(s.organizations)
		.values([
			{ name: 'Hardening A', slug: randomUUID(), status: 'active' },
			{ name: 'Hardening B', slug: randomUUID(), status: 'active' }
		])
		.returning();

	async function actor(organization, permissions, options = {}) {
		const user = await createCredentialUser(f, options);
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: organization.id, userId: user.id })
			.returning();
		const grants = [];
		for (const permissionId of permissions)
			grants.push(
				await grantPermission(f, {
					organizationId: organization.id,
					membershipId: membership.id,
					permissionId
				})
			);
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, grants, session, cookie: session.cookieHeader };
	}

	const all = [VIEW_ALL, VIEW_OWN, ADD_COMMENT, VIEW_NOTES, ADD_NOTE];
	const admin = await actor(orgA, all, { name: 'Admin A' });
	const reader = await actor(orgA, [VIEW_ALL]);
	const ownTech = await actor(orgA, [VIEW_OWN, ADD_COMMENT]);
	const otherTech = await actor(orgA, [VIEW_OWN, ADD_COMMENT]);
	const commentOnly = await actor(orgA, [ADD_COMMENT]);
	const notesOnly = await actor(orgA, [VIEW_NOTES, ADD_NOTE]);
	const client = await actor(orgA, [VIEW_OWN, ADD_COMMENT, 'incidents:create']);
	const adminB = await actor(orgB, all, { name: 'Admin B' });

	let incidentNumber = 200000;
	async function incident(organization = orgA, status = 'open', values = {}) {
		const creator = organization.id === orgA.id ? admin : adminB;
		const [row] = await db
			.insert(s.incidents)
			.values({
				organizationId: organization.id,
				incidentNumber: ++incidentNumber,
				title: 'Hardening',
				description: 'Synthetic',
				client: 'Synthetic',
				createdByUserId: creator.user.id,
				status,
				...values
			})
			.returning();
		return row;
	}

	async function call(
		route,
		method,
		{ id, organizationId = orgA.id, cookie, query = '', body, rawBody, headers: extra = {} } = {}
	) {
		const path = route === notes ? 'internal-notes' : route === comments ? 'comments' : 'history';
		const qs = organizationId === null ? '' : 'organizationId=' + organizationId;
		const url = new URL(`http://localhost/api/incidents/${id}/${path}?${qs}${query}`);
		const headers = new Headers(extra);
		if (cookie) headers.set('cookie', cookie);
		const init = { method, headers };
		if (rawBody !== undefined || body !== undefined) {
			headers.set('content-type', 'application/json');
			init.body = rawBody !== undefined ? rawBody : JSON.stringify(body);
		}
		const response = await route[method]({ url, params: { id }, request: new Request(url, init) });
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null, text };
	}
	const both = [
		['comments', comments],
		['internal-notes', notes]
	];

	async function messagesOf(target) {
		return db.select().from(s.incidentMessages).where(eq(s.incidentMessages.incidentId, target.id));
	}
	async function historyOf(target) {
		return db.select().from(s.incidentHistory).where(eq(s.incidentHistory.incidentId, target.id));
	}

	const main = await incident();
	const foreign = await incident(orgB);
	const ownAssigned = await incident(orgA, 'open', { assignedToUserId: ownTech.user.id });
	const otherAssigned = await incident(orgA, 'open', { assignedToUserId: otherTech.user.id });
	const unassigned = await incident();
	const requested = await incident(orgA, 'open', { clientUserId: client.user.id });

	// Datos sensibles en B para comprobar fugas
	const foreignComment = await call(comments, 'POST', {
		id: foreign.id,
		organizationId: orgB.id,
		cookie: adminB.cookie,
		body: { body: 'SECRETO-COMENTARIO-B' }
	});
	const foreignNote = await call(notes, 'POST', {
		id: foreign.id,
		organizationId: orgB.id,
		cookie: adminB.cookie,
		body: { body: 'SECRETO-NOTA-B' }
	});
	assert.equal(foreignComment.status, 201);
	assert.equal(foreignNote.status, 201);

	// =========================================================================
	// Broken access control / IDOR
	// =========================================================================
	await t.test('1-2. IDOR cross-tenant en comments e internal-notes', async () => {
		for (const [name, route] of both) {
			for (const method of ['GET', 'POST']) {
				// incidencia de B pedida bajo org A con permisos completos en A -> 404
				const res = await call(route, method, {
					id: foreign.id,
					cookie: admin.cookie,
					body: method === 'POST' ? { body: 'x' } : undefined
				});
				assert.equal(res.status, 404, `${name} ${method}`);
				assert.deepEqual(res.json, {
					error: { code: 'INCIDENT_NOT_FOUND', message: 'Incident not found.' }
				});
				// indistinguible de inexistente
				const missing = await call(route, method, {
					id: randomUUID(),
					cookie: admin.cookie,
					body: method === 'POST' ? { body: 'x' } : undefined
				});
				assert.deepEqual(missing.json, res.json);
				// org B manipulada sin membresía -> 403 antes de consultar
				const tampered = await call(route, method, {
					id: foreign.id,
					organizationId: orgB.id,
					cookie: admin.cookie,
					body: method === 'POST' ? { body: 'x' } : undefined
				});
				assert.equal(tampered.status, 403);
				for (const r of [res, missing, tampered]) {
					assert.ok(!r.text.includes('SECRETO'));
					assert.ok(!r.text.includes(orgB.id));
				}
			}
			// UUID de un mensaje de B usado como incidentId -> 404
			for (const messageId of [foreignComment.json.item.id, foreignNote.json.item.id]) {
				const res = await call(route, 'GET', { id: messageId, cookie: admin.cookie });
				assert.equal(res.status, 404, name);
			}
		}
		assert.equal((await messagesOf(foreign)).length, 2);
	});

	await t.test('3-8. matriz de permisos y acceso a la incidencia', async () => {
		const expectations = [
			// [actor, target, GET comments, POST comments]
			[commentOnly, main, 403, 403], // 3, 8: add_comment sin acceso ni lectura
			[ownTech, otherAssigned, 403, 403], // 4
			[ownTech, unassigned, 403, 403], // 5
			[client, requested, 403, 403], // 6
			[reader, main, 200, 403], // 7: view_all no concede add_comment
			[ownTech, ownAssigned, 200, 201]
		];
		for (const [who, target, getStatus, postStatus] of expectations) {
			assert.equal(
				(await call(comments, 'GET', { id: target.id, cookie: who.cookie })).status,
				getStatus
			);
			assert.equal(
				(await call(comments, 'POST', { id: target.id, cookie: who.cookie, body: { body: 'x' } }))
					.status,
				postStatus
			);
		}
		for (const target of [main, otherAssigned, unassigned, requested])
			assert.ok((await messagesOf(target)).every((m) => m.authorUserId !== commentOnly.user.id));
	});

	await t.test('9-10. permisos de notas y comentarios no se cruzan', async () => {
		// 9. notas internas no conceden comentarios
		assert.equal(
			(await call(comments, 'GET', { id: main.id, cookie: notesOnly.cookie })).status,
			403
		);
		assert.equal(
			(await call(comments, 'POST', { id: main.id, cookie: notesOnly.cookie, body: { body: 'x' } }))
				.status,
			403
		);
		// 10. add_comment / view_all / view_own no conceden notas internas
		for (const who of [commentOnly, reader, ownTech, client]) {
			const target = who === ownTech ? ownAssigned : main;
			assert.equal((await call(notes, 'GET', { id: target.id, cookie: who.cookie })).status, 403);
			assert.equal(
				(await call(notes, 'POST', { id: target.id, cookie: who.cookie, body: { body: 'x' } }))
					.status,
				403
			);
		}
	});

	// =========================================================================
	// Mass assignment / tampering
	// =========================================================================
	await t.test('11. mass assignment en body -> 400 sin efectos', async () => {
		const target = await incident();
		const fields = {
			organizationId: orgB.id,
			incidentId: foreign.id,
			authorUserId: reader.user.id,
			actorUserId: reader.user.id,
			visibility: 'internal',
			eventType: 'created',
			reason: 'x',
			comment: 'x',
			createdAt: '2000-01-01T00:00:00.000Z',
			id: randomUUID(),
			history: [],
			permissions: [ADD_NOTE],
			roles: ['admin'],
			membership: {},
			__proto__: { polluted: true }
		};
		for (const [name, route] of both) {
			for (const [key, value] of Object.entries(fields)) {
				const res = await call(route, 'POST', {
					id: target.id,
					cookie: admin.cookie,
					body: { body: 'ok', [key]: value }
				});
				assert.equal(res.status, 400, `${name} ${key}`);
			}
			const proto = await call(route, 'POST', {
				id: target.id,
				cookie: admin.cookie,
				rawBody: '{"body":"ok","__proto__":{"visibility":"internal"}}'
			});
			assert.equal(proto.status, 400, `${name} __proto__`);
		}
		assert.equal((await messagesOf(target)).length, 0);
		assert.equal((await historyOf(target)).length, 0);
		assert.equal({}.polluted, undefined);
	});

	await t.test('12-13. query tampering y parámetros duplicados -> 400', async () => {
		const target = await incident();
		const queries = [
			'&incidentId=' + foreign.id,
			'&organizationId=' + orgB.id,
			'&authorUserId=' + reader.user.id,
			'&actorUserId=' + reader.user.id,
			'&userId=' + reader.user.id,
			'&visibility=internal',
			'&limit=1&limit=2',
			'&cursor=a&cursor=b'
		];
		for (const [name, route] of both) {
			for (const query of queries) {
				assert.equal(
					(await call(route, 'GET', { id: target.id, cookie: admin.cookie, query })).status,
					400,
					`${name} GET ${query}`
				);
				assert.equal(
					(
						await call(route, 'POST', {
							id: target.id,
							cookie: admin.cookie,
							query,
							body: { body: 'x' }
						})
					).status,
					400,
					`${name} POST ${query}`
				);
			}
		}
		assert.equal((await messagesOf(target)).length, 0);
	});

	// =========================================================================
	// Leakage
	// =========================================================================
	await t.test('14-16. notas internas y comentarios nunca salen por vías ajenas', async () => {
		const target = await incident();
		const NOTE = 'NOTA-INTERNA-' + randomUUID();
		const COMMENT = 'COMENTARIO-' + randomUUID();
		const note = await call(notes, 'POST', {
			id: target.id,
			cookie: admin.cookie,
			body: { body: NOTE }
		});
		const comment = await call(comments, 'POST', {
			id: target.id,
			cookie: admin.cookie,
			body: { body: COMMENT }
		});
		assert.equal(note.status, 201);
		assert.equal(comment.status, 201);

		// 14/16. incident_history: exactamente un evento (la nota), sin cuerpos
		const events = await historyOf(target);
		assert.deepEqual(
			events.map((e) => e.eventType),
			['internal_note_added']
		);
		assert.deepEqual(events[0].payload, { messageId: note.json.item.id });
		const rawHistory = JSON.stringify(events);
		assert.ok(!rawHistory.includes(NOTE) && !rawHistory.includes(COMMENT));

		// 15. /comments nunca incluye la nota
		const commentsPage = await call(comments, 'GET', { id: target.id, cookie: admin.cookie });
		assert.ok(!commentsPage.text.includes(NOTE));
		assert.ok(!commentsPage.text.includes(note.json.item.id));
		// /internal-notes nunca incluye el comentario
		const notesPage = await call(notes, 'GET', { id: target.id, cookie: admin.cookie });
		assert.ok(!notesPage.text.includes(COMMENT));

		// history API, detalle, listado
		const historyPage = await call(history, 'GET', { id: target.id, cookie: admin.cookie });
		assert.equal(historyPage.status, 200);
		const detailUrl = new URL(
			`http://localhost/api/incidents/${target.id}?organizationId=${orgA.id}`
		);
		const detailRes = await detail.GET({
			url: detailUrl,
			params: { id: target.id },
			request: new Request(detailUrl, { headers: { cookie: admin.cookie } })
		});
		const listUrl = new URL(`http://localhost/api/incidents?organizationId=${orgA.id}&queue=all`);
		const listRes = await incidentsRoute.GET({
			url: listUrl,
			request: new Request(listUrl, { headers: { cookie: admin.cookie } })
		});
		for (const text of [historyPage.text, await detailRes.text(), await listRes.text()]) {
			assert.ok(!text.includes(NOTE), 'nota filtrada');
			assert.ok(!text.includes(COMMENT), 'comentario filtrado');
			assert.ok(!text.includes('internal_note_added'));
		}

		// errores nunca devuelven el body enviado
		const closed = await incident(orgA, 'closed');
		for (const route of [notes, comments]) {
			const res = await call(route, 'POST', {
				id: closed.id,
				cookie: admin.cookie,
				body: { body: NOTE }
			});
			assert.equal(res.status, 409);
			assert.ok(!res.text.includes(NOTE));
		}
	});

	// =========================================================================
	// Paginación
	// =========================================================================
	await t.test('17. cursores y limits corruptos -> 400', async () => {
		const target = await incident();
		const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
		const queries = [
			'&limit=0',
			'&limit=101',
			'&limit=-1',
			'&limit=1.5',
			'&limit=NaN',
			'&limit=abc',
			'&limit=01',
			'&limit=',
			'&limit=%201',
			'&cursor=',
			'&cursor=%%%',
			'&cursor=not+base64',
			'&cursor=' + 'a'.repeat(300),
			'&cursor=' + b64([]),
			'&cursor=' + b64({ at: '2026-01-01T00:00:00.000000Z', id: randomUUID() }),
			'&cursor=' + b64(['2026-13-01T00:00:00.000000Z', randomUUID()]),
			'&cursor=' + b64(['2026-01-01T00:00:00.000Z', randomUUID()]),
			'&cursor=' + b64(['2026-01-01T00:00:00.000000Z', 'not-a-uuid']),
			'&cursor=' + b64(['2026-01-01T00:00:00.000000Z', randomUUID(), 'extra']),
			'&cursor=' + b64(['2026-01-01T00:00:00.000000Z', randomUUID()]) + '='
		];
		for (const [name, route] of both) {
			for (const query of queries) {
				const res = await call(route, 'GET', { id: target.id, cookie: admin.cookie, query });
				assert.equal(res.status, 400, `${name} ${query}`);
				assert.equal(res.json.error.code, 'INVALID_INPUT');
			}
			for (const query of ['&limit=1', '&limit=100']) {
				assert.equal(
					(await call(route, 'GET', { id: target.id, cookie: admin.cookie, query })).status,
					200
				);
			}
		}
	});

	await t.test('18-20. paginación mezclando visibility y tenants, 130 filas', async () => {
		const target = await incident();
		const twin = await incident(orgB);
		const tie = new Date('2026-03-01T00:00:00.000Z');
		const rows = [];
		for (let i = 0; i < 130; i++) {
			const at = i % 10 === 0 ? tie : new Date(Date.UTC(2026, 2, 2, 0, 0, i));
			rows.push(
				{
					id: randomUUID(),
					organizationId: orgA.id,
					incidentId: target.id,
					authorUserId: admin.user.id,
					visibility: 'public',
					body: `P${i}`,
					createdAt: at
				},
				{
					id: randomUUID(),
					organizationId: orgA.id,
					incidentId: target.id,
					authorUserId: admin.user.id,
					visibility: 'internal',
					body: `I${i}`,
					createdAt: at
				},
				{
					id: randomUUID(),
					organizationId: orgB.id,
					incidentId: twin.id,
					authorUserId: adminB.user.id,
					visibility: 'public',
					body: `B${i}`,
					createdAt: at
				}
			);
		}
		await db.insert(s.incidentMessages).values(rows);
		// microsegundos distintos dentro del mismo milisegundo
		await pg.query(
			`UPDATE incident_messages SET created_at = '2026-03-03T00:00:00.000001Z'
			 WHERE incident_id = $1 AND body IN ('P1', 'I1');
			 `,
			[target.id]
		);
		await pg.query(
			`UPDATE incident_messages SET created_at = '2026-03-03T00:00:00.000002Z'
			 WHERE incident_id = $1 AND body IN ('P2', 'I2');`,
			[target.id]
		);

		async function walk(route, limit) {
			const seen = [];
			let cursor = null;
			do {
				const res = await call(route, 'GET', {
					id: target.id,
					cookie: admin.cookie,
					query: `&limit=${limit}` + (cursor ? '&cursor=' + cursor : '')
				});
				assert.equal(res.status, 200);
				seen.push(...res.json.items);
				cursor = res.json.nextCursor;
			} while (cursor);
			return seen;
		}
		for (const [route, prefix] of [
			[comments, 'P'],
			[notes, 'I']
		]) {
			const expected = (
				await pg.query(
					`SELECT id FROM incident_messages WHERE incident_id = $1 AND visibility = $2
					 ORDER BY created_at DESC, id DESC`,
					[target.id, prefix === 'P' ? 'public' : 'internal']
				)
			).rows.map((r) => r.id);
			assert.equal(expected.length, 130);
			for (const limit of [1, 13, 100]) {
				const items = await walk(route, limit);
				assert.deepEqual(
					items.map((i) => i.id),
					expected,
					`limit ${limit}`
				);
				assert.ok(items.every((i) => i.body.startsWith(prefix)));
			}
			// los dos primeros por microsegundo
			const first = await walk(route, 100);
			assert.deepEqual(
				first.slice(0, 2).map((i) => i.body),
				[`${prefix}2`, `${prefix}1`]
			);
		}
	});

	// =========================================================================
	// Estados, transacciones, concurrencia (estática)
	// =========================================================================
	await t.test('21-22. closed rechaza comentario y nota; lectura permitida', async () => {
		const target = await incident(orgA, 'closed');
		for (const [name, route] of both) {
			const res = await call(route, 'POST', {
				id: target.id,
				cookie: admin.cookie,
				body: { body: 'x' }
			});
			assert.equal(res.status, 409, name);
			assert.equal(res.json.error.code, 'INCIDENT_CLOSED');
			assert.equal((await call(route, 'GET', { id: target.id, cookie: admin.cookie })).status, 200);
		}
		assert.equal((await messagesOf(target)).length, 0);
		assert.equal((await historyOf(target)).length, 0);
	});

	await t.test('23-24, 29-30. rollback y 500 seguro sin secretos', async () => {
		for (const [name, route, table] of [
			['internal-notes', notes, 'incident_history'],
			['internal-notes', notes, 'incident_messages'],
			['comments', comments, 'incident_messages']
		]) {
			const target = await incident();
			await pg.exec(`
				CREATE FUNCTION test_boom() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN RAISE EXCEPTION 'SECRET-DB-DETAIL /srv/app/secret.sql'; END $$;
				CREATE TRIGGER test_boom BEFORE INSERT ON ${table}
				FOR EACH ROW EXECUTE FUNCTION test_boom();`);
			let res;
			try {
				res = await call(route, 'POST', {
					id: target.id,
					cookie: admin.cookie,
					body: { body: 'CUERPO-SENSIBLE' }
				});
			} finally {
				await pg.exec(`DROP TRIGGER test_boom ON ${table}; DROP FUNCTION test_boom();`);
			}
			assert.equal(res.status, 500, `${name} ${table}`);
			assert.deepEqual(res.json, {
				error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' }
			});
			for (const secret of ['SECRET-DB-DETAIL', '/srv/', 'insert', 'CUERPO-SENSIBLE', 'stack'])
				assert.ok(!res.text.toLowerCase().includes(secret.toLowerCase()));
			assert.equal((await messagesOf(target)).length, 0);
			assert.equal((await historyOf(target)).length, 0);
		}
	});

	await t.test(
		'BUG 5.4N-E: el proxy db de producción expone transaction al operador in',
		async () => {
			// El fixture reemplaza $lib/server/db por una copia; el sufijo evita esa interceptación
			// y carga el módulo real. getDb() crea el cliente postgres-js sin conectar.
			const production = await server.ssrLoadModule('/src/lib/server/db/index.ts?production-proxy');
			assert.equal(typeof production.db.transaction, 'function');
			assert.equal('transaction' in production.db, true);
			assert.equal('select' in production.db, true);
			assert.equal('definitelyMissing' in production.db, false);
			// Y el proxy de tests se comporta igual
			assert.equal('transaction' in (await server.ssrLoadModule('$lib/server/db')).db, true);
		}
	);

	await t.test(
		'Concurrencia (estática): incidencia leída FOR SHARE dentro de la transacción',
		async () => {
			// PGlite es de una sola conexión: no hay carrera real posible. Se verifica el SQL emitido.
			const queries = [];
			const logged = drizzle(pg, {
				schema: s,
				logger: { logQuery: (query) => queries.push(query) }
			});
			// PGlite abre la transacción sin pasar por el logger de drizzle: se marca aquí.
			const originalTransaction = pg.transaction.bind(pg);
			pg.transaction = async (fn) => {
				queries.push('begin');
				try {
					return await originalTransaction(fn);
				} finally {
					queries.push('commit');
				}
			};
			const target = await incident(orgA, 'open', { assignedToUserId: ownTech.user.id });
			try {
				await messages.createPublicComment(
					logged,
					{
						organizationId: orgA.id,
						incidentId: target.id,
						actorUserId: ownTech.user.id,
						assignedToUserId: ownTech.user.id
					},
					'x'
				);
				await messages.createInternalNote(
					logged,
					{ organizationId: orgA.id, incidentId: target.id, actorUserId: admin.user.id },
					'y'
				);
			} finally {
				pg.transaction = originalTransaction;
			}
			const statements = queries.map((q) => q.toLowerCase());
			for (const kind of ['comment', 'note']) {
				const start = statements.findIndex(
					(q, i) => q === 'begin' && i >= (kind === 'note' ? statements.indexOf('commit') + 1 : 0)
				);
				const end = statements.indexOf('commit', start);
				const tx = statements.slice(start, end + 1);
				assert.ok(start >= 0 && end > start, `${kind}: transacción explícita`);
				const lockIndex = tx.findIndex(
					(q) =>
						q.includes('from "incidents"') &&
						q.includes('for share') &&
						q.includes('"organization_id" = $')
				);
				const insertIndex = tx.findIndex((q) => q.startsWith('insert into "incident_messages"'));
				assert.ok(lockIndex > 0, `${kind}: SELECT ... FOR SHARE sobre incidents`);
				assert.ok(insertIndex > lockIndex, `${kind}: el insert ocurre tras el bloqueo`);
				const historyInserts = tx.filter((q) => q.startsWith('insert into "incident_history"'));
				assert.equal(historyInserts.length, kind === 'note' ? 1 : 0, `${kind}: history`);
			}
		}
	);

	// =========================================================================
	// Auth / sesión
	// =========================================================================
	await t.test('25-27. estado del actor, membership y organización -> 401/403', async () => {
		const target = await incident();
		const cases = [];
		const inactiveUser = await actor(orgA, all);
		await db.update(s.users).set({ active: false }).where(eq(s.users.id, inactiveUser.user.id));
		cases.push([inactiveUser, 401]);
		const inactiveMember = await actor(orgA, all);
		await db
			.update(s.memberships)
			.set({ active: false })
			.where(eq(s.memberships.id, inactiveMember.membership.id));
		cases.push([inactiveMember, 403]);
		const expired = await actor(orgA, all);
		await db
			.update(s.authSessions)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(s.authSessions.id, expired.session.session.id));
		cases.push([expired, 401]);
		const revoked = await actor(orgA, all);
		await db.delete(s.authSessions).where(eq(s.authSessions.id, revoked.session.session.id));
		cases.push([revoked, 401]);

		for (const [who, expected] of cases) {
			for (const [name, route] of both) {
				assert.equal(
					(await call(route, 'GET', { id: target.id, cookie: who.cookie })).status,
					expected,
					name
				);
				assert.equal(
					(await call(route, 'POST', { id: target.id, cookie: who.cookie, body: { body: 'x' } }))
						.status,
					expected,
					name
				);
			}
		}
		for (const status of ['suspended', 'trial']) {
			const [org] = await db
				.insert(s.organizations)
				.values({ name: status, slug: randomUUID(), status: 'active' })
				.returning();
			const member = await actor(org, all);
			await db.update(s.organizations).set({ status }).where(eq(s.organizations.id, org.id));
			for (const [name, route] of both)
				assert.equal(
					(
						await call(route, 'POST', {
							id: target.id,
							organizationId: org.id,
							cookie: member.cookie,
							body: { body: 'x' }
						})
					).status,
					403,
					`${name} ${status}`
				);
		}
		// permiso revocado entre requests
		const revokable = await actor(orgA, [VIEW_ALL, ADD_COMMENT]);
		assert.equal(
			(
				await call(comments, 'POST', {
					id: target.id,
					cookie: revokable.cookie,
					body: { body: 'x' }
				})
			).status,
			201
		);
		const addGrant = revokable.grants[1];
		await db.delete(s.roleAssignments).where(eq(s.roleAssignments.id, addGrant.assignment.id));
		assert.equal(
			(
				await call(comments, 'POST', {
					id: target.id,
					cookie: revokable.cookie,
					body: { body: 'x' }
				})
			).status,
			403
		);
		assert.equal(
			(await call(comments, 'GET', { id: target.id, cookie: revokable.cookie })).status,
			200
		);
		assert.ok(
			(await messagesOf(target)).every((m) => [revokable.user.id].includes(m.authorUserId))
		);
	});

	await t.test('28. cabeceras de identidad personalizadas se ignoran', async () => {
		const target = await incident();
		const spoof = {
			'x-user-id': admin.user.id,
			'x-organization-id': orgA.id,
			'x-actor-user-id': admin.user.id,
			authorization: 'Bearer ' + admin.user.id
		};
		for (const [name, route] of both) {
			const anonymous = await call(route, 'POST', {
				id: target.id,
				headers: spoof,
				body: { body: 'x' }
			});
			assert.equal(anonymous.status, 401, name);
		}
		// Con sesión de commentOnly + cabeceras que apuntan al admin: sigue siendo commentOnly
		const res = await call(comments, 'POST', {
			id: target.id,
			cookie: ownTech.cookie,
			headers: spoof,
			body: { body: 'x' }
		});
		assert.equal(res.status, 403);
		const ok = await call(comments, 'POST', {
			id: ownAssigned.id,
			cookie: ownTech.cookie,
			headers: spoof,
			body: { body: 'spoof' }
		});
		assert.equal(ok.status, 201);
		const [row] = await db
			.select()
			.from(s.incidentMessages)
			.where(eq(s.incidentMessages.id, ok.json.item.id));
		assert.equal(row.authorUserId, ownTech.user.id);
		assert.equal((await messagesOf(target)).length, 0);
		assert.ok(createTamperedCookie());
	});

	// =========================================================================
	// Contenido / abuso
	// =========================================================================
	await t.test('Contenido: NUL y surrogates sueltos -> 400 (no 500 ni alteración)', async () => {
		const target = await incident();
		for (const [name, route] of both) {
			for (const body of ['a\u0000b', '\u0000', 'a\ud800b', 'b\udc00', 'x'.repeat(10) + '\ud83d']) {
				const res = await call(route, 'POST', {
					id: target.id,
					cookie: admin.cookie,
					body: { body }
				});
				assert.equal(res.status, 400, `${name} ${JSON.stringify(body)}`);
				assert.equal(res.json.error.code, 'INVALID_INPUT');
			}
			// Pares surrogate válidos (emoji) siguen permitidos y se devuelven íntegros
			const emoji = await call(route, 'POST', {
				id: target.id,
				cookie: admin.cookie,
				body: { body: 'ok 😀' }
			});
			assert.equal(emoji.status, 201, name);
			assert.equal(emoji.json.item.body, 'ok 😀');
		}
		assert.ok((await messagesOf(target)).every((m) => !m.body.includes('�')));
	});

	await t.test('Abuso básico: JSON anidado, arrays, cuerpos grandes', async () => {
		const target = await incident();
		const deep = '['.repeat(5000) + ']'.repeat(5000);
		for (const [name, route] of both) {
			for (const rawBody of [
				deep,
				'{"body":' + deep + '}',
				'[{"body":"x"}]',
				JSON.stringify({ body: 'x'.repeat(200000) }),
				JSON.stringify({ body: ['x'] }),
				JSON.stringify({ body: { toString: 'x' } })
			]) {
				const res = await call(route, 'POST', { id: target.id, cookie: admin.cookie, rawBody });
				assert.equal(res.status, 400, `${name} ${rawBody.slice(0, 20)}`);
			}
			const longQuery = '&x=' + 'a'.repeat(8000);
			assert.equal(
				(await call(route, 'GET', { id: target.id, cookie: admin.cookie, query: longQuery }))
					.status,
				400
			);
		}
		assert.equal((await messagesOf(target)).length, 0);
	});

	await t.test('XSS: el texto se almacena y devuelve literal', async () => {
		const target = await incident();
		const payload = '<script>alert(1)</script><img src=x onerror=alert(2)>{@html x}';
		for (const [name, route] of both) {
			const created = await call(route, 'POST', {
				id: target.id,
				cookie: admin.cookie,
				body: { body: payload }
			});
			assert.equal(created.status, 201, name);
			assert.equal(created.json.item.body, payload);
			const listed = await call(route, 'GET', { id: target.id, cookie: admin.cookie });
			assert.equal(listed.json.items[0].body, payload);
		}
		const rows = await db
			.select()
			.from(s.incidentMessages)
			.where(and(eq(s.incidentMessages.incidentId, target.id)));
		assert.ok(rows.every((r) => r.body === payload));
	});
});

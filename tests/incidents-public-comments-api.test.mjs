import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
	fixture,
	createCredentialUser,
	createSession,
	createTamperedCookie,
	grantPermission
} from './helpers/auth-fixture.mjs';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEW_ALL = 'incidents:view_all';
const VIEW_OWN = 'incidents:view_own';
const ADD = 'incidents:add_comment';

test('SoporteFlow — Etapa 5.4N-D: API HTTP de comentarios públicos', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;
	const route = await server.ssrLoadModule('/src/routes/api/incidents/[id]/comments/+server.ts');
	const { GET, POST } = route;
	const notesRoute = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/internal-notes/+server.ts'
	);
	const { GET: historyGET } = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/history/+server.ts'
	);
	const { GET: detailGET } = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/+server.ts'
	);
	const { GET: listGET } = await server.ssrLoadModule('/src/routes/api/incidents/+server.ts');

	const [orgA, orgB] = await db
		.insert(s.organizations)
		.values([
			{ name: 'Comments API A', slug: randomUUID(), status: 'active' },
			{ name: 'Comments API B', slug: randomUUID(), status: 'active' }
		])
		.returning();

	async function actor(organization, permissions, options = {}) {
		const user = await createCredentialUser(f, options);
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

	const manager = await actor(orgA, [VIEW_ALL, ADD], { name: 'Ana Gestora' });
	const reader = await actor(orgA, [VIEW_ALL]);
	const ownTech = await actor(orgA, [VIEW_OWN, ADD], { name: 'Olga Asignada' });
	const ownReader = await actor(orgA, [VIEW_OWN]);
	const otherTech = await actor(orgA, [VIEW_OWN, ADD]);
	const commentOnly = await actor(orgA, [ADD]);
	const none = await actor(orgA, []);
	const client = await actor(orgA, [VIEW_OWN, ADD, 'incidents:create']);
	const notesOnly = await actor(orgA, [
		'incidents:view_internal_notes',
		'incidents:add_internal_note'
	]);
	const managerB = await actor(orgB, [VIEW_ALL, ADD], { name: 'Gestor B' });
	const blank = await actor(orgA, [VIEW_ALL, ADD], { name: '   ' });

	let incidentNumber = 100000;
	async function incident(organization = orgA, status = 'open', values = {}) {
		const creator = organization.id === orgA.id ? manager : managerB;
		const [row] = await db
			.insert(s.incidents)
			.values({
				organizationId: organization.id,
				incidentNumber: ++incidentNumber,
				title: 'Incidencia API comentarios',
				description: 'Synthetic',
				client: 'Synthetic',
				createdByUserId: creator.user.id,
				status,
				...values
			})
			.returning();
		return row;
	}

	async function request(
		handler,
		method,
		{ id, organizationId = orgA.id, cookie, query = '', body, rawBody, path = 'comments' } = {}
	) {
		const qs = organizationId === null ? '' : 'organizationId=' + organizationId;
		const url = new URL(`http://localhost/api/incidents/${id}/${path}?${qs}${query}`);
		const headers = new Headers();
		if (cookie) headers.set('cookie', cookie);
		const init = { method, headers };
		if (rawBody !== undefined) {
			headers.set('content-type', 'application/json');
			init.body = rawBody;
		} else if (body !== undefined) {
			headers.set('content-type', 'application/json');
			init.body = JSON.stringify(body);
		}
		const response = await handler({ url, params: { id }, request: new Request(url, init) });
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null, text };
	}
	const get = (options) => request(GET, 'GET', { cookie: manager.cookie, ...options });
	const post = (options) => request(POST, 'POST', { cookie: manager.cookie, ...options });

	async function messagesOf(target) {
		return db.select().from(s.incidentMessages).where(eq(s.incidentMessages.incidentId, target.id));
	}
	async function historyOf(target) {
		return db.select().from(s.incidentHistory).where(eq(s.incidentHistory.incidentId, target.id));
	}

	const main = await incident();
	const assignedToOwn = await incident(orgA, 'open', { assignedToUserId: ownTech.user.id });
	const assignedToOwnReader = await incident(orgA, 'open', {
		assignedToUserId: ownReader.user.id
	});
	const assignedToOther = await incident(orgA, 'open', { assignedToUserId: otherTech.user.id });
	const unassigned = await incident();
	const requestedByClient = await incident(orgA, 'open', { clientUserId: client.user.id });
	const foreign = await incident(orgB);

	// =========================================================================
	// GET
	// =========================================================================
	await t.test('GET 1-3. sin sesión, sesión inválida o usuario inactivo -> 401', async () => {
		const inactive = await actor(orgA, [VIEW_ALL], { active: false });
		for (const cookie of ['', createTamperedCookie(), inactive.cookie]) {
			const res = await get({ id: main.id, cookie });
			assert.equal(res.status, 401);
			assert.equal(res.json.error.code, 'UNAUTHORIZED');
		}
		assert.equal((await get({ id: main.id, cookie: '', query: '&limit=0' })).status, 401);
	});

	await t.test(
		'GET 4-6. organizationId ausente/inválido o incidentId inválido -> 400',
		async () => {
			for (const options of [
				{ id: main.id, organizationId: null },
				{ id: main.id, organizationId: 'nope' },
				{ id: 'nope' }
			]) {
				const res = await get(options);
				assert.equal(res.status, 400);
				assert.equal(res.json.error.code, 'INVALID_INPUT');
			}
		}
	);

	await t.test('GET 7-8. sin view_all/view_own o permiso en otra org -> 403', async () => {
		for (const cookie of [none.cookie, commentOnly.cookie, notesOnly.cookie, managerB.cookie]) {
			const res = await get({ id: main.id, cookie });
			assert.equal(res.status, 403);
			assert.equal(res.json.error.code, 'FORBIDDEN');
		}
		// 403 precede a la validación de query
		assert.equal((await get({ id: main.id, cookie: none.cookie, query: '&limit=0' })).status, 403);
	});

	await t.test('GET 9-13. reglas view_all / view_own / clientUserId', async () => {
		// view_all lee cualquier incidencia del tenant, sin add_comment
		for (const target of [main, assignedToOwn, assignedToOther, unassigned]) {
			assert.equal((await get({ id: target.id, cookie: reader.cookie })).status, 200);
		}
		// view_own solo la asignada
		assert.equal((await get({ id: assignedToOwn.id, cookie: ownTech.cookie })).status, 200);
		assert.equal((await get({ id: assignedToOwnReader.id, cookie: ownReader.cookie })).status, 200);
		for (const target of [assignedToOther, unassigned]) {
			const res = await get({ id: target.id, cookie: ownTech.cookie });
			assert.equal(res.status, 403);
			assert.equal(res.json.error.code, 'FORBIDDEN');
			assert.equal(res.json.items, undefined);
		}
		// clientUserId=self sin asignación no concede acceso
		const res = await get({ id: requestedByClient.id, cookie: client.cookie });
		assert.equal(res.status, 403);
	});

	await t.test('GET 14-15. inexistente o cross-tenant -> 404 sin fuga', async () => {
		for (const cookie of [manager.cookie, ownTech.cookie]) {
			for (const id of [randomUUID(), foreign.id]) {
				const res = await get({ id, cookie });
				assert.equal(res.status, 404);
				assert.equal(res.json.error.code, 'INCIDENT_NOT_FOUND');
				assert.ok(!res.text.includes(orgB.id));
			}
		}
	});

	await t.test('GET 16-18, 21. closed legible; solo public; DTO seguro', async () => {
		const target = await incident();
		const created = await post({ id: target.id, body: { body: 'Comentario visible' } });
		assert.equal(created.status, 201);
		const note = await request(notesRoute.POST, 'POST', {
			id: target.id,
			cookie: notesOnly.cookie,
			path: 'internal-notes',
			body: { body: 'NOTA-INTERNA-SECRETA' }
		});
		assert.equal(note.status, 201);
		await db.update(s.incidents).set({ status: 'closed' }).where(eq(s.incidents.id, target.id));

		const res = await get({ id: target.id, cookie: reader.cookie });
		assert.equal(res.status, 200);
		assert.deepEqual(Object.keys(res.json).sort(), ['items', 'nextCursor']);
		assert.deepEqual(
			res.json.items.map((i) => i.body),
			['Comentario visible']
		);
		assert.deepEqual(Object.keys(res.json.items[0]).sort(), ['author', 'body', 'createdAt', 'id']);
		assert.deepEqual(res.json.items[0].author, { name: 'Ana Gestora' });
		for (const hidden of [
			orgA.id,
			target.id,
			manager.user.id,
			manager.membership.id,
			note.json.item.id,
			'NOTA-INTERNA-SECRETA',
			'visibility',
			'history',
			'permission',
			'membership',
			'session',
			'roles'
		])
			assert.ok(!res.text.includes(hidden), `no debe exponer ${hidden}`);
	});

	await t.test('GET 19. paginación limit/cursor', async () => {
		const target = await incident();
		for (let i = 0; i < 5; i++) await post({ id: target.id, body: { body: `C${i}` } });
		const seen = [];
		let cursor = null;
		do {
			const res = await get({
				id: target.id,
				query: '&limit=2' + (cursor ? '&cursor=' + cursor : '')
			});
			assert.equal(res.status, 200);
			assert.ok(res.json.items.length <= 2);
			seen.push(...res.json.items.map((i) => i.body));
			cursor = res.json.nextCursor;
		} while (cursor);
		assert.deepEqual(seen, ['C4', 'C3', 'C2', 'C1', 'C0']);
	});

	await t.test('GET 20. query inválida -> 400', async () => {
		for (const query of [
			'&limit=0',
			'&limit=101',
			'&limit=x',
			'&cursor=%%%',
			'&cursor=' + Buffer.from('[]').toString('base64url'),
			'&visibility=internal',
			'&incidentId=' + randomUUID(),
			'&limit=2&limit=3',
			'&organizationId=' + orgA.id
		]) {
			const res = await get({ id: main.id, query });
			assert.equal(res.status, 400, query);
			assert.equal(res.json.error.code, 'INVALID_INPUT');
		}
	});

	// =========================================================================
	// POST
	// =========================================================================
	await t.test('POST 22. sin sesión -> 401', async () => {
		for (const cookie of ['', createTamperedCookie()]) {
			assert.equal((await post({ id: main.id, cookie, rawBody: '{bad' })).status, 401);
		}
	});

	await t.test('POST 23-29. permisos y acceso a la incidencia -> 403', async () => {
		const cases = [
			// 23. sin add_comment (view_all no reemplaza add_comment)
			[reader, main],
			[ownReader, assignedToOwnReader],
			[none, main],
			// 24. add_comment sin view_all/view_own
			[commentOnly, main],
			// 27-28. view_own + otro técnico o sin asignar
			[ownTech, assignedToOther],
			[ownTech, unassigned],
			// 29. clientUserId=self sin acceso técnico
			[client, requestedByClient],
			// permiso solo en otra org
			[managerB, main],
			// permisos de notas internas no conceden comentarios
			[notesOnly, main]
		];
		for (const [who, target] of cases) {
			const res = await post({ id: target.id, cookie: who.cookie, body: { body: 'x' } });
			assert.equal(res.status, 403);
			assert.equal(res.json.error.code, 'FORBIDDEN');
		}
		// 403 de permiso precede a la validación del body
		assert.equal((await post({ id: main.id, cookie: reader.cookie, rawBody: '{bad' })).status, 403);
		for (const target of [main, assignedToOther, unassigned, requestedByClient])
			assert.equal((await messagesOf(target)).length, 0);
	});

	await t.test('POST 25-26, 43-45. view_all o view_own asignada -> 201 sin history', async () => {
		for (const [who, target] of [
			[manager, await incident()],
			[ownTech, assignedToOwn]
		]) {
			const historyBefore = (await historyOf(target)).length;
			const res = await post({ id: target.id, cookie: who.cookie, body: { body: 'Hola' } });
			assert.equal(res.status, 201);
			assert.deepEqual(Object.keys(res.json), ['item']);
			assert.deepEqual(Object.keys(res.json.item).sort(), ['author', 'body', 'createdAt', 'id']);
			assert.match(res.json.item.id, UUID_REGEX);
			assert.ok(!res.text.includes('history'));
			assert.ok(!res.text.includes(who.user.id));
			const [row] = await db
				.select()
				.from(s.incidentMessages)
				.where(eq(s.incidentMessages.id, res.json.item.id));
			assert.equal(row.authorUserId, who.user.id);
			assert.equal(row.visibility, 'public');
			assert.equal((await historyOf(target)).length, historyBefore);
		}
	});

	await t.test('POST 30-39. body/query inválidos -> 400', async () => {
		const target = await incident();
		const cases = [
			{ rawBody: '{bad json' },
			{ rawBody: '' },
			{ body: 'texto' },
			{ body: ['a'] },
			{ body: null },
			{ body: {} },
			{ body: { body: '' } },
			{ body: { body: '   ' } },
			{ body: { body: 1 } },
			{ body: { body: 'x'.repeat(4001) } },
			{ body: { body: 'ok', extra: 1 } },
			{ body: { body: 'ok', visibility: 'internal' } },
			{ body: { body: 'ok', authorUserId: none.user.id } },
			{ body: { body: 'ok', organizationId: orgB.id } },
			{ body: { body: 'ok', incidentId: foreign.id } },
			{ body: { body: 'ok' }, query: '&incidentId=' + foreign.id },
			{ body: { body: 'ok' }, query: '&visibility=internal' }
		];
		for (const options of cases) {
			const res = await post({ id: target.id, ...options });
			assert.equal(res.status, 400, JSON.stringify(options).slice(0, 80));
			assert.equal(res.json.error.code, 'INVALID_INPUT');
		}
		assert.equal((await messagesOf(target)).length, 0);
	});

	await t.test('POST 34. body de 4000 caracteres -> 201', async () => {
		const res = await post({ id: main.id, body: { body: 'z'.repeat(4000) } });
		assert.equal(res.status, 201);
		assert.equal(res.json.item.body.length, 4000);
	});

	await t.test('POST 40. closed -> 409', async () => {
		for (const [who, target] of [
			[manager, await incident(orgA, 'closed')],
			[ownTech, await incident(orgA, 'closed', { assignedToUserId: ownTech.user.id })]
		]) {
			const res = await post({ id: target.id, cookie: who.cookie, body: { body: 'x' } });
			assert.equal(res.status, 409);
			assert.deepEqual(res.json, {
				error: {
					code: 'INCIDENT_CLOSED',
					message: 'No se pueden añadir comentarios a una incidencia cerrada.'
				}
			});
			assert.equal((await messagesOf(target)).length, 0);
		}
	});

	await t.test('POST 41-42. inexistente o cross-tenant -> 404', async () => {
		for (const cookie of [manager.cookie, ownTech.cookie]) {
			for (const id of [randomUUID(), foreign.id]) {
				const res = await post({ id, cookie, body: { body: 'x' } });
				assert.equal(res.status, 404);
				assert.ok(!res.text.includes(orgB.id));
			}
		}
		assert.equal((await messagesOf(foreign)).length, 0);
	});

	await t.test('POST 46-48. HTML literal, nombre legible y fallback', async () => {
		const target = await incident();
		const html = '<script>alert(1)</script>';
		const res = await post({ id: target.id, body: { body: html } });
		assert.equal(res.status, 201);
		assert.equal(res.json.item.body, html);
		assert.deepEqual(res.json.item.author, { name: 'Ana Gestora' });
		const anon = await post({ id: target.id, cookie: blank.cookie, body: { body: 'anon' } });
		assert.deepEqual(anon.json.item.author, { name: 'Usuario no disponible' });
	});

	await t.test('POST 49. no hay PUT/PATCH/DELETE definidos', async () => {
		assert.deepEqual(Object.keys(route).sort(), ['GET', 'POST']);
	});

	// =========================================================================
	// Regresiones
	// =========================================================================
	await t.test('REG 50. /internal-notes intacta y aislada de comentarios', async () => {
		const target = await incident();
		await post({ id: target.id, body: { body: 'COMENTARIO-PUBLICO' } });
		const note = await request(notesRoute.POST, 'POST', {
			id: target.id,
			cookie: notesOnly.cookie,
			path: 'internal-notes',
			body: { body: 'Nota' }
		});
		assert.equal(note.status, 201);
		const notes = await request(notesRoute.GET, 'GET', {
			id: target.id,
			cookie: notesOnly.cookie,
			path: 'internal-notes'
		});
		assert.equal(notes.status, 200);
		assert.deepEqual(
			notes.json.items.map((i) => i.body),
			['Nota']
		);
		// add_comment / view_all no conceden notas internas
		for (const who of [manager, reader, ownTech]) {
			const res = await request(notesRoute.GET, 'GET', {
				id: target.id,
				cookie: who.cookie,
				path: 'internal-notes'
			});
			assert.equal(res.status, 403);
		}
		const events = (await historyOf(target)).map((e) => e.eventType);
		assert.deepEqual(events, ['internal_note_added']);
	});

	await t.test(
		'REG. /history sin internal_note_added ni comentarios; detalle sin history',
		async () => {
			const target = await incident();
			await post({ id: target.id, body: { body: 'COMENTARIO-HISTORY' } });
			const history = await request(historyGET, 'GET', {
				id: target.id,
				cookie: reader.cookie,
				path: 'history'
			});
			assert.equal(history.status, 200);
			assert.deepEqual(history.json.items, []);
			assert.ok(!history.text.includes('COMENTARIO-HISTORY'));

			const url = new URL(`http://localhost/api/incidents/${target.id}?organizationId=${orgA.id}`);
			const detail = await detailGET({
				url,
				params: { id: target.id },
				request: new Request(url, { headers: { cookie: reader.cookie } })
			});
			assert.equal(detail.status, 200);
			assert.deepEqual(Object.keys(await detail.json()), ['incident']);
		}
	);

	await t.test('REG. view_own del detalle y queue=mine intactos', async () => {
		const detail = async (target, cookie) => {
			const url = new URL(`http://localhost/api/incidents/${target.id}?organizationId=${orgA.id}`);
			return (
				await detailGET({
					url,
					params: { id: target.id },
					request: new Request(url, { headers: { cookie } })
				})
			).status;
		};
		assert.equal(await detail(assignedToOwn, ownTech.cookie), 200);
		assert.equal(await detail(assignedToOther, ownTech.cookie), 403);
		assert.equal(await detail(requestedByClient, client.cookie), 403);

		const url = new URL(`http://localhost/api/incidents?organizationId=${orgA.id}&queue=mine`);
		const response = await listGET({
			url,
			request: new Request(url, { headers: { cookie: ownTech.cookie } })
		});
		assert.equal(response.status, 200);
		const { incidents } = await response.json();
		assert.ok(incidents.length > 0);
		assert.ok(incidents.every((i) => i.assignedToUserId === ownTech.user.id));
	});
});

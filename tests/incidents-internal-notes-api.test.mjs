import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
	fixture,
	createCredentialUser,
	createSession,
	createTamperedCookie,
	grantPermission
} from './helpers/auth-fixture.mjs';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEW = 'incidents:view_internal_notes';
const ADD = 'incidents:add_internal_note';

test('SoporteFlow — Etapa 5.4N-C: API HTTP de notas internas', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;
	const route = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/internal-notes/+server.ts'
	);
	const { GET, POST } = route;
	const { GET: historyGET } = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/history/+server.ts'
	);
	const { GET: detailGET } = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/+server.ts'
	);
	const { GET: listGET, POST: createPOST } = await server.ssrLoadModule(
		'/src/routes/api/incidents/+server.ts'
	);

	const [orgA, orgB] = await db
		.insert(s.organizations)
		.values([
			{ name: 'Notes API A', slug: randomUUID(), status: 'active' },
			{ name: 'Notes API B', slug: randomUUID(), status: 'active' }
		])
		.returning();

	async function actor(organization, permissions, options = {}) {
		const user = await createCredentialUser(f, options);
		if (options.displayName !== undefined)
			await db
				.update(s.users)
				.set({ displayName: options.displayName })
				.where(eq(s.users.id, user.id));
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
		return { user, membership, session, cookie: session.cookieHeader };
	}

	const tech = await actor(orgA, [VIEW, ADD], { name: 'Ana Técnica' });
	const viewer = await actor(orgA, [VIEW]);
	const writer = await actor(orgA, [ADD]);
	const none = await actor(orgA, []);
	const viewAllOnly = await actor(orgA, ['incidents:view_all', 'incidents:edit']);
	const viewOwnOnly = await actor(orgA, ['incidents:view_own']);
	const clientViewOwn = await actor(orgA, ['incidents:view_own', 'incidents:create']);
	const techB = await actor(orgB, [VIEW, ADD], { name: 'Técnico B' });
	const blank = await actor(orgA, [ADD], { name: '   ' });

	let incidentNumber = 100000;
	async function incident(organization = orgA, status = 'open', values = {}) {
		const creator = organization.id === orgA.id ? tech : techB;
		const [row] = await db
			.insert(s.incidents)
			.values({
				organizationId: organization.id,
				incidentNumber: ++incidentNumber,
				title: 'Incidencia API notas',
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
		{ id, organizationId = orgA.id, cookie, query = '', body, rawBody } = {}
	) {
		const qs = organizationId === null ? '' : 'organizationId=' + organizationId;
		const url = new URL(`http://localhost/api/incidents/${id}/internal-notes?${qs}${query}`);
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
		return {
			status: response.status,
			json: text ? JSON.parse(text) : null,
			text,
			headers: response.headers
		};
	}
	const get = (options) => request(GET, 'GET', { cookie: tech.cookie, ...options });
	const post = (options) => request(POST, 'POST', { cookie: tech.cookie, ...options });

	async function messagesOf(target) {
		return db.select().from(s.incidentMessages).where(eq(s.incidentMessages.incidentId, target.id));
	}
	async function noteEventsOf(target) {
		return db
			.select()
			.from(s.incidentHistory)
			.where(
				and(
					eq(s.incidentHistory.incidentId, target.id),
					eq(s.incidentHistory.eventType, 'internal_note_added')
				)
			);
	}

	const main = await incident();
	const foreign = await incident(orgB);

	// =========================================================================
	// GET
	// =========================================================================
	await t.test('GET 1-3. sin sesión, sesión inválida o usuario inactivo -> 401', async () => {
		const inactive = await actor(orgA, [VIEW], { active: false });
		for (const cookie of [undefined, createTamperedCookie(), inactive.cookie]) {
			const res = await get({ id: main.id, cookie: cookie ?? '' });
			assert.equal(res.status, 401);
			assert.equal(res.json.error.code, 'UNAUTHORIZED');
		}
		// 401 precede a la validación de query
		const res = await get({ id: main.id, cookie: '', query: '&limit=0' });
		assert.equal(res.status, 401);
	});

	await t.test(
		'GET 4-6. organizationId ausente/inválido o incidentId inválido -> 400',
		async () => {
			for (const options of [
				{ id: main.id, organizationId: null },
				{ id: main.id, organizationId: 'not-a-uuid' },
				{ id: 'not-a-uuid' }
			]) {
				const res = await get(options);
				assert.equal(res.status, 400);
				assert.equal(res.json.error.code, 'INVALID_INPUT');
			}
		}
	);

	await t.test(
		'GET 7-10. sin permiso, otra org, membership inactiva, org no activa -> 403',
		async () => {
			for (const cookie of [none.cookie, writer.cookie, techB.cookie]) {
				const res = await get({ id: main.id, cookie });
				assert.equal(res.status, 403);
				assert.equal(res.json.error.code, 'FORBIDDEN');
			}
			const inactiveMember = await actor(orgA, [VIEW]);
			await db
				.update(s.memberships)
				.set({ active: false })
				.where(eq(s.memberships.id, inactiveMember.membership.id));
			assert.equal((await get({ id: main.id, cookie: inactiveMember.cookie })).status, 403);

			for (const status of ['suspended', 'trial']) {
				const [org] = await db
					.insert(s.organizations)
					.values({ name: 'Org ' + status, slug: randomUUID(), status: 'active' })
					.returning();
				const member = await actor(org, [VIEW]);
				await db.update(s.organizations).set({ status }).where(eq(s.organizations.id, org.id));
				const res = await get({ id: main.id, organizationId: org.id, cookie: member.cookie });
				assert.equal(res.status, 403);
			}
			// 403 precede a la validación de query
			assert.equal(
				(await get({ id: main.id, cookie: none.cookie, query: '&limit=0' })).status,
				403
			);
		}
	);

	await t.test('GET 11-12. incidencia inexistente o cross-tenant -> 404 sin fuga', async () => {
		for (const id of [randomUUID(), foreign.id]) {
			const res = await get({ id });
			assert.equal(res.status, 404);
			assert.equal(res.json.error.code, 'INCIDENT_NOT_FOUND');
			assert.ok(!res.text.includes(orgB.id));
		}
	});

	await t.test('GET 13. lista vacía -> 200', async () => {
		const empty = await incident();
		const res = await get({ id: empty.id });
		assert.equal(res.status, 200);
		assert.deepEqual(res.json, { items: [], nextCursor: null });
		assert.equal(res.headers.get('cache-control'), 'private, no-store');
	});

	await t.test('GET 14-16, 23. devuelve solo internas con DTO seguro', async () => {
		const target = await incident();
		const created = await post({ id: target.id, body: { body: 'Nota interna visible' } });
		assert.equal(created.status, 201);
		await db.insert(s.incidentMessages).values({
			organizationId: orgA.id,
			incidentId: target.id,
			authorUserId: tech.user.id,
			visibility: 'public',
			body: 'Comentario público oculto'
		});
		const res = await get({ id: target.id, cookie: viewer.cookie });
		assert.equal(res.status, 200);
		assert.deepEqual(Object.keys(res.json).sort(), ['items', 'nextCursor']);
		assert.deepEqual(
			res.json.items.map((i) => i.body),
			['Nota interna visible']
		);
		const [item] = res.json.items;
		assert.deepEqual(Object.keys(item).sort(), ['author', 'body', 'createdAt', 'id']);
		assert.deepEqual(item.author, { name: 'Ana Técnica' });
		assert.equal(item.id, created.json.item.id);
		for (const hidden of [
			orgA.id,
			target.id,
			tech.user.id,
			tech.membership.id,
			'visibility',
			'Comentario público',
			'history',
			'permission',
			'membership',
			'session',
			'roles'
		])
			assert.ok(!res.text.includes(hidden), `no debe exponer ${hidden}`);
	});

	await t.test('GET 17. closed permite lectura', async () => {
		const target = await incident();
		await post({ id: target.id, body: { body: 'Antes de cerrar' } });
		await db.update(s.incidents).set({ status: 'closed' }).where(eq(s.incidents.id, target.id));
		const res = await get({ id: target.id });
		assert.equal(res.status, 200);
		assert.deepEqual(
			res.json.items.map((i) => i.body),
			['Antes de cerrar']
		);
	});

	await t.test('GET 18. paginación limit/cursor', async () => {
		const target = await incident();
		for (let i = 0; i < 5; i++) await post({ id: target.id, body: { body: `Nota ${i}` } });
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
		assert.deepEqual(seen, ['Nota 4', 'Nota 3', 'Nota 2', 'Nota 1', 'Nota 0']);
	});

	await t.test(
		'GET 19-22. limit/cursor inválido, query desconocida o duplicada -> 400',
		async () => {
			for (const query of [
				'&limit=0',
				'&limit=101',
				'&limit=abc',
				'&cursor=%%%',
				'&cursor=' + Buffer.from('[]').toString('base64url'),
				'&visibility=public',
				'&incidentId=' + randomUUID(),
				'&limit=2&limit=3',
				'&organizationId=' + orgA.id
			]) {
				const res = await get({ id: main.id, query });
				assert.equal(res.status, 400, query);
				assert.equal(res.json.error.code, 'INVALID_INPUT');
			}
		}
	);

	// =========================================================================
	// POST
	// =========================================================================
	await t.test('POST 24. sin sesión o sesión inválida -> 401', async () => {
		for (const cookie of ['', createTamperedCookie()]) {
			const res = await post({ id: main.id, cookie, rawBody: '{bad' });
			assert.equal(res.status, 401);
		}
		assert.equal((await messagesOf(main)).length, 0);
	});

	await t.test('POST 25-26. sin add_internal_note u otra org -> 403 (antes del body)', async () => {
		for (const cookie of [none.cookie, viewer.cookie, techB.cookie]) {
			const res = await post({ id: main.id, cookie, rawBody: '{bad' });
			assert.equal(res.status, 403);
			assert.equal(res.json.error.code, 'FORBIDDEN');
		}
		assert.equal((await messagesOf(main)).length, 0);
	});

	await t.test('POST 27-37. body malformado o inválido -> 400', async () => {
		const cases = [
			{ rawBody: '{bad json' },
			{ rawBody: '' },
			{ body: 'texto' },
			{ body: ['a'] },
			{ body: null },
			{ body: {} },
			{ body: { body: '' } },
			{ body: { body: '   \n ' } },
			{ body: { body: 42 } },
			{ body: { body: 'x'.repeat(4001) } },
			{ body: { body: 'ok', extra: true } },
			{ body: { body: 'ok', authorUserId: none.user.id } },
			{ body: { body: 'ok', visibility: 'public' } },
			{ body: { body: 'ok', organizationId: orgB.id } },
			{ body: { body: 'ok', incidentId: foreign.id } },
			{ body: { body: 'ok', eventType: 'created' } }
		];
		for (const options of cases) {
			const res = await post({ id: main.id, ...options });
			assert.equal(res.status, 400, JSON.stringify(options).slice(0, 80));
			assert.equal(res.json.error.code, 'INVALID_INPUT');
		}
		// POST no acepta query extra que sustituya params.id
		const res = await post({
			id: main.id,
			query: '&incidentId=' + foreign.id,
			body: { body: 'x' }
		});
		assert.equal(res.status, 400);
		assert.equal((await messagesOf(main)).length, 0);
		assert.equal((await noteEventsOf(main)).length, 0);
	});

	await t.test('POST 32. body de 4000 caracteres -> 201', async () => {
		const res = await post({ id: main.id, body: { body: 'y'.repeat(4000) } });
		assert.equal(res.status, 201);
		assert.equal(res.json.item.body.length, 4000);
	});

	await t.test(
		'POST 38-40, 44-49. crea en open/pending/resolved con auditoría segura',
		async () => {
			for (const status of ['open', 'pending', 'resolved']) {
				const target = await incident(orgA, status);
				const secret = `Secreto ${status} ${randomUUID()}`;
				const res = await post({ id: target.id, cookie: writer.cookie, body: { body: secret } });
				assert.equal(res.status, 201);
				assert.deepEqual(Object.keys(res.json), ['item']);
				assert.deepEqual(Object.keys(res.json.item).sort(), ['author', 'body', 'createdAt', 'id']);
				assert.match(res.json.item.id, UUID_REGEX);
				assert.equal(res.json.item.body, secret);
				assert.ok(!res.text.includes('history'));
				assert.ok(!res.text.includes(writer.user.id));

				const messages = await messagesOf(target);
				assert.equal(messages.length, 1);
				assert.equal(messages[0].authorUserId, writer.user.id);
				assert.equal(messages[0].visibility, 'internal');
				assert.equal(messages[0].organizationId, orgA.id);

				const events = await noteEventsOf(target);
				assert.equal(events.length, 1);
				assert.equal(events[0].actorUserId, writer.user.id);
				assert.deepEqual(events[0].payload, { messageId: res.json.item.id });
				assert.equal(events[0].comment, null);
				assert.equal(events[0].reason, null);
				assert.ok(!JSON.stringify(events[0]).includes(secret));
			}
		}
	);

	await t.test('POST 41. closed -> 409 sin persistir', async () => {
		const target = await incident(orgA, 'closed');
		const res = await post({ id: target.id, body: { body: 'No entra' } });
		assert.equal(res.status, 409);
		assert.deepEqual(res.json, {
			error: {
				code: 'INCIDENT_CLOSED',
				message: 'No se pueden añadir notas internas a una incidencia cerrada.'
			}
		});
		assert.equal((await messagesOf(target)).length, 0);
		assert.equal((await noteEventsOf(target)).length, 0);
	});

	await t.test('POST 42-43. incidencia inexistente o cross-tenant -> 404', async () => {
		for (const id of [randomUUID(), foreign.id]) {
			const res = await post({ id, body: { body: 'Nota' } });
			assert.equal(res.status, 404);
			assert.equal(res.json.error.code, 'INCIDENT_NOT_FOUND');
			assert.ok(!res.text.includes(orgB.id));
		}
		assert.equal((await messagesOf(foreign)).length, 0);
	});

	await t.test('POST 50-52. HTML literal, nombre legible y fallback', async () => {
		const target = await incident();
		const html = '<script>alert(1)</script><b>x</b>';
		const res = await post({ id: target.id, body: { body: html } });
		assert.equal(res.status, 201);
		assert.equal(res.json.item.body, html);
		assert.deepEqual(res.json.item.author, { name: 'Ana Técnica' });

		const anonymous = await post({ id: target.id, cookie: blank.cookie, body: { body: 'Anon' } });
		assert.equal(anonymous.status, 201);
		assert.deepEqual(anonymous.json.item.author, { name: 'Usuario no disponible' });
	});

	await t.test('POST 53. no hay PUT/PATCH/DELETE definidos', async () => {
		assert.deepEqual(Object.keys(route).sort(), ['GET', 'POST']);
	});

	// =========================================================================
	// Regresiones clave
	// =========================================================================
	await t.test('REG. view_all/view_own/cliente sin permiso explícito -> 403', async () => {
		for (const who of [viewAllOnly, viewOwnOnly, clientViewOwn]) {
			assert.equal((await get({ id: main.id, cookie: who.cookie })).status, 403);
			assert.equal(
				(await post({ id: main.id, cookie: who.cookie, body: { body: 'x' } })).status,
				403
			);
		}
		// Aun asignada al usuario view_own, no concede notas internas
		const assigned = await incident(orgA, 'open', { assignedToUserId: viewOwnOnly.user.id });
		assert.equal((await get({ id: assigned.id, cookie: viewOwnOnly.cookie })).status, 403);
	});

	await t.test('REG. /history sigue excluyendo internal_note_added', async () => {
		const target = await incident();
		const created = await post({ id: target.id, body: { body: 'NOTA-SECRETA-HISTORY' } });
		assert.equal(created.status, 201);
		assert.equal((await noteEventsOf(target)).length, 1);
		const url = new URL(
			`http://localhost/api/incidents/${target.id}/history?organizationId=${orgA.id}`
		);
		const response = await historyGET({
			url,
			params: { id: target.id },
			request: new Request(url, { headers: { cookie: viewAllOnly.cookie } })
		});
		assert.equal(response.status, 200);
		const text = await response.text();
		assert.ok(!text.includes('internal_note_added'));
		assert.ok(!text.includes('NOTA-SECRETA-HISTORY'));
		assert.ok(!text.includes(created.json.item.id));
	});

	await t.test('REG. detalle y creación de incidencia siguen sin history', async () => {
		const url = new URL(`http://localhost/api/incidents/${main.id}?organizationId=${orgA.id}`);
		const response = await detailGET({
			url,
			params: { id: main.id },
			request: new Request(url, { headers: { cookie: viewAllOnly.cookie } })
		});
		assert.equal(response.status, 200);
		const detail = await response.json();
		assert.deepEqual(Object.keys(detail), ['incident']);

		const creator = await actor(orgA, ['incidents:create']);
		const createUrl = new URL('http://localhost/api/incidents');
		const createdResponse = await createPOST({
			url: createUrl,
			request: new Request(createUrl, {
				method: 'POST',
				headers: { cookie: creator.cookie, 'content-type': 'application/json' },
				body: JSON.stringify({
					organizationId: orgA.id,
					title: 'Nueva',
					description: 'Desc',
					client: 'Cliente'
				})
			})
		});
		assert.equal(createdResponse.status, 201);
		const createdBody = await createdResponse.json();
		assert.ok(!('history' in createdBody));
	});

	await t.test('REG. queue=mine con view_own sin cambios', async () => {
		const mine = await incident(orgA, 'open', { assignedToUserId: viewOwnOnly.user.id });
		const other = await incident(orgA, 'open', { assignedToUserId: tech.user.id });
		const url = new URL(`http://localhost/api/incidents?organizationId=${orgA.id}&queue=mine`);
		const response = await listGET({
			url,
			request: new Request(url, { headers: { cookie: viewOwnOnly.cookie } })
		});
		assert.equal(response.status, 200);
		const { incidents } = await response.json();
		assert.ok(incidents.every((i) => i.assignedToUserId === viewOwnOnly.user.id));
		assert.ok(incidents.some((i) => i.id === mine.id));
		assert.ok(!incidents.some((i) => i.id === other.id));
	});
});

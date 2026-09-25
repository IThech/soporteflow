import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
	listIncidentComments,
	createIncidentComment,
	listIncidentInternalNotes,
	createIncidentInternalNote,
	IncidentApiError
} from '../src/lib/api/incidents.ts';
import {
	fixture,
	createCredentialUser,
	createSession,
	grantPermission
} from './helpers/auth-fixture.mjs';

const ORG = randomUUID();
const INCIDENT = randomUUID();
const CURSOR = Buffer.from(JSON.stringify(['2026-01-01T00:00:00.000001Z', randomUUID()])).toString(
	'base64url'
);

function item(overrides = {}) {
	return {
		id: randomUUID(),
		body: 'Texto',
		createdAt: '2026-05-01T10:20:30.123456Z',
		author: { name: 'Ana' },
		...overrides
	};
}

/** Records every call and answers with the given Response factory. */
function mockFetch(respond) {
	const calls = [];
	const fetchFn = async (url, init) => {
		calls.push({ url, init });
		return typeof respond === 'function' ? respond(url, init) : respond;
	};
	return { fetchFn, calls };
}

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

async function rejectsWith(promise, { status, code }) {
	await assert.rejects(promise, (error) => {
		assert.ok(error instanceof IncidentApiError, `esperado IncidentApiError: ${error}`);
		if (status !== undefined) assert.equal(error.status, status);
		assert.equal(error.code, code);
		return true;
	});
}

const clients = [
	{
		name: 'comments',
		path: 'comments',
		list: listIncidentComments,
		create: createIncidentComment
	},
	{
		name: 'internal-notes',
		path: 'internal-notes',
		list: listIncidentInternalNotes,
		create: createIncidentInternalNote
	}
];

test('SoporteFlow — Etapa 5.4N-F: cliente API de mensajes', async (t) => {
	for (const client of clients) {
		// =====================================================================
		// LIST (1-17 comments, 31-35 internal notes)
		// =====================================================================
		await t.test(`${client.name} LIST 1-7. URL, query, método y signal`, async () => {
			const { fetchFn, calls } = mockFetch(() => json({ items: [], nextCursor: null }));
			const controller = new AbortController();
			await client.list({
				organizationId: ORG,
				incidentId: INCIDENT,
				signal: controller.signal,
				customFetch: fetchFn
			});
			await client.list({
				organizationId: ORG,
				incidentId: INCIDENT,
				limit: 25,
				cursor: CURSOR,
				customFetch: fetchFn
			});
			const [plain, paged] = calls;
			assert.equal(plain.url, `/api/incidents/${INCIDENT}/${client.path}?organizationId=${ORG}`);
			assert.equal(plain.init.method, 'GET');
			assert.equal(plain.init.signal, controller.signal);
			assert.equal(plain.init.body, undefined);
			const url = new URL(paged.url, 'http://localhost');
			assert.equal(url.pathname, `/api/incidents/${INCIDENT}/${client.path}`);
			assert.deepEqual(Object.fromEntries(url.searchParams), {
				organizationId: ORG,
				limit: '25',
				cursor: CURSOR
			});
			// Sin cabeceras de identidad/tenant
			for (const call of calls) assert.equal(call.init.headers, undefined);
		});

		await t.test(`${client.name} LIST 8-11. respuestas válidas`, async () => {
			const items = [
				item({ body: '<script>alert(1)</script>' }),
				item({ author: { name: 'Usuario no disponible' } })
			];
			for (const [payload, expected] of [
				[
					{ items, nextCursor: CURSOR },
					{ items, nextCursor: CURSOR }
				],
				[
					{ items: [], nextCursor: null },
					{ items: [], nextCursor: null }
				]
			]) {
				const { fetchFn } = mockFetch(() => json(payload));
				const page = await client.list({
					organizationId: ORG,
					incidentId: INCIDENT,
					customFetch: fetchFn
				});
				assert.deepEqual(page, expected);
			}
		});

		await t.test(`${client.name} LIST 12-16. payload inválido rechazado`, async () => {
			const invalid = [
				null,
				[],
				{},
				{ nextCursor: null },
				{ items: 'x', nextCursor: null },
				{ items: [], nextCursor: 42 },
				{ items: [], nextCursor: '' },
				{ items: [], nextCursor: 'bad cursor!' },
				{ items: [], nextCursor: undefined },
				{ items: [null], nextCursor: null },
				{ items: [item({ id: 'not-a-uuid' })], nextCursor: null },
				{ items: [item({ id: 42 })], nextCursor: null },
				{ items: [item({ body: '' })], nextCursor: null },
				{ items: [item({ body: 'x'.repeat(4001) })], nextCursor: null },
				{ items: [item({ body: null })], nextCursor: null },
				{ items: [item({ createdAt: '2026-05-01' })], nextCursor: null },
				{ items: [item({ createdAt: '2026-05-01T10:20:30.123Z' })], nextCursor: null },
				{ items: [item({ createdAt: '2026-13-45T10:20:30.123456Z' })], nextCursor: null },
				{ items: [item({ createdAt: 1714558830 })], nextCursor: null },
				{ items: [item({ author: null })], nextCursor: null },
				{ items: [item({ author: 'Ana' })], nextCursor: null },
				{ items: [item({ author: {} })], nextCursor: null },
				{ items: [item({ author: { name: '   ' } })], nextCursor: null },
				{ items: [item({ author: { name: 7 } })], nextCursor: null }
			];
			const duplicated = item();
			invalid.push({ items: [duplicated, duplicated], nextCursor: null });
			for (const payload of invalid) {
				const { fetchFn } = mockFetch(() => json(payload));
				await rejectsWith(
					client.list({ organizationId: ORG, incidentId: INCIDENT, customFetch: fetchFn }),
					{ status: 200, code: 'INVALID_PAYLOAD' }
				);
			}
			const { fetchFn } = mockFetch(() => new Response('not json', { status: 200 }));
			await rejectsWith(
				client.list({ organizationId: ORG, incidentId: INCIDENT, customFetch: fetchFn }),
				{ code: 'INVALID_PAYLOAD' }
			);
		});

		await t.test(`${client.name} LIST 17. campos extra sensibles se descartan`, async () => {
			const raw = {
				...item(),
				organizationId: ORG,
				incidentId: INCIDENT,
				authorUserId: randomUUID(),
				visibility: 'internal',
				roles: ['admin'],
				permissions: ['x'],
				membership: {},
				session: 'tok',
				history: [],
				author: { name: 'Ana', id: randomUUID(), email: 'ana@example.test' }
			};
			const { fetchFn } = mockFetch(() =>
				json({ items: [raw], nextCursor: null, history: [], total: 9 })
			);
			const page = await client.list({
				organizationId: ORG,
				incidentId: INCIDENT,
				customFetch: fetchFn
			});
			assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor']);
			assert.deepEqual(Object.keys(page.items[0]).sort(), ['author', 'body', 'createdAt', 'id']);
			assert.deepEqual(page.items[0].author, { name: 'Ana' });
			const serialized = JSON.stringify(page);
			for (const hidden of [ORG, INCIDENT, raw.authorUserId, 'visibility', 'ana@example.test'])
				assert.ok(!serialized.includes(hidden));
		});

		await t.test(`${client.name} LIST entrada inválida no llama a fetch`, async () => {
			const { fetchFn, calls } = mockFetch(() => json({ items: [], nextCursor: null }));
			const bad = [
				{ organizationId: 'x', incidentId: INCIDENT },
				{ organizationId: ORG, incidentId: '../x' },
				{ organizationId: ORG, incidentId: INCIDENT, limit: 0 },
				{ organizationId: ORG, incidentId: INCIDENT, limit: 101 },
				{ organizationId: ORG, incidentId: INCIDENT, limit: 1.5 },
				{ organizationId: ORG, incidentId: INCIDENT, cursor: '' },
				{ organizationId: ORG, incidentId: INCIDENT, cursor: 'a&visibility=internal' }
			];
			for (const input of bad)
				await rejectsWith(client.list({ ...input, customFetch: fetchFn }), {
					status: 0,
					code: 'INVALID_INPUT'
				});
			assert.equal(calls.length, 0);
			// visibility no es parametrizable: se ignora aunque se pase
			await client.list({
				organizationId: ORG,
				incidentId: INCIDENT,
				visibility: 'public',
				customFetch: fetchFn
			});
			assert.ok(!calls[0].url.includes('visibility'));
		});

		// =====================================================================
		// CREATE (18-30 comments, 36-42 internal notes)
		// =====================================================================
		await t.test(`${client.name} CREATE 18-21, 36-38, 41-42. request exacta y 201`, async () => {
			const created = item({ body: '<b>hola</b> & <script>x</script>' });
			const { fetchFn, calls } = mockFetch(() => json({ item: created }, 201));
			const controller = new AbortController();
			const result = await client.create({
				organizationId: ORG,
				incidentId: INCIDENT,
				body: created.body,
				signal: controller.signal,
				customFetch: fetchFn,
				// Campos que un caller malicioso podría intentar colar: se ignoran
				authorUserId: randomUUID(),
				visibility: 'public',
				eventType: 'created'
			});
			assert.deepEqual(result, created);
			const [call] = calls;
			assert.equal(call.url, `/api/incidents/${INCIDENT}/${client.path}?organizationId=${ORG}`);
			assert.equal(call.init.method, 'POST');
			assert.deepEqual(call.init.headers, { 'Content-Type': 'application/json' });
			assert.equal(call.init.body, JSON.stringify({ body: created.body }));
			assert.deepEqual(JSON.parse(call.init.body), { body: created.body });
			assert.equal(call.init.signal, controller.signal);
		});

		await t.test(`${client.name} CREATE 22, 40. payload inválido o con history`, async () => {
			for (const payload of [
				{},
				{ item: null },
				{ items: [item()] },
				{ item: item({ id: 'x' }) },
				{ item: item({ createdAt: 'yesterday' }) }
			]) {
				const { fetchFn } = mockFetch(() => json(payload, 201));
				await rejectsWith(
					client.create({
						organizationId: ORG,
						incidentId: INCIDENT,
						body: 'x',
						customFetch: fetchFn
					}),
					{ status: 201, code: 'INVALID_PAYLOAD' }
				);
			}
			// history adicional en la respuesta no forma parte del contrato devuelto
			const created = item();
			const { fetchFn } = mockFetch(() =>
				json({ item: { ...created, history: [{ eventType: 'x' }] }, history: [] }, 201)
			);
			const result = await client.create({
				organizationId: ORG,
				incidentId: INCIDENT,
				body: 'x',
				customFetch: fetchFn
			});
			assert.deepEqual(Object.keys(result).sort(), ['author', 'body', 'createdAt', 'id']);
		});

		await t.test(`${client.name} CREATE 23-28, 39. errores HTTP tipados y seguros`, async () => {
			const secret = 'SELECT * FROM incident_messages -- stack at /srv/app.js';
			const cases = [
				[400, { error: { code: 'INVALID_INPUT', message: secret } }, 'INVALID_INPUT'],
				[401, { error: { code: 'UNAUTHORIZED', message: secret } }, 'UNAUTHORIZED'],
				[403, { error: { code: 'FORBIDDEN', message: secret } }, 'FORBIDDEN'],
				[404, { error: { code: 'INCIDENT_NOT_FOUND', message: secret } }, 'NOT_FOUND'],
				[409, { error: { code: 'INCIDENT_CLOSED', message: secret } }, 'INCIDENT_CLOSED'],
				[409, { error: { code: 'OTHER', message: secret } }, 'CONFLICT'],
				[409, 'not json', 'CONFLICT'],
				[500, { error: { code: 'INTERNAL_ERROR', message: secret } }, 'SERVER_ERROR'],
				[503, 'gateway', 'SERVER_ERROR'],
				[418, {}, 'INTERNAL_ERROR']
			];
			for (const [status, body, code] of cases) {
				for (const call of [
					(fetchFn) =>
						client.create({
							organizationId: ORG,
							incidentId: INCIDENT,
							body: 'x',
							customFetch: fetchFn
						}),
					(fetchFn) =>
						client.list({ organizationId: ORG, incidentId: INCIDENT, customFetch: fetchFn })
				]) {
					const { fetchFn } = mockFetch(
						() => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
					);
					await assert.rejects(call(fetchFn), (error) => {
						assert.ok(error instanceof IncidentApiError);
						assert.equal(error.status, status);
						assert.equal(error.code, code);
						assert.ok(!error.message.includes('SELECT'));
						assert.ok(!error.message.includes('/srv/'));
						assert.ok(!JSON.stringify(error).includes('SELECT'));
						return true;
					});
				}
			}
		});

		await t.test(`${client.name} CREATE 29-30. network y AbortError`, async () => {
			const network = mockFetch(() => {
				throw new TypeError('fetch failed');
			});
			await rejectsWith(
				client.create({
					organizationId: ORG,
					incidentId: INCIDENT,
					body: 'x',
					customFetch: network.fetchFn
				}),
				{ status: 0, code: 'NETWORK_ERROR' }
			);
			await rejectsWith(
				client.list({ organizationId: ORG, incidentId: INCIDENT, customFetch: network.fetchFn }),
				{ status: 0, code: 'NETWORK_ERROR' }
			);

			const controller = new AbortController();
			const abortable = mockFetch((url, init) => {
				assert.equal(init.signal, controller.signal);
				controller.abort();
				throw new DOMException('The operation was aborted.', 'AbortError');
			});
			for (const call of [
				() =>
					client.create({
						organizationId: ORG,
						incidentId: INCIDENT,
						body: 'x',
						signal: controller.signal,
						customFetch: abortable.fetchFn
					}),
				() =>
					client.list({
						organizationId: ORG,
						incidentId: INCIDENT,
						signal: controller.signal,
						customFetch: abortable.fetchFn
					})
			]) {
				await assert.rejects(call(), (error) => {
					assert.ok(!(error instanceof IncidentApiError));
					assert.equal(error.name, 'AbortError');
					return true;
				});
			}
		});

		await t.test(`${client.name} CREATE body no string no llama a fetch`, async () => {
			const { fetchFn, calls } = mockFetch(() => json({ item: item() }, 201));
			for (const body of [undefined, null, 42, { body: 'x' }])
				await rejectsWith(
					client.create({ organizationId: ORG, incidentId: INCIDENT, body, customFetch: fetchFn }),
					{ status: 0, code: 'INVALID_INPUT' }
				);
			assert.equal(calls.length, 0);
		});
	}

	// =========================================================================
	// Regresiones 43-50
	// =========================================================================
	await t.test(
		'43-47. código fuente: sin storage, demo, cabeceras de identidad ni visibility',
		async () => {
			const source = fs.readFileSync(
				new URL('../src/lib/api/incidents.ts', import.meta.url),
				'utf8'
			);
			const block = source.slice(source.indexOf('Incident messages: public comments'));
			assert.ok(block.length > 1000);
			for (const forbidden of [
				'localStorage',
				'sessionStorage',
				'demo',
				'activeUser',
				'clientUserId',
				'x-user-id',
				'x-organization-id',
				'authorUserId',
				'visibility',
				'{@html',
				'innerHTML'
			])
				assert.ok(!block.includes(forbidden), `no debe contener ${forbidden}`);
			assert.ok(!/^import /m.test(source), 'el cliente no importa módulos (ni demo ni stores)');
			assert.equal(
				fs.readdirSync(new URL('../src', import.meta.url), { recursive: true }).filter((file) => {
					if (!/\.(svelte|ts)$/.test(file)) return false;
					return fs
						.readFileSync(new URL('../src/' + file.split('\\').join('/'), import.meta.url), 'utf8')
						.includes('{@html');
				}).length,
				0
			);
		}
	);

	await t.test('46. comments e internal-notes usan endpoints distintos', async () => {
		const seen = [];
		const fetchFn = async (url, init) => {
			seen.push(new URL(url, 'http://localhost').pathname);
			return init.method === 'POST'
				? json({ item: item() }, 201)
				: json({ items: [], nextCursor: null });
		};
		const base = { organizationId: ORG, incidentId: INCIDENT, customFetch: fetchFn };
		await listIncidentComments(base);
		await createIncidentComment({ ...base, body: 'x' });
		await listIncidentInternalNotes(base);
		await createIncidentInternalNote({ ...base, body: 'x' });
		assert.deepEqual(seen, [
			`/api/incidents/${INCIDENT}/comments`,
			`/api/incidents/${INCIDENT}/comments`,
			`/api/incidents/${INCIDENT}/internal-notes`,
			`/api/incidents/${INCIDENT}/internal-notes`
		]);
	});

	await t.test('48-49. createdAt permanece string y el body no se transforma', async () => {
		const created = item({
			body: '  <img src=x onerror=alert(1)> &amp; \n',
			createdAt: '2026-05-01T10:20:30.999999Z'
		});
		const { fetchFn } = mockFetch(() => json({ items: [created], nextCursor: null }));
		const page = await listIncidentComments({
			organizationId: ORG,
			incidentId: INCIDENT,
			customFetch: fetchFn
		});
		assert.equal(typeof page.items[0].createdAt, 'string');
		assert.equal(page.items[0].createdAt, '2026-05-01T10:20:30.999999Z');
		assert.equal(page.items[0].body, created.body);
	});

	// =========================================================================
	// Contrato real extremo a extremo contra los handlers
	// =========================================================================
	await t.test('E2E. el cliente consume los endpoints reales', async (st) => {
		const f = await fixture(st);
		const { db, schema: s, server } = f;
		const routes = {
			comments: await server.ssrLoadModule('/src/routes/api/incidents/[id]/comments/+server.ts'),
			'internal-notes': await server.ssrLoadModule(
				'/src/routes/api/incidents/[id]/internal-notes/+server.ts'
			)
		};
		const [org] = await db
			.insert(s.organizations)
			.values({ name: 'Client E2E', slug: randomUUID(), status: 'active' })
			.returning();
		const user = await createCredentialUser(f, { name: 'Técnica E2E' });
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
		for (const permissionId of [
			'incidents:view_all',
			'incidents:add_comment',
			'incidents:view_internal_notes',
			'incidents:add_internal_note'
		])
			await grantPermission(f, {
				organizationId: org.id,
				membershipId: membership.id,
				permissionId
			});
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		const [incident] = await db
			.insert(s.incidents)
			.values({
				organizationId: org.id,
				incidentNumber: 1,
				title: 'E2E',
				description: 'E2E',
				client: 'E2E',
				createdByUserId: user.id
			})
			.returning();

		// Puente fetch -> handler real; la cookie la añade el "navegador", no el cliente
		const bridge = async (url, init = {}) => {
			const parsed = new URL(url, 'http://localhost');
			const [, , , id, endpoint] = parsed.pathname.split('/');
			const headers = new Headers(init.headers);
			headers.set('cookie', session.cookieHeader);
			const request = new Request(parsed, { method: init.method, headers, body: init.body });
			return routes[endpoint][init.method]({ url: parsed, params: { id }, request });
		};
		const base = { organizationId: org.id, incidentId: incident.id, customFetch: bridge };

		const comment = await createIncidentComment({ ...base, body: '<script>c</script>' });
		const note = await createIncidentInternalNote({ ...base, body: 'Nota E2E' });
		assert.equal(comment.body, '<script>c</script>');
		assert.deepEqual(comment.author, { name: 'Técnica E2E' });

		const comments = await listIncidentComments(base);
		const notes = await listIncidentInternalNotes(base);
		assert.deepEqual(
			comments.items.map((i) => i.id),
			[comment.id]
		);
		assert.deepEqual(
			notes.items.map((i) => i.id),
			[note.id]
		);

		for (let i = 0; i < 3; i++) await createIncidentComment({ ...base, body: `C${i}` });
		const first = await listIncidentComments({ ...base, limit: 2 });
		assert.equal(first.items.length, 2);
		assert.equal(typeof first.nextCursor, 'string');
		const second = await listIncidentComments({ ...base, limit: 2, cursor: first.nextCursor });
		assert.deepEqual(
			[...first.items, ...second.items].map((i) => i.body),
			['C2', 'C1', 'C0', '<script>c</script>']
		);
		assert.equal(second.nextCursor, null);

		await db.update(s.incidents).set({ status: 'closed' }).where(eq(s.incidents.id, incident.id));
		await rejectsWith(createIncidentComment({ ...base, body: 'x' }), {
			status: 409,
			code: 'INCIDENT_CLOSED'
		});
		await rejectsWith(createIncidentInternalNote({ ...base, body: 'x' }), {
			status: 409,
			code: 'INCIDENT_CLOSED'
		});
		await rejectsWith(createIncidentComment({ ...base, body: '   ' }), {
			status: 400,
			code: 'INVALID_INPUT'
		});
		await rejectsWith(listIncidentComments({ ...base, incidentId: randomUUID() }), {
			status: 404,
			code: 'NOT_FOUND'
		});
		const anonymous = async (url, init = {}) => {
			const parsed = new URL(url, 'http://localhost');
			const [, , , id, endpoint] = parsed.pathname.split('/');
			const request = new Request(parsed, { method: init.method, headers: init.headers });
			return routes[endpoint][init.method]({ url: parsed, params: { id }, request });
		};
		await rejectsWith(listIncidentInternalNotes({ ...base, customFetch: anonymous }), {
			status: 401,
			code: 'UNAUTHORIZED'
		});
	});
});

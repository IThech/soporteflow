import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
	listCategories,
	createCategory,
	updateCategory,
	setCategoryActive,
	CategoryApiError
} from '../src/lib/api/categories.ts';
import {
	listIncidents,
	getIncident,
	createIncident,
	updateIncidentCategory,
	IncidentApiError
} from '../src/lib/api/incidents.ts';
import {
	fixture,
	createCredentialUser,
	createSession,
	grantPermission
} from './helpers/auth-fixture.mjs';

const ORG = randomUUID();
const CATEGORY = randomUUID();
const INCIDENT = randomUUID();

function category(overrides = {}) {
	return {
		id: randomUUID(),
		name: 'Hardware',
		description: null,
		active: true,
		createdAt: '2026-05-01T10:20:30.123Z',
		updatedAt: '2026-05-02T10:20:30.123Z',
		...overrides
	};
}

function incident(overrides = {}) {
	return {
		id: INCIDENT,
		organizationId: ORG,
		incidentNumber: 1,
		title: 'T',
		description: 'D',
		status: 'open',
		priority: 'medium',
		supportLevel: 'N1',
		client: 'C',
		clientUserId: null,
		createdByUserId: randomUUID(),
		siteId: null,
		assignedToUserId: null,
		teamId: null,
		categoryId: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides
	};
}

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function mockFetch(respond) {
	const calls = [];
	const fetchFn = async (url, init) => {
		calls.push({ url, init });
		return typeof respond === 'function' ? respond(url, init) : respond;
	};
	return { fetchFn, calls };
}

async function rejectsWith(promise, { status, code, type = CategoryApiError }) {
	await assert.rejects(promise, (error) => {
		assert.ok(error instanceof type, `esperado ${type.name}: ${error}`);
		if (status !== undefined) assert.equal(error.status, status);
		assert.equal(error.code, code);
		return true;
	});
}

test('SoporteFlow — Etapa 5.4P-D: clientes API de categorías', async (t) => {
	// =========================================================================
	// Cliente de categorías
	// =========================================================================
	await t.test(
		'1-4, 30-33. list: vacío, varias, activeOnly, URL, signal y customFetch',
		async () => {
			const many = [
				category({ name: 'Hardware' }),
				category({ name: 'Software', active: false, description: 'Apps' })
			];
			const { fetchFn, calls } = mockFetch(() =>
				json({ categories: calls.length === 1 ? [] : many })
			);
			const controller = new AbortController();
			assert.deepEqual(
				await listCategories({
					organizationId: ORG,
					customFetch: fetchFn,
					signal: controller.signal
				}),
				[]
			);
			assert.deepEqual(await listCategories({ organizationId: ORG, customFetch: fetchFn }), many);
			await listCategories({ organizationId: ORG, activeOnly: true, customFetch: fetchFn });
			await listCategories({ organizationId: ORG, activeOnly: false, customFetch: fetchFn });
			assert.equal(calls[0].url, `/api/categories?organizationId=${ORG}`);
			assert.equal(calls[0].init.method, 'GET');
			assert.equal(calls[0].init.signal, controller.signal);
			assert.equal(calls[0].init.body, undefined);
			assert.equal(calls[0].init.headers, undefined);
			assert.equal(calls[2].url, `/api/categories?organizationId=${ORG}&activeOnly=true`);
			assert.equal(calls[3].url, `/api/categories?organizationId=${ORG}&activeOnly=false`);
		}
	);

	await t.test('5-12, 34-37. create/update/set_active: bodies exactos y seguros', async () => {
		const created = category();
		const { fetchFn, calls } = mockFetch((url, init) =>
			json({ category: created }, init.method === 'POST' ? 201 : 200)
		);
		const extra = {
			active: false,
			id: randomUUID(),
			organizationIdInBody: ORG,
			actorUserId: randomUUID(),
			color: 'red'
		};
		assert.deepEqual(
			await createCategory({
				organizationId: ORG,
				name: ' Hardware ',
				customFetch: fetchFn,
				...extra
			}),
			created
		);
		await createCategory({
			organizationId: ORG,
			name: 'Sin desc',
			description: undefined,
			customFetch: fetchFn
		});
		await createCategory({
			organizationId: ORG,
			name: 'Nula',
			description: null,
			customFetch: fetchFn
		});
		await createCategory({
			organizationId: ORG,
			name: 'Con',
			description: 'Texto',
			customFetch: fetchFn
		});
		await updateCategory({
			organizationId: ORG,
			categoryId: CATEGORY,
			name: 'Nuevo',
			customFetch: fetchFn,
			...extra
		});
		await updateCategory({
			organizationId: ORG,
			categoryId: CATEGORY,
			description: null,
			customFetch: fetchFn
		});
		await updateCategory({
			organizationId: ORG,
			categoryId: CATEGORY,
			name: 'Ambos',
			description: 'D',
			customFetch: fetchFn
		});
		await setCategoryActive({
			organizationId: ORG,
			categoryId: CATEGORY,
			active: false,
			customFetch: fetchFn,
			name: 'x'
		});
		await setCategoryActive({
			organizationId: ORG,
			categoryId: CATEGORY,
			active: true,
			customFetch: fetchFn
		});
		const bodies = calls.map((c) => JSON.parse(c.init.body));
		assert.deepEqual(bodies, [
			{ name: ' Hardware ' },
			{ name: 'Sin desc' },
			{ name: 'Nula', description: null },
			{ name: 'Con', description: 'Texto' },
			{ action: 'update', name: 'Nuevo' },
			{ action: 'update', description: null },
			{ action: 'update', name: 'Ambos', description: 'D' },
			{ action: 'set_active', active: false },
			{ action: 'set_active', active: true }
		]);
		for (const call of calls.slice(0, 4)) {
			assert.equal(call.url, `/api/categories?organizationId=${ORG}`);
			assert.equal(call.init.method, 'POST');
		}
		for (const call of calls.slice(4)) {
			assert.equal(call.url, `/api/categories/${CATEGORY}?organizationId=${ORG}`);
			assert.equal(call.init.method, 'PATCH');
		}
		for (const call of calls) {
			assert.deepEqual(call.init.headers, { 'Content-Type': 'application/json' });
			for (const forbidden of ['organizationId', 'actorUserId', 'color', '"id"', 'x-user-id'])
				assert.ok(!call.init.body.includes(forbidden), forbidden);
		}
	});

	await t.test('13-15. entrada inválida no llama a fetch', async () => {
		const { fetchFn, calls } = mockFetch(() => json({ categories: [] }));
		const bad = [
			() => listCategories({ organizationId: 'x', customFetch: fetchFn }),
			() => listCategories({ organizationId: ORG, activeOnly: 'true', customFetch: fetchFn }),
			() => createCategory({ organizationId: ORG, name: '  ', customFetch: fetchFn }),
			() => createCategory({ organizationId: ORG, name: 5, customFetch: fetchFn }),
			() =>
				createCategory({ organizationId: ORG, name: 'Ok', description: 5, customFetch: fetchFn }),
			() => createCategory({ organizationId: '../x', name: 'Ok', customFetch: fetchFn }),
			() =>
				updateCategory({
					organizationId: ORG,
					categoryId: 'nope',
					name: 'Ok',
					customFetch: fetchFn
				}),
			() =>
				updateCategory({
					organizationId: ORG,
					categoryId: '../../x',
					name: 'Ok',
					customFetch: fetchFn
				}),
			() => updateCategory({ organizationId: ORG, categoryId: CATEGORY, customFetch: fetchFn }),
			() =>
				updateCategory({
					organizationId: ORG,
					categoryId: CATEGORY,
					name: '',
					customFetch: fetchFn
				}),
			() =>
				updateCategory({
					organizationId: ORG,
					categoryId: CATEGORY,
					description: 5,
					customFetch: fetchFn
				}),
			() =>
				setCategoryActive({
					organizationId: ORG,
					categoryId: CATEGORY,
					active: 'false',
					customFetch: fetchFn
				}),
			() => setCategoryActive({ organizationId: ORG, categoryId: CATEGORY, customFetch: fetchFn })
		];
		for (const run of bad) await rejectsWith(run(), { status: 0, code: 'INVALID_INPUT' });
		assert.equal(calls.length, 0);
	});

	await t.test(
		'16-21. payload inválido -> INVALID_PAYLOAD; extras y organizationId descartados',
		async () => {
			const invalid = [
				null,
				[],
				{},
				{ categories: 'x' },
				{ categories: [null] },
				{ categories: [category({ id: 'x' })] },
				{ categories: [category({ name: '' })] },
				{ categories: [category({ name: 'x'.repeat(101) })] },
				{ categories: [category({ description: 5 })] },
				{ categories: [category({ description: 'd'.repeat(1001) })] },
				{ categories: [category({ active: 'true' })] },
				{ categories: [category({ createdAt: 'ayer' })] },
				{ categories: [category({ updatedAt: '2026-13-45T00:00:00.000Z' })] }
			];
			const dup = category();
			invalid.push({ categories: [dup, dup] });
			for (const payload of invalid) {
				const { fetchFn } = mockFetch(() => json(payload));
				await rejectsWith(listCategories({ organizationId: ORG, customFetch: fetchFn }), {
					status: 200,
					code: 'INVALID_PAYLOAD'
				});
			}
			for (const payload of [{}, { category: null }, { category: category({ id: 1 }) }]) {
				const { fetchFn } = mockFetch(() => json(payload, 201));
				await rejectsWith(
					createCategory({ organizationId: ORG, name: 'Ok', customFetch: fetchFn }),
					{ code: 'INVALID_PAYLOAD' }
				);
			}
			const raw = {
				...category(),
				organizationId: ORG,
				routing: {},
				defaultTeamId: randomUUID(),
				defaultSupportLevel: 'N2',
				classification: 'x',
				subcategory: 'x',
				color: 'red',
				icon: 'x'
			};
			const { fetchFn } = mockFetch(() => json({ categories: [raw], organizationId: ORG }));
			const [parsed] = await listCategories({ organizationId: ORG, customFetch: fetchFn });
			assert.deepEqual(Object.keys(parsed).sort(), [
				'active',
				'createdAt',
				'description',
				'id',
				'name',
				'updatedAt'
			]);
			assert.ok(!JSON.stringify(parsed).includes(ORG));
		}
	);

	await t.test('22-27. errores HTTP tipados con mensajes fijos', async () => {
		const secret =
			'duplicate key value violates unique constraint "categories_org_normalized_name_unique_idx"';
		const cases = [
			[400, { error: { code: 'INVALID_INPUT', message: secret } }, 'INVALID_INPUT'],
			[401, { error: { code: 'UNAUTHORIZED', message: secret } }, 'UNAUTHORIZED'],
			[403, { error: { code: 'FORBIDDEN', message: secret } }, 'FORBIDDEN'],
			[404, { error: { code: 'CATEGORY_NOT_FOUND', message: secret } }, 'CATEGORY_NOT_FOUND'],
			[404, 'not json', 'NOT_FOUND'],
			[
				409,
				{ error: { code: 'CATEGORY_NAME_DUPLICATE', message: secret } },
				'CATEGORY_NAME_DUPLICATE'
			],
			[409, { error: { code: 'OTHER' } }, 'CONFLICT'],
			[500, { error: { code: 'INTERNAL_ERROR', message: secret } }, 'SERVER_ERROR'],
			[418, {}, 'INTERNAL_ERROR']
		];
		for (const [status, body, code] of cases) {
			for (const run of [
				(f) => listCategories({ organizationId: ORG, customFetch: f }),
				(f) => createCategory({ organizationId: ORG, name: 'Ok', customFetch: f }),
				(f) =>
					updateCategory({ organizationId: ORG, categoryId: CATEGORY, name: 'Ok', customFetch: f }),
				(f) =>
					setCategoryActive({
						organizationId: ORG,
						categoryId: CATEGORY,
						active: true,
						customFetch: f
					})
			]) {
				const { fetchFn } = mockFetch(
					() => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
				);
				await assert.rejects(run(fetchFn), (error) => {
					assert.ok(error instanceof CategoryApiError);
					assert.equal(error.status, status);
					assert.equal(error.code, code);
					assert.ok(
						!error.message.includes('duplicate key') && !error.message.includes('constraint')
					);
					return true;
				});
			}
		}
	});

	await t.test('28-29. network y AbortError', async () => {
		const network = mockFetch(() => {
			throw new TypeError('fetch failed');
		});
		await rejectsWith(listCategories({ organizationId: ORG, customFetch: network.fetchFn }), {
			status: 0,
			code: 'NETWORK_ERROR'
		});
		const controller = new AbortController();
		const abortable = mockFetch((url, init) => {
			assert.equal(init.signal, controller.signal);
			controller.abort();
			throw new DOMException('aborted', 'AbortError');
		});
		for (const run of [
			() =>
				listCategories({
					organizationId: ORG,
					signal: controller.signal,
					customFetch: abortable.fetchFn
				}),
			() =>
				createCategory({
					organizationId: ORG,
					name: 'Ok',
					signal: controller.signal,
					customFetch: abortable.fetchFn
				}),
			() =>
				setCategoryActive({
					organizationId: ORG,
					categoryId: CATEGORY,
					active: false,
					signal: controller.signal,
					customFetch: abortable.fetchFn
				})
		]) {
			await assert.rejects(run(), (error) => {
				assert.ok(!(error instanceof CategoryApiError));
				assert.equal(error.name, 'AbortError');
				return true;
			});
		}
	});

	// =========================================================================
	// Cliente de incidencias con categoría
	// =========================================================================
	await t.test('38-39, 44-45. listIncidents: filtro categoryId y parser', async () => {
		const { fetchFn, calls } = mockFetch(() =>
			json({
				incidents: [
					incident({ id: randomUUID() }),
					incident({ id: randomUUID(), categoryId: CATEGORY }),
					{ ...incident({ id: randomUUID() }), categoryId: undefined }
				]
			})
		);
		const items = await listIncidents(ORG, {
			categoryId: CATEGORY,
			queue: 'all',
			customFetch: fetchFn
		});
		assert.equal(
			calls[0].url,
			`/api/incidents?organizationId=${ORG}&queue=all&categoryId=${CATEGORY}`
		);
		assert.deepEqual(
			items.map((i) => i.categoryId),
			[null, CATEGORY, null]
		);
		const noFilter = mockFetch(() => json({ incidents: [] }));
		await listIncidents(ORG, { customFetch: noFilter.fetchFn });
		assert.ok(!noFilter.calls[0].url.includes('categoryId'));
		const none = mockFetch(() => json({ incidents: [] }));
		for (const categoryId of ['nope', '', 5])
			await rejectsWith(listIncidents(ORG, { categoryId, customFetch: none.fetchFn }), {
				status: 0,
				code: 'INVALID_INPUT',
				type: IncidentApiError
			});
		assert.equal(none.calls.length, 0);
		for (const categoryId of ['nope', 5, {}]) {
			const { fetchFn: bad } = mockFetch(() => json({ incidents: [incident({ categoryId })] }));
			await rejectsWith(listIncidents(ORG, { customFetch: bad }), {
				code: 'INVALID_PAYLOAD',
				type: IncidentApiError
			});
		}
	});

	await t.test('40-43, 46. createIncident y getIncident con categoryId', async () => {
		const input = { title: 'T', description: 'D', client: 'C', priority: 'medium' };
		const { fetchFn, calls } = mockFetch((url, init) => {
			const body = JSON.parse(init.body);
			return json({ incident: incident({ categoryId: body.categoryId ?? null }) }, 201);
		});
		assert.equal((await createIncident(ORG, input, { customFetch: fetchFn })).categoryId, null);
		assert.equal(
			(await createIncident(ORG, { ...input, categoryId: null }, { customFetch: fetchFn }))
				.categoryId,
			null
		);
		assert.equal(
			(await createIncident(ORG, { ...input, categoryId: CATEGORY }, { customFetch: fetchFn }))
				.categoryId,
			CATEGORY
		);
		await createIncident(
			ORG,
			{ ...input, categoryName: 'Hardware', subcategoryId: randomUUID(), classification: 'x' },
			{ customFetch: fetchFn }
		);
		const bodies = calls.map((c) => JSON.parse(c.init.body));
		assert.ok(!('categoryId' in bodies[0]));
		assert.equal(bodies[1].categoryId, null);
		assert.equal(bodies[2].categoryId, CATEGORY);
		assert.deepEqual(Object.keys(bodies[3]).sort(), [
			'client',
			'description',
			'organizationId',
			'priority',
			'title'
		]);
		const none = mockFetch(() => json({}));
		await rejectsWith(
			createIncident(ORG, { ...input, categoryId: 'nope' }, { customFetch: none.fetchFn }),
			{ status: 0, code: 'INVALID_INPUT', type: IncidentApiError }
		);
		assert.equal(none.calls.length, 0);
		const detail = mockFetch(() => json({ incident: incident({ categoryId: CATEGORY }) }));
		assert.equal(
			(await getIncident(ORG, INCIDENT, { customFetch: detail.fetchFn })).categoryId,
			CATEGORY
		);
		const legacy = mockFetch(() => json({ incident: { ...incident(), categoryId: undefined } }));
		assert.equal(
			(await getIncident(ORG, INCIDENT, { customFetch: legacy.fetchFn })).categoryId,
			null
		);
		const bad = mockFetch(() => json({ incident: incident({ categoryId: 'nope' }) }));
		await rejectsWith(getIncident(ORG, INCIDENT, { customFetch: bad.fetchFn }), {
			code: 'INVALID_PAYLOAD',
			type: IncidentApiError
		});
	});

	await t.test('47-60. updateIncidentCategory: request, respuesta y errores', async () => {
		const ok = mockFetch((url, init) =>
			json({ incident: incident({ categoryId: JSON.parse(init.body).categoryId }) })
		);
		const controller = new AbortController();
		const set = await updateIncidentCategory(
			ORG,
			INCIDENT,
			{ categoryId: CATEGORY },
			{ customFetch: ok.fetchFn, signal: controller.signal }
		);
		assert.equal(set.categoryId, CATEGORY);
		const cleared = await updateIncidentCategory(
			ORG,
			INCIDENT,
			{
				categoryId: null,
				reason: 'Retirada',
				organizationId: randomUUID(),
				actorUserId: randomUUID()
			},
			{ customFetch: ok.fetchFn }
		);
		assert.equal(cleared.categoryId, null);
		assert.equal(ok.calls[0].url, `/api/incidents/${INCIDENT}/category?organizationId=${ORG}`);
		assert.equal(ok.calls[0].init.method, 'PATCH');
		assert.equal(ok.calls[0].init.signal, controller.signal);
		assert.deepEqual(ok.calls[0].init.headers, { 'Content-Type': 'application/json' });
		assert.equal(ok.calls[0].init.body, JSON.stringify({ categoryId: CATEGORY }));
		assert.equal(ok.calls[1].init.body, JSON.stringify({ categoryId: null, reason: 'Retirada' }));

		const mismatch = mockFetch(() => json({ incident: incident({ categoryId: randomUUID() }) }));
		await rejectsWith(
			updateIncidentCategory(
				ORG,
				INCIDENT,
				{ categoryId: CATEGORY },
				{ customFetch: mismatch.fetchFn }
			),
			{ code: 'INVALID_PAYLOAD', type: IncidentApiError }
		);
		const wrongIncident = mockFetch(() =>
			json({ incident: incident({ id: randomUUID(), categoryId: CATEGORY }) })
		);
		await rejectsWith(
			updateIncidentCategory(
				ORG,
				INCIDENT,
				{ categoryId: CATEGORY },
				{ customFetch: wrongIncident.fetchFn }
			),
			{ code: 'INVALID_PAYLOAD', type: IncidentApiError }
		);

		for (const [status, code, expected] of [
			[400, 'INVALID_INPUT', 'INVALID_INPUT'],
			[401, 'UNAUTHORIZED', 'UNAUTHORIZED'],
			[403, 'FORBIDDEN', 'FORBIDDEN'],
			[404, 'INCIDENT_NOT_FOUND', 'NOT_FOUND'],
			[404, 'CATEGORY_NOT_FOUND', 'CATEGORY_NOT_FOUND'],
			[409, 'CATEGORY_INACTIVE', 'CATEGORY_INACTIVE'],
			[409, 'INCIDENT_CLOSED', 'INCIDENT_CLOSED'],
			[409, 'OTHER', 'CONFLICT'],
			[500, 'INTERNAL_ERROR', 'SERVER_ERROR']
		]) {
			const { fetchFn } = mockFetch(() =>
				json({ error: { code, message: 'SQL secret /srv' } }, status)
			);
			await assert.rejects(
				updateIncidentCategory(ORG, INCIDENT, { categoryId: CATEGORY }, { customFetch: fetchFn }),
				(error) => {
					assert.ok(error instanceof IncidentApiError);
					assert.equal(error.status, status);
					assert.equal(error.code, expected);
					assert.ok(!error.message.includes('SQL') && !error.message.includes('/srv'));
					return true;
				}
			);
		}
		const network = mockFetch(() => {
			throw new TypeError('fetch failed');
		});
		await rejectsWith(
			updateIncidentCategory(ORG, INCIDENT, { categoryId: null }, { customFetch: network.fetchFn }),
			{ status: 0, code: 'NETWORK_ERROR', type: IncidentApiError }
		);
		const abort = new AbortController();
		const abortable = mockFetch(() => {
			abort.abort();
			throw new DOMException('aborted', 'AbortError');
		});
		await assert.rejects(
			updateIncidentCategory(
				ORG,
				INCIDENT,
				{ categoryId: null },
				{ customFetch: abortable.fetchFn, signal: abort.signal }
			),
			(e) => e.name === 'AbortError' && !(e instanceof IncidentApiError)
		);

		const none = mockFetch(() => json({}));
		for (const args of [
			['x', INCIDENT, { categoryId: CATEGORY }],
			[ORG, 'x', { categoryId: CATEGORY }],
			[ORG, INCIDENT, { categoryId: 'x' }],
			[ORG, INCIDENT, { categoryId: undefined }],
			[ORG, INCIDENT, { categoryId: CATEGORY, reason: 5 }]
		])
			await rejectsWith(updateIncidentCategory(...args, { customFetch: none.fetchFn }), {
				status: 0,
				code: 'INVALID_INPUT',
				type: IncidentApiError
			});
		assert.equal(none.calls.length, 0);
	});

	await t.test(
		'hardening: código fuente sin storage, demo, clasificación ni cabeceras de identidad',
		async () => {
			const source = fs.readFileSync('src/lib/api/categories.ts', 'utf8');
			assert.ok(!/^import /m.test(source));
			for (const forbidden of [
				'localStorage',
				'sessionStorage',
				'demo',
				'x-user-id',
				'x-organization-id',
				'hasPermission',
				'routing',
				'defaultTeamId',
				'subcategor',
				'classification',
				'priority'
			])
				assert.ok(!source.includes(forbidden), forbidden);
			const incidentsSource = fs.readFileSync('src/lib/api/incidents.ts', 'utf8');
			assert.ok(!incidentsSource.includes('categoryName'));
		}
	);

	// =========================================================================
	// E2E cliente ↔ handlers reales
	// =========================================================================
	await t.test('E2E: categorías e incidencias contra los handlers reales', async (st) => {
		const f = await fixture(st);
		const { db, schema: s, server } = f;
		const routes = {
			categories: await server.ssrLoadModule('/src/routes/api/categories/+server.ts'),
			category: await server.ssrLoadModule('/src/routes/api/categories/[id]/+server.ts'),
			incidents: await server.ssrLoadModule('/src/routes/api/incidents/+server.ts'),
			incident: await server.ssrLoadModule('/src/routes/api/incidents/[id]/+server.ts'),
			incidentCategory: await server.ssrLoadModule(
				'/src/routes/api/incidents/[id]/category/+server.ts'
			)
		};
		const [org] = await db
			.insert(s.organizations)
			.values({ name: 'E2E cat', slug: randomUUID(), status: 'active' })
			.returning();
		const user = await createCredentialUser(f);
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
		for (const permissionId of [
			'categories:view',
			'categories:manage',
			'incidents:create',
			'incidents:view_all',
			'incidents:edit'
		])
			await grantPermission(f, {
				organizationId: org.id,
				membershipId: membership.id,
				permissionId
			});
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		const bridge = async (url, init = {}) => {
			const parsed = new URL(url, 'http://localhost');
			const parts = parsed.pathname.split('/').filter(Boolean);
			const headers = new Headers(init.headers);
			headers.set('cookie', session.cookieHeader);
			const request = new Request(parsed, { method: init.method, headers, body: init.body });
			const method = init.method;
			if (parts[1] === 'categories')
				return parts.length === 2
					? routes.categories[method]({ url: parsed, params: {}, request })
					: routes.category[method]({ url: parsed, params: { id: parts[2] }, request });
			if (parts.length === 2) return routes.incidents[method]({ url: parsed, params: {}, request });
			if (parts[3] === 'category')
				return routes.incidentCategory[method]({ url: parsed, params: { id: parts[2] }, request });
			return routes.incident[method]({ url: parsed, params: { id: parts[2] }, request });
		};
		const base = { organizationId: org.id, customFetch: bridge };

		const hardware = await createCategory({ ...base, name: '  Hardware ', description: 'Equipos' });
		assert.equal(hardware.name, 'Hardware');
		const software = await createCategory({ ...base, name: 'Software' });
		await rejectsWith(createCategory({ ...base, name: 'HARDWARE' }), {
			status: 409,
			code: 'CATEGORY_NAME_DUPLICATE'
		});
		assert.equal(
			(
				await updateCategory({
					...base,
					categoryId: software.id,
					name: 'Aplicaciones',
					description: null
				})
			).name,
			'Aplicaciones'
		);
		const legacy = await createCategory({ ...base, name: 'Legacy' });
		assert.equal(
			(await setCategoryActive({ ...base, categoryId: legacy.id, active: false })).active,
			false
		);
		assert.deepEqual(
			(await listCategories({ ...base, activeOnly: true })).map((c) => c.name),
			['Aplicaciones', 'Hardware']
		);
		assert.equal((await listCategories(base)).length, 3);
		await rejectsWith(updateCategory({ ...base, categoryId: randomUUID(), name: 'Inexistente' }), {
			status: 404,
			code: 'CATEGORY_NOT_FOUND'
		});

		const input = { title: 'E2E', description: 'E2E', client: 'E2E', priority: 'medium' };
		const withCategory = await createIncident(
			org.id,
			{ ...input, categoryId: hardware.id },
			{ customFetch: bridge }
		);
		assert.equal(withCategory.categoryId, hardware.id);
		const plain = await createIncident(org.id, input, { customFetch: bridge });
		assert.equal(plain.categoryId, null);
		await rejectsWith(
			createIncident(org.id, { ...input, categoryId: legacy.id }, { customFetch: bridge }),
			{
				status: 409,
				code: 'CATEGORY_INACTIVE',
				type: IncidentApiError
			}
		);
		await rejectsWith(
			createIncident(org.id, { ...input, categoryId: randomUUID() }, { customFetch: bridge }),
			{
				status: 404,
				code: 'CATEGORY_NOT_FOUND',
				type: IncidentApiError
			}
		);
		assert.deepEqual(
			(await listIncidents(org.id, { categoryId: hardware.id, customFetch: bridge })).map(
				(i) => i.id
			),
			[withCategory.id]
		);
		assert.equal(
			(await getIncident(org.id, withCategory.id, { customFetch: bridge })).categoryId,
			hardware.id
		);

		assert.equal(
			(
				await updateIncidentCategory(
					org.id,
					plain.id,
					{ categoryId: software.id },
					{ customFetch: bridge }
				)
			).categoryId,
			software.id
		);
		await rejectsWith(
			updateIncidentCategory(
				org.id,
				plain.id,
				{ categoryId: legacy.id, reason: 'x' },
				{ customFetch: bridge }
			),
			{ status: 409, code: 'CATEGORY_INACTIVE', type: IncidentApiError }
		);
		await rejectsWith(
			updateIncidentCategory(
				org.id,
				plain.id,
				{ categoryId: randomUUID(), reason: 'x' },
				{ customFetch: bridge }
			),
			{ status: 404, code: 'CATEGORY_NOT_FOUND', type: IncidentApiError }
		);
		await rejectsWith(
			updateIncidentCategory(org.id, plain.id, { categoryId: null }, { customFetch: bridge }),
			{ status: 400, code: 'INVALID_INPUT', type: IncidentApiError }
		);
		await db.update(s.incidents).set({ status: 'closed' }).where(eq(s.incidents.id, plain.id));
		await rejectsWith(
			updateIncidentCategory(
				org.id,
				plain.id,
				{ categoryId: null, reason: 'x' },
				{ customFetch: bridge }
			),
			{ status: 409, code: 'INCIDENT_CLOSED', type: IncidentApiError }
		);
	});
});

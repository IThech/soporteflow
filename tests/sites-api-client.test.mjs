import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
	listSites,
	createSite,
	renameSite,
	setSiteActive,
	SiteApiError
} from '../src/lib/api/sites.ts';
import { updateIncidentSite, IncidentApiError } from '../src/lib/api/incidents.ts';
import {
	fixture,
	createCredentialUser,
	createSession,
	grantPermission
} from './helpers/auth-fixture.mjs';

const ORG = randomUUID();
const SITE = randomUUID();
const INCIDENT = randomUUID();

function site(overrides = {}) {
	return {
		id: randomUUID(),
		name: 'Valencia',
		active: true,
		createdAt: '2026-05-01T10:20:30.123Z',
		updatedAt: '2026-05-02T10:20:30.123Z',
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

async function rejectsWith(promise, { status, code, type = SiteApiError }) {
	await assert.rejects(promise, (error) => {
		assert.ok(error instanceof type, `esperado ${type.name}: ${error}`);
		if (status !== undefined) assert.equal(error.status, status);
		assert.equal(error.code, code);
		return true;
	});
}

test('SoporteFlow — Etapa 5.4O-C: cliente API de sedes', async (t) => {
	await t.test('list: vacío, varias, activeOnly, URL y signal', async () => {
		const sites = [site({ name: 'Madrid' }), site({ name: 'Valencia', active: false })];
		const { fetchFn, calls } = mockFetch((url) =>
			json({
				sites: url.includes('activeOnly=true') ? [sites[0]] : calls.length === 1 ? [] : sites
			})
		);
		const controller = new AbortController();
		assert.deepEqual(
			await listSites({ organizationId: ORG, customFetch: fetchFn, signal: controller.signal }),
			[]
		);
		assert.deepEqual(await listSites({ organizationId: ORG, customFetch: fetchFn }), sites);
		assert.deepEqual(
			await listSites({ organizationId: ORG, activeOnly: true, customFetch: fetchFn }),
			[sites[0]]
		);
		await listSites({ organizationId: ORG, activeOnly: false, customFetch: fetchFn });
		assert.equal(calls[0].url, `/api/sites?organizationId=${ORG}`);
		assert.equal(calls[0].init.method, 'GET');
		assert.equal(calls[0].init.signal, controller.signal);
		assert.equal(calls[0].init.body, undefined);
		assert.equal(calls[0].init.headers, undefined);
		assert.equal(calls[2].url, `/api/sites?organizationId=${ORG}&activeOnly=true`);
		assert.equal(calls[3].url, `/api/sites?organizationId=${ORG}&activeOnly=false`);
	});

	await t.test('create / rename / set_active: request exacta', async () => {
		const created = site();
		const { fetchFn, calls } = mockFetch((url, init) =>
			json({ site: created }, init.method === 'POST' ? 201 : 200)
		);
		const extra = {
			organizationIdInBody: ORG,
			visibility: 'x',
			actorUserId: randomUUID(),
			userId: randomUUID()
		};
		assert.deepEqual(
			await createSite({ organizationId: ORG, name: ' Valencia ', customFetch: fetchFn, ...extra }),
			created
		);
		await renameSite({
			organizationId: ORG,
			siteId: SITE,
			name: 'Madrid Norte',
			customFetch: fetchFn,
			...extra
		});
		await setSiteActive({ organizationId: ORG, siteId: SITE, active: false, customFetch: fetchFn });
		await setSiteActive({ organizationId: ORG, siteId: SITE, active: true, customFetch: fetchFn });
		const [create, rename, off, on] = calls;
		assert.equal(create.url, `/api/sites?organizationId=${ORG}`);
		assert.equal(create.init.method, 'POST');
		assert.deepEqual(create.init.headers, { 'Content-Type': 'application/json' });
		assert.equal(create.init.body, JSON.stringify({ name: ' Valencia ' }));
		for (const call of [rename, off, on]) {
			assert.equal(call.url, `/api/sites/${SITE}?organizationId=${ORG}`);
			assert.equal(call.init.method, 'PATCH');
			assert.deepEqual(call.init.headers, { 'Content-Type': 'application/json' });
		}
		assert.equal(rename.init.body, JSON.stringify({ action: 'rename', name: 'Madrid Norte' }));
		assert.equal(off.init.body, JSON.stringify({ action: 'set_active', active: false }));
		assert.equal(on.init.body, JSON.stringify({ action: 'set_active', active: true }));
		for (const call of calls) {
			const body = call.init.body ?? '';
			for (const field of ['organizationId', 'visibility', 'actorUserId', 'userId', 'description'])
				assert.ok(!body.includes(field), field);
		}
	});

	await t.test('entrada inválida no llama a fetch', async () => {
		const { fetchFn, calls } = mockFetch(() => json({ sites: [] }));
		const bad = [
			() => listSites({ organizationId: 'x', customFetch: fetchFn }),
			() => listSites({ organizationId: ORG, activeOnly: 'true', customFetch: fetchFn }),
			() => createSite({ organizationId: ORG, name: '   ', customFetch: fetchFn }),
			() => createSite({ organizationId: ORG, name: 42, customFetch: fetchFn }),
			() => createSite({ organizationId: '../x', name: 'Ok', customFetch: fetchFn }),
			() => renameSite({ organizationId: ORG, siteId: 'nope', name: 'Ok', customFetch: fetchFn }),
			() =>
				renameSite({ organizationId: ORG, siteId: '../../x', name: 'Ok', customFetch: fetchFn }),
			() =>
				setSiteActive({ organizationId: ORG, siteId: SITE, active: 'false', customFetch: fetchFn }),
			() => setSiteActive({ organizationId: ORG, siteId: SITE, customFetch: fetchFn })
		];
		for (const run of bad) await rejectsWith(run(), { status: 0, code: 'INVALID_INPUT' });
		assert.equal(calls.length, 0);
	});

	await t.test('payload inválido -> INVALID_PAYLOAD; extras descartados', async () => {
		const invalid = [
			null,
			[],
			{},
			{ sites: 'x' },
			{ sites: [null] },
			{ sites: [site({ id: 'x' })] },
			{ sites: [site({ name: '' })] },
			{ sites: [site({ name: 'x'.repeat(256) })] },
			{ sites: [site({ active: 'true' })] },
			{ sites: [site({ createdAt: 'ayer' })] },
			{ sites: [site({ updatedAt: '2026-13-45T00:00:00.000Z' })] },
			{ sites: [site({ createdAt: 1714558830 })] }
		];
		const dup = site();
		invalid.push({ sites: [dup, dup] });
		for (const payload of invalid) {
			const { fetchFn } = mockFetch(() => json(payload));
			await rejectsWith(listSites({ organizationId: ORG, customFetch: fetchFn }), {
				status: 200,
				code: 'INVALID_PAYLOAD'
			});
		}
		for (const payload of [{}, { site: null }, { site: site({ id: 1 }) }]) {
			const { fetchFn } = mockFetch(() => json(payload, 201));
			await rejectsWith(createSite({ organizationId: ORG, name: 'Ok', customFetch: fetchFn }), {
				code: 'INVALID_PAYLOAD'
			});
		}
		const raw = {
			...site(),
			organizationId: ORG,
			description: 'SECRETO',
			membership: {},
			permissions: ['x']
		};
		const { fetchFn } = mockFetch(() => json({ sites: [raw], organizationId: ORG }));
		const [parsed] = await listSites({ organizationId: ORG, customFetch: fetchFn });
		assert.deepEqual(Object.keys(parsed).sort(), [
			'active',
			'createdAt',
			'id',
			'name',
			'updatedAt'
		]);
		assert.ok(!JSON.stringify(parsed).includes('SECRETO'));
		assert.equal(typeof parsed.createdAt, 'string');
	});

	await t.test('errores HTTP tipados y mensajes seguros', async () => {
		const secret =
			'duplicate key value violates unique constraint "sites_org_normalized_name_unique_idx"';
		const cases = [
			[400, { error: { code: 'INVALID_INPUT', message: secret } }, 'INVALID_INPUT'],
			[401, { error: { code: 'UNAUTHORIZED', message: secret } }, 'UNAUTHORIZED'],
			[403, { error: { code: 'FORBIDDEN', message: secret } }, 'FORBIDDEN'],
			[404, { error: { code: 'SITE_NOT_FOUND', message: secret } }, 'SITE_NOT_FOUND'],
			[404, 'not json', 'NOT_FOUND'],
			[409, { error: { code: 'SITE_NAME_DUPLICATE', message: secret } }, 'SITE_NAME_DUPLICATE'],
			[409, { error: { code: 'OTHER' } }, 'CONFLICT'],
			[500, { error: { code: 'INTERNAL_ERROR', message: secret } }, 'SERVER_ERROR'],
			[418, {}, 'INTERNAL_ERROR']
		];
		for (const [status, body, code] of cases) {
			for (const run of [
				(fetchFn) => listSites({ organizationId: ORG, customFetch: fetchFn }),
				(fetchFn) => createSite({ organizationId: ORG, name: 'Ok', customFetch: fetchFn }),
				(fetchFn) =>
					renameSite({ organizationId: ORG, siteId: SITE, name: 'Ok', customFetch: fetchFn }),
				(fetchFn) =>
					setSiteActive({ organizationId: ORG, siteId: SITE, active: true, customFetch: fetchFn })
			]) {
				const { fetchFn } = mockFetch(
					() => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
				);
				await assert.rejects(run(fetchFn), (error) => {
					assert.ok(error instanceof SiteApiError);
					assert.equal(error.status, status);
					assert.equal(error.code, code);
					assert.ok(!error.message.includes('duplicate key'));
					assert.ok(!error.message.includes('constraint'));
					return true;
				});
			}
		}
	});

	await t.test('network y AbortError', async () => {
		const network = mockFetch(() => {
			throw new TypeError('fetch failed');
		});
		await rejectsWith(listSites({ organizationId: ORG, customFetch: network.fetchFn }), {
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
				listSites({
					organizationId: ORG,
					signal: controller.signal,
					customFetch: abortable.fetchFn
				}),
			() =>
				createSite({
					organizationId: ORG,
					name: 'Ok',
					signal: controller.signal,
					customFetch: abortable.fetchFn
				}),
			() =>
				setSiteActive({
					organizationId: ORG,
					siteId: SITE,
					active: false,
					signal: controller.signal,
					customFetch: abortable.fetchFn
				})
		]) {
			await assert.rejects(run(), (error) => {
				assert.ok(!(error instanceof SiteApiError));
				assert.equal(error.name, 'AbortError');
				return true;
			});
		}
	});

	await t.test('updateIncidentSite: request, errores y validación', async () => {
		const incident = { id: INCIDENT, organizationId: ORG, siteId: SITE };
		const ok = mockFetch(() => json({ incident: fullIncident(incident) }));
		const result = await updateIncidentSite(
			ORG,
			INCIDENT,
			{ siteId: SITE, reason: 'Traslado' },
			{ customFetch: ok.fetchFn }
		);
		assert.equal(result.siteId, SITE);
		const [call] = ok.calls;
		assert.equal(call.url, `/api/incidents/${INCIDENT}/site?organizationId=${ORG}`);
		assert.equal(call.init.method, 'PATCH');
		assert.equal(call.init.body, JSON.stringify({ siteId: SITE, reason: 'Traslado' }));
		const cleared = mockFetch(() =>
			json({ incident: fullIncident({ ...incident, siteId: null }) })
		);
		await updateIncidentSite(ORG, INCIDENT, { siteId: null }, { customFetch: cleared.fetchFn });
		assert.equal(cleared.calls[0].init.body, JSON.stringify({ siteId: null }));

		// respuesta incoherente con el cambio pedido
		const mismatch = mockFetch(() =>
			json({ incident: fullIncident({ ...incident, siteId: randomUUID() }) })
		);
		await rejectsWith(
			updateIncidentSite(ORG, INCIDENT, { siteId: SITE }, { customFetch: mismatch.fetchFn }),
			{ code: 'INVALID_PAYLOAD', type: IncidentApiError }
		);

		for (const [status, code, expected] of [
			[400, 'INVALID_INPUT', 'INVALID_INPUT'],
			[401, 'UNAUTHORIZED', 'UNAUTHORIZED'],
			[403, 'FORBIDDEN', 'FORBIDDEN'],
			[404, 'INCIDENT_NOT_FOUND', 'NOT_FOUND'],
			[404, 'SITE_NOT_FOUND', 'SITE_NOT_FOUND'],
			[409, 'SITE_INACTIVE', 'SITE_INACTIVE'],
			[500, 'INTERNAL_ERROR', 'SERVER_ERROR']
		]) {
			const { fetchFn } = mockFetch(() => json({ error: { code, message: 'SQL secret' } }, status));
			await assert.rejects(
				updateIncidentSite(ORG, INCIDENT, { siteId: SITE }, { customFetch: fetchFn }),
				(error) => {
					assert.ok(error instanceof IncidentApiError);
					assert.equal(error.code, expected);
					assert.ok(!error.message.includes('SQL'));
					return true;
				}
			);
		}
		const none = mockFetch(() => json({}));
		for (const args of [
			['x', INCIDENT, { siteId: SITE }],
			[ORG, 'x', { siteId: SITE }],
			[ORG, INCIDENT, { siteId: 'x' }],
			[ORG, INCIDENT, { siteId: undefined }],
			[ORG, INCIDENT, { siteId: SITE, reason: 5 }]
		])
			await rejectsWith(updateIncidentSite(...args, { customFetch: none.fetchFn }), {
				status: 0,
				code: 'INVALID_INPUT',
				type: IncidentApiError
			});
		assert.equal(none.calls.length, 0);
	});

	await t.test('código fuente: sin storage, demo, cabeceras de identidad ni permisos', async () => {
		const source = fs.readFileSync(new URL('../src/lib/api/sites.ts', import.meta.url), 'utf8');
		assert.ok(!/^import /m.test(source));
		for (const forbidden of [
			'localStorage',
			'sessionStorage',
			'demo',
			'x-user-id',
			'x-organization-id',
			'hasPermission',
			'description',
			'actorUserId'
		])
			assert.ok(!source.includes(forbidden), forbidden);
	});

	await t.test('E2E: cliente contra los handlers reales', async (st) => {
		const f = await fixture(st);
		const { db, schema: s, server } = f;
		const routes = {
			collection: await server.ssrLoadModule('/src/routes/api/sites/+server.ts'),
			item: await server.ssrLoadModule('/src/routes/api/sites/[id]/+server.ts'),
			incidentSite: await server.ssrLoadModule('/src/routes/api/incidents/[id]/site/+server.ts')
		};
		const { createIncidentRecord } = await server.ssrLoadModule(
			'/src/lib/server/services/incidents.ts'
		);
		const [org] = await db
			.insert(s.organizations)
			.values({ name: 'E2E sedes', slug: randomUUID(), status: 'active' })
			.returning();
		const user = await createCredentialUser(f);
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
		for (const permissionId of ['sites:view', 'sites:manage', 'incidents:edit'])
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
			if (parts[1] === 'incidents')
				return routes.incidentSite.PATCH({ url: parsed, params: { id: parts[2] }, request });
			if (parts.length === 2)
				return routes.collection[init.method]({ url: parsed, params: {}, request });
			return routes.item.PATCH({ url: parsed, params: { id: parts[2] }, request });
		};
		const base = { organizationId: org.id, customFetch: bridge };

		const valencia = await createSite({ ...base, name: '  Valencia  ' });
		assert.equal(valencia.name, 'Valencia');
		const madrid = await createSite({ ...base, name: 'Madrid' });
		await rejectsWith(createSite({ ...base, name: 'VALENCIA' }), {
			status: 409,
			code: 'SITE_NAME_DUPLICATE'
		});
		const renamed = await renameSite({ ...base, siteId: madrid.id, name: 'Madrid Norte' });
		assert.equal(renamed.name, 'Madrid Norte');
		assert.equal(
			(await setSiteActive({ ...base, siteId: madrid.id, active: false })).active,
			false
		);
		assert.deepEqual(
			(await listSites({ ...base, activeOnly: true })).map((x) => x.name),
			['Valencia']
		);
		assert.deepEqual(
			(await listSites(base)).map((x) => x.name),
			['Madrid Norte', 'Valencia']
		);
		await rejectsWith(renameSite({ ...base, siteId: randomUUID(), name: 'Inexistente' }), {
			status: 404,
			code: 'SITE_NOT_FOUND'
		});

		const { incident } = await createIncidentRecord(
			db,
			{ organizationId: org.id, creatorUserId: user.id },
			{ title: 'E2E', description: 'E2E', client: 'E2E' }
		);
		const updated = await updateIncidentSite(
			org.id,
			incident.id,
			{ siteId: valencia.id },
			{ customFetch: bridge }
		);
		assert.equal(updated.siteId, valencia.id);
		await rejectsWith(
			updateIncidentSite(
				org.id,
				incident.id,
				{ siteId: madrid.id, reason: 'x' },
				{ customFetch: bridge }
			),
			{ status: 409, code: 'SITE_INACTIVE', type: IncidentApiError }
		);
		await rejectsWith(
			updateIncidentSite(org.id, incident.id, { siteId: null }, { customFetch: bridge }),
			{ status: 400, code: 'INVALID_INPUT', type: IncidentApiError }
		);
		assert.equal(
			(
				await updateIncidentSite(
					org.id,
					incident.id,
					{ siteId: null, reason: 'Retirada' },
					{ customFetch: bridge }
				)
			).siteId,
			null
		);
	});
});

function fullIncident(overrides) {
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
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides
	};
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
	listSlaPolicies,
	getSlaPolicy,
	createSlaPolicy,
	updateSlaPolicy,
	SlaPolicyApiError
} from '../src/lib/api/sla-policies.ts';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

const ORG = randomUUID();
const POLICY = randomUUID();
function policy(overrides = {}) {
	return {
		id: POLICY,
		code: 'estandar',
		name: 'Estándar',
		description: null,
		active: true,
		isDefault: false,
		firstResponseMinutes: 60,
		resolutionMinutes: 480,
		createdAt: '2026-09-26T10:00:00.000Z',
		updatedAt: '2026-09-26T10:00:00.000Z',
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
async function rejectsWith(promise, { status, code }) {
	await assert.rejects(promise, (error) => {
		assert.ok(error instanceof SlaPolicyApiError, `esperado SlaPolicyApiError: ${error}`);
		if (status !== undefined) assert.equal(error.status, status);
		assert.equal(error.code, code);
		return true;
	});
}
const draft = {
	code: 'estandar',
	name: 'Estándar',
	firstResponseMinutes: 60,
	resolutionMinutes: 480
};

test('SoporteFlow — Etapa 5.4T-A: cliente API de políticas SLA', async (t) => {
	await t.test(
		'list/get: GET, filtros, signal, customFetch, sin cabeceras; extras descartados',
		async () => {
			const controller = new AbortController();
			const { fetchFn, calls } = mockFetch(() =>
				json({ slaPolicies: [{ ...policy(), organizationId: ORG, rules: [] }] })
			);
			const result = await listSlaPolicies({
				organizationId: ORG,
				active: true,
				isDefault: false,
				customFetch: fetchFn,
				signal: controller.signal
			});
			assert.deepEqual(result, [policy()]);
			assert.equal(
				calls[0].url,
				`/api/sla-policies?organizationId=${ORG}&active=true&isDefault=false`
			);
			assert.equal(calls[0].init.method, 'GET');
			assert.equal(calls[0].init.signal, controller.signal);
			assert.equal(calls[0].init.headers, undefined);
			const { fetchFn: one } = mockFetch(() => json({ slaPolicy: policy() }));
			assert.deepEqual(
				await getSlaPolicy({ organizationId: ORG, policyId: POLICY, customFetch: one }),
				policy()
			);
		}
	);

	await t.test('create/update: POST y PATCH con cuerpo exacto; code inmutable', async () => {
		const { fetchFn, calls } = mockFetch((url, init) =>
			init.method === 'POST'
				? json({ slaPolicy: policy() }, 201)
				: json({ slaPolicy: policy({ name: 'Nuevo' }) })
		);
		await createSlaPolicy({
			organizationId: ORG,
			policy: { ...draft, description: null, isDefault: true },
			customFetch: fetchFn
		});
		assert.equal(calls[0].init.method, 'POST');
		assert.equal(calls[0].url, `/api/sla-policies?organizationId=${ORG}`);
		assert.deepEqual(JSON.parse(calls[0].init.body), {
			...draft,
			description: null,
			isDefault: true
		});
		const updated = await updateSlaPolicy({
			organizationId: ORG,
			policyId: POLICY,
			patch: { name: 'Nuevo', active: undefined, firstResponseMinutes: 30 },
			customFetch: fetchFn
		});
		assert.equal(updated.name, 'Nuevo');
		assert.equal(calls[1].init.method, 'PATCH');
		assert.equal(calls[1].url, `/api/sla-policies/${POLICY}?organizationId=${ORG}`);
		assert.deepEqual(JSON.parse(calls[1].init.body), { name: 'Nuevo', firstResponseMinutes: 30 });
	});

	await t.test(
		'validación previa: UUID, code, targets, patch vacío/code/desconocido no llaman a fetch',
		async () => {
			const { fetchFn, calls } = mockFetch(json({}));
			for (const promise of [
				listSlaPolicies({ organizationId: 'x', customFetch: fetchFn }),
				listSlaPolicies({ organizationId: ORG, active: 'true', customFetch: fetchFn }),
				getSlaPolicy({ organizationId: ORG, policyId: 'x', customFetch: fetchFn }),
				createSlaPolicy({
					organizationId: ORG,
					policy: { ...draft, code: 'Mal' },
					customFetch: fetchFn
				}),
				createSlaPolicy({
					organizationId: ORG,
					policy: { ...draft, firstResponseMinutes: 0 },
					customFetch: fetchFn
				}),
				createSlaPolicy({
					organizationId: ORG,
					policy: { ...draft, firstResponseMinutes: 1.5 },
					customFetch: fetchFn
				}),
				createSlaPolicy({
					organizationId: ORG,
					policy: { ...draft, firstResponseMinutes: 600 },
					customFetch: fetchFn
				}),
				createSlaPolicy({
					organizationId: ORG,
					policy: { ...draft, resolutionMinutes: Infinity },
					customFetch: fetchFn
				}),
				updateSlaPolicy({ organizationId: ORG, policyId: POLICY, patch: {}, customFetch: fetchFn }),
				updateSlaPolicy({
					organizationId: ORG,
					policyId: POLICY,
					patch: { code: 'x_y' },
					customFetch: fetchFn
				}),
				updateSlaPolicy({
					organizationId: ORG,
					policyId: POLICY,
					patch: { active: 'no' },
					customFetch: fetchFn
				}),
				updateSlaPolicy({
					organizationId: ORG,
					policyId: POLICY,
					patch: { resolutionMinutes: -1 },
					customFetch: fetchFn
				})
			])
				await rejectsWith(promise, { status: 0, code: 'INVALID_INPUT' });
			assert.equal(calls.length, 0);
		}
	);

	await t.test('parser estricto: payloads incoherentes -> INVALID_PAYLOAD', async () => {
		for (const bad of [
			{},
			{ slaPolicies: [policy(), policy()] },
			{ slaPolicies: [policy({ id: randomUUID(), isDefault: true }), policy({ isDefault: true })] },
			{ slaPolicies: [policy({ isDefault: true, active: false })] },
			{ slaPolicies: [policy({ firstResponseMinutes: 500, resolutionMinutes: 100 })] },
			{ slaPolicies: [policy({ firstResponseMinutes: 0 })] },
			{ slaPolicies: [policy({ code: 'Mal Code' })] },
			{ slaPolicies: [policy({ createdAt: 'ayer' })] }
		])
			await rejectsWith(
				listSlaPolicies({ organizationId: ORG, customFetch: async () => json(bad) }),
				{
					code: 'INVALID_PAYLOAD'
				}
			);
		await rejectsWith(
			getSlaPolicy({
				organizationId: ORG,
				policyId: POLICY,
				customFetch: async () => json({ slaPolicy: policy({ id: randomUUID() }) })
			}),
			{ code: 'INVALID_PAYLOAD' }
		);
		await rejectsWith(
			createSlaPolicy({
				organizationId: ORG,
				policy: draft,
				customFetch: async () => json({ slaPolicy: policy() }, 200)
			}),
			{ code: 'INVALID_PAYLOAD' }
		);
	});

	await t.test('mapeo HTTP: 400/401/403/404/409/5xx con mensajes fijos', async () => {
		const res = (status, code) => async () =>
			json({ error: { code, message: 'SQL: sla_policies_org_code_unique' } }, status);
		const create = (customFetch) =>
			createSlaPolicy({ organizationId: ORG, policy: draft, customFetch });
		await rejectsWith(create(res(400, 'INVALID_INPUT')), { status: 400, code: 'INVALID_INPUT' });
		await rejectsWith(create(res(400, 'SLA_POLICY_INVALID_TARGET')), {
			status: 400,
			code: 'SLA_POLICY_INVALID_TARGET'
		});
		await rejectsWith(create(res(401, 'UNAUTHORIZED')), { status: 401, code: 'UNAUTHORIZED' });
		await assert.rejects(
			create(res(403, 'FORBIDDEN')),
			(e) => e.code === 'FORBIDDEN' && /gestionar/.test(e.message)
		);
		await rejectsWith(
			getSlaPolicy({
				organizationId: ORG,
				policyId: POLICY,
				customFetch: res(404, 'SLA_POLICY_NOT_FOUND')
			}),
			{ status: 404, code: 'SLA_POLICY_NOT_FOUND' }
		);
		for (const code of ['SLA_POLICY_CODE_CONFLICT', 'SLA_POLICY_INVALID_DEFAULT'])
			await assert.rejects(create(res(409, code)), (e) => {
				assert.equal(e.code, code);
				assert.ok(!e.message.includes('SQL'));
				return true;
			});
		await rejectsWith(create(res(409, 'OTRO')), { status: 409, code: 'CONFLICT' });
		await rejectsWith(create(res(500, 'INTERNAL_ERROR')), { status: 500, code: 'SERVER_ERROR' });
	});

	await t.test('AbortError se propaga; fallo de red -> NETWORK_ERROR', async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			listSlaPolicies({
				organizationId: ORG,
				signal: controller.signal,
				customFetch: async () => {
					throw new DOMException('aborted', 'AbortError');
				}
			}),
			(e) => e.name === 'AbortError'
		);
		await rejectsWith(
			updateSlaPolicy({
				organizationId: ORG,
				policyId: POLICY,
				patch: { name: 'X' },
				customFetch: async () => {
					throw new TypeError('fetch failed');
				}
			}),
			{ status: 0, code: 'NETWORK_ERROR' }
		);
	});

	await t.test('hardening: sin storage, demo ni cabeceras de identidad', () => {
		const source = fs.readFileSync('src/lib/api/sla-policies.ts', 'utf8');
		assert.ok(!/^import /m.test(source));
		for (const forbidden of [
			'localStorage',
			'sessionStorage',
			'demo',
			'x-user-id',
			'x-organization-id'
		])
			assert.ok(!source.includes(forbidden), forbidden);
	});

	await t.test('E2E cliente: Admin crea, lista, actualiza; Technician solo lee', async (st) => {
		const f = await fixture(st);
		const { db, schema: s, server } = f;
		const { ensureOrganizationRoles } = await server.ssrLoadModule(
			'/src/lib/server/services/roles.ts'
		);
		const routes = {
			list: await server.ssrLoadModule('/src/routes/api/sla-policies/+server.ts'),
			item: await server.ssrLoadModule('/src/routes/api/sla-policies/[id]/+server.ts')
		};
		const [org] = await db
			.insert(s.organizations)
			.values({ name: 'E2E SLA', slug: 'e2e-sla-' + randomUUID(), status: 'active' })
			.returning();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		async function session(code) {
			const user = await createCredentialUser(f, { email: `sla-${randomUUID()}@example.test` });
			const [membership] = await db
				.insert(s.memberships)
				.values({ organizationId: org.id, userId: user.id })
				.returning();
			await db.insert(s.roleAssignments).values({
				organizationId: org.id,
				membershipId: membership.id,
				roleId: roles.find((r) => r.code === code).id,
				scopeType: 'organization'
			});
			return (await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) }))
				.cookieHeader;
		}
		const bridge = (cookie) => async (url, init) => {
			const parsed = new URL(url, 'http://localhost');
			const parts = parsed.pathname.split('/').filter(Boolean);
			const request = new Request(parsed, {
				method: init.method,
				headers: { ...(init.headers ?? {}), cookie },
				body: init.body
			});
			const event = { url: parsed, request };
			if (parts.length === 2) return routes.list[init.method]({ ...event, params: {} });
			return routes.item[init.method]({ ...event, params: { id: parts[2] } });
		};
		const admin = bridge(await session('organization_admin'));
		const tech = bridge(await session('technician'));
		const created = await createSlaPolicy({
			organizationId: org.id,
			policy: { ...draft, isDefault: true },
			customFetch: admin
		});
		assert.equal(created.isDefault, true);
		assert.deepEqual(await listSlaPolicies({ organizationId: org.id, customFetch: tech }), [
			created
		]);
		const updated = await updateSlaPolicy({
			organizationId: org.id,
			policyId: created.id,
			patch: { active: false },
			customFetch: admin
		});
		assert.equal(updated.active, false);
		assert.equal(updated.isDefault, false);
		await rejectsWith(
			updateSlaPolicy({
				organizationId: org.id,
				policyId: created.id,
				patch: { name: 'X' },
				customFetch: tech
			}),
			{ status: 403, code: 'FORBIDDEN' }
		);
		await rejectsWith(
			createSlaPolicy({ organizationId: org.id, policy: draft, customFetch: admin }),
			{ status: 409, code: 'SLA_POLICY_CODE_CONFLICT' }
		);
	});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
	listMemberships,
	getMembership,
	assignRole,
	revokeRole,
	MembershipApiError
} from '../src/lib/api/memberships.ts';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

const ORG = randomUUID();
const MEMBERSHIP = randomUUID();
const ROLE = randomUUID();
const USER = randomUUID();

function role(overrides = {}) {
	return {
		id: ROLE,
		code: 'technician',
		name: 'Técnico de soporte',
		active: true,
		isCustom: false,
		...overrides
	};
}
function membership(overrides = {}) {
	return {
		id: MEMBERSHIP,
		user: { id: USER, name: 'Ana', email: 'ana@example.test', active: true },
		active: true,
		roles: [role()],
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
		assert.ok(error instanceof MembershipApiError, `esperado MembershipApiError: ${error}`);
		if (status !== undefined) assert.equal(error.status, status);
		assert.equal(error.code, code);
		return true;
	});
}
const ids = { organizationId: ORG, membershipId: MEMBERSHIP, roleId: ROLE };

test('SoporteFlow — Etapa 5.4R-C: cliente API de memberships', async (t) => {
	await t.test(
		'41, 53-55. listMemberships: GET, URL, signal, customFetch, sin cabeceras',
		async () => {
			const controller = new AbortController();
			const { fetchFn, calls } = mockFetch(json({ memberships: [membership()] }));
			const listed = await listMemberships({
				organizationId: ORG,
				customFetch: fetchFn,
				signal: controller.signal
			});
			assert.deepEqual(listed, [membership()]);
			assert.equal(calls[0].url, `/api/memberships?organizationId=${ORG}`);
			assert.equal(calls[0].init.method, 'GET');
			assert.equal(calls[0].init.signal, controller.signal);
			assert.equal(calls[0].init.headers, undefined);
			assert.equal(calls[0].init.body, undefined);
		}
	);

	await t.test('42. getMembership: URL con id, email null aceptado, id verificado', async () => {
		const { fetchFn, calls } = mockFetch(
			json({ membership: membership({ user: { ...membership().user, email: null } }) })
		);
		const got = await getMembership({
			organizationId: ORG,
			membershipId: MEMBERSHIP,
			customFetch: fetchFn
		});
		assert.equal(got.user.email, null);
		assert.equal(calls[0].url, `/api/memberships/${MEMBERSHIP}?organizationId=${ORG}`);
		await rejectsWith(
			getMembership({
				organizationId: ORG,
				membershipId: MEMBERSHIP,
				customFetch: async () => json({ membership: membership({ id: randomUUID() }) })
			}),
			{ code: 'INVALID_PAYLOAD' }
		);
	});

	await t.test(
		'43. assignRole: POST con body {roleId}, 201 created y 200 idempotente',
		async () => {
			const { fetchFn, calls } = mockFetch(
				json({ assignment: { membershipId: MEMBERSHIP, role: role(), created: true } }, 201)
			);
			const result = await assignRole({ ...ids, customFetch: fetchFn });
			assert.deepEqual(result, { membershipId: MEMBERSHIP, role: role(), created: true });
			assert.equal(calls[0].url, `/api/memberships/${MEMBERSHIP}/roles?organizationId=${ORG}`);
			assert.equal(calls[0].init.method, 'POST');
			assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json' });
			assert.deepEqual(JSON.parse(calls[0].init.body), { roleId: ROLE });
			const again = await assignRole({
				...ids,
				customFetch: async () =>
					json({ assignment: { membershipId: MEMBERSHIP, role: role(), created: false } }, 200)
			});
			assert.equal(again.created, false);
		}
	);

	await t.test('44. revokeRole: DELETE sin body y 204', async () => {
		const { fetchFn, calls } = mockFetch(new Response(null, { status: 204 }));
		assert.equal(await revokeRole({ ...ids, customFetch: fetchFn }), undefined);
		assert.equal(
			calls[0].url,
			`/api/memberships/${MEMBERSHIP}/roles/${ROLE}?organizationId=${ORG}`
		);
		assert.equal(calls[0].init.method, 'DELETE');
		assert.equal(calls[0].init.body, undefined);
		await rejectsWith(revokeRole({ ...ids, customFetch: async () => json({}, 200) }), {
			code: 'INVALID_PAYLOAD'
		});
	});

	await t.test('45. UUID inválido no llama a fetch', async () => {
		const { fetchFn, calls } = mockFetch(json({}));
		for (const promise of [
			listMemberships({ organizationId: 'nope', customFetch: fetchFn }),
			listMemberships({ customFetch: fetchFn }),
			getMembership({ organizationId: ORG, membershipId: 'x', customFetch: fetchFn }),
			assignRole({ ...ids, roleId: 'x', customFetch: fetchFn }),
			assignRole({ ...ids, membershipId: undefined, customFetch: fetchFn }),
			revokeRole({ ...ids, organizationId: '', customFetch: fetchFn }),
			revokeRole({ ...ids, roleId: `${ROLE}/../x`, customFetch: fetchFn })
		])
			await rejectsWith(promise, { status: 0, code: 'INVALID_INPUT' });
		assert.equal(calls.length, 0);
	});

	await t.test('46. payload inválido, duplicados y campos extra descartados', async () => {
		for (const body of [
			{},
			{ memberships: 'x' },
			{ memberships: [membership({ roles: [role(), role()] })] },
			{ memberships: [membership(), membership()] },
			{ memberships: [membership({ active: 'yes' })] },
			{ memberships: [membership({ user: null })] },
			{ memberships: [membership({ user: { ...membership().user, email: 5 } })] },
			{ memberships: [membership({ roles: [role({ id: 'x' })] })] },
			{ memberships: [membership({ roles: [role({ active: 1 })] })] }
		])
			await rejectsWith(
				listMemberships({ organizationId: ORG, customFetch: async () => json(body) }),
				{ code: 'INVALID_PAYLOAD' }
			);
		const [clean] = await listMemberships({
			organizationId: ORG,
			customFetch: async () =>
				json({
					memberships: [
						{
							...membership({
								user: { ...membership().user, passwordHash: 'h', sessions: [] },
								roles: [{ ...role(), permissions: ['x:y'], organizationId: ORG }]
							}),
							organizationId: ORG,
							secret: 's'
						}
					]
				})
		});
		assert.deepEqual(clean, membership());
		for (const bad of [
			json(
				{
					assignment: { membershipId: MEMBERSHIP, role: role({ id: randomUUID() }), created: true }
				},
				201
			),
			json({ assignment: { membershipId: randomUUID(), role: role(), created: true } }, 201),
			json({ assignment: { membershipId: MEMBERSHIP, role: role(), created: false } }, 201),
			json({ assignment: { membershipId: MEMBERSHIP, role: role(), created: true } }, 200),
			json({ assignment: { membershipId: MEMBERSHIP, role: role() } }, 201),
			json({ assignment: null }, 201),
			new Response(null, { status: 204 })
		])
			await rejectsWith(assignRole({ ...ids, customFetch: async () => bad }), {
				code: 'INVALID_PAYLOAD'
			});
	});

	await t.test('47-49. 401, 403 (FORBIDDEN / PERMISSION_NOT_DELEGABLE) y 404 tipados', async () => {
		const res = (status, code) => async () =>
			json({ error: { code, message: 'SQL: select * from role_assignments' } }, status);
		await rejectsWith(
			listMemberships({ organizationId: ORG, customFetch: res(401, 'UNAUTHORIZED') }),
			{
				status: 401,
				code: 'UNAUTHORIZED'
			}
		);
		await assert.rejects(
			listMemberships({ organizationId: ORG, customFetch: res(403, 'FORBIDDEN') }),
			(e) => e.code === 'FORBIDDEN' && e.message.includes('consultar')
		);
		await assert.rejects(
			assignRole({ ...ids, customFetch: res(403, 'FORBIDDEN') }),
			(e) => e.code === 'FORBIDDEN' && e.message.includes('gestionar')
		);
		await rejectsWith(assignRole({ ...ids, customFetch: res(403, 'PERMISSION_NOT_DELEGABLE') }), {
			status: 403,
			code: 'PERMISSION_NOT_DELEGABLE'
		});
		for (const code of ['MEMBERSHIP_NOT_FOUND', 'ROLE_NOT_FOUND', 'ROLE_ASSIGNMENT_NOT_FOUND'])
			await rejectsWith(revokeRole({ ...ids, customFetch: res(404, code) }), { status: 404, code });
		await rejectsWith(revokeRole({ ...ids, customFetch: res(404, 'WHATEVER') }), {
			status: 404,
			code: 'NOT_FOUND'
		});
		await rejectsWith(getMembership({ ...ids, customFetch: res(400, 'INVALID_INPUT') }), {
			status: 400,
			code: 'INVALID_INPUT'
		});
	});

	await t.test(
		'50. 409 tipados y genérico; 5xx con mensaje fijo, sin eco del backend',
		async () => {
			const res = (status, code) => async () =>
				json({ error: { code, message: 'constraint role_assignments_unique_idx' } }, status);
			for (const code of ['MEMBERSHIP_INACTIVE', 'ROLE_INACTIVE', 'LAST_ADMIN_REQUIRED'])
				await assert.rejects(assignRole({ ...ids, customFetch: res(409, code) }), (e) => {
					assert.equal(e.status, 409);
					assert.equal(e.code, code);
					assert.ok(!e.message.includes('constraint'));
					return true;
				});
			await rejectsWith(revokeRole({ ...ids, customFetch: res(409, 'OTHER') }), {
				status: 409,
				code: 'CONFLICT'
			});
			await assert.rejects(revokeRole({ ...ids, customFetch: res(500, 'INTERNAL_ERROR') }), (e) => {
				assert.equal(e.code, 'SERVER_ERROR');
				assert.equal(e.message, 'No se pudo retirar el rol. Inténtalo de nuevo.');
				return true;
			});
		}
	);

	await t.test('51-52. AbortError se propaga; fallo de red -> NETWORK_ERROR', async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			listMemberships({
				organizationId: ORG,
				signal: controller.signal,
				customFetch: async () => {
					throw new DOMException('aborted', 'AbortError');
				}
			}),
			(e) => e.name === 'AbortError'
		);
		await rejectsWith(
			assignRole({
				...ids,
				customFetch: async () => {
					throw new TypeError('fetch failed');
				}
			}),
			{ status: 0, code: 'NETWORK_ERROR' }
		);
	});

	await t.test(
		'55. hardening: sin storage, demo, cabeceras de identidad ni lógica de permisos',
		() => {
			const source = fs.readFileSync('src/lib/api/memberships.ts', 'utf8');
			assert.ok(!/^import /m.test(source));
			for (const forbidden of [
				'localStorage',
				'sessionStorage',
				'demo',
				'x-user-id',
				'x-organization-id',
				'hasPermission',
				'actorUserId',
				"'organization_admin'"
			])
				assert.ok(!source.includes(forbidden), forbidden);
		}
	);

	await t.test(
		'E2E cliente: lista, asigna, revoca y último admin vía handlers reales',
		async (st) => {
			const f = await fixture(st);
			const { db, schema: s, server } = f;
			const { ensureOrganizationRoles } = await server.ssrLoadModule(
				'/src/lib/server/services/roles.ts'
			);
			const routes = {
				list: await server.ssrLoadModule('/src/routes/api/memberships/+server.ts'),
				detail: await server.ssrLoadModule('/src/routes/api/memberships/[id]/+server.ts'),
				assign: await server.ssrLoadModule('/src/routes/api/memberships/[id]/roles/+server.ts'),
				revoke: await server.ssrLoadModule(
					'/src/routes/api/memberships/[id]/roles/[roleId]/+server.ts'
				)
			};
			const [org] = await db
				.insert(s.organizations)
				.values({ name: 'E2E RC', slug: 'e2e-rc-' + randomUUID(), status: 'active' })
				.returning();
			const { roles } = await ensureOrganizationRoles(db, org.id);
			const admin = roles.find((r) => r.code === 'organization_admin');
			const tech = roles.find((r) => r.code === 'technician');
			const join = async (roleIds) => {
				const user = await createCredentialUser(f);
				const [m] = await db
					.insert(s.memberships)
					.values({ organizationId: org.id, userId: user.id })
					.returning();
				for (const roleId of roleIds)
					await db.insert(s.roleAssignments).values({
						organizationId: org.id,
						membershipId: m.id,
						roleId,
						scopeType: 'organization'
					});
				return m;
			};
			const me = await createCredentialUser(f);
			const [mine] = await db
				.insert(s.memberships)
				.values({ organizationId: org.id, userId: me.id })
				.returning();
			await db.insert(s.roleAssignments).values({
				organizationId: org.id,
				membershipId: mine.id,
				roleId: admin.id,
				scopeType: 'organization'
			});
			const worker = await join([]);
			const session = await createSession(f, me.id, { expiresAt: new Date(Date.now() + 3600000) });
			const bridge = async (url, init) => {
				const parsed = new URL(url, 'http://localhost');
				const parts = parsed.pathname.split('/').filter(Boolean);
				const request = new Request(parsed, {
					method: init.method,
					headers: { ...(init.headers ?? {}), cookie: session.cookieHeader },
					body: init.body
				});
				const event = { url: parsed, request };
				if (parts.length === 2) return routes.list.GET({ ...event, params: {} });
				if (parts.length === 3) return routes.detail.GET({ ...event, params: { id: parts[2] } });
				if (parts.length === 4) return routes.assign.POST({ ...event, params: { id: parts[2] } });
				return routes.revoke.DELETE({ ...event, params: { id: parts[2], roleId: parts[4] } });
			};
			const listed = await listMemberships({ organizationId: org.id, customFetch: bridge });
			assert.equal(listed.length, 2);
			const assigned = await assignRole({
				organizationId: org.id,
				membershipId: worker.id,
				roleId: tech.id,
				customFetch: bridge
			});
			assert.equal(assigned.created, true);
			const again = await assignRole({
				organizationId: org.id,
				membershipId: worker.id,
				roleId: tech.id,
				customFetch: bridge
			});
			assert.equal(again.created, false);
			const shown = await getMembership({
				organizationId: org.id,
				membershipId: worker.id,
				customFetch: bridge
			});
			assert.deepEqual(
				shown.roles.map((r) => r.code),
				['technician']
			);
			await revokeRole({
				organizationId: org.id,
				membershipId: worker.id,
				roleId: tech.id,
				customFetch: bridge
			});
			await rejectsWith(
				revokeRole({
					organizationId: org.id,
					membershipId: worker.id,
					roleId: tech.id,
					customFetch: bridge
				}),
				{ status: 404, code: 'ROLE_ASSIGNMENT_NOT_FOUND' }
			);
			await rejectsWith(
				revokeRole({
					organizationId: org.id,
					membershipId: mine.id,
					roleId: admin.id,
					customFetch: bridge
				}),
				{ status: 409, code: 'LAST_ADMIN_REQUIRED' }
			);
		}
	);
});

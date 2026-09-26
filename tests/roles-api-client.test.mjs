import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
	listPermissions,
	listRoles,
	getRole,
	createRole,
	updateRole,
	RoleApiError
} from '../src/lib/api/roles.ts';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

const ORG = randomUUID();
const ROLE = randomUUID();

function permission(overrides = {}) {
	return {
		id: 'sites:view',
		name: 'Ver sedes',
		description: 'Consultar sedes.',
		category: 'sites',
		allowedScopeTypes: ['organization'],
		...overrides
	};
}
function role(overrides = {}) {
	return {
		id: ROLE,
		code: 'technician',
		name: 'Técnico de soporte',
		description: null,
		templateId: 'tpl_technician',
		isCustom: false,
		active: true,
		permissions: ['incidents:view_all', 'sites:view'],
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
		assert.ok(error instanceof RoleApiError, `esperado RoleApiError: ${error}`);
		if (status !== undefined) assert.equal(error.status, status);
		assert.equal(error.code, code);
		return true;
	});
}

test('SoporteFlow — Etapa 5.4R-A: cliente API de roles', async (t) => {
	await t.test(
		'31-33, 44-46. listPermissions/listRoles/getRole: URL, GET, signal, customFetch, sin cabeceras',
		async () => {
			const controller = new AbortController();
			const { fetchFn, calls } = mockFetch((url) =>
				url.startsWith('/api/permissions')
					? json({
							permissions: [permission(), permission({ id: 'roles:view', category: 'roles' })]
						})
					: url.startsWith('/api/roles?')
						? json({ roles: [role()] })
						: json({ role: role() })
			);
			const perms = await listPermissions({
				organizationId: ORG,
				customFetch: fetchFn,
				signal: controller.signal
			});
			assert.deepEqual(
				perms.map((p) => p.id),
				['sites:view', 'roles:view']
			);
			assert.deepEqual(await listRoles({ organizationId: ORG, customFetch: fetchFn }), [role()]);
			await listRoles({ organizationId: ORG, activeOnly: true, customFetch: fetchFn });
			assert.deepEqual(
				await getRole({
					organizationId: ORG,
					roleId: ROLE,
					customFetch: fetchFn,
					userId: randomUUID()
				}),
				role()
			);
			assert.deepEqual(
				calls.map((c) => c.url),
				[
					`/api/permissions?organizationId=${ORG}`,
					`/api/roles?organizationId=${ORG}`,
					`/api/roles?organizationId=${ORG}&activeOnly=true`,
					`/api/roles/${ROLE}?organizationId=${ORG}`
				]
			);
			assert.equal(calls[0].init.signal, controller.signal);
			for (const call of calls) {
				assert.equal(call.init.method, 'GET');
				assert.equal(call.init.body, undefined);
				assert.equal(call.init.headers, undefined);
				assert.ok(!call.url.includes('userId') && !call.url.includes('membershipId'));
			}
		}
	);

	await t.test('34-35. UUID de organización o rol inválido no llama a fetch', async () => {
		const { fetchFn, calls } = mockFetch(() => json({}));
		for (const run of [
			() => listPermissions({ organizationId: 'x', customFetch: fetchFn }),
			() => listRoles({ organizationId: '../x', customFetch: fetchFn }),
			() => listRoles({ organizationId: ORG, activeOnly: 'true', customFetch: fetchFn }),
			() => getRole({ organizationId: ORG, roleId: 'nope', customFetch: fetchFn }),
			() => getRole({ organizationId: ORG, roleId: '../../x', customFetch: fetchFn })
		])
			await rejectsWith(run(), { status: 0, code: 'INVALID_INPUT' });
		assert.equal(calls.length, 0);
	});

	await t.test('36-38. payload inválido, duplicados y campos extra descartados', async () => {
		const badPermissions = [
			{},
			{ permissions: 'x' },
			{ permissions: [permission({ id: 'Sites View' })] },
			{ permissions: [permission({ allowedScopeTypes: ['galaxy'] })] },
			{ permissions: [permission({ allowedScopeTypes: [] })] },
			{ permissions: [permission({ allowedScopeTypes: ['organization', 'organization'] })] },
			{ permissions: [permission(), permission()] },
			{ permissions: [permission({ name: '' })] }
		];
		for (const payload of badPermissions) {
			const { fetchFn } = mockFetch(() => json(payload));
			await rejectsWith(listPermissions({ organizationId: ORG, customFetch: fetchFn }), {
				code: 'INVALID_PAYLOAD'
			});
		}
		const badRoles = [
			{ roles: [role({ id: 'x' })] },
			{ roles: [role({ isCustom: 'false' })] },
			{ roles: [role({ active: 1 })] },
			{ roles: [role({ permissions: ['sites:view', 'sites:view'] })] },
			{ roles: [role({ permissions: 'sites:view' })] },
			{ roles: [role({ permissions: [5] })] },
			{ roles: [role({ templateId: 5 })] },
			{ roles: [role({ description: 5 })] },
			{ roles: [role(), role()] }
		];
		for (const payload of badRoles) {
			const { fetchFn } = mockFetch(() => json(payload));
			await rejectsWith(listRoles({ organizationId: ORG, customFetch: fetchFn }), {
				code: 'INVALID_PAYLOAD'
			});
		}
		const mismatch = mockFetch(() => json({ role: role({ id: randomUUID() }) }));
		await rejectsWith(
			getRole({ organizationId: ORG, roleId: ROLE, customFetch: mismatch.fetchFn }),
			{ code: 'INVALID_PAYLOAD' }
		);
		const extra = mockFetch(() =>
			json({
				roles: [
					{
						...role(),
						organizationId: ORG,
						assignments: [],
						membershipIds: [randomUUID()],
						templatePermissions: ['x:y']
					}
				]
			})
		);
		const [parsed] = await listRoles({ organizationId: ORG, customFetch: extra.fetchFn });
		assert.deepEqual(Object.keys(parsed).sort(), [
			'active',
			'code',
			'description',
			'id',
			'isCustom',
			'name',
			'permissions',
			'templateId'
		]);
		const extraPerm = mockFetch(() =>
			json({ permissions: [{ ...permission(), createdAt: '2026', platform: true }] })
		);
		const [p] = await listPermissions({ organizationId: ORG, customFetch: extraPerm.fetchFn });
		assert.deepEqual(Object.keys(p).sort(), [
			'allowedScopeTypes',
			'category',
			'description',
			'id',
			'name'
		]);
	});

	await t.test('39-43. AbortError, NETWORK_ERROR, 401, 403, 404 y mensajes fijos', async () => {
		const controller = new AbortController();
		const abortable = mockFetch(() => {
			controller.abort();
			throw new DOMException('aborted', 'AbortError');
		});
		await assert.rejects(
			listRoles({ organizationId: ORG, signal: controller.signal, customFetch: abortable.fetchFn }),
			(e) => e.name === 'AbortError' && !(e instanceof RoleApiError)
		);
		const network = mockFetch(() => {
			throw new TypeError('fetch failed');
		});
		await rejectsWith(listPermissions({ organizationId: ORG, customFetch: network.fetchFn }), {
			status: 0,
			code: 'NETWORK_ERROR'
		});
		for (const [status, body, code] of [
			[400, { error: { code: 'INVALID_INPUT' } }, 'INVALID_INPUT'],
			[401, { error: { code: 'UNAUTHORIZED' } }, 'UNAUTHORIZED'],
			[403, { error: { code: 'FORBIDDEN' } }, 'FORBIDDEN'],
			[404, { error: { code: 'ROLE_NOT_FOUND', message: 'SQL secret' } }, 'ROLE_NOT_FOUND'],
			[404, 'x', 'NOT_FOUND'],
			[500, { error: { code: 'INTERNAL_ERROR', message: 'SQL secret' } }, 'SERVER_ERROR'],
			[418, {}, 'INTERNAL_ERROR']
		]) {
			const { fetchFn } = mockFetch(
				() => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
			);
			await assert.rejects(
				getRole({ organizationId: ORG, roleId: ROLE, customFetch: fetchFn }),
				(e) => {
					assert.ok(e instanceof RoleApiError);
					assert.equal(e.status, status);
					assert.equal(e.code, code);
					assert.ok(!e.message.includes('SQL'));
					return true;
				}
			);
		}
	});

	await t.test('hardening: sin storage, demo, cabeceras de identidad ni lógica de permisos', () => {
		const source = fs.readFileSync('src/lib/api/roles.ts', 'utf8');
		assert.ok(!/^import /m.test(source));
		for (const forbidden of [
			'localStorage',
			'sessionStorage',
			'demo',
			'x-user-id',
			'x-organization-id',
			'hasPermission',
			'membershipId',
			'actorUserId'
		])
			assert.ok(!source.includes(forbidden), forbidden);
	});

	await t.test('E2E: Admin real lista permisos y roles y obtiene technician', async (st) => {
		const f = await fixture(st);
		const { db, schema: s, server } = f;
		const { ensureOrganizationRoles } = await server.ssrLoadModule(
			'/src/lib/server/services/roles.ts'
		);
		const { ROLE_TEMPLATES } = await server.ssrLoadModule('/src/lib/server/auth/role-templates.ts');
		const { PERMISSION_IDS } = await server.ssrLoadModule('/src/lib/server/auth/permissions.ts');
		const routes = {
			permissions: await server.ssrLoadModule('/src/routes/api/permissions/+server.ts'),
			roles: await server.ssrLoadModule('/src/routes/api/roles/+server.ts'),
			role: await server.ssrLoadModule('/src/routes/api/roles/[id]/+server.ts')
		};
		const [org] = await db
			.insert(s.organizations)
			.values({ name: 'E2E roles', slug: 'e2e-' + randomUUID(), status: 'active' })
			.returning();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		const admin = roles.find((r) => r.code === 'organization_admin');
		const tech = roles.find((r) => r.code === 'technician');
		const user = await createCredentialUser(f);
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
		await db.insert(s.roleAssignments).values({
			organizationId: org.id,
			membershipId: membership.id,
			roleId: admin.id,
			scopeType: 'organization'
		});
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		const bridge = async (url) => {
			const parsed = new URL(url, 'http://localhost');
			const parts = parsed.pathname.split('/').filter(Boolean);
			const request = new Request(parsed, { headers: { cookie: session.cookieHeader } });
			if (parts[1] === 'permissions')
				return routes.permissions.GET({ url: parsed, params: {}, request });
			if (parts.length === 2) return routes.roles.GET({ url: parsed, params: {}, request });
			return routes.role.GET({ url: parsed, params: { id: parts[2] }, request });
		};
		const permissions = await listPermissions({ organizationId: org.id, customFetch: bridge });
		assert.deepEqual(
			permissions.map((p) => p.id),
			[...PERMISSION_IDS]
		);
		const listed = await listRoles({ organizationId: org.id, customFetch: bridge });
		assert.deepEqual(
			listed.map((r) => r.code),
			['customer', 'organization_admin', 'technician']
		);
		const technician = await getRole({
			organizationId: org.id,
			roleId: tech.id,
			customFetch: bridge
		});
		assert.deepEqual(
			technician.permissions,
			PERMISSION_IDS.filter((id) => ROLE_TEMPLATES[1].permissionIds.includes(id))
		);
		assert.equal(technician.isCustom, false);
		await rejectsWith(
			getRole({ organizationId: org.id, roleId: randomUUID(), customFetch: bridge }),
			{ status: 404, code: 'ROLE_NOT_FOUND' }
		);
	});
});

test('SoporteFlow — Etapa 5.4R-B: cliente API de mutaciones de roles', async (t) => {
	const custom = (overrides = {}) =>
		role({
			code: 'supervisor',
			name: 'Supervisor',
			templateId: null,
			isCustom: true,
			permissions: ['sites:view'],
			...overrides
		});
	const draft = { name: 'Supervisor', code: 'supervisor', permissions: ['sites:view'] };

	await t.test('42. createRole: POST, URL, JSON, signal, customFetch, sin identidad', async () => {
		const controller = new AbortController();
		const { fetchFn, calls } = mockFetch(json({ role: custom() }, 201));
		const created = await createRole({
			organizationId: ORG,
			role: { ...draft, description: 'Supervisa' },
			customFetch: fetchFn,
			signal: controller.signal
		});
		assert.deepEqual(created, custom());
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, `/api/roles?organizationId=${ORG}`);
		assert.equal(calls[0].init.method, 'POST');
		assert.equal(calls[0].init.signal, controller.signal);
		assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json' });
		assert.deepEqual(JSON.parse(calls[0].init.body), { ...draft, description: 'Supervisa' });
		assert.ok(!('credentials' in calls[0].init));
	});

	await t.test('43. createRole: sin description no se envía; null se envía', async () => {
		const { fetchFn, calls } = mockFetch(() => json({ role: custom() }, 201));
		await createRole({ organizationId: ORG, role: draft, customFetch: fetchFn });
		assert.ok(!('description' in JSON.parse(calls[0].init.body)));
		await createRole({
			organizationId: ORG,
			role: { ...draft, description: null },
			customFetch: fetchFn
		});
		assert.equal(JSON.parse(calls[1].init.body).description, null);
	});

	await t.test('44. createRole: entrada inválida no llama a fetch', async () => {
		const { fetchFn, calls } = mockFetch(json({ role: custom() }, 201));
		for (const input of [
			{ organizationId: 'nope', role: draft },
			{ organizationId: ORG },
			{ organizationId: ORG, role: { ...draft, code: 'Bad Code' } },
			{ organizationId: ORG, role: { ...draft, name: ' ' } },
			{ organizationId: ORG, role: { ...draft, permissions: ['sites:view', 'sites:view'] } },
			{ organizationId: ORG, role: { ...draft, permissions: 'sites:view' } },
			{ organizationId: ORG, role: { ...draft, description: 3 } }
		])
			await rejectsWith(createRole({ ...input, customFetch: fetchFn }), {
				status: 0,
				code: 'INVALID_INPUT'
			});
		assert.equal(calls.length, 0);
	});

	await t.test(
		'45. createRole: no 201, payload inválido o code distinto -> INVALID_PAYLOAD',
		async () => {
			for (const response of [
				json({ role: custom() }, 200),
				json({ role: { ...custom(), permissions: 'x' } }, 201),
				json({ role: custom({ code: 'otro' }) }, 201),
				json({}, 201),
				new Response('not json', { status: 201 })
			])
				await rejectsWith(
					createRole({ organizationId: ORG, role: draft, customFetch: async () => response }),
					{ code: 'INVALID_PAYLOAD' }
				);
		}
	);

	await t.test('46. createRole: campos extra del backend se descartan', async () => {
		const created = await createRole({
			organizationId: ORG,
			role: draft,
			customFetch: async () =>
				json({ role: { ...custom(), organizationId: ORG, assignments: [], secret: 'x' } }, 201)
		});
		assert.deepEqual(Object.keys(created).sort(), Object.keys(custom()).sort());
	});

	await t.test('47. updateRole: PATCH, URL, cuerpo sólo con campos definidos', async () => {
		const { fetchFn, calls } = mockFetch(json({ role: custom({ name: 'Nuevo' }) }));
		const updated = await updateRole({
			organizationId: ORG,
			roleId: ROLE,
			patch: { name: 'Nuevo', description: undefined, active: false },
			customFetch: fetchFn
		});
		assert.equal(updated.name, 'Nuevo');
		assert.equal(calls[0].url, `/api/roles/${ROLE}?organizationId=${ORG}`);
		assert.equal(calls[0].init.method, 'PATCH');
		assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json' });
		assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'Nuevo', active: false });
	});

	await t.test('48. updateRole: permissions [] y description null viajan tal cual', async () => {
		const { fetchFn, calls } = mockFetch(json({ role: custom() }));
		await updateRole({
			organizationId: ORG,
			roleId: ROLE,
			patch: { permissions: [], description: null },
			customFetch: fetchFn
		});
		assert.deepEqual(JSON.parse(calls[0].init.body), { permissions: [], description: null });
	});

	await t.test(
		'49. updateRole: patch vacío, code, desconocidos o inválidos no llaman a fetch',
		async () => {
			const { fetchFn, calls } = mockFetch(json({ role: custom() }));
			for (const input of [
				{ organizationId: ORG, roleId: ROLE, patch: {} },
				{ organizationId: ORG, roleId: ROLE, patch: { name: undefined } },
				{ organizationId: ORG, roleId: ROLE },
				{ organizationId: ORG, roleId: ROLE, patch: [] },
				{ organizationId: ORG, roleId: ROLE, patch: { code: 'otro' } },
				{ organizationId: ORG, roleId: ROLE, patch: { extra: 1 } },
				{ organizationId: ORG, roleId: ROLE, patch: { active: 'false' } },
				{ organizationId: ORG, roleId: ROLE, patch: { name: '' } },
				{ organizationId: ORG, roleId: ROLE, patch: { permissions: ['bad'] } },
				{ organizationId: ORG, roleId: 'nope', patch: { name: 'X' } },
				{ organizationId: 'nope', roleId: ROLE, patch: { name: 'X' } }
			])
				await rejectsWith(updateRole({ ...input, customFetch: fetchFn }), {
					status: 0,
					code: 'INVALID_INPUT'
				});
			assert.equal(calls.length, 0);
		}
	);

	await t.test('50. updateRole: id devuelto distinto -> INVALID_PAYLOAD', async () => {
		await rejectsWith(
			updateRole({
				organizationId: ORG,
				roleId: ROLE,
				patch: { name: 'X' },
				customFetch: async () => json({ role: custom({ id: randomUUID() }) })
			}),
			{ code: 'INVALID_PAYLOAD' }
		);
	});

	await t.test('51. 409 tipados y genérico, sin eco del mensaje backend', async () => {
		const backend = (code) => async () =>
			json({ error: { code, message: 'SQL: duplicate key roles_org_code_unique' } }, 409);
		const cases = [
			['ROLE_CODE_CONFLICT', 'ROLE_CODE_CONFLICT'],
			['SYSTEM_ROLE_IMMUTABLE', 'SYSTEM_ROLE_IMMUTABLE'],
			['ROLE_HAS_UNKNOWN_PERMISSIONS', 'ROLE_HAS_UNKNOWN_PERMISSIONS'],
			['WHATEVER', 'CONFLICT']
		];
		for (const [backendCode, expected] of cases) {
			await assert.rejects(
				updateRole({
					organizationId: ORG,
					roleId: ROLE,
					patch: { name: 'X' },
					customFetch: backend(backendCode)
				}),
				(error) => {
					assert.equal(error.status, 409);
					assert.equal(error.code, expected);
					assert.ok(!error.message.includes('SQL'));
					return true;
				}
			);
		}
		await rejectsWith(
			createRole({ organizationId: ORG, role: draft, customFetch: backend('ROLE_CODE_CONFLICT') }),
			{ status: 409, code: 'ROLE_CODE_CONFLICT' }
		);
	});

	await t.test('52. 403: PERMISSION_NOT_DELEGABLE vs FORBIDDEN de gestión', async () => {
		const res = (code) => async () => json({ error: { code, message: 'x' } }, 403);
		await rejectsWith(
			createRole({
				organizationId: ORG,
				role: draft,
				customFetch: res('PERMISSION_NOT_DELEGABLE')
			}),
			{ status: 403, code: 'PERMISSION_NOT_DELEGABLE' }
		);
		await assert.rejects(
			updateRole({
				organizationId: ORG,
				roleId: ROLE,
				patch: { active: true },
				customFetch: res('FORBIDDEN')
			}),
			(error) => error.code === 'FORBIDDEN' && error.message.includes('gestionar')
		);
	});

	await t.test('53. 400, 401, 404 ROLE_NOT_FOUND y 5xx con mensajes fijos', async () => {
		const res = (status, code) => async () => json({ error: { code, message: 'leak' } }, status);
		const update = (customFetch) =>
			updateRole({ organizationId: ORG, roleId: ROLE, patch: { name: 'X' }, customFetch });
		await rejectsWith(update(res(400, 'INVALID_INPUT')), { status: 400, code: 'INVALID_INPUT' });
		await rejectsWith(update(res(401, 'UNAUTHORIZED')), { status: 401, code: 'UNAUTHORIZED' });
		await rejectsWith(update(res(404, 'ROLE_NOT_FOUND')), {
			status: 404,
			code: 'ROLE_NOT_FOUND'
		});
		await assert.rejects(update(res(500, 'INTERNAL_ERROR')), (error) => {
			assert.equal(error.code, 'SERVER_ERROR');
			assert.equal(error.message, 'No se pudo actualizar el rol. Inténtalo de nuevo.');
			return true;
		});
		await assert.rejects(
			createRole({ organizationId: ORG, role: draft, customFetch: res(503, 'X') }),
			(error) => error.message === 'No se pudo crear el rol. Inténtalo de nuevo.'
		);
	});

	await t.test('54. AbortError se propaga; fallo de red -> NETWORK_ERROR', async () => {
		const controller = new AbortController();
		controller.abort();
		const abort = async () => {
			throw new DOMException('aborted', 'AbortError');
		};
		await assert.rejects(
			createRole({
				organizationId: ORG,
				role: draft,
				customFetch: abort,
				signal: controller.signal
			}),
			(error) => error.name === 'AbortError'
		);
		await rejectsWith(
			updateRole({
				organizationId: ORG,
				roleId: ROLE,
				patch: { name: 'X' },
				customFetch: async () => {
					throw new TypeError('fetch failed');
				}
			}),
			{ status: 0, code: 'NETWORK_ERROR' }
		);
	});

	await t.test('55. la entrada del llamador no se muta', async () => {
		const permissions = ['sites:view'];
		const input = { ...draft, permissions };
		const { fetchFn } = mockFetch(json({ role: custom() }, 201));
		await createRole({ organizationId: ORG, role: input, customFetch: fetchFn });
		assert.deepEqual(permissions, ['sites:view']);
		assert.deepEqual(input, { ...draft, permissions });
	});

	await t.test('56. E2E cliente: crear y actualizar rol real vía handlers', async (st) => {
		const f = await fixture(st);
		const { db, schema: s, server } = f;
		const { ensureOrganizationRoles } = await server.ssrLoadModule(
			'/src/lib/server/services/roles.ts'
		);
		const routes = {
			roles: await server.ssrLoadModule('/src/routes/api/roles/+server.ts'),
			role: await server.ssrLoadModule('/src/routes/api/roles/[id]/+server.ts')
		};
		const [org] = await db
			.insert(s.organizations)
			.values({ name: 'E2E R-B', slug: 'e2e-rb-' + randomUUID(), status: 'active' })
			.returning();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		const admin = roles.find((r) => r.code === 'organization_admin');
		const tech = roles.find((r) => r.code === 'technician');
		const user = await createCredentialUser(f);
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
		await db.insert(s.roleAssignments).values({
			organizationId: org.id,
			membershipId: membership.id,
			roleId: admin.id,
			scopeType: 'organization'
		});
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		const bridge = async (url, init) => {
			const parsed = new URL(url, 'http://localhost');
			const parts = parsed.pathname.split('/').filter(Boolean);
			const request = new Request(parsed, {
				method: init.method,
				headers: { ...init.headers, cookie: session.cookieHeader },
				body: init.body
			});
			const route = parts.length === 2 ? routes.roles : routes.role;
			const params = parts.length === 2 ? {} : { id: parts[2] };
			return route[init.method]({ url: parsed, params, request });
		};
		const created = await createRole({
			organizationId: org.id,
			role: { name: 'Consultor', code: 'consultor', permissions: ['sites:view'] },
			customFetch: bridge
		});
		assert.equal(created.isCustom, true);
		assert.equal(created.templateId, null);
		const fetched = await getRole({
			organizationId: org.id,
			roleId: created.id,
			customFetch: bridge
		});
		assert.deepEqual(fetched, created);
		const updated = await updateRole({
			organizationId: org.id,
			roleId: created.id,
			patch: { permissions: ['sites:view', 'categories:view'], active: false },
			customFetch: bridge
		});
		assert.deepEqual(updated.permissions, ['sites:view', 'categories:view']);
		assert.equal(updated.active, false);
		await rejectsWith(
			createRole({
				organizationId: org.id,
				role: { name: 'Otro', code: 'consultor', permissions: [] },
				customFetch: bridge
			}),
			{ status: 409, code: 'ROLE_CODE_CONFLICT' }
		);
		await rejectsWith(
			updateRole({
				organizationId: org.id,
				roleId: tech.id,
				patch: { active: false },
				customFetch: bridge
			}),
			{ status: 409, code: 'SYSTEM_ROLE_IMMUTABLE' }
		);
		await rejectsWith(
			updateRole({
				organizationId: org.id,
				roleId: created.id,
				patch: { permissions: ['platform:manage'] },
				customFetch: bridge
			}),
			{ status: 400, code: 'INVALID_INPUT' }
		);
	});
});

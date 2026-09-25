import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { listPermissions, listRoles, getRole, RoleApiError } from '../src/lib/api/roles.ts';
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
			['organization_admin', 'technician']
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

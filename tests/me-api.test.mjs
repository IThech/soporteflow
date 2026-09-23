import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fixture, identity, createSession, createTamperedCookie } from './helpers/auth-fixture.mjs';

function makeEvent(request, url = new URL(request.url), route = { id: '/api/me' }) {
	return {
		request,
		url,
		params: {},
		locals: {},
		cookies: {
			get: (name) => {
				const cookie = request.headers.get('cookie');
				if (!cookie) return undefined;
				const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
				return match ? decodeURIComponent(match[1]) : undefined;
			},
			getAll: () => [],
			set: () => {},
			delete: () => {},
			serialize: () => ''
		},
		fetch: globalThis.fetch,
		getClientAddress: () => '127.0.0.1',
		isDataRequest: false,
		isSubRequest: false,
		platform: {},
		route,
		setHeaders: () => {}
	};
}

async function callGet(GET, { headers = {}, url = 'http://localhost/api/me' } = {}) {
	const reqHeaders = new Headers(headers);
	const request = new Request(url, {
		method: 'GET',
		headers: reqHeaders
	});
	const event = makeEvent(request, new URL(url));
	const response = await GET(event);
	const status = response.status;
	const json = await response.json();
	return { status, json, response };
}

test('SoporteFlow — Etapa 5.4A: Endpoint HTTP GET /api/me (Bootstrap)', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;

	const { GET } = await server.ssrLoadModule('/src/routes/api/me/+server.ts');
	const { getAuthenticatedUserContext, UserContextServiceError } = await server.ssrLoadModule(
		'/src/lib/server/services/user-context.ts'
	);

	// Setup User A
	const userA = await identity(f);
	const sessionA = await createSession(f, userA.id);

	// Setup User B
	const userB = await identity(f);
	const sessionB = await createSession(f, userB.id);

	// Setup Organizations
	const [orgAlpha] = await db
		.insert(s.organizations)
		.values({ name: 'Alpha Solutions', slug: 'alpha-' + randomUUID(), status: 'active' })
		.returning();

	const [orgBeta] = await db
		.insert(s.organizations)
		.values({ name: 'Beta Systems', slug: 'beta-' + randomUUID(), status: 'active' })
		.returning();

	const [orgGamma] = await db
		.insert(s.organizations)
		.values({ name: 'Gamma Corp', slug: 'gamma-' + randomUUID(), status: 'active' })
		.returning();

	const [orgSuspended] = await db
		.insert(s.organizations)
		.values({ name: 'Suspended Org', slug: 'susp-' + randomUUID(), status: 'suspended' })
		.returning();

	const [orgTrial] = await db
		.insert(s.organizations)
		.values({ name: 'Trial Org', slug: 'trial-' + randomUUID(), status: 'trial' })
		.returning();

	// Inactive membership in an active organization
	const [orgActiveInactiveMem] = await db
		.insert(s.organizations)
		.values({ name: 'Delta Inactive Org', slug: 'delta-' + randomUUID(), status: 'active' })
		.returning();

	// User A memberships:
	// - Active in orgBeta, orgAlpha, orgGamma
	// - Inactive in orgActiveInactiveMem
	// - Active in orgSuspended
	// - Active in orgTrial
	await db.insert(s.memberships).values([
		{ organizationId: orgBeta.id, userId: userA.id, active: true },
		{ organizationId: orgAlpha.id, userId: userA.id, active: true },
		{ organizationId: orgGamma.id, userId: userA.id, active: true },
		{ organizationId: orgSuspended.id, userId: userA.id, active: true },
		{ organizationId: orgTrial.id, userId: userA.id, active: true },
		{ organizationId: orgActiveInactiveMem.id, userId: userA.id, active: false }
	]);

	// User B exclusive organization
	const [orgBExclusive] = await db
		.insert(s.organizations)
		.values({ name: 'User B Only Org', slug: 'org-b-' + randomUUID(), status: 'active' })
		.returning();
	await db.insert(s.memberships).values({
		organizationId: orgBExclusive.id,
		userId: userB.id,
		active: true
	});

	// User C (valid user without any memberships)
	const userC = await identity(f);
	const sessionC = await createSession(f, userC.id);

	// Inactive user
	const userInactive = await identity(f);
	const sessionInactive = await createSession(f, userInactive.id);
	await db.update(s.users).set({ active: false }).where(eq(s.users.id, userInactive.id));

	// Expired session for User A
	const sessionExpired = await createSession(f, userA.id, {
		expiresAt: new Date(Date.now() - 3600 * 1000)
	});

	// =========================================================================
	// AUTHENTICATION (Tests 1 - 5)
	// =========================================================================
	await t.test('1. sin cookie -> 401', async () => {
		const res = await callGet(GET, { headers: {} });
		assert.equal(res.status, 401);
		assert.equal(res.json.error?.code, 'UNAUTHORIZED');
		assert.equal(res.json.error?.message, 'Authentication required.');
	});

	await t.test('2. cookie manipulada -> 401', async () => {
		const res = await callGet(GET, {
			headers: { cookie: createTamperedCookie() }
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error?.code, 'UNAUTHORIZED');
	});

	await t.test('3. sesión inexistente -> 401', async () => {
		// Valid format cookie with random non-existent token
		const res = await callGet(GET, {
			headers: { cookie: `soporteflow-auth.session_token=${randomUUID()}` }
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error?.code, 'UNAUTHORIZED');
	});

	await t.test('4. sesión expirada -> 401', async () => {
		const res = await callGet(GET, {
			headers: { cookie: sessionExpired.cookieHeader }
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error?.code, 'UNAUTHORIZED');
	});

	await t.test('5. users.active = false -> 401', async () => {
		const res = await callGet(GET, {
			headers: { cookie: sessionInactive.cookieHeader }
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error?.code, 'UNAUTHORIZED');
	});

	// =========================================================================
	// PROFILE (Tests 6 - 10)
	// =========================================================================
	await t.test('6. usuario válido -> 200', async () => {
		const res = await callGet(GET, {
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		assert.ok(res.json.user);
		assert.ok(Array.isArray(res.json.organizations));
	});

	await t.test('7. devuelve id correcto', async () => {
		const res = await callGet(GET, {
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.user.id, userA.id);
	});

	await t.test('8. devuelve name correcto', async () => {
		const res = await callGet(GET, {
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		// Name matches the synthetic identity created in fixture
		const [coreUser] = await db.select().from(s.users).where(eq(s.users.id, userA.id));
		assert.equal(res.json.user.name, coreUser.name);
	});

	await t.test('9. devuelve email real de auth_users', async () => {
		const res = await callGet(GET, {
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		const [authProfile] = await db.select().from(s.authUsers).where(eq(s.authUsers.id, userA.id));
		assert.equal(res.json.user.email, authProfile.email);
		assert.ok(res.json.user.email.includes('@'));
	});

	await t.test(
		'10. respuesta no contiene password, token, session, cookie, auth_accounts ni credentials',
		async () => {
			const res = await callGet(GET, {
				headers: { cookie: sessionA.cookieHeader }
			});
			assert.equal(res.status, 200);

			// Top-level keys strictly bounded
			assert.deepEqual(Object.keys(res.json).sort(), ['organizations', 'user']);

			// User keys strictly bounded
			assert.deepEqual(Object.keys(res.json.user).sort(), ['email', 'id', 'name']);

			// Ensure forbidden sensitive tokens do not leak
			const jsonString = JSON.stringify(res.json);
			assert.equal(jsonString.includes('password'), false);
			assert.equal(jsonString.includes('token'), false);
			assert.equal(jsonString.includes('session'), false);
			assert.equal(jsonString.includes('cookie'), false);
			assert.equal(jsonString.includes('auth_accounts'), false);
			assert.equal(jsonString.includes('secret'), false);
		}
	);

	// =========================================================================
	// ORGANIZATIONS (Tests 11 - 18)
	// =========================================================================
	await t.test('11. usuario sin memberships -> 200 + organizations []', async () => {
		const res = await callGet(GET, {
			headers: { cookie: sessionC.cookieHeader }
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.user.id, userC.id);
		assert.deepEqual(res.json.organizations, []);
	});

	await t.test('12. membership inactive -> organización excluida', async () => {
		const res = await callGet(GET, {
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		const orgIds = res.json.organizations.map((o) => o.id);
		assert.equal(
			orgIds.includes(orgActiveInactiveMem.id),
			false,
			'Organización con membresía inactiva debe ser excluida'
		);
	});

	await t.test('13. organization suspended -> excluida', async () => {
		const res = await callGet(GET, {
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		const orgIds = res.json.organizations.map((o) => o.id);
		assert.equal(
			orgIds.includes(orgSuspended.id),
			false,
			'Organización suspendida debe ser excluida'
		);
	});

	await t.test('14. organization trial -> excluida', async () => {
		const res = await callGet(GET, {
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		const orgIds = res.json.organizations.map((o) => o.id);
		assert.equal(orgIds.includes(orgTrial.id), false, 'Organización trial debe ser excluida');
	});

	await t.test('15. organization active + membership active -> incluida', async () => {
		const res = await callGet(GET, {
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		const alpha = res.json.organizations.find((o) => o.id === orgAlpha.id);
		assert.ok(alpha, 'Organización activa con membresía activa debe estar incluida');
		assert.equal(alpha.name, orgAlpha.name);
		assert.equal(alpha.slug, orgAlpha.slug);
	});

	await t.test('16. varias organizaciones activas -> todas incluidas', async () => {
		const res = await callGet(GET, {
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		const orgIds = res.json.organizations.map((o) => o.id);
		assert.ok(orgIds.includes(orgAlpha.id));
		assert.ok(orgIds.includes(orgBeta.id));
		assert.ok(orgIds.includes(orgGamma.id));
		assert.equal(res.json.organizations.length, 3);
	});

	await t.test('17. orden: name ASC, id ASC', async () => {
		// User with organizations whose names test deterministic ordering
		const userOrder = await identity(f);
		const sessionOrder = await createSession(f, userOrder.id);

		const id1 = '00000000-0000-0000-0000-000000000001';
		const id2 = '00000000-0000-0000-0000-000000000002';

		const [orgZ] = await db
			.insert(s.organizations)
			.values({ name: 'Zeta Holding', slug: 'zeta-' + randomUUID(), status: 'active' })
			.returning();
		const [orgA1] = await db
			.insert(s.organizations)
			.values({ id: id1, name: 'Apex Corp', slug: 'apex1-' + randomUUID(), status: 'active' })
			.returning();
		const [orgA2] = await db
			.insert(s.organizations)
			.values({ id: id2, name: 'Apex Corp', slug: 'apex2-' + randomUUID(), status: 'active' })
			.returning();

		// Insert memberships in reverse order
		await db.insert(s.memberships).values([
			{ organizationId: orgZ.id, userId: userOrder.id, active: true },
			{ organizationId: orgA2.id, userId: userOrder.id, active: true },
			{ organizationId: orgA1.id, userId: userOrder.id, active: true }
		]);

		const res = await callGet(GET, {
			headers: { cookie: sessionOrder.cookieHeader }
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.organizations.length, 3);

		// First Apex Corp with id1, then Apex Corp with id2, then Zeta Holding
		assert.equal(res.json.organizations[0].id, id1);
		assert.equal(res.json.organizations[0].name, 'Apex Corp');
		assert.equal(res.json.organizations[1].id, id2);
		assert.equal(res.json.organizations[1].name, 'Apex Corp');
		assert.equal(res.json.organizations[2].id, orgZ.id);
		assert.equal(res.json.organizations[2].name, 'Zeta Holding');
	});

	await t.test('18. membership perteneciente a otro usuario -> nunca aparece', async () => {
		const res = await callGet(GET, {
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		const orgIds = res.json.organizations.map((o) => o.id);
		assert.equal(
			orgIds.includes(orgBExclusive.id),
			false,
			'Organización exclusiva de User B jamás debe aparecer en User A'
		);
	});

	// =========================================================================
	// SPOOFING & ISOLATION (Tests 19 - 23)
	// =========================================================================
	await t.test('19. userId malicioso en query -> ignorado', async () => {
		const res = await callGet(GET, {
			url: `http://localhost/api/me?userId=${userB.id}`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		assert.equal(
			res.json.user.id,
			userA.id,
			'Debe devolver el usuario autenticado, no el del query'
		);
	});

	await t.test('20. organizationId malicioso en query -> ignorado', async () => {
		const res = await callGet(GET, {
			url: `http://localhost/api/me?organizationId=${orgBExclusive.id}`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		const orgIds = res.json.organizations.map((o) => o.id);
		assert.equal(orgIds.includes(orgBExclusive.id), false);
		assert.equal(res.json.organizations.length, 3);
	});

	await t.test('21. x-user-id -> ignorado', async () => {
		const res = await callGet(GET, {
			headers: {
				cookie: sessionA.cookieHeader,
				'x-user-id': userB.id
			}
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.user.id, userA.id);
	});

	await t.test('22. x-organization-id -> ignorado', async () => {
		const res = await callGet(GET, {
			headers: {
				cookie: sessionA.cookieHeader,
				'x-organization-id': orgBExclusive.id
			}
		});
		assert.equal(res.status, 200);
		const orgIds = res.json.organizations.map((o) => o.id);
		assert.equal(orgIds.includes(orgBExclusive.id), false);
	});

	await t.test('23. el payload siempre corresponde al principal autenticado', async () => {
		// Petición con cookie de User B
		const resB = await callGet(GET, {
			headers: { cookie: sessionB.cookieHeader }
		});
		assert.equal(resB.status, 200);
		assert.equal(resB.json.user.id, userB.id);
		assert.equal(resB.json.organizations.length, 1);
		assert.equal(resB.json.organizations[0].id, orgBExclusive.id);

		// Petición con cookie de User A
		const resA = await callGet(GET, {
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resA.status, 200);
		assert.equal(resA.json.user.id, userA.id);
		assert.equal(resA.json.organizations.length, 3);
	});

	// =========================================================================
	// INCONSISTENCY (Test 24)
	// =========================================================================
	await t.test(
		'24. inconsistencia interna entre Core y auth profile -> lanza AUTH_PROFILE_INCONSISTENT y no inventa datos',
		async () => {
			// Creamos una identidad Core sin perfil de acceso en auth_users (withProfile = false)
			const userNoProfile = await identity(f, false);

			// El servicio directo rechaza devolver perfil con email inventado
			await assert.rejects(
				getAuthenticatedUserContext(db, userNoProfile.id),
				(err) => err instanceof UserContextServiceError && err.code === 'AUTH_PROFILE_INCONSISTENT'
			);

			// Si el servicio arrojara error durante el endpoint, este responde 500 y nunca 401
			// Nota de arquitectura: La integridad referencial FK (auth_sessions.user_id -> auth_users.id ON DELETE CASCADE)
			// garantiza en base de datos que una sesión válida persistida en Better Auth no puede existir sin su fila en auth_users.
		}
	);
});

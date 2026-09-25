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

const VIEW = 'sites:view';
const MANAGE = 'sites:manage';
const DTO_KEYS = ['active', 'createdAt', 'id', 'name', 'updatedAt'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('SoporteFlow — Etapa 5.4O-B: API HTTP de sedes', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, pg, server } = f;
	const collection = await server.ssrLoadModule('/src/routes/api/sites/+server.ts');
	const item = await server.ssrLoadModule('/src/routes/api/sites/[id]/+server.ts');

	const [orgA, orgB] = await db
		.insert(s.organizations)
		.values([
			{ name: 'Sites API A', slug: randomUUID(), status: 'active' },
			{ name: 'Sites API B', slug: randomUUID(), status: 'active' }
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

	const admin = await actor(orgA, [VIEW, MANAGE]);
	const viewer = await actor(orgA, [VIEW]);
	const manager = await actor(orgA, [MANAGE]);
	const none = await actor(orgA, []);
	const incidentsPower = await actor(orgA, [
		'incidents:view_all',
		'incidents:edit',
		'incidents:assign',
		'organization:manage'
	]);
	const adminB = await actor(orgB, [VIEW, MANAGE]);

	async function call(
		handler,
		method,
		{ id, organizationId = orgA.id, cookie, query = '', body, rawBody, headers: extra } = {}
	) {
		const qs = organizationId === null ? '' : 'organizationId=' + organizationId;
		const path = id === undefined ? '/api/sites' : `/api/sites/${id}`;
		const url = new URL(`http://localhost${path}?${qs}${query}`);
		const headers = new Headers(extra);
		if (cookie) headers.set('cookie', cookie);
		const init = { method, headers };
		if (rawBody !== undefined || body !== undefined) {
			headers.set('content-type', 'application/json');
			init.body = rawBody !== undefined ? rawBody : JSON.stringify(body);
		}
		const params = id === undefined ? {} : { id };
		const response = await handler({ url, params, request: new Request(url, init) });
		const text = await response.text();
		return {
			status: response.status,
			json: text ? JSON.parse(text) : null,
			text,
			headers: response.headers
		};
	}
	const list = (options = {}) => call(collection.GET, 'GET', { cookie: admin.cookie, ...options });
	const create = (options = {}) =>
		call(collection.POST, 'POST', { cookie: admin.cookie, ...options });
	const patch = (options = {}) => call(item.PATCH, 'PATCH', { cookie: admin.cookie, ...options });

	async function rowOf(id) {
		const [row] = await db.select().from(s.sites).where(eq(s.sites.id, id));
		return row;
	}

	// =========================================================================
	// GET
	// =========================================================================
	await t.test('GET 1-2. 401 sin sesión y 403 sin sites:view', async () => {
		for (const cookie of ['', createTamperedCookie()]) {
			const res = await list({ cookie });
			assert.equal(res.status, 401);
			assert.equal(res.json.error.code, 'UNAUTHORIZED');
		}
		// 401 antes que la validación de la query
		assert.equal((await list({ cookie: '', query: '&activeOnly=maybe' })).status, 401);
		for (const who of [none, manager, incidentsPower]) {
			const res = await list({ cookie: who.cookie });
			assert.equal(res.status, 403);
			assert.equal(res.json.error.code, 'FORBIDDEN');
		}
		assert.equal((await list({ cookie: none.cookie, query: '&activeOnly=maybe' })).status, 403);
	});

	await t.test('GET 3. lista vacía', async () => {
		const res = await list({ cookie: viewer.cookie });
		assert.equal(res.status, 200);
		assert.deepEqual(res.json, { sites: [] });
		assert.equal(res.headers.get('cache-control'), 'private, no-store');
	});

	let valencia;
	let madrid;
	await t.test('POST 14-16. crea sede activa con nombre normalizado', async () => {
		const res = await create({ body: { name: '  Valencia   Centro ' } });
		assert.equal(res.status, 201);
		assert.deepEqual(Object.keys(res.json), ['site']);
		valencia = res.json.site;
		assert.deepEqual(Object.keys(valencia).sort(), DTO_KEYS);
		assert.equal(valencia.name, 'Valencia Centro');
		assert.equal(valencia.active, true);
		assert.match(valencia.createdAt, ISO);
		const row = await rowOf(valencia.id);
		assert.equal(row.organizationId, orgA.id);
		assert.equal(row.description, null);
		madrid = (await create({ cookie: manager.cookie, body: { name: 'Madrid' } })).json.site;
		assert.equal(madrid.active, true);
	});

	await t.test('GET 4-9. lista, DTO seguro, inactivas y activeOnly', async () => {
		await db.update(s.sites).set({ description: 'SECRETO-DESC' }).where(eq(s.sites.id, madrid.id));
		await patch({ id: madrid.id, body: { action: 'set_active', active: false } });

		const all = await list({ cookie: viewer.cookie });
		assert.equal(all.status, 200);
		assert.deepEqual(
			all.json.sites.map((site) => [site.name, site.active]),
			[
				['Madrid', false],
				['Valencia Centro', true]
			]
		);
		for (const site of all.json.sites) assert.deepEqual(Object.keys(site).sort(), DTO_KEYS);
		for (const hidden of [orgA.id, 'organizationId', 'description', 'SECRETO-DESC'])
			assert.ok(!all.text.includes(hidden), `no debe exponer ${hidden}`);

		const onlyActive = await list({ cookie: viewer.cookie, query: '&activeOnly=true' });
		assert.deepEqual(
			onlyActive.json.sites.map((site) => site.name),
			['Valencia Centro']
		);
		const explicitAll = await list({ cookie: viewer.cookie, query: '&activeOnly=false' });
		assert.deepEqual(explicitAll.json, all.json);
	});

	await t.test('GET 10. query inválida -> 400', async () => {
		for (const query of [
			'&activeOnly=1',
			'&activeOnly=TRUE',
			'&activeOnly=',
			'&activeOnly=yes',
			'&activeOnly=true&activeOnly=false',
			'&organizationId=' + orgB.id,
			'&includeDescription=true',
			'&x=' + 'a'.repeat(5000)
		]) {
			const res = await list({ query });
			assert.equal(res.status, 400, query);
			assert.equal(res.json.error.code, 'INVALID_INPUT');
		}
		for (const organizationId of [null, 'not-a-uuid'])
			assert.equal((await list({ organizationId })).status, 400);
	});

	await t.test(
		'GET 11-13, 26. aislamiento, membership inactiva y organización no activa',
		async () => {
			const siteB = await create({
				organizationId: orgB.id,
				cookie: adminB.cookie,
				body: { name: 'Valencia Centro' }
			});
			assert.equal(siteB.status, 201, '25. mismo nombre en otro tenant permitido');
			// A no ve B
			const listA = await list();
			assert.ok(!listA.text.includes(siteB.json.site.id));
			// organizationId manipulado hacia B
			for (const [method, run] of [
				['GET', () => list({ organizationId: orgB.id })],
				['POST', () => create({ organizationId: orgB.id, body: { name: 'Intrusa' } })],
				[
					'PATCH',
					() =>
						patch({
							id: siteB.json.site.id,
							organizationId: orgB.id,
							body: { action: 'rename', name: 'X' }
						})
				]
			]) {
				const res = await run();
				assert.equal(res.status, 403, method);
				assert.ok(!res.text.includes('Valencia'));
			}
			assert.equal((await rowOf(siteB.json.site.id)).name, 'Valencia Centro');
			assert.equal(
				(await db.select().from(s.sites).where(eq(s.sites.organizationId, orgB.id))).length,
				1
			);

			const inactiveMember = await actor(orgA, [VIEW, MANAGE]);
			await db
				.update(s.memberships)
				.set({ active: false })
				.where(eq(s.memberships.id, inactiveMember.membership.id));
			assert.equal((await list({ cookie: inactiveMember.cookie })).status, 403);
			assert.equal(
				(await create({ cookie: inactiveMember.cookie, body: { name: 'No' } })).status,
				403
			);

			const inactiveUser = await actor(orgA, [VIEW, MANAGE]);
			await db.update(s.users).set({ active: false }).where(eq(s.users.id, inactiveUser.user.id));
			assert.equal((await list({ cookie: inactiveUser.cookie })).status, 401);

			for (const status of ['suspended', 'trial']) {
				const [org] = await db
					.insert(s.organizations)
					.values({ name: status, slug: randomUUID(), status: 'active' })
					.returning();
				const member = await actor(org, [VIEW, MANAGE]);
				const [site] = await db
					.insert(s.sites)
					.values({ organizationId: org.id, name: 'Legacy' })
					.returning();
				await db.update(s.organizations).set({ status }).where(eq(s.organizations.id, org.id));
				assert.equal(
					(await list({ organizationId: org.id, cookie: member.cookie })).status,
					403,
					status
				);
				assert.equal(
					(await create({ organizationId: org.id, cookie: member.cookie, body: { name: 'Nueva' } }))
						.status,
					403
				);
				assert.equal(
					(
						await patch({
							id: site.id,
							organizationId: org.id,
							cookie: member.cookie,
							body: { action: 'set_active', active: false }
						})
					).status,
					403
				);
				assert.equal((await rowOf(site.id)).active, true);
			}
		}
	);

	// =========================================================================
	// POST
	// =========================================================================
	await t.test('POST 17-19. body inválido, name vacío y campos extra -> 400', async () => {
		const before = (await db.select().from(s.sites).where(eq(s.sites.organizationId, orgA.id)))
			.length;
		const cases = [
			{ rawBody: '{bad' },
			{ rawBody: '' },
			{ body: 'Valencia' },
			{ body: ['Valencia'] },
			{ body: null },
			{ body: {} },
			{ body: { name: '' } },
			{ body: { name: '   ' } },
			{ body: { name: 'x' } },
			{ body: { name: 'x'.repeat(256) } },
			{ body: { name: 42 } },
			{ body: { name: 'Ok', organizationId: orgB.id } },
			{ body: { name: 'Ok', active: false } },
			{ body: { name: 'Ok', description: 'd' } },
			{ body: { name: 'Ok', actorUserId: none.user.id } },
			{ body: { name: 'Ok', userId: none.user.id } },
			{ body: { name: 'Ok', createdAt: '2000-01-01' } },
			{ body: { name: 'Ok', id: randomUUID() } },
			{ rawBody: '{"name":"Ok","__proto__":{"active":false}}' },
			{ body: { name: 'Ok' }, query: '&name=Otra' }
		];
		for (const options of cases) {
			const res = await create(options);
			assert.equal(res.status, 400, JSON.stringify(options).slice(0, 80));
			assert.equal(res.json.error.code, 'INVALID_INPUT');
		}
		const after = (await db.select().from(s.sites).where(eq(s.sites.organizationId, orgA.id)))
			.length;
		assert.equal(after, before);
	});

	await t.test('POST 20-21, 41, 43. sin sites:manage -> 403 (antes del body)', async () => {
		for (const who of [none, viewer, incidentsPower]) {
			const res = await create({ cookie: who.cookie, rawBody: '{bad' });
			assert.equal(res.status, 403);
			assert.equal((await create({ cookie: who.cookie, body: { name: 'Prohibida' } })).status, 403);
		}
		assert.equal((await create({ cookie: '', body: { name: 'Anónima' } })).status, 401);
	});

	await t.test('POST 22-24, 27, 44. duplicados -> 409 sin fuga SQL', async () => {
		for (const name of [
			'Valencia Centro',
			'valencia centro',
			'VALENCIA  CENTRO',
			'  valencia\tcentro ',
			'madrid'
		]) {
			const res = await create({ body: { name } });
			assert.equal(res.status, 409, name);
			assert.deepEqual(res.json, {
				error: {
					code: 'SITE_NAME_DUPLICATE',
					message: 'A site with this name already exists in the organization.'
				}
			});
			for (const leak of ['23505', 'sites_org', 'constraint', 'duplicate key', 'SELECT', 'INSERT'])
				assert.ok(!res.text.includes(leak), leak);
		}
	});

	await t.test('Concurrencia (§13). dos creaciones simultáneas: una 201 y otra 409', async () => {
		const results = await Promise.all([
			create({ body: { name: 'Lisboa' } }),
			create({ body: { name: ' LISBOA ' } })
		]);
		assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
	});

	// =========================================================================
	// PATCH
	// =========================================================================
	await t.test('PATCH 28-30. renombra, desactiva y reactiva', async () => {
		const res = await patch({
			id: valencia.id,
			body: { action: 'rename', name: '  Valencia   Puerto ' }
		});
		assert.equal(res.status, 200);
		assert.deepEqual(Object.keys(res.json), ['site']);
		assert.deepEqual(Object.keys(res.json.site).sort(), DTO_KEYS);
		assert.equal(res.json.site.name, 'Valencia Puerto');
		assert.equal(res.json.site.active, true);

		const off = await patch({
			id: valencia.id,
			cookie: manager.cookie,
			body: { action: 'set_active', active: false }
		});
		assert.equal(off.status, 200);
		assert.equal(off.json.site.active, false);
		assert.equal(off.json.site.name, 'Valencia Puerto');
		assert.ok(await rowOf(valencia.id), 'desactivar no borra');

		const on = await patch({ id: valencia.id, body: { action: 'set_active', active: true } });
		assert.equal(on.json.site.active, true);
	});

	await t.test('PATCH 31-32, 48. inexistente y cross-tenant -> mismo 404', async () => {
		const [siteB] = await db.select().from(s.sites).where(eq(s.sites.organizationId, orgB.id));
		const bodies = [
			{ action: 'rename', name: 'Tomada' },
			{ action: 'set_active', active: false }
		];
		for (const body of bodies) {
			const foreign = await patch({ id: siteB.id, body });
			const missing = await patch({ id: randomUUID(), body });
			assert.equal(foreign.status, 404);
			assert.deepEqual(foreign.json, {
				error: { code: 'SITE_NOT_FOUND', message: 'Site not found.' }
			});
			assert.deepEqual(foreign.json, missing.json);
			for (const leak of [siteB.id, orgB.id, 'Valencia', 'active'])
				assert.ok(!foreign.text.includes(leak), leak);
		}
		const row = await rowOf(siteB.id);
		assert.equal(row.name, 'Valencia Centro');
		assert.equal(row.active, true);
	});

	await t.test('PATCH 33. renombrar a duplicado -> 409', async () => {
		const res = await patch({ id: valencia.id, body: { action: 'rename', name: 'MADRID' } });
		assert.equal(res.status, 409);
		assert.equal(res.json.error.code, 'SITE_NAME_DUPLICATE');
		assert.equal((await rowOf(valencia.id)).name, 'Valencia Puerto');
	});

	await t.test('PATCH 34-35, 38-39. body y UUID inválidos -> 400', async () => {
		const cases = [
			{ rawBody: '{bad' },
			{ body: [] },
			{ body: {} },
			{ body: { name: 'Solo nombre' } },
			{ body: { active: false } },
			{ body: { name: 'Mix', active: false } },
			{ body: { action: 'rename' } },
			{ body: { action: 'rename', name: 5 } },
			{ body: { action: 'rename', name: ' ' } },
			{ body: { action: 'rename', name: 'Ok', active: false } },
			{ body: { action: 'set_active' } },
			{ body: { action: 'set_active', active: 'false' } },
			{ body: { action: 'set_active', active: 0 } },
			{ body: { action: 'set_active', active: false, name: 'x' } },
			{ body: { action: 'delete' } },
			{ body: { action: 'RENAME', name: 'Ok' } },
			{ body: { action: 'rename', name: 'Ok', description: 'd' } },
			{ body: { action: 'rename', name: 'Ok', organizationId: orgB.id } },
			{ body: { action: 'set_active', active: true, updatedAt: '2000-01-01' } },
			{ body: { action: 'rename', name: 'Ok' }, query: '&action=set_active' }
		];
		for (const options of cases) {
			const res = await patch({ id: valencia.id, ...options });
			assert.equal(res.status, 400, JSON.stringify(options).slice(0, 80));
			assert.equal(res.json.error.code, 'INVALID_INPUT');
		}
		for (const id of ['not-a-uuid', '1', "' OR 1=1"]) {
			const res = await patch({ id, body: { action: 'rename', name: 'Ok' } });
			assert.equal(res.status, 400);
		}
		const row = await rowOf(valencia.id);
		assert.equal(row.name, 'Valencia Puerto');
		assert.equal(row.active, true);
		assert.equal(row.description, null);
		assert.equal(row.organizationId, orgA.id);
	});

	await t.test('PATCH 36-37, 41, 43. sin permiso o sin sesión', async () => {
		const body = { action: 'set_active', active: false };
		for (const who of [none, viewer, incidentsPower]) {
			const res = await patch({ id: valencia.id, cookie: who.cookie, body });
			assert.equal(res.status, 403);
			// 403 antes de validar el body: no se filtra existencia ni validación
			assert.equal(
				(await patch({ id: randomUUID(), cookie: who.cookie, rawBody: '{bad' })).status,
				403
			);
		}
		assert.equal((await patch({ id: valencia.id, cookie: '', body })).status, 401);
		assert.equal((await rowOf(valencia.id)).active, true);
	});

	await t.test('40, 42. sin DELETE/PUT; sites:manage no implica sites:view', async () => {
		assert.deepEqual(Object.keys(collection).sort(), ['GET', 'POST']);
		assert.deepEqual(Object.keys(item).sort(), ['PATCH']);
		assert.equal((await list({ cookie: manager.cookie })).status, 403);
		assert.equal(
			(await create({ cookie: manager.cookie, body: { name: 'Gestor escribe' } })).status,
			201
		);
	});

	// =========================================================================
	// Seguridad
	// =========================================================================
	await t.test('45-47. cabeceras de identidad ignoradas; tenant solo por query', async () => {
		const spoof = {
			'x-user-id': admin.user.id,
			'x-organization-id': orgA.id,
			'x-actor-user-id': admin.user.id,
			authorization: 'Bearer ' + admin.user.id
		};
		assert.equal((await list({ cookie: '', headers: spoof })).status, 401);
		assert.equal(
			(await create({ cookie: none.cookie, headers: spoof, body: { name: 'Spoof' } })).status,
			403
		);
		// cabeceras hacia B con sesión de A: sigue operando sobre A
		const res = await create({
			headers: { 'x-organization-id': orgB.id },
			body: { name: 'Solo en A' }
		});
		assert.equal(res.status, 201);
		assert.equal((await rowOf(res.json.site.id)).organizationId, orgA.id);
	});

	await t.test('44. error inesperado -> 500 genérico sin detalles', async () => {
		await pg.exec(`
			CREATE FUNCTION test_boom_site() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'SECRET-SITE-DETAIL /srv/sites.sql'; END $$;
			CREATE TRIGGER test_boom_site BEFORE INSERT OR UPDATE ON sites
			FOR EACH ROW EXECUTE FUNCTION test_boom_site();`);
		try {
			for (const res of [
				await create({ body: { name: 'Explota' } }),
				await patch({ id: valencia.id, body: { action: 'rename', name: 'Explota' } })
			]) {
				assert.equal(res.status, 500);
				assert.deepEqual(res.json, {
					error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' }
				});
				assert.ok(!res.text.includes('SECRET'));
				assert.ok(!res.text.includes('/srv/'));
			}
		} finally {
			await pg.exec('DROP TRIGGER test_boom_site ON sites; DROP FUNCTION test_boom_site();');
		}
		assert.equal((await rowOf(valencia.id)).name, 'Valencia Puerto');
	});
});

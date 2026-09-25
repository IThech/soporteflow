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

const VIEW = 'categories:view';
const MANAGE = 'categories:manage';
const DTO_KEYS = ['active', 'createdAt', 'description', 'id', 'name', 'updatedAt'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('SoporteFlow — Etapa 5.4P-B: API HTTP de categorías', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, pg, server } = f;
	const collection = await server.ssrLoadModule('/src/routes/api/categories/+server.ts');
	const member = await server.ssrLoadModule('/src/routes/api/categories/[id]/+server.ts');

	const [orgA, orgB] = await db
		.insert(s.organizations)
		.values([
			{ name: 'Categories API A', slug: randomUUID(), status: 'active' },
			{ name: 'Categories API B', slug: randomUUID(), status: 'active' }
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
	const otherPowers = await actor(orgA, [
		'organization:manage',
		'sites:manage',
		'sites:view',
		'incidents:edit',
		'incidents:view_all'
	]);
	const adminB = await actor(orgB, [VIEW, MANAGE]);

	async function call(
		handler,
		method,
		{ id, organizationId = orgA.id, cookie, query = '', body, rawBody, headers: extra } = {}
	) {
		const qs = organizationId === null ? '' : 'organizationId=' + organizationId;
		const path = id === undefined ? '/api/categories' : `/api/categories/${id}`;
		const url = new URL(`http://localhost${path}?${qs}${query}`);
		const headers = new Headers(extra);
		if (cookie) headers.set('cookie', cookie);
		const init = { method, headers };
		if (rawBody !== undefined || body !== undefined) {
			headers.set('content-type', 'application/json');
			init.body = rawBody !== undefined ? rawBody : JSON.stringify(body);
		}
		const response = await handler({
			url,
			params: id === undefined ? {} : { id },
			request: new Request(url, init)
		});
		const text = await response.text();
		return {
			status: response.status,
			json: text ? JSON.parse(text) : null,
			text,
			headers: response.headers
		};
	}
	const list = (o = {}) => call(collection.GET, 'GET', { cookie: admin.cookie, ...o });
	const create = (o = {}) => call(collection.POST, 'POST', { cookie: admin.cookie, ...o });
	const patch = (o = {}) => call(member.PATCH, 'PATCH', { cookie: admin.cookie, ...o });
	async function rowOf(id) {
		const [row] = await db.select().from(s.categories).where(eq(s.categories.id, id));
		return row;
	}
	async function countA() {
		return (await db.select().from(s.categories).where(eq(s.categories.organizationId, orgA.id)))
			.length;
	}

	// =========================================================================
	// GET
	// =========================================================================
	await t.test(
		'GET 1-3, 19. 401 sin sesión o cookie manipulada; 403 sin categories:view',
		async () => {
			for (const cookie of ['', createTamperedCookie()]) {
				const res = await list({ cookie });
				assert.equal(res.status, 401);
				assert.equal(res.json.error.code, 'UNAUTHORIZED');
			}
			assert.equal((await list({ cookie: '', query: '&activeOnly=maybe' })).status, 401);
			for (const who of [none, manager, otherPowers]) {
				const res = await list({ cookie: who.cookie });
				assert.equal(res.status, 403);
				assert.equal(res.json.error.code, 'FORBIDDEN');
				// 403 antes de validar la query: no se filtran detalles de validación
				assert.equal((await list({ cookie: who.cookie, query: '&activeOnly=maybe' })).status, 403);
			}
		}
	);

	await t.test('GET 4. lista vacía con cabeceras no-store', async () => {
		const res = await list({ cookie: viewer.cookie });
		assert.equal(res.status, 200);
		assert.deepEqual(res.json, { categories: [] });
		assert.equal(res.headers.get('cache-control'), 'private, no-store');
	});

	let hardware;
	let software;
	await t.test('POST 20-25. crear válidas, description y nombre canónico', async () => {
		const res = await create({
			body: { name: '  Hardware   de  puesto ', description: '  PCs y periféricos ' }
		});
		assert.equal(res.status, 201);
		assert.deepEqual(Object.keys(res.json), ['category']);
		hardware = res.json.category;
		assert.deepEqual(Object.keys(hardware).sort(), DTO_KEYS);
		assert.equal(hardware.name, 'Hardware de puesto');
		assert.equal(hardware.description, 'PCs y periféricos');
		assert.equal(hardware.active, true);
		assert.match(hardware.createdAt, ISO);
		assert.match(hardware.updatedAt, ISO);
		software = (await create({ cookie: manager.cookie, body: { name: 'Software' } })).json.category;
		assert.equal(software.description, null, '21. omitida -> null');
		const nulled = await create({ body: { name: 'Redes', description: null } });
		assert.equal(nulled.json.category.description, null, '22. null');
		const blank = await create({ body: { name: 'Correo', description: '   ' } });
		assert.equal(blank.json.category.description, null, '23. whitespace -> null');
		assert.equal((await rowOf(hardware.id)).organizationId, orgA.id);
	});

	await t.test('GET 5-11. lista, DTO seguro, inactivas y activeOnly', async () => {
		await patch({ id: software.id, body: { action: 'set_active', active: false } });
		const all = await list({ cookie: viewer.cookie });
		assert.equal(all.status, 200);
		assert.deepEqual(
			all.json.categories.map((c) => [c.name, c.active]),
			[
				['Correo', true],
				['Hardware de puesto', true],
				['Redes', true],
				['Software', false]
			]
		);
		for (const category of all.json.categories)
			assert.deepEqual(Object.keys(category).sort(), DTO_KEYS);
		for (const hidden of [
			orgA.id,
			'organizationId',
			'defaultTeamId',
			'defaultSupportLevel',
			'subcategor',
			'classification',
			'routing',
			'color',
			'icon'
		])
			assert.ok(!all.text.includes(hidden), hidden);
		const active = await list({ cookie: viewer.cookie, query: '&activeOnly=true' });
		assert.ok(active.json.categories.every((c) => c.active));
		assert.ok(!active.json.categories.some((c) => c.id === software.id));
		assert.deepEqual(
			(await list({ cookie: viewer.cookie, query: '&activeOnly=false' })).json,
			all.json
		);
	});

	await t.test('GET 12-15. query inválida -> 400', async () => {
		for (const query of [
			'&activeOnly=1',
			'&activeOnly=TRUE',
			'&activeOnly=',
			'&activeOnly=yes',
			'&includeInactive=true',
			'&activeOnly=true&activeOnly=false',
			'&organizationId=' + orgB.id
		]) {
			const res = await list({ query });
			assert.equal(res.status, 400, query);
			assert.equal(res.json.error.code, 'INVALID_INPUT');
		}
		for (const organizationId of [null, 'not-a-uuid', "' OR 1=1"])
			assert.equal((await list({ organizationId })).status, 400);
	});

	await t.test(
		'GET 16-18, 40. aislamiento, membership inactiva y organización no operativa',
		async () => {
			const createdB = await create({
				organizationId: orgB.id,
				cookie: adminB.cookie,
				body: { name: 'Hardware de puesto' }
			});
			assert.equal(createdB.status, 201, '40. mismo nombre en otro tenant');
			assert.ok(!(await list()).text.includes(createdB.json.category.id));
			// organizationId manipulado hacia B
			assert.equal((await list({ organizationId: orgB.id })).status, 403);
			assert.equal(
				(await create({ organizationId: orgB.id, body: { name: 'Intrusa' } })).status,
				403
			);

			const inactiveMember = await actor(orgA, [VIEW, MANAGE]);
			await db
				.update(s.memberships)
				.set({ active: false })
				.where(eq(s.memberships.id, inactiveMember.membership.id));
			assert.equal((await list({ cookie: inactiveMember.cookie })).status, 403);
			const inactiveUser = await actor(orgA, [VIEW, MANAGE]);
			await db.update(s.users).set({ active: false }).where(eq(s.users.id, inactiveUser.user.id));
			assert.equal((await list({ cookie: inactiveUser.cookie })).status, 401);

			for (const status of ['suspended', 'trial']) {
				const [org] = await db
					.insert(s.organizations)
					.values({ name: status, slug: randomUUID(), status: 'active' })
					.returning();
				const who = await actor(org, [VIEW, MANAGE]);
				const [legacy] = await db
					.insert(s.categories)
					.values({ organizationId: org.id, name: 'Legacy' })
					.returning();
				await db.update(s.organizations).set({ status }).where(eq(s.organizations.id, org.id));
				assert.equal(
					(await list({ organizationId: org.id, cookie: who.cookie })).status,
					403,
					status
				);
				assert.equal(
					(await create({ organizationId: org.id, cookie: who.cookie, body: { name: 'Nueva' } }))
						.status,
					403
				);
				assert.equal(
					(
						await patch({
							id: legacy.id,
							organizationId: org.id,
							cookie: who.cookie,
							body: { action: 'set_active', active: false }
						})
					).status,
					403
				);
				assert.equal((await rowOf(legacy.id)).active, true);
			}
		}
	);

	// =========================================================================
	// POST
	// =========================================================================
	await t.test('POST 26-33. body inválido, campos extra y mass assignment -> 400', async () => {
		const before = await countA();
		const cases = [
			{ rawBody: '{bad' },
			{ rawBody: '' },
			{ body: 'Hardware' },
			{ body: ['Hardware'] },
			{ body: null },
			{ body: {} },
			{ body: { name: '' } },
			{ body: { name: '   ' } },
			{ body: { name: 'x' } },
			{ body: { name: 'x'.repeat(101) } },
			{ body: { name: 42 } },
			{ body: { name: 'a\u0000b' } },
			{ body: { name: 'Ok', description: 'a\u0000b' } },
			{ body: { name: 'Ok', description: 'd'.repeat(1001) } },
			{ body: { name: 'Ok', description: 42 } },
			{ body: { name: 'Ok', description: ['x'] } },
			...[
				'organizationId',
				'active',
				'id',
				'createdAt',
				'updatedAt',
				'defaultTeamId',
				'defaultSupportLevel',
				'color',
				'icon',
				'parentId',
				'subcategory',
				'priority',
				'routing'
			].map((key) => ({ body: { name: 'Ok ' + key, [key]: key === 'active' ? false : 'x' } })),
			{ rawBody: '{"name":"Ok","__proto__":{"active":false}}' },
			{ body: { name: 'Ok' }, query: '&name=Otra' }
		];
		for (const options of cases) {
			const res = await create(options);
			assert.equal(res.status, 400, JSON.stringify(options).slice(0, 80));
			assert.equal(res.json.error.code, 'INVALID_INPUT');
		}
		assert.equal(await countA(), before);
	});

	await t.test('POST 34-35, 61, 63. sin categories:manage -> 403 antes del body', async () => {
		for (const who of [none, viewer, otherPowers]) {
			assert.equal((await create({ cookie: who.cookie, rawBody: '{bad' })).status, 403);
			assert.equal((await create({ cookie: who.cookie, body: { name: 'Prohibida' } })).status, 403);
		}
		assert.equal((await create({ cookie: '', body: { name: 'Anónima' } })).status, 401);
	});

	await t.test(
		'POST 36-39, 41. duplicados -> 409 sin fuga SQL (también frente a inactiva)',
		async () => {
			for (const name of [
				'Hardware de puesto',
				'hardware de puesto',
				' Hardware de puesto ',
				'Hardware de puesto   ',
				'HARDWARE  DE PUESTO',
				'software'
			]) {
				const res = await create({ body: { name } });
				assert.equal(res.status, 409, name);
				assert.deepEqual(res.json, {
					error: {
						code: 'CATEGORY_NAME_DUPLICATE',
						message: 'A category with this name already exists in the organization.'
					}
				});
				for (const leak of [
					'23505',
					'categories_org',
					'constraint',
					'duplicate key',
					'INSERT',
					'SELECT'
				])
					assert.ok(!res.text.includes(leak), leak);
			}
		}
	);

	await t.test('Concurrencia: dos POST simultáneos -> 201 y 409', async () => {
		const results = await Promise.all([
			create({ body: { name: 'Impresoras' } }),
			create({ body: { name: ' IMPRESORAS ' } })
		]);
		assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
	});

	// =========================================================================
	// PATCH
	// =========================================================================
	await t.test('PATCH 42-47. update name/description, limpiar y set_active', async () => {
		const byName = await patch({
			id: hardware.id,
			body: { action: 'update', name: '  Hardware   y periféricos ' }
		});
		assert.equal(byName.status, 200);
		assert.deepEqual(Object.keys(byName.json), ['category']);
		assert.equal(byName.json.category.name, 'Hardware y periféricos');
		assert.equal(
			byName.json.category.description,
			'PCs y periféricos',
			'description omitida se conserva'
		);
		const byDesc = await patch({
			id: hardware.id,
			body: { action: 'update', description: ' Nueva ' }
		});
		assert.equal(byDesc.json.category.description, 'Nueva');
		const cleared = await patch({ id: hardware.id, body: { action: 'update', description: null } });
		assert.equal(cleared.json.category.description, null);
		const both = await patch({
			id: hardware.id,
			cookie: manager.cookie,
			body: { action: 'update', name: 'Hardware', description: 'Equipos' }
		});
		assert.equal(both.json.category.name, 'Hardware');
		assert.equal(both.json.category.description, 'Equipos');
		const off = await patch({ id: hardware.id, body: { action: 'set_active', active: false } });
		assert.equal(off.json.category.active, false);
		assert.ok(await rowOf(hardware.id), 'desactivar no borra');
		const on = await patch({ id: hardware.id, body: { action: 'set_active', active: true } });
		assert.equal(on.json.category.active, true);
		for (const key of DTO_KEYS) assert.ok(key in on.json.category);
	});

	await t.test('PATCH 48-55, 64-65. body, acción y UUID inválidos -> 400 sin cambios', async () => {
		const before = await rowOf(hardware.id);
		const cases = [
			{ rawBody: '{bad' },
			{ body: [] },
			{ body: {} },
			{ body: { name: 'Sin acción' } },
			{ body: { action: 'delete' } },
			{ body: { action: 'UPDATE', name: 'x y' } },
			{ body: { action: 'update' } },
			{ body: { action: 'update', name: 5 } },
			{ body: { action: 'update', name: ' ' } },
			{ body: { action: 'update', description: 5 } },
			{ body: { action: 'set_active' } },
			{ body: { action: 'set_active', active: 'false' } },
			{ body: { action: 'set_active', active: 0 } },
			{ body: { action: 'update', name: 'Mix', active: false } },
			{ body: { action: 'set_active', active: false, name: 'Mix' } },
			{ body: { action: 'set_active', active: false, description: null } },
			{ body: { action: 'update', name: 'Ok', color: 'red' } },
			{ body: { action: 'update', name: 'Ok', organizationId: orgB.id } },
			{ body: { action: 'update', name: 'Ok', id: randomUUID() } },
			{ body: { action: 'update', name: 'Ok', createdAt: '2000-01-01T00:00:00.000Z' } },
			{ body: { action: 'set_active', active: true, updatedAt: '2000-01-01T00:00:00.000Z' } },
			{ body: { action: 'update', name: 'Ok' }, query: '&action=set_active' }
		];
		for (const options of cases) {
			const res = await patch({ id: hardware.id, ...options });
			assert.equal(res.status, 400, JSON.stringify(options).slice(0, 80));
			assert.equal(res.json.error.code, 'INVALID_INPUT');
		}
		for (const id of ['not-a-uuid', '1', "' OR 1=1"])
			assert.equal((await patch({ id, body: { action: 'update', name: 'Ok' } })).status, 400);
		assert.deepEqual(await rowOf(hardware.id), before);
	});

	await t.test(
		'PATCH 56-58, 71. inexistente y cross-tenant -> mismo 404; duplicado -> 409',
		async () => {
			const [categoryB] = await db
				.select()
				.from(s.categories)
				.where(eq(s.categories.organizationId, orgB.id));
			for (const body of [
				{ action: 'update', name: 'Tomada' },
				{ action: 'update', description: 'x' },
				{ action: 'set_active', active: false }
			]) {
				const foreign = await patch({ id: categoryB.id, body });
				const missing = await patch({ id: randomUUID(), body });
				assert.equal(foreign.status, 404);
				assert.deepEqual(foreign.json, {
					error: { code: 'CATEGORY_NOT_FOUND', message: 'Category not found.' }
				});
				assert.deepEqual(foreign.json, missing.json);
				for (const leak of [categoryB.id, orgB.id, 'Hardware de puesto', 'active'])
					assert.ok(!foreign.text.includes(leak), leak);
			}
			const row = await rowOf(categoryB.id);
			assert.equal(row.name, 'Hardware de puesto');
			assert.equal(row.active, true);
			const dup = await patch({ id: hardware.id, body: { action: 'update', name: 'SOFTWARE' } });
			assert.equal(dup.status, 409);
			assert.equal(dup.json.error.code, 'CATEGORY_NAME_DUPLICATE');
		}
	);

	await t.test(
		'PATCH 59-63. permisos: sin manage, sin sesión, view no sustituye manage',
		async () => {
			const body = { action: 'set_active', active: false };
			for (const who of [none, viewer, otherPowers]) {
				assert.equal((await patch({ id: hardware.id, cookie: who.cookie, body })).status, 403);
				assert.equal(
					(await patch({ id: randomUUID(), cookie: who.cookie, rawBody: '{bad' })).status,
					403
				);
			}
			assert.equal((await patch({ id: hardware.id, cookie: '', body })).status, 401);
			assert.equal((await rowOf(hardware.id)).active, true);
			// 62. manage no implica view
			assert.equal((await list({ cookie: manager.cookie })).status, 403);
			assert.equal(
				(
					await patch({
						id: hardware.id,
						cookie: manager.cookie,
						body: { action: 'update', description: 'Gestor' }
					})
				).status,
				200
			);
		}
	);

	await t.test(
		'66-67. contrato de métodos: GET/POST colección, PATCH miembro; sin DELETE ni PUT',
		async () => {
			assert.deepEqual(Object.keys(collection).sort(), ['GET', 'POST']);
			assert.deepEqual(Object.keys(member).sort(), ['PATCH']);
			// SvelteKit responde 405 Method Not Allowed a los métodos no exportados
		}
	);

	// =========================================================================
	// Seguridad
	// =========================================================================
	await t.test(
		'68-69, 72. cabeceras de identidad/tenant ignoradas; tenant solo por query',
		async () => {
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
			const res = await create({
				headers: { 'x-organization-id': orgB.id },
				body: { name: 'Solo en A' }
			});
			assert.equal(res.status, 201);
			assert.equal((await rowOf(res.json.category.id)).organizationId, orgA.id);
		}
	);

	await t.test('70, 73. error inesperado -> 500 genérico sin detalles ni datos', async () => {
		await pg.exec(`
			CREATE FUNCTION test_boom_category() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'SECRET-CATEGORY-DETAIL /srv/categories.sql'; END $$;
			CREATE TRIGGER test_boom_category BEFORE INSERT OR UPDATE ON categories
			FOR EACH ROW EXECUTE FUNCTION test_boom_category();`);
		try {
			for (const res of [
				await create({ body: { name: 'Explota' } }),
				await patch({ id: hardware.id, body: { action: 'update', name: 'Explota' } })
			]) {
				assert.equal(res.status, 500);
				assert.deepEqual(res.json, {
					error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' }
				});
				for (const leak of ['SECRET', '/srv/', 'Explota', 'categories'])
					assert.ok(!res.text.includes(leak), leak);
			}
		} finally {
			await pg.exec(
				'DROP TRIGGER test_boom_category ON categories; DROP FUNCTION test_boom_category();'
			);
		}
		assert.equal((await rowOf(hardware.id)).name, 'Hardware');
	});
});

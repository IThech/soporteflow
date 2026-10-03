import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
	listSubcategories,
	createSubcategory,
	updateSubcategory,
	setSubcategoryActive,
	getCategoryTree,
	SubcategoryApiError
} from '../src/lib/api/subcategories.ts';
import { createCategory } from '../src/lib/api/categories.ts';
import {
	fixture,
	createCredentialUser,
	createSession,
	grantPermission
} from './helpers/auth-fixture.mjs';

const ORG = randomUUID();
const CAT = randomUUID();
const SUB = randomUUID();

function subcategory(overrides = {}) {
	return {
		id: randomUUID(),
		categoryId: CAT,
		name: 'Portátiles',
		description: null,
		active: true,
		createdAt: '2026-05-01T10:20:30.123Z',
		updatedAt: '2026-05-02T10:20:30.123Z',
		...overrides
	};
}

test('SoporteFlow — Subcategories API Client Unit & E2E', async (t) => {
	await t.test(
		'Client input validation rejects invalid UUIDs / names before calling fetch',
		async () => {
			let called = false;
			const customFetch = async () => {
				called = true;
				return new Response();
			};

			await assert.rejects(
				() => listSubcategories({ organizationId: 'not-a-uuid', customFetch }),
				(err) => err instanceof SubcategoryApiError && err.code === 'INVALID_INPUT'
			);
			await assert.rejects(
				() =>
					createSubcategory({ organizationId: ORG, categoryId: 'bad', name: 'Valid', customFetch }),
				(err) => err instanceof SubcategoryApiError && err.code === 'INVALID_INPUT'
			);
			await assert.rejects(
				() => createSubcategory({ organizationId: ORG, categoryId: CAT, name: '  ', customFetch }),
				(err) => err instanceof SubcategoryApiError && err.code === 'INVALID_INPUT'
			);
			await assert.rejects(
				() => updateSubcategory({ organizationId: ORG, subcategoryId: SUB, customFetch }),
				(err) => err instanceof SubcategoryApiError && err.code === 'INVALID_INPUT'
			);
			assert.equal(called, false);
		}
	);

	await t.test('listSubcategories: parses response properly', async () => {
		const s1 = subcategory({ name: 'Sub 1' });
		const s2 = subcategory({ name: 'Sub 2' });
		const customFetch = async (url) => {
			const u = new URL(url, 'http://localhost');
			assert.equal(u.searchParams.get('organizationId'), ORG);
			assert.equal(u.searchParams.get('activeOnly'), 'true');
			return new Response(JSON.stringify({ subcategories: [s1, s2] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		};

		const list = await listSubcategories({ organizationId: ORG, activeOnly: true, customFetch });
		assert.equal(list.length, 2);
		assert.equal(list[0].name, 'Sub 1');
		assert.equal(list[1].name, 'Sub 2');
	});

	await t.test('createSubcategory: sends body and parses response', async () => {
		const expected = subcategory({ name: 'Impresoras', description: 'Láser e inyección' });
		const customFetch = async (url, init) => {
			assert.equal(init.method, 'POST');
			const body = JSON.parse(init.body);
			assert.equal(body.categoryId, CAT);
			assert.equal(body.name, 'Impresoras');
			assert.equal(body.description, 'Láser e inyección');
			return new Response(JSON.stringify({ subcategory: expected }), {
				status: 201,
				headers: { 'content-type': 'application/json' }
			});
		};

		const created = await createSubcategory({
			organizationId: ORG,
			categoryId: CAT,
			name: 'Impresoras',
			description: 'Láser e inyección',
			customFetch
		});
		assert.equal(created.id, expected.id);
		assert.equal(created.name, 'Impresoras');
	});

	await t.test('updateSubcategory and setSubcategoryActive: calls PATCH', async () => {
		const expected = subcategory({ name: 'Impresoras 3D' });
		const customFetch = async (url, init) => {
			assert.equal(init.method, 'PATCH');
			const body = JSON.parse(init.body);
			assert.equal(body.action, 'update');
			assert.equal(body.name, 'Impresoras 3D');
			return new Response(JSON.stringify({ subcategory: expected }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		};

		const updated = await updateSubcategory({
			organizationId: ORG,
			subcategoryId: SUB,
			name: 'Impresoras 3D',
			customFetch
		});
		assert.equal(updated.name, 'Impresoras 3D');
	});

	await t.test('getCategoryTree: parses tree response', async () => {
		const treeNode = {
			id: CAT,
			name: 'Hardware',
			description: null,
			active: true,
			createdAt: '2026-05-01T10:20:30.123Z',
			updatedAt: '2026-05-02T10:20:30.123Z',
			subcategories: [subcategory({ name: 'Monitores' })]
		};
		const customFetch = async (url) => {
			const u = new URL(url, 'http://localhost');
			assert.equal(u.searchParams.get('organizationId'), ORG);
			assert.equal(u.searchParams.get('tree'), 'true');
			return new Response(JSON.stringify({ categories: [treeNode] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		};

		const tree = await getCategoryTree({ organizationId: ORG, customFetch });
		assert.equal(tree.length, 1);
		assert.equal(tree[0].name, 'Hardware');
		assert.equal(tree[0].subcategories.length, 1);
		assert.equal(tree[0].subcategories[0].name, 'Monitores');
	});

	// E2E test against real endpoints
	await t.test('E2E: subcategories and tree against real SSR handlers', async (st) => {
		const f = await fixture(st);
		const { db, schema: s, server } = f;

		const [org] = await db
			.insert(s.organizations)
			.values({ name: 'Subcategories E2E Org', slug: randomUUID(), status: 'active' })
			.returning();

		const user = await createCredentialUser(f);
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();

		for (const p of ['categories:view', 'categories:manage']) {
			await grantPermission(f, {
				organizationId: org.id,
				membershipId: membership.id,
				permissionId: p
			});
		}

		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });

		const catCollection = await server.ssrLoadModule('/src/routes/api/categories/+server.ts');
		const catMember = await server.ssrLoadModule('/src/routes/api/categories/[id]/+server.ts');
		const subCollection = await server.ssrLoadModule('/src/routes/api/subcategories/+server.ts');
		const subMember = await server.ssrLoadModule('/src/routes/api/subcategories/[id]/+server.ts');

		const ssrFetch = async (input, init = {}) => {
			const url = new URL(typeof input === 'string' ? input : input.url, 'http://localhost');
			const headers = new Headers(init.headers || {});
			headers.set('cookie', session.cookieHeader);
			const req = new Request(url, {
				method: init.method || 'GET',
				headers,
				body: init.body
			});

			if (url.pathname === '/api/categories') {
				if (req.method === 'POST') return catCollection.POST({ request: req, url });
				return catCollection.GET({ request: req, url });
			}
			if (url.pathname.startsWith('/api/categories/')) {
				const id = url.pathname.slice('/api/categories/'.length);
				return catMember.PATCH({ request: req, url, params: { id } });
			}
			if (url.pathname === '/api/subcategories') {
				if (req.method === 'POST') return subCollection.POST({ request: req, url });
				return subCollection.GET({ request: req, url });
			}
			if (url.pathname.startsWith('/api/subcategories/')) {
				const id = url.pathname.slice('/api/subcategories/'.length);
				return subMember.PATCH({ request: req, url, params: { id } });
			}
			throw new Error(`Unhandled route ${url.pathname}`);
		};

		// 1. Create Category
		const cat = await createCategory({
			organizationId: org.id,
			name: 'Redes y Comunicaciones',
			customFetch: ssrFetch
		});
		assert.equal(cat.name, 'Redes y Comunicaciones');

		// 2. Create Subcategory
		const sub = await createSubcategory({
			organizationId: org.id,
			categoryId: cat.id,
			name: 'Routers y Switches',
			description: 'Equipos de red',
			customFetch: ssrFetch
		});
		assert.equal(sub.name, 'Routers y Switches');
		assert.equal(sub.categoryId, cat.id);

		// 3. List Subcategories
		const list = await listSubcategories({
			organizationId: org.id,
			categoryId: cat.id,
			customFetch: ssrFetch
		});
		assert.equal(list.length, 1);
		assert.equal(list[0].id, sub.id);

		// 4. Update Subcategory
		const updatedSub = await updateSubcategory({
			organizationId: org.id,
			subcategoryId: sub.id,
			name: 'Routers, Switches y WiFi',
			customFetch: ssrFetch
		});
		assert.equal(updatedSub.name, 'Routers, Switches y WiFi');

		// 5. Get Category Tree
		const tree = await getCategoryTree({
			organizationId: org.id,
			customFetch: ssrFetch
		});
		assert.equal(tree.length, 1);
		assert.equal(tree[0].id, cat.id);
		assert.equal(tree[0].subcategories.length, 1);
		assert.equal(tree[0].subcategories[0].name, 'Routers, Switches y WiFi');

		// 6. Set active
		const deactSub = await setSubcategoryActive({
			organizationId: org.id,
			subcategoryId: sub.id,
			active: false,
			customFetch: ssrFetch
		});
		assert.equal(deactSub.active, false);
	});
});

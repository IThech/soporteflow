import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
	fixture,
	createCredentialUser,
	createSession,
	grantPermission
} from './helpers/auth-fixture.mjs';

const VIEW = 'categories:view';
const MANAGE = 'categories:manage';
const SUB_DTO_KEYS = [
	'active',
	'categoryId',
	'createdAt',
	'description',
	'id',
	'name',
	'updatedAt'
];

test('SoporteFlow — Subcategories API HTTP & Tree endpoint', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;
	const catCollection = await server.ssrLoadModule('/src/routes/api/categories/+server.ts');
	const catMember = await server.ssrLoadModule('/src/routes/api/categories/[id]/+server.ts');
	const subCollection = await server.ssrLoadModule('/src/routes/api/subcategories/+server.ts');
	const subMember = await server.ssrLoadModule('/src/routes/api/subcategories/[id]/+server.ts');

	const [orgA, orgB] = await db
		.insert(s.organizations)
		.values([
			{ name: 'Subcategories API A', slug: randomUUID(), status: 'active' },
			{ name: 'Subcategories API B', slug: randomUUID(), status: 'active' }
		])
		.returning();

	async function actor(organization, permissions) {
		const user = await createCredentialUser(f);
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

	const adminA = await actor(orgA, [VIEW, MANAGE]);
	const viewerA = await actor(orgA, [VIEW]);
	const unprivilegedA = await actor(orgA, []);
	const adminB = await actor(orgB, [VIEW, MANAGE]);

	function makeRequest(path, options = {}, cookie = adminA.cookie) {
		const headers = new Headers(options.headers || {});
		if (cookie) headers.set('cookie', cookie);
		if (options.body) headers.set('content-type', 'application/json');
		return new Request(`http://localhost${path}`, {
			method: options.method || 'GET',
			headers,
			body: options.body ? JSON.stringify(options.body) : undefined
		});
	}

	// 1. Create a category in Org A
	const catResA = await catCollection.POST({
		request: makeRequest(`/api/categories?organizationId=${orgA.id}`, {
			method: 'POST',
			body: { name: 'Hardware', description: 'Equipos físicos' }
		}),
		url: new URL(`http://localhost/api/categories?organizationId=${orgA.id}`)
	});
	assert.equal(catResA.status, 201);
	const { category: catA } = await catResA.json();

	// Create a category in Org B
	const catResB = await catCollection.POST({
		request: makeRequest(
			`/api/categories?organizationId=${orgB.id}`,
			{
				method: 'POST',
				body: { name: 'Hardware B' }
			},
			adminB.cookie
		),
		url: new URL(`http://localhost/api/categories?organizationId=${orgB.id}`)
	});
	assert.equal(catResB.status, 201);
	const { category: catB } = await catResB.json();

	await t.test('POST /api/subcategories: permissions & authorization', async () => {
		// No auth
		const resNoAuth = await subCollection.POST({
			request: makeRequest(
				`/api/subcategories?organizationId=${orgA.id}`,
				{
					method: 'POST',
					body: { categoryId: catA.id, name: 'Portátiles' }
				},
				null
			),
			url: new URL(`http://localhost/api/subcategories?organizationId=${orgA.id}`)
		});
		assert.equal(resNoAuth.status, 401);

		// Viewer only (no categories:manage)
		const resViewer = await subCollection.POST({
			request: makeRequest(
				`/api/subcategories?organizationId=${orgA.id}`,
				{
					method: 'POST',
					body: { categoryId: catA.id, name: 'Portátiles' }
				},
				viewerA.cookie
			),
			url: new URL(`http://localhost/api/subcategories?organizationId=${orgA.id}`)
		});
		assert.equal(resViewer.status, 403);

		// Unprivileged
		const resNone = await subCollection.POST({
			request: makeRequest(
				`/api/subcategories?organizationId=${orgA.id}`,
				{
					method: 'POST',
					body: { categoryId: catA.id, name: 'Portátiles' }
				},
				unprivilegedA.cookie
			),
			url: new URL(`http://localhost/api/subcategories?organizationId=${orgA.id}`)
		});
		assert.equal(resNone.status, 403);
	});

	let sub1;
	await t.test('POST /api/subcategories: create valid subcategory', async () => {
		const res = await subCollection.POST({
			request: makeRequest(`/api/subcategories?organizationId=${orgA.id}`, {
				method: 'POST',
				body: { categoryId: catA.id, name: '  Portátiles  ', description: 'Laptops y notebooks' }
			}),
			url: new URL(`http://localhost/api/subcategories?organizationId=${orgA.id}`)
		});
		assert.equal(res.status, 201);
		const data = await res.json();
		assert.ok(data.subcategory);
		sub1 = data.subcategory;
		assert.equal(sub1.name, 'Portátiles');
		assert.equal(sub1.description, 'Laptops y notebooks');
		assert.equal(sub1.categoryId, catA.id);
		assert.equal(sub1.active, true);
		assert.deepEqual(Object.keys(sub1).sort(), SUB_DTO_KEYS);
	});

	await t.test('POST /api/subcategories: duplicate name within same category -> 409', async () => {
		const res = await subCollection.POST({
			request: makeRequest(`/api/subcategories?organizationId=${orgA.id}`, {
				method: 'POST',
				body: { categoryId: catA.id, name: 'portátiles' }
			}),
			url: new URL(`http://localhost/api/subcategories?organizationId=${orgA.id}`)
		});
		assert.equal(res.status, 409);
		const data = await res.json();
		assert.equal(data.error.code, 'SUBCATEGORY_NAME_DUPLICATE');
	});

	await t.test('POST /api/subcategories: cross-tenant category -> 404 (isolation)', async () => {
		// Org A admin trying to create subcategory inside Org B's category
		const res = await subCollection.POST({
			request: makeRequest(`/api/subcategories?organizationId=${orgA.id}`, {
				method: 'POST',
				body: { categoryId: catB.id, name: 'Hack attempt' }
			}),
			url: new URL(`http://localhost/api/subcategories?organizationId=${orgA.id}`)
		});
		assert.equal(res.status, 404);
		const data = await res.json();
		assert.equal(data.error.code, 'CATEGORY_NOT_FOUND');
	});

	await t.test(
		'POST /api/subcategories: duplicate name allowed across different categories',
		async () => {
			// Create another category in Org A
			const cat2Res = await catCollection.POST({
				request: makeRequest(`/api/categories?organizationId=${orgA.id}`, {
					method: 'POST',
					body: { name: 'Inventario' }
				}),
				url: new URL(`http://localhost/api/categories?organizationId=${orgA.id}`)
			});
			assert.equal(cat2Res.status, 201);
			const { category: cat2 } = await cat2Res.json();

			const res = await subCollection.POST({
				request: makeRequest(`/api/subcategories?organizationId=${orgA.id}`, {
					method: 'POST',
					body: { categoryId: cat2.id, name: 'Portátiles' }
				}),
				url: new URL(`http://localhost/api/subcategories?organizationId=${orgA.id}`)
			});
			assert.equal(res.status, 201);
		}
	);

	await t.test('GET /api/subcategories: list, filter, permissions', async () => {
		// Viewer can list
		const resViewer = await subCollection.GET({
			request: makeRequest(`/api/subcategories?organizationId=${orgA.id}`, {}, viewerA.cookie),
			url: new URL(`http://localhost/api/subcategories?organizationId=${orgA.id}`)
		});
		assert.equal(resViewer.status, 200);
		const dataViewer = await resViewer.json();
		assert.equal(dataViewer.subcategories.length, 2);

		// Filter by categoryId
		const resFilterCat = await subCollection.GET({
			request: makeRequest(
				`/api/subcategories?organizationId=${orgA.id}&categoryId=${catA.id}`,
				{},
				viewerA.cookie
			),
			url: new URL(
				`http://localhost/api/subcategories?organizationId=${orgA.id}&categoryId=${catA.id}`
			)
		});
		assert.equal(resFilterCat.status, 200);
		const dataFilterCat = await resFilterCat.json();
		assert.equal(dataFilterCat.subcategories.length, 1);
		assert.equal(dataFilterCat.subcategories[0].id, sub1.id);

		// Cross-tenant list isolation: Org B sees 0
		const resOrgB = await subCollection.GET({
			request: makeRequest(`/api/subcategories?organizationId=${orgB.id}`, {}, adminB.cookie),
			url: new URL(`http://localhost/api/subcategories?organizationId=${orgB.id}`)
		});
		assert.equal(resOrgB.status, 200);
		const dataOrgB = await resOrgB.json();
		assert.equal(dataOrgB.subcategories.length, 0);
	});

	await t.test('PATCH /api/subcategories/[id]: update name and description', async () => {
		const res = await subMember.PATCH({
			request: makeRequest(`/api/subcategories/${sub1.id}?organizationId=${orgA.id}`, {
				method: 'PATCH',
				body: { action: 'update', name: 'Portátiles Corporativos', description: null }
			}),
			url: new URL(`http://localhost/api/subcategories/${sub1.id}?organizationId=${orgA.id}`),
			params: { id: sub1.id }
		});
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.subcategory.name, 'Portátiles Corporativos');
		assert.equal(data.subcategory.description, null);
	});

	await t.test('PATCH /api/subcategories/[id]: cross-tenant edit -> 404', async () => {
		const res = await subMember.PATCH({
			request: makeRequest(
				`/api/subcategories/${sub1.id}?organizationId=${orgB.id}`,
				{
					method: 'PATCH',
					body: { action: 'update', name: 'Hacked' }
				},
				adminB.cookie
			),
			url: new URL(`http://localhost/api/subcategories/${sub1.id}?organizationId=${orgB.id}`),
			params: { id: sub1.id }
		});
		assert.equal(res.status, 404);
	});

	await t.test('PATCH /api/subcategories/[id]: toggle active state', async () => {
		// Deactivate
		const resDeact = await subMember.PATCH({
			request: makeRequest(`/api/subcategories/${sub1.id}?organizationId=${orgA.id}`, {
				method: 'PATCH',
				body: { action: 'set_active', active: false }
			}),
			url: new URL(`http://localhost/api/subcategories/${sub1.id}?organizationId=${orgA.id}`),
			params: { id: sub1.id }
		});
		assert.equal(resDeact.status, 200);
		assert.equal((await resDeact.json()).subcategory.active, false);

		// Re-activate
		const resAct = await subMember.PATCH({
			request: makeRequest(`/api/subcategories/${sub1.id}?organizationId=${orgA.id}`, {
				method: 'PATCH',
				body: { action: 'set_active', active: true }
			}),
			url: new URL(`http://localhost/api/subcategories/${sub1.id}?organizationId=${orgA.id}`),
			params: { id: sub1.id }
		});
		assert.equal(resAct.status, 200);
		assert.equal((await resAct.json()).subcategory.active, true);
	});

	await t.test('Cascade: deactivating category deactivates its subcategories', async () => {
		// Deactivate catA
		const resDeactCat = await catMember.PATCH({
			request: makeRequest(`/api/categories/${catA.id}?organizationId=${orgA.id}`, {
				method: 'PATCH',
				body: { action: 'set_active', active: false }
			}),
			url: new URL(`http://localhost/api/categories/${catA.id}?organizationId=${orgA.id}`),
			params: { id: catA.id }
		});
		assert.equal(resDeactCat.status, 200);

		// Verify sub1 is now inactive
		const resSub = await subCollection.GET({
			request: makeRequest(`/api/subcategories?organizationId=${orgA.id}&categoryId=${catA.id}`),
			url: new URL(
				`http://localhost/api/subcategories?organizationId=${orgA.id}&categoryId=${catA.id}`
			)
		});
		const { subcategories } = await resSub.json();
		assert.equal(subcategories[0].active, false);

		// Cannot activate subcategory while category is inactive -> 409 CATEGORY_INACTIVE
		const resReactivateSub = await subMember.PATCH({
			request: makeRequest(`/api/subcategories/${sub1.id}?organizationId=${orgA.id}`, {
				method: 'PATCH',
				body: { action: 'set_active', active: true }
			}),
			url: new URL(`http://localhost/api/subcategories/${sub1.id}?organizationId=${orgA.id}`),
			params: { id: sub1.id }
		});
		assert.equal(resReactivateSub.status, 409);
		assert.equal((await resReactivateSub.json()).error.code, 'CATEGORY_INACTIVE');

		// Re-activate catA
		await catMember.PATCH({
			request: makeRequest(`/api/categories/${catA.id}?organizationId=${orgA.id}`, {
				method: 'PATCH',
				body: { action: 'set_active', active: true }
			}),
			url: new URL(`http://localhost/api/categories/${catA.id}?organizationId=${orgA.id}`),
			params: { id: catA.id }
		});

		// Now activating subcategory succeeds
		const resReactivateSub2 = await subMember.PATCH({
			request: makeRequest(`/api/subcategories/${sub1.id}?organizationId=${orgA.id}`, {
				method: 'PATCH',
				body: { action: 'set_active', active: true }
			}),
			url: new URL(`http://localhost/api/subcategories/${sub1.id}?organizationId=${orgA.id}`),
			params: { id: sub1.id }
		});
		assert.equal(resReactivateSub2.status, 200);
		assert.equal((await resReactivateSub2.json()).subcategory.active, true);
	});

	await t.test('GET /api/categories?tree=true returns nested subcategories', async () => {
		const res = await catCollection.GET({
			request: makeRequest(`/api/categories?organizationId=${orgA.id}&tree=true`),
			url: new URL(`http://localhost/api/categories?organizationId=${orgA.id}&tree=true`)
		});
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.ok(Array.isArray(data.categories));
		const treeNode = data.categories.find((c) => c.id === catA.id);
		assert.ok(treeNode);
		assert.ok(Array.isArray(treeNode.subcategories));
		assert.equal(treeNode.subcategories.length, 1);
		assert.equal(treeNode.subcategories[0].id, sub1.id);
		assert.equal(treeNode.subcategories[0].name, 'Portátiles Corporativos');
	});
});

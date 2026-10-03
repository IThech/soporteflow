import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
	fixture,
	createCredentialUser,
	createSession,
	grantPermission
} from './helpers/auth-fixture.mjs';

test('SoporteFlow — Incidents Subcategory Integration', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;

	const [orgA, orgB] = await db
		.insert(s.organizations)
		.values([
			{ name: 'Incidents Subcat Org A', slug: randomUUID(), status: 'active' },
			{ name: 'Incidents Subcat Org B', slug: randomUUID(), status: 'active' }
		])
		.returning();

	async function actor(organization, permissions) {
		const user = await createCredentialUser(f);
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: organization.id, userId: user.id })
			.returning();
		for (const p of permissions) {
			await grantPermission(f, {
				organizationId: organization.id,
				membershipId: membership.id,
				permissionId: p
			});
		}
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, cookie: session.cookieHeader };
	}

	const agentA = await actor(orgA, [
		'incidents:create',
		'incidents:edit',
		'incidents:view_all',
		'categories:view',
		'categories:manage'
	]);
	const agentB = await actor(orgB, [
		'incidents:create',
		'incidents:edit',
		'incidents:view_all',
		'categories:view',
		'categories:manage'
	]);

	const catModule = await server.ssrLoadModule('/src/routes/api/categories/+server.ts');
	const subModule = await server.ssrLoadModule('/src/routes/api/subcategories/+server.ts');
	const subMemberModule = await server.ssrLoadModule(
		'/src/routes/api/subcategories/[id]/+server.ts'
	);
	const incModule = await server.ssrLoadModule('/src/routes/api/incidents/+server.ts');
	const incCatModule = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/category/+server.ts'
	);

	function makeRequest(path, options = {}, cookie = agentA.cookie) {
		const headers = new Headers(options.headers || {});
		if (cookie) headers.set('cookie', cookie);
		if (options.body) headers.set('content-type', 'application/json');
		return new Request(`http://localhost${path}`, {
			method: options.method || 'GET',
			headers,
			body: options.body ? JSON.stringify(options.body) : undefined
		});
	}

	// 1. Create categories and subcategories
	const catRes1 = await catModule.POST({
		request: makeRequest(`/api/categories?organizationId=${orgA.id}`, {
			method: 'POST',
			body: { name: 'Sistemas Operativos' }
		}),
		url: new URL(`http://localhost/api/categories?organizationId=${orgA.id}`)
	});
	const { category: cat1 } = await catRes1.json();

	const catRes2 = await catModule.POST({
		request: makeRequest(`/api/categories?organizationId=${orgA.id}`, {
			method: 'POST',
			body: { name: 'Hardware' }
		}),
		url: new URL(`http://localhost/api/categories?organizationId=${orgA.id}`)
	});
	const { category: cat2 } = await catRes2.json();

	// Subcategory for cat1
	const subRes1 = await subModule.POST({
		request: makeRequest(`/api/subcategories?organizationId=${orgA.id}`, {
			method: 'POST',
			body: { categoryId: cat1.id, name: 'Linux' }
		}),
		url: new URL(`http://localhost/api/subcategories?organizationId=${orgA.id}`)
	});
	const { subcategory: sub1 } = await subRes1.json();

	// Subcategory for cat2
	const subRes2 = await subModule.POST({
		request: makeRequest(`/api/subcategories?organizationId=${orgA.id}`, {
			method: 'POST',
			body: { categoryId: cat2.id, name: 'Impresoras' }
		}),
		url: new URL(`http://localhost/api/subcategories?organizationId=${orgA.id}`)
	});
	const { subcategory: sub2 } = await subRes2.json();

	// Org B category & subcategory
	const catResB = await catModule.POST({
		request: makeRequest(
			`/api/categories?organizationId=${orgB.id}`,
			{
				method: 'POST',
				body: { name: 'Redes B' }
			},
			agentB.cookie
		),
		url: new URL(`http://localhost/api/categories?organizationId=${orgB.id}`)
	});
	const { category: catB } = await catResB.json();

	const subResB = await subModule.POST({
		request: makeRequest(
			`/api/subcategories?organizationId=${orgB.id}`,
			{
				method: 'POST',
				body: { categoryId: catB.id, name: 'WiFi B' }
			},
			agentB.cookie
		),
		url: new URL(`http://localhost/api/subcategories?organizationId=${orgB.id}`)
	});
	const { subcategory: subB } = await subResB.json();

	let incident1;
	await t.test('Create incident with valid categoryId + subcategoryId', async () => {
		const res = await incModule.POST({
			request: makeRequest(`/api/incidents`, {
				method: 'POST',
				body: {
					organizationId: orgA.id,
					title: 'Error de kernel Linux',
					description: 'Kernel panic tras actualización',
					priority: 'high',
					client: 'Acme Corp',
					categoryId: cat1.id,
					subcategoryId: sub1.id
				}
			}),
			url: new URL(`http://localhost/api/incidents`)
		});
		assert.equal(res.status, 201);
		const data = await res.json();
		incident1 = data.incident;
		assert.equal(incident1.categoryId, cat1.id);
		assert.equal(incident1.subcategoryId, sub1.id);

		// Verify in DB directly
		const [dbInc] = await db.select().from(s.incidents).where(eq(s.incidents.id, incident1.id));
		assert.equal(dbInc.categoryId, cat1.id);
		assert.equal(dbInc.subcategoryId, sub1.id);
	});

	await t.test('Create incident with subcategoryId but NO categoryId -> 400', async () => {
		const res = await incModule.POST({
			request: makeRequest(`/api/incidents`, {
				method: 'POST',
				body: {
					organizationId: orgA.id,
					title: 'Inválido',
					description: 'Subcategoría sin categoría',
					client: 'Acme Corp',
					subcategoryId: sub1.id
				}
			}),
			url: new URL(`http://localhost/api/incidents`)
		});
		assert.equal(res.status, 400);
	});

	await t.test(
		'Create incident with subcategory belonging to a DIFFERENT category -> 400/404',
		async () => {
			// cat1 is "Sistemas Operativos", sub2 is "Impresoras" under cat2 "Hardware"
			const res = await incModule.POST({
				request: makeRequest(`/api/incidents`, {
					method: 'POST',
					body: {
						organizationId: orgA.id,
						title: 'Mismatch',
						description: 'Subcategoría de otra categoría',
						client: 'Acme Corp',
						categoryId: cat1.id,
						subcategoryId: sub2.id
					}
				}),
				url: new URL(`http://localhost/api/incidents`)
			});
			assert.ok(res.status === 400 || res.status === 404);
		}
	);

	await t.test('Create incident with cross-tenant subcategory -> 404', async () => {
		const res = await incModule.POST({
			request: makeRequest(`/api/incidents`, {
				method: 'POST',
				body: {
					organizationId: orgA.id,
					title: 'Cross tenant subcategory',
					description: 'Subcat de Org B en Org A',
					client: 'Acme Corp',
					categoryId: cat1.id,
					subcategoryId: subB.id
				}
			}),
			url: new URL(`http://localhost/api/incidents`)
		});
		assert.equal(res.status, 404);
	});

	await t.test('Create incident with inactive subcategory -> 409', async () => {
		// Deactivate sub1
		await subMemberModule.PATCH({
			request: makeRequest(`/api/subcategories/${sub1.id}?organizationId=${orgA.id}`, {
				method: 'PATCH',
				body: { action: 'set_active', active: false }
			}),
			url: new URL(`http://localhost/api/subcategories/${sub1.id}?organizationId=${orgA.id}`),
			params: { id: sub1.id }
		});

		const res = await incModule.POST({
			request: makeRequest(`/api/incidents`, {
				method: 'POST',
				body: {
					organizationId: orgA.id,
					title: 'Subcategoría inactiva',
					description: 'Intentando usar inactiva',
					client: 'Acme Corp',
					categoryId: cat1.id,
					subcategoryId: sub1.id
				}
			}),
			url: new URL(`http://localhost/api/incidents`)
		});
		assert.equal(res.status, 409);
		const data = await res.json();
		assert.equal(data.error.code, 'SUBCATEGORY_INACTIVE');

		// Re-activate sub1
		await subMemberModule.PATCH({
			request: makeRequest(`/api/subcategories/${sub1.id}?organizationId=${orgA.id}`, {
				method: 'PATCH',
				body: { action: 'set_active', active: true }
			}),
			url: new URL(`http://localhost/api/subcategories/${sub1.id}?organizationId=${orgA.id}`),
			params: { id: sub1.id }
		});
	});

	await t.test('PATCH /api/incidents/[id]/category: change category and subcategory', async () => {
		const res = await incCatModule.PATCH({
			request: makeRequest(`/api/incidents/${incident1.id}/category?organizationId=${orgA.id}`, {
				method: 'PATCH',
				body: {
					categoryId: cat2.id,
					subcategoryId: sub2.id,
					reason: 'Reclasificación a Hardware / Impresoras'
				}
			}),
			url: new URL(
				`http://localhost/api/incidents/${incident1.id}/category?organizationId=${orgA.id}`
			),
			params: { id: incident1.id }
		});
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.incident.categoryId, cat2.id);
		assert.equal(data.incident.subcategoryId, sub2.id);

		// Now clear subcategory keeping category
		const res2 = await incCatModule.PATCH({
			request: makeRequest(`/api/incidents/${incident1.id}/category?organizationId=${orgA.id}`, {
				method: 'PATCH',
				body: {
					categoryId: cat2.id,
					subcategoryId: null,
					reason: 'Hardware general sin subcategoría'
				}
			}),
			url: new URL(
				`http://localhost/api/incidents/${incident1.id}/category?organizationId=${orgA.id}`
			),
			params: { id: incident1.id }
		});
		assert.equal(res2.status, 200);
		const data2 = await res2.json();
		assert.equal(data2.incident.categoryId, cat2.id);
		assert.equal(data2.incident.subcategoryId, null);

		// Now clear category and subcategory
		const res3 = await incCatModule.PATCH({
			request: makeRequest(`/api/incidents/${incident1.id}/category?organizationId=${orgA.id}`, {
				method: 'PATCH',
				body: {
					categoryId: null,
					subcategoryId: null,
					reason: 'Sin clasificar'
				}
			}),
			url: new URL(
				`http://localhost/api/incidents/${incident1.id}/category?organizationId=${orgA.id}`
			),
			params: { id: incident1.id }
		});
		assert.equal(res3.status, 200);
		const data3 = await res3.json();
		assert.equal(data3.incident.categoryId, null);
		assert.equal(data3.incident.subcategoryId, null);
	});
});

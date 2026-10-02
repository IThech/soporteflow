import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
	fixture,
	createCredentialUser,
	createSession,
	grantPermission
} from './helpers/auth-fixture.mjs';

const ORIGIN = 'http://localhost';
const VIEW = 'sites:view';
const MANAGE = 'sites:manage';
const INCIDENTS_CREATE = 'incidents:create';
const INCIDENTS_VIEW_ALL = 'incidents:view_all';
const INCIDENTS_EDIT = 'incidents:edit';

test('SoporteFlow — Sedes: Administración, aislamiento y selector en incidencias', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;

	const sitesCollection = await server.ssrLoadModule('/src/routes/api/sites/+server.ts');
	const siteItem = await server.ssrLoadModule('/src/routes/api/sites/[id]/+server.ts');
	const incidentsCollection = await server.ssrLoadModule('/src/routes/api/incidents/+server.ts');
	const incidentSiteRoute = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/site/+server.ts'
	);

	const [orgA, orgB] = await db
		.insert(s.organizations)
		.values([
			{ name: 'Org Sedes A', slug: 'sites-a-' + randomUUID(), status: 'active' },
			{ name: 'Org Sedes B', slug: 'sites-b-' + randomUUID(), status: 'active' }
		])
		.returning();

	async function makeActor(organization, permissions = []) {
		const user = await createCredentialUser(f, { email: `actor-${randomUUID()}@example.test` });
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: organization.id, userId: user.id })
			.returning();
		for (const permissionId of permissions) {
			await grantPermission(f, {
				organizationId: organization.id,
				membershipId: membership.id,
				permissionId
			});
		}
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, cookie: session.cookieHeader };
	}

	const adminA = await makeActor(orgA, [
		VIEW,
		MANAGE,
		INCIDENTS_CREATE,
		INCIDENTS_VIEW_ALL,
		INCIDENTS_EDIT
	]);
	const viewerA = await makeActor(orgA, [VIEW, INCIDENTS_CREATE, INCIDENTS_VIEW_ALL]);
	const noSitesA = await makeActor(orgA, [INCIDENTS_CREATE, INCIDENTS_VIEW_ALL]);
	const adminB = await makeActor(orgB, [VIEW, MANAGE, INCIDENTS_CREATE, INCIDENTS_VIEW_ALL]);

	async function call(handler, { method = 'GET', path, cookie, body, query = '' }) {
		const fullQuery = query ? (query.startsWith('?') ? query : `?${query}`) : '';
		const url = new URL(`${ORIGIN}${path}${fullQuery}`);
		const headers = new Headers({ origin: ORIGIN });
		if (cookie) headers.set('cookie', cookie);
		if (body !== undefined) headers.set('content-type', 'application/json');

		const parts = path.split('/').filter(Boolean);
		let id;
		if (parts[1] === 'incidents') {
			id = parts[2];
		} else if (parts[parts.length - 1] !== 'sites') {
			id = parts[parts.length - 1];
		}
		const params = id ? { id } : {};

		const response = await handler({
			url,
			params,
			request: new Request(url, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body)
			}),
			route: { id: path }
		});
		const text = await response.text();
		return {
			status: response.status,
			headers: response.headers,
			json: text ? JSON.parse(text) : null,
			text
		};
	}

	// 1. RBAC & Auth checks
	await t.test('1. RBAC: Autenticación y permisos requeridos para sedes', async () => {
		const unauth = await call(sitesCollection.GET, {
			path: '/api/sites',
			query: `organizationId=${orgA.id}`
		});
		assert.equal(unauth.status, 401);

		const forbiddenList = await call(sitesCollection.GET, {
			path: '/api/sites',
			cookie: noSitesA.cookie,
			query: `organizationId=${orgA.id}`
		});
		assert.equal(forbiddenList.status, 403);

		const viewerList = await call(sitesCollection.GET, {
			path: '/api/sites',
			cookie: viewerA.cookie,
			query: `organizationId=${orgA.id}`
		});
		assert.equal(viewerList.status, 200);

		const forbiddenCreate = await call(sitesCollection.POST, {
			path: '/api/sites',
			method: 'POST',
			cookie: viewerA.cookie,
			query: `organizationId=${orgA.id}`,
			body: { name: 'Sede Denegada' }
		});
		assert.equal(forbiddenCreate.status, 403);
	});

	// 2. Lifecycle: Create, List, Edit (extended fields), Deactivate, Reactivate
	let sedeValenciaId;
	await t.test('2. Ciclo de vida completo de sedes con campos extendidos', async () => {
		const createRes = await call(sitesCollection.POST, {
			path: '/api/sites',
			method: 'POST',
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}`,
			body: {
				name: 'Valencia Centro',
				code: 'VLC-01',
				address: 'Calle Colón 10',
				city: 'Valencia',
				postalCode: '46004',
				country: 'ES'
			}
		});
		assert.equal(createRes.status, 201);
		sedeValenciaId = createRes.json.site.id;
		assert.equal(createRes.json.site.name, 'Valencia Centro');
		assert.equal(createRes.json.site.code, 'VLC-01');
		assert.equal(createRes.json.site.city, 'Valencia');
		assert.equal(createRes.json.site.active, true);

		// List
		const listRes = await call(sitesCollection.GET, {
			path: '/api/sites',
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}`
		});
		assert.equal(listRes.status, 200);
		assert.equal(listRes.json.sites.length, 1);
		assert.equal(listRes.json.sites[0].name, 'Valencia Centro');
		assert.equal(listRes.json.sites[0].code, 'VLC-01');

		// Update with action: 'edit'
		const editRes = await call(siteItem.PATCH, {
			path: `/api/sites/${sedeValenciaId}`,
			method: 'PATCH',
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}`,
			body: {
				action: 'edit',
				name: 'Valencia Sede Principal',
				code: 'VLC-HQ',
				city: 'Valencia Capital'
			}
		});
		assert.equal(editRes.status, 200);
		assert.equal(editRes.json.site.name, 'Valencia Sede Principal');
		assert.equal(editRes.json.site.code, 'VLC-HQ');
		assert.equal(editRes.json.site.city, 'Valencia Capital');
		assert.equal(editRes.json.site.address, 'Calle Colón 10');

		// Deactivate
		const deactRes = await call(siteItem.PATCH, {
			path: `/api/sites/${sedeValenciaId}`,
			method: 'PATCH',
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}`,
			body: { action: 'set_active', active: false }
		});
		assert.equal(deactRes.status, 200);
		assert.equal(deactRes.json.site.active, false);

		// Active-only list excludes it
		const activeList = await call(sitesCollection.GET, {
			path: '/api/sites',
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}&activeOnly=true`
		});
		assert.equal(activeList.status, 200);
		assert.equal(activeList.json.sites.length, 0);

		// Reactivate
		const reactRes = await call(siteItem.PATCH, {
			path: `/api/sites/${sedeValenciaId}`,
			method: 'PATCH',
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}`,
			body: { action: 'set_active', active: true }
		});
		assert.equal(reactRes.status, 200);
		assert.equal(reactRes.json.site.active, true);
	});

	// 3. Multi-tenant isolation
	await t.test('3. Aislamiento estricto multi-tenant de sedes', async () => {
		// Org B cannot access Org A's site
		const crossPatch = await call(siteItem.PATCH, {
			path: `/api/sites/${sedeValenciaId}`,
			method: 'PATCH',
			cookie: adminB.cookie,
			query: `organizationId=${orgB.id}`,
			body: { action: 'rename', name: 'Hack' }
		});
		assert.equal(crossPatch.status, 404);
		assert.equal(crossPatch.json.error?.code, 'SITE_NOT_FOUND');

		// Org B cannot see Org A's sites in list
		const listB = await call(sitesCollection.GET, {
			path: '/api/sites',
			cookie: adminB.cookie,
			query: `organizationId=${orgB.id}`
		});
		assert.equal(listB.status, 200);
		assert.equal(listB.json.sites.length, 0);

		// Org B can create a site with the same name without conflict
		const createB = await call(sitesCollection.POST, {
			path: '/api/sites',
			method: 'POST',
			cookie: adminB.cookie,
			query: `organizationId=${orgB.id}`,
			body: { name: 'Valencia Sede Principal' }
		});
		assert.equal(createB.status, 201);
		assert.equal(createB.json.site.name, 'Valencia Sede Principal');
	});

	// 4. Incidents integration & soft deactivation
	await t.test(
		'4. Integración con incidencias y preservación histórica tras desactivar',
		async () => {
			// Create incident with active site
			const incRes = await call(incidentsCollection.POST, {
				path: '/api/incidents',
				method: 'POST',
				cookie: adminA.cookie,
				body: {
					organizationId: orgA.id,
					title: 'Problema de red en Valencia',
					description: 'Fallo de switch',
					client: 'Cliente General',
					siteId: sedeValenciaId,
					priority: 'medium'
				}
			});
			assert.equal(incRes.status, 201);
			const incidentId = incRes.json.incident.id;
			assert.equal(incRes.json.incident.siteId, sedeValenciaId);

			// Deactivate the site
			await call(siteItem.PATCH, {
				path: `/api/sites/${sedeValenciaId}`,
				method: 'PATCH',
				cookie: adminA.cookie,
				query: `organizationId=${orgA.id}`,
				body: { action: 'set_active', active: false }
			});

			// Historical incident still retains the siteId
			const getInc = await call(incidentsCollection.GET, {
				path: '/api/incidents',
				cookie: adminA.cookie,
				query: `organizationId=${orgA.id}`
			});
			const found = getInc.json.incidents.find((i) => i.id === incidentId);
			assert.ok(found);
			assert.equal(found.siteId, sedeValenciaId);

			// Create a second site and deactivate it
			const madridRes = await call(sitesCollection.POST, {
				path: '/api/sites',
				method: 'POST',
				cookie: adminA.cookie,
				query: `organizationId=${orgA.id}`,
				body: { name: 'Madrid Almacén' }
			});
			const sedeMadridId = madridRes.json.site.id;
			await call(siteItem.PATCH, {
				path: `/api/sites/${sedeMadridId}`,
				method: 'PATCH',
				cookie: adminA.cookie,
				query: `organizationId=${orgA.id}`,
				body: { action: 'set_active', active: false }
			});

			// Attempting to change an incident to an inactive site fails with 409 SITE_INACTIVE
			const assignInactive = await call(incidentSiteRoute.PATCH, {
				path: `/api/incidents/${incidentId}/site`,
				method: 'PATCH',
				cookie: adminA.cookie,
				query: `organizationId=${orgA.id}`,
				body: { siteId: sedeMadridId, reason: 'Cambio a sede inactiva' }
			});
			assert.equal(assignInactive.status, 409);
			assert.equal(assignInactive.json.error?.code, 'SITE_INACTIVE');

			// Attempting to create an incident with an inactive site fails with 409 SITE_INACTIVE
			const createWithInactive = await call(incidentsCollection.POST, {
				path: '/api/incidents',
				method: 'POST',
				cookie: adminA.cookie,
				body: {
					organizationId: orgA.id,
					title: 'Incidencia en sede cerrada',
					description: 'Desc',
					client: 'Cliente General',
					siteId: sedeMadridId,
					priority: 'low'
				}
			});
			assert.equal(createWithInactive.status, 409);
			assert.equal(createWithInactive.json.error?.code, 'SITE_INACTIVE');
		}
	);

	// 5. Admin UI checks (SSR & CSS Design Tokens & Accessibility)
	await t.test('5. UI de sedes: tokens de diseño, data-sf-ui y accesibilidad', async () => {
		const filePath = path.resolve('src/routes/app/admin/sites/+page.svelte');
		assert.ok(fs.existsSync(filePath), 'El archivo /app/admin/sites/+page.svelte existe');
		const content = fs.readFileSync(filePath, 'utf8');

		// Inside AppShell
		const appShellCloseIndex = content.indexOf('</AppShell>');
		const modalIndex = content.indexOf('class="sf-modal-backdrop"');
		assert.ok(modalIndex !== -1, 'sf-modal-backdrop presente en el código');
		assert.ok(
			modalIndex < appShellCloseIndex,
			'El modal debe renderizarse DENTRO de AppShell para heredar el contexto data-sf-ui'
		);

		// data-sf-ui explicitly on the backdrop
		assert.match(
			content,
			/class="sf-modal-backdrop"[^>]*data-sf-ui|data-sf-ui[^>]*class="sf-modal-backdrop"/,
			'Backdrop del modal incluye data-sf-ui'
		);

		// CSS rules must use theme design tokens
		assert.match(
			content,
			/\.sf-modal-dialog\s*\{[^}]*background:\s*var\(--surface-card/,
			'El diálogo usa var(--surface-card)'
		);
		assert.match(
			content,
			/\.sf-modal-backdrop\s*\{[^}]*background:\s*var\(--overlay/,
			'El overlay usa var(--overlay)'
		);

		// Accessible keyboard handling (Escape) and focus
		assert.match(
			content,
			/onkeydown=[\s\S]*?Escape[\s\S]*?closeDialog/,
			'Cierre accesible con tecla Escape'
		);
		assert.match(content, /bind:element=\{nameInputElement\}/, 'Enlace de elemento para auto-foco');
	});
});

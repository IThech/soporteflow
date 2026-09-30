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
import { navigationModel } from '../src/lib/app/capabilities.ts';

const ORIGIN = 'http://localhost';
const VIEW = 'clients:view';
const MANAGE = 'clients:manage';
const INCIDENTS_CREATE = 'incidents:create';
const INCIDENTS_VIEW_ALL = 'incidents:view_all';

test('SoporteFlow — Clientes: Administración, aislamiento y selector en nueva incidencia', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;

	const clientsCollection = await server.ssrLoadModule('/src/routes/api/clients/+server.ts');
	const clientItem = await server.ssrLoadModule('/src/routes/api/clients/[id]/+server.ts');
	const incidentsCollection = await server.ssrLoadModule('/src/routes/api/incidents/+server.ts');

	const [orgA, orgB] = await db
		.insert(s.organizations)
		.values([
			{ name: 'Org Clientes A', slug: 'clients-a-' + randomUUID(), status: 'active' },
			{ name: 'Org Clientes B', slug: 'clients-b-' + randomUUID(), status: 'active' }
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

	const adminA = await makeActor(orgA, [VIEW, MANAGE, INCIDENTS_CREATE, INCIDENTS_VIEW_ALL]);
	const viewerA = await makeActor(orgA, [VIEW, INCIDENTS_CREATE, INCIDENTS_VIEW_ALL]);
	const noClientsA = await makeActor(orgA, [INCIDENTS_CREATE, INCIDENTS_VIEW_ALL]);
	const adminB = await makeActor(orgB, [VIEW, MANAGE, INCIDENTS_CREATE, INCIDENTS_VIEW_ALL]);

	async function call(handler, { method = 'GET', path, cookie, body, query = '' }) {
		const fullQuery = query ? (query.startsWith('?') ? query : `?${query}`) : '';
		const url = new URL(`${ORIGIN}${path}${fullQuery}`);
		const headers = new Headers({ origin: ORIGIN });
		if (cookie) headers.set('cookie', cookie);
		if (body !== undefined) headers.set('content-type', 'application/json');

		const parts = path.split('/').filter(Boolean);
		const id =
			parts[parts.length - 1] !== 'clients' && parts[parts.length - 1] !== 'incidents'
				? parts[parts.length - 1]
				: undefined;
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

	// 1. Auth & RBAC security checks
	await t.test('1. RBAC: Autenticación y permisos requeridos para clientes', async () => {
		// 401 unauthenticated
		const unauth = await call(clientsCollection.GET, {
			path: '/api/clients',
			query: `organizationId=${orgA.id}`
		});
		assert.equal(unauth.status, 401);

		// 403 on GET without clients:view
		const forbiddenList = await call(clientsCollection.GET, {
			path: '/api/clients',
			cookie: noClientsA.cookie,
			query: `organizationId=${orgA.id}`
		});
		assert.equal(forbiddenList.status, 403);

		// 403 on POST without clients:manage (even with clients:view)
		const forbiddenCreate = await call(clientsCollection.POST, {
			path: '/api/clients',
			method: 'POST',
			cookie: viewerA.cookie,
			query: `organizationId=${orgA.id}`,
			body: { name: 'Acme Corp' }
		});
		assert.equal(forbiddenCreate.status, 403);

		// Navigation: clients:view alone does NOT grant adminClients (technician does not see administration sidebar)
		assert.equal(navigationModel([VIEW, INCIDENTS_CREATE]).adminClients, undefined);
		// clients:manage grants adminClients (admin sees and manages administration sidebar)
		assert.equal(navigationModel([MANAGE, VIEW, INCIDENTS_CREATE]).adminClients, true);
	});

	// 2. Client creation validations and normalization
	let clientAcmeId;
	let clientBetaId;

	await t.test('2. Creación de cliente: validaciones, trim y unicidad de nombre', async () => {
		// Empty name fails
		const emptyRes = await call(clientsCollection.POST, {
			path: '/api/clients',
			method: 'POST',
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}`,
			body: { name: '   ' }
		});
		assert.equal(emptyRes.status, 400);

		// Valid creation with trim and description
		const createRes = await call(clientsCollection.POST, {
			path: '/api/clients',
			method: 'POST',
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}`,
			body: { name: '  Acme Corporation  ', description: 'Primary client' }
		});
		assert.equal(createRes.status, 201);
		assert.equal(createRes.json.client.name, 'Acme Corporation');
		assert.equal(createRes.json.client.description, 'Primary client');
		assert.equal(createRes.json.client.active, true);
		clientAcmeId = createRes.json.client.id;

		// Duplicate name fails with 409 (case-insensitive)
		const dupRes = await call(clientsCollection.POST, {
			path: '/api/clients',
			method: 'POST',
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}`,
			body: { name: 'acme corporation' }
		});
		assert.equal(dupRes.status, 409);
		assert.equal(dupRes.json.error?.code, 'CLIENT_NAME_DUPLICATE');

		// Create a second client
		const createBeta = await call(clientsCollection.POST, {
			path: '/api/clients',
			method: 'POST',
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}`,
			body: { name: 'Beta Systems' }
		});
		assert.equal(createBeta.status, 201);
		clientBetaId = createBeta.json.client.id;
	});

	// 3. Listing clients: active filter and alphabetical sorting
	await t.test('3. Listado de clientes: orden alfabético y filtros de estado', async () => {
		const listRes = await call(clientsCollection.GET, {
			path: '/api/clients',
			cookie: viewerA.cookie,
			query: `organizationId=${orgA.id}`
		});
		assert.equal(listRes.status, 200);
		assert.ok(Array.isArray(listRes.json.clients));
		assert.equal(listRes.json.clients.length, 2);
		assert.equal(listRes.json.clients[0].name, 'Acme Corporation');
		assert.equal(listRes.json.clients[1].name, 'Beta Systems');
	});

	// 4. Client modification: rename, update notes, set active
	await t.test('4. Edición de cliente y alternancia de estado (activar/desactivar)', async () => {
		// Viewer cannot edit
		const forbiddenPatch = await call(clientItem.PATCH, {
			path: `/api/clients/${clientBetaId}`,
			method: 'PATCH',
			cookie: viewerA.cookie,
			query: `organizationId=${orgA.id}`,
			body: { action: 'rename', name: 'Beta Renamed' }
		});
		assert.equal(forbiddenPatch.status, 403);

		// Admin edits Beta -> Beta Technologies with description
		const renameRes = await call(clientItem.PATCH, {
			path: `/api/clients/${clientBetaId}`,
			method: 'PATCH',
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}`,
			body: { action: 'edit', name: '  Beta Technologies  ', description: 'Updated notes' }
		});
		assert.equal(renameRes.status, 200);
		assert.equal(renameRes.json.client.name, 'Beta Technologies');
		assert.equal(renameRes.json.client.description, 'Updated notes');

		// Renaming to Acme Corporation fails with 409
		const dupRename = await call(clientItem.PATCH, {
			path: `/api/clients/${clientBetaId}`,
			method: 'PATCH',
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}`,
			body: { action: 'rename', name: 'ACME CORPORATION' }
		});
		assert.equal(dupRename.status, 409);

		// Deactivate Beta Technologies
		const deactRes = await call(clientItem.PATCH, {
			path: `/api/clients/${clientBetaId}`,
			method: 'PATCH',
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}`,
			body: { action: 'set_active', active: false }
		});
		assert.equal(deactRes.status, 200);
		assert.equal(deactRes.json.client.active, false);

		// Listing active only should now only return Acme
		const listActive = await call(clientsCollection.GET, {
			path: '/api/clients',
			cookie: viewerA.cookie,
			query: `organizationId=${orgA.id}&activeOnly=true`
		});
		assert.equal(listActive.json.clients.length, 1);
		assert.equal(listActive.json.clients[0].id, clientAcmeId);

		// Listing without activeOnly returns all
		const listAll = await call(clientsCollection.GET, {
			path: '/api/clients',
			cookie: viewerA.cookie,
			query: `organizationId=${orgA.id}`
		});
		assert.equal(listAll.json.clients.length, 2);

		// Reactivate Beta Technologies
		const reactRes = await call(clientItem.PATCH, {
			path: `/api/clients/${clientBetaId}`,
			method: 'PATCH',
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}`,
			body: { action: 'set_active', active: true }
		});
		assert.equal(reactRes.status, 200);
		assert.equal(reactRes.json.client.active, true);
	});

	// 5. Multi-tenant isolation (BOLA / cross-tenant)
	let clientOrgBId;
	await t.test('5. Multi-tenant: Aislamiento estricto entre organizaciones', async () => {
		// Org B can create client with identical name 'Acme Corporation'
		const createOrgB = await call(clientsCollection.POST, {
			path: '/api/clients',
			method: 'POST',
			cookie: adminB.cookie,
			query: `organizationId=${orgB.id}`,
			body: { name: 'Acme Corporation' }
		});
		assert.equal(createOrgB.status, 201);
		clientOrgBId = createOrgB.json.client.id;

		// Org A cannot view Org B client
		const viewOther = await call(clientItem.GET, {
			path: `/api/clients/${clientOrgBId}`,
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}`
		});
		assert.equal(viewOther.status, 404);

		// Org A cannot edit Org B client
		const editOther = await call(clientItem.PATCH, {
			path: `/api/clients/${clientOrgBId}`,
			method: 'PATCH',
			cookie: adminA.cookie,
			query: `organizationId=${orgA.id}`,
			body: { action: 'rename', name: 'Hacked' }
		});
		assert.equal(editOther.status, 404);
	});

	// 6. Incident creation with client selection
	await t.test(
		'6. Creación de incidencia con selector de cliente y persistencia dual',
		async () => {
			// Create incident with valid clientId
			const incRes = await call(incidentsCollection.POST, {
				path: '/api/incidents',
				method: 'POST',
				cookie: adminA.cookie,
				body: {
					organizationId: orgA.id,
					title: 'Router caído en oficina central',
					description: 'El router principal no responde',
					clientId: clientAcmeId,
					priority: 'high'
				}
			});
			assert.equal(incRes.status, 201);
			assert.equal(incRes.json.incident.client, 'Acme Corporation');

			// Verify database row directly
			const [dbRow] = await db
				.select()
				.from(s.incidents)
				.where(eq(s.incidents.id, incRes.json.incident.id));
			assert.ok(dbRow);
			assert.equal(dbRow.clientId, clientAcmeId);
			assert.equal(dbRow.client, 'Acme Corporation');

			// Attempt to create incident with cross-tenant clientId (Org B's client in Org A) -> 404
			const crossTenantInc = await call(incidentsCollection.POST, {
				path: '/api/incidents',
				method: 'POST',
				cookie: adminA.cookie,
				body: {
					organizationId: orgA.id,
					title: 'Test cross-tenant',
					description: 'Desc',
					clientId: clientOrgBId,
					priority: 'low'
				}
			});
			assert.equal(crossTenantInc.status, 404);
			assert.equal(crossTenantInc.json.error?.code, 'CLIENT_NOT_FOUND');

			// Attempt to create incident with non-existent clientId -> 404
			const notFoundInc = await call(incidentsCollection.POST, {
				path: '/api/incidents',
				method: 'POST',
				cookie: adminA.cookie,
				body: {
					organizationId: orgA.id,
					title: 'Test not found',
					description: 'Desc',
					clientId: randomUUID(),
					priority: 'low'
				}
			});
			assert.equal(notFoundInc.status, 404);
			assert.equal(notFoundInc.json.error?.code, 'CLIENT_NOT_FOUND');

			// Deactivate Acme Corporation and attempt to create incident -> 409 CLIENT_INACTIVE
			await call(clientItem.PATCH, {
				path: `/api/clients/${clientAcmeId}`,
				method: 'PATCH',
				cookie: adminA.cookie,
				query: `organizationId=${orgA.id}`,
				body: { action: 'set_active', active: false }
			});

			const inactiveInc = await call(incidentsCollection.POST, {
				path: '/api/incidents',
				method: 'POST',
				cookie: adminA.cookie,
				body: {
					organizationId: orgA.id,
					title: 'Test inactive client',
					description: 'Desc',
					clientId: clientAcmeId,
					priority: 'low'
				}
			});
			assert.equal(inactiveInc.status, 409);
			assert.equal(inactiveInc.json.error?.code, 'CLIENT_INACTIVE');
		}
	);

	// 7. Modal architecture & design tokens in /app/admin/clients
	await t.test(
		'7. Modal de clientes: integridad con tokens de diseño, data-sf-ui y accesibilidad',
		async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');
			const content = fs.readFileSync(
				path.resolve('src/routes/app/admin/clients/+page.svelte'),
				'utf8'
			);

			// Must be inside AppShell and sf-clients-container
			const appShellCloseIndex = content.indexOf('</AppShell>');
			const modalIndex = content.indexOf('class="sf-modal-backdrop"');
			assert.ok(modalIndex !== -1, 'sf-modal-backdrop presente en el código');
			assert.ok(
				modalIndex < appShellCloseIndex,
				'El modal debe renderizarse DENTRO de AppShell para heredar el contexto data-sf-ui'
			);

			// Must have data-sf-ui explicitly on the backdrop as well
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
			assert.match(
				content,
				/bind:element=\{nameInputElement\}/,
				'Enlace de elemento para auto-foco'
			);
		}
	);
});

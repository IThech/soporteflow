import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
	fixture,
	identity,
	createCredentialUser,
	createSession,
	createTamperedCookie,
	grantPermission
} from './helpers/auth-fixture.mjs';

function makeEvent(
	request,
	url = new URL(request.url),
	params = {},
	route = { id: '/api/incidents' }
) {
	return {
		request,
		url,
		params,
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

async function callPost(
	POST,
	{ body, headers = {}, rawBody, url = 'http://localhost/api/incidents' }
) {
	const reqHeaders = new Headers(headers);
	if (!reqHeaders.has('content-type') && rawBody === undefined) {
		reqHeaders.set('content-type', 'application/json');
	}
	const reqBody = rawBody !== undefined ? rawBody : JSON.stringify(body);
	const request = new Request(url, {
		method: 'POST',
		headers: reqHeaders,
		body: reqBody
	});
	const event = makeEvent(request, new URL(url));
	const response = await POST(event);
	const status = response.status;
	const json = await response.json();
	return { status, json, response };
}

async function callGet(GET, { headers = {}, url = 'http://localhost/api/incidents' } = {}) {
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

async function callGetDetail(
	GET,
	{ headers = {}, url = 'http://localhost/api/incidents/test', params = {} } = {}
) {
	const reqHeaders = new Headers(headers);
	const request = new Request(url, {
		method: 'GET',
		headers: reqHeaders
	});
	const event = makeEvent(request, new URL(url), params, { id: '/api/incidents/[id]' });
	const response = await GET(event);
	const status = response.status;
	const json = await response.json();
	return { status, json, response };
}

async function callPatchDetail(
	PATCH,
	{ body, headers = {}, rawBody, url = 'http://localhost/api/incidents/test', params = {} } = {}
) {
	const reqHeaders = new Headers(headers);
	if (!reqHeaders.has('content-type') && rawBody === undefined) {
		reqHeaders.set('content-type', 'application/json');
	}
	const reqBody =
		rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
	const request = new Request(url, {
		method: 'PATCH',
		headers: reqHeaders,
		body: reqBody
	});
	const event = makeEvent(request, new URL(url), params, { id: '/api/incidents/[id]' });
	const response = await PATCH(event);
	const status = response.status;
	const json = await response.json();
	return { status, json, response };
}

async function callGetAssignees(
	GET,
	{ headers = {}, url = 'http://localhost/api/incidents/assignees' } = {}
) {
	const reqHeaders = new Headers(headers);
	const request = new Request(url, {
		method: 'GET',
		headers: reqHeaders
	});
	const event = makeEvent(request, new URL(url), {}, { id: '/api/incidents/assignees' });
	const response = await GET(event);
	const status = response.status;
	const json = await response.json();
	return { status, json, response };
}

async function callPostAssign(
	POST,
	{
		body,
		headers = {},
		rawBody,
		url = 'http://localhost/api/incidents/test/assign',
		params = {}
	} = {}
) {
	const reqHeaders = new Headers(headers);
	if (!reqHeaders.has('content-type') && rawBody === undefined) {
		reqHeaders.set('content-type', 'application/json');
	}
	const reqBody =
		rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
	const request = new Request(url, {
		method: 'POST',
		headers: reqHeaders,
		body: reqBody
	});
	const event = makeEvent(request, new URL(url), params, { id: '/api/incidents/[id]/assign' });
	const response = await POST(event);
	const status = response.status;
	const json = await response.json();
	return { status, json, response };
}

test('SoporteFlow — Etapa 5.2A: Endpoint HTTP POST /api/incidents', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;

	const { POST } = await server.ssrLoadModule('/src/routes/api/incidents/+server.ts');

	// --- 1. SETUP TENANTS & USERS ---
	// Organizaciones
	const [orgA] = await db
		.insert(s.organizations)
		.values({ name: 'Org A', slug: 'org-a-' + randomUUID(), status: 'active' })
		.returning();

	const [orgB] = await db
		.insert(s.organizations)
		.values({ name: 'Org B', slug: 'org-b-' + randomUUID(), status: 'active' })
		.returning();

	const [orgSuspended] = await db
		.insert(s.organizations)
		.values({ name: 'Org Suspended', slug: 'org-susp-' + randomUUID(), status: 'suspended' })
		.returning();

	const [orgTrial] = await db
		.insert(s.organizations)
		.values({ name: 'Org Trial', slug: 'org-trial-' + randomUUID(), status: 'trial' })
		.returning();

	// Identidad y membresía para User A (creador autorizado en Org A)
	const userA = await identity(f);
	const [membershipA] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userA.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: membershipA.id,
		permissionId: 'incidents:create'
	});
	const sessionA = await createSession(f, userA.id);

	// Identidad y membresía para User B (creador autorizado en Org B)
	const userB = await identity(f);
	const [membershipB] = await db
		.insert(s.memberships)
		.values({ organizationId: orgB.id, userId: userB.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgB.id,
		membershipId: membershipB.id,
		permissionId: 'incidents:create'
	});
	const sessionB = await createSession(f, userB.id);

	// Usuario con membresía en Org A pero SIN rol/permiso incidents:create
	const userNoRoleA = await identity(f);
	await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userNoRoleA.id, active: true });
	const sessionNoRoleA = await createSession(f, userNoRoleA.id);

	// Usuario con membresía INACTIVA en Org A
	const userInactiveMemA = await identity(f);
	const [memInactiveA] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userInactiveMemA.id, active: false })
		.returning();
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memInactiveA.id,
		permissionId: 'incidents:create'
	});
	const sessionInactiveMemA = await createSession(f, userInactiveMemA.id);

	// Usuario en Org suspendida
	const userSuspended = await identity(f);
	const [memSusp] = await db
		.insert(s.memberships)
		.values({ organizationId: orgSuspended.id, userId: userSuspended.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgSuspended.id,
		membershipId: memSusp.id,
		permissionId: 'incidents:create'
	});
	const sessionSuspended = await createSession(f, userSuspended.id);

	// Usuario en Org trial
	const userTrial = await identity(f);
	const [memTrial] = await db
		.insert(s.memberships)
		.values({ organizationId: orgTrial.id, userId: userTrial.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgTrial.id,
		membershipId: memTrial.id,
		permissionId: 'incidents:create'
	});
	const sessionTrial = await createSession(f, userTrial.id);

	// Cliente corporativo válido en Org A
	const clientUserA = await identity(f);
	await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: clientUserA.id, active: true });

	// Cliente corporativo inactivo en Org A (membresía inactiva)
	const clientUserInactiveA = await identity(f);
	await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: clientUserInactiveA.id, active: false });

	// Cliente corporativo en Org B (cross-tenant para Org A)
	const clientUserB = await identity(f);
	await db
		.insert(s.memberships)
		.values({ organizationId: orgB.id, userId: clientUserB.id, active: true });

	// Sedes
	const [siteA] = await db
		.insert(s.sites)
		.values({ organizationId: orgA.id, name: 'Sede A Principal', active: true })
		.returning();

	const [siteInactiveA] = await db
		.insert(s.sites)
		.values({ organizationId: orgA.id, name: 'Sede A Inactiva', active: false })
		.returning();

	const [siteB] = await db
		.insert(s.sites)
		.values({ organizationId: orgB.id, name: 'Sede B Principal', active: true })
		.returning();

	const basePayloadA = {
		organizationId: orgA.id,
		title: 'Fallo de conectividad en planta',
		description: 'El switch principal no responde al tráfico VLAN 10.',
		client: 'Industrias Acme'
	};

	// =========================================================================
	// AUTHENTICATION (Tests 1 - 4)
	// =========================================================================
	await t.test('1. Sin cookie de sesión -> 401', async () => {
		const res = await callPost(POST, {
			body: basePayloadA,
			headers: {}
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error?.code, 'UNAUTHORIZED');
		assert.equal(res.json.error?.message, 'Authentication required.');
	});

	await t.test('2. Cookie inválida / manipulada -> 401', async () => {
		const res = await callPost(POST, {
			body: basePayloadA,
			headers: { cookie: createTamperedCookie() }
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error?.code, 'UNAUTHORIZED');
		assert.equal(res.json.error?.message, 'Authentication required.');
	});

	await t.test('3. Sesión expirada -> 401', async () => {
		const expiredSession = await createSession(f, userA.id, {
			expiresAt: new Date(Date.now() - 5000)
		});
		const res = await callPost(POST, {
			body: basePayloadA,
			headers: { cookie: expiredSession.cookieHeader }
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error?.code, 'UNAUTHORIZED');
		assert.equal(res.json.error?.message, 'Authentication required.');
	});

	await t.test('4. Usuario desactivado -> 401', async () => {
		const userDeactivated = await identity(f);
		await db
			.insert(s.memberships)
			.values({ organizationId: orgA.id, userId: userDeactivated.id, active: true });
		await grantPermission(f, {
			organizationId: orgA.id,
			membershipId: (
				await db.select().from(s.memberships).where(eq(s.memberships.userId, userDeactivated.id))
			)[0].id,
			permissionId: 'incidents:create'
		});
		const sessionDeactivated = await createSession(f, userDeactivated.id);

		// Desactivar usuario
		await db.update(s.users).set({ active: false }).where(eq(s.users.id, userDeactivated.id));

		const res = await callPost(POST, {
			body: basePayloadA,
			headers: { cookie: sessionDeactivated.cookieHeader }
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error?.code, 'UNAUTHORIZED');
	});

	// =========================================================================
	// AUTHORIZATION (Tests 5 - 9)
	// =========================================================================
	await t.test('5. Usuario sin membresía en organizationId -> 403', async () => {
		// userB está autenticado pero solicita crear en orgA donde no tiene membresía
		const res = await callPost(POST, {
			body: { ...basePayloadA, organizationId: orgA.id },
			headers: { cookie: sessionB.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
		assert.equal(res.json.error?.message, 'Permission denied.');
	});

	await t.test(
		'6. Usuario con membresía pero sin rol ni permiso incidents:create -> 403',
		async () => {
			const res = await callPost(POST, {
				body: basePayloadA,
				headers: { cookie: sessionNoRoleA.cookieHeader }
			});
			assert.equal(res.status, 403);
			assert.equal(res.json.error?.code, 'FORBIDDEN');
			assert.equal(res.json.error?.message, 'Permission denied.');
		}
	);

	await t.test('7. Usuario con permiso en OTRA organización -> 403', async () => {
		// userB tiene permiso en Org B, intenta operar en Org A
		const res = await callPost(POST, {
			body: { ...basePayloadA, organizationId: orgA.id },
			headers: { cookie: sessionB.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
	});

	await t.test('8. Usuario con membresía inactiva -> 403', async () => {
		const res = await callPost(POST, {
			body: basePayloadA,
			headers: { cookie: sessionInactiveMemA.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
	});

	await t.test('9.A Organización suspendida -> 403', async () => {
		const resSuspended = await callPost(POST, {
			body: { ...basePayloadA, organizationId: orgSuspended.id },
			headers: { cookie: sessionSuspended.cookieHeader }
		});
		assert.equal(resSuspended.status, 403);
		assert.equal(resSuspended.json.error?.code, 'FORBIDDEN');
		assert.equal(resSuspended.json.error?.message, 'Permission denied.');
	});

	await t.test('9.B Organización trial (no operativa) -> 403', async () => {
		const resTrial = await callPost(POST, {
			body: { ...basePayloadA, organizationId: orgTrial.id },
			headers: { cookie: sessionTrial.cookieHeader }
		});
		assert.equal(resTrial.status, 403);
		assert.equal(resTrial.json.error?.code, 'FORBIDDEN');
		assert.equal(resTrial.json.error?.message, 'Permission denied.');
	});

	// =========================================================================
	// CREATE (Tests 10 - 15)
	// =========================================================================
	let createdIncidentId = null;

	await t.test('10. Creación básica exitosa (title, description, client) -> 201', async () => {
		const res = await callPost(POST, {
			body: basePayloadA,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 201);
		assert.ok(res.json.incident);
		assert.ok(res.json.history);
		assert.equal(res.json.incident.organizationId, orgA.id);
		assert.equal(res.json.incident.title, basePayloadA.title);
		assert.equal(res.json.incident.description, basePayloadA.description);
		assert.equal(res.json.incident.client, basePayloadA.client);
		assert.equal(res.json.incident.priority, 'medium');

		createdIncidentId = res.json.incident.id;
	});

	await t.test('11. Devuelve incident con status = "open"', async () => {
		// Incluso si el cliente intenta enviar status = 'resolved' en el body
		const res = await callPost(POST, {
			body: { ...basePayloadA, status: 'resolved' },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 201);
		assert.equal(res.json.incident.status, 'open');
	});

	await t.test('12. Devuelve incident_number secuencial', async () => {
		// En los tests 10 y 11 ya se crearon las incidencias #1 y #2 de Org A.
		// Creando una 3ra en Org A:
		const res3 = await callPost(POST, {
			body: { ...basePayloadA, title: 'Incidente 3 de Org A' },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res3.status, 201);
		assert.equal(res3.json.incident.incidentNumber, 3);

		// Primera en Org B debe ser #1:
		const resB1 = await callPost(POST, {
			body: {
				organizationId: orgB.id,
				title: 'Primer incidente Org B',
				description: 'Descripción para Org B',
				client: 'Cliente de Org B'
			},
			headers: { cookie: sessionB.cookieHeader }
		});
		assert.equal(resB1.status, 201);
		assert.equal(resB1.json.incident.incidentNumber, 1);
	});

	await t.test('13. Devuelve registro en incident_history con event_type = "created"', async () => {
		const res = await callPost(POST, {
			body: { ...basePayloadA, title: 'Incidente con auditoría de historial' },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 201);
		const history = res.json.history;
		assert.ok(history);
		assert.equal(history.incidentId, res.json.incident.id);
		assert.equal(history.organizationId, orgA.id);
		assert.equal(history.eventType, 'created');
		assert.equal(history.actorType, 'user');
		assert.equal(history.actorUserId, userA.id);
		assert.equal(history.payload.title, 'Incidente con auditoría de historial');
		assert.equal(history.payload.status, 'open');
		assert.equal(history.payload.incidentNumber, res.json.incident.incidentNumber);
	});

	await t.test('14. creatorUserId proviene exclusivamente de la sesión (no del body)', async () => {
		// Intentar suplantar creador pasando IDs ajenos en el body
		const spoofedUserId = userB.id;
		const res = await callPost(POST, {
			body: {
				...basePayloadA,
				creatorUserId: spoofedUserId,
				createdByUserId: spoofedUserId,
				userId: spoofedUserId
			},
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 201);
		// El creador registrado DEBE ser userA (de la sesión), NUNCA el del body
		assert.equal(res.json.incident.createdByUserId, userA.id);
		assert.notEqual(res.json.incident.createdByUserId, spoofedUserId);
		assert.equal(res.json.history.actorUserId, userA.id);

		// Verificación directa en base de datos: el registro persistido tiene userA.id
		const [persistedIncident] = await db
			.select()
			.from(s.incidents)
			.where(eq(s.incidents.id, res.json.incident.id));
		assert.ok(persistedIncident);
		assert.equal(persistedIncident.createdByUserId, userA.id);
		assert.notEqual(persistedIncident.createdByUserId, spoofedUserId);
	});

	await t.test(
		'15. organizationId proviene exclusivamente del body (no de headers ni query)',
		async () => {
			// Pasar query y header contradictorios apuntando a Org B, pero body apunta a Org A
			const res = await callPost(POST, {
				body: { ...basePayloadA, organizationId: orgA.id },
				headers: {
					cookie: sessionA.cookieHeader,
					'x-organization-id': orgB.id
				},
				url: `http://localhost/api/incidents?organizationId=${orgB.id}`
			});
			assert.equal(res.status, 201);
			assert.equal(res.json.incident.organizationId, orgA.id);

			// Si no viene en el body, aunque venga en header o query, debe fallar con 400
			const bodyWithoutOrg = {
				title: basePayloadA.title,
				description: basePayloadA.description,
				client: basePayloadA.client
			};
			const resMissing = await callPost(POST, {
				body: bodyWithoutOrg,
				headers: {
					cookie: sessionA.cookieHeader,
					'x-organization-id': orgA.id
				},
				url: `http://localhost/api/incidents?organizationId=${orgA.id}`
			});
			assert.equal(resMissing.status, 400);
			assert.equal(resMissing.json.error?.code, 'INVALID_INPUT');
		}
	);

	// =========================================================================
	// INPUT (Tests 16 - 20)
	// =========================================================================
	await t.test('16. Body JSON malformado -> 400', async () => {
		const resMalformed = await callPost(POST, {
			rawBody: '{"invalid": json missing quote}',
			headers: { cookie: sessionA.cookieHeader, 'content-type': 'application/json' }
		});
		assert.equal(resMalformed.status, 400);
		assert.equal(resMalformed.json.error?.code, 'INVALID_INPUT');
		assert.equal(resMalformed.json.error?.message, 'Invalid request body.');

		// Body no objeto (p.ej. null o array)
		const resArray = await callPost(POST, {
			rawBody: '[]',
			headers: { cookie: sessionA.cookieHeader, 'content-type': 'application/json' }
		});
		assert.equal(resArray.status, 400);
		assert.equal(resArray.json.error?.code, 'INVALID_INPUT');
	});

	await t.test('17. Falta organizationId o no es UUID -> 400', async () => {
		// Falta organizationId
		const resMissing = await callPost(POST, {
			body: { title: 'T', description: 'D', client: 'C' },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resMissing.status, 400);
		assert.equal(resMissing.json.error?.code, 'INVALID_INPUT');

		// organizationId no es UUID
		const resInvalid = await callPost(POST, {
			body: { ...basePayloadA, organizationId: 'not-a-valid-uuid' },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resInvalid.status, 400);
		assert.equal(resInvalid.json.error?.code, 'INVALID_INPUT');
	});

	await t.test('18. Falta title o vacío -> 400', async () => {
		// title ausente
		const resMissing = await callPost(POST, {
			body: { organizationId: orgA.id, description: 'D', client: 'C' },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resMissing.status, 400);
		assert.equal(resMissing.json.error?.code, 'INVALID_INPUT');

		// title cadena vacía / espacios
		const resEmpty = await callPost(POST, {
			body: { ...basePayloadA, title: '    ' },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resEmpty.status, 400);
		assert.equal(resEmpty.json.error?.code, 'INVALID_INPUT');
	});

	await t.test('19. Falta description o vacío -> 400', async () => {
		// description ausente
		const resMissing = await callPost(POST, {
			body: { organizationId: orgA.id, title: 'T', client: 'C' },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resMissing.status, 400);
		assert.equal(resMissing.json.error?.code, 'INVALID_INPUT');

		// description vacía
		const resEmpty = await callPost(POST, {
			body: { ...basePayloadA, description: '' },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resEmpty.status, 400);
		assert.equal(resEmpty.json.error?.code, 'INVALID_INPUT');
	});

	await t.test('20. Falta client o vacío -> 400', async () => {
		// client ausente
		const resMissing = await callPost(POST, {
			body: { organizationId: orgA.id, title: 'T', description: 'D' },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resMissing.status, 400);
		assert.equal(resMissing.json.error?.code, 'INVALID_INPUT');

		// client vacío
		const resEmpty = await callPost(POST, {
			body: { ...basePayloadA, client: '   ' },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resEmpty.status, 400);
		assert.equal(resEmpty.json.error?.code, 'INVALID_INPUT');
	});

	// =========================================================================
	// TENANT / REFERENCIAS (Tests 21 - 26)
	// =========================================================================
	await t.test('21. clientUserId válido de la misma organización -> 201', async () => {
		const res = await callPost(POST, {
			body: { ...basePayloadA, clientUserId: clientUserA.id },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 201);
		assert.equal(res.json.incident.clientUserId, clientUserA.id);
		assert.equal(res.json.history.payload.clientUserId, clientUserA.id);
	});

	await t.test(
		'22. clientUserId cross-tenant vs inexistente son indistinguibles -> 404',
		async () => {
			const nonexistentClientUserId = randomUUID();
			const resCrossTenant = await callPost(POST, {
				body: { ...basePayloadA, clientUserId: clientUserB.id },
				headers: { cookie: sessionA.cookieHeader }
			});
			const resNonexistent = await callPost(POST, {
				body: { ...basePayloadA, clientUserId: nonexistentClientUserId },
				headers: { cookie: sessionA.cookieHeader }
			});

			// Mismo status HTTP (404)
			assert.equal(resCrossTenant.status, 404);
			assert.equal(resNonexistent.status, 404);

			// Mismo error.code
			assert.equal(resCrossTenant.json.error?.code, 'CLIENT_USER_MEMBERSHIP_NOT_FOUND');
			assert.equal(resNonexistent.json.error?.code, 'CLIENT_USER_MEMBERSHIP_NOT_FOUND');

			// Mismo error.message
			assert.equal(
				resCrossTenant.json.error?.message,
				'Client user has no membership in this organization'
			);
			assert.equal(
				resNonexistent.json.error?.message,
				'Client user has no membership in this organization'
			);

			// Misma estructura JSON completa
			assert.deepEqual(resCrossTenant.json, resNonexistent.json);
			assert.deepEqual(Object.keys(resCrossTenant.json), ['error']);
			assert.deepEqual(Object.keys(resCrossTenant.json.error).sort(), ['code', 'message'].sort());
		}
	);

	await t.test('23. clientUserId inactivo -> 409', async () => {
		const res = await callPost(POST, {
			body: { ...basePayloadA, clientUserId: clientUserInactiveA.id },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 409);
		assert.equal(res.json.error?.code, 'CLIENT_USER_INACTIVE');
	});

	await t.test('24. siteId válido de la misma organización -> 201', async () => {
		const res = await callPost(POST, {
			body: { ...basePayloadA, siteId: siteA.id },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 201);
		assert.equal(res.json.incident.siteId, siteA.id);
		assert.equal(res.json.history.payload.siteId, siteA.id);
	});

	await t.test('25. siteId cross-tenant vs inexistente son indistinguibles -> 404', async () => {
		const nonexistentSiteId = randomUUID();
		const resCrossTenant = await callPost(POST, {
			body: { ...basePayloadA, siteId: siteB.id },
			headers: { cookie: sessionA.cookieHeader }
		});
		const resNonexistent = await callPost(POST, {
			body: { ...basePayloadA, siteId: nonexistentSiteId },
			headers: { cookie: sessionA.cookieHeader }
		});

		// Mismo status HTTP (404)
		assert.equal(resCrossTenant.status, 404);
		assert.equal(resNonexistent.status, 404);

		// Mismo error.code
		assert.equal(resCrossTenant.json.error?.code, 'SITE_NOT_FOUND');
		assert.equal(resNonexistent.json.error?.code, 'SITE_NOT_FOUND');

		// Mismo error.message
		assert.equal(
			resCrossTenant.json.error?.message,
			'Site does not exist or belongs to another organization'
		);
		assert.equal(
			resNonexistent.json.error?.message,
			'Site does not exist or belongs to another organization'
		);

		// Misma estructura JSON completa
		assert.deepEqual(resCrossTenant.json, resNonexistent.json);
		assert.deepEqual(Object.keys(resCrossTenant.json), ['error']);
		assert.deepEqual(Object.keys(resCrossTenant.json.error).sort(), ['code', 'message'].sort());
	});

	await t.test('26. siteId inactivo -> 409', async () => {
		const res = await callPost(POST, {
			body: { ...basePayloadA, siteId: siteInactiveA.id },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 409);
		assert.equal(res.json.error?.code, 'SITE_INACTIVE');
	});

	// =========================================================================
	// PERSISTENCIA
	// =========================================================================
	await t.test('Persistencia: incidente, contador incrementado e historial en DB', async () => {
		// Verificar existencia en tabla incidents
		const [persistedIncident] = await db
			.select()
			.from(s.incidents)
			.where(eq(s.incidents.id, createdIncidentId));

		assert.ok(persistedIncident);
		assert.equal(persistedIncident.organizationId, orgA.id);
		assert.equal(persistedIncident.title, basePayloadA.title);
		assert.equal(persistedIncident.status, 'open');
		assert.equal(persistedIncident.createdByUserId, userA.id);

		// Verificar que el contador en organization_counters refleja las creaciones en Org A
		const [counterA] = await db
			.select()
			.from(s.organizationCounters)
			.where(eq(s.organizationCounters.organizationId, orgA.id));

		assert.ok(counterA);
		assert.ok(counterA.lastIncidentNumber >= 1);

		// Verificar que existe el registro correspondiente en incident_history
		const [persistedHistory] = await db
			.select()
			.from(s.incidentHistory)
			.where(eq(s.incidentHistory.incidentId, createdIncidentId));

		assert.ok(persistedHistory);
		assert.equal(persistedHistory.eventType, 'created');
		assert.equal(persistedHistory.actorUserId, userA.id);
		assert.equal(persistedHistory.organizationId, orgA.id);
	});
});

test('SoporteFlow — Etapa 5.2B: Endpoint HTTP GET /api/incidents', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;

	const { GET } = await server.ssrLoadModule('/src/routes/api/incidents/+server.ts');
	const { createIncidentRecord } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);

	// 1. Organizaciones
	const [orgA] = await db
		.insert(s.organizations)
		.values({ name: 'Org A (GET)', slug: 'org-a-get-' + randomUUID(), status: 'active' })
		.returning();

	const [orgB] = await db
		.insert(s.organizations)
		.values({ name: 'Org B (GET)', slug: 'org-b-get-' + randomUUID(), status: 'active' })
		.returning();

	const [orgSuspended] = await db
		.insert(s.organizations)
		.values({
			name: 'Org Suspended (GET)',
			slug: 'org-susp-get-' + randomUUID(),
			status: 'suspended'
		})
		.returning();

	const [orgTrial] = await db
		.insert(s.organizations)
		.values({ name: 'Org Trial (GET)', slug: 'org-trial-get-' + randomUUID(), status: 'trial' })
		.returning();

	// 2. Sedes
	const [siteA1] = await db
		.insert(s.sites)
		.values({ organizationId: orgA.id, name: 'Sede A1', active: true })
		.returning();

	const [siteA2] = await db
		.insert(s.sites)
		.values({ organizationId: orgA.id, name: 'Sede A2', active: true })
		.returning();

	const [siteB1] = await db
		.insert(s.sites)
		.values({ organizationId: orgB.id, name: 'Sede B1', active: true })
		.returning();

	// 3. Usuarios, Memberships y Permisos
	// User A: Autorizado con incidents:view_all e incidents:create en Org A
	const userA = await identity(f);
	const [membershipA] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userA.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: membershipA.id,
		permissionId: 'incidents:view_all'
	});
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: membershipA.id,
		permissionId: 'incidents:create'
	});
	const sessionA = await createSession(f, userA.id);

	// User B: Autorizado con incidents:view_all e incidents:create en Org B
	const userB = await identity(f);
	const [membershipB] = await db
		.insert(s.memberships)
		.values({ organizationId: orgB.id, userId: userB.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgB.id,
		membershipId: membershipB.id,
		permissionId: 'incidents:view_all'
	});
	await grantPermission(f, {
		organizationId: orgB.id,
		membershipId: membershipB.id,
		permissionId: 'incidents:create'
	});
	const sessionB = await createSession(f, userB.id);

	// User No Perm A: Pertenencia activa en Org A pero SIN incidents:view_all
	const userNoPermA = await identity(f);
	await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userNoPermA.id, active: true });
	const sessionNoPermA = await createSession(f, userNoPermA.id);

	// User Inactive Membership A: Pertenencia inactiva en Org A con incidents:view_all asignado
	const userInactiveMemA = await identity(f);
	const [memInactiveA] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userInactiveMemA.id, active: false })
		.returning();
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memInactiveA.id,
		permissionId: 'incidents:view_all'
	});
	const sessionInactiveMemA = await createSession(f, userInactiveMemA.id);

	// User en Organización Suspendida con incidents:view_all
	const userSuspended = await identity(f);
	const [memSusp] = await db
		.insert(s.memberships)
		.values({ organizationId: orgSuspended.id, userId: userSuspended.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgSuspended.id,
		membershipId: memSusp.id,
		permissionId: 'incidents:view_all'
	});
	const sessionSuspended = await createSession(f, userSuspended.id);

	// User en Organización Trial con incidents:view_all
	const userTrial = await identity(f);
	const [memTrial] = await db
		.insert(s.memberships)
		.values({ organizationId: orgTrial.id, userId: userTrial.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgTrial.id,
		membershipId: memTrial.id,
		permissionId: 'incidents:view_all'
	});
	const sessionTrial = await createSession(f, userTrial.id);

	// 4. Sembrado de Incidencias
	// Org A: 4 incidencias con variedad de status, prioridades y sedes
	const incA1 = (
		await createIncidentRecord(
			db,
			{ organizationId: orgA.id, creatorUserId: userA.id },
			{
				title: 'Incidente A1 Red',
				description: 'Fallo en switch principal',
				client: 'Cliente Alpha',
				priority: 'high',
				siteId: siteA1.id
			}
		)
	).incident;

	const incA2Created = (
		await createIncidentRecord(
			db,
			{ organizationId: orgA.id, creatorUserId: userA.id },
			{
				title: 'Incidente A2 Servidor',
				description: 'Memoria al 95%',
				client: 'Cliente Alpha',
				priority: 'medium',
				siteId: siteA1.id
			}
		)
	).incident;
	const [incA2] = await db
		.update(s.incidents)
		.set({ status: 'pending' })
		.where(eq(s.incidents.id, incA2Created.id))
		.returning();

	const incA3Created = (
		await createIncidentRecord(
			db,
			{ organizationId: orgA.id, creatorUserId: userA.id },
			{
				title: 'Incidente A3 Router',
				description: 'Caída de fibra óptica',
				client: 'Cliente Alpha',
				priority: 'urgent',
				siteId: siteA2.id
			}
		)
	).incident;
	const [incA3] = await db
		.update(s.incidents)
		.set({ status: 'resolved' })
		.where(eq(s.incidents.id, incA3Created.id))
		.returning();

	const incA4Created = (
		await createIncidentRecord(
			db,
			{ organizationId: orgA.id, creatorUserId: userA.id },
			{
				title: 'Incidente A4 Impresora',
				description: 'Atasco de papel',
				client: 'Cliente Alpha',
				priority: 'low',
				siteId: null
			}
		)
	).incident;
	const [incA4] = await db
		.update(s.incidents)
		.set({ status: 'closed' })
		.where(eq(s.incidents.id, incA4Created.id))
		.returning();

	// Org B: 2 incidencias (incidentNumber 1 y 2) para verificar aislamiento
	const incB1 = (
		await createIncidentRecord(
			db,
			{ organizationId: orgB.id, creatorUserId: userB.id },
			{
				title: 'Incidente B1 Base de Datos',
				description: 'Bloqueo de tablas',
				client: 'Cliente Beta',
				priority: 'high',
				siteId: siteB1.id
			}
		)
	).incident;

	const incB2Created = (
		await createIncidentRecord(
			db,
			{ organizationId: orgB.id, creatorUserId: userB.id },
			{
				title: 'Incidente B2 Firewall',
				description: 'Regla bloqueando tráfico',
				client: 'Cliente Beta',
				priority: 'low',
				siteId: siteB1.id
			}
		)
	).incident;
	await db
		.update(s.incidents)
		.set({ status: 'resolved' })
		.where(eq(s.incidents.id, incB2Created.id));

	// =========================================================================
	// AUTHENTICATION (Tests 1 - 3)
	// =========================================================================
	await t.test('1. GET sin cookie → 401', async () => {
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}`,
			headers: {}
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error?.code, 'UNAUTHORIZED');
		assert.equal(res.json.error?.message, 'Authentication required.');
	});

	await t.test('2. GET con sesión inválida/expirada → 401', async () => {
		// Cookie manipulada
		const resTampered = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}`,
			headers: { cookie: createTamperedCookie() }
		});
		assert.equal(resTampered.status, 401);
		assert.equal(resTampered.json.error?.code, 'UNAUTHORIZED');

		// Sesión expirada
		const expired = await createSession(f, userA.id, {
			expiresAt: new Date(Date.now() - 5000)
		});
		const resExpired = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}`,
			headers: { cookie: expired.cookieHeader }
		});
		assert.equal(resExpired.status, 401);
		assert.equal(resExpired.json.error?.code, 'UNAUTHORIZED');
	});

	await t.test('3. usuario inactive → 401', async () => {
		const userDeactivated = await identity(f);
		await db
			.insert(s.memberships)
			.values({ organizationId: orgA.id, userId: userDeactivated.id, active: true });
		await grantPermission(f, {
			organizationId: orgA.id,
			membershipId: (
				await db.select().from(s.memberships).where(eq(s.memberships.userId, userDeactivated.id))
			)[0].id,
			permissionId: 'incidents:view_all'
		});
		const sessionDeactivated = await createSession(f, userDeactivated.id);

		// Desactivar usuario globalmente
		await db.update(s.users).set({ active: false }).where(eq(s.users.id, userDeactivated.id));

		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}`,
			headers: { cookie: sessionDeactivated.cookieHeader }
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error?.code, 'UNAUTHORIZED');
	});

	// =========================================================================
	// AUTHORIZATION (Tests 4 - 9)
	// =========================================================================
	await t.test('4. usuario sin membership → 403', async () => {
		// userB está autenticado pero solicita listar orgA donde no tiene membresía
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}`,
			headers: { cookie: sessionB.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
		assert.equal(res.json.error?.message, 'Permission denied.');
	});

	await t.test('5. membership inactive → 403', async () => {
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}`,
			headers: { cookie: sessionInactiveMemA.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
		assert.equal(res.json.error?.message, 'Permission denied.');
	});

	await t.test('6. organization suspended → 403', async () => {
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgSuspended.id}`,
			headers: { cookie: sessionSuspended.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
		assert.equal(res.json.error?.message, 'Permission denied.');
	});

	await t.test('7. organization trial → 403', async () => {
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgTrial.id}`,
			headers: { cookie: sessionTrial.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
		assert.equal(res.json.error?.message, 'Permission denied.');
	});

	await t.test('8. membership válida sin incidents:view_all → 403', async () => {
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}`,
			headers: { cookie: sessionNoPermA.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
		assert.equal(res.json.error?.message, 'Permission denied.');
	});

	await t.test('9. usuario con incidents:view_all en otra organización → 403', async () => {
		// userB tiene incidents:view_all en Org B, intenta listar Org A
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}`,
			headers: { cookie: sessionB.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
		assert.equal(res.json.error?.message, 'Permission denied.');
	});

	// =========================================================================
	// INPUT (Tests 10 - 14)
	// =========================================================================
	await t.test('10. organizationId ausente → 400', async () => {
		const res = await callGet(GET, {
			url: 'http://localhost/api/incidents',
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
		assert.equal(res.json.error?.message, 'organizationId must be a valid UUID.');
	});

	await t.test('11. organizationId inválido → 400', async () => {
		const res = await callGet(GET, {
			url: 'http://localhost/api/incidents?organizationId=not-a-valid-uuid',
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
		assert.equal(res.json.error?.message, 'organizationId must be a valid UUID.');
	});

	await t.test('12. status inválido → 400', async () => {
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}&status=invalid_status`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
		assert.ok(res.json.error?.message.includes('invalid status filter'));
	});

	await t.test('13. priority inválida → 400', async () => {
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}&priority=critical_unknown`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
		assert.ok(res.json.error?.message.includes('invalid priority filter'));
	});

	await t.test('14. siteId no UUID → 400', async () => {
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}&siteId=not-a-valid-uuid`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
		assert.ok(res.json.error?.message.includes('siteId filter must be a valid UUID'));
	});

	// =========================================================================
	// LIST (Tests 15 - 23)
	// =========================================================================
	await t.test('15. listado válido → 200', async () => {
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		assert.ok(Array.isArray(res.json.incidents));
	});

	await t.test('16. devuelve únicamente incidencias de la organización solicitada', async () => {
		const resA = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resA.status, 200);
		assert.ok(resA.json.incidents.length > 0);
		for (const incident of resA.json.incidents) {
			assert.equal(incident.organizationId, orgA.id);
			assert.notEqual(incident.organizationId, orgB.id);
		}
	});

	await t.test(
		'17. no filtra accidentalmente incidencias de otro tenant aunque tengan mismo incident_number',
		async () => {
			// incA1 e incB1 tienen ambos incidentNumber === 1
			assert.equal(incA1.incidentNumber, 1);
			assert.equal(incB1.incidentNumber, 1);

			// Listar Org A contiene incA1 pero no incB1
			const resA = await callGet(GET, {
				url: `http://localhost/api/incidents?organizationId=${orgA.id}`,
				headers: { cookie: sessionA.cookieHeader }
			});
			assert.equal(resA.status, 200);
			const idsInA = resA.json.incidents.map((i) => i.id);
			assert.ok(idsInA.includes(incA1.id));
			assert.ok(!idsInA.includes(incB1.id));

			// Listar Org B contiene incB1 pero no incA1
			const resB = await callGet(GET, {
				url: `http://localhost/api/incidents?organizationId=${orgB.id}`,
				headers: { cookie: sessionB.cookieHeader }
			});
			assert.equal(resB.status, 200);
			const idsInB = resB.json.incidents.map((i) => i.id);
			assert.ok(idsInB.includes(incB1.id));
			assert.ok(!idsInB.includes(incA1.id));
		}
	);

	await t.test(
		'18. orden estable coincide con listIncidents (createdAt DESC, incidentNumber DESC)',
		async () => {
			const res = await callGet(GET, {
				url: `http://localhost/api/incidents?organizationId=${orgA.id}`,
				headers: { cookie: sessionA.cookieHeader }
			});
			assert.equal(res.status, 200);
			const ids = res.json.incidents.map((i) => i.id);
			assert.deepEqual(ids, [incA4.id, incA3.id, incA2.id, incA1.id]);
		}
	);

	await t.test('19. filtro status funciona', async () => {
		// status = 'open' -> incA1
		const resOpen = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}&status=open`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resOpen.status, 200);
		assert.equal(resOpen.json.incidents.length, 1);
		assert.equal(resOpen.json.incidents[0].id, incA1.id);
		assert.equal(resOpen.json.incidents[0].status, 'open');

		// status = 'pending' -> incA2
		const resPending = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}&status=pending`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resPending.status, 200);
		assert.equal(resPending.json.incidents.length, 1);
		assert.equal(resPending.json.incidents[0].id, incA2.id);

		// status = 'resolved' -> incA3
		const resResolved = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}&status=resolved`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resResolved.status, 200);
		assert.equal(resResolved.json.incidents.length, 1);
		assert.equal(resResolved.json.incidents[0].id, incA3.id);

		// status = 'closed' -> incA4
		const resClosed = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}&status=closed`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resClosed.status, 200);
		assert.equal(resClosed.json.incidents.length, 1);
		assert.equal(resClosed.json.incidents[0].id, incA4.id);
	});

	await t.test('20. filtro priority funciona', async () => {
		// priority = 'high' -> incA1
		const resHigh = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}&priority=high`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resHigh.status, 200);
		assert.equal(resHigh.json.incidents.length, 1);
		assert.equal(resHigh.json.incidents[0].id, incA1.id);
		assert.equal(resHigh.json.incidents[0].priority, 'high');

		// priority = 'medium' -> incA2
		const resMedium = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}&priority=medium`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resMedium.status, 200);
		assert.equal(resMedium.json.incidents.length, 1);
		assert.equal(resMedium.json.incidents[0].id, incA2.id);

		// priority = 'urgent' -> incA3
		const resUrgent = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}&priority=urgent`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resUrgent.status, 200);
		assert.equal(resUrgent.json.incidents.length, 1);
		assert.equal(resUrgent.json.incidents[0].id, incA3.id);

		// priority = 'low' -> incA4
		const resLow = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}&priority=low`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resLow.status, 200);
		assert.equal(resLow.json.incidents.length, 1);
		assert.equal(resLow.json.incidents[0].id, incA4.id);
	});

	await t.test('21. filtro siteId funciona', async () => {
		// siteId = siteA1.id -> incA2 e incA1
		const resSite1 = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}&siteId=${siteA1.id}`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resSite1.status, 200);
		assert.equal(resSite1.json.incidents.length, 2);
		const ids1 = resSite1.json.incidents.map((i) => i.id);
		assert.deepEqual(ids1, [incA2.id, incA1.id]);

		// siteId = siteA2.id -> incA3
		const resSite2 = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}&siteId=${siteA2.id}`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resSite2.status, 200);
		assert.equal(resSite2.json.incidents.length, 1);
		assert.equal(resSite2.json.incidents[0].id, incA3.id);
	});

	await t.test('22. combinación de filtros funciona', async () => {
		// status = 'pending' & priority = 'medium' & siteId = siteA1.id -> incA2
		const resComb = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}&status=pending&priority=medium&siteId=${siteA1.id}`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resComb.status, 200);
		assert.equal(resComb.json.incidents.length, 1);
		assert.equal(resComb.json.incidents[0].id, incA2.id);

		// Combinación sin resultados (status 'closed' con prioridad 'urgent')
		const resEmpty = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}&status=closed&priority=urgent`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resEmpty.status, 200);
		assert.equal(resEmpty.json.incidents.length, 0);
	});

	await t.test('23. sin filtros opcionales devuelve todas las incidencias del tenant', async () => {
		// Org A tiene 4 incidencias
		const resA = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgA.id}`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(resA.status, 200);
		assert.equal(resA.json.incidents.length, 4);

		// Org B tiene 2 incidencias
		const resB = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgB.id}`,
			headers: { cookie: sessionB.cookieHeader }
		});
		assert.equal(resB.status, 200);
		assert.equal(resB.json.incidents.length, 2);
	});

	// =========================================================================
	// SEGURIDAD (Tests 24 - 27)
	// =========================================================================
	await t.test('24. organizationId enviado en header pero no query → 400', async () => {
		const res = await callGet(GET, {
			url: 'http://localhost/api/incidents',
			headers: {
				cookie: sessionA.cookieHeader,
				'x-organization-id': orgA.id
			}
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
		assert.equal(res.json.error?.message, 'organizationId must be a valid UUID.');
	});

	await t.test(
		'25. organizationId de query prevalece y no se sustituye por ningún header',
		async () => {
			// Query tiene Org A (donde userA está autorizado), Header tiene Org B (donde userA NO está autorizado)
			const res = await callGet(GET, {
				url: `http://localhost/api/incidents?organizationId=${orgA.id}`,
				headers: {
					cookie: sessionA.cookieHeader,
					'x-organization-id': orgB.id
				}
			});
			assert.equal(res.status, 200);
			assert.ok(res.json.incidents.length > 0);
			for (const incident of res.json.incidents) {
				assert.equal(incident.organizationId, orgA.id);
			}
		}
	);

	await t.test('26. usuario autorizado en org A no puede listar org B', async () => {
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgB.id}`,
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
		assert.equal(res.json.error?.message, 'Permission denied.');
	});

	await t.test(
		'27. respuesta no incluye datos de membership, roles, permisos ni sesión',
		async () => {
			const res = await callGet(GET, {
				url: `http://localhost/api/incidents?organizationId=${orgA.id}`,
				headers: { cookie: sessionA.cookieHeader }
			});
			assert.equal(res.status, 200);
			assert.deepEqual(Object.keys(res.json), ['incidents']);

			const allowedKeys = new Set([
				'id',
				'organizationId',
				'incidentNumber',
				'title',
				'description',
				'status',
				'priority',
				'client',
				'clientUserId',
				'createdByUserId',
				'siteId',
				'assignedToUserId',
				'createdAt',
				'updatedAt'
			]);

			for (const incident of res.json.incidents) {
				assert.equal('membership' in incident, false);
				assert.equal('memberships' in incident, false);
				assert.equal('role' in incident, false);
				assert.equal('roles' in incident, false);
				assert.equal('permissions' in incident, false);
				assert.equal('session' in incident, false);
				assert.equal('token' in incident, false);

				for (const key of Object.keys(incident)) {
					assert.ok(
						allowedKeys.has(key),
						`Campo inesperado '${key}' retornado en objeto de incidencia`
					);
				}
			}
		}
	);

	await t.test(
		'28. parámetros de query desconocidos no alteran el comportamiento ni los filtros',
		async () => {
			const res = await callGet(GET, {
				url: `http://localhost/api/incidents?organizationId=${orgA.id}&page=2&search=hack&sort=desc&limit=100`,
				headers: { cookie: sessionA.cookieHeader }
			});
			assert.equal(res.status, 200);
			assert.equal(res.json.incidents.length, 4);
			const ids = res.json.incidents.map((i) => i.id);
			assert.deepEqual(ids, [incA4.id, incA3.id, incA2.id, incA1.id]);
		}
	);
});

test('SoporteFlow — Etapa 5.2C: Endpoint HTTP GET /api/incidents/[id]', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;

	const { GET } = await server.ssrLoadModule('/src/routes/api/incidents/[id]/+server.ts');
	const { createIncidentRecord } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);

	// --- SETUP TENANTS & USERS ---
	const [orgA] = await db
		.insert(s.organizations)
		.values({ name: 'Org A Detail', slug: 'org-a-det-' + randomUUID(), status: 'active' })
		.returning();

	const [orgB] = await db
		.insert(s.organizations)
		.values({ name: 'Org B Detail', slug: 'org-b-det-' + randomUUID(), status: 'active' })
		.returning();

	const [orgSuspended] = await db
		.insert(s.organizations)
		.values({
			name: 'Org Suspended Detail',
			slug: 'org-susp-det-' + randomUUID(),
			status: 'suspended'
		})
		.returning();

	const [orgTrial] = await db
		.insert(s.organizations)
		.values({ name: 'Org Trial Detail', slug: 'org-trial-det-' + randomUUID(), status: 'trial' })
		.returning();

	// User A - Authorized in Org A with incidents:view_all
	const userA = await identity(f);
	const [membershipA] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userA.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: membershipA.id,
		permissionId: 'incidents:view_all'
	});
	const sessionA = await createSession(f, userA.id);

	// User B - Authorized in Org B with incidents:view_all
	const userB = await identity(f);
	const [membershipB] = await db
		.insert(s.memberships)
		.values({ organizationId: orgB.id, userId: userB.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgB.id,
		membershipId: membershipB.id,
		permissionId: 'incidents:view_all'
	});
	const sessionB = await createSession(f, userB.id);

	// User without incidents:view_all in Org A
	const userNoPermA = await identity(f);
	await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userNoPermA.id, active: true });
	const sessionNoPermA = await createSession(f, userNoPermA.id);

	// User with inactive membership in Org A
	const userInactiveMemA = await identity(f);
	const [memInactiveA] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userInactiveMemA.id, active: false })
		.returning();
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memInactiveA.id,
		permissionId: 'incidents:view_all'
	});
	const sessionInactiveMemA = await createSession(f, userInactiveMemA.id);

	// User in suspended org
	const userSuspended = await identity(f);
	const [memSusp] = await db
		.insert(s.memberships)
		.values({ organizationId: orgSuspended.id, userId: userSuspended.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgSuspended.id,
		membershipId: memSusp.id,
		permissionId: 'incidents:view_all'
	});
	const sessionSuspended = await createSession(f, userSuspended.id);

	// User in trial org
	const userTrial = await identity(f);
	const [memTrial] = await db
		.insert(s.memberships)
		.values({ organizationId: orgTrial.id, userId: userTrial.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgTrial.id,
		membershipId: memTrial.id,
		permissionId: 'incidents:view_all'
	});
	const sessionTrial = await createSession(f, userTrial.id);

	// User inactive
	const userInactive = await identity(f);
	const [memInactiveUserA] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userInactive.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memInactiveUserA.id,
		permissionId: 'incidents:view_all'
	});
	const sessionInactive = await createSession(f, userInactive.id);
	await db.update(s.users).set({ active: false }).where(eq(s.users.id, userInactive.id));

	// Expired session
	const sessionExpired = await createSession(f, userA.id, {
		expiresAt: new Date(Date.now() - 3600 * 1000)
	});

	// --- SETUP INCIDENTS ---
	// Incident Org A
	const incA1Created = (
		await createIncidentRecord(
			db,
			{ organizationId: orgA.id, creatorUserId: userA.id },
			{
				title: 'Incidente A1 Detalle',
				description: 'Descripción detallada de prueba para A1',
				client: 'Cliente Alpha Detalle',
				priority: 'high'
			}
		)
	).incident;

	// Incident Org B
	const incB1Created = (
		await createIncidentRecord(
			db,
			{ organizationId: orgB.id, creatorUserId: userB.id },
			{
				title: 'Incidente B1 Detalle',
				description: 'Descripción detallada de prueba para B1',
				client: 'Cliente Beta Detalle',
				priority: 'medium'
			}
		)
	).incident;

	// Add additional history events to incA1 for history order testing
	const baseTime = incA1Created.createdAt.getTime();
	const event2Id = randomUUID();
	const event3Id = randomUUID();

	await db.insert(s.incidentHistory).values([
		{
			id: event2Id,
			incidentId: incA1Created.id,
			organizationId: orgA.id,
			eventType: 'internal_note_added',
			actorType: 'user',
			actorUserId: userA.id,
			comment: 'Primera nota adicional',
			createdAt: new Date(baseTime + 10000)
		},
		{
			id: event3Id,
			incidentId: incA1Created.id,
			organizationId: orgA.id,
			eventType: 'priority_changed',
			actorType: 'user',
			actorUserId: userA.id,
			comment: 'Escalada de prioridad',
			createdAt: new Date(baseTime + 20000)
		}
	]);

	// =========================================================================
	// AUTHENTICATION (Tests 1 - 3)
	// =========================================================================
	await t.test('1. detalle sin cookie → 401', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: {}
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error?.code, 'UNAUTHORIZED');
	});

	await t.test('2. sesión inválida/expirada → 401', async () => {
		// Tampered cookie
		const resTampered = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: createTamperedCookie('invalid-token') }
		});
		assert.equal(resTampered.status, 401);
		assert.equal(resTampered.json.error?.code, 'UNAUTHORIZED');

		// Expired session
		const resExpired = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionExpired.cookieHeader }
		});
		assert.equal(resExpired.status, 401);
		assert.equal(resExpired.json.error?.code, 'UNAUTHORIZED');
	});

	await t.test('3. usuario inactive → 401', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionInactive.cookieHeader }
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error?.code, 'UNAUTHORIZED');
	});

	// =========================================================================
	// AUTHORIZATION (Tests 4 - 9)
	// =========================================================================
	await t.test('4. usuario sin membership → 403', async () => {
		const userOutside = await identity(f);
		const sessionOutside = await createSession(f, userOutside.id);

		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionOutside.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
	});

	await t.test('5. membership inactive → 403', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionInactiveMemA.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
	});

	await t.test('6. organization suspended → 403', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgSuspended.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionSuspended.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
	});

	await t.test('7. organization trial → 403', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgTrial.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionTrial.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
	});

	await t.test('8. sin incidents:view_all → 403', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionNoPermA.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
	});

	await t.test('9. incidents:view_all solo en otra org → 403', async () => {
		// User B has incidents:view_all in Org B, but queries Org A
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionB.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
	});

	// =========================================================================
	// INPUT (Tests 10 - 12)
	// =========================================================================
	await t.test('10. organizationId ausente → 400', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
	});

	await t.test('11. organizationId inválido → 400', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=not-a-uuid`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
	});

	await t.test('12. incident id inválido → 400', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/not-a-uuid?organizationId=${orgA.id}`,
			params: { id: 'not-a-uuid' },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
	});

	// =========================================================================
	// DETAIL (Tests 13 - 17)
	// =========================================================================
	await t.test('13. incidencia existente del tenant → 200', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
	});

	await t.test('14. devuelve incident correcto', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		assert.ok(res.json.incident);
		assert.equal(res.json.incident.id, incA1Created.id);
		assert.equal(res.json.incident.organizationId, orgA.id);
		assert.equal(res.json.incident.title, 'Incidente A1 Detalle');
		assert.equal(res.json.incident.description, 'Descripción detallada de prueba para A1');
		assert.equal(res.json.incident.client, 'Cliente Alpha Detalle');
		assert.equal(res.json.incident.priority, 'high');
		assert.equal(res.json.incident.status, 'open');
	});

	await t.test('15. devuelve history', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		assert.ok(Array.isArray(res.json.history));
		assert.equal(res.json.history.length, 3);
	});

	await t.test('16. history ordenado cronológicamente de forma determinista', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		const history = res.json.history;
		for (let i = 1; i < history.length; i++) {
			const prevTime = new Date(history[i - 1].createdAt).getTime();
			const currTime = new Date(history[i].createdAt).getTime();
			assert.ok(
				currTime > prevTime || (currTime === prevTime && history[i].id >= history[i - 1].id),
				`Historial fuera de orden en índice ${i}`
			);
		}
	});

	await t.test('17. response no contiene membership/roles/permisos/sesión', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);

		// Top-level
		const topKeys = Object.keys(res.json);
		assert.deepEqual(topKeys.sort(), ['history', 'incident']);

		// Incident
		const allowedIncidentKeys = new Set([
			'id',
			'organizationId',
			'incidentNumber',
			'title',
			'description',
			'status',
			'priority',
			'client',
			'clientUserId',
			'createdByUserId',
			'siteId',
			'assignedToUserId',
			'assignedToUserName',
			'createdAt',
			'updatedAt'
		]);
		for (const key of Object.keys(res.json.incident)) {
			assert.ok(allowedIncidentKeys.has(key), `Campo inesperado en incident: ${key}`);
		}
		assert.equal('membership' in res.json.incident, false);
		assert.equal('roles' in res.json.incident, false);
		assert.equal('permissions' in res.json.incident, false);
		assert.equal('session' in res.json.incident, false);

		// History
		const allowedHistoryKeys = new Set([
			'id',
			'incidentId',
			'organizationId',
			'eventType',
			'actorType',
			'actorUserId',
			'reason',
			'comment',
			'payload',
			'createdAt'
		]);
		for (const entry of res.json.history) {
			for (const key of Object.keys(entry)) {
				assert.ok(allowedHistoryKeys.has(key), `Campo inesperado en history: ${key}`);
			}
			assert.equal('membership' in entry, false);
			assert.equal('roles' in entry, false);
			assert.equal('permissions' in entry, false);
			assert.equal('session' in entry, false);
		}
	});

	// =========================================================================
	// TENANT ISOLATION (Tests 18 - 22)
	// =========================================================================
	await t.test('18. incidencia de org A consultada con organizationId A → 200', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.incident.id, incA1Created.id);
	});

	await t.test('19. misma incidencia consultada con organizationId B → 404', async () => {
		// User B is authorized in Org B, queries incA1Created.id with Org B
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgB.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionB.cookieHeader }
		});
		assert.equal(res.status, 404);
		assert.equal(res.json.error?.code, 'INCIDENT_NOT_FOUND');
	});

	await t.test('20. UUID inexistente → 404', async () => {
		const missingId = randomUUID();
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${missingId}?organizationId=${orgA.id}`,
			params: { id: missingId },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 404);
		assert.equal(res.json.error?.code, 'INCIDENT_NOT_FOUND');
	});

	await t.test('21. cross-tenant vs inexistente son indistinguibles', async () => {
		// 1. Cross-tenant request (incA1 queried under orgB by userB)
		const resCross = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgB.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionB.cookieHeader }
		});

		// 2. Non-existent UUID under orgB by userB
		const nonExistentId = randomUUID();
		const resNonExistent = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${nonExistentId}?organizationId=${orgB.id}`,
			params: { id: nonExistentId },
			headers: { cookie: sessionB.cookieHeader }
		});

		// Same HTTP status
		assert.equal(resCross.status, 404);
		assert.equal(resNonExistent.status, 404);

		// Same error structure
		assert.deepEqual(resCross.json, resNonExistent.json);
		assert.equal(resCross.json.error.code, 'INCIDENT_NOT_FOUND');
		assert.equal(resCross.json.error.message, 'Incident not found.');
	});

	await t.test(
		'22. usuario autorizado en org A no puede consultar detalle bajo org B → 403 antes de llegar al servicio',
		async () => {
			// User A attempts to query incB1 under orgB
			const res = await callGetDetail(GET, {
				url: `http://localhost/api/incidents/${incB1Created.id}?organizationId=${orgB.id}`,
				params: { id: incB1Created.id },
				headers: { cookie: sessionA.cookieHeader }
			});
			assert.equal(res.status, 403);
			assert.equal(res.json.error?.code, 'FORBIDDEN');
		}
	);

	// =========================================================================
	// SEGURIDAD DE FUENTES (Tests 23 - 25)
	// =========================================================================
	await t.test(
		'23. incidentId enviado en query pero no en route param → debe ignorarse / no sustituir params.id',
		async () => {
			// Query string contains valid incA1Created.id, but params.id is invalid
			const resInvalidParam = await callGetDetail(GET, {
				url: `http://localhost/api/incidents/invalid-id?organizationId=${orgA.id}&id=${incA1Created.id}`,
				params: { id: 'invalid-id' },
				headers: { cookie: sessionA.cookieHeader }
			});
			assert.equal(resInvalidParam.status, 400);
			assert.equal(resInvalidParam.json.error?.code, 'INVALID_INPUT');

			// Query string contains other id, but params.id contains incA1Created.id
			const otherId = randomUUID();
			const resValidParam = await callGetDetail(GET, {
				url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}&id=${otherId}`,
				params: { id: incA1Created.id },
				headers: { cookie: sessionA.cookieHeader }
			});
			assert.equal(resValidParam.status, 200);
			assert.equal(resValidParam.json.incident.id, incA1Created.id);
		}
	);

	await t.test('24. organizationId enviado en header pero no en query → 400', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}`,
			params: { id: incA1Created.id },
			headers: {
				cookie: sessionA.cookieHeader,
				'x-organization-id': orgA.id
			}
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
	});

	await t.test('25. query organizationId prevalece frente a headers alternativos', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: {
				cookie: sessionA.cookieHeader,
				'x-organization-id': orgB.id
			}
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.incident.organizationId, orgA.id);
	});

	// =========================================================================
	// HISTORIAL (Tests 26 - 27)
	// =========================================================================
	await t.test('26. evento created aparece en historial', async () => {
		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incA1Created.id}?organizationId=${orgA.id}`,
			params: { id: incA1Created.id },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		const createdEvent = res.json.history.find((h) => h.eventType === 'created');
		assert.ok(createdEvent, 'Debe existir un evento de tipo created en el historial');
		assert.equal(createdEvent.incidentId, incA1Created.id);
		assert.equal(createdEvent.organizationId, orgA.id);
	});

	await t.test('27. varios eventos se devuelven en orden: createdAt ASC, id ASC', async () => {
		// Create a separate incident to test fine-grained order with identical timestamps
		const incOrderCreated = (
			await createIncidentRecord(
				db,
				{ organizationId: orgA.id, creatorUserId: userA.id },
				{
					title: 'Incidente Orden Historial',
					description: 'Verificación de orden createdAt ASC, id ASC',
					client: 'Cliente Test',
					priority: 'low'
				}
			)
		).incident;

		const fixedTime = new Date('2026-09-23T12:00:00.000Z');
		const idSmall = '00000000-0000-0000-0000-000000000001';
		const idLarge = '00000000-0000-0000-0000-000000000002';

		// Insert in reverse order to ensure DB ordering is what dictates the return
		await db.insert(s.incidentHistory).values([
			{
				id: idLarge,
				incidentId: incOrderCreated.id,
				organizationId: orgA.id,
				eventType: 'escalated',
				actorType: 'user',
				actorUserId: userA.id,
				createdAt: fixedTime
			},
			{
				id: idSmall,
				incidentId: incOrderCreated.id,
				organizationId: orgA.id,
				eventType: 'reassigned',
				actorType: 'user',
				actorUserId: userA.id,
				createdAt: fixedTime
			}
		]);

		const res = await callGetDetail(GET, {
			url: `http://localhost/api/incidents/${incOrderCreated.id}?organizationId=${orgA.id}`,
			params: { id: incOrderCreated.id },
			headers: { cookie: sessionA.cookieHeader }
		});
		assert.equal(res.status, 200);
		const history = res.json.history;
		// Must have created event + 2 inserted events
		assert.equal(history.length, 3);
		// The two events with identical createdAt must be sorted by id ASC
		const identicalTimeEvents = history.filter((h) => h.createdAt === fixedTime.toISOString());
		assert.equal(identicalTimeEvents.length, 2);
		assert.equal(identicalTimeEvents[0].id, idSmall);
		assert.equal(identicalTimeEvents[1].id, idLarge);
	});
});

test('SoporteFlow — Etapa 5.4H: Endpoint HTTP PATCH /api/incidents/[id]', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;

	const { PATCH } = await server.ssrLoadModule('/src/routes/api/incidents/[id]/+server.ts');
	const { createIncidentRecord } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);

	// 1. SETUP TENANTS & USERS
	const [orgA] = await db
		.insert(s.organizations)
		.values({ name: 'Org A 5.4H', slug: 'org-a-54h-' + randomUUID(), status: 'active' })
		.returning();

	const [orgB] = await db
		.insert(s.organizations)
		.values({ name: 'Org B 5.4H', slug: 'org-b-54h-' + randomUUID(), status: 'active' })
		.returning();

	// Técnico en Org A con permiso incidents:edit
	const userTechA = await identity(f);
	const [membershipTechA] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userTechA.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: membershipTechA.id,
		permissionId: 'incidents:edit'
	});
	const sessionTechA = await createSession(f, userTechA.id);

	// Administrador en Org A con permiso incidents:edit
	const userOrgAdminA = await identity(f);
	const [membershipAdminA] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userOrgAdminA.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: membershipAdminA.id,
		permissionId: 'incidents:edit'
	});
	const sessionAdminA = await createSession(f, userOrgAdminA.id);

	// Cliente en Org A (SIN incidents:edit)
	const userClientA = await identity(f);
	const [membershipClientA] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userClientA.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: membershipClientA.id,
		permissionId: 'incidents:create'
	});
	const sessionClientA = await createSession(f, userClientA.id);

	// Usuario en Org B con permiso incidents:edit
	const userB = await identity(f);
	const [membershipB] = await db
		.insert(s.memberships)
		.values({ organizationId: orgB.id, userId: userB.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgB.id,
		membershipId: membershipB.id,
		permissionId: 'incidents:edit'
	});
	const sessionB = await createSession(f, userB.id);

	// Helper para crear incidentes iniciales en Org A
	async function createFreshIncident(status = 'open', priority = 'medium') {
		const created = (
			await createIncidentRecord(
				db,
				{ organizationId: orgA.id, creatorUserId: userTechA.id },
				{
					title: 'Incidente PATCH ' + randomUUID(),
					description: 'Descripción para PATCH test',
					client: 'Cliente Test',
					priority
				}
			)
		).incident;

		if (status !== 'open') {
			await db.update(s.incidents).set({ status }).where(eq(s.incidents.id, created.id));
			created.status = status;
		}

		return created;
	}

	await t.test('1. 401 si no hay sesión autenticada', async () => {
		const inc = await createFreshIncident();
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=${orgA.id}`,
			params: { id: inc.id },
			body: { status: 'pending' }
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error?.code, 'UNAUTHORIZED');
	});

	await t.test('2. 401 con cookie manipulada o sesión inexistente', async () => {
		const inc = await createFreshIncident();
		const tamperedCookie = createTamperedCookie('invalid-session');
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: tamperedCookie },
			body: { status: 'pending' }
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error?.code, 'UNAUTHORIZED');
	});

	await t.test('3. 400 si organizationId es inválido o ausente', async () => {
		const inc = await createFreshIncident();
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=not-a-uuid`,
			params: { id: inc.id },
			headers: { cookie: sessionTechA.cookieHeader },
			body: { status: 'pending' }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
	});

	await t.test('4. 400 si incidentId es inválido o no es UUID', async () => {
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/not-a-uuid?organizationId=${orgA.id}`,
			params: { id: 'not-a-uuid' },
			headers: { cookie: sessionTechA.cookieHeader },
			body: { status: 'pending' }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
	});

	await t.test('5. 400 si el JSON está malformado', async () => {
		const inc = await createFreshIncident();
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTechA.cookieHeader },
			rawBody: '{ invalid json'
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
	});

	await t.test('6. 400 si el body está vacío', async () => {
		const inc = await createFreshIncident();
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTechA.cookieHeader },
			body: {}
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
	});

	await t.test('7. 400 si status no pertenece al enum permitido', async () => {
		const inc = await createFreshIncident();
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTechA.cookieHeader },
			body: { status: 'invented_status' }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
	});

	await t.test('8. 400 si priority no pertenece al enum permitido', async () => {
		const inc = await createFreshIncident();
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTechA.cookieHeader },
			body: { priority: 'super_urgent' }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
	});

	await t.test('9. 400 si se envían propiedades desconocidas', async () => {
		const inc = await createFreshIncident();
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTechA.cookieHeader },
			body: { status: 'pending', reason: 'motivo no admitido' }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
	});

	await t.test('10. 400 si la transición de status es inválida (open -> closed)', async () => {
		const inc = await createFreshIncident('open');
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTechA.cookieHeader },
			body: { status: 'closed' }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
	});

	await t.test('11. 403 Forbidden para usuario cliente sin incidents:edit', async () => {
		const inc = await createFreshIncident();
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionClientA.cookieHeader },
			body: { status: 'pending' }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
	});

	await t.test('12. 200 OK para técnico autorizado con incidents:edit', async () => {
		const inc = await createFreshIncident('open');
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTechA.cookieHeader },
			body: { status: 'pending' }
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.incident.status, 'pending');
	});

	await t.test('13. 200 OK para org admin autorizado', async () => {
		const inc = await createFreshIncident('pending');
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionAdminA.cookieHeader },
			body: { status: 'resolved' }
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.incident.status, 'resolved');
	});

	await t.test('14. cross-tenant con organizationId propio devuelve 404', async () => {
		const incA = await createFreshIncident();
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${incA.id}?organizationId=${orgB.id}`,
			params: { id: incA.id },
			headers: { cookie: sessionB.cookieHeader },
			body: { status: 'pending' }
		});
		assert.equal(res.status, 404);
		assert.equal(res.json.error?.code, 'INCIDENT_NOT_FOUND');
	});

	await t.test('15. cross-tenant con organizationId ajeno devuelve 403', async () => {
		const incA = await createFreshIncident();
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${incA.id}?organizationId=${orgA.id}`,
			params: { id: incA.id },
			headers: { cookie: sessionB.cookieHeader },
			body: { status: 'pending' }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
	});

	await t.test('16. 404 para incident inexistente', async () => {
		const fakeId = randomUUID();
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${fakeId}?organizationId=${orgA.id}`,
			params: { id: fakeId },
			headers: { cookie: sessionTechA.cookieHeader },
			body: { status: 'pending' }
		});
		assert.equal(res.status, 404);
		assert.equal(res.json.error?.code, 'INCIDENT_NOT_FOUND');
	});

	await t.test('17. 200 para actualización exclusiva de status', async () => {
		const inc = await createFreshIncident('open', 'medium');
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTechA.cookieHeader },
			body: { status: 'resolved' }
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.incident.status, 'resolved');
		assert.equal(res.json.incident.priority, 'medium');
	});

	await t.test('18. 200 para actualización exclusiva de priority', async () => {
		const inc = await createFreshIncident('open', 'low');
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTechA.cookieHeader },
			body: { priority: 'urgent' }
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.incident.priority, 'urgent');
		assert.equal(res.json.incident.status, 'open');
	});

	await t.test('19. 200 para actualización simultánea de status y priority', async () => {
		const inc = await createFreshIncident('open', 'low');
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTechA.cookieHeader },
			body: { status: 'pending', priority: 'high' }
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.incident.status, 'pending');
		assert.equal(res.json.incident.priority, 'high');
	});

	await t.test('20. el payload de respuesta NO contiene history confidencial', async () => {
		const inc = await createFreshIncident('open');
		const res = await callPatchDetail(PATCH, {
			url: `http://localhost/api/incidents/${inc.id}?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTechA.cookieHeader },
			body: { status: 'pending' }
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.history, undefined);
		assert.ok(res.json.incident);
	});
});

test('SoporteFlow — Etapa 5.4I-A: GET /api/incidents/assignees — Catálogo de técnicos asignables', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;

	const { GET: getAssignees } = await server.ssrLoadModule(
		'/src/routes/api/incidents/assignees/+server.ts'
	);

	// Setup orgs
	const [orgA] = await db
		.insert(s.organizations)
		.values({ name: 'Org Assignees A', slug: 'assign-a-' + randomUUID(), status: 'active' })
		.returning();

	// Helper for roles
	async function createRole(orgId, name, code) {
		const [role] = await db
			.insert(s.roles)
			.values({ organizationId: orgId, name, code, active: true })
			.returning();
		return role;
	}
	async function assignRole(orgId, membershipId, roleId) {
		const [assignment] = await db
			.insert(s.roleAssignments)
			.values({ organizationId: orgId, membershipId, roleId, scopeType: 'organization' })
			.returning();
		return assignment;
	}

	const roleTechA = await createRole(orgA.id, 'Técnico', 'technician');
	const roleAdminA = await createRole(orgA.id, 'Admin', 'organization_admin');
	const roleClientA = await createRole(orgA.id, 'Cliente', 'client');

	// Users in Org A
	const userTech1 = await createCredentialUser(f, { name: 'Bernardo Técnico' });
	const memTech1 = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userTech1.id, active: true })
		.returning();
	await assignRole(orgA.id, memTech1[0].id, roleTechA.id);
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memTech1[0].id,
		permissionId: 'incidents:assign'
	});
	const sessionTechA = await createSession(f, userTech1.id);

	const userTech2 = await createCredentialUser(f, { name: 'Carlos Técnico' });
	const memTech2 = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userTech2.id, active: true })
		.returning();
	await assignRole(orgA.id, memTech2[0].id, roleTechA.id);

	const userAdmin = await createCredentialUser(f, { name: 'Alicia Admin' });
	const memAdmin = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userAdmin.id, active: true })
		.returning();
	await assignRole(orgA.id, memAdmin[0].id, roleAdminA.id);

	const userClient = await createCredentialUser(f, { name: 'David Cliente' });
	const memClient = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userClient.id, active: true })
		.returning();
	await assignRole(orgA.id, memClient[0].id, roleClientA.id);
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memClient[0].id,
		permissionId: 'incidents:create'
	});
	const sessionClientA = await createSession(f, userClient.id);

	const userInactive = await createCredentialUser(f, { name: 'Elena Inactiva', active: false });
	const memInactive = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userInactive.id, active: true })
		.returning();
	await assignRole(orgA.id, memInactive[0].id, roleTechA.id);

	const userInactiveMem = await createCredentialUser(f, { name: 'Fernando Inactivo' });
	const memInactiveMem = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userInactiveMem.id, active: false })
		.returning();
	await assignRole(orgA.id, memInactiveMem[0].id, roleTechA.id);

	// 1. 401 si no hay sesión
	await t.test('1. 401 si no hay sesión autenticada', async () => {
		const res = await callGetAssignees(getAssignees, {
			url: `http://localhost/api/incidents/assignees?organizationId=${orgA.id}`
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error.code, 'UNAUTHORIZED');
	});

	// 2. 403 si el rol no tiene incidents:assign (cliente)
	await t.test('2. 403 si el usuario carece del permiso incidents:assign', async () => {
		const res = await callGetAssignees(getAssignees, {
			url: `http://localhost/api/incidents/assignees?organizationId=${orgA.id}`,
			headers: { cookie: sessionClientA.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error.code, 'FORBIDDEN');
	});

	// 3. 400 si organizationId no es UUID válido
	await t.test('3. 400 si organizationId no es UUID', async () => {
		const res = await callGetAssignees(getAssignees, {
			url: 'http://localhost/api/incidents/assignees?organizationId=invalid-uuid',
			headers: { cookie: sessionTechA.cookieHeader }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error.code, 'INVALID_INPUT');
	});

	// 4. 200 catálogo filtra y ordena deterministamente
	await t.test(
		'4. 200 devuelve solo técnicos/admins activos ordenados alfabéticamente',
		async () => {
			const res = await callGetAssignees(getAssignees, {
				url: `http://localhost/api/incidents/assignees?organizationId=${orgA.id}`,
				headers: { cookie: sessionTechA.cookieHeader }
			});
			assert.equal(res.status, 200);
			assert.ok(Array.isArray(res.json.assignees));
			const list = res.json.assignees;
			const ids = list.map((a) => a.id);

			assert.ok(ids.includes(userAdmin.id), 'Debe incluir admin');
			assert.ok(ids.includes(userTech1.id), 'Debe incluir tech 1');
			assert.ok(ids.includes(userTech2.id), 'Debe incluir tech 2');
			assert.ok(!ids.includes(userClient.id), 'NO debe incluir client');
			assert.ok(!ids.includes(userInactive.id), 'NO debe incluir user inactivo');
			assert.ok(!ids.includes(userInactiveMem.id), 'NO debe incluir membership inactiva');

			// Orden alfabético: Alicia Admin < Bernardo Técnico < Carlos Técnico
			assert.equal(list[0].name, 'Alicia Admin');
			assert.equal(list[1].name, 'Bernardo Técnico');
			assert.equal(list[2].name, 'Carlos Técnico');
		}
	);
});

test('SoporteFlow — Etapa 5.4I-A: POST /api/incidents/[id]/assign — Asignación y Reasignación', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;

	const { POST: postAssign } = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/assign/+server.ts'
	);
	const { createIncidentRecord } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);

	const [orgA] = await db
		.insert(s.organizations)
		.values({ name: 'Org Assign Test A', slug: 'assign-test-a-' + randomUUID(), status: 'active' })
		.returning();
	const [orgB] = await db
		.insert(s.organizations)
		.values({ name: 'Org Assign Test B', slug: 'assign-test-b-' + randomUUID(), status: 'active' })
		.returning();

	async function createRole(orgId, name, code) {
		const [role] = await db
			.insert(s.roles)
			.values({ organizationId: orgId, name, code, active: true })
			.returning();
		return role;
	}
	async function assignRole(orgId, membershipId, roleId) {
		const [assignment] = await db
			.insert(s.roleAssignments)
			.values({ organizationId: orgId, membershipId, roleId, scopeType: 'organization' })
			.returning();
		return assignment;
	}

	const roleTechA = await createRole(orgA.id, 'Técnico', 'technician');
	const roleClientA = await createRole(orgA.id, 'Cliente', 'client');

	const userTech1 = await createCredentialUser(f, { name: 'Técnico A1' });
	const [memTech1] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userTech1.id, active: true })
		.returning();
	await assignRole(orgA.id, memTech1.id, roleTechA.id);
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memTech1.id,
		permissionId: 'incidents:assign'
	});
	const sessionTech1 = await createSession(f, userTech1.id);

	const userTech2 = await createCredentialUser(f, { name: 'Técnico A2' });
	const [memTech2] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userTech2.id, active: true })
		.returning();
	await assignRole(orgA.id, memTech2.id, roleTechA.id);

	const userClient = await createCredentialUser(f, { name: 'Cliente A' });
	const [memClient] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userClient.id, active: true })
		.returning();
	await assignRole(orgA.id, memClient.id, roleClientA.id);
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memClient.id,
		permissionId: 'incidents:create'
	});
	const sessionClient = await createSession(f, userClient.id);

	// Técnico en orgB
	const roleTechB = await createRole(orgB.id, 'Técnico B', 'technician');
	const userTechB = await createCredentialUser(f, { name: 'Técnico B1' });
	const [memTechB] = await db
		.insert(s.memberships)
		.values({ organizationId: orgB.id, userId: userTechB.id, active: true })
		.returning();
	await assignRole(orgB.id, memTechB.id, roleTechB.id);

	async function createIncidentA() {
		const { incident } = await createIncidentRecord(
			db,
			{
				organizationId: orgA.id,
				creatorUserId: userTech1.id
			},
			{
				title: 'Incidencia API Test ' + randomUUID().slice(0, 6),
				description: 'Test descripción',
				client: 'Cliente Test'
			}
		);
		return incident;
	}

	// 1. 401 sin sesión
	await t.test('1. 401 si no hay sesión autenticada', async () => {
		const inc = await createIncidentA();
		const res = await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${inc.id}/assign?organizationId=${orgA.id}`,
			params: { id: inc.id },
			body: { assignedToUserId: userTech1.id }
		});
		assert.equal(res.status, 401);
		assert.equal(res.json.error.code, 'UNAUTHORIZED');
	});

	// 2. 403 sin permiso incidents:assign
	await t.test('2. 403 si el usuario carece de incidents:assign', async () => {
		const inc = await createIncidentA();
		const res = await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${inc.id}/assign?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionClient.cookieHeader },
			body: { assignedToUserId: userTech1.id }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error.code, 'FORBIDDEN');
	});

	// 3. 400 malformed JSON o no object
	await t.test('3. 400 con body malformado o no-objeto', async () => {
		const inc = await createIncidentA();
		const res1 = await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${inc.id}/assign?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTech1.cookieHeader },
			rawBody: '{ bad json'
		});
		assert.equal(res1.status, 400);

		const res2 = await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${inc.id}/assign?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTech1.cookieHeader },
			rawBody: '["array_not_object"]'
		});
		assert.equal(res2.status, 400);
	});

	// 4. 400 UUID inválido
	await t.test('4. 400 si organizationId, incidentId o assignedToUserId no son UUID', async () => {
		const inc = await createIncidentA();
		const resOrg = await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${inc.id}/assign?organizationId=not-a-uuid`,
			params: { id: inc.id },
			headers: { cookie: sessionTech1.cookieHeader },
			body: { assignedToUserId: userTech1.id }
		});
		assert.equal(resOrg.status, 400);

		const resInc = await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/not-a-uuid/assign?organizationId=${orgA.id}`,
			params: { id: 'not-a-uuid' },
			headers: { cookie: sessionTech1.cookieHeader },
			body: { assignedToUserId: userTech1.id }
		});
		assert.equal(resInc.status, 400);

		const resAssignee = await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${inc.id}/assign?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTech1.cookieHeader },
			body: { assignedToUserId: 'not-a-uuid' }
		});
		assert.equal(resAssignee.status, 400);
	});

	// 5. 400 unknown keys
	await t.test('5. 400 si se envían propiedades no permitidas', async () => {
		const inc = await createIncidentA();
		const res = await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${inc.id}/assign?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTech1.cookieHeader },
			body: { assignedToUserId: userTech1.id, teamId: randomUUID() }
		});
		assert.equal(res.status, 400);
		assert.ok(res.json.error.message.includes('teamId'));
	});

	// 6. 404 si la incidencia no existe o pertenece a otro tenant
	await t.test('6. 404 si la incidencia no existe en la organización', async () => {
		const fakeId = randomUUID();
		const res = await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${fakeId}/assign?organizationId=${orgA.id}`,
			params: { id: fakeId },
			headers: { cookie: sessionTech1.cookieHeader },
			body: { assignedToUserId: userTech1.id }
		});
		assert.equal(res.status, 404);
		assert.equal(res.json.error.code, 'INCIDENT_NOT_FOUND');
	});

	// 7. 404 si el técnico pertenece a otra organización
	await t.test('7. 404 fail-closed si el técnico pertenece a otro tenant', async () => {
		const inc = await createIncidentA();
		const res = await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${inc.id}/assign?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTech1.cookieHeader },
			body: { assignedToUserId: userTechB.id }
		});
		assert.equal(res.status, 404);
		assert.equal(res.json.error.code, 'ASSIGNEE_NOT_FOUND');
	});

	// 8. 200 primera asignación: actualiza, devuelve incident y NO history
	await t.test('8. 200 primera asignación exitosa sin history en payload', async () => {
		const inc = await createIncidentA();
		const res = await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${inc.id}/assign?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTech1.cookieHeader },
			body: { assignedToUserId: userTech1.id }
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.incident.assignedToUserId, userTech1.id);
		assert.equal(res.json.history, undefined);
	});

	// 9. 400 reasignación sin motivo
	await t.test('9. 400 reasignación sin motivo falla con INVALID_INPUT', async () => {
		const inc = await createIncidentA();
		// Primera asignación
		await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${inc.id}/assign?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTech1.cookieHeader },
			body: { assignedToUserId: userTech1.id }
		});

		// Reasignación sin reason
		const res = await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${inc.id}/assign?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTech1.cookieHeader },
			body: { assignedToUserId: userTech2.id }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error.code, 'INVALID_INPUT');
	});

	// 10. 200 reasignación con motivo válido
	await t.test('10. 200 reasignación con motivo válido y NO history en respuesta', async () => {
		const inc = await createIncidentA();
		await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${inc.id}/assign?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTech1.cookieHeader },
			body: { assignedToUserId: userTech1.id }
		});

		const res = await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${inc.id}/assign?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTech1.cookieHeader },
			body: { assignedToUserId: userTech2.id, reason: 'Escalado por turno' }
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.incident.assignedToUserId, userTech2.id);
		assert.equal(res.json.history, undefined);
	});

	// 11. 200 no-op al asignar al mismo técnico
	await t.test('11. 200 no-op devuelve estado actual sin error', async () => {
		const inc = await createIncidentA();
		await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${inc.id}/assign?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTech1.cookieHeader },
			body: { assignedToUserId: userTech1.id }
		});

		const res = await callPostAssign(postAssign, {
			url: `http://localhost/api/incidents/${inc.id}/assign?organizationId=${orgA.id}`,
			params: { id: inc.id },
			headers: { cookie: sessionTech1.cookieHeader },
			body: { assignedToUserId: userTech1.id }
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.incident.assignedToUserId, userTech1.id);
	});
});

test('SoporteFlow — Etapa 5.4J-A: Endpoint HTTP GET /api/incidents — Colas (mine, unassigned, all)', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;

	const { GET } = await server.ssrLoadModule('/src/routes/api/incidents/+server.ts');
	const { createIncidentRecord, assignIncidentRecord, updateIncidentRecord } =
		await server.ssrLoadModule('/src/lib/server/services/incidents.ts');

	// Setup organizations:
	const [orgQ] = await db
		.insert(s.organizations)
		.values({ name: 'Org Q API', slug: 'org-q-api-' + randomUUID(), status: 'active' })
		.returning();

	const [orgOther] = await db
		.insert(s.organizations)
		.values({ name: 'Org Other API', slug: 'org-other-api-' + randomUUID(), status: 'active' })
		.returning();

	// Users in orgQ:
	// userViewAll: has incidents:view_all
	const userViewAll = await identity(f);
	const [memViewAll] = await db
		.insert(s.memberships)
		.values({ organizationId: orgQ.id, userId: userViewAll.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgQ.id,
		membershipId: memViewAll.id,
		permissionId: 'incidents:view_all'
	});
	const sessionViewAll = await createSession(f, userViewAll.id);

	// userViewOwn: has ONLY incidents:view_own
	const userViewOwn = await identity(f);
	const [memViewOwn] = await db
		.insert(s.memberships)
		.values({ organizationId: orgQ.id, userId: userViewOwn.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgQ.id,
		membershipId: memViewOwn.id,
		permissionId: 'incidents:view_own'
	});
	const sessionViewOwn = await createSession(f, userViewOwn.id);

	// userNoPerm: has membership but neither view_all nor view_own
	const userNoPerm = await identity(f);
	await db
		.insert(s.memberships)
		.values({ organizationId: orgQ.id, userId: userNoPerm.id, active: true });
	const sessionNoPerm = await createSession(f, userNoPerm.id);

	// userOther: user in orgOther with view_all
	const userOther = await identity(f);
	const [memOther] = await db
		.insert(s.memberships)
		.values({ organizationId: orgOther.id, userId: userOther.id, active: true })
		.returning();
	await grantPermission(f, {
		organizationId: orgOther.id,
		membershipId: memOther.id,
		permissionId: 'incidents:view_all'
	});
	const sessionOther = await createSession(f, userOther.id);

	const [roleTech] = await db
		.insert(s.roles)
		.values({ organizationId: orgQ.id, name: 'Technician', code: 'technician', active: true })
		.returning();
	await db.insert(s.roleAssignments).values([
		{
			organizationId: orgQ.id,
			membershipId: memViewAll.id,
			roleId: roleTech.id,
			scopeType: 'organization'
		},
		{
			organizationId: orgQ.id,
			membershipId: memViewOwn.id,
			roleId: roleTech.id,
			scopeType: 'organization'
		}
	]);

	// Incidents creation in orgQ:
	// 1. Assigned to userViewAll (open, high)
	const { incident: inc1 } = await createIncidentRecord(
		db,
		{ organizationId: orgQ.id, creatorUserId: userViewAll.id },
		{ title: 'Inc 1 - ViewAll', description: 'Desc 1', client: 'Client A', priority: 'high' }
	);
	await assignIncidentRecord(
		db,
		{ organizationId: orgQ.id, actorUserId: userViewAll.id },
		inc1.id,
		{ assignedToUserId: userViewAll.id }
	);

	// 2. Assigned to userViewOwn (pending, medium)
	const { incident: inc2 } = await createIncidentRecord(
		db,
		{ organizationId: orgQ.id, creatorUserId: userViewAll.id },
		{ title: 'Inc 2 - ViewOwn', description: 'Desc 2', client: 'Client B', priority: 'medium' }
	);
	await assignIncidentRecord(
		db,
		{ organizationId: orgQ.id, actorUserId: userViewAll.id },
		inc2.id,
		{ assignedToUserId: userViewOwn.id }
	);
	await updateIncidentRecord(
		db,
		{ organizationId: orgQ.id, actorUserId: userViewAll.id },
		inc2.id,
		{ status: 'pending' }
	);

	// 3. Unassigned (open, high)
	const { incident: inc3 } = await createIncidentRecord(
		db,
		{ organizationId: orgQ.id, creatorUserId: userViewAll.id },
		{ title: 'Inc 3 - Unassigned 1', description: 'Desc 3', client: 'Client C', priority: 'high' }
	);

	// 4. Unassigned (resolved, low)
	const { incident: inc4 } = await createIncidentRecord(
		db,
		{ organizationId: orgQ.id, creatorUserId: userViewAll.id },
		{ title: 'Inc 4 - Unassigned 2', description: 'Desc 4', client: 'Client D', priority: 'low' }
	);
	await updateIncidentRecord(
		db,
		{ organizationId: orgQ.id, actorUserId: userViewAll.id },
		inc4.id,
		{ status: 'resolved' }
	);

	// Incidents in orgOther:
	const { incident: incOther } = await createIncidentRecord(
		db,
		{ organizationId: orgOther.id, creatorUserId: userOther.id },
		{ title: 'Inc Other Org', description: 'Desc Other', client: 'Client Other', priority: 'high' }
	);

	// Subtests:
	// 1. queue=all con incidents:view_all -> 200 y devuelve todas las incidencias
	await t.test(
		'1. queue=all con incidents:view_all -> 200 y devuelve todas las incidencias',
		async () => {
			const res = await callGet(GET, {
				url: `http://localhost/api/incidents?organizationId=${orgQ.id}&queue=all`,
				headers: { cookie: sessionViewAll.cookieHeader }
			});
			assert.equal(res.status, 200);
			assert.equal(res.json.incidents.length, 4);
			const ids = res.json.incidents.map((i) => i.id);
			assert.ok(ids.includes(inc1.id));
			assert.ok(ids.includes(inc2.id));
			assert.ok(ids.includes(inc3.id));
			assert.ok(ids.includes(inc4.id));
			assert.ok(!ids.includes(incOther.id));
		}
	);

	// 2. queue=unassigned con incidents:view_all -> 200 y solo devuelve assignedToUserId null
	await t.test(
		'2. queue=unassigned con incidents:view_all -> 200 y solo devuelve assignedToUserId null',
		async () => {
			const res = await callGet(GET, {
				url: `http://localhost/api/incidents?organizationId=${orgQ.id}&queue=unassigned`,
				headers: { cookie: sessionViewAll.cookieHeader }
			});
			assert.equal(res.status, 200);
			assert.equal(res.json.incidents.length, 2);
			for (const inc of res.json.incidents) {
				assert.equal(inc.assignedToUserId, null);
			}
			const ids = res.json.incidents.map((i) => i.id);
			assert.ok(ids.includes(inc3.id));
			assert.ok(ids.includes(inc4.id));
		}
	);

	// 3. queue=mine con incidents:view_all -> 200 y devuelve solo las del actor autenticado
	await t.test(
		'3. queue=mine con incidents:view_all -> 200 y devuelve solo las del actor autenticado',
		async () => {
			const res = await callGet(GET, {
				url: `http://localhost/api/incidents?organizationId=${orgQ.id}&queue=mine`,
				headers: { cookie: sessionViewAll.cookieHeader }
			});
			assert.equal(res.status, 200);
			assert.equal(res.json.incidents.length, 1);
			assert.equal(res.json.incidents[0].id, inc1.id);
			assert.equal(res.json.incidents[0].assignedToUserId, userViewAll.id);
		}
	);

	// 4. queue=mine con incidents:view_own (sin view_all) -> 200 y devuelve solo las del actor autenticado
	await t.test(
		'4. queue=mine con incidents:view_own (sin view_all) -> 200 y devuelve solo las del actor autenticado',
		async () => {
			const res = await callGet(GET, {
				url: `http://localhost/api/incidents?organizationId=${orgQ.id}&queue=mine`,
				headers: { cookie: sessionViewOwn.cookieHeader }
			});
			assert.equal(res.status, 200);
			assert.equal(res.json.incidents.length, 1);
			assert.equal(res.json.incidents[0].id, inc2.id);
			assert.equal(res.json.incidents[0].assignedToUserId, userViewOwn.id);
		}
	);

	// 5. queue=all con solo incidents:view_own -> 403 FORBIDDEN
	await t.test('5. queue=all con solo incidents:view_own -> 403 FORBIDDEN', async () => {
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgQ.id}&queue=all`,
			headers: { cookie: sessionViewOwn.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
	});

	// 6. queue=unassigned con solo incidents:view_own -> 403 FORBIDDEN
	await t.test('6. queue=unassigned con solo incidents:view_own -> 403 FORBIDDEN', async () => {
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgQ.id}&queue=unassigned`,
			headers: { cookie: sessionViewOwn.cookieHeader }
		});
		assert.equal(res.status, 403);
		assert.equal(res.json.error?.code, 'FORBIDDEN');
	});

	// 7. sin queue con solo incidents:view_own -> 403 FORBIDDEN (por default a all)
	await t.test(
		'7. sin queue con solo incidents:view_own -> 403 FORBIDDEN (por default a all)',
		async () => {
			const res = await callGet(GET, {
				url: `http://localhost/api/incidents?organizationId=${orgQ.id}`,
				headers: { cookie: sessionViewOwn.cookieHeader }
			});
			assert.equal(res.status, 403);
			assert.equal(res.json.error?.code, 'FORBIDDEN');
		}
	);

	// 8. queue inválida -> 400 INVALID_INPUT
	await t.test('8. queue inválida -> 400 INVALID_INPUT', async () => {
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgQ.id}&queue=custom`,
			headers: { cookie: sessionViewAll.cookieHeader }
		});
		assert.equal(res.status, 400);
		assert.equal(res.json.error?.code, 'INVALID_INPUT');
	});

	// 9. usuario sin ninguno de los dos permisos -> 403 FORBIDDEN en cualquier cola
	await t.test(
		'9. usuario sin ninguno de los dos permisos -> 403 FORBIDDEN en cualquier cola',
		async () => {
			for (const q of ['all', 'unassigned', 'mine']) {
				const res = await callGet(GET, {
					url: `http://localhost/api/incidents?organizationId=${orgQ.id}&queue=${q}`,
					headers: { cookie: sessionNoPerm.cookieHeader }
				});
				assert.equal(res.status, 403);
				assert.equal(res.json.error?.code, 'FORBIDDEN');
			}
		}
	);

	// 10. userId en query no permite suplantación de identidad (queue=mine sigue usando sesión)
	await t.test('10. userId en query no permite suplantación de identidad', async () => {
		// userViewOwn intenta pedir los tickets de userViewAll pasando userId en query
		const res = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgQ.id}&queue=mine&userId=${userViewAll.id}&assignedToUserId=${userViewAll.id}`,
			headers: { cookie: sessionViewOwn.cookieHeader }
		});
		assert.equal(res.status, 200);
		// Debe devolver SOLO las de userViewOwn, NO las de userViewAll
		assert.equal(res.json.incidents.length, 1);
		assert.equal(res.json.incidents[0].id, inc2.id);
		assert.equal(res.json.incidents[0].assignedToUserId, userViewOwn.id);
	});

	// 11. aislamiento multi-tenant en todas las colas
	await t.test('11. aislamiento multi-tenant en todas las colas', async () => {
		const resAll = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgOther.id}&queue=all`,
			headers: { cookie: sessionOther.cookieHeader }
		});
		assert.equal(resAll.status, 200);
		assert.equal(resAll.json.incidents.length, 1);
		assert.equal(resAll.json.incidents[0].id, incOther.id);

		const resUnassigned = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgOther.id}&queue=unassigned`,
			headers: { cookie: sessionOther.cookieHeader }
		});
		assert.equal(resUnassigned.status, 200);
		assert.equal(resUnassigned.json.incidents.length, 1);
		assert.equal(resUnassigned.json.incidents[0].id, incOther.id);

		const resMine = await callGet(GET, {
			url: `http://localhost/api/incidents?organizationId=${orgOther.id}&queue=mine`,
			headers: { cookie: sessionOther.cookieHeader }
		});
		assert.equal(resMine.status, 200);
		assert.equal(resMine.json.incidents.length, 0);
	});

	// 12. filtros existentes (status, priority) se combinan correctamente con las colas
	await t.test(
		'12. filtros existentes (status, priority) se combinan correctamente con las colas',
		async () => {
			// mine + priority
			const resMineHigh = await callGet(GET, {
				url: `http://localhost/api/incidents?organizationId=${orgQ.id}&queue=mine&priority=high`,
				headers: { cookie: sessionViewAll.cookieHeader }
			});
			assert.equal(resMineHigh.status, 200);
			assert.equal(resMineHigh.json.incidents.length, 1);
			assert.equal(resMineHigh.json.incidents[0].id, inc1.id);

			const resMineLow = await callGet(GET, {
				url: `http://localhost/api/incidents?organizationId=${orgQ.id}&queue=mine&priority=low`,
				headers: { cookie: sessionViewAll.cookieHeader }
			});
			assert.equal(resMineLow.status, 200);
			assert.equal(resMineLow.json.incidents.length, 0);

			// unassigned + status
			const resUnassignedResolved = await callGet(GET, {
				url: `http://localhost/api/incidents?organizationId=${orgQ.id}&queue=unassigned&status=resolved`,
				headers: { cookie: sessionViewAll.cookieHeader }
			});
			assert.equal(resUnassignedResolved.status, 200);
			assert.equal(resUnassignedResolved.json.incidents.length, 1);
			assert.equal(resUnassignedResolved.json.incidents[0].id, inc4.id);

			// all + status + priority
			const resAllOpenHigh = await callGet(GET, {
				url: `http://localhost/api/incidents?organizationId=${orgQ.id}&queue=all&status=open&priority=high`,
				headers: { cookie: sessionViewAll.cookieHeader }
			});
			assert.equal(resAllOpenHigh.status, 200);
			assert.equal(resAllOpenHigh.json.incidents.length, 2);
			const ids = resAllOpenHigh.json.incidents.map((i) => i.id);
			assert.ok(ids.includes(inc1.id));
			assert.ok(ids.includes(inc3.id));
		}
	);
});

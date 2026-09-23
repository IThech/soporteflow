import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
	fixture,
	identity,
	createSession,
	createTamperedCookie,
	grantPermission
} from './helpers/auth-fixture.mjs';

function makeEvent(request, url = new URL(request.url)) {
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
		route: { id: '/api/incidents' },
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

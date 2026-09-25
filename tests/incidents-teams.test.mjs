import { eq } from 'drizzle-orm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
	fixture,
	createCredentialUser,
	createSession,
	grantPermission
} from './helpers/auth-fixture.mjs';

test('SoporteFlow — Etapa 5.4K-A: Backend y persistencia de equipos reales en incidencias', async (t) => {
	const f = await fixture(t, true);
	const { db, schema: s, server } = f;

	// Load services and endpoints
	const { getActiveTeams } = await server.ssrLoadModule('/src/lib/server/services/teams.ts');
	const {
		getAssignableTechnicians,
		assignIncidentRecord,
		createIncidentRecord,
		getIncidentById,
		listIncidents
	} = await server.ssrLoadModule('/src/lib/server/services/incidents.ts');
	const { GET: getTeamsEndpoint } = await server.ssrLoadModule('/src/routes/api/teams/+server.ts');
	const { GET: getAssigneesEndpoint } = await server.ssrLoadModule(
		'/src/routes/api/incidents/assignees/+server.ts'
	);
	const { POST: assignEndpoint } = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/assign/+server.ts'
	);

	// Setup Organizations
	const [orgA] = await db
		.insert(s.organizations)
		.values({ name: 'Org Equipos A', slug: 'org-teams-a-' + randomUUID(), status: 'active' })
		.returning();

	const [orgB] = await db
		.insert(s.organizations)
		.values({ name: 'Org Equipos B', slug: 'org-teams-b-' + randomUUID(), status: 'active' })
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
	// Tech 1: Belongs to Team 1
	const userTech1 = await createCredentialUser(f, { name: 'Alba Redes' });
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
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memTech1.id,
		permissionId: 'incidents:view_all'
	});
	const sessionTechA = await createSession(f, userTech1.id);

	// Tech 2: Belongs to Team 1 and Team 2
	const userTech2 = await createCredentialUser(f, { name: 'Berto Multi' });
	const [memTech2] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userTech2.id, active: true })
		.returning();
	await assignRole(orgA.id, memTech2.id, roleTechA.id);
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memTech2.id,
		permissionId: 'incidents:assign'
	});

	// Tech 3: Belongs only to Team 2
	const userTech3 = await createCredentialUser(f, { name: 'Clara Sistemas' });
	const [memTech3] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userTech3.id, active: true })
		.returning();
	await assignRole(orgA.id, memTech3.id, roleTechA.id);

	// Admin: Belongs to Team 1
	const userAdmin = await createCredentialUser(f, { name: 'Admin Alicia' });
	const [memAdmin] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userAdmin.id, active: true })
		.returning();
	await assignRole(orgA.id, memAdmin.id, roleAdminA.id);
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memAdmin.id,
		permissionId: 'incidents:assign'
	});
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memAdmin.id,
		permissionId: 'incidents:create'
	});
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memAdmin.id,
		permissionId: 'incidents:view_all'
	});
	const sessionAdmin = await createSession(f, userAdmin.id);

	// Client: No operational role
	const userClient = await createCredentialUser(f, { name: 'Daniel Cliente' });
	const [memClient] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userClient.id, active: true })
		.returning();
	await assignRole(orgA.id, memClient.id, roleClientA.id);
	const sessionClient = await createSession(f, userClient.id);

	// Inactive User
	const userInactive = await createCredentialUser(f, { name: 'Elena Inactiva', active: false });
	const [memInactive] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userInactive.id, active: true })
		.returning();
	await assignRole(orgA.id, memInactive.id, roleTechA.id);

	// Inactive Membership User
	const userMemInactive = await createCredentialUser(f, { name: 'Fabián MemInactiva' });
	const [memInactive2] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userMemInactive.id, active: false })
		.returning();
	await assignRole(orgA.id, memInactive2.id, roleTechA.id);

	// Create Teams in Org A
	const [team1] = await db
		.insert(s.teams)
		.values({
			organizationId: orgA.id,
			name: 'Redes y Comunicaciones',
			description: 'Equipo de soporte de redes'
		})
		.returning();

	const [team2] = await db
		.insert(s.teams)
		.values({
			organizationId: orgA.id,
			name: 'Sistemas y Servidores',
			description: 'Equipo de servidores'
		})
		.returning();

	const [teamInactive] = await db
		.insert(s.teams)
		.values({
			organizationId: orgA.id,
			name: 'Equipo Desactivado',
			description: 'Equipo antiguo inactivo',
			active: false
		})
		.returning();

	// Team in Org B (for cross-tenant tests)
	const [teamB] = await db
		.insert(s.teams)
		.values({
			organizationId: orgB.id,
			name: 'Equipo de Org B',
			description: 'Equipo en otra org'
		})
		.returning();

	// Team memberships in Team 1: userTech1, userTech2, userAdmin
	await db.insert(s.teamMemberships).values([
		{ organizationId: orgA.id, teamId: team1.id, membershipId: memTech1.id, active: true },
		{ organizationId: orgA.id, teamId: team1.id, membershipId: memTech2.id, active: true },
		{ organizationId: orgA.id, teamId: team1.id, membershipId: memAdmin.id, active: true }
	]);

	// Team memberships in Team 2: userTech2, userTech3
	await db.insert(s.teamMemberships).values([
		{ organizationId: orgA.id, teamId: team2.id, membershipId: memTech2.id, active: true },
		{ organizationId: orgA.id, teamId: team2.id, membershipId: memTech3.id, active: true }
	]);

	// Inactive team membership in Team 1
	const userInactiveTM = await createCredentialUser(f, { name: 'Gabriel InactiveTM' });
	const [memInactiveTM] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userInactiveTM.id, active: true })
		.returning();
	await assignRole(orgA.id, memInactiveTM.id, roleTechA.id);
	await db.insert(s.teamMemberships).values({
		organizationId: orgA.id,
		teamId: team1.id,
		membershipId: memInactiveTM.id,
		active: false
	});

	// Inactive team memberships in teamInactive
	await db.insert(s.teamMemberships).values({
		organizationId: orgA.id,
		teamId: teamInactive.id,
		membershipId: memTech1.id,
		active: true
	});

	// Helper to create an incident
	async function createTicket(title = 'Incidencia de prueba') {
		const res = await createIncidentRecord(
			db,
			{ organizationId: orgA.id, creatorUserId: userAdmin.id },
			{
				title,
				description: 'Descripción detallada',
				client: 'Cliente A'
			}
		);
		return res.incident;
	}

	// =========================================================================
	// 1. TESTS TEAMS (getActiveTeams and GET /api/teams)
	// =========================================================================
	await t.test(
		'1. getActiveTeams: devuelve solo equipos activos de la org, ordenados',
		async () => {
			const teams = await getActiveTeams(db, orgA.id);
			assert.equal(teams.length, 2);
			assert.equal(teams[0].name, 'Redes y Comunicaciones');
			assert.equal(teams[1].name, 'Sistemas y Servidores');
			// Minimal fields
			assert.ok(teams[0].id);
			assert.ok(teams[0].description !== undefined);
			assert.equal(teams[0].active, undefined); // Not projected
		}
	);

	await t.test('2. GET /api/teams: autenticación, autorización y aislamiento', async () => {
		// 401 si no autenticado
		const unauthRes = await getTeamsEndpoint({
			url: new URL(`http://localhost/api/teams?organizationId=${orgA.id}`),
			request: new Request(`http://localhost/api/teams?organizationId=${orgA.id}`)
		});
		assert.equal(unauthRes.status, 401);

		// 403 si no tiene incidents:assign
		const forbidRes = await getTeamsEndpoint({
			url: new URL(`http://localhost/api/teams?organizationId=${orgA.id}`),
			request: new Request(`http://localhost/api/teams?organizationId=${orgA.id}`, {
				headers: sessionClient.headers
			})
		});
		assert.equal(forbidRes.status, 403);

		// 400 si organizationId inválido
		const invalidRes = await getTeamsEndpoint({
			url: new URL('http://localhost/api/teams?organizationId=invalid-uuid'),
			request: new Request('http://localhost/api/teams?organizationId=invalid-uuid', {
				headers: sessionTechA.headers
			})
		});
		assert.equal(invalidRes.status, 400);

		// 200 con incidents:assign
		const okRes = await getTeamsEndpoint({
			url: new URL(`http://localhost/api/teams?organizationId=${orgA.id}`),
			request: new Request(`http://localhost/api/teams?organizationId=${orgA.id}`, {
				headers: sessionTechA.headers
			})
		});
		assert.equal(okRes.status, 200);
		const data = await okRes.json();
		assert.ok(Array.isArray(data.teams));
		assert.equal(data.teams.length, 2);
		assert.equal(data.teams[0].name, 'Redes y Comunicaciones');
		assert.equal(data.teams[1].name, 'Sistemas y Servidores');
	});

	// =========================================================================
	// 2. TESTS ASSIGNEES POR TEAM (getAssignableTechnicians and /api/incidents/assignees)
	// =========================================================================
	await t.test('3. getAssignableTechnicians: sin teamId mantiene catálogo completo', async () => {
		const assignees = await getAssignableTechnicians(db, orgA.id);
		// Eligible: Alba (Tech1), Berto (Tech2), Clara (Tech3), Admin Alicia, Gabriel (InactiveTM has active membership/user/role)
		// Excluded: Daniel (Client), Elena (Inactive user), Fabián (Inactive membership)
		const names = assignees.map((a) => a.name);
		assert.ok(names.includes('Alba Redes'));
		assert.ok(names.includes('Berto Multi'));
		assert.ok(names.includes('Clara Sistemas'));
		assert.ok(names.includes('Admin Alicia'));
		assert.ok(!names.includes('Daniel Cliente'));
		assert.ok(!names.includes('Elena Inactiva'));
		assert.ok(!names.includes('Fabián MemInactiva'));
	});

	await t.test(
		'4. getAssignableTechnicians con teamId: filtra miembros activos del equipo',
		async () => {
			// Team 1 members: Alba, Berto, Admin Alicia (Gabriel excluded because teamMembership.active is false)
			const t1Assignees = await getAssignableTechnicians(db, orgA.id, team1.id);
			assert.equal(t1Assignees.length, 3);
			const t1Names = t1Assignees.map((a) => a.name);
			assert.deepEqual(t1Names, ['Admin Alicia', 'Alba Redes', 'Berto Multi']); // Deterministic order name ASC

			// Team 2 members: Berto, Clara
			const t2Assignees = await getAssignableTechnicians(db, orgA.id, team2.id);
			assert.equal(t2Assignees.length, 2);
			const t2Names = t2Assignees.map((a) => a.name);
			assert.deepEqual(t2Names, ['Berto Multi', 'Clara Sistemas']);

			// Inactive team -> safe empty list
			const inactiveAssignees = await getAssignableTechnicians(db, orgA.id, teamInactive.id);
			assert.deepEqual(inactiveAssignees, []);

			// Cross-tenant team -> safe empty list
			const crossAssignees = await getAssignableTechnicians(db, orgA.id, teamB.id);
			assert.deepEqual(crossAssignees, []);
		}
	);

	await t.test(
		'5. GET /api/incidents/assignees?teamId=: endpoint HTTP filtra por equipo',
		async () => {
			const res = await getAssigneesEndpoint({
				url: new URL(
					`http://localhost/api/incidents/assignees?organizationId=${orgA.id}&teamId=${team1.id}`
				),
				request: new Request(
					`http://localhost/api/incidents/assignees?organizationId=${orgA.id}&teamId=${team1.id}`,
					{ headers: sessionTechA.headers }
				)
			});
			assert.equal(res.status, 200);
			const data = await res.json();
			assert.equal(data.assignees.length, 3);
			assert.deepEqual(
				data.assignees.map((a) => a.name),
				['Admin Alicia', 'Alba Redes', 'Berto Multi']
			);

			// Invalid teamId UUID -> 400
			const badRes = await getAssigneesEndpoint({
				url: new URL(
					`http://localhost/api/incidents/assignees?organizationId=${orgA.id}&teamId=not-uuid`
				),
				request: new Request(
					`http://localhost/api/incidents/assignees?organizationId=${orgA.id}&teamId=not-uuid`,
					{ headers: sessionTechA.headers }
				)
			});
			assert.equal(badRes.status, 400);
		}
	);

	// =========================================================================
	// 3. TESTS DETALLE CON EQUIPO (teamId, teamName)
	// =========================================================================
	await t.test('6. getIncidentById: devuelve teamId y teamName enriquecidos', async () => {
		const ticket = await createTicket('Ticket para detalle');
		// Inicialmente sin equipo
		const detail1 = await getIncidentById(db, { organizationId: orgA.id }, ticket.id);
		assert.equal(detail1.incident.teamId, null);
		assert.equal(detail1.incident.teamName, null);

		// Asignar equipo
		await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket.id,
			{ teamId: team1.id }
		);

		const detail2 = await getIncidentById(db, { organizationId: orgA.id }, ticket.id);
		assert.equal(detail2.incident.teamId, team1.id);
		assert.equal(detail2.incident.teamName, 'Redes y Comunicaciones');
	});

	// =========================================================================
	// 4. TESTS SEMÁNTICA DE MUTACIÓN (Casos A-F) Y REASON
	// =========================================================================
	await t.test('7. CASO A: sin equipo/sin técnico -> asignar solo team T', async () => {
		const ticket = await createTicket('Caso A');
		assert.equal(ticket.teamId, null);
		assert.equal(ticket.assignedToUserId, null);

		// Primera asignación: motivo opcional
		const res = await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket.id,
			{ teamId: team1.id }
		);

		assert.equal(res.incident.teamId, team1.id);
		assert.equal(res.incident.assignedToUserId, null);
		assert.equal(res.history.eventType, 'assigned');
		assert.deepEqual(res.history.payload, {
			previousTeamId: null,
			newTeamId: team1.id,
			previousAssigneeUserId: null,
			newAssigneeUserId: null
		});
	});

	await t.test('8. CASO B: sin equipo/sin técnico -> team T + técnico U de T', async () => {
		const ticket = await createTicket('Caso B');

		// Asignación válida
		const res = await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket.id,
			{ teamId: team1.id, assignedToUserId: userTech1.id }
		);

		assert.equal(res.incident.teamId, team1.id);
		assert.equal(res.incident.assignedToUserId, userTech1.id);
		assert.equal(res.history.eventType, 'assigned');
		assert.deepEqual(res.history.payload, {
			previousTeamId: null,
			newTeamId: team1.id,
			previousAssigneeUserId: null,
			newAssigneeUserId: userTech1.id
		});

		// Técnico explícito incompatible (userTech3 NO pertenece a team1) -> 400 INVALID_INPUT
		const ticketFail = await createTicket('Caso B Fail');
		await assert.rejects(
			assignIncidentRecord(
				db,
				{ organizationId: orgA.id, actorUserId: userAdmin.id },
				ticketFail.id,
				{ teamId: team1.id, assignedToUserId: userTech3.id }
			),
			(err) => err.code === 'INVALID_INPUT' && err.message.includes('not an active member')
		);
	});

	await t.test('9. CASO C: técnico U sin equipo -> asignar a team T', async () => {
		// 1. Incidencia con técnico Alba (Team 1) pero sin equipo
		const ticket1 = await createTicket('Caso C compatible');
		await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket1.id,
			{ assignedToUserId: userTech1.id }
		);

		// Reasignación a Team 1: como Alba pertenece a Team 1, se mantiene Alba
		const res1 = await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket1.id,
			{ teamId: team1.id, reason: 'Asignando al equipo de redes' }
		);
		assert.equal(res1.incident.teamId, team1.id);
		assert.equal(res1.incident.assignedToUserId, userTech1.id);
		assert.equal(res1.history.eventType, 'reassigned');

		// 2. Incidencia con técnico Alba asignada a Team 2 (Alba NO pertenece a Team 2) -> auto-clears to null
		const ticket2 = await createTicket('Caso C incompatible');
		await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket2.id,
			{ assignedToUserId: userTech1.id }
		);

		const res2 = await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket2.id,
			{ teamId: team2.id, reason: 'Derivación a sistemas' }
		);
		assert.equal(res2.incident.teamId, team2.id);
		assert.equal(res2.incident.assignedToUserId, null); // Auto-clear!
		assert.equal(res2.history.eventType, 'reassigned');
		assert.deepEqual(res2.history.payload, {
			previousTeamId: null,
			newTeamId: team2.id,
			previousAssigneeUserId: userTech1.id,
			newAssigneeUserId: null
		});
	});

	await t.test('10. CASO D: team T1 + técnico U1 -> team T2', async () => {
		// Caso D1: Cambiar equipo enviando nuevo técnico válido U2 de T2
		const ticket1 = await createTicket('Caso D1');
		await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket1.id,
			{ teamId: team1.id, assignedToUserId: userTech1.id }
		);

		const res1 = await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket1.id,
			{ teamId: team2.id, assignedToUserId: userTech3.id, reason: 'Pasa a sistemas con Clara' }
		);
		assert.equal(res1.incident.teamId, team2.id);
		assert.equal(res1.incident.assignedToUserId, userTech3.id);

		// Caso D2: Cambiar equipo enviando técnico U no perteneciente a T2 -> rechazo 400
		await assert.rejects(
			assignIncidentRecord(db, { organizationId: orgA.id, actorUserId: userAdmin.id }, ticket1.id, {
				teamId: team2.id,
				assignedToUserId: userTech1.id,
				reason: 'Intento inválido'
			}),
			(err) => err.code === 'INVALID_INPUT'
		);

		// Caso D3: Cambiar equipo sin enviar técnico, técnico actual compatible (Berto está en T1 y T2)
		const ticket3 = await createTicket('Caso D3 Berto');
		await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket3.id,
			{ teamId: team1.id, assignedToUserId: userTech2.id }
		);

		const res3 = await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket3.id,
			{ teamId: team2.id, reason: 'Cambio de equipo conservando a Berto' }
		);
		assert.equal(res3.incident.teamId, team2.id);
		assert.equal(res3.incident.assignedToUserId, userTech2.id); // Berto se conserva

		// Caso D4: Cambiar equipo sin enviar técnico, técnico actual incompatible (Alba no está en T2) -> auto-clears
		const ticket4 = await createTicket('Caso D4 Alba');
		await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket4.id,
			{ teamId: team1.id, assignedToUserId: userTech1.id }
		);

		const res4 = await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket4.id,
			{ teamId: team2.id, reason: 'Cambio de equipo limpia a Alba' }
		);
		assert.equal(res4.incident.teamId, team2.id);
		assert.equal(res4.incident.assignedToUserId, null); // Auto-clear!
	});

	await t.test('11. CASO E: team T + técnico U -> cambiar solo técnico dentro de T', async () => {
		const ticket = await createTicket('Caso E');
		await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket.id,
			{ teamId: team1.id, assignedToUserId: userTech1.id }
		);

		// Cambiar a Berto (miembro de T1) -> OK
		const res = await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket.id,
			{ assignedToUserId: userTech2.id, reason: 'Pasa a Berto dentro de Redes' }
		);
		assert.equal(res.incident.teamId, team1.id);
		assert.equal(res.incident.assignedToUserId, userTech2.id);

		// Cambiar a Clara (NO miembro de T1) -> rechazo 400
		await assert.rejects(
			assignIncidentRecord(db, { organizationId: orgA.id, actorUserId: userAdmin.id }, ticket.id, {
				assignedToUserId: userTech3.id,
				reason: 'Intento asignar técnica de otro equipo'
			}),
			(err) => err.code === 'INVALID_INPUT'
		);
	});

	await t.test('12. CASO F: team=null + técnico U directo', async () => {
		const ticket = await createTicket('Caso F');
		const res = await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket.id,
			{ teamId: null, assignedToUserId: userTech1.id }
		);
		assert.equal(res.incident.teamId, null);
		assert.equal(res.incident.assignedToUserId, userTech1.id);
	});

	await t.test(
		'13. No-Op: valores idénticos no modifican DB, no alteran updatedAt, no crean historial',
		async () => {
			const ticket = await createTicket('No-op test');
			const initial = await assignIncidentRecord(
				db,
				{ organizationId: orgA.id, actorUserId: userAdmin.id },
				ticket.id,
				{ teamId: team1.id, assignedToUserId: userTech1.id }
			);

			const updatedTime = initial.incident.updatedAt;

			// Reasignación no-op (sin reason)
			const noop = await assignIncidentRecord(
				db,
				{ organizationId: orgA.id, actorUserId: userAdmin.id },
				ticket.id,
				{ teamId: team1.id, assignedToUserId: userTech1.id }
			);

			assert.equal(noop.incident.updatedAt.getTime(), updatedTime.getTime());
			assert.equal(noop.history, undefined);

			// Verificar en historial que solo hay 2 eventos: created y assigned
			const detail = await getIncidentById(db, { organizationId: orgA.id }, ticket.id);
			assert.equal('history' in detail, false);
			const persisted = await db
				.select()
				.from(s.incidentHistory)
				.where(eq(s.incidentHistory.incidentId, ticket.id));
			assert.equal(persisted.length, 2);
		}
	);

	await t.test('14. Exigencia estricta de Reason en reasignaciones', async () => {
		const ticket = await createTicket('Reason test');
		// Primera asignación (no requiere motivo)
		await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			ticket.id,
			{ teamId: team1.id }
		);

		// Reasignación sin motivo -> Error INVALID_INPUT
		await assert.rejects(
			assignIncidentRecord(db, { organizationId: orgA.id, actorUserId: userAdmin.id }, ticket.id, {
				teamId: team2.id
			}),
			(err) => err.code === 'INVALID_INPUT' && err.message.includes('Reason is required')
		);

		// Reasignación con motivo vacío/espacios -> Error INVALID_INPUT
		await assert.rejects(
			assignIncidentRecord(db, { organizationId: orgA.id, actorUserId: userAdmin.id }, ticket.id, {
				teamId: team2.id,
				reason: '   '
			}),
			(err) => err.code === 'INVALID_INPUT'
		);
	});

	// =========================================================================
	// 5. TESTS ENDPOINT POST /api/incidents/[id]/assign
	// =========================================================================
	await t.test('15. POST /api/incidents/[id]/assign vía HTTP', async () => {
		const ticket = await createTicket('HTTP assign test');

		// Asignar equipo vía HTTP
		const res1 = await assignEndpoint({
			params: { id: ticket.id },
			url: new URL(`http://localhost/api/incidents/${ticket.id}/assign?organizationId=${orgA.id}`),
			request: new Request(
				`http://localhost/api/incidents/${ticket.id}/assign?organizationId=${orgA.id}`,
				{
					method: 'POST',
					headers: {
						...Object.fromEntries(sessionAdmin.headers),
						'content-type': 'application/json'
					},
					body: JSON.stringify({ teamId: team1.id, assignedToUserId: userTech1.id })
				}
			)
		});

		assert.equal(res1.status, 200);
		const data1 = await res1.json();
		assert.equal(data1.incident.teamId, team1.id);
		assert.equal(data1.incident.assignedToUserId, userTech1.id);
		assert.equal(data1.history, undefined); // History no expuesto en HTTP

		// Reasignar sin motivo -> 400
		const resFail = await assignEndpoint({
			params: { id: ticket.id },
			url: new URL(`http://localhost/api/incidents/${ticket.id}/assign?organizationId=${orgA.id}`),
			request: new Request(
				`http://localhost/api/incidents/${ticket.id}/assign?organizationId=${orgA.id}`,
				{
					method: 'POST',
					headers: {
						...Object.fromEntries(sessionAdmin.headers),
						'content-type': 'application/json'
					},
					body: JSON.stringify({ teamId: team2.id })
				}
			)
		});
		assert.equal(resFail.status, 400);

		// Reasignar con motivo -> 200
		const resOk = await assignEndpoint({
			params: { id: ticket.id },
			url: new URL(`http://localhost/api/incidents/${ticket.id}/assign?organizationId=${orgA.id}`),
			request: new Request(
				`http://localhost/api/incidents/${ticket.id}/assign?organizationId=${orgA.id}`,
				{
					method: 'POST',
					headers: {
						...Object.fromEntries(sessionAdmin.headers),
						'content-type': 'application/json'
					},
					body: JSON.stringify({ teamId: team2.id, reason: 'Escalado a sistemas' })
				}
			)
		});
		assert.equal(resOk.status, 200);
		const dataOk = await resOk.json();
		assert.equal(dataOk.incident.teamId, team2.id);
		assert.equal(dataOk.incident.assignedToUserId, null); // Auto-cleared!
	});

	// =========================================================================
	// 6. TESTS LISTADO Y FILTRO POR EQUIPO + PRESERVACIÓN DE queue=unassigned
	// =========================================================================
	await t.test('16. listIncidents con teamId y preservación de queue=unassigned', async () => {
		// Ticket 1: Team 1, sin técnico
		const inc1 = await createTicket('Filtro 1');
		await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			inc1.id,
			{ teamId: team1.id }
		);

		// Ticket 2: Team 1, con técnico Alba
		const inc2 = await createTicket('Filtro 2');
		await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			inc2.id,
			{ teamId: team1.id, assignedToUserId: userTech1.id }
		);

		// Ticket 3: Team 2, con técnico Berto
		const inc3 = await createTicket('Filtro 3');
		await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			inc3.id,
			{ teamId: team2.id, assignedToUserId: userTech2.id }
		);

		// 1. Filtrar por teamId = team1
		const listTeam1 = await listIncidents(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			{ teamId: team1.id }
		);
		assert.ok(listTeam1.length >= 2);
		assert.ok(listTeam1.some((i) => i.id === inc1.id));
		assert.ok(listTeam1.some((i) => i.id === inc2.id));
		assert.ok(!listTeam1.some((i) => i.id === inc3.id));
		assert.ok(listTeam1.every((i) => i.teamId === team1.id));

		// 2. queue=unassigned sigue significando assigned_to_user_id IS NULL
		// Incluye inc1 aunque inc1 tenga teamId = team1
		const unassigned = await listIncidents(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			{ queue: 'unassigned' }
		);
		const inc1Found = unassigned.find((i) => i.id === inc1.id);
		assert.ok(inc1Found);
		assert.equal(inc1Found.assignedToUserId, null);
		assert.equal(inc1Found.teamId, team1.id);

		// 3. Combinar queue=unassigned + teamId=team1 -> debe incluir inc1 y no inc2 ni inc3
		const unassignedTeam1 = await listIncidents(
			db,
			{ organizationId: orgA.id, actorUserId: userAdmin.id },
			{ queue: 'unassigned', teamId: team1.id }
		);
		assert.ok(unassignedTeam1.some((i) => i.id === inc1.id));
		assert.ok(!unassignedTeam1.some((i) => i.id === inc2.id));
		assert.ok(!unassignedTeam1.some((i) => i.id === inc3.id));
		assert.ok(unassignedTeam1.every((i) => i.assignedToUserId === null && i.teamId === team1.id));
	});
});

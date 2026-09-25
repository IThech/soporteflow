import { eq, asc } from 'drizzle-orm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
	fixture,
	createCredentialUser,
	createSession,
	grantPermission
} from './helpers/auth-fixture.mjs';
import { getIncident, IncidentApiError } from '../src/lib/api/incidents.ts';

async function persistedHistory(db, schema, incidentId) {
	return (
		await db
			.select()
			.from(schema.incidentHistory)
			.where(eq(schema.incidentHistory.incidentId, incidentId))
			.orderBy(asc(schema.incidentHistory.createdAt), asc(schema.incidentHistory.id))
	).map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

test('SoporteFlow — Etapa 5.4L-A: Backend real de niveles N1 / N2 / N3', async (t) => {
	const f = await fixture(t, true);
	const { db, schema: s, server, pg } = f;

	// Load services and endpoints via ssrLoadModule
	const {
		createIncidentRecord,
		getIncidentById,
		updateIncidentSupportLevel,
		assignIncidentRecord
	} = await server.ssrLoadModule('/src/lib/server/services/incidents.ts');

	const { POST: createIncidentEndpoint, GET: listIncidentsEndpoint } = await server.ssrLoadModule(
		'/src/routes/api/incidents/+server.ts'
	);

	const { GET: getIncidentEndpoint } = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/+server.ts'
	);

	const { PATCH: updateSupportLevelEndpoint } = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/support-level/+server.ts'
	);

	const { POST: assignEndpoint } = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/assign/+server.ts'
	);

	// Setup Organizations A and B
	const [orgA] = await db
		.insert(s.organizations)
		.values({ name: 'Org Soporte A', slug: 'org-soporte-a-' + randomUUID(), status: 'active' })
		.returning();

	const [orgB] = await db
		.insert(s.organizations)
		.values({ name: 'Org Soporte B', slug: 'org-soporte-b-' + randomUUID(), status: 'active' })
		.returning();

	// Helper to create and assign roles
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

	const roleAdminA = await createRole(orgA.id, 'Admin', 'organization_admin');
	const roleTechA = await createRole(orgA.id, 'Técnico', 'technician');
	const roleViewerA = await createRole(orgA.id, 'Viewer', 'viewer');

	// Admin User in Org A (with incidents:create, incidents:view_all, incidents:edit, incidents:assign)
	const userAdminA = await createCredentialUser(f, { name: 'Admin Alicia' });
	const [memAdminA] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userAdminA.id, active: true })
		.returning();
	await assignRole(orgA.id, memAdminA.id, roleAdminA.id);
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memAdminA.id,
		permissionId: 'incidents:create'
	});
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memAdminA.id,
		permissionId: 'incidents:view_all'
	});
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memAdminA.id,
		permissionId: 'incidents:edit'
	});
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memAdminA.id,
		permissionId: 'incidents:assign'
	});
	const sessionAdminA = await createSession(f, userAdminA.id);

	// Viewer User in Org A (only incidents:view_all, NO incidents:edit)
	const userViewerA = await createCredentialUser(f, { name: 'Viewer Victor' });
	const [memViewerA] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userViewerA.id, active: true })
		.returning();
	await assignRole(orgA.id, memViewerA.id, roleViewerA.id);
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memViewerA.id,
		permissionId: 'incidents:view_all'
	});
	const sessionViewerA = await createSession(f, userViewerA.id);

	// Technician in Org A
	const userTechA = await createCredentialUser(f, { name: 'Tech Tom' });
	const [memTechA] = await db
		.insert(s.memberships)
		.values({ organizationId: orgA.id, userId: userTechA.id, active: true })
		.returning();
	await assignRole(orgA.id, memTechA.id, roleTechA.id);

	// Team in Org A
	const [teamA] = await db
		.insert(s.teams)
		.values({ organizationId: orgA.id, name: 'Equipo Redes', active: true })
		.returning();

	// Team membership for Tech Tom
	await db.insert(s.teamMemberships).values({
		organizationId: orgA.id,
		teamId: teamA.id,
		membershipId: memTechA.id,
		active: true
	});

	// Admin User in Org B
	const roleAdminB = await createRole(orgB.id, 'Admin B', 'organization_admin');
	const userAdminB = await createCredentialUser(f, { name: 'Admin Bruno' });
	const [memAdminB] = await db
		.insert(s.memberships)
		.values({ organizationId: orgB.id, userId: userAdminB.id, active: true })
		.returning();
	await assignRole(orgB.id, memAdminB.id, roleAdminB.id);
	await grantPermission(f, {
		organizationId: orgB.id,
		membershipId: memAdminB.id,
		permissionId: 'incidents:create'
	});
	await grantPermission(f, {
		organizationId: orgB.id,
		membershipId: memAdminB.id,
		permissionId: 'incidents:view_all'
	});
	await grantPermission(f, {
		organizationId: orgB.id,
		membershipId: memAdminB.id,
		permissionId: 'incidents:edit'
	});
	const sessionAdminB = await createSession(f, userAdminB.id);

	// Helper to create incident via service in Org A
	async function createTicket(title, extra = {}) {
		const res = await createIncidentRecord(
			db,
			{ organizationId: orgA.id, creatorUserId: userAdminA.id },
			{
				title,
				description: 'Descripción para ' + title,
				client: 'Cliente Demo',
				priority: extra.priority || 'medium',
				siteId: extra.siteId || null
			}
		);
		return res.incident;
	}

	// =========================================================================
	// 1. Migración / schema
	// =========================================================================
	await t.test(
		'1. Schema: support_level column, check constraint, and event_type constraint',
		async () => {
			// Verify support_level column defaults to N1 and is not null
			const colsResult = await pg.query(
				`SELECT column_name, data_type, column_default, is_nullable
			 FROM information_schema.columns
			 WHERE table_name = 'incidents' AND column_name = 'support_level';`
			);
			assert.equal(colsResult.rows.length, 1);
			assert.equal(colsResult.rows[0].column_name, 'support_level');
			assert.match(colsResult.rows[0].column_default, /N1/);
			assert.equal(colsResult.rows[0].is_nullable, 'NO');

			// Verify check constraint on incidents allows only N1, N2, N3
			const ticket = await createTicket('Schema Check Ticket');
			assert.equal(ticket.supportLevel, 'N1');

			// Attempt direct invalid insert bypassing TypeScript
			await assert.rejects(
				pg.query(
					`INSERT INTO incidents (id, organization_id, incident_number, title, description, client, status, priority, support_level, created_by_user_id)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
					[
						randomUUID(),
						orgA.id,
						9999,
						'Invalid Level Check',
						'Desc',
						'Client',
						'open',
						'medium',
						'N4',
						userAdminA.id
					]
				),
				(err) =>
					/incidents_support_level_check/.test(err.message) || /check constraint/i.test(err.message)
			);

			// Verify incident_history accepts 'support_level_changed'
			const histInsert = await pg.query(
				`INSERT INTO incident_history (id, incident_id, organization_id, event_type, actor_type, actor_user_id, reason, payload)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 RETURNING event_type;`,
				[
					randomUUID(),
					ticket.id,
					orgA.id,
					'support_level_changed',
					'user',
					userAdminA.id,
					'Escalado a N2 para revisión',
					JSON.stringify({ previousSupportLevel: 'N1', newSupportLevel: 'N2' })
				]
			);
			assert.equal(histInsert.rows[0].event_type, 'support_level_changed');
		}
	);

	// =========================================================================
	// 2. Creación por defecto (siempre N1)
	// =========================================================================
	await t.test('2. Incident creation defaults to N1 without breaking history', async () => {
		const ticket = await createTicket('Default N1 Ticket');
		assert.equal(ticket.supportLevel, 'N1');

		const detail = await getIncidentById(db, { organizationId: orgA.id }, ticket.id);
		assert.ok(detail);
		assert.equal(detail.incident.supportLevel, 'N1');
		assert.equal((await persistedHistory(db, s, detail.incident.id)).length, 1);
		assert.equal((await persistedHistory(db, s, detail.incident.id))[0].eventType, 'created');
	});

	// =========================================================================
	// 3. Rechazo de supportLevel en creación (POST /api/incidents)
	// =========================================================================
	await t.test('3. POST /api/incidents rejects supportLevel in body (both N2 and N1)', async () => {
		// Attempting to specify supportLevel: 'N2'
		const resN2 = await createIncidentEndpoint({
			url: new URL('http://localhost/api/incidents'),
			request: new Request('http://localhost/api/incidents', {
				method: 'POST',
				headers: {
					...Object.fromEntries(sessionAdminA.headers),
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					organizationId: orgA.id,
					title: 'Intento N2 en creacion',
					description: 'Desc',
					client: 'Cliente Demo',
					priority: 'high',
					supportLevel: 'N2'
				})
			})
		});
		assert.equal(resN2.status, 400);
		const dataN2 = await resN2.json();
		assert.equal(dataN2.error.code, 'INVALID_INPUT');

		// Attempting to specify supportLevel: 'N1'
		const resN1 = await createIncidentEndpoint({
			url: new URL('http://localhost/api/incidents'),
			request: new Request('http://localhost/api/incidents', {
				method: 'POST',
				headers: {
					...Object.fromEntries(sessionAdminA.headers),
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					organizationId: orgA.id,
					title: 'Intento N1 en creacion',
					description: 'Desc',
					client: 'Cliente Demo',
					priority: 'medium',
					supportLevel: 'N1'
				})
			})
		});
		assert.equal(resN1.status, 400);
		const dataN1 = await resN1.json();
		assert.equal(dataN1.error.code, 'INVALID_INPUT');
	});

	// =========================================================================
	// 4. Transición N1 -> N2
	// =========================================================================
	await t.test('4. Transition N1 -> N2 with reason succeeds with audit history', async () => {
		const ticket = await createTicket('Ticket N1 to N2');
		assert.equal(ticket.supportLevel, 'N1');

		const res = await updateSupportLevelEndpoint({
			params: { id: ticket.id },
			url: new URL(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
			),
			request: new Request(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
				{
					method: 'PATCH',
					headers: {
						...Object.fromEntries(sessionAdminA.headers),
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						supportLevel: 'N2',
						reason: 'Requiere revisión técnica avanzada de N2'
					})
				}
			)
		});

		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.incident.supportLevel, 'N2');
		assert.equal(data.history, undefined); // History not leaked in response

		const detail = await getIncidentById(db, { organizationId: orgA.id }, ticket.id);
		assert.equal(detail.incident.supportLevel, 'N2');
		assert.equal((await persistedHistory(db, s, detail.incident.id)).length, 2);
		const lastEvent = (await persistedHistory(db, s, detail.incident.id))[1];
		assert.equal(lastEvent.eventType, 'support_level_changed');
		assert.equal(lastEvent.reason, 'Requiere revisión técnica avanzada de N2');
		assert.deepEqual(lastEvent.payload, {
			previousSupportLevel: 'N1',
			newSupportLevel: 'N2'
		});
	});

	// =========================================================================
	// 5. Transición N2 -> N3
	// =========================================================================
	await t.test('5. Transition N2 -> N3 with reason succeeds with audit history', async () => {
		const ticket = await createTicket('Ticket N2 to N3');
		await updateIncidentSupportLevel(
			db,
			{ organizationId: orgA.id, actorUserId: userAdminA.id },
			ticket.id,
			{ supportLevel: 'N2', reason: 'A nivel 2' }
		);

		const res = await updateSupportLevelEndpoint({
			params: { id: ticket.id },
			url: new URL(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
			),
			request: new Request(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
				{
					method: 'PATCH',
					headers: {
						...Object.fromEntries(sessionAdminA.headers),
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						supportLevel: 'N3',
						reason: 'Escalado a ingeniería de N3 por fallo en el kernel'
					})
				}
			)
		});

		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.incident.supportLevel, 'N3');

		const detail = await getIncidentById(db, { organizationId: orgA.id }, ticket.id);
		assert.equal(detail.incident.supportLevel, 'N3');
		const lastEvent = (await persistedHistory(db, s, detail.incident.id))[
			(await persistedHistory(db, s, detail.incident.id)).length - 1
		];
		assert.equal(lastEvent.eventType, 'support_level_changed');
		assert.deepEqual(lastEvent.payload, {
			previousSupportLevel: 'N2',
			newSupportLevel: 'N3'
		});
	});

	// =========================================================================
	// 6. Salto directo N1 -> N3
	// =========================================================================
	await t.test('6. Direct jump N1 -> N3 with reason is permitted', async () => {
		const ticket = await createTicket('Direct Jump N1 to N3');
		assert.equal(ticket.supportLevel, 'N1');

		const res = await updateSupportLevelEndpoint({
			params: { id: ticket.id },
			url: new URL(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
			),
			request: new Request(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
				{
					method: 'PATCH',
					headers: {
						...Object.fromEntries(sessionAdminA.headers),
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						supportLevel: 'N3',
						reason: 'Incidencia crítica que amerita salto directo a N3'
					})
				}
			)
		});

		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.incident.supportLevel, 'N3');

		const detail = await getIncidentById(db, { organizationId: orgA.id }, ticket.id);
		const lastEvent = (await persistedHistory(db, s, detail.incident.id))[
			(await persistedHistory(db, s, detail.incident.id)).length - 1
		];
		assert.equal(lastEvent.eventType, 'support_level_changed');
		assert.deepEqual(lastEvent.payload, {
			previousSupportLevel: 'N1',
			newSupportLevel: 'N3'
		});
	});

	// =========================================================================
	// 7. Desescalado N3 -> N2
	// =========================================================================
	await t.test('7. De-escalation N3 -> N2 with reason is permitted', async () => {
		const ticket = await createTicket('De-escalate N3 to N2');
		await updateIncidentSupportLevel(
			db,
			{ organizationId: orgA.id, actorUserId: userAdminA.id },
			ticket.id,
			{ supportLevel: 'N3', reason: 'A nivel 3' }
		);

		const res = await updateSupportLevelEndpoint({
			params: { id: ticket.id },
			url: new URL(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
			),
			request: new Request(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
				{
					method: 'PATCH',
					headers: {
						...Object.fromEntries(sessionAdminA.headers),
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						supportLevel: 'N2',
						reason: 'Bug resuelto por core, devuelto a N2 para pruebas'
					})
				}
			)
		});

		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.incident.supportLevel, 'N2');

		const detail = await getIncidentById(db, { organizationId: orgA.id }, ticket.id);
		const lastEvent = (await persistedHistory(db, s, detail.incident.id))[
			(await persistedHistory(db, s, detail.incident.id)).length - 1
		];
		assert.equal(lastEvent.eventType, 'support_level_changed');
		assert.deepEqual(lastEvent.payload, {
			previousSupportLevel: 'N3',
			newSupportLevel: 'N2'
		});
	});

	// =========================================================================
	// 8. Desescalado N3 -> N1
	// =========================================================================
	await t.test('8. De-escalation N3 -> N1 with reason is permitted', async () => {
		const ticket = await createTicket('De-escalate N3 to N1');
		await updateIncidentSupportLevel(
			db,
			{ organizationId: orgA.id, actorUserId: userAdminA.id },
			ticket.id,
			{ supportLevel: 'N3', reason: 'A nivel 3' }
		);

		const res = await updateSupportLevelEndpoint({
			params: { id: ticket.id },
			url: new URL(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
			),
			request: new Request(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
				{
					method: 'PATCH',
					headers: {
						...Object.fromEntries(sessionAdminA.headers),
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						supportLevel: 'N1',
						reason: 'Falsa alarma, devuelto directamente a mesa de ayuda N1'
					})
				}
			)
		});

		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.incident.supportLevel, 'N1');

		const detail = await getIncidentById(db, { organizationId: orgA.id }, ticket.id);
		const lastEvent = (await persistedHistory(db, s, detail.incident.id))[
			(await persistedHistory(db, s, detail.incident.id)).length - 1
		];
		assert.equal(lastEvent.eventType, 'support_level_changed');
		assert.deepEqual(lastEvent.payload, {
			previousSupportLevel: 'N3',
			newSupportLevel: 'N1'
		});
	});

	// =========================================================================
	// 9. Desescalado N2 -> N1
	// =========================================================================
	await t.test('9. De-escalation N2 -> N1 with reason is permitted', async () => {
		const ticket = await createTicket('De-escalate N2 to N1');
		await updateIncidentSupportLevel(
			db,
			{ organizationId: orgA.id, actorUserId: userAdminA.id },
			ticket.id,
			{ supportLevel: 'N2', reason: 'A nivel 2' }
		);

		const res = await updateSupportLevelEndpoint({
			params: { id: ticket.id },
			url: new URL(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
			),
			request: new Request(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
				{
					method: 'PATCH',
					headers: {
						...Object.fromEntries(sessionAdminA.headers),
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						supportLevel: 'N1',
						reason: 'No requiere soporte nivel 2'
					})
				}
			)
		});

		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.incident.supportLevel, 'N1');

		const detail = await getIncidentById(db, { organizationId: orgA.id }, ticket.id);
		const lastEvent = (await persistedHistory(db, s, detail.incident.id))[
			(await persistedHistory(db, s, detail.incident.id)).length - 1
		];
		assert.equal(lastEvent.eventType, 'support_level_changed');
		assert.deepEqual(lastEvent.payload, {
			previousSupportLevel: 'N2',
			newSupportLevel: 'N1'
		});
	});

	// =========================================================================
	// 10. No-op (mismo nivel)
	// =========================================================================
	await t.test(
		'10. Same level no-op returns 200 without DB update, updatedAt change, or history',
		async () => {
			const ticket = await createTicket('No-op Support Level Ticket');
			const initialDetail = await getIncidentById(db, { organizationId: orgA.id }, ticket.id);
			const initialUpdatedAt = initialDetail.incident.updatedAt;

			// 10.1 No-op with reason
			const resWithReason = await updateSupportLevelEndpoint({
				params: { id: ticket.id },
				url: new URL(
					`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
				),
				request: new Request(
					`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
					{
						method: 'PATCH',
						headers: {
							...Object.fromEntries(sessionAdminA.headers),
							'content-type': 'application/json'
						},
						body: JSON.stringify({
							supportLevel: 'N1',
							reason: 'Mismo nivel pero con motivo'
						})
					}
				)
			});
			assert.equal(resWithReason.status, 200);
			const dataWithReason = await resWithReason.json();
			assert.equal(dataWithReason.incident.supportLevel, 'N1');

			// 10.2 No-op without reason (must NOT require reason)
			const resWithoutReason = await updateSupportLevelEndpoint({
				params: { id: ticket.id },
				url: new URL(
					`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
				),
				request: new Request(
					`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
					{
						method: 'PATCH',
						headers: {
							...Object.fromEntries(sessionAdminA.headers),
							'content-type': 'application/json'
						},
						body: JSON.stringify({
							supportLevel: 'N1'
						})
					}
				)
			});
			assert.equal(resWithoutReason.status, 200);

			// Verify updatedAt was NOT changed and NO new history record was created
			const afterDetail = await getIncidentById(db, { organizationId: orgA.id }, ticket.id);
			assert.equal(afterDetail.incident.updatedAt.getTime(), initialUpdatedAt.getTime());
			assert.equal((await persistedHistory(db, s, afterDetail.incident.id)).length, 1);
			assert.equal(
				(await persistedHistory(db, s, afterDetail.incident.id))[0].eventType,
				'created'
			);
		}
	);

	// =========================================================================
	// 11. Validación de motivo
	// =========================================================================
	await t.test(
		'11. Reason validation: required on change, rejects whitespace, non-string',
		async () => {
			const ticket = await createTicket('Reason Validation Ticket');

			// Missing reason on level change -> 400
			const resMissing = await updateSupportLevelEndpoint({
				params: { id: ticket.id },
				url: new URL(
					`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
				),
				request: new Request(
					`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
					{
						method: 'PATCH',
						headers: {
							...Object.fromEntries(sessionAdminA.headers),
							'content-type': 'application/json'
						},
						body: JSON.stringify({
							supportLevel: 'N2'
						})
					}
				)
			});
			assert.equal(resMissing.status, 400);
			const dataMissing = await resMissing.json();
			assert.equal(dataMissing.error.code, 'INVALID_INPUT');

			// Whitespace-only reason on level change -> 400
			const resWhitespace = await updateSupportLevelEndpoint({
				params: { id: ticket.id },
				url: new URL(
					`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
				),
				request: new Request(
					`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
					{
						method: 'PATCH',
						headers: {
							...Object.fromEntries(sessionAdminA.headers),
							'content-type': 'application/json'
						},
						body: JSON.stringify({
							supportLevel: 'N2',
							reason: '   '
						})
					}
				)
			});
			assert.equal(resWhitespace.status, 400);
			const dataWhitespace = await resWhitespace.json();
			assert.equal(dataWhitespace.error.code, 'INVALID_INPUT');

			// Non-string reason -> 400
			const resNonString = await updateSupportLevelEndpoint({
				params: { id: ticket.id },
				url: new URL(
					`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
				),
				request: new Request(
					`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
					{
						method: 'PATCH',
						headers: {
							...Object.fromEntries(sessionAdminA.headers),
							'content-type': 'application/json'
						},
						body: JSON.stringify({
							supportLevel: 'N2',
							reason: 12345
						})
					}
				)
			});
			assert.equal(resNonString.status, 400);
			const dataNonString = await resNonString.json();
			assert.equal(dataNonString.error.code, 'INVALID_INPUT');
		}
	);

	// =========================================================================
	// 12. Nivel inválido
	// =========================================================================
	await t.test(
		'12. Invalid supportLevel values (N4, n1, empty, null, missing) -> 400 INVALID_INPUT',
		async () => {
			const ticket = await createTicket('Invalid Level Ticket');

			const invalidValues = ['N4', 'n1', '', null, undefined, 2, 'LEVEL_1'];

			for (const val of invalidValues) {
				const body = { reason: 'Motivo de prueba' };
				if (val !== undefined) {
					body.supportLevel = val;
				}
				const res = await updateSupportLevelEndpoint({
					params: { id: ticket.id },
					url: new URL(
						`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
					),
					request: new Request(
						`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
						{
							method: 'PATCH',
							headers: {
								...Object.fromEntries(sessionAdminA.headers),
								'content-type': 'application/json'
							},
							body: JSON.stringify(body)
						}
					)
				});
				assert.equal(res.status, 400, `Expected 400 for value: ${val}`);
				const data = await res.json();
				assert.equal(data.error.code, 'INVALID_INPUT');
			}
		}
	);

	// =========================================================================
	// 13. Propiedades extra en body
	// =========================================================================
	await t.test('13. Extra properties in body -> 400 INVALID_INPUT', async () => {
		const ticket = await createTicket('Extra Props Ticket');

		const res = await updateSupportLevelEndpoint({
			params: { id: ticket.id },
			url: new URL(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
			),
			request: new Request(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
				{
					method: 'PATCH',
					headers: {
						...Object.fromEntries(sessionAdminA.headers),
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						supportLevel: 'N2',
						reason: 'Motivo valido',
						teamId: teamA.id, // Not allowed on support-level endpoint
						extraField: 'intruder'
					})
				}
			)
		});
		assert.equal(res.status, 400);
		const data = await res.json();
		assert.equal(data.error.code, 'INVALID_INPUT');
		assert.match(data.error.message, /Unknown property/i);
	});

	// =========================================================================
	// 14. Independencia de asignación
	// =========================================================================
	await t.test(
		'14. Assignment independence: changing level preserves team and technician, and reassigning preserves level',
		async () => {
			// 14.1 Unassigned ticket changes level
			const ticket = await createTicket('Independence Ticket');
			assert.equal(ticket.teamId, null);
			assert.equal(ticket.assignedToUserId, null);

			const resLevel = await updateSupportLevelEndpoint({
				params: { id: ticket.id },
				url: new URL(
					`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
				),
				request: new Request(
					`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
					{
						method: 'PATCH',
						headers: {
							...Object.fromEntries(sessionAdminA.headers),
							'content-type': 'application/json'
						},
						body: JSON.stringify({
							supportLevel: 'N2',
							reason: 'Pase a N2 sin asignar'
						})
					}
				)
			});
			assert.equal(resLevel.status, 200);
			const dataLevel = await resLevel.json();
			assert.equal(dataLevel.incident.supportLevel, 'N2');
			assert.equal(dataLevel.incident.teamId, null);
			assert.equal(dataLevel.incident.assignedToUserId, null);

			// 14.2 Assign team and technician via assignment endpoint
			const resAssign = await assignEndpoint({
				params: { id: ticket.id },
				url: new URL(
					`http://localhost/api/incidents/${ticket.id}/assign?organizationId=${orgA.id}`
				),
				request: new Request(
					`http://localhost/api/incidents/${ticket.id}/assign?organizationId=${orgA.id}`,
					{
						method: 'POST',
						headers: {
							...Object.fromEntries(sessionAdminA.headers),
							'content-type': 'application/json'
						},
						body: JSON.stringify({
							teamId: teamA.id,
							assignedToUserId: userTechA.id
						})
					}
				)
			});
			assert.equal(resAssign.status, 200);
			const dataAssign = await resAssign.json();
			assert.equal(dataAssign.incident.teamId, teamA.id);
			assert.equal(dataAssign.incident.assignedToUserId, userTechA.id);
			assert.equal(dataAssign.incident.supportLevel, 'N2'); // supportLevel preserved!

			// 14.3 Change supportLevel to N3 -> team and technician remain intact
			const resLevel3 = await updateSupportLevelEndpoint({
				params: { id: ticket.id },
				url: new URL(
					`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
				),
				request: new Request(
					`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
					{
						method: 'PATCH',
						headers: {
							...Object.fromEntries(sessionAdminA.headers),
							'content-type': 'application/json'
						},
						body: JSON.stringify({
							supportLevel: 'N3',
							reason: 'Escalado a N3 manteniendo equipo y técnico'
						})
					}
				)
			});
			assert.equal(resLevel3.status, 200);
			const dataLevel3 = await resLevel3.json();
			assert.equal(dataLevel3.incident.supportLevel, 'N3');
			assert.equal(dataLevel3.incident.teamId, teamA.id);
			assert.equal(dataLevel3.incident.assignedToUserId, userTechA.id);

			// 14.4 Clear technician (reassign to team only) -> supportLevel N3 remains intact
			const resClearTech = await assignEndpoint({
				params: { id: ticket.id },
				url: new URL(
					`http://localhost/api/incidents/${ticket.id}/assign?organizationId=${orgA.id}`
				),
				request: new Request(
					`http://localhost/api/incidents/${ticket.id}/assign?organizationId=${orgA.id}`,
					{
						method: 'POST',
						headers: {
							...Object.fromEntries(sessionAdminA.headers),
							'content-type': 'application/json'
						},
						body: JSON.stringify({
							teamId: teamA.id,
							assignedToUserId: null,
							reason: 'Desasignando técnico conservando equipo'
						})
					}
				)
			});
			assert.equal(resClearTech.status, 200);
			const dataClearTech = await resClearTech.json();
			assert.equal(dataClearTech.incident.teamId, teamA.id);
			assert.equal(dataClearTech.incident.assignedToUserId, null);
			assert.equal(dataClearTech.incident.supportLevel, 'N3');
		}
	);

	// =========================================================================
	// 15. Filtrado en listado GET /api/incidents
	// =========================================================================
	await t.test('15. GET /api/incidents supportLevel filter & orthogonal combinations', async () => {
		// Create 3 tickets with different levels and queues
		const tN1 = await createTicket('Filtro N1', { priority: 'high' });
		const tN2 = await createTicket('Filtro N2', { priority: 'high' });
		await updateIncidentSupportLevel(
			db,
			{ organizationId: orgA.id, actorUserId: userAdminA.id },
			tN2.id,
			{ supportLevel: 'N2', reason: 'Pase N2' }
		);

		const tN3 = await createTicket('Filtro N3', { priority: 'low' });
		await updateIncidentSupportLevel(
			db,
			{ organizationId: orgA.id, actorUserId: userAdminA.id },
			tN3.id,
			{ supportLevel: 'N3', reason: 'Pase N3' }
		);
		// Assign tN3 to userAdminA
		await assignIncidentRecord(
			db,
			{ organizationId: orgA.id, actorUserId: userAdminA.id },
			tN3.id,
			{ assignedToUserId: userAdminA.id }
		);

		// 15.1 Filter supportLevel=N1
		const resFiltN1 = await listIncidentsEndpoint({
			url: new URL(`http://localhost/api/incidents?organizationId=${orgA.id}&supportLevel=N1`),
			request: new Request(
				`http://localhost/api/incidents?organizationId=${orgA.id}&supportLevel=N1`,
				{
					headers: Object.fromEntries(sessionAdminA.headers)
				}
			)
		});
		assert.equal(resFiltN1.status, 200);
		const dataFiltN1 = await resFiltN1.json();
		assert.ok(dataFiltN1.incidents.length > 0);
		assert.ok(dataFiltN1.incidents.every((inc) => inc.supportLevel === 'N1'));
		assert.ok(dataFiltN1.incidents.some((inc) => inc.id === tN1.id));
		assert.ok(!dataFiltN1.incidents.some((inc) => inc.id === tN2.id));
		assert.ok(!dataFiltN1.incidents.some((inc) => inc.id === tN3.id));

		// 15.2 Filter supportLevel=N2
		const resFiltN2 = await listIncidentsEndpoint({
			url: new URL(`http://localhost/api/incidents?organizationId=${orgA.id}&supportLevel=N2`),
			request: new Request(
				`http://localhost/api/incidents?organizationId=${orgA.id}&supportLevel=N2`,
				{
					headers: Object.fromEntries(sessionAdminA.headers)
				}
			)
		});
		assert.equal(resFiltN2.status, 200);
		const dataFiltN2 = await resFiltN2.json();
		assert.ok(dataFiltN2.incidents.every((inc) => inc.supportLevel === 'N2'));
		assert.ok(dataFiltN2.incidents.some((inc) => inc.id === tN2.id));

		// 15.3 Filter supportLevel=N3
		const resFiltN3 = await listIncidentsEndpoint({
			url: new URL(`http://localhost/api/incidents?organizationId=${orgA.id}&supportLevel=N3`),
			request: new Request(
				`http://localhost/api/incidents?organizationId=${orgA.id}&supportLevel=N3`,
				{
					headers: Object.fromEntries(sessionAdminA.headers)
				}
			)
		});
		assert.equal(resFiltN3.status, 200);
		const dataFiltN3 = await resFiltN3.json();
		assert.ok(dataFiltN3.incidents.every((inc) => inc.supportLevel === 'N3'));
		assert.ok(dataFiltN3.incidents.some((inc) => inc.id === tN3.id));

		// 15.4 Invalid supportLevel query param -> 400 INVALID_INPUT
		const resInvalid = await listIncidentsEndpoint({
			url: new URL(`http://localhost/api/incidents?organizationId=${orgA.id}&supportLevel=N4`),
			request: new Request(
				`http://localhost/api/incidents?organizationId=${orgA.id}&supportLevel=N4`,
				{
					headers: Object.fromEntries(sessionAdminA.headers)
				}
			)
		});
		assert.equal(resInvalid.status, 400);
		const dataInvalid = await resInvalid.json();
		assert.equal(dataInvalid.error.code, 'INVALID_INPUT');

		// 15.5 Orthogonal combination: supportLevel=N3 & queue=mine
		const resOrtho = await listIncidentsEndpoint({
			url: new URL(
				`http://localhost/api/incidents?organizationId=${orgA.id}&supportLevel=N3&queue=mine`
			),
			request: new Request(
				`http://localhost/api/incidents?organizationId=${orgA.id}&supportLevel=N3&queue=mine`,
				{
					headers: Object.fromEntries(sessionAdminA.headers)
				}
			)
		});
		assert.equal(resOrtho.status, 200);
		const dataOrtho = await resOrtho.json();
		assert.ok(dataOrtho.incidents.length > 0);
		assert.ok(
			dataOrtho.incidents.every(
				(inc) => inc.supportLevel === 'N3' && inc.assignedToUserId === userAdminA.id
			)
		);
	});

	// =========================================================================
	// 16. Proyección en GET /api/incidents/[id]
	// =========================================================================
	await t.test('16. GET /api/incidents/[id] returns real supportLevel in response', async () => {
		const ticket = await createTicket('Projection Detail Ticket');
		await updateIncidentSupportLevel(
			db,
			{ organizationId: orgA.id, actorUserId: userAdminA.id },
			ticket.id,
			{ supportLevel: 'N2', reason: 'Cambio a N2' }
		);

		const res = await getIncidentEndpoint({
			params: { id: ticket.id },
			url: new URL(`http://localhost/api/incidents/${ticket.id}?organizationId=${orgA.id}`),
			request: new Request(
				`http://localhost/api/incidents/${ticket.id}?organizationId=${orgA.id}`,
				{
					headers: Object.fromEntries(sessionAdminA.headers)
				}
			)
		});

		assert.equal(res.status, 200);
		const data = await res.json();
		assert.ok(data.incident);
		assert.equal(data.incident.id, ticket.id);
		assert.equal(data.incident.supportLevel, 'N2');
	});

	// =========================================================================
	// 17. Multi-tenant y aislamiento
	// =========================================================================
	await t.test(
		'17. Multi-tenant isolation: cannot modify or access incidents belonging to another org',
		async () => {
			// Incident belongs to Org A
			const ticketA = await createTicket('Ticket Org A for Multi-tenant');

			// Admin of Org B tries to update supportLevel of ticket A using Org B in query param -> 404 INCIDENT_NOT_FOUND
			const resCrossOrg = await updateSupportLevelEndpoint({
				params: { id: ticketA.id },
				url: new URL(
					`http://localhost/api/incidents/${ticketA.id}/support-level?organizationId=${orgB.id}`
				),
				request: new Request(
					`http://localhost/api/incidents/${ticketA.id}/support-level?organizationId=${orgB.id}`,
					{
						method: 'PATCH',
						headers: {
							...Object.fromEntries(sessionAdminB.headers),
							'content-type': 'application/json'
						},
						body: JSON.stringify({
							supportLevel: 'N2',
							reason: 'Ataque cross-tenant'
						})
					}
				)
			});
			assert.equal(resCrossOrg.status, 404);
			const dataCrossOrg = await resCrossOrg.json();
			assert.equal(dataCrossOrg.error.code, 'INCIDENT_NOT_FOUND');

			// Admin of Org B tries with Org A in query param (no membership in Org A) -> 403 FORBIDDEN
			const resNoPerm = await updateSupportLevelEndpoint({
				params: { id: ticketA.id },
				url: new URL(
					`http://localhost/api/incidents/${ticketA.id}/support-level?organizationId=${orgA.id}`
				),
				request: new Request(
					`http://localhost/api/incidents/${ticketA.id}/support-level?organizationId=${orgA.id}`,
					{
						method: 'PATCH',
						headers: {
							...Object.fromEntries(sessionAdminB.headers),
							'content-type': 'application/json'
						},
						body: JSON.stringify({
							supportLevel: 'N2',
							reason: 'Ataque sin membresia en Org A'
						})
					}
				)
			});
			assert.equal(resNoPerm.status, 403);

			// Verify ticketA remains untouched at N1
			const detail = await getIncidentById(db, { organizationId: orgA.id }, ticketA.id);
			assert.equal(detail.incident.supportLevel, 'N1');
		}
	);

	// =========================================================================
	// 18. Permisos
	// =========================================================================
	await t.test('18. Permissions: anonymous -> 401, without incidents:edit -> 403', async () => {
		const ticket = await createTicket('Permissions Ticket');

		// Anonymous -> 401
		const resAnon = await updateSupportLevelEndpoint({
			params: { id: ticket.id },
			url: new URL(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
			),
			request: new Request(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
				{
					method: 'PATCH',
					headers: {
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						supportLevel: 'N2',
						reason: 'Intento anonimo'
					})
				}
			)
		});
		assert.equal(resAnon.status, 401);
		const dataAnon = await resAnon.json();
		assert.equal(dataAnon.error.code, 'UNAUTHORIZED');

		// Viewer without incidents:edit -> 403
		const resViewer = await updateSupportLevelEndpoint({
			params: { id: ticket.id },
			url: new URL(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`
			),
			request: new Request(
				`http://localhost/api/incidents/${ticket.id}/support-level?organizationId=${orgA.id}`,
				{
					method: 'PATCH',
					headers: {
						...Object.fromEntries(sessionViewerA.headers),
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						supportLevel: 'N2',
						reason: 'Intento sin permiso edit'
					})
				}
			)
		});
		assert.equal(resViewer.status, 403);
		const dataViewer = await resViewer.json();
		assert.equal(dataViewer.error.code, 'FORBIDDEN');
	});

	// =========================================================================
	// 19. Client API: parseAndValidateIncident rechaza payloads sin supportLevel o inválidos
	// =========================================================================
	await t.test(
		'19. Client API runtime parser: rejects missing, non-string, or invalid supportLevel with INVALID_PAYLOAD (no fallback to N1)',
		async () => {
			const orgId = randomUUID();
			const incId = randomUUID();
			const basePayload = {
				id: incId,
				organizationId: orgId,
				incidentNumber: 1,
				title: 'Test',
				description: 'Desc',
				status: 'open',
				priority: 'medium',
				client: 'Acme',
				clientUserId: null,
				createdByUserId: randomUUID(),
				siteId: null,
				createdAt: '2026-09-25T10:00:00.000Z',
				updatedAt: '2026-09-25T10:00:00.000Z'
			};

			// 1. Missing supportLevel -> throws INVALID_PAYLOAD (does not fallback to N1)
			const mockMissing = async () =>
				new Response(JSON.stringify({ incident: { ...basePayload } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});

			await assert.rejects(
				async () => getIncident(orgId, incId, { customFetch: mockMissing }),
				(err) => {
					assert.ok(err instanceof IncidentApiError);
					assert.equal(err.code, 'INVALID_PAYLOAD');
					return true;
				}
			);

			// 2. Non-string supportLevel -> throws INVALID_PAYLOAD
			const mockNumber = async () =>
				new Response(JSON.stringify({ incident: { ...basePayload, supportLevel: 1 } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});

			await assert.rejects(
				async () => getIncident(orgId, incId, { customFetch: mockNumber }),
				(err) => {
					assert.ok(err instanceof IncidentApiError);
					assert.equal(err.code, 'INVALID_PAYLOAD');
					return true;
				}
			);

			// 3. Invalid enum supportLevel ('N4') -> throws INVALID_PAYLOAD
			const mockInvalid = async () =>
				new Response(JSON.stringify({ incident: { ...basePayload, supportLevel: 'N4' } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});

			await assert.rejects(
				async () => getIncident(orgId, incId, { customFetch: mockInvalid }),
				(err) => {
					assert.ok(err instanceof IncidentApiError);
					assert.equal(err.code, 'INVALID_PAYLOAD');
					return true;
				}
			);

			// 4. Valid supportLevel ('N2') -> parses successfully with mandatory supportLevel
			const mockValid = async () =>
				new Response(JSON.stringify({ incident: { ...basePayload, supportLevel: 'N2' } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});

			const parsed = await getIncident(orgId, incId, { customFetch: mockValid });
			assert.equal(parsed.supportLevel, 'N2');
		}
	);
});

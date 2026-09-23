import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fixture } from './helpers/auth-fixture.mjs';

async function createOrg(db, s, name = 'Org Test', status = 'active') {
	const [org] = await db
		.insert(s.organizations)
		.values({ name, slug: 'org-' + randomUUID(), status })
		.returning();
	return org;
}

async function createUser(db, s, name = 'User Test', active = true) {
	const [u] = await db.insert(s.users).values({ name, active }).returning();
	return u;
}

async function createMembership(db, s, organizationId, userId, active = true) {
	const [m] = await db.insert(s.memberships).values({ organizationId, userId, active }).returning();
	return m;
}

async function createSite(db, s, organizationId, name = 'Sede Test', active = true) {
	const [site] = await db.insert(s.sites).values({ organizationId, name, active }).returning();
	return site;
}

test('SoporteFlow — Etapa 4: Servicios de servidor de incidencias v1', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;

	const { createIncidentRecord, listIncidents, getIncidentById, IncidentServiceError } =
		await server.ssrLoadModule('/src/lib/server/services/incidents.ts');

	// Configuración base de organizaciones
	const orgA = await createOrg(db, s, 'Organización Alpha', 'active');
	const orgB = await createOrg(db, s, 'Organización Beta', 'active');

	// Usuarios y membresías de Org Alpha
	const userCreatorA = await createUser(db, s, 'Creador Alpha');
	await createMembership(db, s, orgA.id, userCreatorA.id, true);

	const userClientA = await createUser(db, s, 'Cliente Alpha');
	await createMembership(db, s, orgA.id, userClientA.id, true);

	const siteA = await createSite(db, s, orgA.id, 'Sede Central Alpha', true);

	// Usuarios y membresías de Org Beta
	const userCreatorB = await createUser(db, s, 'Creador Beta');
	await createMembership(db, s, orgB.id, userCreatorB.id, true);

	const siteB = await createSite(db, s, orgB.id, 'Sede Central Beta', true);

	// =========================================================================
	// 1. CREATE: Creación válida, numeración y eventos
	// =========================================================================
	await t.test('CREATE: creación válida, status open y evento de historial inicial', async () => {
		const context = { organizationId: orgA.id, creatorUserId: userCreatorA.id };
		const result = await createIncidentRecord(db, context, {
			title: 'Fallo de conectividad en planta 1',
			description: 'El switch de distribución ha perdido alimentación.',
			client: 'Dra. García',
			priority: 'high',
			clientUserId: userClientA.id,
			siteId: siteA.id
		});

		assert.ok(result.incident);
		assert.ok(result.history);
		assert.equal(result.incident.incidentNumber, 1);
		assert.equal(result.incident.organizationId, orgA.id);
		assert.equal(result.incident.title, 'Fallo de conectividad en planta 1');
		assert.equal(result.incident.status, 'open'); // Forzado server-side
		assert.equal(result.incident.priority, 'high');
		assert.equal(result.incident.client, 'Dra. García');
		assert.equal(result.incident.clientUserId, userClientA.id);
		assert.equal(result.incident.createdByUserId, userCreatorA.id);
		assert.equal(result.incident.siteId, siteA.id);

		// Verificar evento de historial 'created'
		assert.equal(result.history.incidentId, result.incident.id);
		assert.equal(result.history.organizationId, orgA.id);
		assert.equal(result.history.eventType, 'created');
		assert.equal(result.history.actorType, 'user');
		assert.equal(result.history.actorUserId, userCreatorA.id);
		assert.equal(result.history.payload.incidentNumber, 1);
		assert.equal(result.history.payload.status, 'open');
	});

	await t.test(
		'CREATE: segunda incidencia genera #2 en misma org, y primera en org distinta genera #1',
		async () => {
			// Segunda incidencia en Org Alpha -> #2
			const contextA = { organizationId: orgA.id, creatorUserId: userCreatorA.id };
			const resA2 = await createIncidentRecord(db, contextA, {
				title: 'Impresora sin tóner',
				description: 'Reemplazar cartucho en recepción.',
				client: 'Recepción'
			});
			assert.equal(resA2.incident.incidentNumber, 2);

			// Primera incidencia en Org Beta -> #1 (contador independiente)
			const contextB = { organizationId: orgB.id, creatorUserId: userCreatorB.id };
			const resB1 = await createIncidentRecord(db, contextB, {
				title: 'Incidencia en Beta',
				description: 'Primera incidencia registrada para Org Beta.',
				client: 'Cliente Beta',
				siteId: siteB.id
			});
			assert.equal(resB1.incident.incidentNumber, 1);

			// Comprobar contadores directamente en organization_counters
			const [counterA] = await db
				.select()
				.from(s.organizationCounters)
				.where(eq(s.organizationCounters.organizationId, orgA.id));
			const [counterB] = await db
				.select()
				.from(s.organizationCounters)
				.where(eq(s.organizationCounters.organizationId, orgB.id));
			assert.equal(counterA.lastIncidentNumber, 2);
			assert.equal(counterB.lastIncidentNumber, 1);
		}
	);

	// =========================================================================
	// 2. ROLLBACK: Reversión total transaccional
	// =========================================================================
	await t.test(
		'ROLLBACK: aborto transaccional no consume número ni persiste registros',
		async () => {
			const orgRollback = await createOrg(db, s, 'Org Rollback Test', 'active');
			const userRollback = await createUser(db, s, 'Usuario Rollback');
			await createMembership(db, s, orgRollback.id, userRollback.id, true);

			// Primer ticket exitoso -> #1
			const res1 = await createIncidentRecord(
				db,
				{ organizationId: orgRollback.id, creatorUserId: userRollback.id },
				{ title: 'Ticket 1', description: 'Desc', client: 'Cli' }
			);
			assert.equal(res1.incident.incidentNumber, 1);

			// Intentar crear un ticket dentro de una transacción que falla intencionadamente después
			await assert.rejects(
				db.transaction(async (tx) => {
					await createIncidentRecord(
						tx,
						{ organizationId: orgRollback.id, creatorUserId: userRollback.id },
						{ title: 'Ticket que fallará', description: 'Desc', client: 'Cli' }
					);
					throw new Error('Forced failure to trigger transaction rollback');
				}),
				/Forced failure/
			);

			// Verificar que el contador sigue en 1 y no avanzó a 2
			const [counter] = await db
				.select()
				.from(s.organizationCounters)
				.where(eq(s.organizationCounters.organizationId, orgRollback.id));
			assert.equal(counter.lastIncidentNumber, 1);

			// Verificar que no quedó ninguna incidencia con número 2
			const incidentsInOrg = await db
				.select()
				.from(s.incidents)
				.where(eq(s.incidents.organizationId, orgRollback.id));
			assert.equal(incidentsInOrg.length, 1);
			assert.equal(incidentsInOrg[0].incidentNumber, 1);

			// El siguiente ticket exitoso debe ser #2, sin saltos
			const res2 = await createIncidentRecord(
				db,
				{ organizationId: orgRollback.id, creatorUserId: userRollback.id },
				{ title: 'Ticket 2 tras rollback', description: 'Desc', client: 'Cli' }
			);
			assert.equal(res2.incident.incidentNumber, 2);
		}
	);

	// =========================================================================
	// 3. ORGANIZATION: Estado y existencia de organización
	// =========================================================================
	await t.test('ORGANIZATION: rechaza organización inexistente, trial o suspended', async () => {
		const nonExistentOrgId = randomUUID();
		await assert.rejects(
			createIncidentRecord(
				db,
				{ organizationId: nonExistentOrgId, creatorUserId: userCreatorA.id },
				{ title: 'T', description: 'D', client: 'C' }
			),
			(err) => err instanceof IncidentServiceError && err.code === 'ORGANIZATION_NOT_FOUND'
		);

		// Org en trial
		const orgTrial = await createOrg(db, s, 'Org Trial', 'trial');
		const userTrial = await createUser(db, s, 'User Trial');
		await createMembership(db, s, orgTrial.id, userTrial.id, true);

		await assert.rejects(
			createIncidentRecord(
				db,
				{ organizationId: orgTrial.id, creatorUserId: userTrial.id },
				{ title: 'T', description: 'D', client: 'C' }
			),
			(err) => err instanceof IncidentServiceError && err.code === 'ORGANIZATION_NOT_OPERATIONAL'
		);

		// Org en suspended
		const orgSuspended = await createOrg(db, s, 'Org Suspended', 'suspended');
		const userSuspended = await createUser(db, s, 'User Suspended');
		await createMembership(db, s, orgSuspended.id, userSuspended.id, true);

		await assert.rejects(
			createIncidentRecord(
				db,
				{ organizationId: orgSuspended.id, creatorUserId: userSuspended.id },
				{ title: 'T', description: 'D', client: 'C' }
			),
			(err) => err instanceof IncidentServiceError && err.code === 'ORGANIZATION_NOT_OPERATIONAL'
		);
	});

	// =========================================================================
	// 4. CREATOR: Pertenencia y actividad del creador
	// =========================================================================
	await t.test('CREATOR: rechaza creador sin membership, inactivo o cross-tenant', async () => {
		const userOutside = await createUser(db, s, 'Usuario Sin Membresía');

		// Sin membership
		await assert.rejects(
			createIncidentRecord(
				db,
				{ organizationId: orgA.id, creatorUserId: userOutside.id },
				{ title: 'T', description: 'D', client: 'C' }
			),
			(err) => err instanceof IncidentServiceError && err.code === 'CREATOR_MEMBERSHIP_NOT_FOUND'
		);

		// Creador cross-tenant (pertenece a Org B intentando crear en Org A)
		await assert.rejects(
			createIncidentRecord(
				db,
				{ organizationId: orgA.id, creatorUserId: userCreatorB.id },
				{ title: 'T', description: 'D', client: 'C' }
			),
			(err) => err instanceof IncidentServiceError && err.code === 'CREATOR_MEMBERSHIP_NOT_FOUND'
		);

		// Membership inactiva
		const userInactiveMem = await createUser(db, s, 'Usuario Mem Inactiva');
		await createMembership(db, s, orgA.id, userInactiveMem.id, false);

		await assert.rejects(
			createIncidentRecord(
				db,
				{ organizationId: orgA.id, creatorUserId: userInactiveMem.id },
				{ title: 'T', description: 'D', client: 'C' }
			),
			(err) => err instanceof IncidentServiceError && err.code === 'CREATOR_MEMBERSHIP_INACTIVE'
		);

		// Usuario globalmente inactivo
		const userGloballyInactive = await createUser(db, s, 'Usuario Inactivo Global', false);
		await createMembership(db, s, orgA.id, userGloballyInactive.id, true);

		await assert.rejects(
			createIncidentRecord(
				db,
				{ organizationId: orgA.id, creatorUserId: userGloballyInactive.id },
				{ title: 'T', description: 'D', client: 'C' }
			),
			(err) => err instanceof IncidentServiceError && err.code === 'CREATOR_USER_INACTIVE'
		);
	});

	// =========================================================================
	// 5. CLIENT: Validación de clientUserId
	// =========================================================================
	await t.test('CLIENT: clientUserId null válido, rechaza cross-tenant o inactivo', async () => {
		const context = { organizationId: orgA.id, creatorUserId: userCreatorA.id };

		// clientUserId = null es válido
		const resNull = await createIncidentRecord(db, context, {
			title: 'Llamada telefónica externa',
			description: 'Paciente sin cuenta en el sistema reporta incidencia.',
			client: 'Don Manuel',
			clientUserId: null
		});
		assert.equal(resNull.incident.clientUserId, null);
		assert.equal(resNull.incident.client, 'Don Manuel');

		// clientUserId de otra organización (Org Beta) -> rechazado
		await assert.rejects(
			createIncidentRecord(db, context, {
				title: 'T',
				description: 'D',
				client: 'C',
				clientUserId: userCreatorB.id
			}),
			(err) =>
				err instanceof IncidentServiceError && err.code === 'CLIENT_USER_MEMBERSHIP_NOT_FOUND'
		);

		// clientUserId con membership inactiva -> rechazado
		const userClientInactiveMem = await createUser(db, s, 'Cliente Mem Inactiva');
		await createMembership(db, s, orgA.id, userClientInactiveMem.id, false);

		await assert.rejects(
			createIncidentRecord(db, context, {
				title: 'T',
				description: 'D',
				client: 'C',
				clientUserId: userClientInactiveMem.id
			}),
			(err) => err instanceof IncidentServiceError && err.code === 'CLIENT_USER_INACTIVE'
		);

		// clientUserId con user inactivo -> rechazado
		const userClientInactive = await createUser(db, s, 'Cliente Usuario Inactivo', false);
		await createMembership(db, s, orgA.id, userClientInactive.id, true);

		await assert.rejects(
			createIncidentRecord(db, context, {
				title: 'T',
				description: 'D',
				client: 'C',
				clientUserId: userClientInactive.id
			}),
			(err) => err instanceof IncidentServiceError && err.code === 'CLIENT_USER_INACTIVE'
		);
	});

	// =========================================================================
	// 6. SITE: Validación de siteId
	// =========================================================================
	await t.test('SITE: siteId null válido, rechaza cross-tenant o sede inactiva', async () => {
		const context = { organizationId: orgA.id, creatorUserId: userCreatorA.id };

		// siteId = null es válido
		const resNullSite = await createIncidentRecord(db, context, {
			title: 'Sin sede física',
			description: 'Incidencia sobre servicio en la nube.',
			client: 'Cliente Cloud',
			siteId: null
		});
		assert.equal(resNullSite.incident.siteId, null);

		// Sede de otra organización (siteB) -> rechazada
		await assert.rejects(
			createIncidentRecord(db, context, {
				title: 'T',
				description: 'D',
				client: 'C',
				siteId: siteB.id
			}),
			(err) => err instanceof IncidentServiceError && err.code === 'SITE_NOT_FOUND'
		);

		// Sede inactiva en la misma organización -> rechazada
		const siteAInactive = await createSite(db, s, orgA.id, 'Sede Clausurada Alpha', false);
		await assert.rejects(
			createIncidentRecord(db, context, {
				title: 'T',
				description: 'D',
				client: 'C',
				siteId: siteAInactive.id
			}),
			(err) => err instanceof IncidentServiceError && err.code === 'SITE_INACTIVE'
		);
	});

	// =========================================================================
	// 7. VALIDACIONES: Validación de inputs
	// =========================================================================
	await t.test(
		'VALIDACIONES: rechaza títulos, descripciones, clientes vacíos o prioridades inválidas',
		async () => {
			const context = { organizationId: orgA.id, creatorUserId: userCreatorA.id };

			// Título vacío o espacios
			await assert.rejects(
				createIncidentRecord(db, context, { title: '   ', description: 'D', client: 'C' }),
				(err) => err instanceof IncidentServiceError && err.code === 'INVALID_INPUT'
			);

			// Descripción vacía o espacios
			await assert.rejects(
				createIncidentRecord(db, context, { title: 'T', description: '  \n\t  ', client: 'C' }),
				(err) => err instanceof IncidentServiceError && err.code === 'INVALID_INPUT'
			);

			// Cliente vacío o espacios
			await assert.rejects(
				createIncidentRecord(db, context, { title: 'T', description: 'D', client: '' }),
				(err) => err instanceof IncidentServiceError && err.code === 'INVALID_INPUT'
			);

			// Prioridad inválida
			await assert.rejects(
				createIncidentRecord(db, context, {
					title: 'T',
					description: 'D',
					client: 'C',
					priority: 'urgente_maxima'
				}),
				(err) => err instanceof IncidentServiceError && err.code === 'INVALID_INPUT'
			);

			// UUIDs inválidos en input o context
			await assert.rejects(
				createIncidentRecord(
					db,
					{ organizationId: 'not-a-uuid', creatorUserId: userCreatorA.id },
					{
						title: 'T',
						description: 'D',
						client: 'C'
					}
				),
				(err) => err instanceof IncidentServiceError && err.code === 'INVALID_INPUT'
			);

			await assert.rejects(
				createIncidentRecord(db, context, {
					title: 'T',
					description: 'D',
					client: 'C',
					clientUserId: 'bad-uuid'
				}),
				(err) => err instanceof IncidentServiceError && err.code === 'INVALID_INPUT'
			);
		}
	);

	// =========================================================================
	// 8. LIST: Listado, aislamiento y filtros
	// =========================================================================
	await t.test(
		'LIST: aislamiento estricto por organizationId, orden estable y filtros',
		async () => {
			// Listado de Org Alpha debe devolver solo incidencias de Org Alpha
			const listA = await listIncidents(db, { organizationId: orgA.id });
			assert.ok(listA.length >= 2);
			for (const inc of listA) {
				assert.equal(inc.organizationId, orgA.id);
			}

			// Listado de Org Beta debe devolver solo incidencias de Org Beta
			const listB = await listIncidents(db, { organizationId: orgB.id });
			assert.equal(listB.length, 1);
			assert.equal(listB[0].organizationId, orgB.id);

			// Orden estable: descendente por createdAt / incidentNumber
			for (let i = 1; i < listA.length; i++) {
				assert.ok(listA[i - 1].incidentNumber >= listA[i].incidentNumber);
			}

			// Filtro por priority = 'high' en Org Alpha
			const listHigh = await listIncidents(db, { organizationId: orgA.id }, { priority: 'high' });
			assert.ok(listHigh.length >= 1);
			for (const inc of listHigh) {
				assert.equal(inc.priority, 'high');
				assert.equal(inc.organizationId, orgA.id);
			}

			// Filtro por status = 'open' en Org Alpha
			const listOpen = await listIncidents(db, { organizationId: orgA.id }, { status: 'open' });
			assert.equal(listOpen.length, listA.length); // Todas las creadas están en status 'open'

			// Filtro por siteId
			const listSiteA = await listIncidents(db, { organizationId: orgA.id }, { siteId: siteA.id });
			assert.ok(listSiteA.length >= 1);
			for (const inc of listSiteA) {
				assert.equal(inc.siteId, siteA.id);
			}

			// Filtro por siteId = null (sin sede)
			const listNoSite = await listIncidents(db, { organizationId: orgA.id }, { siteId: null });
			assert.ok(listNoSite.length >= 1);
			for (const inc of listNoSite) {
				assert.equal(inc.siteId, null);
			}
		}
	);

	// =========================================================================
	// 9. DETAIL: Detalle por UUID, aislamiento cross-tenant e historial
	// =========================================================================
	await t.test(
		'DETAIL: recupera detalle e historial ordenado, y devuelve null ante cross-tenant o inexistente',
		async () => {
			const listA = await listIncidents(db, { organizationId: orgA.id });
			const targetA = listA[0];

			// Detalle legítimo de Org Alpha
			const detailA = await getIncidentById(db, { organizationId: orgA.id }, targetA.id);
			assert.ok(detailA);
			assert.equal(detailA.incident.id, targetA.id);
			assert.equal(detailA.incident.organizationId, orgA.id);
			assert.ok(Array.isArray(detailA.history));
			assert.ok(detailA.history.length >= 1);
			assert.equal(detailA.history[0].eventType, 'created');
			assert.equal(detailA.history[0].incidentId, targetA.id);

			// Intento de consultar la misma incidencia de Org Alpha usando el contexto de Org Beta
			const crossTenantDetail = await getIncidentById(db, { organizationId: orgB.id }, targetA.id);
			assert.equal(crossTenantDetail, null, 'No debe revelar incidencias de otro tenant');

			// UUID inexistente en el tenant
			const nonExistentDetail = await getIncidentById(
				db,
				{ organizationId: orgA.id },
				randomUUID()
			);
			assert.equal(nonExistentDetail, null);

			// UUID malformado devuelve null sin excepción ni fuga
			const invalidUuidDetail = await getIncidentById(
				db,
				{ organizationId: orgA.id },
				'not-a-uuid'
			);
			assert.equal(invalidUuidDetail, null);
		}
	);
});

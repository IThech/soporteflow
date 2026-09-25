import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { fixture, directory, expectedMigrations } from './helpers/auth-fixture.mjs';
import { applyMigrations } from './helpers/persistence-migrations.mjs';

function errorCode(error) {
	return error?.code ?? error?.cause?.code;
}

async function rejected(operation, code) {
	await assert.rejects(operation, (error) => {
		const c = errorCode(error);
		const expectedCodes = Array.isArray(code) ? code : [code];
		return expectedCodes.includes(c);
	});
}

async function createOrg(db, s, name = 'Org Test') {
	const [org] = await db
		.insert(s.organizations)
		.values({ name, slug: 'org-' + randomUUID() })
		.returning();
	return org;
}

async function createUser(db, s, name = 'User Test') {
	const [u] = await db.insert(s.users).values({ name }).returning();
	return u;
}

async function createMembership(db, s, orgId, userId) {
	const [m] = await db.insert(s.memberships).values({ organizationId: orgId, userId }).returning();
	return m;
}

async function createSite(db, s, orgId, name = 'Site Test') {
	const [site] = await db.insert(s.sites).values({ organizationId: orgId, name }).returning();
	return site;
}

test('SoporteFlow — Etapa 3: validación de esquema relacional de incidencias v1 en PGlite', async (t) => {
	// =========================================================================
	// 2. Migraciones secuenciales sobre base limpia
	// =========================================================================
	await t.test('2. Migraciones 0000, 0001 y 0002 se aplican limpiamente en PGlite', async () => {
		const f = await fixture(t, false);
		const applied = await applyMigrations(f.pg, directory);
		assert.deepEqual(applied, expectedMigrations);
	});

	// Fixture compartida con todas las migraciones aplicadas
	const f = await fixture(t, true);
	const { db, schema: s, pg } = f;

	// Configuración base de entidades
	const orgA = await createOrg(db, s, 'Organización A');
	const orgB = await createOrg(db, s, 'Organización B');

	const userCreatorA = await createUser(db, s, 'Técnico Creador A');
	await createMembership(db, s, orgA.id, userCreatorA.id);

	const userClientA = await createUser(db, s, 'Cliente Registrado A');
	await createMembership(db, s, orgA.id, userClientA.id);

	const userOtherOrg = await createUser(db, s, 'Usuario Ajeno Org B');
	await createMembership(db, s, orgB.id, userOtherOrg.id);

	const userNoMembership = await createUser(db, s, 'Usuario Sin Membresía');

	const siteA = await createSite(db, s, orgA.id, 'Sede Central A');
	const siteB = await createSite(db, s, orgB.id, 'Sede Norte B');

	// =========================================================================
	// 3.A Inserción válida de incidencia y su evento inicial
	// =========================================================================
	let validIncidentA;
	await t.test(
		'3.A Inserción válida de incidencia e historial en la misma organización',
		async () => {
			const [inc] = await db
				.insert(s.incidents)
				.values({
					organizationId: orgA.id,
					incidentNumber: 1,
					title: 'Fallo de conectividad en Sede Central',
					description: 'Caída de fibra óptica redundante.',
					status: 'open',
					priority: 'high',
					client: 'Cliente A Presencial',
					clientUserId: userClientA.id,
					createdByUserId: userCreatorA.id,
					siteId: siteA.id
				})
				.returning();

			assert.ok(inc);
			assert.equal(inc.organizationId, orgA.id);
			assert.equal(inc.incidentNumber, 1);
			assert.equal(inc.siteId, siteA.id);
			assert.equal(inc.clientUserId, userClientA.id);
			assert.equal(inc.createdByUserId, userCreatorA.id);
			validIncidentA = inc;

			const [hist] = await db
				.insert(s.incidentHistory)
				.values({
					incidentId: inc.id,
					organizationId: orgA.id,
					eventType: 'created',
					actorType: 'user',
					actorUserId: userCreatorA.id,
					payload: { status: 'open', priority: 'high' }
				})
				.returning();

			assert.ok(hist);
			assert.equal(hist.incidentId, inc.id);
			assert.equal(hist.organizationId, orgA.id);
			assert.equal(hist.actorUserId, userCreatorA.id);
			assert.equal(hist.eventType, 'created');
		}
	);

	// =========================================================================
	// 3.B Sede cruzada entre organizaciones (debe fallar por FK compuesta)
	// =========================================================================
	await t.test(
		'3.B Rechazo de sede perteneciente a otra organización (cross-tenant site)',
		async () => {
			await rejected(
				db.insert(s.incidents).values({
					organizationId: orgA.id,
					incidentNumber: 2,
					title: 'Incidencia con sede ajena',
					description: 'Intento de asignar Sede B a Org A',
					status: 'open',
					priority: 'medium',
					client: 'Cliente Test',
					createdByUserId: userCreatorA.id,
					siteId: siteB.id // Sede B pertenece a Org B, no a Org A
				}),
				'23503'
			);
		}
	);

	// =========================================================================
	// 3.C Creador cruzado (usuario sin membresía en Org A)
	// =========================================================================
	await t.test(
		'3.C Rechazo de creador sin membresía en la organización de la incidencia',
		async () => {
			// Usuario de Org B intentando ser creador en Org A
			await rejected(
				db.insert(s.incidents).values({
					organizationId: orgA.id,
					incidentNumber: 3,
					title: 'Creador foráneo',
					description: 'Usuario de Org B creando en Org A',
					status: 'open',
					priority: 'low',
					client: 'Cliente Test',
					createdByUserId: userOtherOrg.id
				}),
				'23503'
			);

			// Usuario global sin ninguna membresía
			await rejected(
				db.insert(s.incidents).values({
					organizationId: orgA.id,
					incidentNumber: 4,
					title: 'Creador sin membresía',
					description: 'Usuario sin membresía creando en Org A',
					status: 'open',
					priority: 'low',
					client: 'Cliente Test',
					createdByUserId: userNoMembership.id
				}),
				'23503'
			);
		}
	);

	// =========================================================================
	// 3.D Cliente registrado cruzado (usuario sin membresía en Org A)
	// =========================================================================
	await t.test(
		'3.D Rechazo de client_user_id sin membresía en la organización de la incidencia',
		async () => {
			await rejected(
				db.insert(s.incidents).values({
					organizationId: orgA.id,
					incidentNumber: 5,
					title: 'Cliente ajeno',
					description: 'client_user_id pertenece a Org B',
					status: 'open',
					priority: 'medium',
					client: 'Nombre Texto',
					createdByUserId: userCreatorA.id,
					clientUserId: userOtherOrg.id // Usuario de Org B
				}),
				'23503'
			);
		}
	);

	// =========================================================================
	// 3.E Actor de historial cruzado (usuario sin membresía en Org A)
	// =========================================================================
	await t.test('3.E Rechazo de actor de historial sin membresía en la organización', async () => {
		await rejected(
			db.insert(s.incidentHistory).values({
				incidentId: validIncidentA.id,
				organizationId: orgA.id,
				eventType: 'status_changed',
				actorType: 'user',
				actorUserId: userOtherOrg.id // Usuario de Org B
			}),
			'23503'
		);
	});

	// =========================================================================
	// 3.F Nulos permitidos (siteId, clientUserId, system actor)
	// =========================================================================
	await t.test(
		'3.F Aceptación de site_id = NULL, client_user_id = NULL y actor_type = system',
		async () => {
			const [incWithoutOptional] = await db
				.insert(s.incidents)
				.values({
					organizationId: orgA.id,
					incidentNumber: 10,
					title: 'Incidencia puramente remota / software',
					description: 'Sin ubicación física ni usuario registrado.',
					status: 'open',
					priority: 'medium',
					client: 'Contacto Telefónico Anónimo',
					clientUserId: null,
					createdByUserId: userCreatorA.id,
					siteId: null
				})
				.returning();

			assert.ok(incWithoutOptional);
			assert.equal(incWithoutOptional.siteId, null);
			assert.equal(incWithoutOptional.clientUserId, null);

			const [systemEvent] = await db
				.insert(s.incidentHistory)
				.values({
					incidentId: incWithoutOptional.id,
					organizationId: orgA.id,
					eventType: 'closed',
					actorType: 'system',
					actorUserId: null,
					reason: 'Cierre automático determinista tras 24h resuelta'
				})
				.returning();

			assert.ok(systemEvent);
			assert.equal(systemEvent.actorType, 'system');
			assert.equal(systemEvent.actorUserId, null);
		}
	);

	// =========================================================================
	// 3.G Restricciones de contenido y tipos (CHECK constraints)
	// =========================================================================
	await t.test(
		'3.G Rechazo de checks inválidos (título, cliente, desc, status, prioridad, actor, evento)',
		async () => {
			// Título vacío o solo espacios
			await rejected(
				db.insert(s.incidents).values({
					organizationId: orgA.id,
					incidentNumber: 20,
					title: '   ',
					description: 'Desc válida',
					client: 'Cliente',
					createdByUserId: userCreatorA.id
				}),
				'23514'
			);

			// Cliente vacío o solo espacios
			await rejected(
				db.insert(s.incidents).values({
					organizationId: orgA.id,
					incidentNumber: 21,
					title: 'Título válido',
					description: 'Desc válida',
					client: '',
					createdByUserId: userCreatorA.id
				}),
				'23514'
			);

			// Descripción vacía o solo espacios
			await rejected(
				db.insert(s.incidents).values({
					organizationId: orgA.id,
					incidentNumber: 22,
					title: 'Título válido',
					description: '   ',
					client: 'Cliente',
					createdByUserId: userCreatorA.id
				}),
				'23514'
			);

			// Estado inválido
			await rejected(
				db.insert(s.incidents).values({
					organizationId: orgA.id,
					incidentNumber: 23,
					title: 'Título válido',
					description: 'Desc válida',
					status: 'in_review', // no es 'open' | 'pending' | 'resolved' | 'closed'
					client: 'Cliente',
					createdByUserId: userCreatorA.id
				}),
				'23514'
			);

			// Prioridad inválida
			await rejected(
				db.insert(s.incidents).values({
					organizationId: orgA.id,
					incidentNumber: 24,
					title: 'Título válido',
					description: 'Desc válida',
					priority: 'critical_legacy', // V1 solo admite 'low' | 'medium' | 'high' | 'urgent'
					client: 'Cliente',
					createdByUserId: userCreatorA.id
				}),
				'23514'
			);

			// actor_type inválido
			await rejected(
				db.insert(s.incidentHistory).values({
					incidentId: validIncidentA.id,
					organizationId: orgA.id,
					eventType: 'status_changed',
					actorType: 'robot', // no es 'user' | 'system'
					actorUserId: userCreatorA.id
				}),
				'23514'
			);

			// actor_type = user con actor_user_id NULL
			await rejected(
				db.insert(s.incidentHistory).values({
					incidentId: validIncidentA.id,
					organizationId: orgA.id,
					eventType: 'status_changed',
					actorType: 'user',
					actorUserId: null
				}),
				'23514'
			);

			// actor_type = system con actor_user_id informado
			await rejected(
				db.insert(s.incidentHistory).values({
					incidentId: validIncidentA.id,
					organizationId: orgA.id,
					eventType: 'status_changed',
					actorType: 'system',
					actorUserId: userCreatorA.id
				}),
				'23514'
			);

			// event_type fuera del catálogo de 17 eventos de dominio
			await rejected(
				db.insert(s.incidentHistory).values({
					incidentId: validIncidentA.id,
					organizationId: orgA.id,
					eventType: 'ticket_exploded',
					actorType: 'user',
					actorUserId: userCreatorA.id
				}),
				'23514'
			);
		}
	);

	// =========================================================================
	// 3.H Unicidad de incident_number por organización
	// =========================================================================
	await t.test(
		'3.H Unicidad: incident_number repetido falla en la misma org pero es válido en org distinta',
		async () => {
			// Repetir incidentNumber = 1 en Org A (ya insertado en 3.A)
			await rejected(
				db.insert(s.incidents).values({
					organizationId: orgA.id,
					incidentNumber: 1, // Ya existe en Org A
					title: 'Duplicado en Org A',
					description: 'Desc',
					client: 'Cliente',
					createdByUserId: userCreatorA.id
				}),
				'23505'
			);

			// Mismo incidentNumber = 1 en Org B
			const [incOrgB] = await db
				.insert(s.incidents)
				.values({
					organizationId: orgB.id,
					incidentNumber: 1, // Válido porque pertenece a Org B
					title: 'Incidencia #1 en Org B',
					description: 'Desc',
					client: 'Cliente Org B',
					createdByUserId: userOtherOrg.id
				})
				.returning();

			assert.ok(incOrgB);
			assert.equal(incOrgB.organizationId, orgB.id);
			assert.equal(incOrgB.incidentNumber, 1);
		}
	);

	// =========================================================================
	// 3.I Conservación de auditoría (ON DELETE RESTRICT en incidencias y sedes)
	// =========================================================================
	await t.test(
		'3.I Conservación de auditoría: ON DELETE RESTRICT bloquea borrado con historial o sede vinculada',
		async () => {
			// Crear incidencia dedicada con historial para prueba de borrado
			const [incToProtect] = await db
				.insert(s.incidents)
				.values({
					organizationId: orgA.id,
					incidentNumber: 99,
					title: 'Incidencia para test de protección',
					description: 'Desc',
					client: 'Cliente',
					createdByUserId: userCreatorA.id
				})
				.returning();

			await db.insert(s.incidentHistory).values({
				incidentId: incToProtect.id,
				organizationId: orgA.id,
				eventType: 'created',
				actorType: 'user',
				actorUserId: userCreatorA.id
			});

			// Intentar borrar la incidencia físicamente -> rechazado por RESTRICT desde incident_history (código 23001 o 23503)
			await rejected(db.delete(s.incidents).where(eq(s.incidents.id, incToProtect.id)), [
				'23001',
				'23503'
			]);

			// Desactivar sede vinculada siteA (active = false)
			await db.update(s.sites).set({ active: false }).where(eq(s.sites.id, siteA.id));
			const [siteAUpdated] = await db.select().from(s.sites).where(eq(s.sites.id, siteA.id));
			assert.equal(siteAUpdated.active, false);

			// La incidencia vinculada sigue existiendo normalmente
			const [incLinked] = await db
				.select()
				.from(s.incidents)
				.where(eq(s.incidents.id, validIncidentA.id));
			assert.equal(incLinked.siteId, siteA.id);

			// Intentar borrar físicamente la sede siteA referenciada -> rechazado por RESTRICT desde incidents (código 23001 o 23503)
			await rejected(db.delete(s.sites).where(eq(s.sites.id, siteA.id)), ['23001', '23503']);
		}
	);

	// =========================================================================
	// 3.J Contador y rollback atómico
	// =========================================================================
	await t.test(
		'3.J Contador atómico por tenant y rollback transaccional completo ante fallo',
		async () => {
			const orgCounterTestA = await createOrg(db, s, 'Org Contador A');
			const orgCounterTestB = await createOrg(db, s, 'Org Contador B');

			const userCounterA = await createUser(db, s, 'Técnico Contador A');
			await createMembership(db, s, orgCounterTestA.id, userCounterA.id);

			// Función que ejecuta el upsert atómico de contador
			async function getNextNumber(client, orgId) {
				const res = await client.query(
					`INSERT INTO organization_counters (organization_id, last_incident_number, updated_at)
				 VALUES ($1, 1, now())
				 ON CONFLICT (organization_id)
				 DO UPDATE SET last_incident_number = organization_counters.last_incident_number + 1, updated_at = now()
				 RETURNING last_incident_number;`,
					[orgId]
				);
				return res.rows[0].last_incident_number;
			}

			// Primera creación en Org Counter A -> 1
			const numA1 = await getNextNumber(pg, orgCounterTestA.id);
			assert.equal(numA1, 1);

			// Segunda creación en Org Counter A -> 2
			const numA2 = await getNextNumber(pg, orgCounterTestA.id);
			assert.equal(numA2, 2);

			// Primera creación en Org Counter B -> 1 (independiente)
			const numB1 = await getNextNumber(pg, orgCounterTestB.id);
			assert.equal(numB1, 1);

			// Ejecución transaccional con fallo deliberado para probar rollback
			let failedAsExpected = false;
			try {
				await db.transaction(async (tx) => {
					// 1. Incrementar contador transaccionalmente (esperado: 3)
					const nextVal = await tx.execute(
						sql`INSERT INTO organization_counters (organization_id, last_incident_number, updated_at)
					    VALUES (${orgCounterTestA.id}::uuid, 1, now())
					    ON CONFLICT (organization_id)
					    DO UPDATE SET last_incident_number = organization_counters.last_incident_number + 1, updated_at = now()
					    RETURNING last_incident_number;`
					);
					const incNumber = nextVal.rows[0].last_incident_number;
					assert.equal(incNumber, 3);

					// 2. Insertar incidencia con ese número
					const [txInc] = await tx
						.insert(s.incidents)
						.values({
							organizationId: orgCounterTestA.id,
							incidentNumber: incNumber,
							title: 'Incidencia condenada al rollback',
							description: 'Esta incidencia no debe persistir',
							client: 'Cliente Test',
							createdByUserId: userCounterA.id
						})
						.returning();

					assert.ok(txInc);

					// 3. Provocar fallo deliberado al insertar historial con event_type inválido
					await tx.insert(s.incidentHistory).values({
						incidentId: txInc.id,
						organizationId: orgCounterTestA.id,
						eventType: 'invalid_event_trigger_rollback',
						actorType: 'user',
						actorUserId: userCounterA.id
					});
				});
			} catch (err) {
				failedAsExpected = true;
				assert.equal(errorCode(err), '23514'); // check_violation en event_type
			}

			assert.equal(failedAsExpected, true);

			// Comprobar que tras el rollback:
			// 1. La incidencia no existe
			const rolledBackInc = await db
				.select()
				.from(s.incidents)
				.where(
					sql`${s.incidents.organizationId} = ${orgCounterTestA.id}::uuid AND ${s.incidents.incidentNumber} = 3`
				);
			assert.equal(rolledBackInc.length, 0);

			// 2. El historial no existe
			const orphanHist = await db
				.select()
				.from(s.incidentHistory)
				.where(sql`${s.incidentHistory.organizationId} = ${orgCounterTestA.id}::uuid`);
			assert.equal(orphanHist.length, 0);

			// 3. El contador conserva su valor previo (2)
			const counterRow = await db
				.select()
				.from(s.organizationCounters)
				.where(sql`${s.organizationCounters.organizationId} = ${orgCounterTestA.id}::uuid`);
			assert.equal(counterRow[0].lastIncidentNumber, 2);
		}
	);

	await t.test(
		'3.K Validación de assigned_to_user_id: nullable, FK multi-tenant hacia memberships',
		async () => {
			// 1. Inserción con assignedToUserId = null es válida
			const [incNull] = await db
				.insert(s.incidents)
				.values({
					organizationId: orgA.id,
					incidentNumber: 1001,
					title: 'Incidencia sin asignar',
					description: 'Prueba null',
					client: 'Cliente A',
					createdByUserId: userCreatorA.id,
					assignedToUserId: null
				})
				.returning();
			assert.equal(incNull.assignedToUserId, null);

			// 2. Inserción con miembro de la misma organización es válida
			const [incAssigned] = await db
				.insert(s.incidents)
				.values({
					organizationId: orgA.id,
					incidentNumber: 1002,
					title: 'Incidencia asignada a miembro orgA',
					description: 'Prueba miembro orgA',
					client: 'Cliente A',
					createdByUserId: userCreatorA.id,
					assignedToUserId: userCreatorA.id
				})
				.returning();
			assert.equal(incAssigned.assignedToUserId, userCreatorA.id);

			// 3. Rechazo de usuario perteneciente a otra organización (cross-tenant FK)
			await rejected(
				db.insert(s.incidents).values({
					organizationId: orgA.id,
					incidentNumber: 1003,
					title: 'Cross tenant assignment',
					description: 'Prueba cross-tenant',
					client: 'Cliente A',
					createdByUserId: userCreatorA.id,
					assignedToUserId: userOtherOrg.id
				}),
				'23503'
			);

			// 4. Rechazo de usuario sin membresía
			await rejected(
				db.insert(s.incidents).values({
					organizationId: orgA.id,
					incidentNumber: 1004,
					title: 'No membership assignment',
					description: 'Prueba no membership',
					client: 'Cliente A',
					createdByUserId: userCreatorA.id,
					assignedToUserId: userNoMembership.id
				}),
				'23503'
			);
		}
	);

	await t.test(
		'3.L Validación de team_id: nullable, FK multi-tenant hacia teams, ON DELETE RESTRICT e índice',
		async () => {
			// Crear equipos en orgA y orgB
			const [teamA] = await db
				.insert(s.teams)
				.values({ organizationId: orgA.id, name: 'Equipo Redes A' })
				.returning();
			const [teamB] = await db
				.insert(s.teams)
				.values({ organizationId: orgB.id, name: 'Equipo Sistemas B' })
				.returning();

			// 1. Inserción con teamId = null es válida
			const [incNullTeam] = await db
				.insert(s.incidents)
				.values({
					organizationId: orgA.id,
					incidentNumber: 2001,
					title: 'Incidencia sin equipo',
					description: 'Prueba teamId null',
					client: 'Cliente A',
					createdByUserId: userCreatorA.id,
					teamId: null
				})
				.returning();
			assert.equal(incNullTeam.teamId, null);

			// 2. Inserción con equipo de la misma organización es válida
			const [incWithTeam] = await db
				.insert(s.incidents)
				.values({
					organizationId: orgA.id,
					incidentNumber: 2002,
					title: 'Incidencia con equipo orgA',
					description: 'Prueba teamId orgA',
					client: 'Cliente A',
					createdByUserId: userCreatorA.id,
					teamId: teamA.id
				})
				.returning();
			assert.equal(incWithTeam.teamId, teamA.id);

			// 3. Rechazo de equipo de otra organización (cross-tenant FK)
			await rejected(
				db.insert(s.incidents).values({
					organizationId: orgA.id,
					incidentNumber: 2003,
					title: 'Cross tenant team assignment',
					description: 'Prueba cross-tenant team',
					client: 'Cliente A',
					createdByUserId: userCreatorA.id,
					teamId: teamB.id
				}),
				'23503'
			);

			// 4. ON DELETE RESTRICT: no se puede borrar el equipo si tiene incidencias asociadas
			await rejected(db.delete(s.teams).where(eq(s.teams.id, teamA.id)), ['23001', '23503']);

			// 5. Verificar existencia del índice compuesto incidents_org_team_idx
			const indexRes = await pg.query(
				`SELECT indexname FROM pg_indexes WHERE tablename = 'incidents' AND indexname = 'incidents_org_team_idx';`
			);
			assert.equal(indexRes.rows.length, 1);
		}
	);
});

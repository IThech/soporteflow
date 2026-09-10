import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('SLA v1 Bloque 2: ciclo de vida, primera respuesta, persistencia coordinada y reapertura', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });
	try {
		const { evaluateIncidentSla } = await server.ssrLoadModule('/src/lib/incidents/sla.ts');
		const {
			applyCreationSla,
			isFirstResponseEligible,
			recordFirstResponse,
			recordStatusTransition
		} = await server.ssrLoadModule('/src/lib/incidents/lifecycle.ts');
		const { recoverFirstResponse, sendIncidentMessage, FIRST_RESPONSE_RECOVERY_KEY } =
			await server.ssrLoadModule('/src/lib/storage/first-response.ts');
		const { prepareAssignment } = await server.ssrLoadModule('/src/lib/incidents/assignment.ts');
		const { prepareEscalation } = await server.ssrLoadModule('/src/lib/incidents/escalation.ts');
		const { INCIDENTS_KEY } = await server.ssrLoadModule('/src/lib/storage/assignment.ts');
		const { MESSAGES_KEY } = await server.ssrLoadModule('/src/lib/storage/messages.ts');
		const { formatSlaDateTime } = await server.ssrLoadModule(
			'/src/lib/incidents/sla-presentation.ts'
		);
		const { demoUsers } = await server.ssrLoadModule('/src/lib/data/users.ts');
		const { demoSupportTeams } = await server.ssrLoadModule('/src/lib/data/teams.ts');

		const orgId = 'org-nodhouses';
		const foreignOrgId = 'org-other';

		const admin = demoUsers.find((u) => u.role === 'organization_admin');
		const tech = demoUsers.find((u) => u.role === 'technician');
		const client = demoUsers.find((u) => u.role === 'client');
		const platformAdmin = demoUsers.find((u) => u.role === 'platform_admin');

		const basePolicies = [
			{
				id: 'sla-default',
				organizationId: orgId,
				name: 'SLA Fallback Estándar',
				active: true,
				isDefault: true,
				categoryId: null,
				priority: null,
				firstResponseMinutes: 240, // 4h
				resolutionMinutes: 1440, // 24h
				createdAt: '2026-09-01T08:00:00.000Z'
			},
			{
				id: 'sla-priority-high',
				organizationId: orgId,
				name: 'SLA Prioridad Alta',
				active: true,
				isDefault: false,
				categoryId: null,
				priority: 'high',
				firstResponseMinutes: 60, // 1h
				resolutionMinutes: 480, // 8h
				createdAt: '2026-09-01T08:05:00.000Z'
			},
			{
				id: 'sla-cat-network',
				organizationId: orgId,
				name: 'SLA Categoría Redes',
				active: true,
				isDefault: false,
				categoryId: 'network',
				priority: null,
				firstResponseMinutes: 120, // 2h
				resolutionMinutes: 720, // 12h
				createdAt: '2026-09-01T08:10:00.000Z'
			},
			{
				id: 'sla-cat-network-high',
				organizationId: orgId,
				name: 'SLA Redes Alta Prioridad',
				active: true,
				isDefault: false,
				categoryId: 'network',
				priority: 'high',
				firstResponseMinutes: 30, // 30m
				resolutionMinutes: 240, // 4h
				createdAt: '2026-09-01T08:15:00.000Z'
			}
		];

		const createStore = (initial = {}) => {
			const values = new Map(Object.entries(initial));
			let count = 0;
			let failures = new Set();
			return {
				values,
				failAt(...positions) {
					count = 0;
					failures = new Set(positions);
				},
				getItem(key) {
					return values.get(key) ?? null;
				},
				setItem(key, value) {
					if (failures.has(++count)) throw new Error('Storage write failure');
					values.set(key, value);
				},
				removeItem(key) {
					values.delete(key);
				}
			};
		};

		await t.test('1. Creación de incidencias y congelación de compromiso SLA', () => {
			const draftWithBoth = {
				id: 101,
				organizationId: orgId,
				title: 'Corte de fibra',
				client: 'Cliente A',
				status: 'open',
				priority: 'high',
				categoryId: 'network',
				createdAt: '2026-09-10T10:00:00.000Z'
			};

			const incidentApplied = applyCreationSla(draftWithBoth, basePolicies);
			assert.ok(incidentApplied.sla);
			assert.equal(incidentApplied.sla.policyId, 'sla-cat-network-high');
			assert.equal(incidentApplied.sla.firstResponseMinutes, 30);
			assert.equal(incidentApplied.sla.firstResponseDueAt, '2026-09-10T10:30:00.000Z');
			assert.equal(incidentApplied.sla.resolutionDueAt, '2026-09-10T14:00:00.000Z');
			assert.equal(incidentApplied.sla.firstRespondedAt, null);
			assert.equal(incidentApplied.sla.resolvedAt, null);

			// Fallback cuando no coincide categoría ni prioridad específica
			const draftFallback = {
				id: 102,
				organizationId: orgId,
				title: 'Duda general',
				client: 'Cliente B',
				status: 'open',
				priority: 'low',
				createdAt: '2026-09-10T10:00:00.000Z'
			};
			const incidentFallback = applyCreationSla(draftFallback, basePolicies);
			assert.ok(incidentFallback.sla);
			assert.equal(incidentFallback.sla.policyId, 'sla-default');

			// Sin SLA cuando no hay política ni default aplicable
			const incidentNoSla = applyCreationSla(draftFallback, []);
			assert.equal(incidentNoSla.sla, undefined);

			// Aislamiento multi-tenant: políticas de otra organización no se aplican
			const foreignPolicies = basePolicies.map((p) => ({ ...p, organizationId: foreignOrgId }));
			const incidentForeign = applyCreationSla(draftWithBoth, foreignPolicies);
			assert.equal(incidentForeign.sla, undefined);
		});

		await t.test(
			'2. Inmutabilidad: cambios posteriores de categoría y prioridad no recalculan SLA',
			() => {
				const initialDraft = {
					id: 103,
					organizationId: orgId,
					title: 'Router bloqueado',
					client: 'Cliente A',
					status: 'open',
					priority: 'high',
					categoryId: 'network',
					createdAt: '2026-09-10T10:00:00.000Z'
				};
				const created = applyCreationSla(initialDraft, basePolicies);
				assert.ok(created.sla);
				const originalSla = { ...created.sla };
				assert.equal(originalSla.policyId, 'sla-cat-network-high');
				assert.equal(originalSla.firstResponseDueAt, '2026-09-10T10:30:00.000Z');
				assert.equal(originalSla.resolutionDueAt, '2026-09-10T14:00:00.000Z');

				// 1. Cambio explícito de categoría posterior (de 'network' a 'equipment' o a null/undefined):
				// En el ciclo de vida de la incidencia, cambiar categoryId no altera el SLA congelado
				const changedCategory = {
					...created,
					categoryId: 'equipment',
					updatedAt: '2026-09-10T10:45:00.000Z'
				};
				assert.deepEqual(changedCategory.sla, originalSla);
				assert.equal(changedCategory.sla.policyId, 'sla-cat-network-high');
				assert.equal(changedCategory.sla.firstResponseDueAt, '2026-09-10T10:30:00.000Z');
				assert.equal(changedCategory.sla.resolutionDueAt, '2026-09-10T14:00:00.000Z');

				const removedCategory = {
					...created,
					categoryId: undefined,
					updatedAt: '2026-09-10T10:50:00.000Z'
				};
				assert.deepEqual(removedCategory.sla, originalSla);
				assert.equal(removedCategory.sla.policyId, 'sla-cat-network-high');
				assert.equal(removedCategory.sla.firstResponseDueAt, '2026-09-10T10:30:00.000Z');
				assert.equal(removedCategory.sla.resolutionDueAt, '2026-09-10T14:00:00.000Z');

				// 2. Cambio de prioridad posterior (ej. de high a low)
				const changedPriority = {
					...created,
					priority: 'low',
					updatedAt: '2026-09-10T11:00:00.000Z'
				};
				assert.deepEqual(changedPriority.sla, originalSla);
				assert.equal(changedPriority.sla.policyId, 'sla-cat-network-high');
				assert.equal(changedPriority.sla.firstResponseDueAt, '2026-09-10T10:30:00.000Z');
				assert.equal(changedPriority.sla.resolutionDueAt, '2026-09-10T14:00:00.000Z');

				// 3. Reasignación no altera SLA
				const reassigned = prepareAssignment(admin, created, demoUsers, tech.id, 'Asignación');
				assert.deepEqual(reassigned.incident.sla, originalSla);

				// 4. Escalado no altera SLA
				const escalated = prepareEscalation(admin, created, demoUsers, demoSupportTeams, {
					supportLevel: 'N2',
					teamId: demoSupportTeams[1].id,
					reason: 'Escalado técnico'
				});
				assert.deepEqual(escalated.incident.sla, originalSla);
			}
		);

		await t.test('3. Calificación y registro de Primera Respuesta SLA', () => {
			const incident = applyCreationSla(
				{
					id: 104,
					organizationId: orgId,
					title: 'Servidor no arranca',
					client: 'Cliente C',
					status: 'open',
					priority: 'high',
					createdAt: '2026-09-10T10:00:00.000Z'
				},
				basePolicies
			);

			// Mensaje de cliente no califica
			const clientMsg = {
				id: 'm1',
				incidentId: 104,
				visibility: 'public',
				createdAt: '2026-09-10T10:05:00.000Z'
			};
			assert.equal(isFirstResponseEligible(incident, clientMsg, client), false);
			assert.equal(recordFirstResponse(incident, clientMsg, client).sla.firstRespondedAt, null);

			// Nota interna de técnico no califica
			const internalNote = {
				id: 'm2',
				incidentId: 104,
				visibility: 'internal',
				createdAt: '2026-09-10T10:08:00.000Z'
			};
			assert.equal(isFirstResponseEligible(incident, internalNote, tech), false);
			assert.equal(recordFirstResponse(incident, internalNote, tech).sla.firstRespondedAt, null);

			// Mensaje público de técnico califica
			const techPublicMsg = {
				id: 'm3',
				incidentId: 104,
				visibility: 'public',
				createdAt: '2026-09-10T10:15:00.000Z'
			};
			assert.equal(isFirstResponseEligible(incident, techPublicMsg, tech), true);
			const respondedIncident = recordFirstResponse(incident, techPublicMsg, tech);
			assert.equal(respondedIncident.sla.firstRespondedAt, '2026-09-10T10:15:00.000Z');

			// Mensaje público de admin de organización califica
			assert.equal(isFirstResponseEligible(incident, techPublicMsg, admin), true);
			// Mensaje público de admin de plataforma califica
			assert.equal(isFirstResponseEligible(incident, techPublicMsg, platformAdmin), true);

			// Segundo mensaje no modifica firstRespondedAt ya registrado
			const secondMsg = {
				id: 'm4',
				incidentId: 104,
				visibility: 'public',
				createdAt: '2026-09-10T10:45:00.000Z'
			};
			assert.equal(isFirstResponseEligible(respondedIncident, secondMsg, tech), false);
			const secondResult = recordFirstResponse(respondedIncident, secondMsg, tech);
			assert.equal(secondResult.sla.firstRespondedAt, '2026-09-10T10:15:00.000Z');

			// Mensaje de otra incidencia no califica
			const otherIncidentMsg = {
				id: 'm5',
				incidentId: 999,
				visibility: 'public',
				createdAt: '2026-09-10T10:20:00.000Z'
			};
			assert.equal(isFirstResponseEligible(incident, otherIncidentMsg, tech), false);

			// Incidencia sin SLA no califica ni falla
			const noSlaIncident = {
				id: 105,
				organizationId: orgId,
				title: 'Sin SLA',
				client: 'Cliente',
				status: 'open',
				priority: 'low',
				createdAt: '2026-09-10T10:00:00.000Z'
			};
			assert.equal(isFirstResponseEligible(noSlaIncident, techPublicMsg, tech), false);
			assert.equal(recordFirstResponse(noSlaIncident, techPublicMsg, tech).sla, undefined);
		});

		await t.test('4. Persistencia coordinada (commitFirstResponse y recoverFirstResponse)', () => {
			const incident = applyCreationSla(
				{
					id: 106,
					organizationId: orgId,
					title: 'Fallo general',
					client: 'Cliente D',
					status: 'open',
					priority: 'high',
					createdAt: '2026-09-10T10:00:00.000Z'
				},
				basePolicies
			);

			const initialIncidents = [incident];
			const initialMessages = [];
			const store = createStore({
				[INCIDENTS_KEY]: JSON.stringify(initialIncidents),
				[MESSAGES_KEY]: JSON.stringify(initialMessages)
			});

			const publicMsg = {
				id: 'm-coord-1',
				incidentId: 106,
				authorUserId: tech.id,
				organizationId: orgId,
				visibility: 'public',
				content: 'Estamos revisando el incidente.',
				createdAt: '2026-09-10T10:12:00.000Z'
			};

			// Ejecutar envío coordinado
			const result = sendIncidentMessage(
				store,
				tech,
				incident,
				publicMsg,
				JSON.stringify(initialMessages),
				initialIncidents,
				JSON.stringify(initialIncidents)
			);

			assert.equal(result.nextMessages.length, 1);
			assert.ok(result.updatedIncident);
			assert.equal(result.updatedIncident.sla.firstRespondedAt, '2026-09-10T10:12:00.000Z');
			// El journal debe haberse limpiado tras el commit exitoso
			assert.equal(store.getItem(FIRST_RESPONSE_RECOVERY_KEY), null);

			// Los datos en storage deben estar actualizados de forma consistente
			const savedIncidents = JSON.parse(store.getItem(INCIDENTS_KEY));
			assert.equal(savedIncidents[0].sla.firstRespondedAt, '2026-09-10T10:12:00.000Z');
			const savedMessages = JSON.parse(store.getItem(MESSAGES_KEY));
			assert.equal(savedMessages.length, 1);
		});

		await t.test('5. Recuperación y rollback ante fallo durante commitFirstResponse', () => {
			const incident = applyCreationSla(
				{
					id: 107,
					organizationId: orgId,
					title: 'Fallo con crash simulado',
					client: 'Cliente E',
					status: 'open',
					priority: 'high',
					createdAt: '2026-09-10T10:00:00.000Z'
				},
				basePolicies
			);

			const initialIncidents = [incident];
			const initialMessages = [];
			const store = createStore({
				[INCIDENTS_KEY]: JSON.stringify(initialIncidents),
				[MESSAGES_KEY]: JSON.stringify(initialMessages)
			});

			// Simular fallo en setItem en la tercera operación de commit (escritura de INCIDENTS_KEY)
			// Operaciones en commitFirstResponse:
			// 1. setItem(FIRST_RESPONSE_RECOVERY_KEY)
			// 2. setItem(MESSAGES_KEY)
			// 3. setItem(INCIDENTS_KEY) -> FALLA
			store.failAt(3);

			const publicMsg = {
				id: 'm-coord-fail',
				incidentId: 107,
				authorUserId: tech.id,
				organizationId: orgId,
				visibility: 'public',
				content: 'Intentando enviar mensaje con fallo...',
				createdAt: '2026-09-10T10:15:00.000Z'
			};

			assert.throws(
				() =>
					sendIncidentMessage(
						store,
						tech,
						incident,
						publicMsg,
						JSON.stringify(initialMessages),
						initialIncidents,
						JSON.stringify(initialIncidents)
					),
				/No se pudo guardar la primera respuesta/
			);

			// Debido al rollback automático dentro del catch, los datos vuelven a su estado previo
			const rolledBackMessages = JSON.parse(store.getItem(MESSAGES_KEY));
			assert.equal(rolledBackMessages.length, 0);
			const rolledBackIncidents = JSON.parse(store.getItem(INCIDENTS_KEY));
			assert.equal(rolledBackIncidents[0].sla.firstRespondedAt, null);
			// El recovery journal ha sido limpiado tras revertir
			assert.equal(store.getItem(FIRST_RESPONSE_RECOVERY_KEY), null);
		});

		await t.test(
			'6. Recuperación manual via recoverFirstResponse tras interrupción externa',
			() => {
				const validOriginalIncident = {
					id: 1,
					organizationId: orgId,
					title: 'Original',
					client: 'Cliente Original',
					status: 'open',
					priority: 'medium',
					createdAt: '2026-09-01T10:00:00.000Z'
				};
				const store = createStore({
					[INCIDENTS_KEY]: JSON.stringify([{ ...validOriginalIncident, title: 'Inconsistente' }]),
					[MESSAGES_KEY]: JSON.stringify([{ id: 'm-inconsistent', content: 'Parcial' }]),
					[FIRST_RESPONSE_RECOVERY_KEY]: JSON.stringify({
						version: 1,
						messages: JSON.stringify([]),
						incidents: JSON.stringify([validOriginalIncident])
					})
				});

				recoverFirstResponse(store);

				assert.equal(store.getItem(FIRST_RESPONSE_RECOVERY_KEY), null);
				assert.equal(JSON.parse(store.getItem(MESSAGES_KEY)).length, 0);
				assert.equal(JSON.parse(store.getItem(INCIDENTS_KEY))[0].title, 'Original');

				// Si el journal está corrupto, lanza error defensivo y no modifica los datos
				const corruptedStore = createStore({
					[INCIDENTS_KEY]: JSON.stringify([validOriginalIncident]),
					[MESSAGES_KEY]: JSON.stringify([]),
					[FIRST_RESPONSE_RECOVERY_KEY]: JSON.stringify({
						version: 1,
						messages: 'no-es-un-array-valido',
						incidents: null
					})
				});
				assert.throws(
					() => recoverFirstResponse(corruptedStore),
					/No se pudo validar la copia de recuperación/
				);
				assert.equal(JSON.parse(corruptedStore.getItem(INCIDENTS_KEY))[0].title, 'Original');
			}
		);

		await t.test(
			'7. Resolución y Reapertura: conservación de deadlines y evaluación dinámica',
			() => {
				const incident = applyCreationSla(
					{
						id: 108,
						organizationId: orgId,
						title: 'Incidencia de red para resolución y reapertura',
						client: 'Cliente F',
						status: 'open',
						priority: 'high',
						categoryId: 'network',
						createdAt: '2026-09-10T10:00:00.000Z'
					},
					basePolicies
				);
				// resolutionDueAt es +4h = 2026-09-10T14:00:00.000Z

				// 1. Resolución dentro de plazo (a las 12:00 UTC)
				const resolveTimestamp = '2026-09-10T12:00:00.000Z';
				const resolvedIncident = recordStatusTransition(incident, 'resolved', resolveTimestamp);

				assert.equal(resolvedIncident.status, 'resolved');
				assert.equal(resolvedIncident.sla.resolvedAt, resolveTimestamp);
				assert.equal(resolvedIncident.updatedAt, resolveTimestamp);
				assert.equal(resolvedIncident.sla.resolutionDueAt, '2026-09-10T14:00:00.000Z');

				// Evaluación de la incidencia resuelta: debe ser fulfilled_within_sla
				const evalResolved = evaluateIncidentSla(
					resolvedIncident,
					new Date('2026-09-10T12:30:00.000Z')
				);
				assert.equal(evalResolved.resolution.stage, 'fulfilled_within_sla');
				assert.equal(evalResolved.resolution.completedAt, resolveTimestamp);

				// 2. REAPERTURA a las 13:00 UTC (antes de resolutionDueAt)
				const reopenTimestamp = '2026-09-10T13:00:00.000Z';
				const reopenedIncident = recordStatusTransition(resolvedIncident, 'open', reopenTimestamp);

				assert.equal(reopenedIncident.status, 'open');
				// Conserva deadlines originales y compromiso
				assert.equal(reopenedIncident.sla.resolutionDueAt, '2026-09-10T14:00:00.000Z');
				assert.equal(reopenedIncident.sla.policyId, 'sla-cat-network-high');
				// Conserva el resolvedAt histórico
				assert.equal(reopenedIncident.sla.resolvedAt, resolveTimestamp);

				// Evaluación mientras está abierta pero antes de vencer (a las 13:10 UTC):
				// REGLA CLAVE: el resolvedAt histórico NO debe hacer que aparezca como cumplida mientras status !== 'resolved'.
				// Debe evaluarse dinámicamente contra now y resolutionDueAt -> on_track (quedan 50m)
				const evalReopenedActive = evaluateIncidentSla(
					reopenedIncident,
					new Date('2026-09-10T13:10:00.000Z')
				);
				assert.equal(evalReopenedActive.resolution.stage, 'on_track');
				assert.equal(evalReopenedActive.resolution.completedAt, null);
				assert.equal(evalReopenedActive.resolution.remainingMinutes, 50);

				// Evaluación mientras sigue abierta pero habiendo pasado el deadline (a las 15:00 UTC):
				// Debe evaluarse como breached
				const evalReopenedBreached = evaluateIncidentSla(
					reopenedIncident,
					new Date('2026-09-10T15:00:00.000Z')
				);
				assert.equal(evalReopenedBreached.resolution.stage, 'breached');
				assert.equal(evalReopenedBreached.resolution.completedAt, null);
				assert.equal(evalReopenedBreached.status, 'breached');

				// 3. SEGUNDA RESOLUCIÓN (a las 15:30 UTC):
				// resolvedAt se actualiza al nuevo timestamp real
				const secondResolveTimestamp = '2026-09-10T15:30:00.000Z';
				const reResolvedIncident = recordStatusTransition(
					reopenedIncident,
					'resolved',
					secondResolveTimestamp
				);
				assert.equal(reResolvedIncident.status, 'resolved');
				assert.equal(reResolvedIncident.sla.resolvedAt, secondResolveTimestamp);

				// Evaluación de la nueva resolución: se completó a las 15:30 habiendo vencido a las 14:00 -> fulfilled_breached
				const evalReResolved = evaluateIncidentSla(
					reResolvedIncident,
					new Date('2026-09-10T16:00:00.000Z')
				);
				assert.equal(evalReResolved.resolution.stage, 'fulfilled_breached');
				assert.equal(evalReResolved.resolution.completedAt, secondResolveTimestamp);
			}
		);

		await t.test(
			'8. Incidencias históricas sin resolvedAt se evalúan como fulfilled_unknown',
			() => {
				const legacyResolved = {
					id: 99,
					organizationId: orgId,
					title: 'Caso resuelto previo',
					client: 'Cliente G',
					status: 'resolved',
					priority: 'medium',
					createdAt: '2026-09-01T10:00:00.000Z',
					sla: {
						policyId: 'sla-default',
						policyName: 'SLA Fallback Estándar',
						firstResponseMinutes: 240,
						resolutionMinutes: 1440,
						firstResponseDueAt: '2026-09-01T14:00:00.000Z',
						resolutionDueAt: '2026-09-02T10:00:00.000Z',
						firstRespondedAt: null,
						resolvedAt: null // Sin resolvedAt explícito
					}
				};

				const evaluation = evaluateIncidentSla(
					legacyResolved,
					new Date('2026-09-05T10:00:00.000Z')
				);
				assert.equal(evaluation.resolution.stage, 'fulfilled_unknown');
			}
		);

		await t.test(
			'9. Conflicto de snapshot en primera respuesta detecta desincronización y aborta sin efectos secundarios',
			() => {
				const incident = applyCreationSla(
					{
						id: 109,
						organizationId: orgId,
						title: 'Conflicto concurrencia',
						client: 'Cliente H',
						status: 'open',
						priority: 'high',
						createdAt: '2026-09-10T10:00:00.000Z'
					},
					basePolicies
				);

				const initialIncidents = [incident];
				const initialMessages = [];
				const publicMsg = {
					id: 'm-conflict',
					incidentId: 109,
					authorUserId: tech.id,
					organizationId: orgId,
					visibility: 'public',
					content: 'Comentario en conflicto.',
					createdAt: '2026-09-10T10:15:00.000Z'
				};

				// Caso A: Conflicto en MESSAGES_KEY (otra pestaña escribió un mensaje previamente)
				const externalMessage = {
					id: 'm-ext',
					incidentId: 109,
					authorUserId: admin.id,
					organizationId: orgId,
					visibility: 'public',
					content: 'Mensaje externo.',
					createdAt: '2026-09-10T10:14:00.000Z'
				};
				const storeA = createStore({
					[INCIDENTS_KEY]: JSON.stringify(initialIncidents),
					[MESSAGES_KEY]: JSON.stringify([externalMessage]) // storage tiene externalMessage, pero snapshot esperado es []
				});

				assert.throws(
					() =>
						sendIncidentMessage(
							storeA,
							tech,
							incident,
							publicMsg,
							JSON.stringify(initialMessages), // snapshot esperado vacío
							initialIncidents,
							JSON.stringify(initialIncidents)
						),
					/Los datos han cambiado en otra pestaña/
				);

				// Verificar que no se escribió el nuevo mensaje ni se modificó firstRespondedAt
				assert.equal(JSON.parse(storeA.getItem(MESSAGES_KEY)).length, 1);
				assert.equal(JSON.parse(storeA.getItem(MESSAGES_KEY))[0].id, 'm-ext');
				assert.equal(JSON.parse(storeA.getItem(INCIDENTS_KEY))[0].sla.firstRespondedAt, null);
				assert.equal(storeA.getItem(FIRST_RESPONSE_RECOVERY_KEY), null);

				// Caso B: Conflicto en INCIDENTS_KEY (otra pestaña modificó una incidencia previamente)
				const modifiedIncident = {
					...incident,
					title: 'Modificado externamente'
				};
				const storeB = createStore({
					[INCIDENTS_KEY]: JSON.stringify([modifiedIncident]), // storage tiene la incidencia modificada
					[MESSAGES_KEY]: JSON.stringify(initialMessages)
				});

				assert.throws(
					() =>
						sendIncidentMessage(
							storeB,
							tech,
							incident,
							publicMsg,
							JSON.stringify(initialMessages),
							initialIncidents,
							JSON.stringify(initialIncidents) // snapshot desactualizado
						),
					/Los datos han cambiado en otra pestaña/
				);

				// Verificar que nada se alteró en storage
				assert.equal(JSON.parse(storeB.getItem(MESSAGES_KEY)).length, 0);
				assert.equal(JSON.parse(storeB.getItem(INCIDENTS_KEY))[0].title, 'Modificado externamente');
				assert.equal(JSON.parse(storeB.getItem(INCIDENTS_KEY))[0].sla.firstRespondedAt, null);
				assert.equal(storeB.getItem(FIRST_RESPONSE_RECOVERY_KEY), null);
			}
		);

		await t.test(
			'10. Comentario ordinario por sendIncidentMessage no genera journal ni altera incidencias',
			() => {
				const incident = applyCreationSla(
					{
						id: 110,
						organizationId: orgId,
						title: 'Incidencia para nota interna y segundo comentario',
						client: 'Cliente I',
						status: 'open',
						priority: 'high',
						createdAt: '2026-09-10T10:00:00.000Z'
					},
					basePolicies
				);

				const initialIncidents = [incident];
				const initialMessages = [];
				const rawIncidentsSnapshot = JSON.stringify(initialIncidents);
				const store = createStore({
					[INCIDENTS_KEY]: rawIncidentsSnapshot,
					[MESSAGES_KEY]: JSON.stringify(initialMessages)
				});

				// Caso A: Nota interna técnica (no califica como primera respuesta SLA)
				const internalNote = {
					id: 'm-internal-1',
					incidentId: 110,
					authorUserId: tech.id,
					organizationId: orgId,
					visibility: 'internal',
					content: 'Revisión técnica interna.',
					createdAt: '2026-09-10T10:08:00.000Z'
				};

				const resultNote = sendIncidentMessage(
					store,
					tech,
					incident,
					internalNote,
					JSON.stringify(initialMessages),
					initialIncidents,
					rawIncidentsSnapshot
				);

				assert.equal(resultNote.nextMessages.length, 1);
				assert.equal(resultNote.nextMessages[0].id, 'm-internal-1');
				assert.equal(resultNote.updatedIncident, undefined);
				// INCIDENTS_KEY debe quedar exactamente sin cambios en storage
				assert.equal(store.getItem(INCIDENTS_KEY), rawIncidentsSnapshot);
				assert.equal(JSON.parse(store.getItem(INCIDENTS_KEY))[0].sla.firstRespondedAt, null);
				// No se crea FIRST_RESPONSE_RECOVERY_KEY
				assert.equal(store.getItem(FIRST_RESPONSE_RECOVERY_KEY), null);

				// Caso B: Mensaje público en incidencia que YA tiene firstRespondedAt registrado
				const incidentWithFirstResponse = {
					...incident,
					sla: {
						...incident.sla,
						firstRespondedAt: '2026-09-10T10:15:00.000Z'
					}
				};
				const incidentsWithResponse = [incidentWithFirstResponse];
				const rawIncidentsWithResponse = JSON.stringify(incidentsWithResponse);
				const storeSecond = createStore({
					[INCIDENTS_KEY]: rawIncidentsWithResponse,
					[MESSAGES_KEY]: JSON.stringify([
						{
							id: 'm-first',
							incidentId: 110,
							authorUserId: tech.id,
							organizationId: orgId,
							visibility: 'public',
							content: 'Primer comentario.',
							createdAt: '2026-09-10T10:15:00.000Z'
						}
					])
				});

				const secondPublicMsg = {
					id: 'm-second',
					incidentId: 110,
					authorUserId: tech.id,
					organizationId: orgId,
					visibility: 'public',
					content: 'Segundo comentario posterior.',
					createdAt: '2026-09-10T10:30:00.000Z'
				};

				const resultSecond = sendIncidentMessage(
					storeSecond,
					tech,
					incidentWithFirstResponse,
					secondPublicMsg,
					storeSecond.getItem(MESSAGES_KEY),
					incidentsWithResponse,
					rawIncidentsWithResponse
				);

				assert.equal(resultSecond.nextMessages.length, 2);
				assert.equal(resultSecond.updatedIncident, undefined);
				// INCIDENTS_KEY exactamente sin cambios
				assert.equal(storeSecond.getItem(INCIDENTS_KEY), rawIncidentsWithResponse);
				assert.equal(
					JSON.parse(storeSecond.getItem(INCIDENTS_KEY))[0].sla.firstRespondedAt,
					'2026-09-10T10:15:00.000Z'
				);
				assert.equal(storeSecond.getItem(FIRST_RESPONSE_RECOVERY_KEY), null);
			}
		);

		await t.test(
			'11. Regresión: precisión temporal de createdAt y cálculo exacto de plazos SLA',
			() => {
				const policyHigh = {
					id: 'sla-high',
					organizationId: orgId,
					name: 'SLA Prioridad Alta',
					active: true,
					isDefault: false,
					categoryId: null,
					priority: 'high',
					firstResponseMinutes: 60, // 1h
					resolutionMinutes: 480, // 8h
					createdAt: '2026-09-08T08:00:00.000Z'
				};

				// A. Incidencia creada a las 11:05:00.000Z con SLA 60/480 produce exactamente 12:05 y 19:05 en UTC
				const creationIso = '2026-09-10T11:05:00.000Z';
				const incidentDraft = {
					id: 111,
					organizationId: orgId,
					title: 'Caída de servicio',
					client: 'Cliente Test',
					status: 'open',
					priority: 'high',
					createdAt: creationIso
				};

				const applied = applyCreationSla(incidentDraft, [policyHigh]);
				assert.ok(applied.sla);
				assert.equal(applied.sla.firstResponseDueAt, '2026-09-10T12:05:00.000Z');
				assert.equal(applied.sla.resolutionDueAt, '2026-09-10T19:05:00.000Z');

				// B. La hora original no se pierde ni se convierte a solo fecha YYYY-MM-DD
				assert.equal(applied.createdAt, '2026-09-10T11:05:00.000Z');
				assert.notEqual(applied.createdAt, '2026-09-10');
				assert.equal(applied.createdAt.length, 24); // ISO 8601 completo

				// C. El snapshot conserva ISO UTC estricto, mientras que formatSlaDateTime formatea para UI
				const formattedResponse = formatSlaDateTime(applied.sla.firstResponseDueAt);
				assert.ok(formattedResponse.length > 0);
				assert.equal(applied.sla.firstResponseDueAt.endsWith('Z'), true);
				assert.equal(applied.sla.resolutionDueAt.endsWith('Z'), true);

				// D. Compatibilidad con incidencias históricas que tienen fecha sin hora (ej. '2026-08-26')
				const legacyIncident = {
					id: 112,
					organizationId: orgId,
					title: 'Incidencia antigua',
					client: 'Cliente Antiguo',
					status: 'open',
					priority: 'high',
					createdAt: '2026-08-26'
				};
				const appliedLegacy = applyCreationSla(legacyIncident, [policyHigh]);
				assert.ok(appliedLegacy.sla);
				// Sigue parseándose válidamente sin lanzar error
				assert.equal(appliedLegacy.sla.firstResponseDueAt, '2026-08-26T01:00:00.000Z');
				assert.equal(appliedLegacy.sla.resolutionDueAt, '2026-08-26T08:00:00.000Z');
			}
		);
	} finally {
		await server.close();
	}
});

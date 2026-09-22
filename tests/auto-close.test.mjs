import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

function createStore(initial = {}) {
	const values = new Map(Object.entries(initial));
	let writeCount = 0;
	let failures = new Set();
	return {
		values,
		failAt(...positions) {
			writeCount = 0;
			failures = new Set(positions);
		},
		getItem(key) {
			return values.get(key) ?? null;
		},
		setItem(key, value) {
			if (failures.has(++writeCount)) {
				throw new Error('Simulated Storage write failure: ' + key);
			}
			values.set(key, String(value));
		},
		removeItem(key) {
			if (failures.has(++writeCount)) {
				throw new Error('Simulated Storage remove failure: ' + key);
			}
			values.delete(key);
		}
	};
}

test('SoporteFlow — Consistencia del Cierre Automático (auto-close)', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const { syncAndCommitAutoClosures, hasPendingRecoveryJournal } = await server.ssrLoadModule(
			'/src/lib/storage/auto-close.ts'
		);
		const {
			INCIDENTS_KEY,
			HISTORY_KEY,
			RECOVERY_KEY: ASSIGNMENT_RECOVERY_KEY,
			TRANSITION_RECOVERY_KEY,
			recoverAssignment
		} = await server.ssrLoadModule('/src/lib/storage/assignment.ts');
		const { FIRST_RESPONSE_RECOVERY_KEY } = await server.ssrLoadModule(
			'/src/lib/storage/first-response.ts'
		);
		const { SYSTEM_ACTOR_ID } = await server.ssrLoadModule('/src/lib/incidents/history.ts');

		const baseResolvedIncident = {
			id: 701,
			organizationId: 'org-test',
			title: 'Impresora sin tóner',
			client: 'Empresa Test',
			clientUserId: 'user-client-1',
			status: 'resolved',
			priority: 'medium',
			createdAt: '2026-09-10T10:00:00.000Z',
			resolvedAt: '2026-09-10T12:00:00.000Z',
			assignedToUserId: 'tech-1'
		};

		const initialHistory = [
			{
				id: 'h-resolved',
				incidentId: 701,
				organizationId: 'org-test',
				actorUserId: 'tech-1',
				timestamp: '2026-09-10T12:00:00.000Z',
				eventType: 'resolved',
				previousValue: { status: 'open' },
				newValue: { status: 'resolved', solution: 'Tóner sustituido' }
			}
		];

		const nowAfter24h = new Date('2026-09-11T12:05:00.000Z');
		const expectedClosedAt = '2026-09-11T12:00:00.000Z'; // resolvedAt + 24h exactas

		// 1. Guardado correcto
		await t.test(
			'1. Guardado correcto: persiste incidencias e historial determinista y limpia diario',
			() => {
				const store = createStore({
					[INCIDENTS_KEY]: JSON.stringify([baseResolvedIncident]),
					[HISTORY_KEY]: JSON.stringify(initialHistory)
				});

				const result = syncAndCommitAutoClosures(
					store,
					[baseResolvedIncident],
					initialHistory,
					JSON.stringify([baseResolvedIncident]),
					JSON.stringify(initialHistory),
					nowAfter24h
				);

				assert.equal(result.changed, true);
				assert.equal(result.status, 'committed');
				assert.deepEqual(result.closedIncidentIds, [701]);

				// Estado en memoria resultante
				assert.equal(result.state.incidents[0].status, 'closed');
				assert.equal(result.state.incidents[0].closureType, 'auto_closed');
				assert.equal(result.state.incidents[0].closedAt, expectedClosedAt);
				assert.equal(result.state.history.length, 2);
				assert.equal(result.state.history[1].actorUserId, SYSTEM_ACTOR_ID);
				assert.equal(result.state.history[1].eventType, 'closed');

				// Persistencia en storage
				const savedIncidents = JSON.parse(store.getItem(INCIDENTS_KEY));
				assert.equal(savedIncidents[0].status, 'closed');
				assert.equal(savedIncidents[0].closedAt, expectedClosedAt);

				const savedHistory = JSON.parse(store.getItem(HISTORY_KEY));
				assert.equal(savedHistory.length, 2);
				assert.equal(savedHistory[1].actorUserId, SYSTEM_ACTOR_ID);

				// Diario eliminado tras commit exitoso
				assert.equal(store.getItem(ASSIGNMENT_RECOVERY_KEY), null);
			}
		);

		// 2. Fallo durante la escritura de incidencias
		await t.test(
			'2. Fallo durante escritura de incidencias: no reporta commit y no deja datos inconsistentes',
			() => {
				const store = createStore({
					[INCIDENTS_KEY]: JSON.stringify([baseResolvedIncident]),
					[HISTORY_KEY]: JSON.stringify(initialHistory)
				});

				// Operaciones en commitAssignment:
				// 1. setItem(ASSIGNMENT_RECOVERY_KEY)
				// 2. setItem(INCIDENTS_KEY) -> FALLA
				store.failAt(2);

				assert.throws(
					() =>
						syncAndCommitAutoClosures(
							store,
							[baseResolvedIncident],
							initialHistory,
							JSON.stringify([baseResolvedIncident]),
							JSON.stringify(initialHistory),
							nowAfter24h
						),
					/No se pudo guardar la asignación/
				);

				// Storage queda restaurado a resolved por el rollback
				const savedIncidents = JSON.parse(store.getItem(INCIDENTS_KEY));
				assert.equal(savedIncidents[0].status, 'resolved');
				assert.equal(store.getItem(ASSIGNMENT_RECOVERY_KEY), null);
			}
		);

		// 3. Fallo durante la escritura del historial
		await t.test(
			'3. Fallo durante escritura del historial: rollback restaura incidencias a resolved',
			() => {
				const store = createStore({
					[INCIDENTS_KEY]: JSON.stringify([baseResolvedIncident]),
					[HISTORY_KEY]: JSON.stringify(initialHistory)
				});

				// 1. setItem(RECOVERY_KEY) -> éxito
				// 2. setItem(INCIDENTS_KEY) -> éxito ('closed')
				// 3. setItem(HISTORY_KEY) -> FALLA
				store.failAt(3);

				assert.throws(
					() =>
						syncAndCommitAutoClosures(
							store,
							[baseResolvedIncident],
							initialHistory,
							JSON.stringify([baseResolvedIncident]),
							JSON.stringify(initialHistory),
							nowAfter24h
						),
					/No se pudo guardar la asignación/
				);

				// Rollback debió restaurar INCIDENTS_KEY a 'resolved'
				const savedIncidents = JSON.parse(store.getItem(INCIDENTS_KEY));
				assert.equal(savedIncidents[0].status, 'resolved');
				const savedHistory = JSON.parse(store.getItem(HISTORY_KEY));
				assert.equal(savedHistory.length, 1);
				assert.equal(store.getItem(ASSIGNMENT_RECOVERY_KEY), null);
			}
		);

		// 4. Conflicto entre pestañas
		await t.test(
			'4. Conflicto entre pestañas: resolución segura y validación previa',
			async (t2) => {
				await t2.test(
					'4.1 Otra pestaña ya auto-cerró la incidencia: adopta datos frescos válidos sin error',
					() => {
						// Pestaña B ya cerró la incidencia en storage
						const closedIncidentByB = {
							...baseResolvedIncident,
							status: 'closed',
							closedAt: expectedClosedAt,
							closureType: 'auto_closed'
						};
						const historyWithClose = [
							...initialHistory,
							{
								id: 'h-auto-b',
								incidentId: 701,
								organizationId: 'org-test',
								actorUserId: SYSTEM_ACTOR_ID,
								timestamp: expectedClosedAt,
								eventType: 'closed',
								newValue: {
									status: 'closed',
									closedAt: expectedClosedAt,
									closureType: 'auto_closed'
								}
							}
						];

						const store = createStore({
							[INCIDENTS_KEY]: JSON.stringify([closedIncidentByB]),
							[HISTORY_KEY]: JSON.stringify(historyWithClose)
						});

						// Pestaña A llega con su snapshot viejo en 'resolved'
						const result = syncAndCommitAutoClosures(
							store,
							[baseResolvedIncident],
							initialHistory,
							JSON.stringify([baseResolvedIncident]), // snapshot viejo
							JSON.stringify(initialHistory),
							nowAfter24h
						);

						assert.equal(result.changed, true);
						assert.equal(result.status, 'conflict_resolved');
						assert.equal(result.state.incidents[0].status, 'closed');
						assert.equal(result.state.history.length, 2);
						// No hubo escrituras adicionales
						assert.equal(store.getItem(ASSIGNMENT_RECOVERY_KEY), null);
					}
				);

				await t2.test(
					'4.2 Otra pestaña modificó otra incidencia: aplica cierre sobre datos frescos válidos',
					() => {
						// Pestaña B añadió una segunda incidencia 702
						const freshListFromB = [
							baseResolvedIncident,
							{ ...baseResolvedIncident, id: 702, title: 'Nueva incidencia creada en pestaña B' }
						];

						const store = createStore({
							[INCIDENTS_KEY]: JSON.stringify(freshListFromB),
							[HISTORY_KEY]: JSON.stringify(initialHistory)
						});

						// Pestaña A tenía snapshot solo con [701]
						const result = syncAndCommitAutoClosures(
							store,
							[baseResolvedIncident],
							initialHistory,
							JSON.stringify([baseResolvedIncident]), // snapshot obsoleto
							JSON.stringify(initialHistory),
							nowAfter24h
						);

						assert.equal(result.changed, true);
						assert.equal(result.status, 'committed');
						assert.equal(result.state.incidents.length, 2);
						assert.equal(result.state.incidents[0].status, 'closed');
						assert.equal(result.state.incidents[1].id, 702); // La incidencia de B se conserva!
					}
				);

				await t2.test(
					'4.3 Otra pestaña dejó datos corruptos: bloquea el auto-cierre y emite error explícito',
					() => {
						const store = createStore({
							[INCIDENTS_KEY]: '{"datos_corruptos":true}',
							[HISTORY_KEY]: JSON.stringify(initialHistory)
						});

						assert.throws(
							() =>
								syncAndCommitAutoClosures(
									store,
									[baseResolvedIncident],
									initialHistory,
									JSON.stringify([baseResolvedIncident]),
									JSON.stringify(initialHistory),
									nowAfter24h
								),
							/no son válidos/i
						);

						// No se sobrescribió nada
						assert.equal(store.getItem(INCIDENTS_KEY), '{"datos_corruptos":true}');
					}
				);
			}
		);

		// 5. Diario de recuperación pendiente
		await t.test(
			'5. Diario de recuperación pendiente en cualquier subsistema bloquea el auto-cierre',
			() => {
				const storeWithAssignmentRecovery = createStore({
					[ASSIGNMENT_RECOVERY_KEY]: JSON.stringify({ version: 1 }),
					[INCIDENTS_KEY]: JSON.stringify([baseResolvedIncident]),
					[HISTORY_KEY]: JSON.stringify(initialHistory)
				});

				assert.equal(hasPendingRecoveryJournal(storeWithAssignmentRecovery), true);
				assert.throws(
					() =>
						syncAndCommitAutoClosures(
							storeWithAssignmentRecovery,
							[baseResolvedIncident],
							initialHistory,
							JSON.stringify([baseResolvedIncident]),
							JSON.stringify(initialHistory),
							nowAfter24h
						),
					/recuperación pendiente/i
				);

				const storeWithTransitionRecovery = createStore({
					[TRANSITION_RECOVERY_KEY]: JSON.stringify({ version: 1 }),
					[INCIDENTS_KEY]: JSON.stringify([baseResolvedIncident]),
					[HISTORY_KEY]: JSON.stringify(initialHistory)
				});

				assert.equal(hasPendingRecoveryJournal(storeWithTransitionRecovery), true);
				assert.throws(
					() =>
						syncAndCommitAutoClosures(
							storeWithTransitionRecovery,
							[baseResolvedIncident],
							initialHistory,
							JSON.stringify([baseResolvedIncident]),
							JSON.stringify(initialHistory),
							nowAfter24h
						),
					/recuperación pendiente/i
				);

				const storeWithFirstResponseRecovery = createStore({
					[FIRST_RESPONSE_RECOVERY_KEY]: JSON.stringify({ version: 1 }),
					[INCIDENTS_KEY]: JSON.stringify([baseResolvedIncident]),
					[HISTORY_KEY]: JSON.stringify(initialHistory)
				});

				assert.equal(hasPendingRecoveryJournal(storeWithFirstResponseRecovery), true);
				assert.throws(
					() =>
						syncAndCommitAutoClosures(
							storeWithFirstResponseRecovery,
							[baseResolvedIncident],
							initialHistory,
							JSON.stringify([baseResolvedIncident]),
							JSON.stringify(initialHistory),
							nowAfter24h
						),
					/recuperación pendiente/i
				);
			}
		);

		// 6. Ejecución repetida sin duplicar eventos de cierre
		await t.test('6. Idempotencia: ejecuciones repetidas devuelven changed: false', () => {
			const closedIncident = {
				...baseResolvedIncident,
				status: 'closed',
				closedAt: expectedClosedAt,
				closureType: 'auto_closed'
			};
			const historyWithClose = [
				...initialHistory,
				{
					id: 'h-auto-1',
					incidentId: 701,
					organizationId: 'org-test',
					actorUserId: SYSTEM_ACTOR_ID,
					timestamp: expectedClosedAt,
					eventType: 'closed',
					newValue: { status: 'closed', closedAt: expectedClosedAt, closureType: 'auto_closed' }
				}
			];

			const store = createStore({
				[INCIDENTS_KEY]: JSON.stringify([closedIncident]),
				[HISTORY_KEY]: JSON.stringify(historyWithClose)
			});

			const result = syncAndCommitAutoClosures(
				store,
				[closedIncident],
				historyWithClose,
				JSON.stringify([closedIncident]),
				JSON.stringify(historyWithClose),
				new Date('2026-09-11T13:00:00.000Z') // 1 hora después
			);

			assert.equal(result.changed, false);
			assert.equal(result.status, 'unchanged');
			assert.equal(result.closedIncidentIds.length, 0);

			// El historial sigue teniendo exactamente 2 entradas, no se duplicó nada
			const savedHistory = JSON.parse(store.getItem(HISTORY_KEY));
			assert.equal(savedHistory.length, 2);
		});

		// 7. Recuperación correcta tras recargar la aplicación
		await t.test(
			'7. Recuperación tras cierre abrupto: recoverAssignment restaura y auto-close completa',
			() => {
				// Simular corte del navegador: ASSIGNMENT_RECOVERY_KEY contiene el estado inicial,
				// INCIDENTS_KEY quedó en 'closed' parcialmente, pero HISTORY_KEY no se llegó a escribir
				const recoveryJournal = {
					version: 1,
					incidents: JSON.stringify([baseResolvedIncident]), // 'resolved'
					history: JSON.stringify(initialHistory)
				};

				const store = createStore({
					[ASSIGNMENT_RECOVERY_KEY]: JSON.stringify(recoveryJournal),
					[INCIDENTS_KEY]: JSON.stringify([
						{ ...baseResolvedIncident, status: 'closed', closedAt: expectedClosedAt }
					]),
					[HISTORY_KEY]: JSON.stringify(initialHistory)
				});

				// Paso 1 de onMount: recoverAssignment
				recoverAssignment(store);
				assert.equal(store.getItem(ASSIGNMENT_RECOVERY_KEY), null);
				assert.equal(JSON.parse(store.getItem(INCIDENTS_KEY))[0].status, 'resolved');

				// Paso 2 de onMount: auto-close seguro determinista
				const result = syncAndCommitAutoClosures(
					store,
					JSON.parse(store.getItem(INCIDENTS_KEY)),
					JSON.parse(store.getItem(HISTORY_KEY)),
					store.getItem(INCIDENTS_KEY),
					store.getItem(HISTORY_KEY),
					nowAfter24h
				);

				assert.equal(result.changed, true);
				assert.equal(result.status, 'committed');
				assert.equal(JSON.parse(store.getItem(INCIDENTS_KEY))[0].status, 'closed');
				assert.equal(JSON.parse(store.getItem(HISTORY_KEY)).length, 2);
			}
		);
	} finally {
		await server.close();
	}
});

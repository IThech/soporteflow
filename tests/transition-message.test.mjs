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

test('Persistencia coordinada de transiciones con mensajes (rechazo y reapertura)', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const { commitTransitionWithMessage, recoverTransitionWithMessage, TRANSITION_RECOVERY_KEY } =
			await server.ssrLoadModule('/src/lib/storage/transition-message.ts');
		const { INCIDENTS_KEY, HISTORY_KEY, RECOVERY_KEY, commitAssignment } =
			await server.ssrLoadModule('/src/lib/storage/assignment.ts');
		const { MESSAGES_KEY, loadMessages, appendMessage } = await server.ssrLoadModule(
			'/src/lib/storage/messages.ts'
		);
		const { FIRST_RESPONSE_RECOVERY_KEY, commitFirstResponse } = await server.ssrLoadModule(
			'/src/lib/storage/first-response.ts'
		);
		const { commitIncidentEdit } = await server.ssrLoadModule('/src/lib/storage/incident-edit.ts');
		const { completeInternalNoteEffects } = await server.ssrLoadModule(
			'/src/lib/storage/internal-note-effects.ts'
		);
		const { recordStatusTransition } = await server.ssrLoadModule(
			'/src/lib/incidents/lifecycle.ts'
		);

		const baseIncident = {
			id: 201,
			organizationId: 'org-test',
			title: 'Error de conexión VPN',
			client: 'Empresa Test',
			clientUserId: 'user-client-1',
			status: 'resolved',
			priority: 'high',
			createdAt: '2026-09-10T10:00:00.000Z',
			resolvedAt: '2026-09-10T12:00:00.000Z',
			assignedToUserId: 'tech-1'
		};

		const initialHistory = [
			{
				id: 'h-1',
				incidentId: 201,
				organizationId: 'org-test',
				actorUserId: 'tech-1',
				timestamp: '2026-09-10T12:00:00.000Z',
				eventType: 'resolved',
				previousValue: { status: 'open' },
				newValue: { status: 'resolved', solution: 'Reiniciado router' }
			}
		];

		const initialMessages = [
			{
				id: 'm-1',
				incidentId: 201,
				organizationId: 'org-test',
				authorUserId: 'tech-1',
				content: 'Se ha reiniciado el router y verificado el túnel VPN.',
				visibility: 'public',
				createdAt: '2026-09-10T12:00:00.000Z'
			}
		];

		// 1. Rechazo correcto
		await t.test(
			'1. Rechazo correcto: actualiza atómicamente incidencias, historial y mensajes',
			() => {
				const store = createStore({
					[INCIDENTS_KEY]: JSON.stringify([baseIncident]),
					[HISTORY_KEY]: JSON.stringify(initialHistory),
					[MESSAGES_KEY]: JSON.stringify(initialMessages)
				});

				const reopenTime = '2026-09-10T14:00:00.000Z';
				const updatedIncident = recordStatusTransition(baseIncident, 'open', reopenTime);

				const rejectionHistory = {
					id: 'h-2',
					incidentId: 201,
					organizationId: 'org-test',
					actorUserId: 'user-client-1',
					timestamp: reopenTime,
					eventType: 'resolution_rejected',
					newValue: {
						status: 'open',
						comment: 'Sigue sin conectar al servidor de archivos'
					}
				};

				const rejectionMessage = {
					id: 'm-2',
					incidentId: 201,
					organizationId: 'org-test',
					authorUserId: 'user-client-1',
					content: '[Solución rechazada]: Sigue sin conectar al servidor de archivos',
					visibility: 'public',
					createdAt: reopenTime
				};

				const nextIncidents = [updatedIncident];
				const nextHistory = [...initialHistory, rejectionHistory];
				const nextMessages = [...initialMessages, rejectionMessage];

				commitTransitionWithMessage(
					store,
					nextIncidents,
					nextHistory,
					nextMessages,
					JSON.stringify([baseIncident]),
					JSON.stringify(initialHistory),
					JSON.stringify(initialMessages)
				);

				// Comprobaciones
				const savedIncidents = JSON.parse(store.getItem(INCIDENTS_KEY));
				assert.equal(savedIncidents[0].status, 'open');
				assert.equal(savedIncidents[0].closedAt, null);

				const savedHistory = JSON.parse(store.getItem(HISTORY_KEY));
				assert.equal(savedHistory.length, 2);
				assert.equal(savedHistory[1].eventType, 'resolution_rejected');
				assert.equal(
					savedHistory[1].newValue.comment,
					'Sigue sin conectar al servidor de archivos'
				);

				const savedMessages = loadMessages(store.getItem(MESSAGES_KEY));
				assert.equal(savedMessages.length, 2);
				assert.equal(
					savedMessages[1].content,
					'[Solución rechazada]: Sigue sin conectar al servidor de archivos'
				);

				// El diario de recuperación debe haber sido eliminado (confirmación completa)
				assert.equal(store.getItem(TRANSITION_RECOVERY_KEY), null);
			}
		);

		// 2. Reapertura correcta
		await t.test(
			'2. Reapertura correcta: actualiza atómicamente incidencia closed a open con mensaje',
			() => {
				const closedIncident = {
					...baseIncident,
					status: 'closed',
					closedAt: '2026-09-10T13:00:00.000Z',
					closureType: 'client_confirmed'
				};

				const store = createStore({
					[INCIDENTS_KEY]: JSON.stringify([closedIncident]),
					[HISTORY_KEY]: JSON.stringify(initialHistory),
					[MESSAGES_KEY]: JSON.stringify(initialMessages)
				});

				const reopenTime = '2026-09-10T15:00:00.000Z';
				const updatedIncident = recordStatusTransition(closedIncident, 'open', reopenTime);

				const reopenHistory = {
					id: 'h-3',
					incidentId: 201,
					organizationId: 'org-test',
					actorUserId: 'user-client-1',
					timestamp: reopenTime,
					eventType: 'reopened',
					newValue: {
						status: 'open',
						reason: 'Volvió a fallar tras el reinicio programado'
					}
				};

				const reopenMessage = {
					id: 'm-3',
					incidentId: 201,
					organizationId: 'org-test',
					authorUserId: 'user-client-1',
					content: '[Incidencia reabierta]: Volvió a fallar tras el reinicio programado',
					visibility: 'public',
					createdAt: reopenTime
				};

				const nextIncidents = [updatedIncident];
				const nextHistory = [...initialHistory, reopenHistory];
				const nextMessages = [...initialMessages, reopenMessage];

				commitTransitionWithMessage(
					store,
					nextIncidents,
					nextHistory,
					nextMessages,
					JSON.stringify([closedIncident]),
					JSON.stringify(initialHistory),
					JSON.stringify(initialMessages)
				);

				const savedIncidents = JSON.parse(store.getItem(INCIDENTS_KEY));
				assert.equal(savedIncidents[0].status, 'open');
				assert.equal(savedIncidents[0].closedAt, null);

				const savedHistory = JSON.parse(store.getItem(HISTORY_KEY));
				assert.equal(savedHistory[1].eventType, 'reopened');
				assert.equal(
					savedHistory[1].newValue.reason,
					'Volvió a fallar tras el reinicio programado'
				);

				const savedMessages = loadMessages(store.getItem(MESSAGES_KEY));
				assert.equal(
					savedMessages[1].content,
					'[Incidencia reabierta]: Volvió a fallar tras el reinicio programado'
				);

				assert.equal(store.getItem(TRANSITION_RECOVERY_KEY), null);
			}
		);

		// 3. Conflicto de concurrencia en incidencias
		await t.test(
			'3. Conflicto de concurrencia en incidencias: aborta antes de escribir y no persiste mensaje',
			() => {
				const store = createStore({
					[INCIDENTS_KEY]: JSON.stringify([
						{ ...baseIncident, title: 'Modificado en otra pestaña' }
					]),
					[HISTORY_KEY]: JSON.stringify(initialHistory),
					[MESSAGES_KEY]: JSON.stringify(initialMessages)
				});

				const updated = recordStatusTransition(baseIncident, 'open', '2026-09-10T14:00:00.000Z');
				const newHistory = {
					id: 'h-fail',
					incidentId: 201,
					organizationId: 'org-test',
					actorUserId: 'user-client-1',
					timestamp: '2026-09-10T14:00:00.000Z',
					eventType: 'resolution_rejected',
					newValue: { status: 'open', comment: 'Rechazo concurrente' }
				};
				const newMsg = {
					id: 'm-fail',
					incidentId: 201,
					organizationId: 'org-test',
					authorUserId: 'user-client-1',
					content: '[Solución rechazada]: Rechazo concurrente',
					visibility: 'public',
					createdAt: '2026-09-10T14:00:00.000Z'
				};

				assert.throws(
					() =>
						commitTransitionWithMessage(
							store,
							[updated],
							[...initialHistory, newHistory],
							[...initialMessages, newMsg],
							JSON.stringify([baseIncident]), // Snapshot obsoleto
							JSON.stringify(initialHistory),
							JSON.stringify(initialMessages)
						),
					/Los datos han cambiado en otra pestaña/
				);

				// Comprobar que no se escribieron mensajes huérfanos ni diario
				const messagesAfter = loadMessages(store.getItem(MESSAGES_KEY));
				assert.equal(messagesAfter.length, 1);
				assert.equal(store.getItem(TRANSITION_RECOVERY_KEY), null);
			}
		);

		// 4. Conflicto de concurrencia en historial
		await t.test('4. Conflicto de concurrencia en historial: aborta antes de escribir', () => {
			const store = createStore({
				[INCIDENTS_KEY]: JSON.stringify([baseIncident]),
				[HISTORY_KEY]: JSON.stringify([...initialHistory, { id: 'ext-h', incidentId: 201 }]),
				[MESSAGES_KEY]: JSON.stringify(initialMessages)
			});

			assert.throws(
				() =>
					commitTransitionWithMessage(
						store,
						[baseIncident],
						initialHistory,
						initialMessages,
						JSON.stringify([baseIncident]),
						JSON.stringify(initialHistory), // Snapshot obsoleto frente al store
						JSON.stringify(initialMessages)
					),
				/Los datos han cambiado en otra pestaña/
			);

			assert.equal(store.getItem(TRANSITION_RECOVERY_KEY), null);
		});

		// 5. Conflicto de concurrencia en mensajes
		await t.test('5. Conflicto de concurrencia en mensajes: aborta antes de escribir', () => {
			const store = createStore({
				[INCIDENTS_KEY]: JSON.stringify([baseIncident]),
				[HISTORY_KEY]: JSON.stringify(initialHistory),
				[MESSAGES_KEY]: JSON.stringify([
					...initialMessages,
					{ id: 'ext-msg', incidentId: 201, content: 'Comentario nuevo en otra pestaña' }
				])
			});

			assert.throws(
				() =>
					commitTransitionWithMessage(
						store,
						[baseIncident],
						initialHistory,
						initialMessages,
						JSON.stringify([baseIncident]),
						JSON.stringify(initialHistory),
						JSON.stringify(initialMessages) // Snapshot obsoleto
					),
				/Los datos han cambiado en otra pestaña/
			);

			assert.equal(store.getItem(TRANSITION_RECOVERY_KEY), null);
		});

		// 6. Fallo durante cada una de las tres escrituras
		await t.test('6.1 Fallo en escritura 1 (INCIDENTS_KEY): rollback restaura todo', () => {
			const store = createStore({
				[INCIDENTS_KEY]: JSON.stringify([baseIncident]),
				[HISTORY_KEY]: JSON.stringify(initialHistory),
				[MESSAGES_KEY]: JSON.stringify(initialMessages)
			});

			// Operaciones en commit:
			// 1. setItem(TRANSITION_RECOVERY_KEY) -> éxito
			// 2. setItem(INCIDENTS_KEY) -> FALLA
			store.failAt(2);

			assert.throws(
				() =>
					commitTransitionWithMessage(
						store,
						[{ ...baseIncident, status: 'open' }],
						initialHistory,
						initialMessages,
						JSON.stringify([baseIncident]),
						JSON.stringify(initialHistory),
						JSON.stringify(initialMessages)
					),
				/No se pudo guardar la transición/
			);

			// Todo debe quedar en el estado anterior
			assert.equal(JSON.parse(store.getItem(INCIDENTS_KEY))[0].status, 'resolved');
			assert.equal(store.getItem(TRANSITION_RECOVERY_KEY), null);
		});

		await t.test('6.2 Fallo en escritura 2 (HISTORY_KEY): rollback restaura INCIDENTS_KEY', () => {
			const store = createStore({
				[INCIDENTS_KEY]: JSON.stringify([baseIncident]),
				[HISTORY_KEY]: JSON.stringify(initialHistory),
				[MESSAGES_KEY]: JSON.stringify(initialMessages)
			});

			const validHistoryEntry = {
				id: 'h-fail-test',
				incidentId: 201,
				organizationId: 'org-test',
				actorUserId: 'tech-1',
				timestamp: '2026-09-10T14:00:00.000Z',
				eventType: 'status_changed',
				previousValue: 'resolved',
				newValue: 'open'
			};

			// 1. setItem(TRANSITION_RECOVERY_KEY) -> éxito
			// 2. setItem(INCIDENTS_KEY) -> éxito (escribe 'open')
			// 3. setItem(HISTORY_KEY) -> FALLA
			store.failAt(3);

			assert.throws(
				() =>
					commitTransitionWithMessage(
						store,
						[{ ...baseIncident, status: 'open' }],
						[...initialHistory, validHistoryEntry],
						initialMessages,
						JSON.stringify([baseIncident]),
						JSON.stringify(initialHistory),
						JSON.stringify(initialMessages)
					),
				/No se pudo guardar la transición/
			);

			// INCIDENTS_KEY debe haber sido revertido a 'resolved'
			assert.equal(JSON.parse(store.getItem(INCIDENTS_KEY))[0].status, 'resolved');
			assert.equal(store.getItem(TRANSITION_RECOVERY_KEY), null);
		});

		await t.test(
			'6.3 Fallo en escritura 3 (MESSAGES_KEY): rollback restaura INCIDENTS e HISTORY',
			() => {
				const store = createStore({
					[INCIDENTS_KEY]: JSON.stringify([baseIncident]),
					[HISTORY_KEY]: JSON.stringify(initialHistory),
					[MESSAGES_KEY]: JSON.stringify(initialMessages)
				});

				const validHistoryEntry = {
					id: 'h-fail-test-2',
					incidentId: 201,
					organizationId: 'org-test',
					actorUserId: 'tech-1',
					timestamp: '2026-09-10T14:00:00.000Z',
					eventType: 'status_changed',
					previousValue: 'resolved',
					newValue: 'open'
				};

				const validMessage = {
					id: 'm-fail-test',
					incidentId: 201,
					organizationId: 'org-test',
					authorUserId: 'tech-1',
					content: 'Mensaje de prueba',
					visibility: 'public',
					createdAt: '2026-09-10T14:00:00.000Z'
				};

				// 1. setItem(TRANSITION_RECOVERY_KEY)
				// 2. setItem(INCIDENTS_KEY)
				// 3. setItem(HISTORY_KEY)
				// 4. setItem(MESSAGES_KEY) -> FALLA
				store.failAt(4);

				assert.throws(
					() =>
						commitTransitionWithMessage(
							store,
							[{ ...baseIncident, status: 'open' }],
							[...initialHistory, validHistoryEntry],
							[...initialMessages, validMessage],
							JSON.stringify([baseIncident]),
							JSON.stringify(initialHistory),
							JSON.stringify(initialMessages)
						),
					/No se pudo guardar la transición/
				);

				assert.equal(JSON.parse(store.getItem(INCIDENTS_KEY))[0].status, 'resolved');
				assert.equal(JSON.parse(store.getItem(HISTORY_KEY)).length, 1);
				assert.equal(loadMessages(store.getItem(MESSAGES_KEY)).length, 1);
				assert.equal(store.getItem(TRANSITION_RECOVERY_KEY), null);
			}
		);

		// 7. Recuperación de un diario pendiente tras una interrupción
		await t.test(
			'7. Recuperación de diario pendiente tras interrupción restaura estado limpio',
			() => {
				// Simular que el navegador se cerró tras escribir INCIDENTS_KEY en 'open'
				const journal = {
					version: 1,
					incidents: JSON.stringify([baseIncident]), // 'resolved'
					history: JSON.stringify(initialHistory),
					messages: JSON.stringify(initialMessages)
				};

				const store = createStore({
					[TRANSITION_RECOVERY_KEY]: JSON.stringify(journal),
					[INCIDENTS_KEY]: JSON.stringify([{ ...baseIncident, status: 'open' }]), // Corrupción parcial
					[HISTORY_KEY]: JSON.stringify(initialHistory),
					[MESSAGES_KEY]: JSON.stringify(initialMessages)
				});

				// Ejecutar recuperación (equivalente a onMount)
				recoverTransitionWithMessage(store);

				// Comprobar que INCIDENTS_KEY fue restaurado a 'resolved'
				assert.equal(JSON.parse(store.getItem(INCIDENTS_KEY))[0].status, 'resolved');
				assert.equal(store.getItem(TRANSITION_RECOVERY_KEY), null);
			}
		);

		await t.test('7.1 Diario con formato inválido lanza error sin borrar el diario', () => {
			const store = createStore({
				[TRANSITION_RECOVERY_KEY]: '{"version":2}' // versión no soportada
			});

			assert.throws(
				() => recoverTransitionWithMessage(store),
				/No se pudo validar la copia de recuperación de transición/
			);

			// El diario corrupto se conserva para auditoría
			assert.notEqual(store.getItem(TRANSITION_RECOVERY_KEY), null);
		});

		// 8. Fallo durante el rollback: no reportar falsamente recuperación exitosa
		await t.test(
			'8. Fallo durante rollback: no reporta recuperación completa y conserva el diario',
			() => {
				const store = createStore({
					[INCIDENTS_KEY]: JSON.stringify([baseIncident]),
					[HISTORY_KEY]: JSON.stringify(initialHistory),
					[MESSAGES_KEY]: JSON.stringify(initialMessages)
				});

				// Operaciones en commit:
				// 1. setItem(TRANSITION_RECOVERY_KEY) -> éxito
				// 2. setItem(INCIDENTS_KEY) -> FALLA -> salta al catch de commit
				// Rollback comienza:
				// 3. setItem(INCIDENTS_KEY, expected) -> FALLA -> falla el rollback
				store.failAt(2, 3);

				assert.throws(
					() =>
						commitTransitionWithMessage(
							store,
							[{ ...baseIncident, status: 'open' }],
							initialHistory,
							initialMessages,
							JSON.stringify([baseIncident]),
							JSON.stringify(initialHistory),
							JSON.stringify(initialMessages)
						),
					/recuperación automática ha fallado/
				);

				// Al fallar el rollback, el diario debe conservarse en storage
				assert.notEqual(store.getItem(TRANSITION_RECOVERY_KEY), null);
			}
		);

		// 9. Aislamiento frente a otros diarios activos
		await t.test(
			'9. Interferencia con otros diarios: bloquea commit si hay diarios pendientes',
			() => {
				const storeWithAssignmentJournal = createStore({
					[RECOVERY_KEY]: JSON.stringify({ version: 1 }),
					[INCIDENTS_KEY]: JSON.stringify([baseIncident]),
					[HISTORY_KEY]: JSON.stringify(initialHistory),
					[MESSAGES_KEY]: JSON.stringify(initialMessages)
				});

				assert.throws(
					() =>
						commitTransitionWithMessage(
							storeWithAssignmentJournal,
							[baseIncident],
							initialHistory,
							initialMessages,
							JSON.stringify([baseIncident]),
							JSON.stringify(initialHistory),
							JSON.stringify(initialMessages)
						),
					/operación de asignación pendiente de recuperación/
				);

				const storeWithFirstResponseJournal = createStore({
					[FIRST_RESPONSE_RECOVERY_KEY]: JSON.stringify({ version: 1 }),
					[INCIDENTS_KEY]: JSON.stringify([baseIncident]),
					[HISTORY_KEY]: JSON.stringify(initialHistory),
					[MESSAGES_KEY]: JSON.stringify(initialMessages)
				});

				assert.throws(
					() =>
						commitTransitionWithMessage(
							storeWithFirstResponseJournal,
							[baseIncident],
							initialHistory,
							initialMessages,
							JSON.stringify([baseIncident]),
							JSON.stringify(initialHistory),
							JSON.stringify(initialMessages)
						),
					/primera respuesta pendiente de recuperación/
				);
			}
		);

		// 10. Detección conservadora de conflictos y prevención de sobrescritura
		await t.test(
			'10.1 Interrupción con modificación legítima de mensajes en otra pestaña: no sobrescribe y conserva el diario',
			() => {
				const reopenTime = '2026-09-10T14:00:00.000Z';
				const updatedIncident = recordStatusTransition(baseIncident, 'open', reopenTime);
				const targetIncidents = JSON.stringify([updatedIncident]);
				const targetHistoryEntry = {
					id: 'h-2',
					incidentId: 201,
					organizationId: 'org-test',
					actorUserId: 'user-client-1',
					timestamp: reopenTime,
					eventType: 'resolution_rejected',
					newValue: { status: 'open', comment: 'Rechazo legítimo' }
				};
				const targetMessage = {
					id: 'm-2',
					incidentId: 201,
					organizationId: 'org-test',
					authorUserId: 'user-client-1',
					content: '[Solución rechazada]: Rechazo legítimo',
					visibility: 'public',
					createdAt: reopenTime
				};
				const targetHistory = JSON.stringify([...initialHistory, targetHistoryEntry]);
				const targetMessages = JSON.stringify([...initialMessages, targetMessage]);

				const journal = {
					version: 1,
					incidents: JSON.stringify([baseIncident]),
					history: JSON.stringify(initialHistory),
					messages: JSON.stringify(initialMessages),
					targetIncidents,
					targetHistory,
					targetMessages
				};

				// Simular que la pestaña A escribió INCIDENTS_KEY pero se interrumpió antes de HISTORY/MESSAGES.
				// Luego, la pestaña B agregó legítimamente un nuevo mensaje al chat:
				const tabBMessage = {
					id: 'm-tab-b',
					incidentId: 201,
					organizationId: 'org-test',
					authorUserId: 'tech-1',
					content: 'Comentario legítimo enviado desde otra pestaña',
					visibility: 'public',
					createdAt: '2026-09-10T14:05:00.000Z'
				};
				const currentMessagesWithTabB = JSON.stringify([...initialMessages, tabBMessage]);

				const store = createStore({
					[TRANSITION_RECOVERY_KEY]: JSON.stringify(journal),
					[INCIDENTS_KEY]: targetIncidents, // escrito por la transacción A
					[HISTORY_KEY]: JSON.stringify(initialHistory), // aún no escrito por A
					[MESSAGES_KEY]: currentMessagesWithTabB // MODIFICADO por la pestaña B
				});

				// Intentar recuperación: debe detectar que MESSAGES_KEY divergió de los valores esperados/objetivo de A
				assert.throws(
					() => recoverTransitionWithMessage(store),
					/Conflicto de recuperación: se detectaron modificaciones externas o divergentes/
				);

				// Verificar que el mensaje legítimo de la pestaña B NO fue sobrescrito
				const preservedMessages = loadMessages(store.getItem(MESSAGES_KEY));
				assert.equal(preservedMessages.length, 2);
				assert.equal(preservedMessages[1].id, 'm-tab-b');
				assert.equal(
					preservedMessages[1].content,
					'Comentario legítimo enviado desde otra pestaña'
				);

				// Verificar que el diario de recuperación se conserva intacto para intervención manual
				assert.notEqual(store.getItem(TRANSITION_RECOVERY_KEY), null);
			}
		);

		await t.test(
			'10.2 Interrupción con modificación legítima de incidencias en otra pestaña: no sobrescribe y conserva el diario',
			() => {
				const reopenTime = '2026-09-10T14:00:00.000Z';
				const updatedIncident = recordStatusTransition(baseIncident, 'open', reopenTime);
				const targetIncidents = JSON.stringify([updatedIncident]);
				const targetHistoryEntry = {
					id: 'h-2',
					incidentId: 201,
					organizationId: 'org-test',
					actorUserId: 'user-client-1',
					timestamp: reopenTime,
					eventType: 'resolution_rejected',
					newValue: { status: 'open', comment: 'Rechazo legítimo' }
				};
				const targetMessage = {
					id: 'm-2',
					incidentId: 201,
					organizationId: 'org-test',
					authorUserId: 'user-client-1',
					content: '[Solución rechazada]: Rechazo legítimo',
					visibility: 'public',
					createdAt: reopenTime
				};
				const targetHistory = JSON.stringify([...initialHistory, targetHistoryEntry]);
				const targetMessages = JSON.stringify([...initialMessages, targetMessage]);

				const journal = {
					version: 1,
					incidents: JSON.stringify([baseIncident]),
					history: JSON.stringify(initialHistory),
					messages: JSON.stringify(initialMessages),
					targetIncidents,
					targetHistory,
					targetMessages
				};

				// Pestaña B creó una nueva incidencia independiente 202:
				const tabBIncidents = [
					baseIncident,
					{ ...baseIncident, id: 202, title: 'Incidencia creada en pestaña B' }
				];

				const store = createStore({
					[TRANSITION_RECOVERY_KEY]: JSON.stringify(journal),
					[INCIDENTS_KEY]: JSON.stringify(tabBIncidents), // Divergencia en incidencias
					[HISTORY_KEY]: JSON.stringify(initialHistory),
					[MESSAGES_KEY]: JSON.stringify(initialMessages)
				});

				assert.throws(
					() => recoverTransitionWithMessage(store),
					/Conflicto de recuperación: se detectaron modificaciones externas o divergentes/
				);

				// Verificar que los datos de la pestaña B no fueron borrados
				const preservedIncidents = JSON.parse(store.getItem(INCIDENTS_KEY));
				assert.equal(preservedIncidents.length, 2);
				assert.equal(preservedIncidents[1].id, 202);

				// El diario se conserva
				assert.notEqual(store.getItem(TRANSITION_RECOVERY_KEY), null);
			}
		);

		await t.test(
			'10.3 Otros mecanismos de persistencia son bloqueados ante diario de transición pendiente',
			() => {
				const incidentWithDesc = {
					...baseIncident,
					description: 'Problema con la conexión VPN corporativa'
				};

				const internalNote = {
					id: 'm-internal',
					incidentId: 201,
					organizationId: 'org-test',
					authorUserId: 'tech-1',
					content: 'Nota interna bloqueada',
					visibility: 'internal',
					createdAt: '2026-09-10T14:12:00.000Z'
				};

				const initialStoreMessages = [...initialMessages, internalNote];

				const pendingStore = createStore({
					[TRANSITION_RECOVERY_KEY]: JSON.stringify({ version: 1 }),
					[INCIDENTS_KEY]: JSON.stringify([incidentWithDesc]),
					[HISTORY_KEY]: JSON.stringify(initialHistory),
					[MESSAGES_KEY]: JSON.stringify(initialStoreMessages)
				});

				const testActor = {
					id: 'tech-1',
					organizationId: 'org-test',
					role: 'technician',
					name: 'Técnico Test',
					email: 'tech1@test.com',
					active: true
				};

				// 1. commitAssignment debe rechazar la escritura
				assert.throws(
					() =>
						commitAssignment(
							pendingStore,
							[incidentWithDesc],
							initialHistory,
							JSON.stringify([incidentWithDesc]),
							JSON.stringify(initialHistory)
						),
					/Hay una operación pendiente de recuperación/
				);

				// 2. commitFirstResponse debe rechazar la escritura
				assert.throws(
					() =>
						commitFirstResponse(
							pendingStore,
							initialStoreMessages,
							[incidentWithDesc],
							JSON.stringify(initialStoreMessages),
							JSON.stringify([incidentWithDesc])
						),
					/Hay una operación de primera respuesta pendiente de recuperación/
				);

				// 3. appendMessage debe rechazar la escritura
				const newMsg = {
					id: 'm-blocked',
					incidentId: 201,
					organizationId: 'org-test',
					authorUserId: 'tech-1',
					content: 'No debe guardarse',
					visibility: 'public',
					createdAt: '2026-09-10T14:10:00.000Z'
				};
				assert.throws(
					() =>
						appendMessage(
							pendingStore,
							testActor,
							incidentWithDesc,
							newMsg,
							JSON.stringify(initialStoreMessages)
						),
					/Hay una recuperación pendiente/
				);

				// 4. commitIncidentEdit debe rechazar la escritura
				assert.throws(
					() =>
						commitIncidentEdit(
							pendingStore,
							testActor,
							incidentWithDesc,
							{ kind: 'status', status: 'pending' },
							[incidentWithDesc],
							initialHistory,
							JSON.stringify([incidentWithDesc]),
							JSON.stringify(initialHistory)
						),
					/Hay una operación pendiente de recuperación/
				);

				// 5. completeInternalNoteEffects debe rechazar la escritura
				assert.throws(
					() =>
						completeInternalNoteEffects(pendingStore, testActor, incidentWithDesc, internalNote, [
							testActor
						]),
					/Hay una recuperación pendiente/
				);

				// Ningún dato fue alterado por estas llamadas
				assert.equal(JSON.parse(pendingStore.getItem(INCIDENTS_KEY))[0].id, 201);
				assert.equal(JSON.parse(pendingStore.getItem(HISTORY_KEY)).length, 1);
				assert.equal(loadMessages(pendingStore.getItem(MESSAGES_KEY)).length, 2);
			}
		);
	} finally {
		await server.close();
	}
});

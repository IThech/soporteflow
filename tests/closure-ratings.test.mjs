import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

function createMockStorage(initial = {}) {
	const data = new Map(Object.entries(initial));
	return {
		getItem: (k) => (data.has(k) ? data.get(k) : null),
		setItem: (k, v) => data.set(k, String(v)),
		removeItem: (k) => data.delete(k),
		clear: () => data.clear()
	};
}

const mockOrg = 'org-acme';
const mockTechnician1 = {
	id: 'tech-1',
	organizationId: mockOrg,
	name: 'Tech Ana',
	role: 'technician',
	active: true
};
const mockTechnician2 = {
	id: 'tech-2',
	organizationId: mockOrg,
	name: 'Tech Carlos',
	role: 'technician',
	active: true
};
const mockClient = {
	id: 'client-1',
	organizationId: mockOrg,
	name: 'Cliente Laura',
	role: 'client',
	active: true
};
const otherClient = {
	id: 'client-2',
	organizationId: mockOrg,
	name: 'Otro Cliente',
	role: 'client',
	active: true
};

test('Cierre, confirmación y satisfacción de incidencias v1', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const { recordStatusTransition, isIncidentReopened } = await server.ssrLoadModule(
			'/src/lib/incidents/lifecycle.ts'
		);
		const {
			synchronizeIncidentClosures,
			canClientConfirmOrReject,
			canClientReopenIncident,
			getAutoCloseRemainingMinutes,
			getReopenRemainingMinutes,
			canClientRateIncident,
			getIncidentResolvedAt
		} = await server.ssrLoadModule('/src/lib/incidents/closure.ts');
		const { isIncidentRating, isIncidentRatingList, loadIncidentRatings, saveIncidentRatings } =
			await server.ssrLoadModule('/src/lib/storage/ratings.ts');
		const { SYSTEM_ACTOR_ID, isIncidentHistory } = await server.ssrLoadModule(
			'/src/lib/incidents/history.ts'
		);
		const { describeHistoryEvent } = await server.ssrLoadModule('/src/lib/incidents/timeline.ts');
		const { evaluateIncidentSla } = await server.ssrLoadModule('/src/lib/incidents/sla.ts');
		const { filterIncidentQueue, queueIncidents } = await server.ssrLoadModule(
			'/src/lib/incidents/queue.ts'
		);
		const { buildIncidentNotification } = await server.ssrLoadModule(
			'/src/lib/incidents/notifications.ts'
		);
		const { isIncidentList } = await server.ssrLoadModule('/src/lib/incidents/validation.ts');
		const { commitAssignment } = await server.ssrLoadModule('/src/lib/storage/assignment.ts');

		await t.test('1. Transiciones de estado y timestamps en lifecycle', () => {
			const baseIncident = {
				id: 101,
				organizationId: mockOrg,
				title: 'Error de login',
				client: 'Empresa A',
				clientUserId: 'client-1',
				status: 'open',
				priority: 'high',
				createdAt: '2026-09-10T10:00:00.000Z',
				assignedToUserId: 'tech-1'
			};

			// 1.1 Resolución por técnico
			const resolvedTimestamp = '2026-09-10T12:00:00.000Z';
			const resolved = recordStatusTransition(baseIncident, 'resolved', resolvedTimestamp);
			assert.equal(resolved.status, 'resolved');
			assert.equal(resolved.resolvedAt, resolvedTimestamp);
			assert.equal(resolved.closedAt, null);
			assert.equal(resolved.closureType, null);

			// 1.2 Confirmación por cliente -> closed
			const closedTimestamp = '2026-09-10T14:00:00.000Z';
			const confirmed = recordStatusTransition(resolved, 'closed', closedTimestamp, {
				closureType: 'client_confirmed'
			});
			assert.equal(confirmed.status, 'closed');
			assert.equal(confirmed.resolvedAt, resolvedTimestamp, 'resolvedAt se preserva');
			assert.equal(confirmed.closedAt, closedTimestamp);
			assert.equal(confirmed.closureType, 'client_confirmed');

			// 1.3 Reapertura por cliente -> open
			const reopenTimestamp = '2026-09-10T16:00:00.000Z';
			const reopened = recordStatusTransition(confirmed, 'open', reopenTimestamp);
			assert.equal(reopened.status, 'open');
			assert.equal(reopened.closedAt, null, 'closedAt se limpia al reabrir');
			assert.equal(reopened.closureType, null, 'closureType se limpia al reabrir');
			assert.equal(reopened.resolvedAt, resolvedTimestamp, 'resolvedAt histórico se preserva');
		});

		await t.test('2. Ventana de confirmación y reapertura del cliente', () => {
			const resolvedIncident = {
				id: 201,
				organizationId: mockOrg,
				title: 'Impresora atascada',
				client: 'Empresa B',
				clientUserId: 'client-1',
				status: 'resolved',
				priority: 'medium',
				createdAt: '2026-09-10T08:00:00.000Z',
				resolvedAt: '2026-09-10T10:00:00.000Z',
				assignedToUserId: 'tech-1'
			};

			// canClientConfirmOrReject
			assert.equal(canClientConfirmOrReject(resolvedIncident, mockClient), true);
			assert.equal(canClientConfirmOrReject(resolvedIncident, otherClient), false);
			assert.equal(canClientConfirmOrReject(resolvedIncident, mockTechnician1), false);

			const closedIncident = {
				...resolvedIncident,
				status: 'closed',
				closedAt: '2026-09-10T12:00:00.000Z',
				closureType: 'client_confirmed'
			};

			// Dentro de las 24 h de closedAt
			const within24h = new Date('2026-09-11T11:59:00.000Z'); // 23h 59m después
			assert.equal(canClientReopenIncident(closedIncident, mockClient, within24h), true);
			assert.equal(getReopenRemainingMinutes(closedIncident, within24h), 1);

			// Tras las 24 h de closedAt: Cierre definitivo para el cliente
			const after24h = new Date('2026-09-11T12:01:00.000Z'); // 24h 01m después
			assert.equal(canClientReopenIncident(closedIncident, mockClient, after24h), false);
			assert.equal(getReopenRemainingMinutes(closedIncident, after24h), 0);

			// Otro cliente no puede reabrir
			assert.equal(canClientReopenIncident(closedIncident, otherClient, within24h), false);
		});

		await t.test('3. Auto-cierre determinista a las 24 h exactas y Actor Sistema', () => {
			const resolvedAt = '2026-09-10T10:00:00.000Z';
			const incident = {
				id: 301,
				organizationId: mockOrg,
				title: 'Problema de VPN',
				client: 'Empresa C',
				clientUserId: 'client-1',
				status: 'resolved',
				priority: 'high',
				createdAt: '2026-09-10T09:00:00.000Z',
				resolvedAt,
				assignedToUserId: 'tech-1'
			};

			// 23h 59m después: NO debe auto-cerrarse aún
			const tBefore = new Date('2026-09-11T09:59:00.000Z');
			assert.equal(getAutoCloseRemainingMinutes(incident, tBefore), 1);
			const syncBefore = synchronizeIncidentClosures([incident], [], tBefore);
			assert.equal(syncBefore.changed, false);
			assert.equal(syncBefore.updatedIncidents[0].status, 'resolved');
			assert.equal(syncBefore.newHistoryEntries.length, 0);

			// 24h 05m después: DEBE auto-cerrarse
			const tAfter = new Date('2026-09-11T10:05:00.000Z');
			assert.equal(getAutoCloseRemainingMinutes(incident, tAfter), 0);
			const syncAfter = synchronizeIncidentClosures([incident], [], tAfter);

			assert.equal(syncAfter.changed, true);
			const closed = syncAfter.updatedIncidents[0];
			assert.equal(closed.status, 'closed');
			assert.equal(closed.closureType, 'auto_closed');
			// Determinismo temporal: closedAt DEBE ser exactamente resolvedAt + 24h (10:00 UTC), NO 10:05
			const expectedClosedAt = '2026-09-11T10:00:00.000Z';
			assert.equal(closed.closedAt, expectedClosedAt);

			// Historial generado
			assert.equal(syncAfter.newHistoryEntries.length, 1);
			const entry = syncAfter.newHistoryEntries[0];
			assert.equal(entry.actorUserId, SYSTEM_ACTOR_ID);
			assert.equal(entry.eventType, 'closed');
			assert.equal(entry.timestamp, expectedClosedAt);
			assert.equal(isIncidentHistory([entry]), true);

			// Formato en Timeline: no busca en usuarios y muestra "Sistema"
			const desc = describeHistoryEvent(entry, [mockTechnician1, mockTechnician2, mockClient]);
			assert.equal(desc, 'La incidencia se cerró automáticamente por inactividad (24 h)');
		});

		await t.test('4. Compatibilidad de SLA ante estado closed', () => {
			const incident = {
				id: 401,
				organizationId: mockOrg,
				title: 'Corte de red',
				client: 'Empresa D',
				clientUserId: 'client-1',
				status: 'resolved',
				priority: 'high',
				createdAt: '2026-09-10T10:00:00.000Z',
				resolvedAt: '2026-09-10T12:00:00.000Z',
				sla: {
					policyId: 'sla-high',
					policyName: 'SLA Alta',
					firstResponseMinutes: 60,
					resolutionMinutes: 240, // 4 horas -> deadline 14:00 UTC
					firstResponseDueAt: '2026-09-10T11:00:00.000Z',
					resolutionDueAt: '2026-09-10T14:00:00.000Z',
					firstRespondedAt: '2026-09-10T10:30:00.000Z',
					resolvedAt: '2026-09-10T12:00:00.000Z'
				}
			};

			// 4.1 En estado resolved, dentro de plazo -> fulfilled
			const evalResolved = evaluateIncidentSla(incident, new Date('2026-09-10T12:30:00.000Z'));
			assert.equal(evalResolved.status, 'fulfilled');
			assert.equal(evalResolved.resolution.stage, 'fulfilled_within_sla');

			// 4.2 Al transicionar a closed (a las 15:00, superado resolutionDueAt de las 14:00)
			const closedIncident = recordStatusTransition(
				incident,
				'closed',
				'2026-09-10T15:00:00.000Z',
				{
					closureType: 'client_confirmed'
				}
			);
			assert.equal(closedIncident.status, 'closed');
			assert.equal(closedIncident.sla.resolvedAt, '2026-09-10T12:00:00.000Z');

			// REGLA CRÍTICA: closed no debe perder el resolvedAt ni marcarse como breached
			const evalClosed = evaluateIncidentSla(closedIncident, new Date('2026-09-12T10:00:00.000Z'));
			assert.equal(evalClosed.status, 'fulfilled', 'closed conserva el cumplimiento de SLA');
			assert.equal(evalClosed.resolution.stage, 'fulfilled_within_sla');
			assert.equal(evalClosed.resolution.completedAt, '2026-09-10T12:00:00.000Z');

			// 4.3 Al reabrir a open tras vencer el deadline -> dinámicamente evalúa a breached
			const reopened = recordStatusTransition(closedIncident, 'open', '2026-09-10T16:00:00.000Z');
			const evalReopened = evaluateIncidentSla(reopened, new Date('2026-09-10T16:00:00.000Z'));
			assert.equal(evalReopened.status, 'breached', 'reabierta después del deadline es breached');
			assert.equal(evalReopened.resolution.stage, 'breached');
			assert.equal(evalReopened.resolution.completedAt, null);
		});

		await t.test('5. Valoraciones de satisfacción por ciclo de resolución', () => {
			const storage = createMockStorage();

			// Inicialmente storage vacío
			const loadInitial = loadIncidentRatings(storage);
			assert.equal(loadInitial.status, 'missing');
			assert.deepEqual(loadInitial.ratings, []);

			const resolution1At = '2026-09-10T12:00:00.000Z';
			const incidentCycle1 = {
				id: 501,
				organizationId: mockOrg,
				title: 'Bug en app móvil',
				client: 'Empresa E',
				clientUserId: 'client-1',
				status: 'resolved',
				priority: 'medium',
				createdAt: '2026-09-10T10:00:00.000Z',
				resolvedAt: resolution1At,
				assignedToUserId: 'tech-1'
			};

			// 5.1 Cliente puede calificar el primer ciclo
			assert.equal(canClientRateIncident(incidentCycle1, mockClient, []), true);

			const rating1 = {
				id: 'rating-1',
				organizationId: mockOrg,
				incidentId: 501,
				resolvedAt: resolution1At,
				technicianUserId: 'tech-1', // snapshot del técnico de este ciclo
				clientUserId: 'client-1',
				rating: 5,
				comment: 'Excelente atención de Ana',
				createdAt: '2026-09-10T13:00:00.000Z'
			};

			assert.equal(isIncidentRating(rating1), true);
			assert.equal(isIncidentRatingList([rating1]), true);

			saveIncidentRatings([rating1], storage);
			const loadAfter1 = loadIncidentRatings(storage);
			assert.equal(loadAfter1.status, 'valid');
			assert.equal(loadAfter1.ratings.length, 1);

			// 5.2 Intento de duplicar valoración para el MISMO ciclo debe ser rechazado
			assert.equal(canClientRateIncident(incidentCycle1, mockClient, [rating1]), false);

			const duplicateRatingSameCycle = {
				id: 'rating-1-dup',
				organizationId: mockOrg,
				incidentId: 501,
				resolvedAt: resolution1At,
				technicianUserId: 'tech-1',
				clientUserId: 'client-1',
				rating: 4,
				createdAt: '2026-09-10T13:10:00.000Z'
			};
			assert.equal(
				isIncidentRatingList([rating1, duplicateRatingSameCycle]),
				false,
				'impide duplicar valoración dentro del mismo ciclo'
			);

			// 5.3 REAPERTURA, CAMBIO DE TÉCNICO Y SEGUNDA RESOLUCIÓN
			const resolution2At = '2026-09-11T16:00:00.000Z';
			const incidentCycle2 = {
				...incidentCycle1,
				assignedToUserId: mockTechnician2.id, // Asignado a Carlos
				resolvedAt: resolution2At
			};

			// Debe permitir una segunda valoración para el nuevo resolvedAt
			assert.equal(
				canClientRateIncident(incidentCycle2, mockClient, [rating1]),
				true,
				'permite valoración de segundo ciclo de resolución'
			);

			const rating2 = {
				id: 'rating-2',
				organizationId: mockOrg,
				incidentId: 501,
				resolvedAt: resolution2At,
				technicianUserId: mockTechnician2.id, // Snapshot del segundo técnico
				clientUserId: 'client-1',
				rating: 4,
				comment: 'Carlos resolvió el detalle que faltaba',
				createdAt: '2026-09-11T17:00:00.000Z'
			};

			// Ambas valoraciones coexisten pacíficamente en storage
			assert.equal(isIncidentRatingList([rating1, rating2]), true);
			saveIncidentRatings([rating1, rating2], storage);

			const loadedBoth = loadIncidentRatings(storage);
			assert.equal(loadedBoth.status, 'valid');
			assert.equal(loadedBoth.ratings.length, 2);

			// Garantía: cada valoración conserva su técnico histórico correcto
			assert.equal(loadedBoth.ratings[0].technicianUserId, 'tech-1');
			assert.equal(loadedBoth.ratings[0].resolvedAt, resolution1At);
			assert.equal(loadedBoth.ratings[1].technicianUserId, mockTechnician2.id);
			assert.equal(loadedBoth.ratings[1].resolvedAt, resolution2At);
		});

		await t.test('6. Bandeja técnica con filtro "Activas" y ordenación', () => {
			const incidents = [
				{
					id: 1,
					organizationId: mockOrg,
					title: 'I1',
					client: 'A',
					status: 'open',
					priority: 'low',
					createdAt: '2026-09-10T10:00:00.000Z'
				},
				{
					id: 2,
					organizationId: mockOrg,
					title: 'I2',
					client: 'B',
					status: 'pending',
					priority: 'high',
					createdAt: '2026-09-10T10:00:00.000Z'
				},
				{
					id: 3,
					organizationId: mockOrg,
					title: 'I3',
					client: 'C',
					status: 'resolved',
					priority: 'high',
					createdAt: '2026-09-10T10:00:00.000Z'
				},
				{
					id: 4,
					organizationId: mockOrg,
					title: 'I4',
					client: 'D',
					status: 'closed',
					priority: 'high',
					createdAt: '2026-09-10T10:00:00.000Z'
				}
			];

			// Filtro 'active' -> solo open y pending
			const activeFiltered = filterIncidentQueue(mockTechnician1, incidents, 'all', 'active', '');
			assert.deepEqual(
				activeFiltered.map((i) => i.id),
				[1, 2]
			);

			// Filtro 'closed' -> solo closed
			const closedFiltered = filterIncidentQueue(mockTechnician1, incidents, 'all', 'closed', '');
			assert.deepEqual(
				closedFiltered.map((i) => i.id),
				[4]
			);

			// Filtro 'resolved' -> solo resolved
			const resolvedFiltered = filterIncidentQueue(
				mockTechnician1,
				incidents,
				'all',
				'resolved',
				''
			);
			assert.deepEqual(
				resolvedFiltered.map((i) => i.id),
				[3]
			);

			// Filtro 'all' -> todas
			const allFiltered = filterIncidentQueue(mockTechnician1, incidents, 'all', 'all', '');
			assert.equal(allFiltered.length, 4);

			// En ordenación 'mine', resolved y closed quedan al final
			const myIncidents = incidents.map((i) => ({ ...i, assignedToUserId: mockTechnician1.id }));
			const sorted = queueIncidents(mockTechnician1, myIncidents, 'mine');
			assert.equal(sorted[0].id, 2);
			assert.equal(sorted[1].id, 1);
			assert.ok(sorted[2].status === 'resolved' || sorted[2].status === 'closed');
			assert.ok(sorted[3].status === 'resolved' || sorted[3].status === 'closed');
		});

		await t.test('7. Notificaciones para cierre y reapertura con motivo', () => {
			const incident = {
				id: 701,
				organizationId: mockOrg,
				title: 'Servidor caído',
				client: 'Empresa F',
				clientUserId: 'client-1',
				status: 'closed',
				priority: 'high',
				createdAt: '2026-09-10T10:00:00.000Z',
				assignedToUserId: 'tech-1'
			};

			// Cliente confirma cierre -> notifica al técnico
			const notifClosed = buildIncidentNotification({
				type: 'incident_closed',
				incident,
				actor: mockClient
			});
			assert.ok(notifClosed);
			assert.equal(notifClosed.recipientUserId, 'tech-1');
			assert.equal(notifClosed.type, 'incident_closed');
			assert.match(notifClosed.message, /confirmado la solución/);

			// Cliente reabre con motivo -> notifica al técnico con el motivo
			const notifReopened = buildIncidentNotification({
				type: 'incident_reopened',
				incident,
				actor: mockClient,
				reason: 'El problema persiste al reiniciar'
			});
			assert.ok(notifReopened);
			assert.equal(notifReopened.recipientUserId, 'tech-1');
			assert.match(notifReopened.message, /El problema persiste al reiniciar/);
		});

		await t.test('8. Lifecycle de cierre directo y rechazo/reapertura deterministas', () => {
			const resolvedIncident = {
				id: 801,
				organizationId: mockOrg,
				title: 'Error de certificado SSL',
				client: 'Empresa G',
				clientUserId: 'client-1',
				status: 'resolved',
				priority: 'high',
				createdAt: '2026-09-10T08:00:00.000Z',
				resolvedAt: '2026-09-10T11:00:00.000Z',
				assignedToUserId: 'tech-1'
			};

			// Cliente confirma -> pasa directamente a closed con client_confirmed en una sola acción
			const confirmed = recordStatusTransition(
				resolvedIncident,
				'closed',
				'2026-09-10T12:00:00.000Z',
				{
					closureType: 'client_confirmed'
				}
			);
			assert.equal(confirmed.status, 'closed');
			assert.equal(confirmed.closureType, 'client_confirmed');
			assert.equal(confirmed.closedAt, '2026-09-10T12:00:00.000Z');
			// El resolvedAt histórico se preserva intacto
			assert.equal(confirmed.resolvedAt, '2026-09-10T11:00:00.000Z');

			// Cliente rechaza -> pasa directamente a open
			const rejected = recordStatusTransition(resolvedIncident, 'open', '2026-09-10T11:30:00.000Z');
			assert.equal(rejected.status, 'open');
			assert.equal(
				rejected.resolvedAt,
				'2026-09-10T11:00:00.000Z',
				'historical resolvedAt is kept'
			);
			assert.equal(rejected.closedAt, null);
			assert.equal(rejected.closureType, null);

			// Ventana de reapertura de 24 horas tras el cierre
			const closeTime = Date.parse('2026-09-10T12:00:00.000Z');
			const deadline = new Date(closeTime + 24 * 60 * 60 * 1000).toISOString();
			assert.equal(deadline, '2026-09-11T12:00:00.000Z');

			// Reabrir dentro de la ventana es válido para el cliente
			assert.equal(
				canClientReopenIncident(confirmed, mockClient, '2026-09-11T11:59:00.000Z'),
				true
			);
			// Reabrir fuera de la ventana queda bloqueado
			assert.equal(
				canClientReopenIncident(confirmed, mockClient, '2026-09-11T12:01:00.000Z'),
				false
			);
		});

		await t.test(
			'9. Compatibilidad retrospectiva (backward-compatibility) con datos legacy y prevención de corrupción',
			() => {
				// 9.1 Incidencias OPEN y PENDING del esquema anterior (sin resolvedAt, closedAt, closureType, sla)
				const legacyOpen = {
					id: 901,
					title: 'Fallo de red legacy',
					client: 'Cliente Antiguo A',
					status: 'open',
					priority: 'high',
					createdAt: '2026-08-20'
				};
				const legacyPending = {
					id: 902,
					title: 'Configuración de router legacy',
					client: 'Cliente Antiguo B',
					status: 'pending',
					priority: 'medium',
					createdAt: '2026-08-21'
				};
				assert.equal(isIncidentList([legacyOpen, legacyPending]), true);

				// 9.2 Incidencia RESOLVED legacy sin resolvedAt nuevo
				const legacyResolved = {
					id: 903,
					title: 'Certificado renovado legacy',
					client: 'Cliente Antiguo C',
					status: 'resolved',
					priority: 'low',
					createdAt: '2026-08-22'
				};
				assert.equal(isIncidentList([legacyResolved]), true);

				// No inventa timestamps históricos
				assert.equal(getIncidentResolvedAt(legacyResolved), null);
				assert.equal(canClientRateIncident(legacyResolved, mockClient, []), false);

				// synchronizeIncidentClosures no auto-cierra incidencias legacy sin resolvedAt
				const syncLegacy = synchronizeIncidentClosures(
					[legacyResolved],
					[],
					'2026-09-11T12:00:00.000Z'
				);
				assert.equal(syncLegacy.changed, false);
				assert.equal(syncLegacy.updatedIncidents[0].status, 'resolved');

				// 9.3 Incidencia CLOSED nueva con metadata completa
				const modernClosed = {
					id: 904,
					organizationId: mockOrg,
					title: 'Incidencia cerrada moderna',
					client: 'Cliente Moderno',
					clientUserId: 'client-1',
					status: 'closed',
					priority: 'high',
					createdAt: '2026-09-10T10:00:00.000Z',
					resolvedAt: '2026-09-10T12:00:00.000Z',
					closedAt: '2026-09-11T12:00:00.000Z',
					closureType: 'auto_closed'
				};
				assert.equal(isIncidentList([modernClosed]), true);

				// 9.4 Mezcla de incidencias legacy + nuevas en la misma colección
				const mixedList = [legacyOpen, legacyPending, legacyResolved, modernClosed];
				assert.equal(isIncidentList(mixedList), true);

				// 9.5 Edición y commit seguro de datos legacy mediante commitAssignment
				const mockStore = createMockStorage({
					'soporteflow-incidents': JSON.stringify(mixedList),
					'soporteflow-incident-history': JSON.stringify([])
				});

				// Modificar una incidencia legacy (cambio de prioridad o asignación)
				const updatedMixed = mixedList.map((inc) =>
					inc.id === 901 ? { ...inc, priority: 'medium', assignedToUserId: 'tech-1' } : inc
				);
				assert.doesNotThrow(() => {
					commitAssignment(
						mockStore,
						updatedMixed,
						[],
						JSON.stringify(mixedList),
						JSON.stringify([])
					);
				});
				assert.equal(isIncidentList(JSON.parse(mockStore.getItem('soporteflow-incidents'))), true);

				// 9.6 Datos realmente corruptos siguen siendo bloqueados
				// A. Status inválido (ej. 'archived')
				assert.equal(isIncidentList([{ ...legacyOpen, status: 'archived' }]), false);
				// B. ClosureType inválido
				assert.equal(isIncidentList([{ ...modernClosed, closureType: 'manual_closed' }]), false);
				// C. ID duplicado
				assert.equal(isIncidentList([legacyOpen, { ...legacyOpen, title: 'Duplicado' }]), false);
				// D. Falta campo obligatorio (title ausente o no string)
				assert.equal(isIncidentList([{ id: 999, status: 'open', priority: 'low' }]), false);
				// E. Timestamp corrupto en closedAt
				assert.equal(isIncidentList([{ ...modernClosed, closedAt: 'fecha-invalida' }]), false);
			}
		);

		await t.test(
			'10. Detección y ciclo de vida de incidencias reabiertas (isIncidentReopened)',
			() => {
				const inc = {
					id: 501,
					organizationId: mockOrg,
					title: 'Servicio caído',
					client: 'Cliente Test',
					clientUserId: 'client-1',
					status: 'open',
					priority: 'high',
					createdAt: '2026-09-10T08:00:00.000Z'
				};

				// 10.1 Incidencia recién creada en open -> false
				const hCreated = {
					id: 'h-1',
					incidentId: 501,
					organizationId: mockOrg,
					actorUserId: 'client-1',
					timestamp: '2026-09-10T08:00:00.000Z',
					eventType: 'created',
					newValue: { title: inc.title, status: 'open', priority: 'high' }
				};
				assert.equal(isIncidentReopened(inc, [hCreated]), false);

				// 10.2 Incidencia resuelta -> false
				const incResolved = { ...inc, status: 'resolved', resolvedAt: '2026-09-10T09:00:00.000Z' };
				const hResolved = {
					id: 'h-2',
					incidentId: 501,
					organizationId: mockOrg,
					actorUserId: 'tech-1',
					timestamp: '2026-09-10T09:00:00.000Z',
					eventType: 'resolved',
					newValue: { status: 'resolved', solution: 'Reiniciado servicio' }
				};
				assert.equal(isIncidentReopened(incResolved, [hCreated, hResolved]), false);

				// 10.3 Rechazo de solución por cliente -> true
				const incRejected = { ...inc, status: 'open', resolvedAt: '2026-09-10T09:00:00.000Z' };
				const hRejected = {
					id: 'h-3',
					incidentId: 501,
					organizationId: mockOrg,
					actorUserId: 'client-1',
					timestamp: '2026-09-10T09:30:00.000Z',
					eventType: 'resolution_rejected',
					previousValue: { status: 'resolved' },
					newValue: { status: 'open', comment: 'Sigue fallando' }
				};
				assert.equal(isIncidentReopened(incRejected, [hCreated, hResolved, hRejected]), true);

				// 10.4 Reapertura de incidencia cerrada -> true
				const hClosed = {
					id: 'h-4',
					incidentId: 501,
					organizationId: mockOrg,
					actorUserId: 'client-1',
					timestamp: '2026-09-10T10:00:00.000Z',
					eventType: 'closed',
					newValue: {
						status: 'closed',
						closedAt: '2026-09-10T10:00:00.000Z',
						closureType: 'client_confirmed'
					}
				};
				const hReopened = {
					id: 'h-5',
					incidentId: 501,
					organizationId: mockOrg,
					actorUserId: 'client-1',
					timestamp: '2026-09-10T11:00:00.000Z',
					eventType: 'reopened',
					previousValue: { status: 'closed' },
					newValue: { status: 'open', reason: 'Vuelve a fallar el servicio' }
				};
				assert.equal(isIncidentReopened(inc, [hCreated, hResolved, hClosed, hReopened]), true);

				// 10.5 Eventos no relacionados con el estado (ej. reasignación) mantienen el estado reabierto
				const hReassigned = {
					id: 'h-6',
					incidentId: 501,
					organizationId: mockOrg,
					actorUserId: 'tech-1',
					timestamp: '2026-09-10T11:30:00.000Z',
					eventType: 'reassigned',
					newValue: 'tech-2'
				};
				assert.equal(
					isIncidentReopened(inc, [hCreated, hResolved, hClosed, hReopened, hReassigned]),
					true
				);

				// 10.6 Nueva resolución de la incidencia reabierta elimina el badge reabierta -> false
				const hResolved2 = {
					id: 'h-7',
					incidentId: 501,
					organizationId: mockOrg,
					actorUserId: 'tech-2',
					timestamp: '2026-09-10T12:00:00.000Z',
					eventType: 'resolved',
					newValue: { status: 'resolved', solution: 'Parche aplicado' }
				};
				assert.equal(
					isIncidentReopened(incResolved, [
						hCreated,
						hResolved,
						hClosed,
						hReopened,
						hReassigned,
						hResolved2
					]),
					false
				);

				// 10.7 Nuevo cierre elimina el estado reabierto -> false
				const incClosedAgain = {
					...inc,
					status: 'closed',
					closedAt: '2026-09-10T13:00:00.000Z',
					closureType: 'client_confirmed'
				};
				assert.equal(
					isIncidentReopened(incClosedAgain, [
						hCreated,
						hResolved,
						hClosed,
						hReopened,
						hReassigned,
						hResolved2
					]),
					false
				);

				// 10.8 Cambio de estado genérico (status_changed de resolved a open) -> true
				const hStatusChanged = {
					id: 'h-8',
					incidentId: 501,
					organizationId: mockOrg,
					actorUserId: 'tech-2',
					timestamp: '2026-09-10T14:00:00.000Z',
					eventType: 'status_changed',
					previousValue: 'resolved',
					newValue: 'open'
				};
				assert.equal(isIncidentReopened(inc, [hCreated, hResolved, hStatusChanged]), true);

				// 10.9 Compatibilidad fallback sin historial
				// Si no hay historial pero status === 'open' y tiene resolvedAt previo -> true
				assert.equal(
					isIncidentReopened(
						{ ...inc, status: 'open', resolvedAt: '2026-09-10T09:00:00.000Z' },
						[]
					),
					true
				);
				// Si no hay historial, status === 'open' y resolvedAt es null -> false
				assert.equal(isIncidentReopened({ ...inc, status: 'open', resolvedAt: null }, []), false);
				assert.equal(isIncidentReopened({ ...inc, status: 'open' }), false);
			}
		);
	} finally {
		await server.close();
	}
});

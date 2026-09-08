import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('Asignaciones, permisos, historial y recuperación de localStorage', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });
	try {
		const { prepareAssignment, assignmentCandidates } = await server.ssrLoadModule(
			'/src/lib/incidents/assignment.ts'
		);
		const { isIncidentHistory } = await server.ssrLoadModule('/src/lib/incidents/history.ts');
		const { isIncidentList } = await server.ssrLoadModule('/src/lib/incidents/validation.ts');
		const {
			commitAssignment,
			recoverAssignment,
			loadHistory,
			INCIDENTS_KEY,
			HISTORY_KEY,
			RECOVERY_KEY
		} = await server.ssrLoadModule('/src/lib/storage/assignment.ts');
		const { demoUsers } = await server.ssrLoadModule('/src/lib/data/users.ts');
		const admin = demoUsers.find((u) => u.role === 'organization_admin');
		const tech = demoUsers.find((u) => u.role === 'technician');
		const other = demoUsers.find((u) => u.role === 'technician' && u.id !== tech.id);
		const client = demoUsers.find((u) => u.role === 'client');
		const platform = demoUsers.find((u) => u.role === 'platform_admin');
		const ticket = {
			id: 1,
			title: 'Red caída',
			client: 'Cliente',
			status: 'open',
			priority: 'high',
			createdAt: '2026-09-08',
			supportLevel: 'N1',
			teamId: tech.teamId
		};
		const assigned = prepareAssignment(admin, ticket, demoUsers, tech.id);
		const reassigned = prepareAssignment(
			tech,
			assigned.incident,
			demoUsers,
			other.id,
			'  Fin de turno  ',
			'  Pendiente de visita  '
		);
		const store = () => {
			const values = new Map();
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
					if (failures.has(++count)) throw new Error('Storage remove failure');
					values.delete(key);
				}
			};
		};
		const { requiresAssignmentReason } = await server.ssrLoadModule(
			'/src/lib/incidents/assignment.ts'
		);
		const { visibleIncidentHistory, describeHistoryEvent } = await server.ssrLoadModule(
			'/src/lib/incidents/timeline.ts'
		);
		await t.test('casos A-E: motivo compartido entre lógica y modal', () => {
			assert.equal(requiresAssignmentReason(tech, ticket, tech.id), false);
			assert.equal(requiresAssignmentReason(admin, ticket, tech.id), false);
			assert.equal(requiresAssignmentReason(tech, ticket, other.id), true);
			for (const reason of ['', '   ', 'Fin de turno'])
				assert.throws(
					() => prepareAssignment(tech, ticket, demoUsers, other.id, reason),
					/permiso/
				);
			const initialOther = prepareAssignment(admin, ticket, demoUsers, other.id);
			assert.equal(initialOther.event.eventType, 'assigned');
			assert.equal(initialOther.event.reason, undefined);
			for (const actor of [admin, tech]) {
				assert.equal(requiresAssignmentReason(actor, assigned.incident, other.id), true);
				assert.throws(
					() => prepareAssignment(actor, assigned.incident, demoUsers, other.id),
					/motivo/
				);
				assert.equal(
					prepareAssignment(actor, assigned.incident, demoUsers, other.id, 'Motivo manual').event
						.eventType,
					'reassigned'
				);
				assert.equal(requiresAssignmentReason(actor, assigned.incident, tech.id), false);
				assert.equal(prepareAssignment(actor, assigned.incident, demoUsers, tech.id), null);
			}
			const storage = store();
			commitAssignment(storage, [initialOther.incident], [initialOther.event], null, null);
			assert.equal(loadHistory(storage.getItem(HISTORY_KEY))[0].eventType, 'assigned');
		});
		await t.test('timeline: vacío, orden natural, organización y exclusión del cliente', () => {
			assert.deepEqual(visibleIncidentHistory(admin, ticket, []), []);
			const early = { ...assigned.event, id: 'early', timestamp: '2026-09-08T09:00:00.000Z' };
			const late = { ...reassigned.event, id: 'late', timestamp: '2026-09-08T10:00:00.000Z' };
			const foreign = { ...early, id: 'foreign', organizationId: 'other-org' };
			const another = { ...early, id: 'another', incidentId: 123 };
			const input = [late, foreign, another, early];
			assert.deepEqual(
				visibleIncidentHistory(tech, ticket, input).map((e) => e.id),
				['early', 'late']
			);
			assert.equal(input[0].id, 'late');
			assert.deepEqual(
				visibleIncidentHistory(client, { ...ticket, clientUserId: client.id }, input),
				[]
			);
			assert.deepEqual(visibleIncidentHistory({ ...admin, active: false }, ticket, input), []);
			assert.deepEqual(
				visibleIncidentHistory({ ...tech, organizationId: 'other-org' }, ticket, input),
				[]
			);
		});
		await t.test('timeline: nombres seguros y representación de los ocho tipos', () => {
			const self = prepareAssignment(tech, ticket, demoUsers, tech.id);
			assert.equal(
				describeHistoryEvent(self.event, demoUsers),
				tech.name + ' se asignó la incidencia'
			);
			assert.ok(describeHistoryEvent(reassigned.event, demoUsers).includes(other.name));
			const missing = {
				...reassigned.event,
				actorUserId: 'missing',
				previousValue: 'missing',
				newValue: 'missing'
			};
			assert.equal(
				describeHistoryEvent(missing, demoUsers),
				'Usuario no disponible reasignó la incidencia de Usuario no disponible a Usuario no disponible'
			);
			assert.ok(
				!describeHistoryEvent(
					{ ...assigned.event, organizationId: 'other-org' },
					demoUsers
				).includes(tech.name)
			);
			for (const eventType of [
				'created',
				'assigned',
				'reassigned',
				'escalated',
				'status_changed',
				'priority_changed',
				'category_changed',
				'resolved'
			]) {
				const partial = {
					id: 'partial',
					incidentId: 1,
					organizationId: admin.organizationId,
					actorUserId: admin.id,
					timestamp: assigned.event.timestamp,
					eventType
				};
				assert.equal(typeof describeHistoryEvent(partial, demoUsers), 'string');
				assert.ok(!describeHistoryEvent(partial, demoUsers).includes('undefined'));
			}
			assert.ok(
				describeHistoryEvent(
					{
						...assigned.event,
						eventType: 'status_changed',
						previousValue: 'pending',
						newValue: 'resolved'
					},
					demoUsers
				).includes('Pendiente a Resuelta')
			);
			assert.ok(
				describeHistoryEvent(
					{
						...assigned.event,
						eventType: 'priority_changed',
						previousValue: 'low',
						newValue: 'high'
					},
					demoUsers
				).includes('Baja a Alta')
			);
			const category = {
				id: 'cat',
				name: 'Redes',
				organizationId: admin.organizationId,
				description: '',
				active: true
			};
			assert.ok(
				describeHistoryEvent(
					{
						...assigned.event,
						eventType: 'category_changed',
						previousValue: null,
						newValue: 'cat'
					},
					demoUsers,
					[category]
				).includes('Sin categoría a Redes')
			);
		});
		await t.test('admin asigna y registra actor, organización, fecha y destinatario', () => {
			assert.equal(assigned.incident.assignedToUserId, tech.id);
			assert.equal(assigned.event.eventType, 'assigned');
			assert.equal(assigned.event.previousValue, null);
			assert.equal(assigned.event.newValue, tech.id);
			assert.equal(assigned.event.actorUserId, admin.id);
			assert.equal(assigned.event.organizationId, admin.organizationId);
			assert.equal(assigned.event.incidentId, ticket.id);
			assert.ok(Number.isFinite(Date.parse(assigned.event.timestamp)));
			assert.equal(ticket.assignedToUserId, undefined);
			assert.equal(assigned.incident.supportLevel, 'N1');
		});
		await t.test('Autoasignacion libre; tickets ajenos protegidos', () => {
			const self = prepareAssignment(tech, ticket, demoUsers, tech.id);
			assert.equal(self.event.eventType, 'assigned');
			assert.equal(self.event.reason, undefined);
			for (const target of [tech.id, other.id])
				assert.throws(
					() => prepareAssignment(other, assigned.incident, demoUsers, target, 'Carga'),
					/permiso/
				);
			assert.equal(
				prepareAssignment(admin, assigned.incident, demoUsers, other.id, 'Ausencia').event
					.eventType,
				'reassigned'
			);
		});
		await t.test('reasignación conserva destinos, requiere motivo y recorta texto', () => {
			assert.equal(reassigned.event.eventType, 'reassigned');
			assert.equal(reassigned.event.previousValue, tech.id);
			assert.equal(reassigned.event.newValue, other.id);
			assert.equal(reassigned.event.reason, 'Fin de turno');
			assert.equal(reassigned.event.comment, 'Pendiente de visita');
			assert.equal(reassigned.incident.supportLevel, assigned.incident.supportLevel);
			assert.equal(reassigned.incident.teamId, assigned.incident.teamId);
			for (const reason of ['', '   ', '\n\t'])
				assert.throws(
					() => prepareAssignment(tech, assigned.incident, demoUsers, other.id, reason),
					/motivo/
				);
			assert.equal(
				prepareAssignment(tech, assigned.incident, demoUsers, other.id, ' Motivo libre ').event
					.reason,
				'Motivo libre'
			);
			assert.equal(prepareAssignment(tech, assigned.incident, demoUsers, tech.id), null);
		});
		await t.test('roles, usuarios inactivos y aislamiento entre organizaciones', () => {
			const foreign = { ...tech, id: 'foreign', organizationId: 'another-org' };
			const inactive = { ...tech, id: 'inactive', active: false };
			const users = [...demoUsers, foreign, inactive];
			assert.deepEqual(
				assignmentCandidates(ticket, users).map((u) => u.id),
				[tech.id, other.id]
			);
			for (const actor of [client, foreign, inactive])
				assert.throws(() => prepareAssignment(actor, ticket, users, tech.id), /permiso/);
			for (const target of [client, admin, platform, foreign, inactive])
				assert.throws(() => prepareAssignment(admin, ticket, users, target.id), /técnico activo/);
			assert.throws(
				() =>
					prepareAssignment(admin, { ...ticket, organizationId: 'another-org' }, users, tech.id),
				/permiso/
			);
			assert.equal(
				prepareAssignment(
					platform,
					{ ...ticket, organizationId: foreign.organizationId },
					users,
					foreign.id
				).event.newValue,
				foreign.id
			);
			assert.throws(
				() =>
					prepareAssignment(
						platform,
						{ ...ticket, organizationId: foreign.organizationId },
						users,
						tech.id
					),
				/técnico activo/
			);
		});
		await t.test(
			'persistencia de incidencia e historial tras recarga y preservación de otros registros',
			() => {
				const storage = store();
				const foreignTicket = { ...ticket, id: 2, organizationId: 'another-org' };
				storage.setItem(INCIDENTS_KEY, JSON.stringify([ticket, foreignTicket]));
				commitAssignment(
					storage,
					[assigned.incident, foreignTicket],
					[assigned.event],
					storage.getItem(INCIDENTS_KEY),
					null
				);
				recoverAssignment(storage);
				assert.deepEqual(JSON.parse(storage.getItem(INCIDENTS_KEY)), [
					assigned.incident,
					foreignTicket
				]);
				assert.deepEqual(loadHistory(storage.getItem(HISTORY_KEY)), [assigned.event]);
				commitAssignment(
					storage,
					[reassigned.incident, foreignTicket],
					[assigned.event, reassigned.event],
					storage.getItem(INCIDENTS_KEY),
					storage.getItem(HISTORY_KEY)
				);
				assert.equal(loadHistory(storage.getItem(HISTORY_KEY)).length, 2);
				assert.equal(storage.getItem(RECOVERY_KEY), null);
			}
		);
		await t.test('fallos en cada escritura conservan ambas claves originales', () => {
			for (const fail of [1, 2, 3, 4]) {
				const storage = store();
				const oldIncidents = JSON.stringify([assigned.incident]);
				const oldHistory = JSON.stringify([assigned.event]);
				storage.setItem(INCIDENTS_KEY, oldIncidents);
				storage.setItem(HISTORY_KEY, oldHistory);
				storage.failAt(fail);
				assert.throws(() =>
					commitAssignment(
						storage,
						[reassigned.incident],
						[assigned.event, reassigned.event],
						oldIncidents,
						oldHistory
					)
				);
				assert.equal(storage.getItem(INCIDENTS_KEY), oldIncidents);
				assert.equal(storage.getItem(HISTORY_KEY), oldHistory);
				assert.equal(storage.getItem(RECOVERY_KEY), null);
			}
		});
		await t.test('recuperación después de fallar también la restauración', () => {
			const storage = store();
			const old = JSON.stringify([assigned.incident]);
			const oldHistory = JSON.stringify([assigned.event]);
			storage.setItem(INCIDENTS_KEY, old);
			storage.setItem(HISTORY_KEY, oldHistory);
			storage.failAt(3, 4);
			assert.throws(
				() =>
					commitAssignment(
						storage,
						[reassigned.incident],
						[assigned.event, reassigned.event],
						old,
						oldHistory
					),
				/recuperación/
			);
			assert.notEqual(storage.getItem(RECOVERY_KEY), null);
			assert.throws(
				() => commitAssignment(storage, [assigned.incident], [assigned.event], old, oldHistory),
				/recuperación/
			);
			storage.failAt();
			recoverAssignment(storage);
			assert.equal(storage.getItem(INCIDENTS_KEY), old);
			assert.equal(storage.getItem(HISTORY_KEY), oldHistory);
			assert.equal(storage.getItem(RECOVERY_KEY), null);
		});
		await t.test('operación interrumpida con claves inicialmente ausentes', () => {
			const storage = store();
			storage.setItem(RECOVERY_KEY, JSON.stringify({ version: 1, incidents: null, history: null }));
			storage.setItem(INCIDENTS_KEY, JSON.stringify([assigned.incident]));
			recoverAssignment(storage);
			assert.equal(storage.getItem(INCIDENTS_KEY), null);
			assert.deepEqual(loadHistory(storage.getItem(HISTORY_KEY)), []);
		});
		await t.test('historial corrupto, valores inválidos y conflictos no se sobrescriben', () => {
			assert.deepEqual(loadHistory(null), []);
			assert.throws(() => loadHistory('{broken'));
			assert.equal(isIncidentHistory([{ ...assigned.event, newValue: 42 }]), false);
			assert.equal(isIncidentHistory([{ ...assigned.event, timestamp: 'ayer' }]), false);
			assert.equal(isIncidentHistory([assigned.event, assigned.event]), false);
			assert.equal(isIncidentHistory([{ ...assigned.event, eventType: 'unknown' }]), false);
			assert.equal(isIncidentList([ticket]), true);
			const storage = store();
			storage.setItem(HISTORY_KEY, 'corrupt');
			assert.throws(
				() => commitAssignment(storage, [assigned.incident], [assigned.event], null, null),
				/otra pestaña/
			);
			assert.equal(storage.getItem(HISTORY_KEY), 'corrupt');
			assert.equal(storage.getItem(RECOVERY_KEY), null);
			storage.setItem(RECOVERY_KEY, '{bad');
			assert.throws(() => recoverAssignment(storage));
			assert.equal(storage.getItem(RECOVERY_KEY), '{bad');
		});
	} finally {
		await server.close();
	}
});

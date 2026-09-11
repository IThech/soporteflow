import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('Administración v1 — Fase C: Compatibilidad de Datos Históricos y Existentes', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const { isIncidentList } = await server.ssrLoadModule('/src/lib/incidents/validation.ts');
		const { isIncidentHistory } = await server.ssrLoadModule('/src/lib/incidents/history.ts');
		const { isUser, isUserList, loadUsersResult } = await server.ssrLoadModule(
			'/src/lib/users/catalog.ts'
		);
		const { demoUsers } = await server.ssrLoadModule('/src/lib/data/users.ts');
		const { demoSupportTeams } = await server.ssrLoadModule('/src/lib/data/teams.ts');
		const { demoSupportLevels } = await server.ssrLoadModule('/src/lib/data/support-levels.ts');
		const { describeHistoryEvent } = await server.ssrLoadModule('/src/lib/incidents/timeline.ts');

		await t.test(
			'1. Usuarios existentes con N1 / N2 y equipos demo cargan y validan correctamente',
			() => {
				assert.equal(isUserList(demoUsers), true);

				const tech1 = demoUsers.find((u) => u.id === 'user-nodhouses-technician');
				assert.ok(tech1);
				assert.equal(tech1.supportLevel, 'N1');
				assert.equal(tech1.teamId, 'team-nodhouses-support');
				assert.equal(isUser(tech1), true);

				const tech2 = demoUsers.find((u) => u.id === 'user-nodhouses-technician-2');
				assert.ok(tech2);
				assert.equal(tech2.supportLevel, 'N2');
				assert.equal(tech2.teamId, 'team-nodhouses-support');
				assert.equal(isUser(tech2), true);

				// loadUsersResult con JSON persistido de demoUsers
				const serialized = JSON.stringify(demoUsers);
				const loadResult = loadUsersResult(serialized);
				assert.equal(loadResult.status, 'valid');
				assert.equal(loadResult.users.length, demoUsers.length);
			}
		);

		await t.test(
			'2. Incidencias existentes con N1 / N2 / N3 validan correctamente en isIncidentList',
			() => {
				const existingIncidents = [
					{
						id: 101,
						title: 'Fallo router',
						client: 'Cliente A',
						status: 'open',
						priority: 'high',
						createdAt: '2026-09-01T10:00:00.000Z',
						supportLevel: 'N1',
						teamId: 'team-nodhouses-support',
						assignedToUserId: 'user-nodhouses-technician'
					},
					{
						id: 102,
						title: 'Base de datos bloqueada',
						client: 'Cliente B',
						status: 'pending',
						priority: 'high',
						createdAt: '2026-09-02T10:00:00.000Z',
						supportLevel: 'N2',
						teamId: 'team-nodhouses-support',
						assignedToUserId: 'user-nodhouses-technician-2'
					},
					{
						id: 103,
						title: 'Ataque DDoS',
						client: 'Cliente C',
						status: 'resolved',
						priority: 'high',
						createdAt: '2026-09-03T10:00:00.000Z',
						supportLevel: 'N3',
						teamId: 'team-nodhouses-operations',
						assignedToUserId: 'user-nodhouses-technician'
					},
					// Nivel configurado no estándar también debe ser aceptado estructuralmente
					{
						id: 104,
						title: 'Consulta arquitectura',
						client: 'Cliente D',
						status: 'open',
						priority: 'low',
						createdAt: '2026-09-04T10:00:00.000Z',
						supportLevel: 'TIER-1',
						teamId: 'team-nodhouses-support'
					}
				];

				assert.equal(isIncidentList(existingIncidents), true);
			}
		);

		await t.test(
			'3. Historial de escalados existente con snapshots valida en isIncidentHistory',
			() => {
				const existingHistory = [
					{
						id: 'hist-1',
						incidentId: 101,
						organizationId: 'org-nodhouses',
						actorUserId: 'user-nodhouses-admin',
						timestamp: '2026-09-05T10:00:00.000Z',
						eventType: 'escalated',
						previousValue: {
							supportLevel: 'N1',
							teamId: 'team-nodhouses-support',
							assignedToUserId: 'user-nodhouses-technician'
						},
						newValue: {
							supportLevel: 'N2',
							teamId: 'team-nodhouses-support',
							assignedToUserId: 'user-nodhouses-technician-2'
						},
						reason: 'Escalado para diagnóstico avanzado'
					},
					{
						id: 'hist-2',
						incidentId: 101,
						organizationId: 'org-nodhouses',
						actorUserId: 'user-nodhouses-admin',
						timestamp: '2026-09-05T11:00:00.000Z',
						eventType: 'escalated',
						previousValue: {
							supportLevel: 'N2',
							teamId: 'team-nodhouses-support',
							assignedToUserId: 'user-nodhouses-technician-2'
						},
						newValue: {
							supportLevel: 'N3',
							teamId: 'team-nodhouses-operations',
							assignedToUserId: 'user-nodhouses-technician'
						},
						reason: 'Escalado crítico a especialistas'
					}
				];

				assert.equal(isIncidentHistory(existingHistory), true);
			}
		);

		await t.test('4. Resolución de nombres de equipos demo e inmutabilidad en el timeline', () => {
			const event = {
				id: 'hist-3',
				incidentId: 101,
				organizationId: 'org-nodhouses',
				actorUserId: 'user-nodhouses-admin',
				timestamp: '2026-09-05T10:00:00.000Z',
				eventType: 'escalated',
				previousValue: {
					supportLevel: 'N1',
					teamId: 'team-nodhouses-support',
					assignedToUserId: 'user-nodhouses-technician'
				},
				newValue: {
					supportLevel: 'N2',
					teamId: 'team-nodhouses-operations',
					assignedToUserId: 'user-nodhouses-technician-2'
				},
				reason: 'Pase a operaciones'
			};

			const text = describeHistoryEvent(event, demoUsers, [], demoSupportTeams);
			assert.ok(text.includes('N1 · Soporte'));
			assert.ok(text.includes('N2 · Operaciones Nodhouses'));
		});

		await t.test(
			'5. Las semillas demoSupportLevels contienen N1, N2 y N3 alineados con los datos existentes',
			() => {
				assert.equal(demoSupportLevels.length, 3);
				assert.equal(demoSupportLevels[0].code, 'N1');
				assert.equal(demoSupportLevels[0].order, 1);
				assert.equal(demoSupportLevels[1].code, 'N2');
				assert.equal(demoSupportLevels[1].order, 2);
				assert.equal(demoSupportLevels[2].code, 'N3');
				assert.equal(demoSupportLevels[2].order, 3);
			}
		);
	} finally {
		await server.close();
	}
});

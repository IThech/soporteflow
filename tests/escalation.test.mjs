import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('Escalado operativo y regresiones', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });
	try {
		const { prepareEscalation, escalationTeams, prepareUnifiedAssignment } =
			await server.ssrLoadModule('/src/lib/incidents/escalation.ts');
		const { prepareAssignment } = await server.ssrLoadModule('/src/lib/incidents/assignment.ts');
		const { describeHistoryEvent } = await server.ssrLoadModule('/src/lib/incidents/timeline.ts');
		const { queueIncidents } = await server.ssrLoadModule('/src/lib/incidents/queue.ts');
		const { commitAssignment, loadHistory, INCIDENTS_KEY, HISTORY_KEY } =
			await server.ssrLoadModule('/src/lib/storage/assignment.ts');
		const { demoUsers: users } = await server.ssrLoadModule('/src/lib/data/users.ts');
		const { demoSupportTeams: teams } = await server.ssrLoadModule('/src/lib/data/teams.ts');
		const tech = users.find((u) => u.role === 'technician');
		const other = users.find((u) => u.role === 'technician' && u.id !== tech.id);
		const admin = users.find((u) => u.role === 'organization_admin');
		const client = users.find((u) => u.role === 'client');
		const platform = users.find((u) => u.role === 'platform_admin');
		const ticket = {
			id: 1,
			title: 'Caso',
			client: 'Cliente',
			organizationId: tech.organizationId,
			status: 'pending',
			priority: 'high',
			createdAt: '2026-09-01',
			description: 'Problema',
			solution: '',
			categoryId: 'equipment',
			supportLevel: 'N1',
			teamId: teams[0].id,
			assignedToUserId: tech.id
		};
		const run = (input, actor = tech, incident = ticket, teamList = teams, userList = users) =>
			prepareEscalation(actor, incident, userList, teamList, {
				reason: '  Revisión especializada  ',
				comment: '  Contexto  ',
				...input
			});
		for (const input of [
			{ supportLevel: 'N2' },
			{ teamId: teams[1].id },
			{ supportLevel: 'N2', teamId: teams[1].id },
			{ supportLevel: 'N2', assignedToUserId: other.id },
			{ teamId: teams[1].id, assignedToUserId: other.id },
			{ supportLevel: 'N2', teamId: teams[1].id, assignedToUserId: other.id }
		]) {
			await t.test(`Un único escalated: ${Object.keys(input).join(', ')}`, () => {
				const result = run(input);
				assert.equal(result.event.eventType, 'escalated');
				assert.deepEqual(result.event.previousValue, {
					supportLevel: 'N1',
					teamId: teams[0].id,
					assignedToUserId: tech.id
				});
				assert.deepEqual(result.event.newValue, { ...result.event.previousValue, ...input });
				assert.equal(result.event.reason, 'Revisión especializada');
				assert.equal(result.event.comment, 'Contexto');
				assert.equal(result.event.actorUserId, tech.id);
				assert.equal(result.event.organizationId, ticket.organizationId);
				assert.equal(result.incident.updatedAt, result.event.timestamp);
				assert.deepEqual(result.incident, {
					...ticket,
					...input,
					updatedAt: result.event.timestamp
				});
			});
		}
		await t.test(
			'Solo responsable conserva assigned/reassigned; ningún cambio no genera evento',
			() => {
				assert.equal(run({ assignedToUserId: other.id }).event.eventType, 'reassigned');
				assert.equal(
					run({ assignedToUserId: other.id }, admin, { ...ticket, assignedToUserId: null }).event
						.eventType,
					'assigned'
				);
				assert.equal(run({ reason: '' }), null);
				assert.equal(
					run({ supportLevel: 'N1', teamId: ticket.teamId, assignedToUserId: tech.id, reason: '' }),
					null
				);
				assert.equal(
					prepareAssignment(tech, ticket, users, other.id, 'Fin de turno').event.eventType,
					'reassigned'
				);
			}
		);
		await t.test('Responsabilidad del tecnico y coordinacion administrativa', () => {
			assert.throws(() => run({ supportLevel: 'N2' }, other), /permiso/);
			assert.throws(
				() => run({ supportLevel: 'N2' }, tech, { ...ticket, assignedToUserId: null }),
				/permiso/
			);
			assert.equal(run({ supportLevel: 'N2' }, admin).event.eventType, 'escalated');
			assert.equal(
				run({ supportLevel: 'N2' }, admin, { ...ticket, assignedToUserId: null }).event.eventType,
				'escalated'
			);
			assert.equal(run({ supportLevel: 'N2' }, platform).event.eventType, 'escalated');
		});
		await t.test('Todos los sentidos de nivel y rechazo de nivel desconocido', () => {
			for (const from of ['N1', 'N2', 'N3'])
				for (const to of ['N1', 'N2', 'N3'])
					if (from !== to)
						assert.equal(
							run({ supportLevel: to }, tech, { ...ticket, supportLevel: from }).event.eventType,
							'escalated'
						);
			assert.throws(() => run({ supportLevel: 'N4' }));
		});
		await t.test('Motivo vacío o solo espacios se rechaza', () => {
			for (const reason of ['', '   ', '\n\t'])
				assert.throws(() => run({ supportLevel: 'N2', reason }));
		});
		await t.test('Permisos y aislamiento también en lógica', () => {
			for (const actor of [tech, admin, platform])
				assert.equal(run({ supportLevel: 'N2' }, actor).event.eventType, 'escalated');
			for (const actor of [
				client,
				{ ...tech, active: false },
				{ ...tech, organizationId: 'foreign' }
			])
				assert.throws(() => run({ supportLevel: 'N2' }, actor));
			assert.throws(() =>
				run({ supportLevel: 'N2' }, admin, { ...ticket, organizationId: 'foreign' })
			);
		});
		await t.test(
			'Solo nuevos equipos activos de la organización; conserva históricos inactivos',
			() => {
				const extra = [
					{ ...teams[0], id: 'foreign', organizationId: 'foreign' },
					{ ...teams[0], id: 'inactive', active: false }
				];
				assert.equal(escalationTeams(ticket, [...teams, ...extra]).length, 2);
				for (const teamId of ['foreign', 'inactive', 'missing'])
					assert.throws(() => run({ teamId }, tech, ticket, [...teams, ...extra]));
				assert.equal(
					run({ supportLevel: 'N2' }, tech, { ...ticket, teamId: 'inactive' }, extra).incident
						.teamId,
					'inactive'
				);
			}
		);
		await t.test(
			'Nuevo responsable activo técnico de la organización, independiente de nivel/equipo',
			() => {
				const extra = [
					{ ...other, id: 'foreign', organizationId: 'foreign' },
					{ ...other, id: 'inactive', active: false }
				];
				for (const assignedToUserId of ['foreign', 'inactive', 'missing', admin.id, client.id])
					assert.throws(() =>
						run({ supportLevel: 'N2', assignedToUserId }, tech, ticket, teams, [...users, ...extra])
					);
				assert.equal(
					run({ supportLevel: 'N3', teamId: teams[1].id, assignedToUserId: other.id }).incident
						.assignedToUserId,
					other.id
				);
			}
		);
		await t.test('Timeline: antes/después y fallbacks de usuarios/equipos históricos', () => {
			const event = run({
				supportLevel: 'N2',
				teamId: teams[1].id,
				assignedToUserId: other.id
			}).event;
			const description = describeHistoryEvent(event, users, [], teams);
			for (const value of ['N1', 'N2', teams[0].name, teams[1].name, tech.name, other.name])
				assert.ok(description.includes(value));
			const fallback = describeHistoryEvent(event, [], [], []);
			assert.ok(fallback.includes('Usuario no disponible'));
			assert.ok(fallback.includes('Equipo no disponible'));
			assert.ok(
				describeHistoryEvent(
					event,
					users,
					[],
					teams.map((team) => ({ ...team, active: false }))
				).includes(teams[0].name)
			);
		});
		await t.test('La cola cambia con responsable y permanece si se conserva', () => {
			const moved = run({ supportLevel: 'N2', assignedToUserId: other.id }).incident;
			assert.equal(queueIncidents(tech, [moved], 'mine').length, 0);
			assert.equal(queueIncidents(other, [moved], 'mine').length, 1);
			assert.equal(queueIncidents(tech, [run({ supportLevel: 'N2' }).incident], 'mine').length, 1);
		});
		await t.test('Persistencia de un único evento, recarga y rollback al fallar', () => {
			const raw = JSON.stringify([ticket]);
			const values = new Map([[INCIDENTS_KEY, raw]]);
			let fail = true;
			const storage = {
				getItem: (key) => values.get(key) ?? null,
				setItem(key, value) {
					if (key === HISTORY_KEY && fail) {
						fail = false;
						throw new Error('Fallo simulado');
					}
					values.set(key, value);
				},
				removeItem: (key) => values.delete(key)
			};
			const result = run({ supportLevel: 'N2', assignedToUserId: other.id });
			assert.throws(() => commitAssignment(storage, [result.incident], [result.event], raw, null));
			assert.equal(storage.getItem(INCIDENTS_KEY), raw);
			assert.equal(storage.getItem(HISTORY_KEY), null);
			commitAssignment(storage, [result.incident], [result.event], raw, null);
			assert.equal(loadHistory(storage.getItem(HISTORY_KEY)).length, 1);
			assert.equal(loadHistory(storage.getItem(HISTORY_KEY))[0].eventType, 'escalated');
			assert.equal(JSON.parse(storage.getItem(INCIDENTS_KEY))[0].supportLevel, 'N2');
		});
		await t.test('Compatibilidad con incidencias antiguas sin destino ni organización', () => {
			const legacy = { ...ticket };
			for (const key of ['supportLevel', 'teamId', 'assignedToUserId', 'organizationId'])
				delete legacy[key];
			const result = run({ supportLevel: 'N2' }, admin, legacy);
			assert.deepEqual(result.event.previousValue, {
				supportLevel: null,
				teamId: null,
				assignedToUserId: null
			});
			assert.equal(result.incident.organizationId, undefined);
			assert.equal(result.incident.teamId, undefined);
		});
		await t.test('Catálogo dinámico de niveles, inactivos, saltos y desescalado (Fase C)', () => {
			const customLevels = [
				{
					id: 'l1',
					organizationId: ticket.organizationId,
					code: 'TIER-1',
					name: 'Nivel 1',
					order: 1,
					active: true,
					createdAt: '2026-09-01'
				},
				{
					id: 'l2',
					organizationId: ticket.organizationId,
					code: 'TIER-2',
					name: 'Nivel 2',
					order: 2,
					active: false,
					createdAt: '2026-09-01'
				},
				{
					id: 'l3',
					organizationId: ticket.organizationId,
					code: 'TIER-3',
					name: 'Nivel 3',
					order: 3,
					active: true,
					createdAt: '2026-09-01'
				}
			];

			// Salto directo TIER-1 -> TIER-3 (permitido)
			const jumpResult = prepareEscalation(
				tech,
				{ ...ticket, supportLevel: 'TIER-1' },
				users,
				teams,
				{
					supportLevel: 'TIER-3',
					reason: 'Caso de alta complejidad'
				},
				customLevels
			);
			assert.equal(jumpResult.incident.supportLevel, 'TIER-3');
			assert.equal(jumpResult.event.eventType, 'escalated');
			assert.equal(jumpResult.event.newValue.supportLevel, 'TIER-3');

			// Desescalado TIER-3 -> TIER-1 (permitido)
			const deescalateResult = prepareEscalation(
				tech,
				{ ...ticket, supportLevel: 'TIER-3' },
				users,
				teams,
				{
					supportLevel: 'TIER-1',
					reason: 'Resuelto componente técnico, pasa a seguimiento'
				},
				customLevels
			);
			assert.equal(deescalateResult.incident.supportLevel, 'TIER-1');

			// Nivel inactivo como nuevo destino debe ser rechazado
			assert.throws(() => {
				prepareEscalation(
					tech,
					{ ...ticket, supportLevel: 'TIER-1' },
					users,
					teams,
					{
						supportLevel: 'TIER-2',
						reason: 'Escalando a nivel inactivo'
					},
					customLevels
				);
			}, /nivel activo/i);

			// Nivel inexistente rechazado
			assert.throws(() => {
				prepareEscalation(
					tech,
					{ ...ticket, supportLevel: 'TIER-1' },
					users,
					teams,
					{
						supportLevel: 'TIER-99',
						reason: 'Escalando a nivel inexistente'
					},
					customLevels
				);
			}, /nivel activo/i);

			// Conservar nivel inactivo si no se cambia de nivel (solo cambia equipo)
			const keepInactiveResult = prepareEscalation(
				tech,
				{ ...ticket, supportLevel: 'TIER-2' },
				users,
				teams,
				{
					teamId: teams[1].id,
					reason: 'Cambio de equipo manteniendo nivel'
				},
				customLevels
			);
			assert.equal(keepInactiveResult.incident.supportLevel, 'TIER-2');
			assert.equal(keepInactiveResult.incident.teamId, teams[1].id);
		});

		await t.test('Casos de uso A, B, C, D y E de escalado y routing', () => {
			const thor = { ...tech, id: 'tech-thor', name: 'Thor' };
			const andres = { ...other, id: 'tech-andres', name: 'Andres' };
			const localUsers = [thor, andres, admin];
			const baseIncident = {
				...ticket,
				assignedToUserId: thor.id,
				supportLevel: 'N1',
				teamId: teams[0].id
			};

			// CASO A: Solo responsable desde escalado -> asignación/reasignación sin falso escalated
			const caseA = prepareEscalation(thor, baseIncident, localUsers, teams, {
				assignedToUserId: andres.id,
				reason: 'Fin de jornada'
			});
			assert.equal(caseA.event.eventType, 'reassigned');
			assert.equal(caseA.incident.assignedToUserId, andres.id);
			assert.equal(caseA.incident.supportLevel, 'N1');
			assert.equal(caseA.incident.teamId, teams[0].id);

			// CASO B: Solo nivel -> N1 a N3 manteniendo equipo y responsable
			const caseB = prepareEscalation(thor, baseIncident, localUsers, teams, {
				supportLevel: 'N3',
				reason: 'Escalar a especialistas'
			});
			assert.equal(caseB.event.eventType, 'escalated');
			assert.equal(caseB.incident.supportLevel, 'N3');
			assert.equal(caseB.incident.teamId, teams[0].id);
			assert.equal(caseB.incident.assignedToUserId, thor.id);
			assert.deepEqual(caseB.event.previousValue, {
				supportLevel: 'N1',
				teamId: teams[0].id,
				assignedToUserId: thor.id
			});
			assert.deepEqual(caseB.event.newValue, {
				supportLevel: 'N3',
				teamId: teams[0].id,
				assignedToUserId: thor.id
			});

			// CASO C: Solo equipo -> Soporte a Infraestructura manteniendo nivel y responsable
			const caseC = prepareEscalation(thor, baseIncident, localUsers, teams, {
				teamId: teams[1].id,
				reason: 'Pase a infraestructura'
			});
			assert.equal(caseC.event.eventType, 'escalated');
			assert.equal(caseC.incident.supportLevel, 'N1');
			assert.equal(caseC.incident.teamId, teams[1].id);
			assert.equal(caseC.incident.assignedToUserId, thor.id);
			assert.deepEqual(caseC.event.previousValue, {
				supportLevel: 'N1',
				teamId: teams[0].id,
				assignedToUserId: thor.id
			});
			assert.deepEqual(caseC.event.newValue, {
				supportLevel: 'N1',
				teamId: teams[1].id,
				assignedToUserId: thor.id
			});

			// CASO D: Nivel + Equipo en la misma operación
			const caseD = prepareEscalation(thor, baseIncident, localUsers, teams, {
				supportLevel: 'N3',
				teamId: teams[1].id,
				reason: 'Escalado completo de nivel y equipo'
			});
			assert.equal(caseD.event.eventType, 'escalated');
			assert.equal(caseD.incident.supportLevel, 'N3');
			assert.equal(caseD.incident.teamId, teams[1].id);
			assert.equal(caseD.incident.assignedToUserId, thor.id);
			assert.deepEqual(caseD.event.previousValue, {
				supportLevel: 'N1',
				teamId: teams[0].id,
				assignedToUserId: thor.id
			});
			assert.deepEqual(caseD.event.newValue, {
				supportLevel: 'N3',
				teamId: teams[1].id,
				assignedToUserId: thor.id
			});

			// CASO E: Nivel + Equipo + Responsable en la misma operación
			const caseE = prepareEscalation(thor, baseIncident, localUsers, teams, {
				supportLevel: 'N3',
				teamId: teams[1].id,
				assignedToUserId: andres.id,
				reason: 'Escalado integral con cambio de técnico'
			});
			assert.equal(caseE.event.eventType, 'escalated');
			assert.equal(caseE.incident.supportLevel, 'N3');
			assert.equal(caseE.incident.teamId, teams[1].id);
			assert.equal(caseE.incident.assignedToUserId, andres.id);
			assert.deepEqual(caseE.event.previousValue, {
				supportLevel: 'N1',
				teamId: teams[0].id,
				assignedToUserId: thor.id
			});
			assert.deepEqual(caseE.event.newValue, {
				supportLevel: 'N3',
				teamId: teams[1].id,
				assignedToUserId: andres.id
			});

			// CASO E2: Nivel + Responsable en la misma operación (conservando equipo)
			const caseE2 = prepareEscalation(thor, baseIncident, localUsers, teams, {
				supportLevel: 'N3',
				assignedToUserId: andres.id,
				reason: 'Escalado de nivel y responsable'
			});
			assert.equal(caseE2.event.eventType, 'escalated');
			assert.equal(caseE2.incident.supportLevel, 'N3');
			assert.equal(caseE2.incident.teamId, teams[0].id);
			assert.equal(caseE2.incident.assignedToUserId, andres.id);
			assert.deepEqual(caseE2.event.newValue, {
				supportLevel: 'N3',
				teamId: teams[0].id,
				assignedToUserId: andres.id
			});

			// CASO E3: Equipo + Responsable en la misma operación (conservando nivel)
			const caseE3 = prepareEscalation(thor, baseIncident, localUsers, teams, {
				teamId: teams[1].id,
				assignedToUserId: andres.id,
				reason: 'Cambio de equipo y responsable'
			});
			assert.equal(caseE3.event.eventType, 'escalated');
			assert.equal(caseE3.incident.supportLevel, 'N1');
			assert.equal(caseE3.incident.teamId, teams[1].id);
			assert.equal(caseE3.incident.assignedToUserId, andres.id);
			assert.deepEqual(caseE3.event.newValue, {
				supportLevel: 'N1',
				teamId: teams[1].id,
				assignedToUserId: andres.id
			});
		});

		await t.test(
			'UX Unificada: prepareUnifiedAssignment cubre los 14 requerimientos funcionales',
			async (st) => {
				const orgId = ticket.organizationId;
				const orgLevels = [
					{
						id: 'lvl-1',
						organizationId: orgId,
						code: 'N1',
						name: 'Nivel 1',
						order: 1,
						active: true,
						createdAt: '2026-09-01'
					},
					{
						id: 'lvl-2',
						organizationId: orgId,
						code: 'N2',
						name: 'Nivel 2',
						order: 2,
						active: true,
						createdAt: '2026-09-01'
					},
					{
						id: 'lvl-3',
						organizationId: orgId,
						code: 'N3',
						name: 'Nivel 3',
						order: 3,
						active: true,
						createdAt: '2026-09-01'
					},
					{
						id: 'lvl-archived',
						organizationId: orgId,
						code: 'N-OLD',
						name: 'Nivel Antiguo',
						order: 4,
						active: false,
						createdAt: '2026-09-01'
					}
				];
				const orgTeams = [
					{
						id: 'team-soporte',
						organizationId: orgId,
						name: 'Soporte',
						active: true,
						createdAt: '2026-09-01'
					},
					{
						id: 'team-infra',
						organizationId: orgId,
						name: 'Infraestructura',
						active: true,
						createdAt: '2026-09-01'
					},
					{
						id: 'team-old',
						organizationId: orgId,
						name: 'Equipo Inactivo',
						active: false,
						createdAt: '2026-09-01'
					}
				];
				const andresTech = {
					id: 'u-andres',
					organizationId: orgId,
					name: 'Andres',
					email: 'andres@nodhouses.test',
					role: 'technician',
					supportLevel: 'N1',
					teamId: 'team-soporte',
					active: true
				};
				const thorTech = {
					id: 'u-thor',
					organizationId: orgId,
					name: 'Thor',
					email: 'thor@nodhouses.test',
					role: 'technician',
					supportLevel: 'N2',
					teamId: 'team-infra',
					active: true
				};
				const adminUser = {
					id: 'u-admin',
					organizationId: orgId,
					name: 'Admin',
					email: 'admin@nodhouses.test',
					role: 'organization_admin',
					supportLevel: 'N1',
					teamId: 'team-soporte',
					active: true
				};
				const inactiveTech = {
					id: 'u-inactive',
					organizationId: orgId,
					name: 'Inactivo',
					email: 'inactive@nodhouses.test',
					role: 'technician',
					supportLevel: 'N1',
					teamId: 'team-soporte',
					active: false
				};
				const otherOrgTech = {
					id: 'u-other-org',
					organizationId: 'other-org',
					name: 'Otro Tenant',
					email: 'other@external.test',
					role: 'technician',
					supportLevel: 'N1',
					teamId: 'team-soporte',
					active: true
				};
				const testUsers = [andresTech, thorTech, adminUser, inactiveTech, otherOrgTech];

				// 1. Asignación inicial con herencia válida
				await st.test('1. Asignación inicial con herencia válida', () => {
					const unassignedTicket = {
						...ticket,
						assignedToUserId: null,
						supportLevel: undefined,
						teamId: undefined
					};
					const res = prepareUnifiedAssignment(
						adminUser,
						unassignedTicket,
						testUsers,
						orgTeams,
						{ assignedToUserId: andresTech.id },
						orgLevels
					);
					assert.equal(res.event.eventType, 'assigned');
					assert.equal(res.incident.assignedToUserId, andresTech.id);
					assert.equal(res.incident.supportLevel, 'N1');
					assert.equal(res.incident.teamId, 'team-soporte');
					assert.equal(res.event.reason, 'Asignación inicial de incidencia');
				});

				// 2. Reasignación de responsable conserva routing existente
				await st.test(
					'2. Reasignación de responsable conserva routing existente sin heredar perfil',
					() => {
						const assignedTicket = {
							...ticket,
							assignedToUserId: andresTech.id,
							supportLevel: 'N1',
							teamId: 'team-soporte'
						};
						const res = prepareUnifiedAssignment(
							adminUser,
							assignedTicket,
							testUsers,
							orgTeams,
							{ assignedToUserId: thorTech.id },
							orgLevels
						);
						assert.equal(res.event.eventType, 'reassigned');
						assert.equal(res.incident.assignedToUserId, thorTech.id);
						assert.equal(res.incident.supportLevel, 'N1');
						assert.equal(res.incident.teamId, 'team-soporte');
						assert.equal(res.event.reason, 'Reasignación de responsable');
					}
				);

				// 3. Modificación de solo nivel genera un único evento escalated
				await st.test('3. Modificación de solo nivel genera un único evento escalated', () => {
					const assignedTicket = {
						...ticket,
						assignedToUserId: andresTech.id,
						supportLevel: 'N1',
						teamId: 'team-soporte'
					};
					const res = prepareUnifiedAssignment(
						adminUser,
						assignedTicket,
						testUsers,
						orgTeams,
						{ supportLevel: 'N2' },
						orgLevels
					);
					assert.equal(res.event.eventType, 'escalated');
					assert.equal(res.incident.supportLevel, 'N2');
					assert.equal(res.incident.teamId, 'team-soporte');
					assert.equal(res.incident.assignedToUserId, andresTech.id);
					assert.deepEqual(res.event.previousValue, {
						supportLevel: 'N1',
						teamId: 'team-soporte',
						assignedToUserId: andresTech.id
					});
					assert.deepEqual(res.event.newValue, {
						supportLevel: 'N2',
						teamId: 'team-soporte',
						assignedToUserId: andresTech.id
					});
					assert.equal(res.event.reason, 'Cambio de nivel de soporte');
				});

				// 4. Modificación de solo equipo genera un único evento escalated
				await st.test('4. Modificación de solo equipo genera un único evento escalated', () => {
					const assignedTicket = {
						...ticket,
						assignedToUserId: andresTech.id,
						supportLevel: 'N1',
						teamId: 'team-soporte'
					};
					const res = prepareUnifiedAssignment(
						adminUser,
						assignedTicket,
						testUsers,
						orgTeams,
						{ teamId: 'team-infra' },
						orgLevels
					);
					assert.equal(res.event.eventType, 'escalated');
					assert.equal(res.incident.supportLevel, 'N1');
					assert.equal(res.incident.teamId, 'team-infra');
					assert.equal(res.incident.assignedToUserId, andresTech.id);
					assert.deepEqual(res.event.newValue, {
						supportLevel: 'N1',
						teamId: 'team-infra',
						assignedToUserId: andresTech.id
					});
					assert.equal(res.event.reason, 'Cambio de equipo de soporte');
				});

				// 5. Modificación combinada de nivel + equipo genera un único evento escalated
				await st.test(
					'5. Modificación combinada de nivel + equipo genera un único evento escalated',
					() => {
						const assignedTicket = {
							...ticket,
							assignedToUserId: andresTech.id,
							supportLevel: 'N1',
							teamId: 'team-soporte'
						};
						const res = prepareUnifiedAssignment(
							adminUser,
							assignedTicket,
							testUsers,
							orgTeams,
							{ supportLevel: 'N3', teamId: 'team-infra' },
							orgLevels
						);
						assert.equal(res.event.eventType, 'escalated');
						assert.equal(res.incident.supportLevel, 'N3');
						assert.equal(res.incident.teamId, 'team-infra');
						assert.equal(res.incident.assignedToUserId, andresTech.id);
						assert.equal(res.event.reason, 'Cambio de nivel y equipo de soporte');
					}
				);

				// 6. Modificación combinada de responsable + nivel genera un único evento escalated
				await st.test(
					'6. Modificación combinada de responsable + nivel genera un único evento escalated',
					() => {
						const assignedTicket = {
							...ticket,
							assignedToUserId: andresTech.id,
							supportLevel: 'N1',
							teamId: 'team-soporte'
						};
						const res = prepareUnifiedAssignment(
							adminUser,
							assignedTicket,
							testUsers,
							orgTeams,
							{ assignedToUserId: thorTech.id, supportLevel: 'N3' },
							orgLevels
						);
						assert.equal(res.event.eventType, 'escalated');
						assert.equal(res.incident.assignedToUserId, thorTech.id);
						assert.equal(res.incident.supportLevel, 'N3');
						assert.equal(res.incident.teamId, 'team-soporte');
						assert.equal(res.event.reason, 'Reasignación y escalado de soporte');
					}
				);

				// 7. Modificación combinada de responsable + equipo genera un único evento escalated
				await st.test(
					'7. Modificación combinada de responsable + equipo genera un único evento escalated',
					() => {
						const assignedTicket = {
							...ticket,
							assignedToUserId: andresTech.id,
							supportLevel: 'N1',
							teamId: 'team-soporte'
						};
						const res = prepareUnifiedAssignment(
							adminUser,
							assignedTicket,
							testUsers,
							orgTeams,
							{ assignedToUserId: thorTech.id, teamId: 'team-infra' },
							orgLevels
						);
						assert.equal(res.event.eventType, 'escalated');
						assert.equal(res.incident.assignedToUserId, thorTech.id);
						assert.equal(res.incident.supportLevel, 'N1');
						assert.equal(res.incident.teamId, 'team-infra');
						assert.equal(res.event.reason, 'Reasignación y escalado de soporte');
					}
				);

				// 8. Modificación combinada de responsable + nivel + equipo genera un único evento escalated
				await st.test(
					'8. Modificación combinada de responsable + nivel + equipo genera un único evento escalated',
					() => {
						const assignedTicket = {
							...ticket,
							assignedToUserId: andresTech.id,
							supportLevel: 'N1',
							teamId: 'team-soporte'
						};
						const res = prepareUnifiedAssignment(
							adminUser,
							assignedTicket,
							testUsers,
							orgTeams,
							{ assignedToUserId: thorTech.id, supportLevel: 'N3', teamId: 'team-infra' },
							orgLevels
						);
						assert.equal(res.event.eventType, 'escalated');
						assert.equal(res.incident.assignedToUserId, thorTech.id);
						assert.equal(res.incident.supportLevel, 'N3');
						assert.equal(res.incident.teamId, 'team-infra');
						assert.equal(res.event.reason, 'Reasignación y escalado de soporte');
					}
				);

				// 9. Guardar sin cambios devuelve null y no genera mutación ni evento
				await st.test('9. Guardar sin cambios devuelve null', () => {
					const assignedTicket = {
						...ticket,
						assignedToUserId: andresTech.id,
						supportLevel: 'N1',
						teamId: 'team-soporte'
					};
					const res = prepareUnifiedAssignment(
						adminUser,
						assignedTicket,
						testUsers,
						orgTeams,
						{ assignedToUserId: andresTech.id, supportLevel: 'N1', teamId: 'team-soporte' },
						orgLevels
					);
					assert.equal(res, null);
				});

				// 10. Referencias inactivas existentes pueden conservarse sin error
				await st.test('10. Referencias inactivas existentes pueden conservarse sin error', () => {
					const ticketWithInactives = {
						...ticket,
						assignedToUserId: andresTech.id,
						supportLevel: 'N-OLD',
						teamId: 'team-old'
					};
					const res = prepareUnifiedAssignment(
						adminUser,
						ticketWithInactives,
						testUsers,
						orgTeams,
						{ assignedToUserId: thorTech.id },
						orgLevels
					);
					assert.equal(res.event.eventType, 'reassigned');
					assert.equal(res.incident.supportLevel, 'N-OLD');
					assert.equal(res.incident.teamId, 'team-old');
				});

				// 11. Referencias inactivas no pueden seleccionarse como nuevo destino
				await st.test(
					'11. Referencias inactivas no pueden seleccionarse como nuevo destino',
					() => {
						const assignedTicket = {
							...ticket,
							assignedToUserId: andresTech.id,
							supportLevel: 'N1',
							teamId: 'team-soporte'
						};
						assert.throws(
							() =>
								prepareUnifiedAssignment(
									adminUser,
									assignedTicket,
									testUsers,
									orgTeams,
									{ supportLevel: 'N-OLD' },
									orgLevels
								),
							/nivel activo/
						);
						assert.throws(
							() =>
								prepareUnifiedAssignment(
									adminUser,
									assignedTicket,
									testUsers,
									orgTeams,
									{ teamId: 'team-old' },
									orgLevels
								),
							/equipo activo/
						);
						assert.throws(
							() =>
								prepareUnifiedAssignment(
									adminUser,
									assignedTicket,
									testUsers,
									orgTeams,
									{ assignedToUserId: inactiveTech.id },
									orgLevels
								),
							/técnico activo/
						);
					}
				);

				// 12. Aislamiento estricto entre organizaciones
				await st.test('12. Aislamiento estricto entre organizaciones', () => {
					const assignedTicket = {
						...ticket,
						assignedToUserId: andresTech.id,
						supportLevel: 'N1',
						teamId: 'team-soporte'
					};
					assert.throws(
						() =>
							prepareUnifiedAssignment(
								adminUser,
								assignedTicket,
								testUsers,
								orgTeams,
								{ assignedToUserId: otherOrgTech.id },
								orgLevels
							),
						/técnico activo/
					);
				});

				// 13. Administrador de organización con parámetros técnicos operativos aparece como candidato válido
				await st.test(
					'13. Administrador de organización con parámetros técnicos operativos aparece como candidato válido',
					() => {
						const unassignedTicket = {
							...ticket,
							assignedToUserId: null,
							supportLevel: undefined,
							teamId: undefined
						};
						const res = prepareUnifiedAssignment(
							adminUser,
							unassignedTicket,
							testUsers,
							orgTeams,
							{ assignedToUserId: adminUser.id },
							orgLevels
						);
						assert.equal(res.event.eventType, 'assigned');
						assert.equal(res.incident.assignedToUserId, adminUser.id);
						assert.equal(res.incident.supportLevel, 'N1');
						assert.equal(res.incident.teamId, 'team-soporte');
					}
				);

				// 14. No se generan eventos ni notificaciones duplicadas
				await st.test(
					'14. No se generan eventos duplicados (un único objeto de evento devuelto)',
					() => {
						const assignedTicket = {
							...ticket,
							assignedToUserId: andresTech.id,
							supportLevel: 'N1',
							teamId: 'team-soporte'
						};
						const res = prepareUnifiedAssignment(
							adminUser,
							assignedTicket,
							testUsers,
							orgTeams,
							{ assignedToUserId: thorTech.id, supportLevel: 'N2', teamId: 'team-infra' },
							orgLevels
						);
						assert.ok(res.event);
						assert.equal(res.event.eventType, 'escalated');
						assert.equal(typeof res.event.id, 'string');
						assert.equal(res.event.previousValue.assignedToUserId, andresTech.id);
						assert.equal(res.event.newValue.assignedToUserId, thorTech.id);
					}
				);
			}
		);
	} finally {
		await server.close();
	}
});

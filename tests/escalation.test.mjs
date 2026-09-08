import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('Escalado operativo y regresiones', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });
	try {
		const { prepareEscalation, escalationTeams } = await server.ssrLoadModule(
			'/src/lib/incidents/escalation.ts'
		);
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
	} finally {
		await server.close();
	}
});

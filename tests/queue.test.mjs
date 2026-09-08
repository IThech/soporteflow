import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('Cola personal del técnico', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });
	try {
		const { queueIncidents, filterIncidentQueue, validQueue } = await server.ssrLoadModule(
			'/src/lib/incidents/queue.ts'
		);
		const { isIncidentList } = await server.ssrLoadModule('/src/lib/incidents/validation.ts');
		const tech = { id: 'tech', role: 'technician', organizationId: 'org-nodhouses', active: true };
		const base = {
			title: 'Conexión de recepción',
			client: 'Clínica Norte',
			status: 'pending',
			priority: 'high',
			createdAt: '2026-09-01'
		};
		const tickets = [
			{ ...base, id: 1, assignedToUserId: 'tech' },
			{ ...base, id: 2, assignedToUserId: 'other' },
			{ ...base, id: 3, assignedToUserId: 'tech', organizationId: 'foreign' },
			{ ...base, id: 4 },
			{ ...base, id: 5, assignedToUserId: null },
			{ ...base, id: 6, assignedToUserId: '' },
			{ ...base, id: 7, assignedToUserId: 'tech', status: 'resolved' }
		];
		const ids = (list) => list.map((i) => i.id);
		await t.test('mis incidencias excluye otro técnico y otra organización', () =>
			assert.deepEqual(ids(queueIncidents(tech, tickets, 'mine')), [1, 7])
		);
		await t.test('sin asignar acepta undefined, null y cadena vacía', () => {
			assert.deepEqual(ids(queueIncidents(tech, tickets, 'unassigned')), [4, 5, 6]);
			assert.equal(isIncidentList(tickets), true);
		});
		await t.test('todas conserva el acceso de organización', () =>
			assert.deepEqual(ids(queueIncidents(tech, tickets, 'all')), [1, 2, 4, 5, 6, 7])
		);
		await t.test('estado combinado con cola', () => {
			assert.deepEqual(ids(filterIncidentQueue(tech, tickets, 'mine', 'pending', '')), [1]);
			assert.deepEqual(ids(filterIncidentQueue(tech, tickets, 'mine', 'resolved', '')), [7]);
		});
		await t.test('búsqueda normalizada por título, cliente e ID', () => {
			for (const search of ['conexion', ' RECEPCION ', 'clinica'])
				assert.deepEqual(ids(filterIncidentQueue(tech, tickets, 'mine', 'pending', search)), [1]);
			for (const search of ['#1', '1'])
				assert.deepEqual(ids(filterIncidentQueue(tech, tickets, 'mine', 'all', search)), [1]);
			assert.deepEqual(filterIncidentQueue(tech, tickets, 'mine', 'all', '#2'), []);
		});
		await t.test('reasignar fuera retira el caso de la cola sin alterar fuente', () => {
			const changed = tickets.map((i) => (i.id === 1 ? { ...i, assignedToUserId: 'other' } : i));
			assert.deepEqual(ids(queueIncidents(tech, changed, 'mine')), [7]);
			assert.equal(tickets[0].assignedToUserId, 'tech');
		});
		await t.test('asignarse incorpora el caso y reduce sin asignar', () => {
			const changed = tickets.map((i) => (i.id === 4 ? { ...i, assignedToUserId: 'tech' } : i));
			assert.deepEqual(ids(queueIncidents(tech, changed, 'mine')), [1, 4, 7]);
			assert.deepEqual(ids(queueIncidents(tech, changed, 'unassigned')), [5, 6]);
		});
		await t.test('roles no técnicos restablecen todas sin ampliar acceso del cliente', () => {
			for (const role of ['client', 'organization_admin', 'platform_admin'])
				assert.equal(validQueue({ ...tech, role }, 'mine'), 'all');
			const client = { ...tech, id: 'client', role: 'client' };
			assert.deepEqual(queueIncidents(client, tickets, 'unassigned'), []);
			assert.deepEqual(
				ids(queueIncidents(client, [{ ...tickets[0], clientUserId: 'client' }], 'mine')),
				[1]
			);
		});
		await t.test('orden: no resueltas, prioridad, antigüedad e ID', () => {
			const items = [
				{ ...tickets[0], id: 10, status: 'resolved' },
				{ ...tickets[0], id: 11, priority: 'low', createdAt: '2020-01-01' },
				{ ...tickets[0], id: 12, createdAt: '2026-08-01' },
				{ ...tickets[0], id: 13, status: 'open', createdAt: '2026-07-01' }
			];
			assert.deepEqual(ids(queueIncidents(tech, items, 'mine')), [13, 12, 11, 10]);
			assert.equal(items[0].id, 10);
		});
		await t.test('vacíos, usuario inactivo y recarga de datos', () => {
			assert.deepEqual(queueIncidents(tech, [], 'mine'), []);
			assert.deepEqual(queueIncidents({ ...tech, active: false }, tickets, 'all'), []);
			assert.deepEqual(
				ids(queueIncidents(tech, JSON.parse(JSON.stringify(tickets)), 'mine')),
				[1, 7]
			);
			assert.equal(validQueue(tech, 'all'), 'all');
		});
	} finally {
		await server.close();
	}
});

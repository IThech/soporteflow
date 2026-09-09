import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('Comentarios y notas internas: acceso, aislamiento y persistencia', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });
	try {
		const { createMessage, visibleMessages, messageAuthor } = await server.ssrLoadModule(
			'/src/lib/incidents/messages.ts'
		);
		const { loadMessages, appendMessage, MESSAGES_KEY } = await server.ssrLoadModule(
			'/src/lib/storage/messages.ts'
		);
		const { demoUsers: users } = await server.ssrLoadModule('/src/lib/data/users.ts');
		const admin = users.find((u) => u.role === 'organization_admin');
		const tech = users.find((u) => u.role === 'technician');
		const other = users.find((u) => u.role === 'technician' && u.id !== tech.id);
		const client = users.find((u) => u.role === 'client');
		const platform = users.find((u) => u.role === 'platform_admin');
		const incident = {
			id: 42,
			organizationId: admin.organizationId,
			clientUserId: client.id,
			assignedToUserId: tech.id,
			title: 'Caso',
			client: 'Cliente',
			status: 'open',
			priority: 'low',
			createdAt: '2026-09-09'
		};
		const create = (
			actor = tech,
			visibility = 'public',
			content = '  Mensaje de prueba  ',
			ticket = incident
		) => createMessage(actor, ticket, visibility, content, []);
		const publicMessage = create();
		const note = create(tech, 'internal');
		function store(raw = null) {
			const values = new Map(raw === null ? [] : [[MESSAGES_KEY, raw]]);
			return {
				values,
				getItem: (key) => values.get(key) ?? null,
				setItem: (key, value) => values.set(key, value)
			};
		}
		await t.test('Comentario publico: identidad, trim, fecha y UUID', () => {
			assert.equal(publicMessage.content, 'Mensaje de prueba');
			assert.equal(publicMessage.authorUserId, tech.id);
			assert.equal(publicMessage.organizationId, admin.organizationId);
			assert.equal(publicMessage.incidentId, 42);
			assert.ok(Number.isFinite(Date.parse(publicMessage.createdAt)));
			assert.notEqual(create().id, publicMessage.id);
		});
		await t.test('Rechaza contenido vacio para ambas visibilidades', () => {
			for (const visibility of ['public', 'internal'])
				for (const content of ['', '   ', '\n\t'])
					assert.throws(() => create(tech, visibility, content));
		});
		await t.test('Tecnicos propios y ajenos, admin y plataforma respetan acceso existente', () => {
			for (const actor of [tech, other, admin, platform])
				for (const visibility of ['public', 'internal'])
					assert.equal(create(actor, visibility).visibility, visibility);
		});
		await t.test('Cliente puede comentar solo en sus incidencias', () => {
			assert.equal(create(client).visibility, 'public');
			assert.throws(() =>
				create(client, 'public', 'texto', { ...incident, clientUserId: other.id })
			);
		});
		await t.test('Cliente no crea ni lee notas; autorizar no depende de la UI', () => {
			assert.throws(() => create(client, 'internal'));
			assert.deepEqual(visibleMessages(client, incident, [note, publicMessage]), [publicMessage]);
		});
		await t.test('Roles inactivos y operaciones cross-org rechazadas', () => {
			for (const actor of [
				{ ...tech, active: false },
				{ ...admin, organizationId: 'foreign' },
				{ ...client, organizationId: 'foreign' }
			]) {
				assert.throws(() => create(actor));
				assert.deepEqual(visibleMessages(actor, incident, [publicMessage, note]), []);
			}
			assert.throws(() => create(tech, 'unknown'));
		});
		await t.test('Filtra por organizacion e incidencia, no solo por ID', () => {
			const entries = [
				publicMessage,
				{ ...note, id: 'foreign', organizationId: 'foreign' },
				{ ...note, id: 'other', incidentId: 43 }
			];
			assert.deepEqual(visibleMessages(tech, incident, entries), [publicMessage]);
		});
		await t.test('Orden cronologico sin mutar entrada', () => {
			const entries = [
				{ ...note, createdAt: '2026-09-09T12:00:00.000Z' },
				{ ...publicMessage, createdAt: '2026-09-09T10:00:00.000Z' }
			];
			assert.equal(visibleMessages(tech, incident, entries)[0].id, publicMessage.id);
			assert.equal(entries[0].id, note.id);
		});
		await t.test('Nombres seguros y fallback historico', () => {
			assert.ok(messageAuthor(publicMessage, users).includes(tech.name));
			assert.equal(messageAuthor(publicMessage, []), 'Usuario no disponible');
			assert.equal(
				messageAuthor({ ...publicMessage, organizationId: 'foreign' }, users),
				'Usuario no disponible'
			);
		});
		await t.test('Persistencia y recarga; historial e incidencia intactos', () => {
			const storage = store();
			storage.values.set('soporteflow-incident-history', 'historial sin cambios');
			const before = JSON.stringify(incident);
			const saved = appendMessage(storage, tech, incident, publicMessage, null);
			assert.deepEqual(loadMessages(storage.getItem(MESSAGES_KEY)), saved);
			assert.equal(saved.length, 1);
			assert.equal(storage.getItem('soporteflow-incident-history'), 'historial sin cambios');
			assert.equal(JSON.stringify(incident), before);
		});
		await t.test('Ausencia y lista vacia valida se conservan', () => {
			assert.deepEqual(loadMessages(null), []);
			assert.deepEqual(loadMessages('[]'), []);
			const storage = store('[]');
			assert.equal(appendMessage(storage, tech, incident, publicMessage, '[]').length, 1);
		});
		await t.test('Datos corruptos y duplicados no se sobrescriben', () => {
			for (const raw of [
				'{',
				'{}',
				'null',
				JSON.stringify([publicMessage, publicMessage]),
				JSON.stringify([{ ...publicMessage, visibility: 'bad' }]),
				JSON.stringify([{ ...note, content: ' ' }]),
				JSON.stringify([{ ...note, createdAt: 'bad' }])
			]) {
				const storage = store(raw);
				assert.throws(() => loadMessages(raw));
				assert.throws(() => appendMessage(storage, tech, incident, publicMessage, raw));
				assert.equal(storage.getItem(MESSAGES_KEY), raw);
			}
			const raw = JSON.stringify([publicMessage]);
			assert.throws(() => appendMessage(store(raw), tech, incident, publicMessage, raw));
		});
		await t.test('Guardar comprueba autor, organizacion, incidencia y visibilidad', () => {
			for (const forged of [
				{ ...publicMessage, authorUserId: other.id },
				{ ...publicMessage, organizationId: 'foreign' },
				{ ...publicMessage, incidentId: 99 }
			])
				assert.throws(() => appendMessage(store(), tech, incident, forged, null));
			assert.throws(() =>
				appendMessage(store(), client, incident, { ...note, authorUserId: client.id }, null)
			);
		});
		await t.test('Conflicto de otra pestaña conserva los datos', () => {
			const raw = JSON.stringify([note]);
			const storage = store(raw);
			assert.throws(() => appendMessage(storage, tech, incident, publicMessage, null));
			assert.equal(storage.getItem(MESSAGES_KEY), raw);
		});
		await t.test('Fallo de escritura no modifica lista ni historial ni devuelve exito', () => {
			let memory = [];
			const original = memory;
			const storage = {
				getItem: () => null,
				setItem() {
					throw Error('Cuota');
				}
			};
			assert.throws(() => {
				memory = appendMessage(storage, tech, incident, publicMessage, null);
			});
			assert.equal(memory, original);
			assert.deepEqual(memory, []);
		});
	} finally {
		await server.close();
	}
});

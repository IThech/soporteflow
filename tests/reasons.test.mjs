import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('Catálogo de motivos por organización', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });
	try {
		const {
			changeReason,
			loadReasons,
			saveReasons,
			activeReasons,
			resolveReason,
			OTHER_REASON,
			REASONS_KEY
		} = await server.ssrLoadModule('/src/lib/reasons/catalog.ts');
		const { prepareCatalogAssignment } = await server.ssrLoadModule(
			'/src/lib/incidents/assignment.ts'
		);
		const { demoUsers } = await server.ssrLoadModule('/src/lib/data/users.ts');
		const { loadHistory } = await server.ssrLoadModule('/src/lib/storage/assignment.ts');
		const admin = demoUsers.find((u) => u.role === 'organization_admin');
		const tech = demoUsers.find((u) => u.role === 'technician');
		const other = demoUsers.find((u) => u.role === 'technician' && u.id !== tech.id);
		const client = demoUsers.find((u) => u.role === 'client');
		const platform = demoUsers.find((u) => u.role === 'platform_admin');
		const create = {
			type: 'save',
			name: '  Revisión comercial  ',
			description: '  Consultar documentación  '
		};
		const list = changeReason(admin, [], create);
		const id = list[0].id;
		const ticket = {
			id: 1,
			title: 'Caso',
			client: 'Cliente',
			status: 'open',
			priority: 'medium',
			createdAt: '2026-09-08'
		};
		await t.test('admin crea y recorta nombre y descripción', () => {
			assert.equal(list[0].name, 'Revisión comercial');
			assert.equal(list[0].description, 'Consultar documentación');
			assert.equal(list[0].organizationId, admin.organizationId);
			assert.equal(list[0].active, true);
		});
		await t.test('admin edita sin cambiar identidad ni creación', () => {
			const next = changeReason(admin, list, { ...create, id, name: 'Nuevo nombre' });
			assert.equal(next[0].id, id);
			assert.equal(next[0].createdAt, list[0].createdAt);
			assert.equal(next[0].name, 'Nuevo nombre');
			assert.equal(list[0].name, 'Revisión comercial');
		});
		await t.test('desactivar y reactivar sin borrar', () => {
			const off = changeReason(admin, list, { type: 'toggle', id });
			assert.equal(off[0].active, false);
			assert.equal(changeReason(admin, off, { type: 'toggle', id })[0].active, true);
		});
		await t.test('técnico, cliente e inactivo no administran', () => {
			for (const user of [tech, client, { ...admin, active: false }])
				for (const change of [create, { ...create, id }, { type: 'toggle', id }])
					assert.throws(() => changeReason(user, list, change), /permiso/);
		});
		await t.test('duplicados ignoran espacios, caja y acentos incluso inactivos', () => {
			for (const name of ['revision comercial', ' REVISIÓN   COMERCIAL ', 'RevisiónComercial'])
				assert.throws(() => changeReason(admin, list, { ...create, name }), /existe/);
			assert.throws(
				() => changeReason(admin, changeReason(admin, list, { type: 'toggle', id }), create),
				/existe/
			);
			assert.throws(() => changeReason(admin, list, { ...create, name: '  ' }), /nombre/);
		});
		await t.test('otra organización puede repetir nombre pero no modificar motivos ajenos', () => {
			const foreign = { ...admin, organizationId: 'foreign' };
			assert.equal(changeReason(foreign, list, create).length, 2);
			assert.throws(() => changeReason(foreign, list, { type: 'toggle', id }), /organización/);
			assert.throws(() => changeReason(foreign, list, { ...create, id }), /organización/);
			assert.equal(changeReason(platform, list, { type: 'toggle', id })[0].active, false);
		});
		await t.test('solo motivos activos de la organización', () => {
			const foreign = { ...list[0], id: 'foreign', organizationId: 'foreign' };
			const inactive = { ...list[0], id: 'off', active: false };
			assert.deepEqual(activeReasons([...list, foreign, inactive], admin.organizationId), list);
			for (const selection of ['foreign', 'off', 'missing'])
				assert.throws(
					() => resolveReason([...list, foreign, inactive], admin.organizationId, selection, ''),
					/activo/
				);
		});
		await t.test('Otro admite texto válido y rechaza blanco', () => {
			assert.equal(
				resolveReason([], admin.organizationId, OTHER_REASON, '  Motivo propio '),
				'Motivo propio'
			);
			for (const value of ['', '   ', '\n\t'])
				assert.throws(() => resolveReason([], admin.organizationId, OTHER_REASON, value), /vacío/);
		});
		await t.test('reassigned guarda texto y renombrar/desactivar no cambia evento', () => {
			const event = prepareCatalogAssignment(
				tech,
				{ ...ticket, assignedToUserId: tech.id },
				demoUsers,
				other.id,
				list,
				id,
				''
			).event;
			assert.equal(event.eventType, 'reassigned');
			assert.equal(event.reason, 'Revisión comercial');
			const renamed = changeReason(admin, list, { ...create, id, name: 'Cambio posterior' });
			const off = changeReason(admin, renamed, { type: 'toggle', id });
			assert.equal(event.reason, 'Revisión comercial');
			assert.throws(
				() =>
					prepareCatalogAssignment(
						tech,
						{ ...ticket, assignedToUserId: tech.id },
						demoUsers,
						other.id,
						off,
						id,
						''
					),
				/activo/
			);
			assert.equal(loadHistory(JSON.stringify([event]))[0].reason, 'Revisión comercial');
		});
		await t.test('reglas de motivo originales se mantienen', () => {
			assert.equal(
				prepareCatalogAssignment(tech, ticket, demoUsers, tech.id, [], '', '').event.eventType,
				'assigned'
			);
			assert.equal(
				prepareCatalogAssignment(admin, ticket, demoUsers, tech.id, [], '', '').event.eventType,
				'assigned'
			);
			assert.throws(() => prepareCatalogAssignment(tech, ticket, demoUsers, other.id, [], '', ''));
			const assigned = { ...ticket, assignedToUserId: tech.id };
			assert.equal(prepareCatalogAssignment(tech, assigned, demoUsers, tech.id, [], '', ''), null);
			assert.throws(() =>
				prepareCatalogAssignment(admin, assigned, demoUsers, other.id, [], OTHER_REASON, '  ')
			);
			assert.equal(
				prepareCatalogAssignment(admin, assigned, demoUsers, other.id, [], OTHER_REASON, 'Cambio')
					.event.eventType,
				'reassigned'
			);
		});
		await t.test('ausencia usa demo y lista vacía guardada se respeta', () => {
			assert.ok(loadReasons(null).length > 0);
			assert.deepEqual(loadReasons('[]'), []);
			assert.deepEqual(loadReasons(JSON.stringify(list)), list);
		});
		await t.test('datos antiguos y almacenamiento corrupto', () => {
			const old = { ...list[0] };
			delete old.description;
			delete old.updatedAt;
			assert.deepEqual(loadReasons(JSON.stringify([old])), [old]);
			const historical = {
				id: 'old',
				incidentId: 1,
				organizationId: admin.organizationId,
				actorUserId: admin.id,
				timestamp: '2026-09-08T10:00:00.000Z',
				eventType: 'assigned',
				reason: 'Motivo antiguo'
			};
			assert.equal(loadHistory(JSON.stringify([historical]))[0].reason, 'Motivo antiguo');
			for (const raw of [
				'{broken',
				'{}',
				JSON.stringify([{ ...old, active: 'yes' }]),
				JSON.stringify([old, old])
			])
				assert.throws(() => loadReasons(raw));
		});
		await t.test('fallo de guardado y conflicto conservan almacenamiento', () => {
			let raw = JSON.stringify(list);
			const store = {
				getItem: (key) => (key === REASONS_KEY ? raw : null),
				setItem() {
					throw Error('quota');
				}
			};
			assert.throws(() => saveReasons(store, [], raw));
			assert.equal(raw, JSON.stringify(list));
			assert.throws(() => saveReasons(store, [], null), /otra pestaña/);
			const good = {
				getItem: () => raw,
				setItem: (key, value) => {
					assert.equal(key, REASONS_KEY);
					raw = value;
				}
			};
			saveReasons(good, [], raw);
			assert.deepEqual(loadReasons(raw), []);
		});
	} finally {
		await server.close();
	}
});

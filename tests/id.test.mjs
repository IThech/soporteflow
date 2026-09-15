import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('Generación centralizada de IDs y compatibilidad en contextos no seguros', async (suite) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const { generateId, generateUuid } = await server.ssrLoadModule('/src/lib/utils/id.ts');
		const { prepareUnifiedAssignment } = await server.ssrLoadModule(
			'/src/lib/incidents/assignment.ts'
		);
		const { buildIncidentNotification } = await server.ssrLoadModule(
			'/src/lib/incidents/notifications.ts'
		);

		await suite.test('1. Contexto seguro / estándar: genera UUID v4 válido', () => {
			const id1 = generateId();
			const id2 = generateUuid();

			assert.match(id1, UUID_V4_REGEX, 'Debe cumplir formato UUID v4');
			assert.match(id2, UUID_V4_REGEX, 'Debe cumplir formato UUID v4');
			assert.notEqual(id1, id2, 'IDs generados consecutivamente deben ser distintos');
		});

		await suite.test(
			'2. Contexto no seguro (crypto.randomUUID undefined, getRandomValues disponible)',
			() => {
				const originalCrypto = globalThis.crypto;
				try {
					// Simula navegador en contexto no seguro (p. ej. http://192.168.1.118:5173 en iPad/Android)
					const mockCrypto = {
						getRandomValues: (buffer) => originalCrypto.getRandomValues(buffer)
						// randomUUID is explicitly omitted/undefined
					};
					Object.defineProperty(globalThis, 'crypto', {
						value: mockCrypto,
						configurable: true,
						writable: true
					});

					assert.equal(typeof globalThis.crypto.randomUUID, 'undefined');

					const id = generateId();
					assert.match(
						id,
						UUID_V4_REGEX,
						'Debe generar un UUID v4 válido usando el fallback de getRandomValues'
					);

					// Verificar unicidad en 100 iteraciones
					const set = new Set();
					for (let i = 0; i < 100; i++) {
						set.add(generateId());
					}
					assert.equal(set.size, 100, 'Todos los 100 IDs generados deben ser únicos');
				} finally {
					Object.defineProperty(globalThis, 'crypto', {
						value: originalCrypto,
						configurable: true,
						writable: true
					});
				}
			}
		);

		await suite.test(
			'3. Contexto degradado extremo (crypto sin randomUUID ni getRandomValues)',
			() => {
				const originalCrypto = globalThis.crypto;
				try {
					Object.defineProperty(globalThis, 'crypto', {
						value: {},
						configurable: true,
						writable: true
					});

					const id = generateId();
					assert.match(
						id,
						UUID_V4_REGEX,
						'Debe generar un UUID v4 válido mediante el fallback de Math.random + timestamp'
					);

					// Unicidad en 500 iteraciones
					const set = new Set();
					for (let i = 0; i < 500; i++) {
						set.add(generateId());
					}
					assert.equal(set.size, 500, 'Todos los 500 IDs deben ser únicos');
				} finally {
					Object.defineProperty(globalThis, 'crypto', {
						value: originalCrypto,
						configurable: true,
						writable: true
					});
				}
			}
		);

		await suite.test(
			'4. Acción "Asumir" (prepareUnifiedAssignment) en contexto no seguro (sin crypto.randomUUID)',
			() => {
				const originalCrypto = globalThis.crypto;
				try {
					// Simula navegador en IP de red local sin HTTPS
					Object.defineProperty(globalThis, 'crypto', {
						value: {
							getRandomValues: (buffer) => originalCrypto.getRandomValues(buffer)
						},
						configurable: true,
						writable: true
					});

					const actor = {
						id: 'tech-1',
						name: 'Técnico Móvil',
						role: 'technician',
						organizationId: 'org-1',
						supportLevel: 'N2',
						active: true
					};

					const incident = {
						id: 99,
						organizationId: 'org-1',
						title: 'Prueba desde iPad/Fold',
						status: 'open',
						priority: 'medium',
						supportLevel: 'N1',
						assignedToUserId: null,
						createdAt: '2026-09-15T12:00:00.000Z'
					};

					const levels = [
						{
							id: 'l1',
							organizationId: 'org-1',
							code: 'N1',
							name: 'Nivel 1',
							order: 1,
							active: true
						},
						{
							id: 'l2',
							organizationId: 'org-1',
							code: 'N2',
							name: 'Nivel 2',
							order: 2,
							active: true
						}
					];

					// Esta llamada fallaba con "crypto.randomUUID is not a function" en http://192.168.1.118:5173
					const change = prepareUnifiedAssignment(
						actor,
						incident,
						[actor],
						[],
						{ assignedToUserId: actor.id },
						levels
					);

					assert.ok(change, 'Debe devolver el cambio de asignación sin errores');
					assert.equal(change.incident.assignedToUserId, actor.id);
					assert.match(
						change.event.id,
						UUID_V4_REGEX,
						'El ID de evento debe ser un UUID v4 válido'
					);
				} finally {
					Object.defineProperty(globalThis, 'crypto', {
						value: originalCrypto,
						configurable: true,
						writable: true
					});
				}
			}
		);

		await suite.test(
			'5. Generación de notificación en contexto no seguro (sin crypto.randomUUID)',
			() => {
				const originalCrypto = globalThis.crypto;
				try {
					Object.defineProperty(globalThis, 'crypto', {
						value: {
							getRandomValues: (buffer) => originalCrypto.getRandomValues(buffer)
						},
						configurable: true,
						writable: true
					});

					const actor = {
						id: 'admin-1',
						name: 'Administrador',
						role: 'organization_admin',
						organizationId: 'org-1',
						active: true
					};

					const incident = {
						id: 100,
						organizationId: 'org-1',
						title: 'Alerta asignación',
						status: 'open',
						priority: 'high',
						assignedToUserId: 'tech-1',
						createdAt: '2026-09-15T12:00:00.000Z'
					};

					const notif = buildIncidentNotification({
						type: 'incident_assigned',
						incident,
						actor,
						newAssigneeId: 'tech-1',
						reason: 'Asignada desde administración'
					});

					assert.ok(notif, 'Debe generar la notificación');
					assert.match(
						notif.id,
						UUID_V4_REGEX,
						'El ID de la notificación debe ser un UUID v4 válido'
					);
				} finally {
					Object.defineProperty(globalThis, 'crypto', {
						value: originalCrypto,
						configurable: true,
						writable: true
					});
				}
			}
		);
	} finally {
		await server.close();
	}
});

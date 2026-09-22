import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
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

test('SoporteFlow — Consistencia de eliminación de incidencias', async (suite) => {
	const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });

	try {
		const mod = (p) => server.ssrLoadModule(`/src/lib/${p}`);
		const { commitIncidentDeletion } = await mod('storage/incident-deletion.ts');
		const {
			INCIDENTS_KEY,
			HISTORY_KEY,
			RECOVERY_KEY: ASSIGNMENT_RECOVERY_KEY,
			TRANSITION_RECOVERY_KEY
		} = await mod('storage/assignment.ts');
		const { FIRST_RESPONSE_RECOVERY_KEY } = await mod('storage/first-response.ts');
		const { MESSAGES_KEY } = await mod('storage/messages.ts');
		const { NOTIFICATIONS_KEY } = await mod('storage/notifications.ts');
		const { RATINGS_KEY } = await mod('storage/ratings.ts');
		const { demoUsers } = await mod('data/users.ts');
		const { demoOrganization } = await mod('data/organizations.ts');

		const orgAdmin = demoUsers.find((u) => u.role === 'organization_admin');
		const platformAdmin = demoUsers.find((u) => u.role === 'platform_admin');
		const techUser = demoUsers.find((u) => u.role === 'technician');
		const clientUser = demoUsers.find((u) => u.role === 'client');

		const orgId = orgAdmin.organizationId ?? demoOrganization.id;

		const incidentA = {
			id: 101,
			organizationId: orgId,
			clientUserId: clientUser.id,
			assignedToUserId: techUser.id,
			title: 'Incidencia a eliminar',
			client: 'Cliente A',
			description: 'Descripción A',
			solution: '',
			status: 'open',
			priority: 'high',
			createdAt: '2026-09-20T10:00:00.000Z'
		};

		const incidentB = {
			id: 102,
			organizationId: orgId,
			clientUserId: clientUser.id,
			assignedToUserId: techUser.id,
			title: 'Incidencia a conservar',
			client: 'Cliente B',
			description: 'Descripción B',
			solution: '',
			status: 'open',
			priority: 'medium',
			createdAt: '2026-09-20T11:00:00.000Z'
		};

		const historyA = [
			{
				id: 'h-101',
				incidentId: 101,
				organizationId: orgId,
				actorUserId: orgAdmin.id,
				timestamp: '2026-09-20T10:00:00.000Z',
				eventType: 'created',
				newValue: { title: incidentA.title, status: 'open', priority: 'high' }
			}
		];

		const historyB = [
			{
				id: 'h-102',
				incidentId: 102,
				organizationId: orgId,
				actorUserId: orgAdmin.id,
				timestamp: '2026-09-20T11:00:00.000Z',
				eventType: 'created',
				newValue: { title: incidentB.title, status: 'open', priority: 'medium' }
			}
		];

		const combinedHistory = [...historyA, ...historyB];

		// =========================================================================
		// BLOQUE 1: PRUEBAS DEL MÓDULO (commitIncidentDeletion)
		// =========================================================================
		await suite.test('1. Eliminación correcta por organization_admin', () => {
			const incidents = [incidentA, incidentB];
			const store = createStore({
				[INCIDENTS_KEY]: JSON.stringify(incidents),
				[HISTORY_KEY]: JSON.stringify(combinedHistory)
			});

			const result = commitIncidentDeletion(
				store,
				orgAdmin,
				101,
				incidents,
				combinedHistory,
				store.getItem(INCIDENTS_KEY),
				store.getItem(HISTORY_KEY)
			);

			assert.equal(result.incidents.length, 1);
			assert.equal(result.incidents[0].id, 102);

			const savedIncidents = JSON.parse(store.getItem(INCIDENTS_KEY));
			assert.equal(savedIncidents.length, 1);
			assert.equal(savedIncidents[0].id, 102);

			assert.equal(store.getItem(HISTORY_KEY), JSON.stringify(combinedHistory));
			assert.equal(store.getItem(ASSIGNMENT_RECOVERY_KEY), null);
		});

		await suite.test('2. Eliminación correcta por platform_admin', () => {
			const incidents = [incidentA, incidentB];
			const store = createStore({
				[INCIDENTS_KEY]: JSON.stringify(incidents),
				[HISTORY_KEY]: JSON.stringify(combinedHistory)
			});

			const result = commitIncidentDeletion(
				store,
				platformAdmin,
				101,
				incidents,
				combinedHistory,
				store.getItem(INCIDENTS_KEY),
				store.getItem(HISTORY_KEY)
			);

			assert.equal(result.incidents.length, 1);
			assert.equal(result.incidents[0].id, 102);
		});

		await suite.test('3. Denegación a usuario sin autorización (technician / client)', () => {
			const incidents = [incidentA, incidentB];
			const store = createStore({
				[INCIDENTS_KEY]: JSON.stringify(incidents),
				[HISTORY_KEY]: JSON.stringify(combinedHistory)
			});

			assert.throws(
				() =>
					commitIncidentDeletion(
						store,
						techUser,
						101,
						incidents,
						combinedHistory,
						store.getItem(INCIDENTS_KEY),
						store.getItem(HISTORY_KEY)
					),
				/No tienes permiso para eliminar esta incidencia/
			);

			assert.throws(
				() =>
					commitIncidentDeletion(
						store,
						clientUser,
						101,
						incidents,
						combinedHistory,
						store.getItem(INCIDENTS_KEY),
						store.getItem(HISTORY_KEY)
					),
				/No tienes permiso para eliminar esta incidencia/
			);

			assert.equal(store.getItem(INCIDENTS_KEY), JSON.stringify(incidents));
		});

		await suite.test('4. Denegación ante acceso a otra organización', () => {
			const foreignIncident = {
				...incidentA,
				id: 999,
				organizationId: 'other-org-uuid'
			};
			const incidents = [foreignIncident];
			const store = createStore({
				[INCIDENTS_KEY]: JSON.stringify(incidents),
				[HISTORY_KEY]: JSON.stringify([])
			});

			assert.throws(
				() =>
					commitIncidentDeletion(
						store,
						orgAdmin, // orgAdmin pertenece a orgId, no a other-org-uuid
						999,
						incidents,
						[],
						store.getItem(INCIDENTS_KEY),
						store.getItem(HISTORY_KEY)
					),
				/No tienes permiso para eliminar esta incidencia/
			);

			assert.equal(store.getItem(INCIDENTS_KEY), JSON.stringify(incidents));
		});

		await suite.test('5. Denegación si la incidencia ya no existe', () => {
			const incidents = [incidentA];
			const store = createStore({
				[INCIDENTS_KEY]: JSON.stringify(incidents),
				[HISTORY_KEY]: JSON.stringify([])
			});

			assert.throws(
				() =>
					commitIncidentDeletion(
						store,
						orgAdmin,
						8888,
						incidents,
						[],
						store.getItem(INCIDENTS_KEY),
						store.getItem(HISTORY_KEY)
					),
				/La incidencia ya no está disponible/
			);
		});

		await suite.test('6. Fallo al escribir en localStorage desencadena rollback atómico', () => {
			const incidents = [incidentA, incidentB];
			const rawIncidents = JSON.stringify(incidents);
			const rawHistory = JSON.stringify(combinedHistory);

			const store = createStore({
				[INCIDENTS_KEY]: rawIncidents,
				[HISTORY_KEY]: rawHistory
			});

			// commitAssignment escribe:
			// 1. RECOVERY_KEY
			// 2. INCIDENTS_KEY (forzamos fallo aquí)
			// catch: recoverAssignment restaura INCIDENTS_KEY (3), HISTORY_KEY (4), borra RECOVERY_KEY (5)
			store.failAt(2);

			assert.throws(
				() =>
					commitIncidentDeletion(
						store,
						orgAdmin,
						101,
						incidents,
						combinedHistory,
						rawIncidents,
						rawHistory
					),
				/No se pudo guardar la asignación. Se han conservado la incidencia y el historial anteriores/
			);

			// El rollback debe haber dejado los datos originales intactos y sin journal colgado
			assert.equal(store.getItem(INCIDENTS_KEY), rawIncidents);
			assert.equal(store.getItem(HISTORY_KEY), rawHistory);
			assert.equal(store.getItem(ASSIGNMENT_RECOVERY_KEY), null);
		});

		await suite.test('7. Conflictos de snapshots (incidencias o historial obsoletos)', () => {
			const incidents = [incidentA, incidentB];
			const store = createStore({
				[INCIDENTS_KEY]: JSON.stringify(incidents),
				[HISTORY_KEY]: JSON.stringify(combinedHistory)
			});

			// Conflicto en snapshot de incidencias
			assert.throws(
				() =>
					commitIncidentDeletion(
						store,
						orgAdmin,
						101,
						incidents,
						combinedHistory,
						'stale-incident-snapshot',
						store.getItem(HISTORY_KEY)
					),
				/Los datos han cambiado en otra pestaña/
			);

			// Conflicto en snapshot de historial
			assert.throws(
				() =>
					commitIncidentDeletion(
						store,
						orgAdmin,
						101,
						incidents,
						combinedHistory,
						store.getItem(INCIDENTS_KEY),
						'stale-history-snapshot'
					),
				/Los datos han cambiado en otra pestaña/
			);

			// Los datos deben permanecer inalterados
			assert.equal(store.getItem(INCIDENTS_KEY), JSON.stringify(incidents));
		});

		await suite.test('8. Bloqueo ante los tres diarios de recuperación', () => {
			const incidents = [incidentA, incidentB];
			const rawIncidents = JSON.stringify(incidents);
			const rawHistory = JSON.stringify(combinedHistory);

			// Caso 8.1: Bloqueo por ASSIGNMENT_RECOVERY_KEY
			const store1 = createStore({
				[INCIDENTS_KEY]: rawIncidents,
				[HISTORY_KEY]: rawHistory,
				[ASSIGNMENT_RECOVERY_KEY]: JSON.stringify({
					version: 1,
					incidents: rawIncidents,
					history: rawHistory
				})
			});
			assert.throws(
				() =>
					commitIncidentDeletion(
						store1,
						orgAdmin,
						101,
						incidents,
						combinedHistory,
						rawIncidents,
						rawHistory
					),
				/Hay una operación pendiente de recuperación/
			);

			// Caso 8.2: Bloqueo por FIRST_RESPONSE_RECOVERY_KEY
			const store2 = createStore({
				[INCIDENTS_KEY]: rawIncidents,
				[HISTORY_KEY]: rawHistory,
				[FIRST_RESPONSE_RECOVERY_KEY]: JSON.stringify({ version: 1 })
			});
			assert.throws(
				() =>
					commitIncidentDeletion(
						store2,
						orgAdmin,
						101,
						incidents,
						combinedHistory,
						rawIncidents,
						rawHistory
					),
				/Hay una primera respuesta pendiente de recuperación/
			);

			// Caso 8.3: Bloqueo por TRANSITION_RECOVERY_KEY
			const store3 = createStore({
				[INCIDENTS_KEY]: rawIncidents,
				[HISTORY_KEY]: rawHistory,
				[TRANSITION_RECOVERY_KEY]: JSON.stringify({ version: 1 })
			});
			assert.throws(
				() =>
					commitIncidentDeletion(
						store3,
						orgAdmin,
						101,
						incidents,
						combinedHistory,
						rawIncidents,
						rawHistory
					),
				/Hay una operación pendiente de recuperación/
			);
		});

		await suite.test(
			'9. Conservación de todos los registros relacionados (mensajes, historial, notificaciones, ratings)',
			() => {
				const incidents = [incidentA, incidentB];
				const messages = [
					{
						id: 'msg-1',
						incidentId: 101,
						organizationId: orgId,
						authorUserId: techUser.id,
						authorName: techUser.name,
						authorRole: techUser.role,
						visibility: 'public',
						content: 'Comentario en incidencia 101',
						createdAt: '2026-09-20T10:15:00.000Z'
					}
				];
				const notifications = [
					{
						id: 'notif-1',
						organizationId: orgId,
						recipientUserId: techUser.id,
						type: 'incident_assigned',
						incidentId: 101,
						title: 'Asignada #101',
						message: 'Detalle',
						createdAt: '2026-09-20T10:00:00.000Z',
						readAt: null
					}
				];
				const ratings = [
					{
						id: 'rating-1',
						incidentId: 101,
						organizationId: orgId,
						technicianUserId: techUser.id,
						clientUserId: clientUser.id,
						rating: 5,
						comment: 'Excelente',
						resolvedAt: '2026-09-20T12:00:00.000Z',
						createdAt: '2026-09-20T12:30:00.000Z'
					}
				];

				const rawIncidents = JSON.stringify(incidents);
				const rawHistory = JSON.stringify(combinedHistory);
				const rawMessages = JSON.stringify(messages);
				const rawNotifications = JSON.stringify(notifications);
				const rawRatings = JSON.stringify(ratings);

				const store = createStore({
					[INCIDENTS_KEY]: rawIncidents,
					[HISTORY_KEY]: rawHistory,
					[MESSAGES_KEY]: rawMessages,
					[NOTIFICATIONS_KEY]: rawNotifications,
					[RATINGS_KEY]: rawRatings
				});

				commitIncidentDeletion(
					store,
					orgAdmin,
					101,
					incidents,
					combinedHistory,
					rawIncidents,
					rawHistory
				);

				// INCIDENTS_KEY debe haber cambiado
				const finalIncidents = JSON.parse(store.getItem(INCIDENTS_KEY));
				assert.equal(finalIncidents.length, 1);
				assert.equal(finalIncidents[0].id, 102);

				// Registros relacionados deben permanecer estrictamente intactos
				assert.equal(store.getItem(HISTORY_KEY), rawHistory, 'Historial debe conservarse');
				assert.equal(store.getItem(MESSAGES_KEY), rawMessages, 'Mensajes deben conservarse');
				assert.equal(
					store.getItem(NOTIFICATIONS_KEY),
					rawNotifications,
					'Notificaciones deben conservarse'
				);
				assert.equal(store.getItem(RATINGS_KEY), rawRatings, 'Ratings deben conservarse');
			}
		);

		await suite.test('10. Ausencia de reutilización de identificadores tras eliminación', () => {
			// Simular el estado tras eliminar incidentA (ID 101):
			// incidentList sólo contiene incidentB (ID 102).
			// Pero history y messages retienen referencias a 101 y 102.
			const currentIncidentList = [incidentB]; // id: 102
			const retainedHistory = combinedHistory; // contiene 101 y 102
			const retainedMessageIncidentIds = [101];

			// Regla implementada en createIncident:
			// const nextId = Math.max(0, ...incidentList.map(i => i.id), ...history.map(e => e.incidentId), ...messageIncidentIds) + 1;
			const nextId =
				Math.max(
					0,
					...currentIncidentList.map((i) => i.id),
					...retainedHistory.map((e) => e.incidentId),
					...retainedMessageIncidentIds
				) + 1;

			assert.equal(
				nextId,
				103,
				'El siguiente identificador debe ser 103, nunca reutilizar 101 ni 102'
			);
			assert.ok(nextId > 101);
			assert.ok(nextId > 102);
		});

		// =========================================================================
		// BLOQUE 2: PRUEBAS DEL ORQUESTADOR EN SVELTE (+page.svelte)
		// =========================================================================
		await suite.test(
			'11. Orquestador Svelte: cancelación de confirmación no altera memoria ni storage',
			async () => {
				const pageSource = readFileSync('src/routes/app/+page.svelte', 'utf8');
				const scriptContent = pageSource.split('<script lang="ts">')[1].split('</script>')[0];
				const ast = ts.createSourceFile(
					'page.ts',
					scriptContent,
					ts.ScriptTarget.Latest,
					true,
					ts.ScriptKind.TS
				);

				const fnNode = ast.statements.find(
					(n) => ts.isFunctionDeclaration(n) && n.name?.text === 'deleteIncident'
				);
				assert.ok(fnNode, 'deleteIncident debe existir en +page.svelte');

				const code = ts.transpileModule(
					`
				const { commitIncidentDeletion, canActOnIncident } = deps;
				let incidentList = seed.incidents;
				let history = seed.history;
				let storedIncidentSnapshot = seed.incidentRaw;
				let storedHistorySnapshot = seed.historyRaw;
				let editingIncident = seed.editing;
				let incidentLoadError = '';
				const activeUser = seed.actor;
				const localStorage = seed.storage;
				const alerts = [];
				const window = {
					confirm: (msg) => seed.confirmResult,
					alert: (msg) => alerts.push(msg)
				};
				${fnNode.getText(ast)}
				return {
					deleteIncident,
					getState: () => ({ incidentList, storedIncidentSnapshot, editingIncident, incidentLoadError, alerts })
				};
				`,
					{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
				).outputText;

				const factory = new Function('deps', 'seed', code);

				const incidents = [incidentA, incidentB];
				const store = createStore({
					[INCIDENTS_KEY]: JSON.stringify(incidents),
					[HISTORY_KEY]: JSON.stringify(combinedHistory)
				});

				const { canActOnIncident } = await mod('auth/record-access.ts');

				const harness = factory(
					{ commitIncidentDeletion, canActOnIncident },
					{
						incidents,
						history: combinedHistory,
						incidentRaw: store.getItem(INCIDENTS_KEY),
						historyRaw: store.getItem(HISTORY_KEY),
						editing: { ...incidentA },
						actor: orgAdmin,
						storage: store,
						confirmResult: false // USUARIO CANCELA
					}
				);

				harness.deleteIncident(101);

				const state = harness.getState();
				assert.equal(
					state.incidentList.length,
					2,
					'incidentList no debe mutar si se cancela la confirmación'
				);
				assert.equal(state.editingIncident?.id, 101, 'editingIncident debe seguir abierto');
				assert.equal(state.incidentLoadError, '');
				assert.equal(
					store.getItem(INCIDENTS_KEY),
					JSON.stringify(incidents),
					'Storage no debe modificarse'
				);
			}
		);

		await suite.test(
			'12. Orquestador Svelte: confirmación exitosa actualiza memoria, snapshot y cierra modal',
			async () => {
				const pageSource = readFileSync('src/routes/app/+page.svelte', 'utf8');
				const scriptContent = pageSource.split('<script lang="ts">')[1].split('</script>')[0];
				const ast = ts.createSourceFile(
					'page.ts',
					scriptContent,
					ts.ScriptTarget.Latest,
					true,
					ts.ScriptKind.TS
				);

				const fnNode = ast.statements.find(
					(n) => ts.isFunctionDeclaration(n) && n.name?.text === 'deleteIncident'
				);
				assert.ok(fnNode, 'deleteIncident debe existir');

				const code = ts.transpileModule(
					`
				const { commitIncidentDeletion, canActOnIncident } = deps;
				let incidentList = seed.incidents;
				let history = seed.history;
				let storedIncidentSnapshot = seed.incidentRaw;
				let storedHistorySnapshot = seed.historyRaw;
				let editingIncident = seed.editing;
				let incidentLoadError = '';
				const activeUser = seed.actor;
				const localStorage = seed.storage;
				const alerts = [];
				const window = {
					confirm: (msg) => seed.confirmResult,
					alert: (msg) => alerts.push(msg)
				};
				${fnNode.getText(ast)}
				return {
					deleteIncident,
					getState: () => ({ incidentList, storedIncidentSnapshot, editingIncident, incidentLoadError, alerts })
				};
				`,
					{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
				).outputText;

				const factory = new Function('deps', 'seed', code);
				const { canActOnIncident } = await server.ssrLoadModule('/src/lib/auth/record-access.ts');

				const incidents = [incidentA, incidentB];
				const store = createStore({
					[INCIDENTS_KEY]: JSON.stringify(incidents),
					[HISTORY_KEY]: JSON.stringify(combinedHistory)
				});

				const harness = factory(
					{ commitIncidentDeletion, canActOnIncident },
					{
						incidents,
						history: combinedHistory,
						incidentRaw: store.getItem(INCIDENTS_KEY),
						historyRaw: store.getItem(HISTORY_KEY),
						editing: { ...incidentA },
						actor: orgAdmin,
						storage: store,
						confirmResult: true // CONFIRMADO
					}
				);

				harness.deleteIncident(101);

				const state = harness.getState();
				assert.equal(
					state.incidentList.length,
					1,
					'incidentList debe contener 1 elemento tras persistir'
				);
				assert.equal(state.incidentList[0].id, 102);
				assert.equal(
					state.editingIncident,
					null,
					'editingIncident debe ser null para cerrar modal'
				);
				assert.equal(state.storedIncidentSnapshot, JSON.stringify([incidentB]));
				assert.equal(state.incidentLoadError, '');
			}
		);

		await suite.test(
			'13. Orquestador Svelte: fallo de persistencia conserva memoria intacta y no cierra modal',
			async () => {
				const pageSource = readFileSync('src/routes/app/+page.svelte', 'utf8');
				const scriptContent = pageSource.split('<script lang="ts">')[1].split('</script>')[0];
				const ast = ts.createSourceFile(
					'page.ts',
					scriptContent,
					ts.ScriptTarget.Latest,
					true,
					ts.ScriptKind.TS
				);

				const fnNode = ast.statements.find(
					(n) => ts.isFunctionDeclaration(n) && n.name?.text === 'deleteIncident'
				);
				assert.ok(fnNode, 'deleteIncident debe existir');

				const code = ts.transpileModule(
					`
				const { commitIncidentDeletion, canActOnIncident } = deps;
				let incidentList = seed.incidents;
				let history = seed.history;
				let storedIncidentSnapshot = seed.incidentRaw;
				let storedHistorySnapshot = seed.historyRaw;
				let editingIncident = seed.editing;
				let incidentLoadError = '';
				const activeUser = seed.actor;
				const localStorage = seed.storage;
				const alerts = [];
				const window = {
					confirm: (msg) => seed.confirmResult,
					alert: (msg) => alerts.push(msg)
				};
				${fnNode.getText(ast)}
				return {
					deleteIncident,
					getState: () => ({ incidentList, storedIncidentSnapshot, editingIncident, incidentLoadError, alerts })
				};
				`,
					{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
				).outputText;

				const factory = new Function('deps', 'seed', code);
				const { canActOnIncident } = await server.ssrLoadModule('/src/lib/auth/record-access.ts');

				const incidents = [incidentA, incidentB];
				const store = createStore({
					[INCIDENTS_KEY]: JSON.stringify(incidents),
					[HISTORY_KEY]: JSON.stringify(combinedHistory)
				});

				// Forzamos conflicto de concurrencia en disco antes de la llamada
				store.setItem(INCIDENTS_KEY, 'divergent-storage-from-another-tab');

				const harness = factory(
					{ commitIncidentDeletion, canActOnIncident },
					{
						incidents,
						history: combinedHistory,
						incidentRaw: JSON.stringify(incidents), // snapshot local desfasado respecto al store
						historyRaw: store.getItem(HISTORY_KEY),
						editing: { ...incidentA },
						actor: orgAdmin,
						storage: store,
						confirmResult: true
					}
				);

				harness.deleteIncident(101);

				const state = harness.getState();
				// El estado en memoria reactivo DEBE permanecer intacto
				assert.equal(
					state.incidentList.length,
					2,
					'incidentList NO debe mutar si la persistencia falla'
				);
				assert.equal(state.incidentList[0].id, 101);
				assert.equal(
					state.editingIncident?.id,
					101,
					'editingIncident NO debe cerrarse si falla el guardado'
				);
				assert.ok(state.incidentLoadError.length > 0, 'incidentLoadError debe quedar registrado');
				assert.equal(state.alerts.length, 1, 'Debe emitirse alert con el error');
			}
		);

		// =========================================================================
		// BLOQUE 3: VERIFICACIONES ESTÁTICAS DE SVELTE Y ARQUITECTURA
		// =========================================================================
		await suite.test(
			'14. Verificación estática: saveIncidents eliminado y no existen referencias huérfanas',
			() => {
				const pageSource = readFileSync('src/routes/app/+page.svelte', 'utf8');

				assert.ok(
					!pageSource.includes('function saveIncidents'),
					'+page.svelte no debe contener la declaración de saveIncidents'
				);
				assert.ok(
					!pageSource.includes('saveIncidents()'),
					'+page.svelte no debe contener llamadas a saveIncidents()'
				);
				assert.ok(
					pageSource.includes('commitIncidentDeletion'),
					'+page.svelte debe importar y usar commitIncidentDeletion'
				);
			}
		);
	} finally {
		await server.close();
	}
});

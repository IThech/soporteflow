import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

test('Clasificación V2E.2 — Integración en UI, Orquestación y Persistencia Coordinada', async (suite) => {
	const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
	try {
		const { reclassifyIncident, applyPriorityOverride, removePriorityOverride } =
			await server.ssrLoadModule('/src/lib/incidents/lifecycle.ts');
		const { commitAssignment, INCIDENTS_KEY, HISTORY_KEY, RECOVERY_KEY } =
			await server.ssrLoadModule('/src/lib/storage/assignment.ts');
		const { isIncidentList } = await server.ssrLoadModule('/src/lib/incidents/validation.ts');
		const { isIncidentHistory } = await server.ssrLoadModule('/src/lib/incidents/history.ts');
		const { canActOnIncident } = await server.ssrLoadModule('/src/lib/auth/record-access.ts');
		const { createStandardPriorityMatrix } = await server.ssrLoadModule(
			'/src/lib/classification/engine.ts'
		);

		const orgId = 'org-nodhouses';
		const otherOrgId = 'org-other';

		const categories = [
			{
				id: 'cat-apps',
				name: 'Aplicaciones',
				organizationId: orgId,
				active: true,
				defaultSupportLevel: 'N2',
				defaultTeamId: 'team-apps'
			},
			{
				id: 'cat-infra',
				name: 'Infraestructura',
				organizationId: orgId,
				active: true,
				defaultSupportLevel: 'N1',
				defaultTeamId: 'team-infra'
			}
		];

		const subcategories = [
			{
				id: 'sub-erp',
				organizationId: orgId,
				categoryId: 'cat-apps',
				name: 'ERP / CRM',
				baseCriticality: 'high',
				minPriority: null,
				active: true
			},
			{
				id: 'sub-email',
				organizationId: orgId,
				categoryId: 'cat-apps',
				name: 'Correo y Calendario',
				baseCriticality: 'medium',
				minPriority: null,
				active: true
			},
			{
				id: 'sub-vpn',
				organizationId: orgId,
				categoryId: 'cat-infra',
				name: 'VPN y Accesos Remotos',
				baseCriticality: 'low',
				minPriority: null,
				active: true
			}
		];

		const priorityMatrices = [createStandardPriorityMatrix(orgId)];

		const adminUser = {
			id: 'usr-admin-01',
			name: 'Admin Nodhouses',
			role: 'organization_admin',
			organizationId: orgId,
			active: true
		};

		const techUser = {
			id: 'usr-tech-01',
			name: 'Técnico Nodhouses',
			role: 'technician',
			organizationId: orgId,
			active: true
		};

		const clientUser = {
			id: 'usr-client-01',
			name: 'Cliente Nodhouses',
			role: 'client',
			organizationId: orgId,
			active: true
		};

		const otherOrgAdmin = {
			id: 'usr-other-admin',
			name: 'Admin Otra Org',
			role: 'organization_admin',
			organizationId: otherOrgId,
			active: true
		};

		function createMockStorage() {
			const values = new Map();
			let writeCount = 0;
			let failAtWrites = new Set();
			return {
				values,
				failAt(...counts) {
					writeCount = 0;
					failAtWrites = new Set(counts);
				},
				getItem(key) {
					return values.get(key) ?? null;
				},
				setItem(key, value) {
					if (failAtWrites.has(++writeCount)) {
						throw new Error('QuotaExceededError: localStorage full');
					}
					values.set(key, value);
				},
				removeItem(key) {
					values.delete(key);
				},
				clear() {
					values.clear();
					writeCount = 0;
					failAtWrites.clear();
				}
			};
		}

		function createSampleV2Incident(overrides = {}) {
			return {
				id: 301,
				organizationId: orgId,
				createdByUserId: clientUser.id,
				title: 'Problema en servidor ERP',
				client: 'Cliente Demo',
				description: 'El ERP responde lentamente tras la actualización.',
				status: 'open',
				priority: 'urgent', // High criticality + I4 => urgent
				createdAt: '2026-09-15T08:00:00.000Z',
				updatedAt: '2026-09-15T08:00:00.000Z',
				assignedToUserId: techUser.id,
				teamId: 'team-apps',
				supportLevel: 'N2',
				siteId: 'site-central',
				categoryId: 'cat-apps',
				subcategoryId: 'sub-erp',
				classification: {
					baseCriticality: 'high',
					impactLevel: 'I4',
					matrixPriority: 'critical',
					minPriority: null,
					minPriorityApplied: false,
					calculatedPriority: 'critical',
					effectivePriority: 'critical',
					hasOverride: false
				},
				sla: {
					policyId: 'sla-apps-urgent',
					policyName: 'SLA Apps Urgente',
					firstResponseMinutes: 60,
					resolutionMinutes: 240,
					firstResponseDueAt: '2026-09-15T09:00:00.000Z',
					resolutionDueAt: '2026-09-15T12:00:00.000Z',
					firstRespondedAt: '2026-09-15T08:30:00.000Z',
					resolvedAt: null
				},
				...overrides
			};
		}

		await suite.test(
			'1. Flujo completo de reclasificación válida y persistencia coordinada',
			() => {
				const storage = createMockStorage();
				const incident = createSampleV2Incident();
				let incidentList = [incident];
				let history = [];
				let storedIncidentSnapshot = JSON.stringify(incidentList);
				let storedHistorySnapshot = JSON.stringify(history);

				storage.setItem(INCIDENTS_KEY, storedIncidentSnapshot);
				storage.setItem(HISTORY_KEY, storedHistorySnapshot);

				// Reclasificar de sub-erp (high) + I4 (urgent) a sub-vpn (low) + I2 (low)
				const res = reclassifyIncident({
					incident,
					actorUser: techUser,
					newCategoryId: 'cat-infra',
					newSubcategoryId: 'sub-vpn',
					newImpact: 'I2',
					reason: 'Identificado que no es fallo de ERP sino lentitud de VPN doméstica',
					categoryList: categories,
					subcategories,
					priorityMatrices
				});

				assert.equal(res.ok, true);
				if (!res.ok) return;

				// Nueva prioridad operativa pasa a ser low
				assert.equal(res.incident.priority, 'low');
				assert.equal(res.incident.categoryId, 'cat-infra');
				assert.equal(res.incident.subcategoryId, 'sub-vpn');
				assert.equal(res.incident.classification.impactLevel, 'I2');
				assert.equal(res.incident.classification.calculatedPriority, 'low');
				assert.equal(res.incident.classification.effectivePriority, 'low');
				assert.equal(res.incident.classification.hasOverride, false);

				// Persistencia simulando el handler de UI en +page.svelte
				const nextList = incidentList.map((i) => (i.id === incident.id ? res.incident : i));
				const nextHistory = [...history, res.historyEntry];

				assert.equal(isIncidentList(nextList), true);
				assert.equal(isIncidentHistory(nextHistory), true);

				commitAssignment(
					storage,
					nextList,
					nextHistory,
					storedIncidentSnapshot,
					storedHistorySnapshot
				);

				// Verificación en storage
				const persistedIncidents = JSON.parse(storage.getItem(INCIDENTS_KEY));
				const persistedHistory = JSON.parse(storage.getItem(HISTORY_KEY));
				assert.equal(persistedIncidents[0].priority, 'low');
				assert.equal(persistedIncidents[0].subcategoryId, 'sub-vpn');
				assert.equal(persistedHistory.length, 1);
				assert.equal(persistedHistory[0].eventType, 'reclassified');
				assert.equal(
					persistedHistory[0].reason,
					'Identificado que no es fallo de ERP sino lentitud de VPN doméstica'
				);
				assert.equal(persistedHistory[0].newValue.previousCalculatedPriority, 'urgent');
				assert.equal(persistedHistory[0].newValue.newCalculatedPriority, 'low');
				assert.equal(persistedHistory[0].newValue.previousEffectivePriority, 'urgent');
				assert.equal(persistedHistory[0].newValue.newEffectivePriority, 'low');

				// Conservación inmutable de SLA y routing
				assert.deepEqual(persistedIncidents[0].sla, incident.sla);
				assert.equal(persistedIncidents[0].assignedToUserId, techUser.id);
				assert.equal(persistedIncidents[0].teamId, 'team-apps');
				assert.equal(persistedIncidents[0].supportLevel, 'N2');
			}
		);

		await suite.test(
			'2. Reclasificación sin cambios: detección y rechazo sin mutar storage',
			() => {
				const storage = createMockStorage();
				const incident = createSampleV2Incident();
				const incidentList = [incident];
				const history = [];
				const storedIncidentSnapshot = JSON.stringify(incidentList);
				const storedHistorySnapshot = JSON.stringify(history);

				storage.setItem(INCIDENTS_KEY, storedIncidentSnapshot);
				storage.setItem(HISTORY_KEY, storedHistorySnapshot);

				const res = reclassifyIncident({
					incident,
					actorUser: techUser,
					newCategoryId: 'cat-apps',
					newSubcategoryId: 'sub-erp',
					newImpact: 'I4',
					reason: 'Sin cambios reales',
					categoryList: categories,
					subcategories,
					priorityMatrices
				});

				assert.equal(res.ok, false);
				assert.match(res.error, /no se han detectado cambios/i);

				// Storage permanece inalterado
				assert.equal(storage.getItem(INCIDENTS_KEY), storedIncidentSnapshot);
				assert.equal(storage.getItem(HISTORY_KEY), storedHistorySnapshot);
			}
		);

		await suite.test('3. Reclasificación con motivo vacío: rechazo de validación', () => {
			const incident = createSampleV2Incident();

			for (const emptyReason of ['', '   ', '\t\n']) {
				const res = reclassifyIncident({
					incident,
					actorUser: techUser,
					newCategoryId: 'cat-infra',
					newSubcategoryId: 'sub-vpn',
					newImpact: 'I2',
					reason: emptyReason,
					categoryList: categories,
					subcategories,
					priorityMatrices
				});
				assert.equal(res.ok, false);
				assert.match(res.error, /motivo.*obligatorio/i);
			}
		});

		await suite.test('4. Aplicación de override de prioridad y registro en historial', () => {
			const storage = createMockStorage();
			// Incidencia clasificada en low (sub-vpn + I2)
			const incident = createSampleV2Incident({
				subcategoryId: 'sub-vpn',
				priority: 'low',
				classification: {
					baseCriticality: 'low',
					impactLevel: 'I2',
					matrixPriority: 'low',
					minPriority: null,
					minPriorityApplied: false,
					calculatedPriority: 'low',
					effectivePriority: 'low',
					hasOverride: false
				}
			});
			const incidentList = [incident];
			const history = [];
			const storedIncidentSnapshot = JSON.stringify(incidentList);
			const storedHistorySnapshot = JSON.stringify(history);

			storage.setItem(INCIDENTS_KEY, storedIncidentSnapshot);
			storage.setItem(HISTORY_KEY, storedHistorySnapshot);

			// Admin aplica override forzando a urgent
			const res = applyPriorityOverride({
				incident,
				actorUser: adminUser,
				targetPriority: 'urgent',
				reason: 'Solicitud expresa de dirección general para desbloquear auditoría'
			});

			assert.equal(res.ok, true);
			if (!res.ok) return;

			assert.equal(res.incident.priority, 'urgent');
			assert.equal(res.incident.classification.hasOverride, true);
			assert.equal(res.incident.classification.effectivePriority, 'critical');
			assert.equal(res.incident.classification.calculatedPriority, 'low'); // Inmutable
			assert.equal(
				res.incident.classification.overrideReason,
				'Solicitud expresa de dirección general para desbloquear auditoría'
			);
			assert.equal(res.incident.classification.overrideAuthorizedBy, adminUser.id);

			assert.equal(res.historyEntry.eventType, 'priority_override_applied');
			assert.equal(res.historyEntry.newValue.calculatedPriority, 'low');
			assert.equal(res.historyEntry.newValue.previousEffectivePriority, 'low');
			assert.equal(res.historyEntry.newValue.newEffectivePriority, 'urgent');

			// Persistencia
			const nextList = [res.incident];
			const nextHistory = [res.historyEntry];
			commitAssignment(
				storage,
				nextList,
				nextHistory,
				storedIncidentSnapshot,
				storedHistorySnapshot
			);

			const saved = JSON.parse(storage.getItem(INCIDENTS_KEY))[0];
			assert.equal(saved.priority, 'urgent');
			assert.equal(saved.classification.hasOverride, true);
			assert.equal(saved.classification.calculatedPriority, 'low');
			assert.deepEqual(saved.sla, incident.sla); // SLA intacto
		});

		await suite.test('5. Modificación de override de prioridad activo', () => {
			// Incidencia con override previo a urgent
			const incidentWithOverride = createSampleV2Incident({
				subcategoryId: 'sub-vpn',
				priority: 'urgent',
				classification: {
					baseCriticality: 'low',
					impactLevel: 'I2',
					matrixPriority: 'low',
					minPriority: null,
					minPriorityApplied: false,
					calculatedPriority: 'low',
					effectivePriority: 'critical',
					hasOverride: true,
					overrideReason: 'Motivo previo',
					overrideAuthorizedBy: adminUser.id
				}
			});

			// Admin modifica override a high
			const res = applyPriorityOverride({
				incident: incidentWithOverride,
				actorUser: adminUser,
				targetPriority: 'high',
				reason: 'Ajuste de impacto tras acordar con cliente'
			});

			assert.equal(res.ok, true);
			if (!res.ok) return;

			assert.equal(res.incident.priority, 'high');
			assert.equal(res.incident.classification.hasOverride, true);
			assert.equal(res.incident.classification.calculatedPriority, 'low');
			assert.equal(res.incident.classification.effectivePriority, 'high');
			assert.equal(res.historyEntry.eventType, 'priority_override_modified');
			assert.equal(res.historyEntry.newValue.previousEffectivePriority, 'urgent');
			assert.equal(res.historyEntry.newValue.newEffectivePriority, 'high');
		});

		await suite.test(
			'6. Retirada de override de prioridad y restauración de calculada base',
			() => {
				const incidentWithOverride = createSampleV2Incident({
					subcategoryId: 'sub-vpn',
					priority: 'urgent',
					classification: {
						baseCriticality: 'low',
						impactLevel: 'I2',
						matrixPriority: 'low',
						minPriority: null,
						minPriorityApplied: false,
						calculatedPriority: 'low',
						effectivePriority: 'critical',
						hasOverride: true,
						overrideReason: 'Override temporal',
						overrideAuthorizedBy: adminUser.id
					}
				});

				const res = removePriorityOverride({
					incident: incidentWithOverride,
					actorUser: adminUser,
					reason: 'Finalizada la auditoría especial; se normaliza la operativa'
				});

				assert.equal(res.ok, true);
				if (!res.ok) return;

				assert.equal(res.incident.priority, 'low');
				assert.equal(res.incident.classification.hasOverride, false);
				assert.equal(res.incident.classification.overrideReason, undefined);
				assert.equal(res.incident.classification.overrideAuthorizedBy, undefined);
				assert.equal(res.incident.classification.effectivePriority, 'low');
				assert.equal(res.incident.classification.calculatedPriority, 'low');

				assert.equal(res.historyEntry.eventType, 'priority_override_removed');
				assert.equal(res.historyEntry.newValue.previousEffectivePriority, 'urgent');
				assert.equal(res.historyEntry.newValue.newEffectivePriority, 'low');
				assert.equal(res.historyEntry.newValue.calculatedPriority, 'low');
			}
		);

		await suite.test(
			'7. Retirada automática de override al reclasificar (con auditoría completa)',
			() => {
				// Incidencia calculada originalmente en medium, con override activo a urgent
				const incidentWithOverride = createSampleV2Incident({
					categoryId: 'cat-apps',
					subcategoryId: 'sub-email',
					priority: 'urgent',
					classification: {
						baseCriticality: 'medium',
						impactLevel: 'I2',
						matrixPriority: 'medium',
						minPriority: null,
						minPriorityApplied: false,
						calculatedPriority: 'medium',
						effectivePriority: 'critical',
						hasOverride: true,
						overrideReason: 'Excepción previa de urgencia',
						overrideAuthorizedBy: adminUser.id
					}
				});

				// Reclasificar a ERP (high) + I4 => calculada = urgent
				const res = reclassifyIncident({
					incident: incidentWithOverride,
					actorUser: techUser,
					newCategoryId: 'cat-apps',
					newSubcategoryId: 'sub-erp',
					newImpact: 'I4',
					reason: 'Se amplía el alcance al ERP completo',
					categoryList: categories,
					subcategories,
					priorityMatrices
				});

				assert.equal(res.ok, true);
				if (!res.ok) return;

				// El override queda revocado
				assert.equal(res.incident.classification.hasOverride, false);
				assert.equal(res.incident.classification.overrideReason, undefined);
				assert.equal(res.incident.classification.overrideAuthorizedBy, undefined);
				assert.equal(res.incident.priority, 'urgent'); // Calculada por la nueva taxonomía

				// Auditoría de revocación en el evento
				const rev = res.historyEntry.newValue.overrideRevoked;
				assert.ok(rev, 'overrideRevoked debe estar presente en el evento');
				assert.equal(rev.previousTargetPriority, 'urgent');
				assert.equal(rev.previousReason, 'Excepción previa de urgencia');
				assert.equal(rev.previousAuthorizedBy, adminUser.id);
			}
		);

		await suite.test('8. Permisos por rol y organización: technicians vs admins vs clients', () => {
			const incident = createSampleV2Incident();

			// 1. Técnico: puede reclasificar, pero no puede hacer override
			assert.equal(canActOnIncident(techUser, incident, 'incidents:classify'), true);
			assert.equal(canActOnIncident(techUser, incident, 'incidents:override_priority'), false);

			const overrideByTech = applyPriorityOverride({
				incident,
				actorUser: techUser,
				targetPriority: 'high',
				reason: 'Técnico intentando override'
			});
			assert.equal(overrideByTech.ok, false);
			assert.match(overrideByTech.error, /permiso/i);

			// 2. Admin: puede reclasificar y aplicar override
			assert.equal(canActOnIncident(adminUser, incident, 'incidents:classify'), true);
			assert.equal(canActOnIncident(adminUser, incident, 'incidents:override_priority'), true);

			// 3. Cliente: no puede reclasificar ni aplicar override
			assert.equal(canActOnIncident(clientUser, incident, 'incidents:classify'), false);
			assert.equal(canActOnIncident(clientUser, incident, 'incidents:override_priority'), false);

			const reclassByClient = reclassifyIncident({
				incident,
				actorUser: clientUser,
				newCategoryId: 'cat-infra',
				newSubcategoryId: 'sub-vpn',
				newImpact: 'I2',
				reason: 'Cliente intentando reclasificar',
				categoryList: categories,
				subcategories,
				priorityMatrices
			});
			assert.equal(reclassByClient.ok, false);
			assert.match(reclassByClient.error, /permiso/i);

			// 4. Admin de otra organización: denegado por multi-tenant
			assert.equal(canActOnIncident(otherOrgAdmin, incident, 'incidents:classify'), false);
			assert.equal(canActOnIncident(otherOrgAdmin, incident, 'incidents:override_priority'), false);
		});

		await suite.test('9. Restricciones de estado: resolved y closed bloquean operaciones', () => {
			const resolvedIncident = createSampleV2Incident({ status: 'resolved' });
			const closedIncident = createSampleV2Incident({ status: 'closed' });

			// Reclasificación en resolved
			const reclassResolved = reclassifyIncident({
				incident: resolvedIncident,
				actorUser: adminUser,
				newCategoryId: 'cat-infra',
				newSubcategoryId: 'sub-vpn',
				newImpact: 'I2',
				reason: 'Intento en resuelta',
				categoryList: categories,
				subcategories,
				priorityMatrices
			});
			assert.equal(reclassResolved.ok, false);
			assert.match(reclassResolved.error, /reabrirse/i);

			// Override en resolved
			const overrideResolved = applyPriorityOverride({
				incident: resolvedIncident,
				actorUser: adminUser,
				targetPriority: 'high',
				reason: 'Intento en resuelta'
			});
			assert.equal(overrideResolved.ok, false);
			assert.match(overrideResolved.error, /reabrirse/i);

			// Reclasificación en closed
			const reclassClosed = reclassifyIncident({
				incident: closedIncident,
				actorUser: adminUser,
				newCategoryId: 'cat-infra',
				newSubcategoryId: 'sub-vpn',
				newImpact: 'I2',
				reason: 'Intento en cerrada',
				categoryList: categories,
				subcategories,
				priorityMatrices
			});
			assert.equal(reclassClosed.ok, false);
			assert.match(reclassClosed.error, /cerrada/i);

			// Override en closed
			const overrideClosed = applyPriorityOverride({
				incident: closedIncident,
				actorUser: adminUser,
				targetPriority: 'high',
				reason: 'Intento en cerrada'
			});
			assert.equal(overrideClosed.ok, false);
			assert.match(overrideClosed.error, /cerrada/i);
		});

		await suite.test(
			'10. Gestión segura de conflictos entre pestañas (concurrencia optimista)',
			() => {
				const storage = createMockStorage();
				const incident = createSampleV2Incident();
				let incidentList = [incident];
				let history = [];
				const initialIncidentsSnapshot = JSON.stringify(incidentList);
				const initialHistorySnapshot = JSON.stringify(history);

				storage.setItem(INCIDENTS_KEY, initialIncidentsSnapshot);
				storage.setItem(HISTORY_KEY, initialHistorySnapshot);

				// Simular que otra pestaña altera el almacenamiento entretanto
				const concurrentIncidents = [{ ...incident, title: 'Modificado por otra pestaña' }];
				storage.setItem(INCIDENTS_KEY, JSON.stringify(concurrentIncidents));

				// Reclasificación local calculada
				const res = reclassifyIncident({
					incident,
					actorUser: techUser,
					newCategoryId: 'cat-infra',
					newSubcategoryId: 'sub-vpn',
					newImpact: 'I2',
					reason: 'Reclasificación con conflicto de pestaña',
					categoryList: categories,
					subcategories,
					priorityMatrices
				});
				assert.equal(res.ok, true);
				if (!res.ok) return;

				const nextList = incidentList.map((i) => (i.id === incident.id ? res.incident : i));
				const nextHistory = [...history, res.historyEntry];

				// Simulación del patrón try/catch del handler en +page.svelte
				let dialogTarget = incident;
				let dialogError = '';
				let localIncidentsMutated = false;

				try {
					commitAssignment(
						storage,
						nextList,
						nextHistory,
						initialIncidentsSnapshot,
						initialHistorySnapshot
					);
					incidentList = nextList;
					history = nextHistory;
					dialogTarget = null;
					localIncidentsMutated = true;
				} catch (err) {
					dialogError = err instanceof Error ? err.message : 'Error inesperado';
				}

				// Verificaciones clave del protocolo 2E.2:
				// 1. El diálogo permanece abierto
				assert.ok(dialogTarget !== null, 'El modal debe permanecer abierto');
				// 2. Mensaje descriptivo de conflicto de pestaña
				assert.match(dialogError, /otra pestaña/i);
				// 3. Cero mutación en memoria de la lista local
				assert.equal(localIncidentsMutated, false);
				assert.equal(incidentList[0].priority, 'urgent'); // No se cambió a low
				assert.equal(history.length, 0); // No se añadió el evento no confirmado
				// 4. Cero sobrescritura destructiva de los datos de la otra pestaña en storage
				const currentInStorage = JSON.parse(storage.getItem(INCIDENTS_KEY));
				assert.equal(currentInStorage[0].title, 'Modificado por otra pestaña');
			}
		);

		await suite.test(
			'11. Persistencia coordinada y rollback con recovery journal ante fallo de escritura',
			() => {
				const storage = createMockStorage();
				const incident = createSampleV2Incident();
				const incidentList = [incident];
				const history = [];
				const initialIncidentsSnapshot = JSON.stringify(incidentList);
				const initialHistorySnapshot = JSON.stringify(history);

				storage.setItem(INCIDENTS_KEY, initialIncidentsSnapshot);
				storage.setItem(HISTORY_KEY, initialHistorySnapshot);

				const res = applyPriorityOverride({
					incident,
					actorUser: adminUser,
					targetPriority: 'high',
					reason: 'Override previo a fallo de disco'
				});
				assert.equal(res.ok, true);
				if (!res.ok) return;

				// Forzar fallo en el segundo setItem (ej. falla al escribir HISTORY_KEY tras haber escrito INCIDENTS_KEY)
				// RECOVERY_KEY es la llamada 1, INCIDENTS_KEY es la 2, HISTORY_KEY es la 3
				storage.failAt(3);

				assert.throws(
					() =>
						commitAssignment(
							storage,
							[res.incident],
							[res.historyEntry],
							initialIncidentsSnapshot,
							initialHistorySnapshot
						),
					/no se pudo guardar/i
				);

				// El rollback de recoverAssignment restauró los snapshots originales
				assert.equal(storage.getItem(INCIDENTS_KEY), initialIncidentsSnapshot);
				assert.equal(storage.getItem(HISTORY_KEY), initialHistorySnapshot);
				assert.equal(storage.getItem(RECOVERY_KEY), null);
			}
		);

		await suite.test('12. Inmutabilidad estricta del SLA en las 4 operaciones de 2E', () => {
			const baseIncident = createSampleV2Incident();
			const originalSla = structuredClone(baseIncident.sla);

			// 1. Reclasificar
			const reclass = reclassifyIncident({
				incident: baseIncident,
				actorUser: techUser,
				newCategoryId: 'cat-infra',
				newSubcategoryId: 'sub-vpn',
				newImpact: 'I1',
				reason: 'Motivo prueba SLA',
				categoryList: categories,
				subcategories,
				priorityMatrices
			});
			assert.equal(reclass.ok, true);
			if (reclass.ok) {
				assert.deepEqual(reclass.incident.sla, originalSla);
			}

			// 2. Aplicar override
			const apply = applyPriorityOverride({
				incident: baseIncident,
				actorUser: adminUser,
				targetPriority: 'low',
				reason: 'Motivo prueba SLA'
			});
			assert.equal(apply.ok, true);
			if (apply.ok) {
				assert.deepEqual(apply.incident.sla, originalSla);

				// 3. Modificar override
				const modify = applyPriorityOverride({
					incident: apply.incident,
					actorUser: adminUser,
					targetPriority: 'high',
					reason: 'Modificar motivo SLA'
				});
				assert.equal(modify.ok, true);
				if (modify.ok) {
					assert.deepEqual(modify.incident.sla, originalSla);

					// 4. Retirar override
					const remove = removePriorityOverride({
						incident: modify.incident,
						actorUser: adminUser,
						reason: 'Retirar motivo SLA'
					});
					assert.equal(remove.ok, true);
					if (remove.ok) {
						assert.deepEqual(remove.incident.sla, originalSla);
					}
				}
			}
		});

		await suite.test('13. Inmutabilidad estricta del routing operativo', () => {
			const incident = createSampleV2Incident({
				assignedToUserId: techUser.id,
				teamId: 'team-apps',
				supportLevel: 'N2'
			});

			// Reclasificar a una categoría diferente (cat-infra cuyo default es N1 y team-infra)
			const res = reclassifyIncident({
				incident,
				actorUser: techUser,
				newCategoryId: 'cat-infra',
				newSubcategoryId: 'sub-vpn',
				newImpact: 'I2',
				reason: 'Reclasificación sin alterar asignación actual',
				categoryList: categories,
				subcategories,
				priorityMatrices
			});

			assert.equal(res.ok, true);
			if (!res.ok) return;

			// El routing previo NO debe cambiar a los defaults de cat-infra
			assert.equal(res.incident.assignedToUserId, techUser.id);
			assert.equal(res.incident.teamId, 'team-apps');
			assert.equal(res.incident.supportLevel, 'N2');
		});

		await suite.test('14. Compatibilidad con incidencias legacy V1', () => {
			const v1Incident = {
				id: 99,
				organizationId: orgId,
				title: 'Incidencia legacy V1 sin classification',
				client: 'Cliente V1',
				description: 'Descripción V1',
				status: 'open',
				priority: 'medium',
				createdAt: '2026-08-10T12:00:00.000Z'
			};

			const reclassV1 = reclassifyIncident({
				incident: v1Incident,
				actorUser: adminUser,
				newCategoryId: 'cat-apps',
				newSubcategoryId: 'sub-erp',
				newImpact: 'I2',
				reason: 'Intento en V1',
				categoryList: categories,
				subcategories,
				priorityMatrices
			});
			assert.equal(reclassV1.ok, false);
			assert.match(reclassV1.error, /V2/i);

			const overrideV1 = applyPriorityOverride({
				incident: v1Incident,
				actorUser: adminUser,
				targetPriority: 'urgent',
				reason: 'Intento override V1'
			});
			assert.equal(overrideV1.ok, false);
			assert.match(overrideV1.error, /V2/i);

			const removeV1 = removePriorityOverride({
				incident: v1Incident,
				actorUser: adminUser,
				reason: 'Intento remove override V1'
			});
			assert.equal(removeV1.ok, false);
			assert.match(removeV1.error, /V2/i);
		});

		await suite.test(
			'15. Formateo preciso del historial reclassified sin redundancias (ej. impacto solo)',
			async () => {
				const { describeHistoryEvent } = await server.ssrLoadModule(
					'/src/lib/incidents/timeline.ts'
				);

				// Caso QA #24: solo cambia impacto de I4 a I1 dentro de la misma categoría/subcategoría
				const entryImpactOnly = {
					id: 'hist-reclass-01',
					incidentId: 24,
					organizationId: orgId,
					actorUserId: adminUser.id,
					eventType: 'reclassified',
					timestamp: '2026-09-16T20:00:00.000Z',
					reason: 'Ajuste de alcance real detectado',
					previousValue: null,
					newValue: {
						previousCategoryId: 'cat-apps',
						newCategoryId: 'cat-apps',
						previousSubcategoryId: 'sub-erp',
						newSubcategoryId: 'sub-erp',
						previousImpact: 'I4',
						newImpact: 'I1',
						previousCalculatedPriority: 'urgent',
						newCalculatedPriority: 'medium',
						previousEffectivePriority: 'urgent',
						newEffectivePriority: 'medium',
						overrideRevoked: null
					}
				};

				const desc1 = describeHistoryEvent(entryImpactOnly, [adminUser], categories);
				// No debe repetir "de Aplicaciones a Aplicaciones"
				assert.ok(!desc1.includes('Aplicaciones a Aplicaciones'));
				assert.match(desc1, /impacto de I4 a I1/i);
				assert.match(desc1, /prioridad calculada: Media/i);

				// Caso con cambio de categoría y subcategoría
				const entryCategoryChange = {
					id: 'hist-reclass-02',
					incidentId: 25,
					organizationId: orgId,
					actorUserId: techUser.id,
					eventType: 'reclassified',
					timestamp: '2026-09-16T20:05:00.000Z',
					reason: 'Era fallo de red',
					previousValue: null,
					newValue: {
						previousCategoryId: 'cat-apps',
						newCategoryId: 'cat-infra',
						previousSubcategoryId: 'sub-erp',
						newSubcategoryId: 'sub-vpn',
						previousImpact: 'I2',
						newImpact: 'I3',
						previousCalculatedPriority: 'medium',
						newCalculatedPriority: 'high',
						previousEffectivePriority: 'medium',
						newEffectivePriority: 'high',
						overrideRevoked: null
					}
				};

				const desc2 = describeHistoryEvent(entryCategoryChange, [techUser], categories);
				assert.match(desc2, /categoría de Aplicaciones a Infraestructura/i);
				assert.match(desc2, /subcategoría de sub-erp a sub-vpn/i);
				assert.match(desc2, /impacto de I2 a I3/i);
				assert.match(desc2, /prioridad calculada: Alta/i);

				// Caso con revocación de override
				const entryOverrideRevoked = {
					id: 'hist-reclass-03',
					incidentId: 26,
					organizationId: orgId,
					actorUserId: adminUser.id,
					eventType: 'reclassified',
					timestamp: '2026-09-16T20:10:00.000Z',
					reason: 'Reclasificación que revoca excepción',
					previousValue: null,
					newValue: {
						previousCategoryId: 'cat-apps',
						newCategoryId: 'cat-apps',
						previousSubcategoryId: 'sub-erp',
						newSubcategoryId: 'sub-erp',
						previousImpact: 'I4',
						newImpact: 'I1',
						previousCalculatedPriority: 'urgent',
						newCalculatedPriority: 'medium',
						previousEffectivePriority: 'urgent',
						newEffectivePriority: 'medium',
						overrideRevoked: {
							previousTargetPriority: 'urgent',
							previousReason: 'Excepción previa',
							previousAuthorizedBy: adminUser.id
						}
					}
				};

				const desc3 = describeHistoryEvent(entryOverrideRevoked, [adminUser], categories);
				assert.match(desc3, /impacto de I4 a I1/i);
				assert.match(desc3, /anulando el override previo \(Urgente\)/i);
				assert.match(desc3, /restableciendo la prioridad calculada Media/i);
			}
		);

		await suite.test(
			'16. Verificación de clases CSS de contraste y reequilibrio de grid en theme.css',
			() => {
				const css = readFileSync('src/routes/app/theme.css', 'utf-8');

				// Clases de prioridad
				assert.ok(css.includes('.badge-priority-urgent'));
				assert.ok(css.includes('.badge-priority-high'));
				assert.ok(css.includes('.badge-priority-medium'));
				assert.ok(css.includes('.badge-priority-low'));

				// Light theme overrides para prioridad
				assert.ok(css.includes("html[data-app-theme='light'] .support-app .badge-priority-urgent"));
				assert.ok(css.includes("html[data-app-theme='light'] .support-app .badge-priority-high"));

				// Texto de prioridad en tabla
				assert.ok(css.includes('.text-priority-urgent'));
				assert.ok(css.includes("html[data-app-theme='light'] .support-app .text-priority-urgent"));

				// Controles de override y reclasificación
				assert.ok(css.includes('.badge-override-active'));
				assert.ok(css.includes('.badge-override-table'));
				assert.ok(css.includes('.box-override-detail'));
				assert.ok(css.includes('.btn-override-action'));
				assert.ok(css.includes('.btn-reclassify-action'));
				assert.ok(css.includes("html[data-app-theme='light'] .support-app .btn-reclassify-action"));
				assert.ok(css.includes('.tab-override-remove-active'));
				assert.ok(css.includes('.box-override-remove-notice'));
				assert.ok(css.includes('.btn-override-remove-submit'));

				// Reequilibrio del grid desktop
				assert.ok(css.includes('grid-template-columns: minmax(0, 1.2fr) minmax(18rem, 1fr)'));

				// Reglas de ajuste para evitar división de palabras en categorías
				assert.ok(css.includes('.support-app .incident-list .incident-category'));
				assert.ok(css.includes('overflow-wrap: normal'));
				assert.ok(css.includes('word-break: normal'));
			}
		);
	} finally {
		await server.close();
	}
});

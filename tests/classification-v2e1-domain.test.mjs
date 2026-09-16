import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('Clasificación V2E.1 — Dominio, Permisos, Historial y Auditoría', async (suite) => {
	const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
	try {
		const { hasPermission } = await server.ssrLoadModule('/src/lib/auth/permissions.ts');
		const { canActOnIncident } = await server.ssrLoadModule('/src/lib/auth/record-access.ts');
		const { isIncidentHistory } = await server.ssrLoadModule('/src/lib/incidents/history.ts');
		const { describeHistoryEvent } = await server.ssrLoadModule('/src/lib/incidents/timeline.ts');
		const { reclassifyIncident, applyPriorityOverride, removePriorityOverride } =
			await server.ssrLoadModule('/src/lib/incidents/lifecycle.ts');
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
			},
			{
				id: 'cat-inactive',
				name: 'Categoría Inactiva',
				organizationId: orgId,
				active: false
			},
			{
				id: 'cat-other',
				name: 'Categoría Otra Org',
				organizationId: otherOrgId,
				active: true
			}
		];

		const subcategories = [
			{
				id: 'sub-erp',
				organizationId: orgId,
				categoryId: 'cat-apps',
				name: 'ERP',
				baseCriticality: 'high',
				minPriority: null,
				active: true
			},
			{
				id: 'sub-email',
				organizationId: orgId,
				categoryId: 'cat-apps',
				name: 'Correo',
				baseCriticality: 'medium',
				minPriority: null,
				active: true
			},
			{
				id: 'sub-vpn',
				organizationId: orgId,
				categoryId: 'cat-infra',
				name: 'VPN',
				baseCriticality: 'low',
				minPriority: null,
				active: true
			},
			{
				id: 'sub-inactive',
				organizationId: orgId,
				categoryId: 'cat-apps',
				name: 'Subcat Inactiva',
				baseCriticality: 'medium',
				minPriority: null,
				active: false
			},
			{
				id: 'sub-other',
				organizationId: otherOrgId,
				categoryId: 'cat-other',
				name: 'Subcat Otra Org',
				baseCriticality: 'high',
				minPriority: null,
				active: true
			}
		];

		const matrices = [createStandardPriorityMatrix(orgId)];

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

		const platformAdmin = {
			id: 'usr-platform-01',
			name: 'Super Admin',
			role: 'platform_admin',
			active: true
		};

		function createBaseV2Incident(overrides = {}) {
			return {
				id: 204,
				organizationId: orgId,
				createdByUserId: clientUser.id,
				title: 'Fallo acceso ERP',
				client: 'Cliente Demo',
				description: 'No puedo acceder al ERP desde la sede central.',
				status: 'open',
				priority: 'urgent',
				createdAt: '2026-09-16T10:00:00.000Z',
				categoryId: 'cat-apps',
				subcategoryId: 'sub-erp',
				supportLevel: 'N2',
				teamId: 'team-apps',
				assignedToUserId: techUser.id,
				sla: {
					policyId: 'sla-apps-urgent',
					policyName: 'SLA Apps Urgente',
					firstResponseMinutes: 60,
					resolutionMinutes: 240,
					firstResponseDueAt: '2026-09-16T11:00:00.000Z',
					resolutionDueAt: '2026-09-16T14:00:00.000Z',
					firstRespondedAt: null,
					resolvedAt: null
				},
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
				...overrides
			};
		}

		await suite.test(
			'1. Permisos granulares de clasificación y override por rol y organización',
			() => {
				assert.equal(hasPermission(adminUser, 'incidents:classify'), true);
				assert.equal(hasPermission(adminUser, 'incidents:override_priority'), true);

				assert.equal(hasPermission(techUser, 'incidents:classify'), true);
				assert.equal(hasPermission(techUser, 'incidents:override_priority'), false);

				assert.equal(hasPermission(clientUser, 'incidents:classify'), false);
				assert.equal(hasPermission(clientUser, 'incidents:override_priority'), false);

				assert.equal(hasPermission(platformAdmin, 'incidents:classify'), true);
				assert.equal(hasPermission(platformAdmin, 'incidents:override_priority'), true);

				const incident = createBaseV2Incident();
				assert.equal(canActOnIncident(techUser, incident, 'incidents:classify'), true);
				assert.equal(canActOnIncident(techUser, incident, 'incidents:override_priority'), false);
				assert.equal(canActOnIncident(otherOrgAdmin, incident, 'incidents:classify'), false);
				assert.equal(
					canActOnIncident(otherOrgAdmin, incident, 'incidents:override_priority'),
					false
				);
			}
		);

		await suite.test('2. Restricción estricta de estados operativos: solo open y pending', () => {
			const incidentResolved = createBaseV2Incident({ status: 'resolved' });
			const incidentClosed = createBaseV2Incident({ status: 'closed' });

			const resReclassResolved = reclassifyIncident({
				incident: incidentResolved,
				actorUser: adminUser,
				newCategoryId: 'cat-apps',
				newSubcategoryId: 'sub-email',
				newImpact: 'I2',
				reason: 'Causa raíz en correo',
				categoryList: categories,
				subcategories,
				priorityMatrices: matrices
			});
			assert.equal(resReclassResolved.ok, false);
			assert.match(resReclassResolved.error, /resuelta/i);

			const resReclassClosed = reclassifyIncident({
				incident: incidentClosed,
				actorUser: adminUser,
				newCategoryId: 'cat-apps',
				newSubcategoryId: 'sub-email',
				newImpact: 'I2',
				reason: 'Ajuste posterior',
				categoryList: categories,
				subcategories,
				priorityMatrices: matrices
			});
			assert.equal(resReclassClosed.ok, false);
			assert.match(resReclassClosed.error, /cerrada/i);

			const resOverrideResolved = applyPriorityOverride({
				incident: incidentResolved,
				actorUser: adminUser,
				targetPriority: 'high',
				reason: 'Excepción de prioridad'
			});
			assert.equal(resOverrideResolved.ok, false);
			assert.match(resOverrideResolved.error, /resuelta/i);

			const resOverrideClosed = applyPriorityOverride({
				incident: incidentClosed,
				actorUser: adminUser,
				targetPriority: 'high',
				reason: 'Excepción de prioridad'
			});
			assert.equal(resOverrideClosed.ok, false);
			assert.match(resOverrideClosed.error, /cerrada/i);
		});

		await suite.test(
			'3. Reclasificación formal válida recalcula prioridad determinista y audita evento',
			() => {
				const incident = createBaseV2Incident(); // high + I4 = critical (urgent)
				const res = reclassifyIncident({
					incident,
					actorUser: techUser,
					newCategoryId: 'cat-apps',
					newSubcategoryId: 'sub-email', // medium
					newImpact: 'I3', // medium + I3 = medium (operational: medium)
					reason: 'El cliente reporta que solo afecta al buzón de su departamento.',
					categoryList: categories,
					subcategories,
					priorityMatrices: matrices
				});

				assert.equal(res.ok, true);
				if (!res.ok) return;

				assert.equal(res.incident.categoryId, 'cat-apps');
				assert.equal(res.incident.subcategoryId, 'sub-email');
				assert.equal(res.incident.classification.impactLevel, 'I3');
				assert.equal(res.incident.classification.calculatedPriority, 'medium');
				assert.equal(res.incident.classification.effectivePriority, 'medium');
				assert.equal(res.incident.classification.hasOverride, false);
				assert.equal(res.incident.priority, 'medium');

				assert.equal(res.historyEntry.eventType, 'reclassified');
				assert.equal(res.historyEntry.actorUserId, techUser.id);
				assert.equal(
					res.historyEntry.reason,
					'El cliente reporta que solo afecta al buzón de su departamento.'
				);
				assert.equal(res.historyEntry.newValue.previousCategoryId, 'cat-apps');
				assert.equal(res.historyEntry.newValue.newCategoryId, 'cat-apps');
				assert.equal(res.historyEntry.newValue.previousSubcategoryId, 'sub-erp');
				assert.equal(res.historyEntry.newValue.newSubcategoryId, 'sub-email');
				assert.equal(res.historyEntry.newValue.previousImpact, 'I4');
				assert.equal(res.historyEntry.newValue.newImpact, 'I3');
				assert.equal(res.historyEntry.newValue.previousCalculatedPriority, 'urgent');
				assert.equal(res.historyEntry.newValue.newCalculatedPriority, 'medium');
				assert.equal(res.historyEntry.newValue.previousEffectivePriority, 'urgent');
				assert.equal(res.historyEntry.newValue.newEffectivePriority, 'medium');
				assert.equal(res.historyEntry.newValue.overrideRevoked, null);

				assert.equal(isIncidentHistory([res.historyEntry]), true);
			}
		);

		await suite.test('4. Rechazo de reclasificación sin cambios reales', () => {
			const incidentWithOverride = createBaseV2Incident({
				priority: 'urgent',
				classification: {
					baseCriticality: 'high',
					impactLevel: 'I4',
					matrixPriority: 'critical',
					minPriority: null,
					minPriorityApplied: false,
					calculatedPriority: 'critical',
					effectivePriority: 'critical',
					hasOverride: true,
					overrideReason: 'Override anterior',
					overrideAuthorizedBy: 'usr-admin-01'
				}
			});

			const res = reclassifyIncident({
				incident: incidentWithOverride,
				actorUser: techUser,
				newCategoryId: 'cat-apps',
				newSubcategoryId: 'sub-erp',
				newImpact: 'I4',
				reason: 'Guardar sin hacer cambios',
				categoryList: categories,
				subcategories,
				priorityMatrices: matrices
			});

			assert.equal(res.ok, false);
			assert.equal(res.error, 'No se han detectado cambios en la clasificación de la incidencia.');
			assert.equal(incidentWithOverride.classification.hasOverride, true);
			assert.equal(incidentWithOverride.priority, 'urgent');
		});

		await suite.test(
			'5. Retirada automática de override al reclasificar y auditoría con previousAuthorizedBy',
			() => {
				const incidentWithOverride = createBaseV2Incident({
					priority: 'urgent',
					classification: {
						baseCriticality: 'low',
						impactLevel: 'I1',
						matrixPriority: 'low',
						minPriority: null,
						minPriorityApplied: false,
						calculatedPriority: 'low',
						effectivePriority: 'critical',
						hasOverride: true,
						overrideReason: 'Petición de dirección general',
						overrideAuthorizedBy: adminUser.id
					}
				});

				const res = reclassifyIncident({
					incident: incidentWithOverride,
					actorUser: techUser,
					newCategoryId: 'cat-apps',
					newSubcategoryId: 'sub-email', // medium
					newImpact: 'I4', // medium + I4 = high
					reason: 'Reclasificación a correo departamental completo',
					categoryList: categories,
					subcategories,
					priorityMatrices: matrices
				});

				assert.equal(res.ok, true);
				if (!res.ok) return;

				assert.equal(res.incident.classification.hasOverride, false);
				assert.equal(res.incident.classification.calculatedPriority, 'high');
				assert.equal(res.incident.classification.effectivePriority, 'high');
				assert.equal(res.incident.priority, 'high');

				assert.deepEqual(res.historyEntry.newValue.overrideRevoked, {
					previousTargetPriority: 'urgent',
					previousReason: 'Petición de dirección general',
					previousAuthorizedBy: adminUser.id
				});
				assert.equal(isIncidentHistory([res.historyEntry]), true);

				const formatted = describeHistoryEvent(res.historyEntry, [adminUser, techUser], categories);
				assert.match(formatted, /anulando el override previo/i);
				assert.match(formatted, /Urgente/i);
			}
		);

		await suite.test('6. Reclasificación inválida rechazada sin mutaciones', () => {
			const incident = createBaseV2Incident();
			const originalCopy = JSON.parse(JSON.stringify(incident));

			// Categoría inactiva
			const resCatInact = reclassifyIncident({
				incident,
				actorUser: techUser,
				newCategoryId: 'cat-inactive',
				newSubcategoryId: 'sub-erp',
				newImpact: 'I2',
				reason: 'Motivo válido',
				categoryList: categories,
				subcategories,
				priorityMatrices: matrices
			});
			assert.equal(resCatInact.ok, false);
			assert.match(resCatInact.error, /inactiva/i);

			// Subcategoría de otra categoría
			const resSubWrongCat = reclassifyIncident({
				incident,
				actorUser: techUser,
				newCategoryId: 'cat-infra',
				newSubcategoryId: 'sub-erp', // ERP es de cat-apps
				newImpact: 'I2',
				reason: 'Motivo válido',
				categoryList: categories,
				subcategories,
				priorityMatrices: matrices
			});
			assert.equal(resSubWrongCat.ok, false);
			assert.match(resSubWrongCat.error, /no pertenece a la categoría/i);

			// Subcategoría de otra organización
			const resOtherOrg = reclassifyIncident({
				incident,
				actorUser: techUser,
				newCategoryId: 'cat-apps',
				newSubcategoryId: 'sub-other',
				newImpact: 'I2',
				reason: 'Motivo válido',
				categoryList: categories,
				subcategories,
				priorityMatrices: matrices
			});
			assert.equal(resOtherOrg.ok, false);
			assert.match(resOtherOrg.error, /no pertenece a la organización/i);

			// Matriz corrupta
			const corruptMatrices = [{ organizationId: orgId, matrix: 'corrupt' }];
			const resCorrupt = reclassifyIncident({
				incident,
				actorUser: techUser,
				newCategoryId: 'cat-apps',
				newSubcategoryId: 'sub-email',
				newImpact: 'I2',
				reason: 'Motivo válido',
				categoryList: categories,
				subcategories,
				priorityMatrices: corruptMatrices
			});
			assert.equal(resCorrupt.ok, false);

			// Asegurar que incident no fue mutado
			assert.deepEqual(incident, originalCopy);
		});

		await suite.test('7. Aplicación, modificación y retirada de override de prioridad', () => {
			const incident = createBaseV2Incident({
				priority: 'low',
				classification: {
					baseCriticality: 'low',
					impactLevel: 'I1',
					matrixPriority: 'low',
					minPriority: null,
					minPriorityApplied: false,
					calculatedPriority: 'low',
					effectivePriority: 'low',
					hasOverride: false
				}
			});

			// 7a. Aplicar override
			const resApply = applyPriorityOverride({
				incident,
				actorUser: adminUser,
				targetPriority: 'urgent',
				reason: 'Cliente VIP requiere atención inmediata'
			});
			assert.equal(resApply.ok, true);
			if (!resApply.ok) return;

			assert.equal(resApply.incident.priority, 'urgent');
			assert.equal(resApply.incident.classification.hasOverride, true);
			assert.equal(resApply.incident.classification.calculatedPriority, 'low');
			assert.equal(resApply.incident.classification.effectivePriority, 'critical');
			assert.equal(
				resApply.incident.classification.overrideReason,
				'Cliente VIP requiere atención inmediata'
			);
			assert.equal(resApply.incident.classification.overrideAuthorizedBy, adminUser.id);
			assert.equal(resApply.historyEntry.eventType, 'priority_override_applied');
			assert.equal(resApply.historyEntry.newValue.calculatedPriority, 'low');
			assert.equal(resApply.historyEntry.newValue.previousEffectivePriority, 'low');
			assert.equal(resApply.historyEntry.newValue.newEffectivePriority, 'urgent');
			assert.equal(isIncidentHistory([resApply.historyEntry]), true);

			// 7b. Modificar override existente
			const resMod = applyPriorityOverride({
				incident: resApply.incident,
				actorUser: platformAdmin,
				targetPriority: 'high',
				reason: 'Reajuste acordado con soporte'
			});
			assert.equal(resMod.ok, true);
			if (!resMod.ok) return;

			assert.equal(resMod.incident.priority, 'high');
			assert.equal(resMod.incident.classification.hasOverride, true);
			assert.equal(resMod.incident.classification.calculatedPriority, 'low');
			assert.equal(resMod.incident.classification.effectivePriority, 'high');
			assert.equal(resMod.incident.classification.overrideAuthorizedBy, platformAdmin.id);
			assert.equal(resMod.historyEntry.eventType, 'priority_override_modified');
			assert.equal(resMod.historyEntry.newValue.previousEffectivePriority, 'urgent');
			assert.equal(resMod.historyEntry.newValue.newEffectivePriority, 'high');
			assert.equal(isIncidentHistory([resMod.historyEntry]), true);

			// 7c. Retirar override y restablecer prioridad calculada base
			const resRemove = removePriorityOverride({
				incident: resMod.incident,
				actorUser: adminUser,
				reason: 'Incidencia normalizada, se restablece prioridad base'
			});
			assert.equal(resRemove.ok, true);
			if (!resRemove.ok) return;

			assert.equal(resRemove.incident.priority, 'low');
			assert.equal(resRemove.incident.classification.hasOverride, false);
			assert.equal(resRemove.incident.classification.calculatedPriority, 'low');
			assert.equal(resRemove.incident.classification.effectivePriority, 'low');
			assert.equal(resRemove.incident.classification.overrideReason, undefined);
			assert.equal(resRemove.incident.classification.overrideAuthorizedBy, undefined);
			assert.equal(resRemove.historyEntry.eventType, 'priority_override_removed');
			assert.equal(resRemove.historyEntry.newValue.calculatedPriority, 'low');
			assert.equal(resRemove.historyEntry.newValue.newEffectivePriority, 'low');
			assert.equal(isIncidentHistory([resRemove.historyEntry]), true);
		});

		await suite.test('8. Validación unificada del motivo: string no vacío tras trim', () => {
			const incident = createBaseV2Incident();

			const resEmpty = reclassifyIncident({
				incident,
				actorUser: techUser,
				newCategoryId: 'cat-apps',
				newSubcategoryId: 'sub-email',
				newImpact: 'I2',
				reason: '   ',
				categoryList: categories,
				subcategories,
				priorityMatrices: matrices
			});
			assert.equal(resEmpty.ok, false);
			assert.match(resEmpty.error, /motivo.*obligatorio/i);

			const resShortValid = reclassifyIncident({
				incident,
				actorUser: techUser,
				newCategoryId: 'cat-apps',
				newSubcategoryId: 'sub-email',
				newImpact: 'I2',
				reason: 'OK', // 2 caracteres, no vacío tras trim
				categoryList: categories,
				subcategories,
				priorityMatrices: matrices
			});
			assert.equal(resShortValid.ok, true);
		});

		await suite.test(
			'9. Catálogo histórico: retirar override no se bloquea si subcategoría fue desactivada',
			() => {
				const incidentHistorical = createBaseV2Incident({
					subcategoryId: 'sub-inactive', // Subcat inactiva en catálogo actual
					priority: 'urgent',
					classification: {
						baseCriticality: 'medium',
						impactLevel: 'I2',
						matrixPriority: 'low',
						minPriority: null,
						minPriorityApplied: false,
						calculatedPriority: 'low',
						effectivePriority: 'critical',
						hasOverride: true,
						overrideReason: 'Override histórico',
						overrideAuthorizedBy: 'usr-admin-01'
					}
				});

				const res = removePriorityOverride({
					incident: incidentHistorical,
					actorUser: adminUser,
					reason: 'Retirar override aunque la subcategoría fuera dada de baja'
				});

				assert.equal(res.ok, true);
				if (!res.ok) return;
				assert.equal(res.incident.priority, 'low');
				assert.equal(res.incident.classification.hasOverride, false);
			}
		);

		await suite.test('10. Garantía inviolable: SLA y plazos permanecen 100% inmutables', () => {
			const incident = createBaseV2Incident();
			const originalSlaCopy = JSON.parse(JSON.stringify(incident.sla));

			// Reclasificación
			const resReclass = reclassifyIncident({
				incident,
				actorUser: techUser,
				newCategoryId: 'cat-apps',
				newSubcategoryId: 'sub-email',
				newImpact: 'I1',
				reason: 'Baja a impacto individual',
				categoryList: categories,
				subcategories,
				priorityMatrices: matrices
			});
			assert.equal(resReclass.ok, true);
			if (resReclass.ok) {
				assert.deepEqual(resReclass.incident.sla, originalSlaCopy);
			}

			// Override
			const resOverride = applyPriorityOverride({
				incident,
				actorUser: adminUser,
				targetPriority: 'low',
				reason: 'Degradación temporal'
			});
			assert.equal(resOverride.ok, true);
			if (resOverride.ok) {
				assert.deepEqual(resOverride.incident.sla, originalSlaCopy);
			}
		});

		await suite.test(
			'11. Garantía inviolable: Routing operativo (técnico, equipo, nivel) permanece inmutable',
			() => {
				const incident = createBaseV2Incident({
					supportLevel: 'N2',
					teamId: 'team-apps',
					assignedToUserId: techUser.id
				});

				// Reclasificar a cat-infra (que tiene defaults N1 y team-infra)
				const res = reclassifyIncident({
					incident,
					actorUser: techUser,
					newCategoryId: 'cat-infra',
					newSubcategoryId: 'sub-vpn',
					newImpact: 'I2',
					reason: 'Problema enrutado pero atendido por técnico actual',
					categoryList: categories,
					subcategories,
					priorityMatrices: matrices
				});

				assert.equal(res.ok, true);
				if (!res.ok) return;

				assert.equal(res.incident.supportLevel, 'N2');
				assert.equal(res.incident.teamId, 'team-apps');
				assert.equal(res.incident.assignedToUserId, techUser.id);
			}
		);

		await suite.test(
			'12. Compatibilidad: Incidencias V1 rechazan reclasificación y override V2',
			() => {
				const incidentV1 = {
					id: 101,
					organizationId: orgId,
					title: 'Incidencia V1 legacy',
					client: 'Cliente V1',
					status: 'open',
					priority: 'medium',
					createdAt: '2026-08-01T10:00:00.000Z',
					classification: undefined
				};

				const resReclass = reclassifyIncident({
					incident: incidentV1,
					actorUser: adminUser,
					newCategoryId: 'cat-apps',
					newSubcategoryId: 'sub-email',
					newImpact: 'I2',
					reason: 'Intentar clasificar V1',
					categoryList: categories,
					subcategories,
					priorityMatrices: matrices
				});
				assert.equal(resReclass.ok, false);
				assert.match(resReclass.error, /V2/i);

				const resOverride = applyPriorityOverride({
					incident: incidentV1,
					actorUser: adminUser,
					targetPriority: 'high',
					reason: 'Intentar override V1'
				});
				assert.equal(resOverride.ok, false);
				assert.match(resOverride.error, /V2/i);
			}
		);
	} finally {
		await server.close();
	}
});

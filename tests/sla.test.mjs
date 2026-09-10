import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('Motor de SLA v1: políticas, precedencia, snapshots y evaluación dinámica', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });
	try {
		const {
			matchSlaPolicy,
			createSlaSnapshot,
			calculateSlaDeadline,
			evaluateIncidentSla,
			hasMultipleActiveDefaults,
			isSlaPolicyList
		} = await server.ssrLoadModule('/src/lib/incidents/sla.ts');
		const { isIncidentList } = await server.ssrLoadModule('/src/lib/incidents/validation.ts');
		const { prepareAssignment } = await server.ssrLoadModule('/src/lib/incidents/assignment.ts');
		const { prepareEscalation } = await server.ssrLoadModule('/src/lib/incidents/escalation.ts');
		const { demoUsers } = await server.ssrLoadModule('/src/lib/data/users.ts');
		const { demoSupportTeams } = await server.ssrLoadModule('/src/lib/data/teams.ts');

		const orgId = 'org-nodhouses';
		const foreignOrgId = 'org-other';

		const fallbackPolicy = {
			id: 'sla-default',
			organizationId: orgId,
			name: 'SLA Fallback Estándar',
			active: true,
			isDefault: true,
			categoryId: null,
			priority: null,
			firstResponseMinutes: 240, // 4h
			resolutionMinutes: 1440, // 24h
			createdAt: '2026-09-01T08:00:00.000Z'
		};

		const priorityHighPolicy = {
			id: 'sla-priority-high',
			organizationId: orgId,
			name: 'SLA Prioridad Alta',
			active: true,
			isDefault: false,
			categoryId: null,
			priority: 'high',
			firstResponseMinutes: 60, // 1h
			resolutionMinutes: 480, // 8h
			createdAt: '2026-09-01T08:05:00.000Z'
		};

		const categoryNetworkPolicy = {
			id: 'sla-cat-network',
			organizationId: orgId,
			name: 'SLA Categoría Redes',
			active: true,
			isDefault: false,
			categoryId: 'network',
			priority: null,
			firstResponseMinutes: 120, // 2h
			resolutionMinutes: 720, // 12h
			createdAt: '2026-09-01T08:10:00.000Z'
		};

		const categoryPriorityPolicy = {
			id: 'sla-cat-network-priority-high',
			organizationId: orgId,
			name: 'SLA Redes Alta Prioridad',
			active: true,
			isDefault: false,
			categoryId: 'network',
			priority: 'high',
			firstResponseMinutes: 30, // 30m
			resolutionMinutes: 240, // 4h
			createdAt: '2026-09-01T08:15:00.000Z'
		};

		const foreignPolicy = {
			id: 'sla-foreign',
			organizationId: foreignOrgId,
			name: 'SLA Otra Organización',
			active: true,
			isDefault: true,
			categoryId: 'network',
			priority: 'high',
			firstResponseMinutes: 10,
			resolutionMinutes: 60,
			createdAt: '2026-09-01T08:00:00.000Z'
		};

		const baseIncident = {
			id: 100,
			organizationId: orgId,
			title: 'Corte de conexión troncal',
			client: 'Cliente Demo',
			status: 'open',
			priority: 'high',
			categoryId: 'network',
			createdAt: '2026-09-10T08:00:00.000Z'
		};

		await t.test('Precedencia: Categoría + Prioridad gana sobre las demás', () => {
			const allPolicies = [
				fallbackPolicy,
				priorityHighPolicy,
				categoryNetworkPolicy,
				categoryPriorityPolicy
			];
			const selected = matchSlaPolicy(baseIncident, allPolicies);
			assert.equal(selected?.id, 'sla-cat-network-priority-high');
		});

		await t.test('Precedencia: Categoría sola gana sobre Prioridad y Fallback', () => {
			const policies = [fallbackPolicy, priorityHighPolicy, categoryNetworkPolicy];
			const selected = matchSlaPolicy(baseIncident, policies);
			assert.equal(selected?.id, 'sla-cat-network');
		});

		await t.test('Precedencia: Prioridad sola gana sobre Fallback', () => {
			const policies = [fallbackPolicy, priorityHighPolicy];
			const selected = matchSlaPolicy(baseIncident, policies);
			assert.equal(selected?.id, 'sla-priority-high');
		});

		await t.test('Fallback funciona cuando no hay coincidencias específicas', () => {
			const ticket = {
				...baseIncident,
				priority: 'low',
				categoryId: 'software'
			};
			const policies = [
				fallbackPolicy,
				priorityHighPolicy,
				categoryNetworkPolicy,
				categoryPriorityPolicy
			];
			const selected = matchSlaPolicy(ticket, policies);
			assert.equal(selected?.id, 'sla-default');
		});

		await t.test('Aislamiento por organización: políticas de otra empresa se ignoran', () => {
			const selected = matchSlaPolicy(baseIncident, [foreignPolicy]);
			assert.equal(selected, null);
		});

		await t.test('Política inactiva no se aplica aunque coincida exactamente', () => {
			const inactive = { ...categoryPriorityPolicy, active: false };
			const selected = matchSlaPolicy(baseIncident, [inactive, fallbackPolicy]);
			assert.equal(selected?.id, 'sla-default');
		});

		await t.test('Comportamiento cuando no existe fallback ni coincidencia: devuelve null', () => {
			const ticket = { ...baseIncident, categoryId: 'other', priority: 'low' };
			const selected = matchSlaPolicy(ticket, [categoryPriorityPolicy]);
			assert.equal(selected, null);
		});

		await t.test(
			'Regla funcional: detección y desempate determinista defensivo ante múltiples defaults',
			() => {
				const default2 = {
					...fallbackPolicy,
					id: 'sla-default-secondary',
					name: 'Segundo Fallback Inconsistente',
					createdAt: '2026-09-02T08:00:00.000Z'
				};
				const ticket = { ...baseIncident, categoryId: 'other', priority: 'low' };

				assert.equal(hasMultipleActiveDefaults([fallbackPolicy, default2], orgId), true);
				assert.equal(hasMultipleActiveDefaults([fallbackPolicy], orgId), false);

				// Defensive tie-breaker picks oldest createdAt
				const selected = matchSlaPolicy(ticket, [default2, fallbackPolicy]);
				assert.equal(selected?.id, 'sla-default');
			}
		);

		await t.test('Cálculo exacto de deadlines a partir de createdAt', () => {
			const deadline = calculateSlaDeadline('2026-09-10T10:00:00.000Z', 120);
			assert.equal(deadline, '2026-09-10T12:00:00.000Z');

			// Compatible with YYYY-MM-DD
			const dateOnlyDeadline = calculateSlaDeadline('2026-09-10', 60);
			assert.equal(dateOnlyDeadline, '2026-09-10T01:00:00.000Z');
		});

		await t.test('calculateSlaDeadline falla explícitamente ante baseTimestamp inválido', () => {
			assert.throws(
				() => calculateSlaDeadline('fecha-invalida', 60),
				/Fecha base inválida para el cálculo de SLA/
			);
			assert.throws(() => calculateSlaDeadline('', 60), /Fecha base inválida/);
			assert.throws(() => calculateSlaDeadline('not-a-date', 120), /Fecha base inválida/);
		});

		await t.test('Políticas isDefault son exclusivamente fallback', () => {
			// Un default con criterios específicos definidos NO gana en niveles 1, 2 o 3
			const defaultWithCriteria = {
				...fallbackPolicy,
				id: 'sla-default-with-criteria',
				isDefault: true,
				categoryId: 'network',
				priority: 'high',
				firstResponseMinutes: 5,
				resolutionMinutes: 10
			};
			// Debe ganar la regla específica no-default, no la default
			const selected = matchSlaPolicy(baseIncident, [defaultWithCriteria, categoryPriorityPolicy]);
			assert.equal(selected?.id, 'sla-cat-network-priority-high');

			// Y si solo compite el default con criterios, no coincide en nivel 1, 2 ni 3, solo como fallback (nivel 4)
			const selectedAlone = matchSlaPolicy(baseIncident, [defaultWithCriteria]);
			assert.equal(selectedAlone?.id, 'sla-default-with-criteria');

			// Fallback normal sigue funcionando cuando no hay reglas específicas
			const ticket = { ...baseIncident, categoryId: 'other', priority: 'low' };
			const selectedFallback = matchSlaPolicy(ticket, [fallbackPolicy]);
			assert.equal(selectedFallback?.id, 'sla-default');
		});

		await t.test(
			'createSlaSnapshot congela compromisos e inicializa firstRespondedAt y resolvedAt en null',
			() => {
				const snapshot = createSlaSnapshot(baseIncident, categoryPriorityPolicy);
				assert.equal(snapshot.policyId, categoryPriorityPolicy.id);
				assert.equal(snapshot.policyName, categoryPriorityPolicy.name);
				assert.equal(snapshot.firstResponseMinutes, 30);
				assert.equal(snapshot.resolutionMinutes, 240);
				assert.equal(snapshot.firstResponseDueAt, '2026-09-10T08:30:00.000Z');
				assert.equal(snapshot.resolutionDueAt, '2026-09-10T12:00:00.000Z');
				assert.equal(snapshot.firstRespondedAt, null);
				assert.equal(snapshot.resolvedAt, null);
			}
		);

		await t.test(
			'Inmutabilidad: mutar la política en catálogo no altera el snapshot de la incidencia',
			() => {
				const incidentWithSla = {
					...baseIncident,
					sla: createSlaSnapshot(baseIncident, categoryPriorityPolicy)
				};

				// Mutate original policy
				const mutatedPolicy = {
					...categoryPriorityPolicy,
					firstResponseMinutes: 999,
					name: 'Nombre Cambiado'
				};

				assert.equal(incidentWithSla.sla?.firstResponseMinutes, 30);
				assert.equal(incidentWithSla.sla?.policyName, 'SLA Redes Alta Prioridad');
				assert.notEqual(
					incidentWithSla.sla?.firstResponseMinutes,
					mutatedPolicy.firstResponseMinutes
				);
			}
		);

		await t.test(
			'Evaluación dinámica en tiempo real: on_track, approaching, breached con fecha determinista',
			() => {
				const incidentWithSla = {
					...baseIncident,
					sla: createSlaSnapshot(baseIncident, categoryPriorityPolicy)
					// firstResponseDueAt = 08:30:00, resolutionDueAt = 12:00:00
				};

				// At 08:10:00 (20 min left for response, threshold is 15 min -> on_track)
				const eval1 = evaluateIncidentSla(incidentWithSla, '2026-09-10T08:10:00.000Z', {
					warningThresholdMinutes: 15
				});
				assert.equal(eval1.status, 'on_track');
				assert.equal(eval1.firstResponse.stage, 'on_track');
				assert.equal(eval1.firstResponse.remainingMinutes, 20);
				assert.equal(eval1.resolution.stage, 'on_track');

				// At 08:20:00 (10 min left for response -> approaching)
				const eval2 = evaluateIncidentSla(incidentWithSla, '2026-09-10T08:20:00.000Z', {
					warningThresholdMinutes: 15
				});
				assert.equal(eval2.status, 'approaching');
				assert.equal(eval2.firstResponse.stage, 'approaching');
				assert.equal(eval2.firstResponse.remainingMinutes, 10);

				// At 08:35:00 (due was 08:30:00 -> response breached)
				const eval3 = evaluateIncidentSla(incidentWithSla, '2026-09-10T08:35:00.000Z');
				assert.equal(eval3.status, 'breached');
				assert.equal(eval3.firstResponse.stage, 'breached');
				assert.equal(eval3.firstResponse.remainingMinutes, -5);
				assert.equal(eval3.resolution.stage, 'on_track');
			}
		);

		await t.test('Cumplimiento de objetivos: firstRespondedAt y resolvedAt', () => {
			const incidentResponded = {
				...baseIncident,
				sla: {
					...createSlaSnapshot(baseIncident, categoryPriorityPolicy),
					firstRespondedAt: '2026-09-10T08:25:00.000Z', // In time (due 08:30)
					resolvedAt: '2026-09-10T11:50:00.000Z' // In time (due 12:00)
				},
				status: 'resolved'
			};

			const evalFulfilled = evaluateIncidentSla(incidentResponded, '2026-09-10T14:00:00.000Z');
			assert.equal(evalFulfilled.status, 'fulfilled');
			assert.equal(evalFulfilled.firstResponse.stage, 'fulfilled_within_sla');
			assert.equal(evalFulfilled.resolution.stage, 'fulfilled_within_sla');

			// Response after deadline
			const incidentLateResponse = {
				...baseIncident,
				sla: {
					...createSlaSnapshot(baseIncident, categoryPriorityPolicy),
					firstRespondedAt: '2026-09-10T08:45:00.000Z' // Late (due 08:30)
				}
			};
			const evalLate = evaluateIncidentSla(incidentLateResponse, '2026-09-10T09:00:00.000Z');
			assert.equal(evalLate.firstResponse.stage, 'fulfilled_breached');
		});

		await t.test(
			'Regla funcional: sin resolvedAt, una incidencia resolved evalúa a fulfilled_unknown sin usar updatedAt',
			() => {
				const incidentResolvedWithoutTimestamp = {
					...baseIncident,
					status: 'resolved',
					updatedAt: '2026-09-10T08:15:00.000Z', // Should NEVER be used as resolution date
					sla: {
						...createSlaSnapshot(baseIncident, categoryPriorityPolicy),
						firstRespondedAt: '2026-09-10T08:20:00.000Z',
						resolvedAt: null // Explicitly untracked/unknown
					}
				};

				const evalResolved = evaluateIncidentSla(
					incidentResolvedWithoutTimestamp,
					'2026-09-10T10:00:00.000Z'
				);
				assert.equal(evalResolved.resolution.stage, 'fulfilled_unknown');
				assert.equal(evalResolved.resolution.completedAt, null);
				assert.equal(evalResolved.resolution.remainingMinutes, null);
				// Overall status is fulfilled since both first response and resolution are fulfilled
				assert.equal(evalResolved.status, 'fulfilled');
			}
		);

		await t.test('Compatibilidad con incidencias sin SLA', () => {
			const legacyIncident = { ...baseIncident };
			delete legacyIncident.sla;

			const evalLegacy = evaluateIncidentSla(legacyIncident);
			assert.equal(evalLegacy.status, 'no_sla');

			// Validate with isIncidentList
			assert.equal(isIncidentList([legacyIncident]), true);
			assert.equal(
				isIncidentList([
					{
						...legacyIncident,
						sla: createSlaSnapshot(legacyIncident, fallbackPolicy)
					}
				]),
				true
			);
		});

		await t.test(
			'Validación de snapshot en isIncidentList: campos obligatorios firstRespondedAt y resolvedAt',
			() => {
				const validSnapshot = createSlaSnapshot(baseIncident, fallbackPolicy);

				// 4. snapshot con ambos null → válido
				assert.equal(validSnapshot.firstRespondedAt, null);
				assert.equal(validSnapshot.resolvedAt, null);
				assert.equal(isIncidentList([{ ...baseIncident, sla: validSnapshot }]), true);

				// 3. incidencia sin sla (ausente o null) → válida
				const withoutSla = { ...baseIncident };
				delete withoutSla.sla;
				assert.equal(isIncidentList([withoutSla]), true);
				assert.equal(isIncidentList([{ ...baseIncident, sla: null }]), true);

				// 1. snapshot con firstRespondedAt ausente/undefined → inválido
				const missingFirstResponse = { ...validSnapshot };
				delete missingFirstResponse.firstRespondedAt;
				assert.equal(isIncidentList([{ ...baseIncident, sla: missingFirstResponse }]), false);
				assert.equal(
					isIncidentList([
						{ ...baseIncident, sla: { ...validSnapshot, firstRespondedAt: undefined } }
					]),
					false
				);

				// 2. snapshot con resolvedAt ausente/undefined → inválido
				const missingResolvedAt = { ...validSnapshot };
				delete missingResolvedAt.resolvedAt;
				assert.equal(isIncidentList([{ ...baseIncident, sla: missingResolvedAt }]), false);
				assert.equal(
					isIncidentList([{ ...baseIncident, sla: { ...validSnapshot, resolvedAt: undefined } }]),
					false
				);

				// Válido con fechas válidas registradas
				assert.equal(
					isIncidentList([
						{
							...baseIncident,
							sla: {
								...validSnapshot,
								firstRespondedAt: '2026-09-10T08:15:00.000Z',
								resolvedAt: '2026-09-10T11:00:00.000Z'
							}
						}
					]),
					true
				);
			}
		);

		await t.test('Validación de listas de políticas SLA (isSlaPolicyList)', () => {
			const validPolicies = [fallbackPolicy, categoryPriorityPolicy];
			assert.equal(isSlaPolicyList(validPolicies), true);
			assert.equal(isSlaPolicyList([{ ...fallbackPolicy, firstResponseMinutes: 0 }]), false);
			assert.equal(isSlaPolicyList([{ ...fallbackPolicy, resolutionMinutes: -10 }]), false);
			assert.equal(isSlaPolicyList([{ ...fallbackPolicy, priority: 'invalid_priority' }]), false);

			// Política default con categoryId no null es inválida
			assert.equal(isSlaPolicyList([{ ...fallbackPolicy, categoryId: 'network' }]), false);
			// Política default con priority no null es inválida
			assert.equal(isSlaPolicyList([{ ...fallbackPolicy, priority: 'high' }]), false);
			// Política default con categoryId y priority explícitamente null es válida
			assert.equal(
				isSlaPolicyList([{ ...fallbackPolicy, categoryId: null, priority: null }]),
				true
			);
		});

		await t.test('Garantía: reasignar y escalar NO reinician ni alteran el SLA', () => {
			const tech1 = demoUsers.find((u) => u.role === 'technician');
			const tech2 = demoUsers.find((u) => u.role === 'technician' && u.id !== tech1.id);
			const admin = demoUsers.find((u) => u.role === 'organization_admin');

			const ticketWithSla = {
				...baseIncident,
				assignedToUserId: tech1.id,
				supportLevel: 'N1',
				teamId: demoSupportTeams[0].id,
				sla: createSlaSnapshot(baseIncident, categoryPriorityPolicy)
			};

			const originalDueResponse = ticketWithSla.sla.firstResponseDueAt;
			const originalDueResolution = ticketWithSla.sla.resolutionDueAt;

			// 1. Reassignment
			const reassigned = prepareAssignment(
				tech1,
				ticketWithSla,
				demoUsers,
				tech2.id,
				'Fin de turno'
			);
			assert.notEqual(reassigned, null);
			assert.equal(reassigned.incident.assignedToUserId, tech2.id);
			assert.deepEqual(reassigned.incident.sla, ticketWithSla.sla);
			assert.equal(reassigned.incident.sla.firstResponseDueAt, originalDueResponse);
			assert.equal(reassigned.incident.sla.resolutionDueAt, originalDueResolution);

			// 2. Escalation
			const escalated = prepareEscalation(admin, ticketWithSla, demoUsers, demoSupportTeams, {
				supportLevel: 'N2',
				teamId: demoSupportTeams[1].id,
				reason: 'Requiere nivel superior'
			});
			assert.notEqual(escalated, null);
			assert.equal(escalated.incident.supportLevel, 'N2');
			assert.deepEqual(escalated.incident.sla, ticketWithSla.sla);
			assert.equal(escalated.incident.sla.firstResponseDueAt, originalDueResponse);
			assert.equal(escalated.incident.sla.resolutionDueAt, originalDueResolution);
		});
	} finally {
		await server.close();
	}
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('Clasificación V2 — Fase 2B: Compatibilidad integral con prioridad "urgent", snapshots V2 y preservación de SLA V1', async (suite) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		// Import modules via Vite SSR
		const { isIncidentList, isValidClassificationSnapshot, isCoherentClassificationPriority } =
			await server.ssrLoadModule('/src/lib/incidents/validation.ts');
		const { queueIncidents } = await server.ssrLoadModule('/src/lib/incidents/queue.ts');
		const { isIncidentHistory } = await server.ssrLoadModule('/src/lib/incidents/history.ts');
		const { describeHistoryEvent } = await server.ssrLoadModule('/src/lib/incidents/timeline.ts');
		const { getIncidentAttentionReasons, getAvailableToAssumeIncidents, ATTENTION_RANKS } =
			await server.ssrLoadModule('/src/lib/incidents/technician-dashboard.ts');
		const { matchSlaPolicy } = await server.ssrLoadModule('/src/lib/incidents/sla.ts');

		const baseIncident = {
			id: 100,
			organizationId: 'org-demo',
			title: 'Incidencia de prueba',
			client: 'Empresa Demo',
			clientUserId: 'usr-client-01',
			status: 'open',
			priority: 'medium',
			createdAt: '2026-09-10T08:00:00.000Z',
			createdByUserId: 'usr-client-01',
			assignedToUserId: 'usr-tech-01',
			supportLevel: 'N1',
			teamId: 'team-frontline'
		};

		const techUser = {
			id: 'usr-tech-01',
			organizationId: 'org-demo',
			name: 'Técnico Demo',
			email: 'tech@demo.com',
			role: 'technician',
			active: true,
			supportLevel: 'N2',
			teamId: 'team-frontline'
		};

		const supportLevels = [
			{
				id: 'lvl-1',
				organizationId: 'org-demo',
				code: 'N1',
				name: 'Nivel 1',
				order: 1,
				active: true
			},
			{
				id: 'lvl-2',
				organizationId: 'org-demo',
				code: 'N2',
				name: 'Nivel 2',
				order: 2,
				active: true
			},
			{
				id: 'lvl-3',
				organizationId: 'org-demo',
				code: 'N3',
				name: 'Nivel 3',
				order: 3,
				active: true
			}
		];

		// =========================================================================
		// 1. Las incidencias V1 siguen siendo válidas
		// =========================================================================
		await suite.test(
			'1. Incidencias V1 históricas siguen siendo completamente válidas',
			async (st) => {
				await st.test('1.1 Incidencias V1 con prioridades low, medium y high sin campos V2', () => {
					const v1Incidents = [
						{ ...baseIncident, id: 1, priority: 'low' },
						{ ...baseIncident, id: 2, priority: 'medium' },
						{ ...baseIncident, id: 3, priority: 'high' }
					];
					assert.equal(isIncidentList(v1Incidents), true);
				});

				await st.test(
					'1.2 Incidencias V1 con subcategoryId o classification ausentes o null',
					() => {
						const incidents = [
							{
								...baseIncident,
								id: 4,
								priority: 'low',
								subcategoryId: undefined,
								classification: undefined
							},
							{
								...baseIncident,
								id: 5,
								priority: 'medium',
								subcategoryId: null,
								classification: null
							},
							{ ...baseIncident, id: 6, priority: 'high' }
						];
						assert.equal(isIncidentList(incidents), true);
					}
				);
			}
		);

		// =========================================================================
		// 2. Las incidencias con prioridad urgent son válidas
		// =========================================================================
		await suite.test(
			'2. Incidencias con prioridad "urgent" son válidas en el modelo y validadores',
			async (st) => {
				await st.test('2.1 Admite priority: "urgent" tanto pura como con subcategoría', () => {
					const urgentIncidents = [
						{ ...baseIncident, id: 10, priority: 'urgent' },
						{ ...baseIncident, id: 11, priority: 'urgent', subcategoryId: 'subcat-infra-01' }
					];
					assert.equal(isIncidentList(urgentIncidents), true);
				});

				await st.test('2.2 Rechaza prioridades no pertenecientes al modelo operativo', () => {
					for (const badPrio of ['critical', 'p1', 'extreme', 'urgente', '', null, 1]) {
						const badIncident = [{ ...baseIncident, id: 99, priority: badPrio }];
						assert.equal(
							isIncidentList(badIncident),
							false,
							`Debe rechazar prioridad inválida: ${badPrio}`
						);
					}
				});
			}
		);

		// =========================================================================
		// 3. Snapshots V2: correctos se aceptan, malformados se rechazan
		// =========================================================================
		await suite.test(
			'3. Validación de snapshots V2: acepta válidos y rechaza malformados',
			async (st) => {
				const validSnapshotNoOverride = {
					baseCriticality: 'high',
					impactLevel: 'I1',
					matrixPriority: 'critical',
					minPriority: null,
					minPriorityApplied: false,
					calculatedPriority: 'critical',
					effectivePriority: 'critical',
					hasOverride: false
				};

				const validSnapshotWithOverride = {
					baseCriticality: 'medium',
					impactLevel: 'I3',
					matrixPriority: 'low',
					minPriority: null,
					minPriorityApplied: false,
					calculatedPriority: 'low',
					effectivePriority: 'critical',
					hasOverride: true,
					overrideReason: 'Corte de servicio crítico verificado en cliente VIP',
					overrideAuthorizedBy: 'usr-admin-01'
				};

				const validSnapshotWithMinPriority = {
					baseCriticality: 'low',
					impactLevel: 'I4',
					matrixPriority: 'low',
					minPriority: 'medium',
					minPriorityApplied: true,
					calculatedPriority: 'medium',
					effectivePriority: 'medium',
					hasOverride: false
				};

				await st.test(
					'3.1 Acepta snapshots bien formados (sin override, con override, con minPriority)',
					() => {
						assert.equal(isValidClassificationSnapshot(validSnapshotNoOverride), true);
						assert.equal(isValidClassificationSnapshot(validSnapshotWithOverride), true);
						assert.equal(isValidClassificationSnapshot(validSnapshotWithMinPriority), true);

						const incidentWithSnapshot = [
							{
								...baseIncident,
								id: 20,
								priority: 'urgent',
								subcategoryId: 'subcat-network',
								classification: validSnapshotNoOverride
							},
							{
								...baseIncident,
								id: 21,
								priority: 'urgent',
								subcategoryId: 'subcat-network',
								classification: validSnapshotWithOverride
							}
						];
						assert.equal(isIncidentList(incidentWithSnapshot), true);
					}
				);

				await st.test('3.2 Rechaza snapshots malformados o con tipos incorrectos', () => {
					assert.equal(isValidClassificationSnapshot('no-es-objeto'), false);
					assert.equal(isValidClassificationSnapshot(123), false);
					assert.equal(isValidClassificationSnapshot([]), false);
					assert.equal(isValidClassificationSnapshot({}), false);

					// Campo baseCriticality inválido
					assert.equal(
						isValidClassificationSnapshot({
							...validSnapshotNoOverride,
							baseCriticality: 'urgent'
						}),
						false
					);

					// Campo impactLevel inválido
					assert.equal(
						isValidClassificationSnapshot({ ...validSnapshotNoOverride, impactLevel: 'I5' }),
						false
					);

					// matrixPriority con nomenclatura incompatible
					assert.equal(
						isValidClassificationSnapshot({ ...validSnapshotNoOverride, matrixPriority: 'urgent' }),
						false
					);

					// minPriorityApplied: true pero minPriority es null
					assert.equal(
						isValidClassificationSnapshot({
							...validSnapshotNoOverride,
							minPriorityApplied: true,
							minPriority: null
						}),
						false
					);

					// Incoherencia sin override: effectivePriority !== calculatedPriority
					assert.equal(
						isValidClassificationSnapshot({
							...validSnapshotNoOverride,
							hasOverride: false,
							effectivePriority: 'high',
							calculatedPriority: 'low'
						}),
						false
					);

					// hasOverride: true pero overrideReason vacío o solo espacios
					assert.equal(
						isValidClassificationSnapshot({
							...validSnapshotWithOverride,
							overrideReason: ''
						}),
						false
					);
					assert.equal(
						isValidClassificationSnapshot({
							...validSnapshotWithOverride,
							overrideReason: '   '
						}),
						false
					);
					assert.equal(
						isValidClassificationSnapshot({
							...validSnapshotWithOverride,
							overrideReason: undefined
						}),
						false
					);
				});

				await st.test('3.3 Rechaza subcategoryId inválida en incidencia', () => {
					// Vacía o solo espacios
					assert.equal(isIncidentList([{ ...baseIncident, id: 25, subcategoryId: '' }]), false);
					assert.equal(isIncidentList([{ ...baseIncident, id: 26, subcategoryId: '   ' }]), false);
					assert.equal(isIncidentList([{ ...baseIncident, id: 27, subcategoryId: 123 }]), false);
				});

				await st.test(
					'3.4 Coherencia estricta entre incident.priority y classification.effectivePriority (adaptador critical <-> urgent)',
					() => {
						// 1. Helper directo: coherencia con adaptador critical <-> urgent
						assert.equal(
							isCoherentClassificationPriority('urgent', validSnapshotNoOverride),
							true,
							'effectivePriority: critical debe ser coherente con priority: urgent'
						);
						assert.equal(
							isCoherentClassificationPriority('high', validSnapshotNoOverride),
							false,
							'effectivePriority: critical NO debe ser coherente con priority: high'
						);
						assert.equal(
							isCoherentClassificationPriority('medium', validSnapshotWithMinPriority),
							true,
							'effectivePriority: medium debe ser coherente con priority: medium'
						);
						assert.equal(
							isCoherentClassificationPriority('low', validSnapshotWithMinPriority),
							false,
							'effectivePriority: medium NO debe ser coherente con priority: low'
						);
						assert.equal(
							isCoherentClassificationPriority('urgent', validSnapshotWithOverride),
							true,
							'override a critical debe ser coherente con priority: urgent'
						);
						assert.equal(
							isCoherentClassificationPriority('high', validSnapshotWithOverride),
							false,
							'override a critical NO debe ser coherente con priority: high'
						);

						// 2. V1 sin clasificación: siempre coherente
						assert.equal(isCoherentClassificationPriority('low', undefined), true);
						assert.equal(isCoherentClassificationPriority('medium', null), true);
						assert.equal(isCoherentClassificationPriority('high', undefined), true);
						assert.equal(isCoherentClassificationPriority('urgent', null), true);

						// 3. Validación de listas de incidencias (isIncidentList)
						// Caso coherente: priority 'urgent' con effectivePriority 'critical'
						assert.equal(
							isIncidentList([
								{
									...baseIncident,
									id: 28,
									priority: 'urgent',
									classification: validSnapshotNoOverride
								}
							]),
							true
						);

						// Caso incoherente: priority 'high' con effectivePriority 'critical' (degradación silenciosa rechazada)
						assert.equal(
							isIncidentList([
								{
									...baseIncident,
									id: 29,
									priority: 'high',
									classification: validSnapshotNoOverride
								}
							]),
							false,
							'isIncidentList debe rechazar incidencia donde priority (high) no coincide con effectivePriority (critical/urgent)'
						);

						// Caso incoherente: priority 'urgent' con effectivePriority 'medium'
						assert.equal(
							isIncidentList([
								{
									...baseIncident,
									id: 30,
									priority: 'urgent',
									classification: validSnapshotWithMinPriority
								}
							]),
							false,
							'isIncidentList debe rechazar incidencia donde priority (urgent) no coincide con effectivePriority (medium)'
						);

						// Caso incoherente con override: priority 'high' con override effectivePriority 'critical'
						assert.equal(
							isIncidentList([
								{
									...baseIncident,
									id: 31,
									priority: 'high',
									classification: validSnapshotWithOverride
								}
							]),
							false,
							'isIncidentList debe rechazar override incoherente'
						);

						// Caso V1 sin clasificación: se mantiene 100% válido
						assert.equal(
							isIncidentList([
								{ ...baseIncident, id: 32, priority: 'urgent', classification: undefined },
								{ ...baseIncident, id: 33, priority: 'high', classification: null },
								{ ...baseIncident, id: 34, priority: 'medium' }
							]),
							true,
							'Incidencias V1 sin clasificación deben seguir siendo válidas'
						);
					}
				);
			}
		);

		// =========================================================================
		// 4. Las colas ordenan correctamente los cuatro niveles
		// =========================================================================
		await suite.test(
			'4. Colas ordenan de forma determinista los cuatro niveles: urgent > high > medium > low',
			async (st) => {
				await st.test(
					'4.1 Orden operativo estricto: urgent (0) > high (1) > medium (2) > low (3)',
					() => {
						const items = [
							{ ...baseIncident, id: 1, priority: 'low', createdAt: '2026-09-10T10:00:00.000Z' },
							{ ...baseIncident, id: 2, priority: 'urgent', createdAt: '2026-09-10T10:00:00.000Z' },
							{ ...baseIncident, id: 3, priority: 'medium', createdAt: '2026-09-10T10:00:00.000Z' },
							{ ...baseIncident, id: 4, priority: 'high', createdAt: '2026-09-10T10:00:00.000Z' }
						];

						const sorted = queueIncidents(techUser, items, 'mine');
						assert.deepEqual(
							sorted.map((i) => i.id),
							[2, 4, 3, 1] // urgent (2), high (4), medium (3), low (1)
						);
					}
				);

				await st.test(
					'4.2 Desempate secundario por antigüedad e id para incidencias de misma prioridad',
					() => {
						const items = [
							{
								...baseIncident,
								id: 10,
								priority: 'urgent',
								createdAt: '2026-09-10T12:00:00.000Z'
							},
							{
								...baseIncident,
								id: 11,
								priority: 'urgent',
								createdAt: '2026-09-10T08:00:00.000Z'
							},
							{ ...baseIncident, id: 12, priority: 'urgent', createdAt: '2026-09-10T08:00:00.000Z' }
						];

						const sorted = queueIncidents(techUser, items, 'mine');
						assert.deepEqual(
							sorted.map((i) => i.id),
							[11, 12, 10] // 11 (más antigua), 12 (misma fecha, id menor), 10 (más reciente)
						);
					}
				);

				await st.test(
					'4.3 Incidencias inactivas (resolved/closed) van al final independientemente de prioridad',
					() => {
						const items = [
							{ ...baseIncident, id: 30, priority: 'urgent', status: 'resolved' },
							{ ...baseIncident, id: 31, priority: 'low', status: 'open' }
						];

						const sorted = queueIncidents(techUser, items, 'mine');
						assert.deepEqual(
							sorted.map((i) => i.id),
							[31, 30] // Activa (low) antes que inactiva (urgent)
						);
					}
				);
			}
		);

		// =========================================================================
		// 5. El dashboard reconoce urgent en sus reglas y ordenaciones
		// =========================================================================
		await suite.test(
			'5. Dashboard reconoce "urgent" en motivos de atención y ordenación de candidatos',
			async (st) => {
				await st.test(
					'5.1 getIncidentAttentionReasons genera motivo Tier 5 con label "Prioridad urgente"',
					() => {
						const urgentInc = { ...baseIncident, id: 40, priority: 'urgent', status: 'open' };
						const reasonsUrgent = getIncidentAttentionReasons(
							urgentInc,
							techUser,
							supportLevels,
							[]
						);
						const highPrioReason = reasonsUrgent.find((r) => r.type === 'high_priority');
						assert.ok(highPrioReason, 'Debe generar motivo high_priority para prioridad urgent');
						assert.equal(highPrioReason.label, 'Prioridad urgente');
						assert.equal(highPrioReason.priorityRank, ATTENTION_RANKS.high_priority);

						// high genera "Prioridad alta"
						const highInc = { ...baseIncident, id: 41, priority: 'high', status: 'open' };
						const reasonsHigh = getIncidentAttentionReasons(highInc, techUser, supportLevels, []);
						const highPrioReason2 = reasonsHigh.find((r) => r.type === 'high_priority');
						assert.ok(highPrioReason2);
						assert.equal(highPrioReason2.label, 'Prioridad alta');

						// medium y low no generan motivo de alta prioridad
						const medInc = { ...baseIncident, id: 42, priority: 'medium', status: 'open' };
						const reasonsMed = getIncidentAttentionReasons(medInc, techUser, supportLevels, []);
						assert.equal(
							reasonsMed.some((r) => r.type === 'high_priority'),
							false
						);
					}
				);

				await st.test(
					'5.2 getAvailableToAssumeIncidents ordena candidatos por prioWeight (urgent > high > medium > low)',
					() => {
						const unassignedPool = [
							{
								...baseIncident,
								id: 51,
								assignedToUserId: null,
								priority: 'low',
								createdAt: '2026-09-10T10:00:00Z'
							},
							{
								...baseIncident,
								id: 52,
								assignedToUserId: null,
								priority: 'urgent',
								createdAt: '2026-09-10T10:00:00Z'
							},
							{
								...baseIncident,
								id: 53,
								assignedToUserId: null,
								priority: 'medium',
								createdAt: '2026-09-10T10:00:00Z'
							},
							{
								...baseIncident,
								id: 54,
								assignedToUserId: null,
								priority: 'high',
								createdAt: '2026-09-10T10:00:00Z'
							}
						];

						const assumable = getAvailableToAssumeIncidents(
							unassignedPool,
							techUser,
							supportLevels
						);
						assert.deepEqual(
							assumable.map((i) => i.id),
							[52, 54, 53, 51] // urgent (52) > high (54) > medium (53) > low (51)
						);
					}
				);
			}
		);

		// =========================================================================
		// 6. Historial: compatibilidad con prioridad urgent
		// =========================================================================
		await suite.test(
			'6. Historial acepta eventos con valor "urgent" y renderiza timeline adecuadamente',
			async (st) => {
				await st.test(
					'6.1 isIncidentHistory acepta cambios de prioridad involucrando urgent',
					() => {
						const historyEntries = [
							{
								id: 'hist-01',
								incidentId: 100,
								organizationId: 'org-demo',
								actorUserId: 'usr-tech-01',
								timestamp: '2026-09-10T09:00:00.000Z',
								eventType: 'priority_changed',
								previousValue: 'high',
								newValue: 'urgent'
							},
							{
								id: 'hist-02',
								incidentId: 100,
								organizationId: 'org-demo',
								actorUserId: 'usr-tech-01',
								timestamp: '2026-09-10T09:15:00.000Z',
								eventType: 'priority_changed',
								previousValue: 'urgent',
								newValue: 'low'
							}
						];
						assert.equal(isIncidentHistory(historyEntries), true);
					}
				);

				await st.test('6.2 isIncidentHistory rechaza valores de prioridad no soportados', () => {
					const badHistory = [
						{
							id: 'hist-bad',
							incidentId: 100,
							organizationId: 'org-demo',
							actorUserId: 'usr-tech-01',
							timestamp: '2026-09-10T09:00:00.000Z',
							eventType: 'priority_changed',
							previousValue: 'high',
							newValue: 'critical' // En historial se usa el enum de IncidentPriority
						}
					];
					assert.equal(isIncidentHistory(badHistory), false);
				});

				await st.test(
					'6.3 isIncidentHistory acepta creación de incidencia con priority: urgent',
					() => {
						const createdHistory = [
							{
								id: 'hist-created',
								incidentId: 100,
								organizationId: 'org-demo',
								actorUserId: 'usr-client-01',
								timestamp: '2026-09-10T08:00:00.000Z',
								eventType: 'created',
								newValue: {
									title: 'Incidencia urgente creada',
									status: 'open',
									priority: 'urgent',
									supportLevel: 'N1',
									teamId: null,
									assignedToUserId: null
								}
							}
						];
						assert.equal(isIncidentHistory(createdHistory), true);
					}
				);

				await st.test('6.4 describeHistoryEvent formatea correctamente el texto "Urgente"', () => {
					const entry = {
						id: 'hist-03',
						incidentId: 100,
						organizationId: 'org-demo',
						actorUserId: 'usr-tech-01',
						timestamp: '2026-09-10T09:00:00.000Z',
						eventType: 'priority_changed',
						previousValue: 'high',
						newValue: 'urgent'
					};
					const text = describeHistoryEvent(entry, [techUser], [], [], []);
					assert.ok(
						text.includes('cambió la prioridad de Alta a Urgente'),
						`El texto debe incluir "cambió la prioridad de Alta a Urgente", obtenido: "${text}"`
					);
				});
			}
		);

		// =========================================================================
		// 7. SLA V1: snapshots existentes y comportamiento estricto sin fallback
		// =========================================================================
		await suite.test(
			'7. Motor y snapshots SLA V1 permanecen intactos sin fallback de urgent a high',
			async (st) => {
				const slaSnapshot = {
					policyId: 'sla-pol-1',
					policyName: 'SLA Estándar V1',
					firstResponseMinutes: 60,
					resolutionMinutes: 240,
					firstResponseDueAt: '2026-09-10T09:00:00.000Z',
					resolutionDueAt: '2026-09-10T12:00:00.000Z',
					firstRespondedAt: null,
					resolvedAt: null
				};

				await st.test(
					'7.1 Snapshots SLA existentes siguen siendo válidos en isIncidentList',
					() => {
						const incidentWithSla = [
							{ ...baseIncident, id: 70, priority: 'urgent', sla: slaSnapshot }
						];
						assert.equal(isIncidentList(incidentWithSla), true);
					}
				);

				await st.test('7.2 matchSlaPolicy NO degrada ni aplica fallback de urgent a high', () => {
					// Catálogo con una política para 'high', otra para 'medium' y ninguna default
					const policiesWithoutDefault = [
						{
							id: 'pol-high',
							organizationId: 'org-demo',
							name: 'SLA Prioridad Alta',
							active: true,
							isDefault: false,
							priority: 'high',
							firstResponseMinutes: 30,
							resolutionMinutes: 120,
							createdAt: '2026-01-01T00:00:00Z'
						},
						{
							id: 'pol-med',
							organizationId: 'org-demo',
							name: 'SLA Prioridad Media',
							active: true,
							isDefault: false,
							priority: 'medium',
							firstResponseMinutes: 60,
							resolutionMinutes: 240,
							createdAt: '2026-01-01T00:00:00Z'
						}
					];

					const urgentIncident = { ...baseIncident, id: 71, priority: 'urgent' };
					const matched = matchSlaPolicy(urgentIncident, policiesWithoutDefault);
					// ESTRICTO: No debe hacer fallback a 'pol-high'
					assert.equal(
						matched,
						null,
						'Una incidencia urgent NO debe recibir la política de prioridad high por fallback'
					);
				});

				await st.test(
					'7.3 matchSlaPolicy aplica la política predeterminada (default fallback) si existe',
					() => {
						const policiesWithDefault = [
							{
								id: 'pol-high',
								organizationId: 'org-demo',
								name: 'SLA Prioridad Alta',
								active: true,
								isDefault: false,
								priority: 'high',
								firstResponseMinutes: 30,
								resolutionMinutes: 120,
								createdAt: '2026-01-01T00:00:00Z'
							},
							{
								id: 'pol-default',
								organizationId: 'org-demo',
								name: 'SLA Fallback General',
								active: true,
								isDefault: true,
								firstResponseMinutes: 120,
								resolutionMinutes: 480,
								createdAt: '2026-01-01T00:00:00Z'
							}
						];

						const urgentIncident = { ...baseIncident, id: 72, priority: 'urgent' };
						const matched = matchSlaPolicy(urgentIncident, policiesWithDefault);
						assert.equal(matched?.id, 'pol-default');
					}
				);
			}
		);
	} finally {
		await server.close();
	}
});

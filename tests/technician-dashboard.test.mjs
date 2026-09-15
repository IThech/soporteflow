import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const mockOrgId = 'org-1';

const techUser = {
	id: 'tech-1',
	name: 'Andrés Técnico',
	email: 'andres@empresa.com',
	role: 'technician',
	organizationId: mockOrgId,
	supportLevel: 'N2',
	teamId: 'team-ops',
	active: true,
	createdAt: '2026-08-01T08:00:00.000Z'
};

const clientUser = {
	id: 'client-1',
	name: 'Carlos Cliente',
	email: 'carlos@cliente.com',
	role: 'client',
	organizationId: mockOrgId,
	active: true,
	createdAt: '2026-08-01T08:00:00.000Z'
};

const otherTech = {
	id: 'tech-2',
	name: 'Beatriz N3',
	email: 'beatriz@empresa.com',
	role: 'technician',
	organizationId: mockOrgId,
	supportLevel: 'N3',
	teamId: 'team-infra',
	active: true,
	createdAt: '2026-08-01T08:00:00.000Z'
};

const users = [techUser, clientUser, otherTech];

const mockLevels = [
	{ id: 'lvl-1', organizationId: mockOrgId, code: 'N1', name: 'Nivel 1', order: 1, active: true },
	{ id: 'lvl-2', organizationId: mockOrgId, code: 'N2', name: 'Nivel 2', order: 2, active: true },
	{ id: 'lvl-3', organizationId: mockOrgId, code: 'N3', name: 'Nivel 3', order: 3, active: true }
];

const mockCategories = [
	{ id: 'cat-software', organizationId: mockOrgId, name: 'Software', active: true },
	{ id: 'cat-hardware', organizationId: mockOrgId, name: 'Hardware', active: true },
	{ id: 'cat-network', organizationId: mockOrgId, name: 'Redes', active: true }
];

test('Dashboard Técnico V1', async (suite) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const {
			ATTENTION_RANKS,
			hasClientRespondedPendingStaff,
			getIncidentAttentionReasons,
			getAttentionIncidents,
			getAvailableToAssumeIncidents,
			computeTechnicianDashboardSummary,
			computeTechnicianActivityMetrics
		} = await server.ssrLoadModule('/src/lib/incidents/technician-dashboard.ts');

		assert.equal(ATTENTION_RANKS.client_responded, 1);
		assert.equal(ATTENTION_RANKS.reopened, 1);
		assert.equal(ATTENTION_RANKS.sla_breached, 2);
		assert.equal(ATTENTION_RANKS.sla_approaching, 3);
		assert.equal(ATTENTION_RANKS.incompatible_level, 4);
		assert.equal(ATTENTION_RANKS.high_priority, 5);

		await suite.test('Lógica de clasificación y motivos de atención', async (t) => {
			const fixedNow = new Date('2026-09-15T12:00:00.000Z');

			await t.test('1. Incidencia activa sin motivos especiales no requiere atención', () => {
				const inc = {
					id: 101,
					organizationId: mockOrgId,
					title: 'Consulta ordinaria',
					client: 'Carlos Cliente',
					clientUserId: clientUser.id,
					status: 'open',
					priority: 'medium',
					supportLevel: 'N1',
					assignedToUserId: techUser.id,
					createdAt: '2026-09-15T11:00:00.000Z',
					sla: null
				};

				const reasons = getIncidentAttentionReasons(
					inc,
					techUser,
					[],
					[],
					users,
					mockLevels,
					fixedNow
				);
				assert.equal(reasons.length, 0, 'No debe tener motivos de atención');
			});

			await t.test(
				'2. Incidencia PENDING esperando cliente sin motivo adicional no requiere atención',
				() => {
					const inc = {
						id: 102,
						organizationId: mockOrgId,
						title: 'Esperando logs',
						client: 'Carlos Cliente',
						clientUserId: clientUser.id,
						status: 'pending',
						priority: 'low',
						supportLevel: 'N2',
						assignedToUserId: techUser.id,
						createdAt: '2026-09-15T10:00:00.000Z',
						sla: null
					};

					const reasons = getIncidentAttentionReasons(
						inc,
						techUser,
						[],
						[],
						users,
						mockLevels,
						fixedNow
					);
					assert.equal(reasons.length, 0, 'PENDING esperando al cliente no debe requerir atención');
				}
			);

			await t.test('3. Incidencia RESOLVED o CLOSED no requiere atención', () => {
				const incResolved = {
					id: 103,
					organizationId: mockOrgId,
					title: 'Solución enviada',
					client: 'Carlos Cliente',
					clientUserId: clientUser.id,
					status: 'resolved',
					priority: 'high',
					supportLevel: 'N2',
					assignedToUserId: techUser.id,
					createdAt: '2026-09-15T09:00:00.000Z',
					resolvedAt: '2026-09-15T11:30:00.000Z'
				};

				const reasons = getIncidentAttentionReasons(
					incResolved,
					techUser,
					[],
					[],
					users,
					mockLevels,
					fixedNow
				);
				assert.equal(
					reasons.length,
					0,
					'RESOLVED no debe entrar en atención inmediata del técnico'
				);
			});

			await t.test('4. SLA incumplido entra con rango 2 (sla_breached)', () => {
				const inc = {
					id: 104,
					organizationId: mockOrgId,
					title: 'SLA vencido',
					client: 'Carlos Cliente',
					status: 'open',
					priority: 'medium',
					supportLevel: 'N2',
					assignedToUserId: techUser.id,
					createdAt: '2026-09-15T08:00:00.000Z',
					sla: {
						policyId: 'p1',
						policyName: 'Estándar',
						firstResponseMinutes: 60,
						resolutionMinutes: 120,
						firstResponseDueAt: '2026-09-15T09:00:00.000Z',
						resolutionDueAt: '2026-09-15T10:00:00.000Z',
						firstRespondedAt: null,
						resolvedAt: null
					}
				};

				const reasons = getIncidentAttentionReasons(
					inc,
					techUser,
					[],
					[],
					users,
					mockLevels,
					fixedNow
				);
				assert.equal(reasons.length, 1);
				assert.equal(reasons[0].type, 'sla_breached');
				assert.equal(reasons[0].priorityRank, 2);
			});

			await t.test('5. SLA próximo entra con rango 3 (sla_approaching)', () => {
				const inc = {
					id: 105,
					organizationId: mockOrgId,
					title: 'SLA por vencer en 10 min',
					client: 'Carlos Cliente',
					status: 'open',
					priority: 'medium',
					supportLevel: 'N2',
					assignedToUserId: techUser.id,
					createdAt: '2026-09-15T10:00:00.000Z',
					sla: {
						policyId: 'p1',
						policyName: 'Estándar',
						firstResponseMinutes: 60,
						resolutionMinutes: 130,
						firstResponseDueAt: '2026-09-15T11:00:00.000Z',
						resolutionDueAt: '2026-09-15T12:10:00.000Z', // 10 min from fixedNow (<= 15 min threshold)
						firstRespondedAt: '2026-09-15T10:30:00.000Z',
						resolvedAt: null
					}
				};

				const reasons = getIncidentAttentionReasons(
					inc,
					techUser,
					[],
					[],
					users,
					mockLevels,
					fixedNow
				);
				assert.equal(reasons.length, 1);
				assert.equal(reasons[0].type, 'sla_approaching');
				assert.equal(reasons[0].priorityRank, 3);
			});

			await t.test('6. Incidencia reabierta entra con rango 1 (reopened)', () => {
				const inc = {
					id: 106,
					organizationId: mockOrgId,
					title: 'Reabierta por cliente',
					client: 'Carlos Cliente',
					status: 'open',
					priority: 'medium',
					supportLevel: 'N2',
					assignedToUserId: techUser.id,
					createdAt: '2026-09-15T08:00:00.000Z',
					resolvedAt: '2026-09-15T10:00:00.000Z'
				};

				const history = [
					{
						id: 'h1',
						incidentId: 106,
						organizationId: mockOrgId,
						actorUserId: techUser.id,
						timestamp: '2026-09-15T10:00:00.000Z',
						eventType: 'resolved'
					},
					{
						id: 'h2',
						incidentId: 106,
						organizationId: mockOrgId,
						actorUserId: clientUser.id,
						timestamp: '2026-09-15T10:30:00.000Z',
						eventType: 'resolution_rejected',
						comment: 'Sigue sin funcionar'
					}
				];

				const reasons = getIncidentAttentionReasons(
					inc,
					techUser,
					history,
					[],
					users,
					mockLevels,
					fixedNow
				);
				assert.ok(reasons.some((r) => r.type === 'reopened' && r.priorityRank === 1));
			});

			await t.test('7. Incompatibilidad de nivel entra con rango 4 (incompatible_level)', () => {
				// Tech is N2, incident requires N3
				const inc = {
					id: 107,
					organizationId: mockOrgId,
					title: 'Requiere N3',
					client: 'Carlos Cliente',
					status: 'open',
					priority: 'medium',
					supportLevel: 'N3',
					assignedToUserId: techUser.id,
					createdAt: '2026-09-15T09:00:00.000Z'
				};

				const reasons = getIncidentAttentionReasons(
					inc,
					techUser,
					[],
					[],
					users,
					mockLevels,
					fixedNow
				);
				assert.ok(reasons.some((r) => r.type === 'incompatible_level' && r.priorityRank === 4));
			});

			await t.test('8. Prioridad alta entra con rango 5 (high_priority)', () => {
				const inc = {
					id: 108,
					organizationId: mockOrgId,
					title: 'Incidencia urgente',
					client: 'Carlos Cliente',
					status: 'open',
					priority: 'high',
					supportLevel: 'N2',
					assignedToUserId: techUser.id,
					createdAt: '2026-09-15T10:00:00.000Z'
				};

				const reasons = getIncidentAttentionReasons(
					inc,
					techUser,
					[],
					[],
					users,
					mockLevels,
					fixedNow
				);
				assert.ok(reasons.some((r) => r.type === 'high_priority' && r.priorityRank === 5));
			});
		});

		await suite.test(
			'Detección estricta de "Cliente ha respondido" (Ver != Atender)',
			async (t) => {
				const inc = {
					id: 201,
					organizationId: mockOrgId,
					title: 'Problema de correo',
					client: 'Carlos Cliente',
					clientUserId: clientUser.id,
					status: 'open',
					priority: 'medium',
					supportLevel: 'N2',
					assignedToUserId: techUser.id,
					createdAt: '2026-09-15T09:00:00.000Z'
				};

				await t.test(
					'1. Cliente comenta públicamente después de creación -> requiere atención',
					() => {
						const messages = [
							{
								id: 'm1',
								incidentId: 201,
								organizationId: mockOrgId,
								authorUserId: clientUser.id,
								visibility: 'public',
								content: 'Adjunto captura del error',
								createdAt: '2026-09-15T09:15:00.000Z'
							}
						];

						const hasReplied = hasClientRespondedPendingStaff(inc, messages, users, []);
						assert.equal(hasReplied, true, 'Debe detectar que el cliente respondió');
					}
				);

				await t.test(
					'2. "Ver != Atender": El técnico visualiza la incidencia (sin historial ni mensajes) -> sigue requiriendo atención',
					() => {
						const messages = [
							{
								id: 'm1',
								incidentId: 201,
								organizationId: mockOrgId,
								authorUserId: clientUser.id,
								visibility: 'public',
								content: 'Adjunto captura del error',
								createdAt: '2026-09-15T09:15:00.000Z'
							}
						];
						// No operational history actions performed
						const hasReplied = hasClientRespondedPendingStaff(inc, messages, users, []);
						assert.equal(hasReplied, true, 'Abrir o mirar no apaga la advertencia');
					}
				);

				await t.test(
					'3. Técnico añade nota interna -> sigue requiriendo atención (no es respuesta al cliente)',
					() => {
						const messages = [
							{
								id: 'm1',
								incidentId: 201,
								organizationId: mockOrgId,
								authorUserId: clientUser.id,
								visibility: 'public',
								content: 'Adjunto captura del error',
								createdAt: '2026-09-15T09:15:00.000Z'
							},
							{
								id: 'm2',
								incidentId: 201,
								organizationId: mockOrgId,
								authorUserId: techUser.id,
								visibility: 'internal',
								content: 'Revisando logs en servidor interno',
								createdAt: '2026-09-15T09:20:00.000Z'
							}
						];

						const hasReplied = hasClientRespondedPendingStaff(inc, messages, users, []);
						assert.equal(hasReplied, true, 'Nota interna no atiende al cliente');
					}
				);

				await t.test(
					'4. Eventos administrativos (categoría, prioridad, sede, reasignación) NO apagan el aviso',
					() => {
						const messages = [
							{
								id: 'm1',
								incidentId: 201,
								organizationId: mockOrgId,
								authorUserId: clientUser.id,
								visibility: 'public',
								content: 'Adjunto captura del error',
								createdAt: '2026-09-15T09:15:00.000Z'
							}
						];

						const adminHistory = [
							{
								id: 'h1',
								incidentId: 201,
								organizationId: mockOrgId,
								actorUserId: techUser.id,
								timestamp: '2026-09-15T09:20:00.000Z',
								eventType: 'category_changed',
								newValue: 'cat-network'
							},
							{
								id: 'h2',
								incidentId: 201,
								organizationId: mockOrgId,
								actorUserId: techUser.id,
								timestamp: '2026-09-15T09:21:00.000Z',
								eventType: 'priority_changed',
								newValue: 'high'
							},
							{
								id: 'h3',
								incidentId: 201,
								organizationId: mockOrgId,
								actorUserId: techUser.id,
								timestamp: '2026-09-15T09:22:00.000Z',
								eventType: 'site_changed',
								newValue: 'site-central'
							}
						];

						const hasReplied = hasClientRespondedPendingStaff(inc, messages, users, adminHistory);
						assert.equal(
							hasReplied,
							true,
							'Cambios administrativos no deben apagar la respuesta pendiente'
						);
					}
				);

				await t.test('5. Técnico escribe comentario público posterior -> el aviso se apaga', () => {
					const messages = [
						{
							id: 'm1',
							incidentId: 201,
							organizationId: mockOrgId,
							authorUserId: clientUser.id,
							visibility: 'public',
							content: 'Adjunto captura del error',
							createdAt: '2026-09-15T09:15:00.000Z'
						},
						{
							id: 'm2',
							incidentId: 201,
							organizationId: mockOrgId,
							authorUserId: techUser.id,
							visibility: 'public',
							content: 'Gracias Carlos, ya lo estamos revisando.',
							createdAt: '2026-09-15T09:25:00.000Z'
						}
					];

					const hasReplied = hasClientRespondedPendingStaff(inc, messages, users, []);
					assert.equal(hasReplied, false, 'Comentario público del staff atiende la respuesta');
				});

				await t.test(
					'6. Cambio de estado operativo posterior (status_changed) -> el aviso se apaga',
					() => {
						const messages = [
							{
								id: 'm1',
								incidentId: 201,
								organizationId: mockOrgId,
								authorUserId: clientUser.id,
								visibility: 'public',
								content: 'Ya he reiniciado el router',
								createdAt: '2026-09-15T09:15:00.000Z'
							}
						];

						const history = [
							{
								id: 'h1',
								incidentId: 201,
								organizationId: mockOrgId,
								actorUserId: techUser.id,
								timestamp: '2026-09-15T09:25:00.000Z',
								eventType: 'status_changed',
								newValue: 'pending'
							}
						];

						const hasReplied = hasClientRespondedPendingStaff(inc, messages, users, history);
						assert.equal(hasReplied, false, 'status_changed operativo atiende la respuesta');
					}
				);

				await t.test('7. Resolución posterior (resolved) -> el aviso se apaga', () => {
					const messages = [
						{
							id: 'm1',
							incidentId: 201,
							organizationId: mockOrgId,
							authorUserId: clientUser.id,
							visibility: 'public',
							content: 'Sigue dando timeout',
							createdAt: '2026-09-15T09:15:00.000Z'
						}
					];

					const history = [
						{
							id: 'h1',
							incidentId: 201,
							organizationId: mockOrgId,
							actorUserId: techUser.id,
							timestamp: '2026-09-15T09:28:00.000Z',
							eventType: 'resolved'
						}
					];

					const hasReplied = hasClientRespondedPendingStaff(inc, messages, users, history);
					assert.equal(hasReplied, false, 'Resolución atiende la respuesta');
				});
			}
		);

		await suite.test('Unicidad y orden de atención', async (t) => {
			const fixedNow = new Date('2026-09-15T12:00:00.000Z');

			await t.test(
				'1. Incidencia con múltiples motivos aparece una sola vez con todos sus motivos',
				() => {
					const inc = {
						id: 301,
						organizationId: mockOrgId,
						title: 'Múltiples alertas',
						client: 'Carlos Cliente',
						status: 'open',
						priority: 'high', // Rango 6
						supportLevel: 'N3', // Rango 5 (tech is N2)
						assignedToUserId: techUser.id,
						createdAt: '2026-09-15T08:00:00.000Z',
						sla: {
							policyId: 'p1',
							policyName: 'Estándar',
							firstResponseMinutes: 60,
							resolutionMinutes: 120,
							firstResponseDueAt: '2026-09-15T09:00:00.000Z',
							resolutionDueAt: '2026-09-15T10:00:00.000Z', // Breached (Rango 1)
							firstRespondedAt: null,
							resolvedAt: null
						}
					};

					const items = getAttentionIncidents([inc], techUser, [], [], users, mockLevels, fixedNow);
					assert.equal(items.length, 1, 'Debe aparecer exactamente una vez');
					assert.equal(items[0].reasons.length, 3, 'Debe contener los 3 motivos concurrentes');
					assert.equal(items[0].primaryReason.type, 'sla_breached');
					assert.equal(items[0].primaryReason.priorityRank, 2);
					assert.ok(items[0].reasons.some((r) => r.type === 'incompatible_level'));
					assert.ok(items[0].reasons.some((r) => r.type === 'high_priority'));
				}
			);

			await t.test('2. Ordenación estricta por rango de motivo y por antigüedad', () => {
				const incHighPrioOld = {
					id: 302,
					organizationId: mockOrgId,
					title: 'Prioridad alta antigua',
					client: 'Carlos Cliente',
					status: 'open',
					priority: 'high', // Tier 5 (Rango 5)
					supportLevel: 'N2',
					assignedToUserId: techUser.id,
					createdAt: '2026-09-15T06:00:00.000Z'
				};

				const incReopened = {
					id: 303,
					organizationId: mockOrgId,
					title: 'Reabierta reciente',
					client: 'Carlos Cliente',
					status: 'open',
					priority: 'medium',
					supportLevel: 'N2',
					assignedToUserId: techUser.id,
					createdAt: '2026-09-15T11:00:00.000Z',
					resolvedAt: '2026-09-15T11:20:00.000Z'
				};

				const incSlaBreachedNewer = {
					id: 304,
					organizationId: mockOrgId,
					title: 'SLA vencido nuevo',
					client: 'Carlos Cliente',
					status: 'open',
					priority: 'medium',
					supportLevel: 'N2',
					assignedToUserId: techUser.id,
					createdAt: '2026-09-15T09:00:00.000Z',
					sla: {
						policyId: 'p1',
						policyName: 'Estándar',
						firstResponseMinutes: 60,
						resolutionMinutes: 120,
						firstResponseDueAt: '2026-09-15T10:00:00.000Z',
						resolutionDueAt: '2026-09-15T11:00:00.000Z', // Breached (Tier 2)
						firstRespondedAt: null,
						resolvedAt: null
					}
				};

				const incSlaBreachedOlder = {
					id: 305,
					organizationId: mockOrgId,
					title: 'SLA vencido viejo',
					client: 'Carlos Cliente',
					status: 'open',
					priority: 'medium',
					supportLevel: 'N2',
					assignedToUserId: techUser.id,
					createdAt: '2026-09-15T07:00:00.000Z',
					sla: {
						policyId: 'p1',
						policyName: 'Estándar',
						firstResponseMinutes: 60,
						resolutionMinutes: 120,
						firstResponseDueAt: '2026-09-15T08:00:00.000Z',
						resolutionDueAt: '2026-09-15T09:00:00.000Z', // Breached (Tier 2)
						firstRespondedAt: null,
						resolvedAt: null
					}
				};

				const history = [
					{
						id: 'h303',
						incidentId: 303,
						organizationId: mockOrgId,
						actorUserId: clientUser.id,
						timestamp: '2026-09-15T11:30:00.000Z',
						eventType: 'resolution_rejected',
						comment: 'Reabrir'
					}
				];

				const items = getAttentionIncidents(
					[incHighPrioOld, incReopened, incSlaBreachedNewer, incSlaBreachedOlder],
					techUser,
					history,
					[],
					users,
					mockLevels,
					fixedNow
				);

				// Esperado con nuevos Tiers:
				// 1. Reabierta (Tier 1)
				// 2. SLA vencido viejo (Tier 2, 07:00)
				// 3. SLA vencido nuevo (Tier 2, 09:00)
				// 4. Prioridad alta (Tier 5, 06:00)
				assert.equal(items.length, 4);
				assert.equal(
					items[0].incident.id,
					303,
					'Reabierta (Tier 1) debe ir antes que SLA vencido (Tier 2)'
				);
				assert.equal(items[1].incident.id, 305, 'SLA vencido más antiguo (Tier 2) debe ir segundo');
				assert.equal(
					items[2].incident.id,
					304,
					'SLA vencido más reciente (Tier 2) debe ir tercero'
				);
				assert.equal(items[3].incident.id, 302, 'Prioridad alta (Tier 5) va al final por su rango');
			});

			await t.test(
				'3. Cliente respondió (Tier 1) se prioriza por delante de SLA incumplido (Tier 2)',
				() => {
					const incBreached = {
						id: 310,
						organizationId: mockOrgId,
						title: 'SLA vencido sin cliente',
						status: 'open',
						priority: 'medium',
						supportLevel: 'N2',
						assignedToUserId: techUser.id,
						createdAt: '2026-09-15T07:00:00.000Z',
						sla: {
							policyId: 'p1',
							policyName: 'Estándar',
							firstResponseMinutes: 60,
							resolutionMinutes: 120,
							firstResponseDueAt: '2026-09-15T08:00:00.000Z',
							resolutionDueAt: '2026-09-15T09:00:00.000Z', // Breached
							firstRespondedAt: null,
							resolvedAt: null
						}
					};

					const incClientReplied = {
						id: 311,
						organizationId: mockOrgId,
						title: 'Cliente ha respondido hace 15m',
						clientUserId: clientUser.id,
						status: 'open',
						priority: 'medium',
						supportLevel: 'N2',
						assignedToUserId: techUser.id,
						createdAt: '2026-09-15T10:00:00.000Z',
						sla: null
					};

					const messages = [
						{
							id: 'm-311',
							incidentId: 311,
							organizationId: mockOrgId,
							authorUserId: clientUser.id,
							visibility: 'public',
							content: '¿Hay alguna novedad sobre esto?',
							createdAt: '2026-09-15T11:45:00.000Z'
						}
					];

					const items = getAttentionIncidents(
						[incBreached, incClientReplied],
						techUser,
						[],
						messages,
						users,
						mockLevels,
						fixedNow
					);

					assert.equal(items.length, 2);
					assert.equal(
						items[0].incident.id,
						311,
						'Cliente respondió (Tier 1) debe ir antes que SLA vencido (Tier 2)'
					);
					assert.equal(items[0].primaryReason.type, 'client_responded');
					assert.equal(items[0].primaryReason.timeAgo, 'hace 15 min');
					assert.equal(items[1].incident.id, 310, 'SLA vencido debe ir después');
				}
			);

			await t.test(
				'4. Multimotivo: Incidencia con SLA incumplido Y respuesta del cliente sube a Tier 1 y conserva ambos badges',
				() => {
					const incMulti = {
						id: 320,
						organizationId: mockOrgId,
						title: 'Vencida y con cliente esperando',
						clientUserId: clientUser.id,
						status: 'open',
						priority: 'high',
						supportLevel: 'N2',
						assignedToUserId: techUser.id,
						createdAt: '2026-09-15T07:00:00.000Z',
						sla: {
							policyId: 'p1',
							policyName: 'Estándar',
							firstResponseMinutes: 60,
							resolutionMinutes: 120,
							firstResponseDueAt: '2026-09-15T08:00:00.000Z',
							resolutionDueAt: '2026-09-15T09:00:00.000Z', // Breached Tier 2
							firstRespondedAt: null,
							resolvedAt: null
						}
					};

					const messages = [
						{
							id: 'm-320',
							incidentId: 320,
							organizationId: mockOrgId,
							authorUserId: clientUser.id,
							visibility: 'public',
							content: 'Por favor, esto nos está bloqueando.',
							createdAt: '2026-09-15T11:50:00.000Z'
						}
					];

					const items = getAttentionIncidents(
						[incMulti],
						techUser,
						[],
						messages,
						users,
						mockLevels,
						fixedNow
					);

					assert.equal(items.length, 1);
					assert.equal(
						items[0].primaryReason.type,
						'client_responded',
						'Sube a Tier 1 por interacción de cliente'
					);
					assert.equal(items[0].primaryReason.priorityRank, 1);
					assert.equal(items[0].primaryReason.timeAgo, 'hace 10 min');
					// Debe conservar los otros badges
					assert.ok(
						items[0].reasons.some((r) => r.type === 'sla_breached'),
						'Conserva badge SLA incumplido'
					);
					assert.ok(
						items[0].reasons.some((r) => r.type === 'high_priority'),
						'Conserva badge prioridad alta'
					);
				}
			);

			await t.test(
				'5. Ordenación dentro de Tier 1 por timestamp del evento (interacción más reciente primero)',
				() => {
					const incOldResponse = {
						id: 330,
						organizationId: mockOrgId,
						title: 'Cliente respondió hace 45m',
						clientUserId: clientUser.id,
						status: 'open',
						priority: 'medium',
						supportLevel: 'N2',
						assignedToUserId: techUser.id,
						createdAt: '2026-09-15T08:00:00.000Z'
					};

					const incNewResponse = {
						id: 331,
						organizationId: mockOrgId,
						title: 'Cliente respondió hace 5m',
						clientUserId: clientUser.id,
						status: 'open',
						priority: 'medium',
						supportLevel: 'N2',
						assignedToUserId: techUser.id,
						createdAt: '2026-09-15T09:00:00.000Z'
					};

					const messages = [
						{
							id: 'm-330',
							incidentId: 330,
							organizationId: mockOrgId,
							authorUserId: clientUser.id,
							visibility: 'public',
							content: 'Mensaje hace 45m',
							createdAt: '2026-09-15T11:15:00.000Z'
						},
						{
							id: 'm-331',
							incidentId: 331,
							organizationId: mockOrgId,
							authorUserId: clientUser.id,
							visibility: 'public',
							content: 'Mensaje hace 5m',
							createdAt: '2026-09-15T11:55:00.000Z'
						}
					];

					const items = getAttentionIncidents(
						[incOldResponse, incNewResponse],
						techUser,
						[],
						messages,
						users,
						mockLevels,
						fixedNow
					);

					assert.equal(items.length, 2);
					assert.equal(
						items[0].incident.id,
						331,
						'Interacción más reciente (hace 5m) debe quedar primera'
					);
					assert.equal(items[0].primaryReason.timeAgo, 'hace 5 min');
					assert.equal(
						items[1].incident.id,
						330,
						'Interacción anterior (hace 45m) debe quedar segunda'
					);
					assert.equal(items[1].primaryReason.timeAgo, 'hace 45 min');
				}
			);
		});

		await suite.test('Incidencias disponibles para asumir y capacidad', async (t) => {
			await t.test(
				'1. Técnico N2 solo puede asumir N1 y N2, no N3 ni asignadas ni de otra organización',
				() => {
					const incidents = [
						{
							id: 401,
							organizationId: mockOrgId,
							title: 'Incidencia N1 sin asignar',
							status: 'open',
							priority: 'medium',
							supportLevel: 'N1',
							teamId: 'team-ops',
							assignedToUserId: null,
							createdAt: '2026-09-15T10:00:00.000Z'
						},
						{
							id: 402,
							organizationId: mockOrgId,
							title: 'Incidencia N2 sin asignar',
							status: 'open',
							priority: 'medium',
							supportLevel: 'N2',
							teamId: 'team-ops',
							assignedToUserId: null,
							createdAt: '2026-09-15T09:00:00.000Z'
						},
						{
							id: 403,
							organizationId: mockOrgId,
							title: 'Incidencia N3 sin asignar (fuera de capacidad)',
							status: 'open',
							priority: 'high',
							supportLevel: 'N3',
							teamId: 'team-infra',
							assignedToUserId: null,
							createdAt: '2026-09-15T08:00:00.000Z'
						},
						{
							id: 404,
							organizationId: mockOrgId,
							title: 'Incidencia N1 ya asignada a Beatriz',
							status: 'open',
							priority: 'medium',
							supportLevel: 'N1',
							assignedToUserId: otherTech.id,
							createdAt: '2026-09-15T07:00:00.000Z'
						},
						{
							id: 405,
							organizationId: 'other-org',
							title: 'Otra empresa',
							status: 'open',
							priority: 'high',
							supportLevel: 'N1',
							assignedToUserId: null,
							createdAt: '2026-09-15T08:00:00.000Z'
						}
					];

					const available = getAvailableToAssumeIncidents(incidents, techUser, mockLevels);
					const ids = available.map((i) => i.id);

					assert.ok(ids.includes(401), 'Debe incluir N1');
					assert.ok(ids.includes(402), 'Debe incluir N2');
					assert.ok(!ids.includes(403), 'No debe incluir N3 por capacidad insuficiente');
					assert.ok(!ids.includes(404), 'No debe incluir incidencias ya asignadas');
					assert.ok(!ids.includes(405), 'No debe incluir incidencias de otra organización');
				}
			);

			await t.test('2. Prioriza incidencias del mismo equipo técnico', () => {
				const incidents = [
					{
						id: 406,
						organizationId: mockOrgId,
						title: 'Equipo externo',
						status: 'open',
						priority: 'high',
						supportLevel: 'N1',
						teamId: 'team-infra',
						assignedToUserId: null,
						createdAt: '2026-09-15T08:00:00.000Z'
					},
					{
						id: 407,
						organizationId: mockOrgId,
						title: 'Mi equipo',
						status: 'open',
						priority: 'medium',
						supportLevel: 'N1',
						teamId: 'team-ops', // Matches techUser.teamId
						assignedToUserId: null,
						createdAt: '2026-09-15T09:00:00.000Z'
					}
				];

				const available = getAvailableToAssumeIncidents(incidents, techUser, mockLevels);
				assert.equal(available[0].id, 407, 'Incidencia del mismo equipo debe ir primero');
			});
		});

		await suite.test('Analítica de actividad a 30 días y atribución', async (t) => {
			const fixedNow = new Date('2026-09-15T12:00:00.000Z');

			await t.test(
				'1. Atribución correcta mediante evento resolved del historial y ventana de 30 días',
				() => {
					const incidents = [
						{
							id: 501,
							organizationId: mockOrgId,
							title: 'Resuelta por techUser hace 5 días',
							status: 'resolved',
							priority: 'medium',
							categoryId: 'cat-software',
							supportLevel: 'N2',
							assignedToUserId: techUser.id,
							createdAt: '2026-09-08T08:00:00.000Z',
							resolvedAt: '2026-09-10T10:00:00.000Z',
							sla: {
								policyId: 'p1',
								policyName: 'Estándar',
								firstResponseMinutes: 60,
								resolutionMinutes: 480,
								firstResponseDueAt: '2026-09-08T09:00:00.000Z',
								resolutionDueAt: '2026-09-10T12:00:00.000Z',
								firstRespondedAt: '2026-09-08T08:30:00.000Z',
								resolvedAt: '2026-09-10T10:00:00.000Z' // within SLA
							}
						},
						{
							id: 502,
							organizationId: mockOrgId,
							title: 'Resuelta por techUser pero actualmente reasignada a Beatriz',
							status: 'closed',
							priority: 'high',
							categoryId: 'cat-hardware',
							supportLevel: 'N1',
							assignedToUserId: otherTech.id, // currently assigned to otherTech!
							createdAt: '2026-09-01T08:00:00.000Z',
							resolvedAt: '2026-09-02T10:00:00.000Z',
							sla: {
								policyId: 'p1',
								policyName: 'Estándar',
								firstResponseMinutes: 60,
								resolutionMinutes: 480,
								firstResponseDueAt: '2026-09-01T09:00:00.000Z',
								resolutionDueAt: '2026-09-01T12:00:00.000Z', // breached resolution SLA
								firstRespondedAt: '2026-09-01T08:30:00.000Z',
								resolvedAt: '2026-09-02T10:00:00.000Z'
							}
						},
						{
							id: 503,
							organizationId: mockOrgId,
							title: 'Resuelta hace 40 días (fuera de ventana)',
							status: 'closed',
							priority: 'low',
							categoryId: 'cat-software',
							supportLevel: 'N1',
							assignedToUserId: techUser.id,
							createdAt: '2026-08-01T08:00:00.000Z',
							resolvedAt: '2026-08-02T08:00:00.000Z'
						}
					];

					const history = [
						{
							id: 'h501',
							incidentId: 501,
							organizationId: mockOrgId,
							actorUserId: techUser.id,
							timestamp: '2026-09-10T10:00:00.000Z',
							eventType: 'resolved'
						},
						{
							id: 'h502',
							incidentId: 502,
							organizationId: mockOrgId,
							actorUserId: techUser.id, // resolved by techUser!
							timestamp: '2026-09-02T10:00:00.000Z',
							eventType: 'resolved'
						},
						{
							id: 'h502-reopen',
							incidentId: 502,
							organizationId: mockOrgId,
							actorUserId: clientUser.id,
							timestamp: '2026-09-03T10:00:00.000Z',
							eventType: 'reopened'
						},
						{
							id: 'h503',
							incidentId: 503,
							organizationId: mockOrgId,
							actorUserId: techUser.id,
							timestamp: '2026-08-02T08:00:00.000Z',
							eventType: 'resolved'
						}
					];

					const metrics = computeTechnicianActivityMetrics(
						incidents,
						techUser,
						history,
						mockCategories,
						mockLevels,
						fixedNow,
						30
					);

					assert.equal(
						metrics.resolvedCount,
						2,
						'Debe incluir 501 y 502 (atribuida por historial), pero no 503'
					);
					assert.equal(metrics.withinSlaCount, 1, '501 dentro de SLA, 502 breached');
					assert.equal(metrics.withinSlaPercentage, 50);
					assert.equal(metrics.reopenedCount, 1, '502 tuvo evento reopened');
					assert.equal(metrics.reopenedPercentage, 50);

					// Categories
					assert.equal(metrics.categories.length, 2);
					const swCat = metrics.categories.find((c) => c.categoryId === 'cat-software');
					const hwCat = metrics.categories.find((c) => c.categoryId === 'cat-hardware');
					assert.equal(swCat?.count, 1);
					assert.equal(swCat?.percentage, 50);
					assert.equal(hwCat?.count, 1);
					assert.equal(hwCat?.percentage, 50);

					// Levels
					const n1Lvl = metrics.levels.find((l) => l.levelCode === 'N1');
					const n2Lvl = metrics.levels.find((l) => l.levelCode === 'N2');
					assert.equal(n1Lvl?.count, 1);
					assert.equal(n2Lvl?.count, 1);
				}
			);

			await t.test(
				'2. Control de caso borde: 0 incidencias resueltas (sin divisiones por cero)',
				() => {
					const metrics = computeTechnicianActivityMetrics(
						[],
						techUser,
						[],
						mockCategories,
						mockLevels,
						fixedNow,
						30
					);

					assert.equal(metrics.resolvedCount, 0);
					assert.equal(metrics.withinSlaCount, 0);
					assert.equal(metrics.withinSlaPercentage, 0);
					assert.equal(metrics.reopenedCount, 0);
					assert.equal(metrics.reopenedPercentage, 0);
					assert.deepEqual(metrics.categories, []);
					assert.deepEqual(metrics.levels, []);
				}
			);

			await t.test(
				'3. Incidencia resuelta sin nivel produce "Sin nivel" y no filtra "none" al usuario',
				() => {
					const incidents = [
						{
							id: 504,
							organizationId: mockOrgId,
							title: 'Resuelta sin nivel asignado',
							status: 'resolved',
							priority: 'low',
							categoryId: 'cat-software',
							supportLevel: undefined,
							assignedToUserId: techUser.id,
							createdAt: '2026-09-12T08:00:00.000Z',
							resolvedAt: '2026-09-12T10:00:00.000Z'
						}
					];

					const metrics = computeTechnicianActivityMetrics(
						incidents,
						techUser,
						[],
						mockCategories,
						mockLevels,
						fixedNow,
						30
					);

					assert.equal(metrics.resolvedCount, 1);
					const noneLvl = metrics.levels.find((l) => l.levelCode === 'none');
					assert.ok(noneLvl, 'Debe registrarse con clave interna none');
					assert.equal(noneLvl.levelName, 'Sin nivel', 'El nombre público debe ser Sin nivel');
				}
			);
		});

		await suite.test('Resumen superior (KPIs)', () => {
			const fixedNow = new Date('2026-09-15T12:00:00.000Z');

			const incidents = [
				{
					id: 601,
					organizationId: mockOrgId,
					title: 'Activa 1',
					status: 'open',
					priority: 'high', // attention
					supportLevel: 'N2',
					assignedToUserId: techUser.id,
					createdAt: '2026-09-15T10:00:00.000Z'
				},
				{
					id: 602,
					organizationId: mockOrgId,
					title: 'Activa 2',
					status: 'pending',
					priority: 'medium',
					supportLevel: 'N2',
					assignedToUserId: techUser.id,
					createdAt: '2026-09-15T09:00:00.000Z',
					sla: {
						policyId: 'p1',
						policyName: 'Estándar',
						firstResponseMinutes: 60,
						resolutionMinutes: 190,
						firstResponseDueAt: '2026-09-15T10:00:00.000Z',
						resolutionDueAt: '2026-09-15T12:10:00.000Z', // approaching (10m) -> attention
						firstRespondedAt: '2026-09-15T09:30:00.000Z',
						resolvedAt: null
					}
				},
				{
					id: 603,
					organizationId: mockOrgId,
					title: 'Sin asignar asumible',
					status: 'open',
					priority: 'medium',
					supportLevel: 'N1',
					assignedToUserId: null,
					createdAt: '2026-09-15T08:00:00.000Z'
				}
			];

			const summary = computeTechnicianDashboardSummary(
				incidents,
				techUser,
				[],
				[],
				users,
				mockLevels,
				fixedNow
			);

			assert.equal(summary.myActiveCount, 2, 'Debe contar 2 incidencias activas asignadas');
			assert.equal(
				summary.attentionCount,
				2,
				'601 (alta prioridad) y 602 (SLA próximo) requieren atención'
			);
			assert.equal(summary.slaApproachingCount, 1, '602 tiene SLA próximo');
			assert.equal(summary.availableToAssumeCount, 1, '603 está disponible para asumir');
		});
	} finally {
		await server.close();
	}
});

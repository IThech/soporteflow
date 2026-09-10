import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('SLA v1 Bloque 3: Presentación, semántica visual estricta y formato temporal', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });
	try {
		const {
			formatSlaDuration,
			formatSlaRemaining,
			formatSlaDateTime,
			getIncidentVisualSlaStatus,
			getSlaBadgeConfig,
			getTargetBadgeConfig
		} = await server.ssrLoadModule('/src/lib/incidents/sla-presentation.ts');
		const { evaluateIncidentSla } = await server.ssrLoadModule('/src/lib/incidents/sla.ts');

		await t.test('1. Formato de duraciones humanizadas (formatSlaDuration)', () => {
			assert.equal(formatSlaDuration(0), '0 min');
			assert.equal(formatSlaDuration(15), '15 min');
			assert.equal(formatSlaDuration(59), '59 min');
			assert.equal(formatSlaDuration(60), '1 h');
			assert.equal(formatSlaDuration(135), '2 h 15 min');
			assert.equal(formatSlaDuration(1440), '1 d');
			assert.equal(formatSlaDuration(1560), '1 d 2 h');
			assert.equal(formatSlaDuration(2880), '2 d');
			assert.equal(formatSlaDuration(2945), '2 d 1 h');
		});

		await t.test('2. Formato de tiempo restante y vencido (formatSlaRemaining)', () => {
			assert.equal(formatSlaRemaining(null), '');
			assert.equal(formatSlaRemaining(35), '35 min restantes');
			assert.equal(formatSlaRemaining(120), '2 h restantes');
			assert.equal(formatSlaRemaining(135), '2 h 15 min restantes');
			assert.equal(formatSlaRemaining(1560), '1 d 2 h restantes');

			// Tiempos negativos (vencidos)
			assert.equal(formatSlaRemaining(-45), 'Vencido hace 45 min');
			assert.equal(formatSlaRemaining(-80), 'Vencido hace 1 h 20 min');
			assert.equal(formatSlaRemaining(-1500), 'Vencido hace 1 d 1 h');
		});

		await t.test('3. Formato de fecha y hora local (formatSlaDateTime)', () => {
			assert.equal(formatSlaDateTime(null), '');
			assert.equal(formatSlaDateTime(''), '');
			assert.equal(formatSlaDateTime('fecha-invalida'), '');

			const formatted = formatSlaDateTime('2026-09-10T14:30:00.000Z');
			assert.ok(formatted.includes('2026') || formatted.includes('10'));
		});

		await t.test('4. Semántica estricta: Finalizado NO equivale a Cumplido', () => {
			// Caso A: Ambos cumplidos dentro de plazo -> Cumplido
			const evalAllWithin = {
				status: 'fulfilled',
				firstResponse: {
					stage: 'fulfilled_within_sla',
					dueAt: '2026-09-10T12:00:00.000Z',
					completedAt: '2026-09-10T11:00:00.000Z',
					remainingMinutes: null
				},
				resolution: {
					stage: 'fulfilled_within_sla',
					dueAt: '2026-09-10T16:00:00.000Z',
					completedAt: '2026-09-10T14:00:00.000Z',
					remainingMinutes: null
				}
			};
			assert.equal(getIncidentVisualSlaStatus(evalAllWithin), 'fulfilled');
			assert.equal(getSlaBadgeConfig('fulfilled').label, 'Cumplido');

			// Caso B: Resuelta pero resolución completada fuera de plazo -> Incumplido
			const evalResolutionBreached = {
				status: 'fulfilled',
				firstResponse: {
					stage: 'fulfilled_within_sla',
					dueAt: '2026-09-10T12:00:00.000Z',
					completedAt: '2026-09-10T11:00:00.000Z',
					remainingMinutes: null
				},
				resolution: {
					stage: 'fulfilled_breached', // Venció fuera de plazo
					dueAt: '2026-09-10T16:00:00.000Z',
					completedAt: '2026-09-10T17:00:00.000Z',
					remainingMinutes: null
				}
			};
			assert.equal(getIncidentVisualSlaStatus(evalResolutionBreached), 'breached');
			assert.equal(getSlaBadgeConfig('breached').label, 'Incumplido');

			// Caso C: Primera respuesta completada fuera de plazo -> Incumplido (aunque ya esté respondida)
			const evalResponseBreached = {
				status: 'on_track',
				firstResponse: {
					stage: 'fulfilled_breached',
					dueAt: '2026-09-10T12:00:00.000Z',
					completedAt: '2026-09-10T12:30:00.000Z',
					remainingMinutes: null
				},
				resolution: {
					stage: 'on_track',
					dueAt: '2026-09-10T18:00:00.000Z',
					completedAt: null,
					remainingMinutes: 200
				}
			};
			assert.equal(getIncidentVisualSlaStatus(evalResponseBreached), 'breached');
			assert.equal(getSlaBadgeConfig('breached').label, 'Incumplido');

			// Caso D: Incidencia finalizada con fulfilled_unknown -> No debe mostrarse como Cumplido
			const evalUnknown = {
				status: 'fulfilled',
				firstResponse: {
					stage: 'fulfilled_within_sla',
					dueAt: '2026-09-10T12:00:00.000Z',
					completedAt: '2026-09-10T11:00:00.000Z',
					remainingMinutes: null
				},
				resolution: {
					stage: 'fulfilled_unknown',
					dueAt: '2026-09-10T18:00:00.000Z',
					completedAt: null,
					remainingMinutes: null
				}
			};
			const unknownStatus = getIncidentVisualSlaStatus(evalUnknown);
			assert.equal(unknownStatus, 'unknown');
			assert.notEqual(unknownStatus, 'fulfilled');
			assert.equal(getSlaBadgeConfig(unknownStatus).label, 'Sin registro');
			assert.equal(getSlaBadgeConfig(unknownStatus, false).fullLabel, 'Sin registro fiable');
		});

		await t.test('5. Estados activos: en plazo, próximo y sin SLA', () => {
			// Sin SLA
			const evalNoSla = {
				status: 'no_sla',
				firstResponse: { stage: 'on_track', dueAt: '', completedAt: null, remainingMinutes: null },
				resolution: { stage: 'on_track', dueAt: '', completedAt: null, remainingMinutes: null }
			};
			assert.equal(getIncidentVisualSlaStatus(evalNoSla), 'no_sla');
			assert.equal(getSlaBadgeConfig('no_sla').label, 'Sin SLA');

			// En plazo
			const evalOnTrack = {
				status: 'on_track',
				firstResponse: {
					stage: 'on_track',
					dueAt: '2026-09-10T14:00:00.000Z',
					completedAt: null,
					remainingMinutes: 90
				},
				resolution: {
					stage: 'on_track',
					dueAt: '2026-09-10T18:00:00.000Z',
					completedAt: null,
					remainingMinutes: 330
				}
			};
			assert.equal(getIncidentVisualSlaStatus(evalOnTrack), 'on_track');
			assert.equal(getSlaBadgeConfig('on_track').label, 'En plazo');

			// Próximo a vencer
			const evalApproaching = {
				status: 'approaching',
				firstResponse: {
					stage: 'approaching',
					dueAt: '2026-09-10T14:00:00.000Z',
					completedAt: null,
					remainingMinutes: 10
				},
				resolution: {
					stage: 'on_track',
					dueAt: '2026-09-10T18:00:00.000Z',
					completedAt: null,
					remainingMinutes: 250
				}
			};
			assert.equal(getIncidentVisualSlaStatus(evalApproaching), 'approaching');
			assert.equal(getSlaBadgeConfig('approaching').label, 'Próximo');
			assert.equal(getSlaBadgeConfig('approaching', false).fullLabel, 'Próximo a vencer');
		});

		await t.test('6. Objetivos individuales (getTargetBadgeConfig)', () => {
			assert.equal(getTargetBadgeConfig('fulfilled_within_sla').label, 'Cumplido');
			assert.equal(getTargetBadgeConfig('fulfilled_breached').label, 'Incumplido');
			assert.equal(getTargetBadgeConfig('fulfilled_unknown').label, 'Sin registro');
			assert.equal(getTargetBadgeConfig('on_track').label, 'En plazo');
			assert.equal(getTargetBadgeConfig('approaching').label, 'Próximo a vencer');
			assert.equal(getTargetBadgeConfig('breached').label, 'Incumplido');
		});

		await t.test('7. Evaluación dinámica pura ante reapertura e inmutabilidad', () => {
			const reopenedIncident = {
				id: 201,
				organizationId: 'org-test',
				title: 'Incidencia reabierta',
				client: 'Cliente Test',
				status: 'open',
				priority: 'high',
				createdAt: '2026-09-10T10:00:00.000Z',
				sla: {
					policyId: 'sla-test',
					policyName: 'SLA Crítico',
					firstResponseMinutes: 60,
					resolutionMinutes: 240,
					firstResponseDueAt: '2026-09-10T11:00:00.000Z',
					resolutionDueAt: '2026-09-10T14:00:00.000Z',
					firstRespondedAt: '2026-09-10T10:30:00.000Z',
					resolvedAt: '2026-09-10T13:00:00.000Z' // Histórico previo
				}
			};

			const snapshotCopy = JSON.stringify(reopenedIncident);

			// Al estar reabierta (status: 'open') y ser las 15:00 UTC (después del deadline de las 14:00):
			const evalReopened = evaluateIncidentSla(
				reopenedIncident,
				new Date('2026-09-10T15:00:00.000Z')
			);

			// La resolución debe estar incumplida
			assert.equal(evalReopened.resolution.stage, 'breached');
			assert.equal(evalReopened.resolution.completedAt, null);
			assert.equal(getIncidentVisualSlaStatus(evalReopened), 'breached');

			// Comprobar que no hubo mutación de la incidencia ni de su snapshot
			assert.equal(JSON.stringify(reopenedIncident), snapshotCopy);
		});
	} finally {
		await server.close();
	}
});

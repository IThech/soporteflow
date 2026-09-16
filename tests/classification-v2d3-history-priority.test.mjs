import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createServer } from 'vite';

test('Clasificación V2D.3: historial de creación y prioridad protegida', async (suite) => {
	const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
	try {
		const { buildCreatedHistoryEntry, resolveEditedIncidentPriority } = await server.ssrLoadModule(
			'/src/lib/incidents/lifecycle.ts'
		);
		const { isIncidentHistory } = await server.ssrLoadModule('/src/lib/incidents/history.ts');

		const v2 = {
			id: 203,
			organizationId: 'org-nodhouses',
			createdByUserId: 'usr-client-01',
			title: 'ERP no disponible',
			client: 'Cliente',
			description: 'No responde',
			status: 'open',
			priority: 'urgent',
			createdAt: '2026-09-16T10:15:30.000Z',
			supportLevel: 'N2',
			teamId: 'team-apps',
			assignedToUserId: null,
			classification: {
				version: 2,
				subcategoryId: 'sub-erp',
				impact: 'I4',
				baseCriticality: 'high',
				matrixPriority: 'critical',
				calculatedPriority: 'critical',
				minPriority: null,
				minPriorityApplied: false,
				effectivePriority: 'critical'
			}
		};

		await suite.test('crea un evento created válido con el snapshot operativo inicial', () => {
			const entry = buildCreatedHistoryEntry(v2, 'usr-client-01', 'hist-created-203');
			assert.equal(isIncidentHistory([entry]), true);
			assert.equal(entry.eventType, 'created');
			assert.equal(entry.timestamp, v2.createdAt);
			assert.deepEqual(entry.newValue, {
				title: v2.title,
				status: 'open',
				priority: 'urgent',
				supportLevel: 'N2',
				teamId: 'team-apps',
				assignedToUserId: null
			});
		});

		await suite.test('ignora cambios manuales de prioridad en incidencias V2', () => {
			assert.equal(resolveEditedIncidentPriority(v2, 'low'), 'urgent');
		});

		await suite.test('mantiene la edición manual V1 e incluye urgent en el selector', async () => {
			const v1 = { ...v2, classification: undefined, priority: 'medium' };
			assert.equal(resolveEditedIncidentPriority(v1, 'urgent'), 'urgent');
			const page = await readFile('src/routes/app/+page.svelte', 'utf8');
			assert.match(page, /\{#if editingIncident\.classification\}/);
			assert.match(page, /<option value="urgent">Urgente<\/option>/);
		});

		await suite.test('la creación persiste incidencia e historial conjuntamente', async () => {
			const page = await readFile('src/routes/app/+page.svelte', 'utf8');
			assert.match(page, /buildCreatedHistoryEntry\(incidentWithSla, activeUser\.id\)/);
			assert.match(page, /const nextHistory = \[\.\.\.history, createdEvent\]/);
			assert.match(page, /commitAssignment\([\s\S]*?nextIncidents,[\s\S]*?nextHistory/);
		});
	} finally {
		await server.close();
	}
});

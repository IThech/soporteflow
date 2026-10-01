import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { ApiError } from '../src/lib/api/errors.ts';
import {
	createIncidentConversation,
	unauthenticatedConversationError
} from '../src/lib/app/incident-conversation.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER_A = randomUUID();
const INCIDENT_A = randomUUID();
const INCIDENT_B = randomUUID();

function identity(capabilities = ['incidents:view_all'], organizationId = ORG_A, generation = 1) {
	return {
		userId: USER_A,
		organizationId,
		organizationSlug: 'org-test',
		generation,
		capabilities: Object.freeze([...capabilities])
	};
}

function historyItem(
	id = randomUUID(),
	type = 'created',
	occurredAt = '2026-09-30T10:00:00.000000Z',
	extra = {}
) {
	return {
		id,
		type,
		occurredAt,
		actor: { type: 'user', label: 'Usuario' },
		...extra
	};
}

test('UI-2D Historial: 1. Pestaña Historial y carga por requester y staff', async () => {
	const calls = [];
	const conv = createIncidentConversation({
		listHistory: async (opts) => {
			calls.push(opts);
			return {
				items: [historyItem('h1', 'created')],
				nextCursor: null
			};
		}
	});

	// 1. Requester accede a Historial
	conv.setTarget({
		identity: identity(['incidents:view_requested']),
		incidentId: INCIDENT_A,
		audience: 'requester',
		capabilities: ['incidents:view_requested']
	});
	conv.setActiveTab('history');
	assert.equal(conv.get().activeTab, 'history', 'requester puede activar la pestaña de historial');

	await conv.loadHistory();
	assert.equal(conv.get().history.status, 'ready');
	assert.equal(conv.get().history.items.length, 1);
	assert.equal(conv.get().history.items[0].type, 'created');
	assert.equal(calls.length, 1);
	assert.equal(calls[0].incidentId, INCIDENT_A);
	assert.equal(calls[0].organizationId, ORG_A);

	// 2. Staff accede a Historial
	conv.setTarget({
		identity: identity(['incidents:view_all']),
		incidentId: INCIDENT_B,
		audience: 'staff',
		capabilities: ['incidents:view_all']
	});
	conv.setActiveTab('history');
	await conv.loadHistory();
	assert.equal(conv.get().history.status, 'ready');
	assert.equal(calls.length, 2);
	assert.equal(calls[1].incidentId, INCIDENT_B);

	conv.dispose();
});

test('UI-2D Historial: 2. Estado vacío y paginación con cursor y deduplicación', async () => {
	const conv = createIncidentConversation({
		listHistory: async (opts) => {
			if (opts.incidentId === 'empty-inc') {
				return { items: [], nextCursor: null };
			}
			if (!opts.cursor) {
				return {
					items: [
						historyItem('h1', 'status_changed', '2026-09-30T10:00:00.000Z', {
							changes: { status: { from: 'open', to: 'pending' } }
						}),
						historyItem('h2', 'created', '2026-09-30T09:00:00.000Z')
					],
					nextCursor: 'cursor_hist_page_2'
				};
			}
			return {
				items: [
					historyItem('h2', 'created', '2026-09-30T09:00:00.000Z'), // Duplicado en el límite
					historyItem('h3', 'created', '2026-09-30T08:00:00.000Z')
				],
				nextCursor: null
			};
		}
	});

	// Estado vacío
	conv.setTarget({
		identity: identity(),
		incidentId: 'empty-inc',
		audience: 'staff',
		capabilities: ['incidents:view_all']
	});
	await conv.loadHistory();
	assert.equal(conv.get().history.status, 'ready');
	assert.equal(conv.get().history.items.length, 0);

	// Primera página
	conv.setTarget({
		identity: identity(),
		incidentId: INCIDENT_A,
		audience: 'staff',
		capabilities: ['incidents:view_all']
	});
	await conv.loadHistory();
	assert.equal(conv.get().history.items.length, 2);
	assert.equal(conv.get().history.nextCursor, 'cursor_hist_page_2');

	// Cargar página siguiente con deduplicación
	await conv.loadHistory({ reset: false });
	assert.equal(conv.get().history.items.length, 3);
	assert.deepEqual(
		conv.get().history.items.map((i) => i.id),
		['h1', 'h2', 'h3']
	);
	assert.equal(conv.get().history.nextCursor, null);

	conv.dispose();
});

test('UI-2D Historial: 3. Error y detección de 401 para expiración de sesión', async () => {
	const conv = createIncidentConversation({
		listHistory: async () => {
			throw new ApiError(401, 'UNAUTHORIZED', 'Sesión expirada');
		}
	});

	conv.setTarget({
		identity: identity(),
		incidentId: INCIDENT_A,
		audience: 'staff',
		capabilities: ['incidents:view_all']
	});

	await conv.loadHistory();
	assert.equal(conv.get().history.status, 'error');
	assert.equal(conv.get().history.error?.status, 401);

	const authErr = unauthenticatedConversationError(conv.get());
	assert.ok(authErr);
	assert.equal(authErr.status, 401);

	conv.dispose();
});

test('UI-2D Historial: 4. Aislamiento multi-tenant y descarte de peticiones obsoletas', async () => {
	let resolveStale;
	const conv = createIncidentConversation({
		listHistory: async (opts) => {
			if (opts.incidentId === INCIDENT_A) {
				return new Promise((res) => {
					resolveStale = res;
				});
			}
			return {
				items: [historyItem('h_current', 'created')],
				nextCursor: null
			};
		}
	});

	// Petición lenta en Tenant A
	conv.setTarget({
		identity: identity(['incidents:view_all'], ORG_A, 1),
		incidentId: INCIDENT_A,
		audience: 'staff',
		capabilities: ['incidents:view_all']
	});
	const load1 = conv.loadHistory();

	// Cambio rápido a Tenant B
	conv.setTarget({
		identity: identity(['incidents:view_all'], ORG_B, 2),
		incidentId: INCIDENT_B,
		audience: 'staff',
		capabilities: ['incidents:view_all']
	});
	const load2 = conv.loadHistory();

	// Resolver petición anterior
	resolveStale({
		items: [historyItem('h_stale', 'created')],
		nextCursor: null
	});
	await load1;
	await load2;

	// Tenant B solo contiene h_current
	assert.equal(conv.get().history.items.length, 1);
	assert.equal(conv.get().history.items[0].id, 'h_current');

	conv.dispose();
});

test('UI-2D Historial SSR: renderizado de eventos, empty state, tabs y accesibilidad', async () => {
	const server = await createServer({
		root,
		configFile: false,
		envDir: false,
		logLevel: 'silent',
		resolve: { alias: { $lib: path.resolve(root, 'src/lib') } },
		plugins: [svelte({ configFile: false })],
		server: { middlewareMode: true, hmr: false, watch: null },
		appType: 'custom'
	});

	try {
		const { render } = await server.ssrLoadModule('svelte/server');
		const mod = await server.ssrLoadModule('/src/lib/components/incidents/IncidentActivity.svelte');
		const Activity = mod.default;

		const staffIncident = {
			id: INCIDENT_A,
			incidentNumber: 1042,
			title: 'Corte de enlace de fibra',
			description: 'Sin conexión en planta 3',
			status: 'open',
			priority: 'urgent',
			audience: 'staff',
			client: 'Corporación Alfa',
			clientUserId: USER_A,
			teamId: null,
			assignedToUserId: null,
			slaPolicyId: null
		};

		const requesterIncident = {
			id: INCIDENT_A,
			incidentNumber: 1042,
			title: 'Corte de enlace de fibra',
			description: 'Sin conexión en planta 3',
			status: 'open',
			priority: 'urgent',
			audience: 'requester'
		};

		// 1. Render Staff con eventos en Historial
		const mockEvents = [
			historyItem('h1', 'status_changed', '2026-09-30T10:30:00.000Z', {
				changes: { status: { from: 'open', to: 'pending' } }
			}),
			historyItem('h2', 'priority_changed', '2026-09-30T10:15:00.000Z', {
				changes: { priority: { from: 'medium', to: 'urgent' } }
			}),
			historyItem('h3', 'assigned', '2026-09-30T10:10:00.000Z', {
				changes: { assignmentChanged: true }
			}),
			historyItem('h4', 'created', '2026-09-30T10:00:00.000Z')
		];

		const staffConv = createIncidentConversation({
			listHistory: async () => ({
				items: mockEvents,
				nextCursor: 'next_c'
			})
		});
		staffConv.setTarget({
			identity: identity(['incidents:view_all', 'incidents:view_internal_notes']),
			incidentId: INCIDENT_A,
			audience: 'staff',
			capabilities: [
				'incidents:view_all',
				'incidents:view_internal_notes',
				'incidents:add_internal_note',
				'incidents:add_comment'
			]
		});
		staffConv.setActiveTab('history');
		await staffConv.loadHistory();

		const staffHtml = render(Activity, {
			props: {
				incident: staffIncident,
				identity: identity(['incidents:view_all', 'incidents:view_internal_notes']),
				capabilities: [
					'incidents:view_all',
					'incidents:view_internal_notes',
					'incidents:add_internal_note',
					'incidents:add_comment'
				],
				conversationController: staffConv
			}
		}).body;

		// Verificaciones en staff:
		assert.ok(staffHtml.includes('role="tablist"'), 'tablist accesible');
		assert.ok(staffHtml.includes('Conversación'), 'pestaña Conversación');
		assert.ok(staffHtml.includes('Notas internas'), 'pestaña Notas internas');
		assert.ok(staffHtml.includes('Historial'), 'pestaña Historial');
		assert.ok(staffHtml.includes('aria-selected="true"'), 'pestaña activa seleccionada');
		assert.ok(staffHtml.includes('Incidencia creada'), 'evento de creación');
		assert.ok(staffHtml.includes('Estado modificado'), 'evento de cambio de estado');
		assert.ok(staffHtml.includes('Prioridad modificada'), 'evento de cambio de prioridad');
		assert.ok(staffHtml.includes('Incidencia asignada'), 'evento de asignación');
		assert.ok(staffHtml.includes('Cargar eventos anteriores'), 'botón de paginación por cursor');

		// 2. Render Requester con Historial (sin notas internas)
		const requesterConv = createIncidentConversation({
			listHistory: async () => ({
				items: [historyItem('r1', 'created', '2026-09-30T10:00:00.000Z')],
				nextCursor: null
			})
		});
		requesterConv.setTarget({
			identity: identity(['incidents:view_requested']),
			incidentId: INCIDENT_A,
			audience: 'requester',
			capabilities: ['incidents:view_requested', 'incidents:add_comment']
		});
		requesterConv.setActiveTab('history');
		await requesterConv.loadHistory();

		const requesterHtml = render(Activity, {
			props: {
				incident: requesterIncident,
				identity: identity(['incidents:view_requested']),
				capabilities: ['incidents:view_requested', 'incidents:add_comment'],
				conversationController: requesterConv
			}
		}).body;

		// Verificaciones en requester:
		assert.ok(requesterHtml.includes('role="tablist"'), 'tablist accesible para requester');
		assert.ok(requesterHtml.includes('Conversación'), 'requester tiene Conversación');
		assert.ok(requesterHtml.includes('Historial'), 'requester tiene Historial');
		assert.ok(!requesterHtml.includes('Notas internas'), 'requester NUNCA ve Notas internas');
		assert.ok(requesterHtml.includes('Incidencia creada'), 'evento visible para requester');

		// 3. Render Historial Vacío
		const emptyConv = createIncidentConversation({
			listHistory: async () => ({ items: [], nextCursor: null })
		});
		emptyConv.setTarget({
			identity: identity(),
			incidentId: 'empty',
			audience: 'staff',
			capabilities: ['incidents:view_all']
		});
		emptyConv.setActiveTab('history');
		await emptyConv.loadHistory();

		const emptyHtml = render(Activity, {
			props: {
				incident: staffIncident,
				identity: identity(),
				capabilities: ['incidents:view_all'],
				conversationController: emptyConv
			}
		}).body;

		assert.ok(
			emptyHtml.includes('No hay actividad registrada en esta incidencia.'),
			'mensaje honesto de historial vacío'
		);

		staffConv.dispose();
		requesterConv.dispose();
		emptyConv.dispose();
	} finally {
		await server.close();
	}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { listIncidents, IncidentApiError } from '../src/lib/api/incidents.ts';
import { session } from '../src/lib/stores/session.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createDeferred() {
	let resolve, reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeSampleIncident(overrides = {}) {
	const orgId = overrides.organizationId ?? randomUUID();
	return {
		id: randomUUID(),
		organizationId: orgId,
		incidentNumber: 101,
		title: 'Incidente de prueba para colas',
		description: 'Descripción de prueba para verificar colas reales.',
		status: 'open',
		priority: 'high',
		client: 'Acme Corp',
		clientUserId: null,
		createdByUserId: randomUUID(),
		siteId: null,
		assignedToUserId: null,
		createdAt: '2026-09-25T10:00:00.000Z',
		updatedAt: '2026-09-25T10:00:00.000Z',
		...overrides
	};
}

/**
 * Simulates the coordinator state machine implemented in src/routes/app/+page.svelte
 * with reactive queue support from URL and race condition protection.
 */
function createQueueCoordinator(options = {}) {
	const fetchFn = options.fetchFn ?? globalThis.fetch;
	let redirectedTo = null;
	let currentUrl = options.initialUrl ?? '/app';

	const state = {
		realIncidents: [],
		realLoading: false,
		realError: null,
		activeQueue: 'all'
	};

	let incidentRequestId = 0;
	let incidentAbortController = null;

	const VALID_QUEUES = new Set(['mine', 'unassigned', 'all']);

	function normalizeQueue(param) {
		if (param && VALID_QUEUES.has(param)) {
			return param;
		}
		return 'all';
	}

	function parseQueueFromUrl(urlStr) {
		try {
			const parsed = new URL(urlStr, 'http://localhost');
			return normalizeQueue(parsed.searchParams.get('queue'));
		} catch {
			return 'all';
		}
	}

	async function selectQueue(newQueue, sessionState) {
		const parsed = new URL(currentUrl, 'http://localhost');
		parsed.searchParams.set('queue', newQueue);
		currentUrl = parsed.pathname + parsed.search;
		state.activeQueue = normalizeQueue(newQueue);
		return runEffect(sessionState);
	}

	async function runEffect(sessionState, urlOverride) {
		if (urlOverride !== undefined) {
			currentUrl = urlOverride;
		}
		const queue = parseQueueFromUrl(currentUrl);
		state.activeQueue = queue;

		const isAuth = sessionState?.isAuthenticated;
		const currentOrg = sessionState?.activeOrganization;
		const currentUserId = sessionState?.user?.id;
		const currentQueue = state.activeQueue;

		incidentRequestId += 1;
		const thisRequestId = incidentRequestId;

		if (incidentAbortController) {
			incidentAbortController.abort();
			incidentAbortController = null;
		}

		if (!isAuth || !currentOrg) {
			state.realIncidents = [];
			state.realLoading = false;
			state.realError = null;
			return;
		}

		state.realIncidents = [];
		state.realError = null;
		state.realLoading = true;

		const controller = new AbortController();
		incidentAbortController = controller;
		const targetOrgId = currentOrg.id;
		const targetUserId = currentUserId;
		const targetQueue = currentQueue;

		try {
			const data = await listIncidents(targetOrgId, {
				queue: targetQueue,
				signal: controller.signal,
				customFetch: fetchFn
			});

			if (
				thisRequestId !== incidentRequestId ||
				sessionState?.activeOrganization?.id !== targetOrgId ||
				sessionState?.user?.id !== targetUserId ||
				state.activeQueue !== targetQueue
			) {
				return;
			}

			state.realIncidents = data;
			state.realError = null;
		} catch (err) {
			if (
				thisRequestId !== incidentRequestId ||
				sessionState?.activeOrganization?.id !== targetOrgId ||
				sessionState?.user?.id !== targetUserId ||
				state.activeQueue !== targetQueue
			) {
				return;
			}

			if (err?.name === 'AbortError' || controller.signal.aborted) {
				return;
			}

			if (err instanceof IncidentApiError && err.status === 401) {
				session.clearSession();
				state.realIncidents = [];
				state.realError = null;
				state.realLoading = false;
				redirectedTo = '/login?expired=true';
				return;
			}

			if (err instanceof IncidentApiError) {
				if (err.status === 403) {
					state.realError = 'No tienes permisos para consultar esta cola.';
				} else {
					state.realError = err.message;
				}
			} else {
				state.realError = 'No se pudieron cargar las incidencias. Inténtalo de nuevo.';
			}
		} finally {
			if (
				thisRequestId === incidentRequestId &&
				sessionState?.activeOrganization?.id === targetOrgId &&
				sessionState?.user?.id === targetUserId &&
				state.activeQueue === targetQueue
			) {
				state.realLoading = false;
			}
		}
	}

	return {
		state,
		runEffect,
		selectQueue,
		getUrl: () => currentUrl,
		setUrl: (u) => {
			currentUrl = u;
		},
		getRedirectedTo: () => redirectedTo,
		getLastAbortController: () => incidentAbortController
	};
}

test('SoporteFlow — Etapa 5.4J-B: Integración UI de Colas Reales de Incidencias', async (t) => {
	// =========================================================================
	// 1. ANÁLISIS ESTÁTICO DE PLANTILLAS Y TABS ACCESIBLES
	// =========================================================================

	await t.test('1. aparecen las tres colas en el bloque real de /app/+page.svelte', () => {
		const pagePath = path.join(root, 'src/routes/app/+page.svelte');
		const content = fs.readFileSync(pagePath, 'utf8');

		assert.ok(content.includes('Mis incidencias'), 'Debe contener pestaña "Mis incidencias"');
		assert.ok(content.includes('Sin asignar'), 'Debe contener pestaña "Sin asignar"');
		assert.ok(content.includes('Todas'), 'Debe contener pestaña "Todas"');
		assert.ok(content.includes('role="tablist"'), 'Debe contener contenedor con role="tablist"');
		assert.ok(content.includes('role="tab"'), 'Debe contener elementos con role="tab"');
		assert.ok(content.includes('aria-selected='), 'Debe incluir aria-selected para accesibilidad');
		assert.ok(content.includes('data-testid="queue-tab-mine"'), 'TestId mine presente');
		assert.ok(content.includes('data-testid="queue-tab-unassigned"'), 'TestId unassigned presente');
		assert.ok(content.includes('data-testid="queue-tab-all"'), 'TestId all presente');
	});

	// =========================================================================
	// 2. PARSEO Y NORMALIZACIÓN DE URL (all por defecto, mine, unassigned, invalid)
	// =========================================================================

	await t.test('2. all activa por defecto si la URL no incluye queue', async () => {
		const org = { id: randomUUID(), name: 'Org A' };
		const coordinator = createQueueCoordinator({
			initialUrl: '/app',
			fetchFn: async (url) => {
				assert.ok(url.includes('queue=all'));
				return new Response(JSON.stringify({ incidents: [] }), { status: 200 });
			}
		});

		await coordinator.runEffect({
			isAuthenticated: true,
			user: { id: randomUUID() },
			activeOrganization: org
		});

		assert.equal(coordinator.state.activeQueue, 'all');
	});

	await t.test('3. ?queue=mine activa mine', async () => {
		const org = { id: randomUUID(), name: 'Org A' };
		const coordinator = createQueueCoordinator({
			initialUrl: '/app?queue=mine',
			fetchFn: async (url) => {
				assert.ok(url.includes('queue=mine'));
				return new Response(JSON.stringify({ incidents: [] }), { status: 200 });
			}
		});

		await coordinator.runEffect({
			isAuthenticated: true,
			user: { id: randomUUID() },
			activeOrganization: org
		});

		assert.equal(coordinator.state.activeQueue, 'mine');
	});

	await t.test('4. ?queue=unassigned activa unassigned', async () => {
		const org = { id: randomUUID(), name: 'Org A' };
		const coordinator = createQueueCoordinator({
			initialUrl: '/app?queue=unassigned',
			fetchFn: async (url) => {
				assert.ok(url.includes('queue=unassigned'));
				return new Response(JSON.stringify({ incidents: [] }), { status: 200 });
			}
		});

		await coordinator.runEffect({
			isAuthenticated: true,
			user: { id: randomUUID() },
			activeOrganization: org
		});

		assert.equal(coordinator.state.activeQueue, 'unassigned');
	});

	await t.test('5. ?queue=all activa all', async () => {
		const org = { id: randomUUID(), name: 'Org A' };
		const coordinator = createQueueCoordinator({
			initialUrl: '/app?queue=all',
			fetchFn: async (url) => {
				assert.ok(url.includes('queue=all'));
				return new Response(JSON.stringify({ incidents: [] }), { status: 200 });
			}
		});

		await coordinator.runEffect({
			isAuthenticated: true,
			user: { id: randomUUID() },
			activeOrganization: org
		});

		assert.equal(coordinator.state.activeQueue, 'all');
	});

	await t.test('6. queue inválida normaliza a all', async () => {
		const org = { id: randomUUID(), name: 'Org A' };
		const coordinator = createQueueCoordinator({
			initialUrl: '/app?queue=custom_invalid_queue',
			fetchFn: async (url) => {
				assert.ok(
					url.includes('queue=all'),
					'Debe consultar con queue=all y nunca con el valor inválido'
				);
				return new Response(JSON.stringify({ incidents: [] }), { status: 200 });
			}
		});

		await coordinator.runEffect({
			isAuthenticated: true,
			user: { id: randomUUID() },
			activeOrganization: org
		});

		assert.equal(coordinator.state.activeQueue, 'all');
	});

	// =========================================================================
	// 3. API CLIENT (listIncidents recibe queue correcta)
	// =========================================================================

	await t.test('7. listIncidents recibe queue correcta en query string', async () => {
		const orgId = randomUUID();
		const urlsCalled = [];
		const mockFetch = async (url) => {
			urlsCalled.push(url);
			return new Response(JSON.stringify({ incidents: [] }), { status: 200 });
		};

		await listIncidents(orgId, { queue: 'mine', customFetch: mockFetch });
		assert.equal(urlsCalled[0], `/api/incidents?organizationId=${orgId}&queue=mine`);

		await listIncidents(orgId, { queue: 'unassigned', customFetch: mockFetch });
		assert.equal(urlsCalled[1], `/api/incidents?organizationId=${orgId}&queue=unassigned`);

		await listIncidents(orgId, { queue: 'all', customFetch: mockFetch });
		assert.equal(urlsCalled[2], `/api/incidents?organizationId=${orgId}&queue=all`);
	});

	// =========================================================================
	// 4. COORDINACIÓN DE TABS, URL Y DISPARO DE REQUESTS
	// =========================================================================

	await t.test('8. cambio de tab actualiza URL', async () => {
		const org = { id: randomUUID(), name: 'Org A' };
		const coordinator = createQueueCoordinator({
			initialUrl: '/app',
			fetchFn: async () => new Response(JSON.stringify({ incidents: [] }), { status: 200 })
		});

		const sessionState = {
			isAuthenticated: true,
			user: { id: randomUUID() },
			activeOrganization: org
		};

		await coordinator.runEffect(sessionState);
		assert.equal(coordinator.getUrl(), '/app');

		await coordinator.selectQueue('mine', sessionState);
		assert.equal(coordinator.getUrl(), '/app?queue=mine');

		await coordinator.selectQueue('unassigned', sessionState);
		assert.equal(coordinator.getUrl(), '/app?queue=unassigned');
	});

	await t.test('9. cambio de tab dispara request con la nueva cola', async () => {
		const org = { id: randomUUID(), name: 'Org A' };
		const requests = [];
		const coordinator = createQueueCoordinator({
			initialUrl: '/app?queue=all',
			fetchFn: async (url) => {
				requests.push(url);
				return new Response(JSON.stringify({ incidents: [] }), { status: 200 });
			}
		});

		const sessionState = {
			isAuthenticated: true,
			user: { id: randomUUID() },
			activeOrganization: org
		};

		await coordinator.runEffect(sessionState);
		assert.equal(requests.length, 1);
		assert.ok(requests[0].includes('queue=all'));

		await coordinator.selectQueue('mine', sessionState);
		assert.equal(requests.length, 2);
		assert.ok(requests[1].includes('queue=mine'));
	});

	await t.test('10. request anterior se aborta al cambiar de pestaña rápidamente', async () => {
		const org = { id: randomUUID(), name: 'Org A' };
		const defA = createDeferred();
		let firstSignal = null;

		const coordinator = createQueueCoordinator({
			initialUrl: '/app?queue=mine',
			fetchFn: async (url, opts) => {
				if (url.includes('queue=mine')) {
					firstSignal = opts.signal;
					await defA.promise;
					return new Response(JSON.stringify({ incidents: [] }), { status: 200 });
				}
				return new Response(JSON.stringify({ incidents: [] }), { status: 200 });
			}
		});

		const sessionState = {
			isAuthenticated: true,
			user: { id: randomUUID() },
			activeOrganization: org
		};

		// Inicia request para mine (se queda pendiente)
		coordinator.runEffect(sessionState);
		assert.equal(firstSignal.aborted, false);

		// Cambia velozmente a unassigned
		const p2 = coordinator.selectQueue('unassigned', sessionState);
		assert.equal(firstSignal.aborted, true, 'La primera señal DEBE haber sido abortada');

		defA.resolve();
		await p2;
	});

	await t.test('11. respuesta stale no sobrescribe actual', async () => {
		const org = { id: randomUUID(), name: 'Org A' };
		const incMine = makeSampleIncident({ organizationId: org.id, title: 'Ticket Mine' });
		const incUnassigned = makeSampleIncident({
			organizationId: org.id,
			title: 'Ticket Unassigned'
		});

		const defMine = createDeferred();
		const defUnassigned = createDeferred();

		const coordinator = createQueueCoordinator({
			initialUrl: '/app?queue=mine',
			fetchFn: async (url) => {
				if (url.includes('queue=mine')) {
					await defMine.promise;
					return new Response(JSON.stringify({ incidents: [incMine] }), { status: 200 });
				}
				await defUnassigned.promise;
				return new Response(JSON.stringify({ incidents: [incUnassigned] }), { status: 200 });
			}
		});

		const sessionState = {
			isAuthenticated: true,
			user: { id: randomUUID() },
			activeOrganization: org
		};

		// 1. Dispara mine (lenta)
		coordinator.runEffect(sessionState);

		// 2. Dispara unassigned (rápida)
		const pUnassigned = coordinator.selectQueue('unassigned', sessionState);

		// Unassigned termina primero
		defUnassigned.resolve();
		await pUnassigned;
		assert.equal(coordinator.state.realIncidents.length, 1);
		assert.equal(coordinator.state.realIncidents[0].title, 'Ticket Unassigned');

		// Mine termina tardíamente
		defMine.resolve();
		await new Promise((r) => setTimeout(r, 20));

		// La lista DEBE seguir siendo la de unassigned
		assert.equal(coordinator.state.realIncidents.length, 1);
		assert.equal(coordinator.state.realIncidents[0].title, 'Ticket Unassigned');
	});

	// =========================================================================
	// 5. SSR DE ESTADOS VACÍOS (RealIncidentList por cola)
	// =========================================================================

	const { svelte } = await import('@sveltejs/vite-plugin-svelte');
	const componentServer = await createServer({
		root,
		configFile: false,
		envDir: false,
		plugins: [svelte({ configFile: false })],
		server: { middlewareMode: true, hmr: false, watch: null },
		appType: 'custom'
	});
	t.after(() => componentServer.close());

	const { render } = await componentServer.ssrLoadModule('svelte/server');
	const componentModule = await componentServer.ssrLoadModule(
		'/src/lib/components/incidents/RealIncidentList.svelte'
	);
	const RealIncidentList = componentModule.default;

	await t.test('12. mine vacío muestra mensaje correcto', () => {
		const html = render(RealIncidentList, {
			props: { incidents: [], loading: false, error: null, queue: 'mine' }
		}).body;
		assert.ok(
			html.includes('No tienes incidencias asignadas actualmente.'),
			'Debe mostrar texto específico de mine'
		);
	});

	await t.test('13. unassigned vacío muestra mensaje correcto', () => {
		const html = render(RealIncidentList, {
			props: { incidents: [], loading: false, error: null, queue: 'unassigned' }
		}).body;
		assert.ok(
			html.includes('No hay incidencias sin asignar en esta organización.'),
			'Debe mostrar texto específico de unassigned'
		);
	});

	await t.test('14. all vacío muestra mensaje correcto', () => {
		const html = render(RealIncidentList, {
			props: { incidents: [], loading: false, error: null, queue: 'all' }
		}).body;
		assert.ok(
			html.includes('No hay incidencias en esta organización.'),
			'Debe mostrar texto general de all'
		);
	});

	// =========================================================================
	// 6. CONTROL DE ERRORES: 401, 403 Y PERMISOS
	// =========================================================================

	await t.test('15. 401 limpia sesión y redirige a /login?expired=true', async () => {
		const org = { id: randomUUID(), name: 'Org A' };
		const coordinator = createQueueCoordinator({
			initialUrl: '/app?queue=mine',
			fetchFn: async () => {
				return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), {
					status: 401,
					headers: { 'content-type': 'application/json' }
				});
			}
		});

		session.setSession({ user: { id: randomUUID(), name: 'U' }, organizations: [org] });

		await coordinator.runEffect({
			isAuthenticated: true,
			user: { id: randomUUID() },
			activeOrganization: org
		});

		assert.equal(coordinator.getRedirectedTo(), '/login?expired=true');
		let curSession;
		const unsub = session.subscribe((s) => (curSession = s));
		unsub();
		assert.equal(curSession.isAuthenticated, false);
	});

	await t.test('16. 403 conserva sesión', async () => {
		const org = { id: randomUUID(), name: 'Org A' };
		const user = { id: randomUUID(), name: 'User Client' };
		const coordinator = createQueueCoordinator({
			initialUrl: '/app?queue=unassigned',
			fetchFn: async () => {
				return new Response(JSON.stringify({ error: { code: 'FORBIDDEN' } }), {
					status: 403,
					headers: { 'content-type': 'application/json' }
				});
			}
		});

		session.setSession({ user, organizations: [org] });

		await coordinator.runEffect({
			isAuthenticated: true,
			user,
			activeOrganization: org
		});

		assert.equal(coordinator.getRedirectedTo(), null);
		let curSession;
		const unsub = session.subscribe((s) => (curSession = s));
		unsub();
		assert.equal(curSession.isAuthenticated, true);
	});

	await t.test('17. 403 muestra mensaje de cola sin permiso', async () => {
		const org = { id: randomUUID(), name: 'Org A' };
		const coordinator = createQueueCoordinator({
			initialUrl: '/app?queue=unassigned',
			fetchFn: async () => {
				return new Response(JSON.stringify({ error: { code: 'FORBIDDEN' } }), {
					status: 403,
					headers: { 'content-type': 'application/json' }
				});
			}
		});

		await coordinator.runEffect({
			isAuthenticated: true,
			user: { id: randomUUID() },
			activeOrganization: org
		});

		assert.equal(coordinator.state.realError, 'No tienes permisos para consultar esta cola.');
	});

	// =========================================================================
	// 7. AISLAMIENTO MULTI-TENANT Y PERSISTENCIA DE COLA
	// =========================================================================

	await t.test('18. cambio de organización mantiene queue activa', async () => {
		const org1 = { id: randomUUID(), name: 'Org 1' };
		const org2 = { id: randomUUID(), name: 'Org 2' };
		const requests = [];

		const coordinator = createQueueCoordinator({
			initialUrl: '/app?queue=mine',
			fetchFn: async (url) => {
				requests.push(url);
				return new Response(JSON.stringify({ incidents: [] }), { status: 200 });
			}
		});

		const user = { id: randomUUID(), name: 'U' };

		// Carga con Org 1
		await coordinator.runEffect({
			isAuthenticated: true,
			user,
			activeOrganization: org1
		});
		assert.equal(coordinator.state.activeQueue, 'mine');
		assert.ok(requests[0].includes(`organizationId=${org1.id}`));
		assert.ok(requests[0].includes('queue=mine'));

		// Cambia a Org 2
		await coordinator.runEffect({
			isAuthenticated: true,
			user,
			activeOrganization: org2
		});
		assert.equal(coordinator.state.activeQueue, 'mine');
		assert.ok(requests[1].includes(`organizationId=${org2.id}`));
		assert.ok(requests[1].includes('queue=mine'));
	});

	await t.test('19. no filtra incidencias localmente', async () => {
		const orgId = randomUUID();
		const inc1 = makeSampleIncident({ organizationId: orgId, assignedToUserId: randomUUID() });
		const inc2 = makeSampleIncident({ organizationId: orgId, assignedToUserId: null });

		// listIncidents devuelve exactamente lo que el servidor envía
		const mockFetch = async () => {
			return new Response(JSON.stringify({ incidents: [inc1, inc2] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		};

		const result = await listIncidents(orgId, {
			queue: 'mine',
			customFetch: mockFetch
		});

		assert.equal(result.length, 2);
		assert.equal(result[0].id, inc1.id);
		assert.equal(result[1].id, inc2.id);
	});

	await t.test('20. demo permanece aislada de las colas reales', () => {
		const pagePath = path.join(root, 'src/routes/app/+page.svelte');
		const content = fs.readFileSync(pagePath, 'utf8');

		const realSection = content.substring(
			content.indexOf('Incidencias reales'),
			content.indexOf('<!-- Zona demo')
		);

		assert.ok(!realSection.includes('demoIncidents'));
		assert.ok(!realSection.includes('demoUsers'));
		assert.ok(!realSection.includes('localStorage.getItem(INCIDENTS_KEY'));
	});

	await t.test('21. no usa roles/demoUsers para inferir permisos u ocultar tabs', () => {
		const pagePath = path.join(root, 'src/routes/app/+page.svelte');
		const content = fs.readFileSync(pagePath, 'utf8');

		const tablistArea = content.substring(
			content.indexOf('role="tablist"'),
			content.indexOf('</RealIncidentList>') !== -1
				? content.indexOf('</RealIncidentList>')
				: content.indexOf('<RealIncidentList')
		);

		// No debe condicionar la aparición de ningún botón según rol de usuario
		assert.ok(!tablistArea.includes("role === 'technician'"));
		assert.ok(!tablistArea.includes("role === 'admin'"));
		assert.ok(!tablistArea.includes("role === 'client'"));
		assert.ok(tablistArea.includes('queue-tab-mine'));
		assert.ok(tablistArea.includes('queue-tab-unassigned'));
		assert.ok(tablistArea.includes('queue-tab-all'));
	});
});

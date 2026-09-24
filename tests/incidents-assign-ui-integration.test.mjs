import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAssignees, assignIncident, IncidentApiError } from '../src/lib/api/incidents.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeSampleIncident(overrides = {}) {
	const orgId = overrides.organizationId ?? randomUUID();
	const incId = overrides.id ?? randomUUID();
	return {
		id: incId,
		organizationId: orgId,
		incidentNumber: 101,
		title: 'Fallo en servicio de correo',
		description: 'Los usuarios no pueden enviar correos externos.',
		status: 'open',
		priority: 'high',
		client: 'Acme Corp',
		clientUserId: null,
		createdByUserId: randomUUID(),
		siteId: null,
		assignedToUserId: null,
		assignedToUserName: null,
		createdAt: '2026-09-23T12:00:00.000Z',
		updatedAt: '2026-09-23T12:30:00.000Z',
		...overrides
	};
}

/**
 * Simulates the assignment coordinator logic in src/routes/app/incidents/[id]/+page.svelte.
 */
function createAssignCoordinator(initialIncident, options = {}) {
	const listAssigneesFn = options.listAssigneesFn ?? listAssignees;
	const assignIncidentFn = options.assignIncidentFn ?? assignIncident;

	const state = {
		incident: initialIncident ? { ...initialIncident } : null,
		isAssigning: false,
		assignees: options.initialAssignees ? [...options.initialAssignees] : [],
		assigneesLoading: false,
		assignmentSubmitting: false,
		assignmentError: null
	};

	let assignAbortController = null;

	async function openAssign(orgId, gotoFn, sessionStore) {
		if (state.assignmentSubmitting) return;
		state.isAssigning = true;
		state.assignmentError = null;

		if (!orgId) return;

		if (state.assignees.length === 0) {
			state.assigneesLoading = true;
			try {
				const list = await listAssigneesFn(orgId);
				state.assignees = list;
			} catch (err) {
				if (err instanceof IncidentApiError && err.status === 401) {
					sessionStore?.clearSession();
					if (gotoFn) await gotoFn('/login?expired=true');
					return;
				}
				if (err instanceof IncidentApiError) {
					if (err.status === 403) {
						state.assignmentError = 'No tienes permisos para asignar incidencias.';
					} else {
						state.assignmentError = err.message;
					}
				} else {
					state.assignmentError = 'No se pudieron cargar los técnicos disponibles.';
				}
			} finally {
				state.assigneesLoading = false;
			}
		}
	}

	function cancelAssign() {
		if (state.assignmentSubmitting) return;
		state.isAssigning = false;
		state.assignmentError = null;
	}

	async function saveAssign(data, orgId, gotoFn, sessionStore) {
		if (state.assignmentSubmitting || !state.incident || !orgId) return;

		// No-op check: if user selects the existing assignee
		if (data.assignedToUserId === state.incident.assignedToUserId) {
			cancelAssign();
			return;
		}

		state.assignmentSubmitting = true;
		state.assignmentError = null;

		if (assignAbortController) {
			assignAbortController.abort();
		}
		const controller = new AbortController();
		assignAbortController = controller;

		try {
			const updated = await assignIncidentFn(orgId, state.incident.id, data, {
				signal: controller.signal
			});

			// Resolve readable technician name from assignees catalog if missing
			const techName =
				updated.assignedToUserName ??
				state.assignees.find((a) => a.id === updated.assignedToUserId)?.name ??
				null;

			state.incident = {
				...updated,
				assignedToUserName: techName
			};
			state.isAssigning = false;
			state.assignmentError = null;
		} catch (err) {
			if (err?.name === 'AbortError' || controller.signal.aborted) {
				return;
			}
			if (err instanceof IncidentApiError && err.status === 401) {
				sessionStore?.clearSession();
				if (gotoFn) await gotoFn('/login?expired=true');
				return;
			}
			if (err instanceof IncidentApiError) {
				if (err.status === 403) {
					state.assignmentError = 'No tienes permisos para asignar esta incidencia.';
				} else if (err.status === 404) {
					state.assignmentError = 'No se pudo realizar la asignación.';
				} else {
					state.assignmentError = err.message;
				}
			} else {
				state.assignmentError = 'No se pudo asignar la incidencia. Inténtalo de nuevo.';
			}
		} finally {
			state.assignmentSubmitting = false;
		}
	}

	return {
		state,
		openAssign,
		cancelAssign,
		saveAssign,
		getAbortController: () => assignAbortController
	};
}

test('SoporteFlow — Etapa 5.4I-B: UI Real de Asignación y Reasignación de Técnico', async (t) => {
	// Vite SSR setup for component rendering
	const { createServer } = await import('vite');
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
	const detailModule = await componentServer.ssrLoadModule(
		'/src/lib/components/incidents/RealIncidentDetail.svelte'
	);
	const RealIncidentDetail = detailModule.default;
	const assignFormModule = await componentServer.ssrLoadModule(
		'/src/lib/components/incidents/RealIncidentAssignForm.svelte'
	);
	const RealIncidentAssignForm = assignFormModule.default;

	// 1. muestra "Sin asignar"
	await t.test('1. muestra "Sin asignar" cuando no hay técnico asignado', () => {
		const item = makeSampleIncident({
			assignedToUserId: null,
			assignedToUserName: null
		});

		const html = render(RealIncidentDetail, {
			props: { incident: item, loading: false, error: null }
		}).body;

		assert.ok(html.includes('Sin asignar'), 'Debe mostrar texto "Sin asignar"');
		assert.ok(html.includes('Asignado a'), 'Debe incluir el encabezado "Asignado a"');
	});

	// 2. muestra nombre técnico existente
	await t.test('2. muestra nombre técnico existente cuando está asignado', () => {
		const item = makeSampleIncident({
			assignedToUserId: randomUUID(),
			assignedToUserName: 'Carlos Guardado'
		});

		const html = render(RealIncidentDetail, {
			props: { incident: item, loading: false, error: null }
		}).body;

		assert.ok(html.includes('Carlos Guardado'), 'Debe mostrar el nombre del técnico');
		assert.equal(html.includes('Sin asignar'), false, 'No debe mostrar "Sin asignar"');
	});

	// 3. botón "Asignar técnico"
	await t.test('3. botón "Asignar técnico" aparece si no hay técnico y se pasa onAssign', () => {
		const item = makeSampleIncident({ assignedToUserId: null });

		const html = render(RealIncidentDetail, {
			props: {
				incident: item,
				loading: false,
				error: null,
				onAssign: () => {}
			}
		}).body;

		assert.ok(html.includes('Asignar técnico'), 'Debe mostrar botón "Asignar técnico"');
		assert.equal(html.includes('Reasignar'), false, 'No debe mostrar botón "Reasignar"');
	});

	// 4. botón "Reasignar"
	await t.test('4. botón "Reasignar" aparece si ya hay técnico y se pasa onAssign', () => {
		const item = makeSampleIncident({
			assignedToUserId: randomUUID(),
			assignedToUserName: 'Elena Vega'
		});

		const html = render(RealIncidentDetail, {
			props: {
				incident: item,
				loading: false,
				error: null,
				onAssign: () => {}
			}
		}).body;

		assert.ok(html.includes('Reasignar'), 'Debe mostrar botón "Reasignar"');
		assert.equal(
			html.includes('Asignar técnico'),
			false,
			'No debe mostrar botón "Asignar técnico"'
		);
	});

	// 5. carga catálogo real
	await t.test('5. carga catálogo real con listAssignees()', async () => {
		const orgId = randomUUID();
		let invokedUrl = '';

		const mockFetch = async (url) => {
			invokedUrl = url;
			return new Response(
				JSON.stringify({
					assignees: [
						{ id: randomUUID(), name: 'Técnico Alfa' },
						{ id: randomUUID(), name: 'Técnico Beta' }
					]
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const result = await listAssignees(orgId, { customFetch: mockFetch });

		assert.equal(
			invokedUrl,
			`/api/incidents/assignees?organizationId=${encodeURIComponent(orgId)}`
		);
		assert.equal(result.length, 2);
		assert.equal(result[0].name, 'Técnico Alfa');
		assert.equal(result[1].name, 'Técnico Beta');
	});

	// 6. no usa demoUsers
	await t.test('6. no usa demoUsers ni almacén demo', () => {
		const formSrc = fs.readFileSync(
			path.join(root, 'src/lib/components/incidents/RealIncidentAssignForm.svelte'),
			'utf-8'
		);
		const detailSrc = fs.readFileSync(
			path.join(root, 'src/lib/components/incidents/RealIncidentDetail.svelte'),
			'utf-8'
		);
		const pageSrc = fs.readFileSync(
			path.join(root, 'src/routes/app/incidents/[id]/+page.svelte'),
			'utf-8'
		);

		for (const src of [formSrc, detailSrc, pageSrc]) {
			assert.equal(src.includes('demoUsers'), false, 'No debe referenciar demoUsers');
			assert.equal(src.includes('demoIncidents'), false, 'No debe referenciar demoIncidents');
			assert.equal(src.includes('localStorage'), false, 'No debe usar localStorage');
		}
	});

	// 7. selector muestra nombres
	await t.test('7. selector muestra nombres legibles de técnicos y no UUIDs', () => {
		const tech1Id = randomUUID();
		const tech2Id = randomUUID();
		const assignees = [
			{ id: tech1Id, name: 'Ana Martínez' },
			{ id: tech2Id, name: 'Bernardo Silva' }
		];

		const html = render(RealIncidentAssignForm, {
			props: {
				currentAssigneeUserId: null,
				assignees,
				onSave: () => {},
				onCancel: () => {}
			}
		}).body;

		assert.ok(html.includes('Ana Martínez'), 'Debe incluir nombre de Ana');
		assert.ok(html.includes('Bernardo Silva'), 'Debe incluir nombre de Bernardo');
		assert.ok(html.includes('for="assign-technician"'), 'Debe contener label para el selector');
	});

	// 8. primera asignación sin reason
	await t.test('8. primera asignación: no muestra campo de motivo en SSR inicial', () => {
		const assignees = [{ id: randomUUID(), name: 'Ana Martínez' }];

		const html = render(RealIncidentAssignForm, {
			props: {
				currentAssigneeUserId: null,
				assignees,
				onSave: () => {},
				onCancel: () => {}
			}
		}).body;

		assert.equal(
			html.includes('Motivo de la reasignación'),
			false,
			'No debe pedir motivo en primera asignación'
		);
		assert.ok(html.includes('Asignar técnico'), 'Botón submit debe indicar "Asignar técnico"');
	});

	// 9. reasignación muestra reason cuando cambia técnico
	await t.test('9. reasignación: estructura del formulario contempla motivo condicional', () => {
		const formSrc = fs.readFileSync(
			path.join(root, 'src/lib/components/incidents/RealIncidentAssignForm.svelte'),
			'utf-8'
		);
		assert.ok(formSrc.includes('Motivo de la reasignación'), 'Debe tener soporte para motivo');
		assert.ok(formSrc.includes('requiresReason'), 'Debe evaluar requiresReason');
		assert.ok(formSrc.includes('assign-reason'), 'Debe tener id assign-reason');
	});

	// 10. reason obligatorio frontend
	await t.test('10. reason obligatorio frontend en reasignación', () => {
		const formSrc = fs.readFileSync(
			path.join(root, 'src/lib/components/incidents/RealIncidentAssignForm.svelte'),
			'utf-8'
		);
		assert.ok(formSrc.includes('cleanReason.length === 0'), 'Debe validar longitud del motivo');
		assert.ok(
			formSrc.includes('Debes indicar el motivo de la reasignación'),
			'Debe mostrar error si falta motivo'
		);
	});

	// 11. same assignee => no API
	await t.test('11. same assignee => no API y cancela edición (no-op)', async () => {
		const techId = randomUUID();
		const orgId = randomUUID();
		const incident = makeSampleIncident({
			organizationId: orgId,
			assignedToUserId: techId,
			assignedToUserName: 'Técnico Actual'
		});

		let apiCalled = false;
		const coordinator = createAssignCoordinator(incident, {
			assignIncidentFn: async () => {
				apiCalled = true;
				return incident;
			}
		});

		coordinator.state.isAssigning = true;
		await coordinator.saveAssign({ assignedToUserId: techId }, orgId);

		assert.equal(apiCalled, false, 'No debe llamar a la API si el técnico es el mismo');
		assert.equal(coordinator.state.isAssigning, false, 'Debe cerrar la edición');
	});

	// 12. submit correcto
	await t.test(
		'12. submit correcto envía payload con assignedToUserId y reason opcional',
		async () => {
			const orgId = randomUUID();
			const incId = randomUUID();
			const techId = randomUUID();

			let sentBody = null;
			let sentUrl = '';

			const mockFetch = async (url, opts) => {
				sentUrl = url;
				sentBody = JSON.parse(opts.body);
				return new Response(
					JSON.stringify({
						incident: makeSampleIncident({
							id: incId,
							organizationId: orgId,
							assignedToUserId: techId
						})
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			};

			const updated = await assignIncident(
				orgId,
				incId,
				{ assignedToUserId: techId, reason: 'Cambio de turno' },
				{ customFetch: mockFetch }
			);

			assert.ok(sentUrl.includes(`/api/incidents/${incId}/assign`));
			assert.equal(sentBody.assignedToUserId, techId);
			assert.equal(sentBody.reason, 'Cambio de turno');
			assert.equal(updated.assignedToUserId, techId);
		}
	);

	// 13. actualiza nombre tras success
	await t.test('13. actualiza nombre tras success usando catálogo assignees local', async () => {
		const orgId = randomUUID();
		const techId = randomUUID();
		const initialIncident = makeSampleIncident({
			organizationId: orgId,
			assignedToUserId: null,
			assignedToUserName: null
		});

		const assignees = [{ id: techId, name: 'Marcos Soto' }];

		const coordinator = createAssignCoordinator(initialIncident, {
			initialAssignees: assignees,
			assignIncidentFn: async () => {
				return makeSampleIncident({
					id: initialIncident.id,
					organizationId: orgId,
					assignedToUserId: techId,
					assignedToUserName: null // Server response does NOT include name
				});
			}
		});

		await coordinator.saveAssign({ assignedToUserId: techId }, orgId);

		assert.equal(coordinator.state.incident.assignedToUserId, techId);
		assert.equal(coordinator.state.incident.assignedToUserName, 'Marcos Soto');
		assert.equal(coordinator.state.isAssigning, false);
	});

	// 14. double-submit bloqueado
	await t.test('14. double-submit bloqueado mientras guarda', async () => {
		const orgId = randomUUID();
		const techId = randomUUID();
		const incident = makeSampleIncident({ organizationId: orgId });

		let callCount = 0;
		let resolveCall;
		const callPromise = new Promise((res) => {
			resolveCall = res;
		});

		const coordinator = createAssignCoordinator(incident, {
			assignIncidentFn: async () => {
				callCount++;
				await callPromise;
				return makeSampleIncident({ ...incident, assignedToUserId: techId });
			}
		});

		// Trigger first save
		const p1 = coordinator.saveAssign({ assignedToUserId: techId }, orgId);
		assert.equal(coordinator.state.assignmentSubmitting, true);

		// Trigger second save while first is in progress
		const p2 = coordinator.saveAssign({ assignedToUserId: techId }, orgId);

		resolveCall();
		await Promise.all([p1, p2]);

		assert.equal(callCount, 1, 'Solo se debe ejecutar una llamada a assignIncident');
		assert.equal(coordinator.state.assignmentSubmitting, false);
	});

	// 15. 401 limpia sesión/redirige
	await t.test('15. 401 limpia sesión y redirige a /login?expired=true', async () => {
		const orgId = randomUUID();
		const incident = makeSampleIncident({ organizationId: orgId });

		let sessionCleared = false;
		let redirectedTo = null;

		const sessionStore = {
			clearSession: () => {
				sessionCleared = true;
			}
		};
		const gotoFn = async (path) => {
			redirectedTo = path;
		};

		const coordinator = createAssignCoordinator(incident, {
			assignIncidentFn: async () => {
				throw new IncidentApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida.');
			}
		});

		await coordinator.saveAssign({ assignedToUserId: randomUUID() }, orgId, gotoFn, sessionStore);

		assert.equal(sessionCleared, true, 'Debe limpiar la sesión ante 401');
		assert.equal(redirectedTo, '/login?expired=true', 'Debe redirigir a login');
	});

	// 16. 403 preserva sesión
	await t.test('16. 403 preserva sesión y muestra error controlado', async () => {
		const orgId = randomUUID();
		const incident = makeSampleIncident({ organizationId: orgId });

		let sessionCleared = false;
		const sessionStore = {
			clearSession: () => {
				sessionCleared = true;
			}
		};

		const coordinator = createAssignCoordinator(incident, {
			assignIncidentFn: async () => {
				throw new IncidentApiError(403, 'FORBIDDEN', 'Permission denied');
			}
		});

		await coordinator.saveAssign({ assignedToUserId: randomUUID() }, orgId, null, sessionStore);

		assert.equal(sessionCleared, false, 'No debe cerrar sesión ante 403');
		assert.equal(
			coordinator.state.assignmentError,
			'No tienes permisos para asignar esta incidencia.'
		);
		assert.ok(coordinator.state.incident, 'El detalle de la incidencia debe permanecer');
	});

	// 17. 404 mensaje seguro
	await t.test('17. 404 muestra mensaje seguro sin filtrar detalles internos', async () => {
		const orgId = randomUUID();
		const incident = makeSampleIncident({ organizationId: orgId });

		const coordinator = createAssignCoordinator(incident, {
			assignIncidentFn: async () => {
				throw new IncidentApiError(404, 'NOT_FOUND', 'Not found');
			}
		});

		await coordinator.saveAssign({ assignedToUserId: randomUUID() }, orgId);

		assert.equal(coordinator.state.assignmentError, 'No se pudo realizar la asignación.');
	});

	// 18. 400 mensaje seguro
	await t.test('18. 400 muestra mensaje seguro de validación', async () => {
		const orgId = randomUUID();
		const incident = makeSampleIncident({ organizationId: orgId });

		const coordinator = createAssignCoordinator(incident, {
			assignIncidentFn: async () => {
				throw new IncidentApiError(400, 'INVALID_INPUT', 'Los datos de asignación son inválidos.');
			}
		});

		await coordinator.saveAssign({ assignedToUserId: randomUUID() }, orgId);

		assert.equal(coordinator.state.assignmentError, 'Los datos de asignación son inválidos.');
	});

	// 19. cancel conserva incidencia
	await t.test('19. cancel conserva incidencia y estado previo', () => {
		const incident = makeSampleIncident();
		const coordinator = createAssignCoordinator(incident);

		coordinator.state.isAssigning = true;
		coordinator.state.assignmentError = 'Algún error previo';

		coordinator.cancelAssign();

		assert.equal(coordinator.state.isAssigning, false);
		assert.equal(coordinator.state.assignmentError, null);
		assert.deepEqual(coordinator.state.incident, incident);
	});

	// 20. no UUIDs visibles
	await t.test('20. no UUIDs visibles en el DOM del detalle ni en opciones del formulario', () => {
		const rawUserId = '12345678-aaaa-bbbb-cccc-111122223333';
		const item = makeSampleIncident({
			assignedToUserId: rawUserId,
			assignedToUserName: 'Paula Rivas'
		});

		const detailHtml = render(RealIncidentDetail, {
			props: { incident: item, loading: false, error: null }
		}).body;

		assert.equal(
			detailHtml.includes(rawUserId),
			false,
			'UUID de asignado no debe aparecer en el DOM de detalle'
		);
		assert.ok(detailHtml.includes('Paula Rivas'));

		const formHtml = render(RealIncidentAssignForm, {
			props: {
				currentAssigneeUserId: rawUserId,
				currentAssigneeUserName: 'Paula Rivas',
				assignees: [{ id: rawUserId, name: 'Paula Rivas' }],
				onSave: () => {},
				onCancel: () => {}
			}
		}).body;

		// The value attribute contains the ID, but user-visible text must only be the name
		assert.ok(formHtml.includes('>Paula Rivas (Actual)<') || formHtml.includes('>Paula Rivas<'));
		assert.equal(
			formHtml.includes(`>${rawUserId}<`),
			false,
			'El texto visible de la opción no debe ser el UUID'
		);
	});
});

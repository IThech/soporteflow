import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	listTeams,
	listAssignees,
	assignIncident,
	IncidentApiError
} from '../src/lib/api/incidents.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeSampleIncident(overrides = {}) {
	const orgId = overrides.organizationId ?? randomUUID();
	const incId = overrides.id ?? randomUUID();
	return {
		id: incId,
		organizationId: orgId,
		incidentNumber: 102,
		title: 'Problema de conectividad en sede central',
		description: 'Los switches del rack principal no responden a SNMP.',
		status: 'open',
		priority: 'high',
		client: 'Empresa Demo Corp',
		clientUserId: null,
		createdByUserId: randomUUID(),
		siteId: null,
		teamId: null,
		teamName: null,
		assignedToUserId: null,
		assignedToUserName: null,
		supportLevel: overrides.supportLevel ?? 'N1',
		createdAt: '2026-09-24T10:00:00.000Z',
		updatedAt: '2026-09-24T10:30:00.000Z',
		...overrides
	};
}

/**
 * Simulates the team & assignee assignment coordinator logic in
 * src/routes/app/incidents/[id]/+page.svelte.
 */
function createTeamAssignCoordinator(initialIncident, options = {}) {
	const listTeamsFn = options.listTeamsFn ?? listTeams;
	const listAssigneesFn = options.listAssigneesFn ?? listAssignees;
	const assignIncidentFn = options.assignIncidentFn ?? assignIncident;

	const cachedTeams = options.initialTeams ? [...options.initialTeams] : [];
	const cachedAssigneesByTeam = options.initialAssigneesCache
		? { ...options.initialAssigneesCache }
		: {};

	const state = {
		incident: initialIncident ? { ...initialIncident } : null,
		isAssigning: false,
		teams: cachedTeams,
		teamsLoading: false,
		assignees: options.initialAssignees ? [...options.initialAssignees] : [],
		assigneesLoading: false,
		assignmentSubmitting: false,
		assignmentError: null
	};

	let assignAbortController = null;
	let assigneesAbortController = null;
	let assigneesRequestId = 0;

	async function loadAssigneesForTeam(orgId, teamId) {
		const cacheKey = teamId ?? '__ALL__';
		if (cachedAssigneesByTeam[cacheKey]) {
			state.assignees = cachedAssigneesByTeam[cacheKey];
			return;
		}

		assigneesRequestId += 1;
		const thisRequestId = assigneesRequestId;

		if (assigneesAbortController) {
			assigneesAbortController.abort();
		}
		const controller = new AbortController();
		assigneesAbortController = controller;

		state.assigneesLoading = true;
		try {
			const fetched = await listAssigneesFn(orgId, {
				...(teamId ? { teamId } : {}),
				signal: controller.signal
			});

			if (thisRequestId !== assigneesRequestId) {
				return;
			}

			cachedAssigneesByTeam[cacheKey] = fetched;
			state.assignees = fetched;
		} catch (err) {
			if (thisRequestId !== assigneesRequestId) {
				return;
			}
			if (err?.name === 'AbortError' || controller.signal.aborted) {
				return;
			}
			if (err instanceof IncidentApiError && err.status === 401) {
				throw err;
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
			if (thisRequestId === assigneesRequestId) {
				state.assigneesLoading = false;
			}
		}
	}

	async function openAssign(orgId, gotoFn, sessionStore) {
		if (state.assignmentSubmitting) return;
		state.isAssigning = true;
		state.assignmentError = null;

		if (!orgId || !state.incident) return;

		// 1. Load teams if not cached
		if (state.teams.length === 0) {
			state.teamsLoading = true;
			try {
				const fetchedTeams = await listTeamsFn(orgId);
				state.teams = fetchedTeams;
			} catch (err) {
				if (err instanceof IncidentApiError && err.status === 401) {
					sessionStore?.clearSession();
					if (gotoFn) await gotoFn('/login?expired=true');
					return;
				}
				if (err instanceof IncidentApiError) {
					if (err.status === 403) {
						state.assignmentError =
							'No tienes permisos para consultar los equipos de esta organización.';
					} else {
						state.assignmentError = err.message;
					}
				} else {
					state.assignmentError = 'No se pudieron cargar los equipos disponibles.';
				}
				state.teamsLoading = false;
				return;
			} finally {
				state.teamsLoading = false;
			}
		}

		// 2. Load assignees for initial team
		try {
			await loadAssigneesForTeam(orgId, state.incident.teamId ?? null);
		} catch (err) {
			if (err instanceof IncidentApiError && err.status === 401) {
				sessionStore?.clearSession();
				if (gotoFn) await gotoFn('/login?expired=true');
			}
		}
	}

	async function changeTeam(newTeamId, orgId) {
		if (!orgId) return;
		state.assignmentError = null;
		await loadAssigneesForTeam(orgId, newTeamId);
	}

	function cancelAssign() {
		if (state.assignmentSubmitting) return;
		state.isAssigning = false;
		state.assignmentError = null;
	}

	async function saveAssign(data, orgId, gotoFn, sessionStore) {
		if (state.assignmentSubmitting || !state.incident || !orgId) return;

		// No-op check: both team and technician remain identical
		const initialTeamId = state.incident.teamId ?? null;
		const initialUserId = state.incident.assignedToUserId ?? null;
		const finalTeamId = data.teamId ?? null;
		const finalUserId = data.assignedToUserId ?? null;

		if (finalTeamId === initialTeamId && finalUserId === initialUserId) {
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

			// Resolve readable team name and technician name from local catalogs if missing in response
			const resolvedTeamName =
				updated.teamName ??
				(updated.teamId ? (state.teams.find((t) => t.id === updated.teamId)?.name ?? null) : null);
			const resolvedTechName =
				updated.assignedToUserName ??
				(updated.assignedToUserId
					? (state.assignees.find((a) => a.id === updated.assignedToUserId)?.name ?? null)
					: null);

			state.incident = {
				...updated,
				teamName: resolvedTeamName,
				assignedToUserName: resolvedTechName
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
		changeTeam,
		cancelAssign,
		saveAssign,
		loadAssigneesForTeam,
		getAssignAbortController: () => assignAbortController,
		getAssigneesAbortController: () => assigneesAbortController
	};
}

test('SoporteFlow — Etapa 5.4K-B: UI Real de Equipos y Técnico en Incidencias', async (t) => {
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

	// 1. muestra "Sin equipo"
	await t.test('1. muestra "Sin equipo" en detalle cuando no tiene equipo asignado', () => {
		const item = makeSampleIncident({ teamId: null, teamName: null });
		const html = render(RealIncidentDetail, {
			props: { incident: item, loading: false, error: null }
		}).body;

		assert.ok(html.includes('Sin equipo'), 'Debe mostrar texto "Sin equipo"');
		assert.ok(html.includes('Equipo'), 'Debe incluir el encabezado "Equipo"');
	});

	// 2. muestra nombre de equipo actual
	await t.test('2. muestra nombre de equipo actual en detalle cuando está asignado', () => {
		const item = makeSampleIncident({
			teamId: randomUUID(),
			teamName: 'Soporte Nivel 1 - Hardware'
		});
		const html = render(RealIncidentDetail, {
			props: { incident: item, loading: false, error: null }
		}).body;

		assert.ok(html.includes('Soporte Nivel 1 - Hardware'), 'Debe mostrar el nombre del equipo');
		assert.equal(html.includes('Sin equipo'), false, 'No debe mostrar "Sin equipo"');
	});

	// 3. carga equipos reales
	await t.test('3. carga equipos reales con listTeams()', async () => {
		const orgId = randomUUID();
		let invokedUrl = '';

		const mockFetch = async (url) => {
			invokedUrl = url;
			return new Response(
				JSON.stringify({
					teams: [
						{ id: randomUUID(), name: 'Equipo Redes', description: 'Atención a infraestructura' },
						{ id: randomUUID(), name: 'Equipo Servidores', description: null }
					]
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const result = await listTeams(orgId, { customFetch: mockFetch });

		assert.equal(invokedUrl, `/api/teams?organizationId=${encodeURIComponent(orgId)}`);
		assert.equal(result.length, 2);
		assert.equal(result[0].name, 'Equipo Redes');
		assert.equal(result[1].name, 'Equipo Servidores');
	});

	// 4. no usa equipos demo
	await t.test('4. no usa equipos demo ni almacenes locales', () => {
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
			assert.equal(src.includes('demoTeams'), false, 'No debe referenciar demoTeams');
			assert.equal(src.includes('demoUsers'), false, 'No debe referenciar demoUsers');
			assert.equal(src.includes('demoIncidents'), false, 'No debe referenciar demoIncidents');
			assert.equal(src.includes('localStorage'), false, 'No debe usar localStorage');
		}
	});

	// 5. selector muestra nombres
	await t.test('5. selector muestra nombres legibles de equipos y no UUIDs', () => {
		const team1Id = randomUUID();
		const team2Id = randomUUID();
		const teams = [
			{ id: team1Id, name: 'Comunicaciones y VoIP', description: null },
			{ id: team2Id, name: 'Sistemas Cloud', description: null }
		];

		const html = render(RealIncidentAssignForm, {
			props: {
				currentTeamId: null,
				currentAssigneeUserId: null,
				teams,
				assignees: [],
				onSave: () => {},
				onCancel: () => {}
			}
		}).body;

		assert.ok(html.includes('Comunicaciones y VoIP'), 'Debe incluir nombre de Comunicaciones');
		assert.ok(html.includes('Sistemas Cloud'), 'Debe incluir nombre de Sistemas Cloud');
		assert.ok(html.includes('for="assign-team"'), 'Debe contener label para el selector de equipo');
		assert.ok(html.includes('Sin equipo'), 'Debe incluir opción Sin equipo');
	});

	// 6. team actual preseleccionado
	await t.test('6. team actual preseleccionado con indicador (Actual)', () => {
		const currentTeamId = randomUUID();
		const teams = [
			{ id: currentTeamId, name: 'Soporte Redes', description: null },
			{ id: randomUUID(), name: 'Soporte Sistemas', description: null }
		];

		const html = render(RealIncidentAssignForm, {
			props: {
				currentTeamId,
				currentAssigneeUserId: null,
				teams,
				assignees: [],
				onSave: () => {},
				onCancel: () => {}
			}
		}).body;

		assert.ok(html.includes('Soporte Redes (Actual)'), 'Debe marcar el equipo actual');
	});

	// 7. team change carga assignees filtrados
	await t.test('7. team change carga assignees filtrados con teamId query param', async () => {
		const orgId = randomUUID();
		const teamId = randomUUID();
		let invokedUrl = '';

		const mockFetch = async (url) => {
			invokedUrl = url;
			return new Response(
				JSON.stringify({
					assignees: [{ id: randomUUID(), name: 'Especialista Redes' }]
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const result = await listAssignees(orgId, { teamId, customFetch: mockFetch });

		assert.equal(
			invokedUrl,
			`/api/incidents/assignees?organizationId=${encodeURIComponent(orgId)}&teamId=${encodeURIComponent(teamId)}`
		);
		assert.equal(result.length, 1);
		assert.equal(result[0].name, 'Especialista Redes');
	});

	// 8. aborta catálogo anterior
	await t.test('8. aborta catálogo anterior en cambios rápidos de equipo', async () => {
		const orgId = randomUUID();
		const team1Id = randomUUID();
		const team2Id = randomUUID();
		const incident = makeSampleIncident({ organizationId: orgId });

		let team1Aborted = false;

		const coordinator = createTeamAssignCoordinator(incident, {
			listAssigneesFn: async (oId, opts) => {
				if (opts?.teamId === team1Id) {
					return new Promise((_, reject) => {
						opts.signal.addEventListener('abort', () => {
							team1Aborted = true;
							const err = new Error('The operation was aborted');
							err.name = 'AbortError';
							reject(err);
						});
					});
				}
				return [{ id: randomUUID(), name: 'Técnico Equipo 2' }];
			}
		});

		// Trigger fetch for team 1
		const p1 = coordinator.changeTeam(team1Id, orgId);
		// Immediately switch to team 2
		const p2 = coordinator.changeTeam(team2Id, orgId);

		await Promise.all([p1, p2]);

		assert.equal(team1Aborted, true, 'El request anterior debe ser abortado');
		assert.equal(coordinator.state.assignees.length, 1);
		assert.equal(coordinator.state.assignees[0].name, 'Técnico Equipo 2');
	});

	// 9. stale response no sobrescribe
	await t.test('9. stale response no sobrescribe estado si llega fuera de orden', async () => {
		const orgId = randomUUID();
		const team1Id = randomUUID();
		const team2Id = randomUUID();
		const incident = makeSampleIncident({ organizationId: orgId });

		let resolveTeam1;
		const team1Promise = new Promise((res) => {
			resolveTeam1 = res;
		});

		const coordinator = createTeamAssignCoordinator(incident, {
			listAssigneesFn: async (oId, opts) => {
				if (opts?.teamId === team1Id) {
					await team1Promise;
					return [{ id: randomUUID(), name: 'Técnico Lento de Equipo 1' }];
				}
				return [{ id: randomUUID(), name: 'Técnico Rápido de Equipo 2' }];
			}
		});

		const p1 = coordinator.changeTeam(team1Id, orgId);
		const p2 = coordinator.changeTeam(team2Id, orgId);

		// Resolve team 2 first
		await p2;
		assert.equal(coordinator.state.assignees[0].name, 'Técnico Rápido de Equipo 2');

		// Resolve stale team 1 afterwards
		resolveTeam1();
		await p1;

		// Stale response must NOT have overwritten team 2
		assert.equal(coordinator.state.assignees[0].name, 'Técnico Rápido de Equipo 2');
	});

	// 10. técnico incompatible se limpia
	await t.test('10. técnico incompatible se limpia automáticamente', () => {
		const formSrc = fs.readFileSync(
			path.join(root, 'src/lib/components/incidents/RealIncidentAssignForm.svelte'),
			'utf-8'
		);

		assert.ok(
			formSrc.includes('!assigneesLoading && selectedUserId'),
			'Debe validar cuando termina de cargar'
		);
		assert.ok(
			formSrc.includes('assignees.some((a) => a.id === selectedUserId)'),
			'Debe verificar si el técnico pertenece al nuevo catálogo'
		);
		assert.ok(
			formSrc.includes("selectedUserId = ''"),
			'Debe limpiar selectedUserId si no es compatible'
		);
	});

	// 11. solo equipo válido
	await t.test('11. asignación de solo equipo es válida en formulario y coordinator', async () => {
		const orgId = randomUUID();
		const teamId = randomUUID();
		const incident = makeSampleIncident({
			organizationId: orgId,
			teamId: null,
			assignedToUserId: null
		});

		let sentPayload = null;
		const coordinator = createTeamAssignCoordinator(incident, {
			assignIncidentFn: async (oId, incId, data) => {
				sentPayload = data;
				return makeSampleIncident({ ...incident, teamId: data.teamId, assignedToUserId: null });
			}
		});

		await coordinator.saveAssign({ teamId, assignedToUserId: null }, orgId);

		assert.equal(sentPayload.teamId, teamId);
		assert.equal(sentPayload.assignedToUserId, null);
		assert.equal(coordinator.state.incident.teamId, teamId);
	});

	// 12. solo técnico válido
	await t.test('12. asignación de solo técnico directo (sin equipo) es válida', async () => {
		const orgId = randomUUID();
		const techId = randomUUID();
		const incident = makeSampleIncident({
			organizationId: orgId,
			teamId: null,
			assignedToUserId: null
		});

		let sentPayload = null;
		const coordinator = createTeamAssignCoordinator(incident, {
			assignIncidentFn: async (oId, incId, data) => {
				sentPayload = data;
				return makeSampleIncident({ ...incident, teamId: null, assignedToUserId: techId });
			}
		});

		await coordinator.saveAssign({ teamId: null, assignedToUserId: techId }, orgId);

		assert.equal(sentPayload.teamId, null);
		assert.equal(sentPayload.assignedToUserId, techId);
		assert.equal(coordinator.state.incident.assignedToUserId, techId);
	});

	// 13. equipo+técnico válido
	await t.test('13. asignación de equipo + técnico es válida', async () => {
		const orgId = randomUUID();
		const teamId = randomUUID();
		const techId = randomUUID();
		const incident = makeSampleIncident({
			organizationId: orgId,
			teamId: null,
			assignedToUserId: null
		});

		let sentPayload = null;
		const coordinator = createTeamAssignCoordinator(incident, {
			assignIncidentFn: async (oId, incId, data) => {
				sentPayload = data;
				return makeSampleIncident({ ...incident, teamId, assignedToUserId: techId });
			}
		});

		await coordinator.saveAssign({ teamId, assignedToUserId: techId }, orgId);

		assert.equal(sentPayload.teamId, teamId);
		assert.equal(sentPayload.assignedToUserId, techId);
		assert.equal(coordinator.state.incident.teamId, teamId);
		assert.equal(coordinator.state.incident.assignedToUserId, techId);
	});

	// 14. primera asignación sin reason
	await t.test('14. primera asignación (team=null, tech=null) no exige motivo', () => {
		const formSrc = fs.readFileSync(
			path.join(root, 'src/lib/components/incidents/RealIncidentAssignForm.svelte'),
			'utf-8'
		);

		assert.ok(formSrc.includes('wasAssigned'), 'Debe derivar wasAssigned');
		assert.ok(
			formSrc.includes('Boolean(currentTeamId || currentAssigneeUserId)'),
			'wasAssigned debe evaluar teamId y assigneeUserId'
		);
		assert.ok(
			formSrc.includes('requiresReason = $derived(wasAssigned && isChanged)'),
			'requiresReason solo aplica si ya estaba asignado y cambió'
		);
	});

	// 15. reasignación exige reason
	await t.test(
		'15. reasignación exige motivo obligatorio cuando ya existía equipo o técnico',
		() => {
			const formSrc = fs.readFileSync(
				path.join(root, 'src/lib/components/incidents/RealIncidentAssignForm.svelte'),
				'utf-8'
			);

			assert.ok(
				formSrc.includes('Debes indicar el motivo de la reasignación.'),
				'Debe validar presencia del motivo si requiresReason'
			);
			assert.ok(
				formSrc.includes('cleanReason.length === 0'),
				'Debe verificar que el motivo no sea vacío'
			);
		}
	);

	// 16. same team+tech => no API
	await t.test('16. same team y same técnico => no API y cancela edición (no-op)', async () => {
		const orgId = randomUUID();
		const teamId = randomUUID();
		const techId = randomUUID();
		const incident = makeSampleIncident({
			organizationId: orgId,
			teamId,
			assignedToUserId: techId
		});

		let apiCalled = false;
		const coordinator = createTeamAssignCoordinator(incident, {
			assignIncidentFn: async () => {
				apiCalled = true;
				return incident;
			}
		});

		coordinator.state.isAssigning = true;
		await coordinator.saveAssign({ teamId, assignedToUserId: techId }, orgId);

		assert.equal(apiCalled, false, 'No debe llamar a la API si team y técnico son los mismos');
		assert.equal(coordinator.state.isAssigning, false, 'Debe cerrar la edición');
	});

	// 17. payload correcto
	await t.test(
		'17. assignIncident serializa payload con teamId, assignedToUserId y reason',
		async () => {
			const orgId = randomUUID();
			const incId = randomUUID();
			const teamId = randomUUID();
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
							teamId,
							assignedToUserId: techId
						})
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			};

			const updated = await assignIncident(
				orgId,
				incId,
				{ teamId, assignedToUserId: techId, reason: 'Escalado a segundo nivel' },
				{ customFetch: mockFetch }
			);

			assert.ok(sentUrl.includes(`/api/incidents/${incId}/assign`));
			assert.equal(sentBody.teamId, teamId);
			assert.equal(sentBody.assignedToUserId, techId);
			assert.equal(sentBody.reason, 'Escalado a segundo nivel');
			assert.equal(updated.teamId, teamId);
			assert.equal(updated.assignedToUserId, techId);
		}
	);

	// 18. success actualiza teamName
	await t.test(
		'18. success actualiza teamName resolviendo desde catálogo local si no viene en response',
		async () => {
			const orgId = randomUUID();
			const teamId = randomUUID();
			const initialIncident = makeSampleIncident({
				organizationId: orgId,
				teamId: null,
				teamName: null
			});

			const teams = [{ id: teamId, name: 'Equipo Especializado Cloud', description: null }];

			const coordinator = createTeamAssignCoordinator(initialIncident, {
				initialTeams: teams,
				assignIncidentFn: async () => {
					return makeSampleIncident({
						id: initialIncident.id,
						organizationId: orgId,
						teamId,
						teamName: null // Server response does NOT include joined name
					});
				}
			});

			await coordinator.saveAssign({ teamId, assignedToUserId: null }, orgId);

			assert.equal(coordinator.state.incident.teamId, teamId);
			assert.equal(coordinator.state.incident.teamName, 'Equipo Especializado Cloud');
			assert.equal(coordinator.state.isAssigning, false);
		}
	);

	// 19. success actualiza technicianName
	await t.test(
		'19. success actualiza technicianName resolviendo desde catálogo local de assignees',
		async () => {
			const orgId = randomUUID();
			const techId = randomUUID();
			const initialIncident = makeSampleIncident({
				organizationId: orgId,
				assignedToUserId: null,
				assignedToUserName: null
			});

			const assignees = [{ id: techId, name: 'Laura Gómez' }];

			const coordinator = createTeamAssignCoordinator(initialIncident, {
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

			await coordinator.saveAssign({ teamId: null, assignedToUserId: techId }, orgId);

			assert.equal(coordinator.state.incident.assignedToUserId, techId);
			assert.equal(coordinator.state.incident.assignedToUserName, 'Laura Gómez');
			assert.equal(coordinator.state.isAssigning, false);
		}
	);

	// 20. 401
	await t.test('20. 401 limpia sesión y redirige a /login?expired=true', async () => {
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

		const coordinator = createTeamAssignCoordinator(incident, {
			assignIncidentFn: async () => {
				throw new IncidentApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida.');
			}
		});

		await coordinator.saveAssign({ teamId: randomUUID() }, orgId, gotoFn, sessionStore);

		assert.equal(sessionCleared, true, 'Debe limpiar sesión');
		assert.equal(redirectedTo, '/login?expired=true', 'Debe redirigir a login');
	});

	// 21. 403
	await t.test('21. 403 preserva sesión y muestra error controlado de permisos', async () => {
		const orgId = randomUUID();
		const incident = makeSampleIncident({ organizationId: orgId });

		let sessionCleared = false;
		const sessionStore = {
			clearSession: () => {
				sessionCleared = true;
			}
		};

		const coordinator = createTeamAssignCoordinator(incident, {
			assignIncidentFn: async () => {
				throw new IncidentApiError(403, 'FORBIDDEN', 'Permission denied');
			}
		});

		await coordinator.saveAssign({ teamId: randomUUID() }, orgId, null, sessionStore);

		assert.equal(sessionCleared, false, 'No debe cerrar sesión');
		assert.equal(
			coordinator.state.assignmentError,
			'No tienes permisos para asignar esta incidencia.'
		);
		assert.ok(coordinator.state.incident, 'La incidencia permanece en memoria');
	});

	// 22. 404
	await t.test('22. 404 muestra mensaje seguro sin exponer detalles internos', async () => {
		const orgId = randomUUID();
		const incident = makeSampleIncident({ organizationId: orgId });

		const coordinator = createTeamAssignCoordinator(incident, {
			assignIncidentFn: async () => {
				throw new IncidentApiError(404, 'NOT_FOUND', 'Not found');
			}
		});

		await coordinator.saveAssign({ teamId: randomUUID() }, orgId);

		assert.equal(coordinator.state.assignmentError, 'No se pudo realizar la asignación.');
	});

	// 23. 400
	await t.test('23. 400 muestra mensaje seguro de validación', async () => {
		const orgId = randomUUID();
		const incident = makeSampleIncident({ organizationId: orgId });

		const coordinator = createTeamAssignCoordinator(incident, {
			assignIncidentFn: async () => {
				throw new IncidentApiError(400, 'INVALID_INPUT', 'Los datos de asignación son inválidos.');
			}
		});

		await coordinator.saveAssign({ teamId: randomUUID() }, orgId);

		assert.equal(coordinator.state.assignmentError, 'Los datos de asignación son inválidos.');
	});

	// 24. double submit
	await t.test('24. double submit bloqueado mientras guarda', async () => {
		const orgId = randomUUID();
		const teamId = randomUUID();
		const incident = makeSampleIncident({ organizationId: orgId });

		let callCount = 0;
		let resolveCall;
		const callPromise = new Promise((res) => {
			resolveCall = res;
		});

		const coordinator = createTeamAssignCoordinator(incident, {
			assignIncidentFn: async () => {
				callCount++;
				await callPromise;
				return makeSampleIncident({ ...incident, teamId });
			}
		});

		const p1 = coordinator.saveAssign({ teamId }, orgId);
		assert.equal(coordinator.state.assignmentSubmitting, true);

		// Second call while first is pending
		const p2 = coordinator.saveAssign({ teamId }, orgId);

		resolveCall();
		await Promise.all([p1, p2]);

		assert.equal(callCount, 1, 'Solo se debe ejecutar una llamada a assignIncident');
		assert.equal(coordinator.state.assignmentSubmitting, false);
	});

	// 25. no UUIDs visibles
	await t.test('25. no UUIDs visibles en el DOM del detalle ni en opciones del formulario', () => {
		const rawTeamId = '55555555-aaaa-bbbb-cccc-111122223333';
		const rawUserId = '66666666-aaaa-bbbb-cccc-444455556666';

		const item = makeSampleIncident({
			teamId: rawTeamId,
			teamName: 'Equipo Redes Globales',
			assignedToUserId: rawUserId,
			assignedToUserName: 'Mariana Duarte'
		});

		const detailHtml = render(RealIncidentDetail, {
			props: { incident: item, loading: false, error: null }
		}).body;

		assert.equal(detailHtml.includes(rawTeamId), false, 'UUID de equipo no debe verse en detalle');
		assert.equal(detailHtml.includes(rawUserId), false, 'UUID de técnico no debe verse en detalle');
		assert.ok(detailHtml.includes('Equipo Redes Globales'));
		assert.ok(detailHtml.includes('Mariana Duarte'));

		const formHtml = render(RealIncidentAssignForm, {
			props: {
				currentTeamId: rawTeamId,
				currentTeamName: 'Equipo Redes Globales',
				currentAssigneeUserId: rawUserId,
				currentAssigneeUserName: 'Mariana Duarte',
				teams: [{ id: rawTeamId, name: 'Equipo Redes Globales', description: null }],
				assignees: [{ id: rawUserId, name: 'Mariana Duarte' }],
				onSave: () => {},
				onCancel: () => {}
			}
		}).body;

		assert.ok(
			formHtml.includes('>Equipo Redes Globales (Actual)<') ||
				formHtml.includes('>Equipo Redes Globales<')
		);
		assert.ok(
			formHtml.includes('>Mariana Duarte (Actual)<') || formHtml.includes('>Mariana Duarte<')
		);
		assert.equal(
			formHtml.includes(`>${rawTeamId}<`),
			false,
			'El texto visible no debe ser el UUID'
		);
		assert.equal(
			formHtml.includes(`>${rawUserId}<`),
			false,
			'El texto visible no debe ser el UUID'
		);
	});

	// 26. demo aislada
	await t.test('26. demo aislada: componentes y stores demo permanecen intactos', () => {
		const demoSessionPath = path.join(root, 'src/lib/auth/demo-session.ts');
		assert.ok(fs.existsSync(demoSessionPath), 'El archivo demo-session.ts debe existir');
		const demoContent = fs.readFileSync(demoSessionPath, 'utf-8');
		assert.ok(demoContent.length > 0, 'El archivo demo-session debe permanecer íntegro');

		// Real components must not import demo-session
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
			assert.equal(src.includes('demo-session'), false, 'No debe importar demo-session');
		}
	});
});

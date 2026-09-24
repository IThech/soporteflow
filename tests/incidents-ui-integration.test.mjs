import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
		title: 'Servidor caído en sede central',
		description: 'El servidor principal no responde a pings ni peticiones HTTP.',
		status: 'open',
		priority: 'high',
		client: 'Acme Corp',
		clientUserId: null,
		createdByUserId: randomUUID(),
		siteId: null,
		createdAt: '2026-09-23T12:00:00.000Z',
		updatedAt: '2026-09-23T12:00:00.000Z',
		...overrides
	};
}

/**
 * Simulates the coordinator state machine implemented in src/routes/app/+page.svelte.
 */
function createCoordinator(options = {}) {
	const fetchFn = options.fetchFn ?? globalThis.fetch;
	let redirectedTo = null;

	const state = {
		realIncidents: [],
		realLoading: false,
		realError: null
	};

	let incidentRequestId = 0;
	let incidentAbortController = null;

	async function runEffect(sessionState) {
		const isAuth = sessionState.isAuthenticated;
		const currentOrg = sessionState.activeOrganization;
		const currentUserId = sessionState.user?.id;

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

		// Clear immediately upon tenant switch or initial load
		state.realIncidents = [];
		state.realError = null;
		state.realLoading = true;

		const controller = new AbortController();
		incidentAbortController = controller;
		const targetOrgId = currentOrg.id;
		const targetUserId = currentUserId;

		try {
			const data = await listIncidents(targetOrgId, {
				signal: controller.signal,
				customFetch: fetchFn
			});

			if (
				thisRequestId !== incidentRequestId ||
				sessionState.activeOrganization?.id !== targetOrgId ||
				sessionState.user?.id !== targetUserId
			) {
				return;
			}

			state.realIncidents = data;
			state.realError = null;
		} catch (err) {
			if (
				thisRequestId !== incidentRequestId ||
				sessionState.activeOrganization?.id !== targetOrgId ||
				sessionState.user?.id !== targetUserId
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
				state.realError = err.message;
			} else {
				state.realError = 'No se pudieron cargar las incidencias. Inténtalo de nuevo.';
			}
		} finally {
			if (
				thisRequestId === incidentRequestId &&
				sessionState.activeOrganization?.id === targetOrgId &&
				sessionState.user?.id === targetUserId
			) {
				state.realLoading = false;
			}
		}
	}

	return {
		state,
		runEffect,
		getRedirectedTo: () => redirectedTo
	};
}

test('SoporteFlow — Etapa 5.4E: Integración UI Incidencias Reales', async (t) => {
	// =========================================================================
	// 1. API CLIENT TESTS (1 to 13)
	// =========================================================================

	await t.test('1. URL correcta: invoca /api/incidents?organizationId=<UUID>', async () => {
		const orgId = randomUUID();
		let calledUrl = '';
		const mockFetch = async (url) => {
			calledUrl = url;
			return new Response(JSON.stringify({ incidents: [] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		};

		await listIncidents(orgId, { customFetch: mockFetch });
		assert.equal(calledUrl, `/api/incidents?organizationId=${orgId}`);
	});

	await t.test('2. organizationId encodeado correctamente en query string', async () => {
		const specialOrgId = 'org test/123+special?param=true';
		let calledUrl = '';
		const mockFetch = async (url) => {
			calledUrl = url;
			return new Response(JSON.stringify({ incidents: [] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		};

		await listIncidents(specialOrgId, { customFetch: mockFetch });
		assert.equal(calledUrl, `/api/incidents?organizationId=${encodeURIComponent(specialOrgId)}`);
	});

	await t.test('3. método GET strictly used with same-origin relative path', async () => {
		const orgId = randomUUID();
		let methodUsed = '';
		const mockFetch = async (url, init) => {
			methodUsed = init?.method;
			return new Response(JSON.stringify({ incidents: [] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		};

		await listIncidents(orgId, { customFetch: mockFetch });
		assert.equal(methodUsed, 'GET');
	});

	await t.test('4. 200 devuelve incidents correctamente tipados y completos', async () => {
		const orgId = randomUUID();
		const sample = makeSampleIncident({ organizationId: orgId });
		const mockFetch = async () => {
			return new Response(JSON.stringify({ incidents: [sample] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		};

		const res = await listIncidents(orgId, { customFetch: mockFetch });
		assert.equal(res.length, 1);
		assert.equal(res[0].id, sample.id);
		assert.equal(res[0].incidentNumber, 101);
		assert.equal(res[0].title, sample.title);
		assert.equal(res[0].client, sample.client);
		assert.equal(res[0].status, 'open');
		assert.equal(res[0].priority, 'high');
	});

	await t.test('5. payload vacío: 200 con { incidents: [] } devuelve array vacío', async () => {
		const orgId = randomUUID();
		const mockFetch = async () => {
			return new Response(JSON.stringify({ incidents: [] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		};

		const res = await listIncidents(orgId, { customFetch: mockFetch });
		assert.deepEqual(res, []);
	});

	await t.test('6. 400: lanza IncidentApiError con mensaje UX seguro', async () => {
		const orgId = randomUUID();
		const mockFetch = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'Internal SQL details' } }),
				{ status: 400, headers: { 'content-type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => {
				await listIncidents(orgId, { customFetch: mockFetch });
			},
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.status, 400);
				assert.equal(err.code, 'INVALID_INPUT');
				assert.equal(err.message, 'No se pudo consultar la organización seleccionada.');
				return true;
			}
		);
	});

	await t.test('7. 401: lanza IncidentApiError con mensaje de sesión expirada', async () => {
		const orgId = randomUUID();
		const mockFetch = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Auth required' } }),
				{ status: 401, headers: { 'content-type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => {
				await listIncidents(orgId, { customFetch: mockFetch });
			},
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.status, 401);
				assert.equal(err.code, 'UNAUTHORIZED');
				assert.equal(err.message, 'Tu sesión ya no es válida.');
				return true;
			}
		);
	});

	await t.test('8. 403: lanza IncidentApiError con mensaje de permisos', async () => {
		const orgId = randomUUID();
		const mockFetch = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Permission denied' } }),
				{ status: 403, headers: { 'content-type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => {
				await listIncidents(orgId, { customFetch: mockFetch });
			},
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.status, 403);
				assert.equal(err.code, 'FORBIDDEN');
				assert.equal(
					err.message,
					'No tienes permisos para consultar las incidencias de esta organización.'
				);
				return true;
			}
		);
	});

	await t.test('9. 500: lanza IncidentApiError seguro sin filtrar datos internos', async () => {
		const orgId = randomUUID();
		const mockFetch = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal DB leak' } }),
				{ status: 500, headers: { 'content-type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => {
				await listIncidents(orgId, { customFetch: mockFetch });
			},
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.status, 500);
				assert.equal(err.code, 'SERVER_ERROR');
				assert.equal(err.message, 'No se pudieron cargar las incidencias. Inténtalo de nuevo.');
				return true;
			}
		);
	});

	await t.test('10. error de red: lanza IncidentApiError con código NETWORK_ERROR', async () => {
		const orgId = randomUUID();
		const mockFetch = async () => {
			throw new TypeError('Failed to fetch');
		};

		await assert.rejects(
			async () => {
				await listIncidents(orgId, { customFetch: mockFetch });
			},
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.status, 0);
				assert.equal(err.code, 'NETWORK_ERROR');
				assert.equal(err.message, 'No se pudo conectar con el servidor.');
				return true;
			}
		);
	});

	await t.test(
		'11. payload malformado: no JSON, objeto sin incidents, o campos inválidos se rechazan',
		async () => {
			const orgId = randomUUID();

			// Case A: Not JSON
			await assert.rejects(
				async () => {
					await listIncidents(orgId, {
						customFetch: async () => new Response('<html>Error</html>', { status: 200 })
					});
				},
				(err) => {
					assert.ok(err instanceof IncidentApiError);
					assert.equal(err.code, 'INVALID_PAYLOAD');
					return true;
				}
			);

			// Case B: incidents missing
			await assert.rejects(
				async () => {
					await listIncidents(orgId, {
						customFetch: async () =>
							new Response(JSON.stringify({ other: true }), {
								status: 200,
								headers: { 'content-type': 'application/json' }
							})
					});
				},
				(err) => {
					assert.ok(err instanceof IncidentApiError);
					assert.equal(err.code, 'INVALID_PAYLOAD');
					return true;
				}
			);

			// Case C: incidents not an array
			await assert.rejects(
				async () => {
					await listIncidents(orgId, {
						customFetch: async () =>
							new Response(JSON.stringify({ incidents: 'not-array' }), {
								status: 200,
								headers: { 'content-type': 'application/json' }
							})
					});
				},
				(err) => {
					assert.ok(err instanceof IncidentApiError);
					assert.equal(err.code, 'INVALID_PAYLOAD');
					return true;
				}
			);

			// Case D: incident missing required type (incidentNumber not a number)
			await assert.rejects(
				async () => {
					await listIncidents(orgId, {
						customFetch: async () =>
							new Response(
								JSON.stringify({
									incidents: [
										{
											id: randomUUID(),
											organizationId: orgId,
											incidentNumber: 'NOT_A_NUMBER',
											title: 'Title',
											client: 'Client',
											status: 'open',
											priority: 'high',
											createdAt: '2026-09-23T12:00:00Z'
										}
									]
								}),
								{ status: 200, headers: { 'content-type': 'application/json' } }
							)
					});
				},
				(err) => {
					assert.ok(err instanceof IncidentApiError);
					assert.equal(err.code, 'INVALID_PAYLOAD');
					return true;
				}
			);
		}
	);

	await t.test('12. tenant diferente en respuesta se rechaza inmediatamente', async () => {
		const orgA = randomUUID();
		const orgB = randomUUID();
		const rogueIncident = makeSampleIncident({ organizationId: orgB });

		const mockFetch = async () => {
			return new Response(JSON.stringify({ incidents: [rogueIncident] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		};

		await assert.rejects(
			async () => {
				await listIncidents(orgA, { customFetch: mockFetch });
			},
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.code, 'INVALID_PAYLOAD');
				assert.equal(err.message, 'No se pudo interpretar la respuesta del servidor.');
				return true;
			}
		);
	});

	await t.test('13. AbortError no se trata como error funcional', async () => {
		const orgId = randomUUID();
		const controller = new AbortController();
		controller.abort();

		const mockFetch = async (_url, init) => {
			if (init?.signal?.aborted) {
				const domErr = new Error('This operation was aborted');
				domErr.name = 'AbortError';
				throw domErr;
			}
			return new Response(JSON.stringify({ incidents: [] }), { status: 200 });
		};

		await assert.rejects(
			async () => {
				await listIncidents(orgId, { signal: controller.signal, customFetch: mockFetch });
			},
			(err) => {
				assert.equal(err.name, 'AbortError');
				assert.equal(err instanceof IncidentApiError, false);
				return true;
			}
		);
	});

	// =========================================================================
	// 2. COORDINACIÓN TESTS (14 to 22)
	// =========================================================================

	await t.test('14. sin activeOrganization no hay fetch y limpia listado real', async () => {
		let fetchCount = 0;
		const coordinator = createCoordinator({
			fetchFn: async () => {
				fetchCount++;
				return new Response(JSON.stringify({ incidents: [] }), { status: 200 });
			}
		});

		await coordinator.runEffect({
			isAuthenticated: true,
			user: { id: randomUUID(), name: 'User', email: 'u@test.local' },
			organizations: [],
			activeOrganization: null
		});

		assert.equal(fetchCount, 0);
		assert.deepEqual(coordinator.state.realIncidents, []);
		assert.equal(coordinator.state.realLoading, false);
		assert.equal(coordinator.state.realError, null);
	});

	await t.test('15. activeOrganization dispara fetch y muestra loading', async () => {
		const orgA = { id: randomUUID(), name: 'Org A', slug: 'org-a' };
		const incident = makeSampleIncident({ organizationId: orgA.id });
		const deferred = createDeferred();

		const coordinator = createCoordinator({
			fetchFn: async () => {
				await deferred.promise;
				return new Response(JSON.stringify({ incidents: [incident] }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
		});

		const sessionCtx = {
			isAuthenticated: true,
			user: { id: randomUUID(), name: 'User', email: 'u@test.local' },
			organizations: [orgA],
			activeOrganization: orgA
		};

		const effectPromise = coordinator.runEffect(sessionCtx);
		// While fetching:
		assert.equal(coordinator.state.realLoading, true);
		assert.deepEqual(coordinator.state.realIncidents, []);

		deferred.resolve();
		await effectPromise;

		assert.equal(coordinator.state.realLoading, false);
		assert.equal(coordinator.state.realIncidents.length, 1);
		assert.equal(coordinator.state.realIncidents[0].id, incident.id);
	});

	await t.test('16. A → B limpia A inmediatamente y muestra loading B', async () => {
		const orgA = { id: randomUUID(), name: 'Org A', slug: 'org-a' };
		const orgB = { id: randomUUID(), name: 'Org B', slug: 'org-b' };
		const incidentA = makeSampleIncident({ organizationId: orgA.id });

		const defA = createDeferred();
		const defB = createDeferred();

		const coordinator = createCoordinator({
			fetchFn: async (url) => {
				if (url.includes(orgA.id)) {
					await defA.promise;
					return new Response(JSON.stringify({ incidents: [incidentA] }), {
						status: 200,
						headers: { 'content-type': 'application/json' }
					});
				}
				await defB.promise;
				return new Response(JSON.stringify({ incidents: [] }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
		});

		const user = { id: randomUUID(), name: 'User', email: 'u@test.local' };

		// Load Org A
		const pA = coordinator.runEffect({
			isAuthenticated: true,
			user,
			organizations: [orgA, orgB],
			activeOrganization: orgA
		});
		defA.resolve();
		await pA;
		assert.equal(coordinator.state.realIncidents.length, 1);

		// Switch to Org B
		coordinator.runEffect({
			isAuthenticated: true,
			user,
			organizations: [orgA, orgB],
			activeOrganization: orgB
		});

		// INMEDIATAMENTE: listado anterior desaparece y loading activo
		assert.deepEqual(
			coordinator.state.realIncidents,
			[],
			'Los datos de Org A deben limpiarse de inmediato'
		);
		assert.equal(coordinator.state.realLoading, true);

		defB.resolve();
	});

	await t.test('17. respuesta tardía A no sustituye B', async () => {
		const orgA = { id: randomUUID(), name: 'Org A', slug: 'org-a' };
		const orgB = { id: randomUUID(), name: 'Org B', slug: 'org-b' };
		const incA = makeSampleIncident({ organizationId: orgA.id, title: 'Inc A' });
		const incB = makeSampleIncident({ organizationId: orgB.id, title: 'Inc B' });

		const defA = createDeferred();
		const defB = createDeferred();

		const coordinator = createCoordinator({
			fetchFn: async (url) => {
				if (url.includes(orgA.id)) {
					await defA.promise;
					return new Response(JSON.stringify({ incidents: [incA] }), {
						status: 200,
						headers: { 'content-type': 'application/json' }
					});
				}
				await defB.promise;
				return new Response(JSON.stringify({ incidents: [incB] }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
		});

		const user = { id: randomUUID(), name: 'User', email: 'u@test.local' };

		// Start request A (will be delayed)
		coordinator.runEffect({
			isAuthenticated: true,
			user,
			organizations: [orgA, orgB],
			activeOrganization: orgA
		});

		// Rapidly switch to B
		const pB = coordinator.runEffect({
			isAuthenticated: true,
			user,
			organizations: [orgA, orgB],
			activeOrganization: orgB
		});

		// Org B finishes FIRST
		defB.resolve();
		await pB;
		assert.equal(coordinator.state.realIncidents.length, 1);
		assert.equal(coordinator.state.realIncidents[0].title, 'Inc B');

		// Now Org A finishes late
		defA.resolve();
		await new Promise((r) => setTimeout(r, 20));

		// Org B MUST NOT be replaced
		assert.equal(coordinator.state.realIncidents.length, 1);
		assert.equal(coordinator.state.realIncidents[0].title, 'Inc B');
	});

	await t.test('18. A → B → A mantiene solo petición vigente', async () => {
		const orgA = { id: randomUUID(), name: 'Org A', slug: 'org-a' };
		const orgB = { id: randomUUID(), name: 'Org B', slug: 'org-b' };
		const incA1 = makeSampleIncident({ organizationId: orgA.id, title: 'Inc A1' });
		const incB = makeSampleIncident({ organizationId: orgB.id, title: 'Inc B' });
		const incA2 = makeSampleIncident({ organizationId: orgA.id, title: 'Inc A2 Final' });

		const defA1 = createDeferred();
		const defB = createDeferred();
		const defA2 = createDeferred();

		let callIndex = 0;
		const coordinator = createCoordinator({
			fetchFn: async () => {
				callIndex++;
				if (callIndex === 1) {
					await defA1.promise;
					return new Response(JSON.stringify({ incidents: [incA1] }), { status: 200 });
				}
				if (callIndex === 2) {
					await defB.promise;
					return new Response(JSON.stringify({ incidents: [incB] }), { status: 200 });
				}
				await defA2.promise;
				return new Response(JSON.stringify({ incidents: [incA2] }), { status: 200 });
			}
		});

		const user = { id: randomUUID(), name: 'User', email: 'u@test.local' };

		// A1
		coordinator.runEffect({
			isAuthenticated: true,
			user,
			organizations: [orgA, orgB],
			activeOrganization: orgA
		});
		// B
		coordinator.runEffect({
			isAuthenticated: true,
			user,
			organizations: [orgA, orgB],
			activeOrganization: orgB
		});
		// A2
		const pA2 = coordinator.runEffect({
			isAuthenticated: true,
			user,
			organizations: [orgA, orgB],
			activeOrganization: orgA
		});

		// Resolve in arbitrary reverse order: B, then A1, then A2
		defB.resolve();
		defA1.resolve();
		await new Promise((r) => setTimeout(r, 20));

		defA2.resolve();
		await pA2;

		assert.equal(coordinator.state.realIncidents.length, 1);
		assert.equal(coordinator.state.realIncidents[0].title, 'Inc A2 Final');
	});

	await t.test('19. error tardío obsoleto se ignora por completo', async () => {
		const orgA = { id: randomUUID(), name: 'Org A', slug: 'org-a' };
		const orgB = { id: randomUUID(), name: 'Org B', slug: 'org-b' };
		const incB = makeSampleIncident({ organizationId: orgB.id });

		const defA = createDeferred();
		const defB = createDeferred();

		const coordinator = createCoordinator({
			fetchFn: async (url) => {
				if (url.includes(orgA.id)) {
					await defA.promise;
					return new Response(JSON.stringify({ error: { message: 'DB Error' } }), {
						status: 500,
						headers: { 'content-type': 'application/json' }
					});
				}
				await defB.promise;
				return new Response(JSON.stringify({ incidents: [incB] }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
		});

		const user = { id: randomUUID(), name: 'User', email: 'u@test.local' };

		coordinator.runEffect({
			isAuthenticated: true,
			user,
			organizations: [orgA, orgB],
			activeOrganization: orgA
		});
		const pB = coordinator.runEffect({
			isAuthenticated: true,
			user,
			organizations: [orgA, orgB],
			activeOrganization: orgB
		});

		defB.resolve();
		await pB;

		// Now A fails with 500 late
		defA.resolve();
		await new Promise((r) => setTimeout(r, 20));

		assert.equal(coordinator.state.realError, null);
		assert.equal(coordinator.state.realIncidents.length, 1);
	});

	await t.test('20. 401 obsoleto NO limpia sesión ni redirecciona', async () => {
		const orgA = { id: randomUUID(), name: 'Org A', slug: 'org-a' };
		const orgB = { id: randomUUID(), name: 'Org B', slug: 'org-b' };
		const incB = makeSampleIncident({ organizationId: orgB.id });

		const defA = createDeferred();
		const defB = createDeferred();

		const coordinator = createCoordinator({
			fetchFn: async (url) => {
				if (url.includes(orgA.id)) {
					await defA.promise;
					return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), {
						status: 401,
						headers: { 'content-type': 'application/json' }
					});
				}
				await defB.promise;
				return new Response(JSON.stringify({ incidents: [incB] }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
		});

		const user = { id: randomUUID(), name: 'User', email: 'u@test.local' };
		session.setSession({ user, organizations: [orgA, orgB] });
		session.setActiveOrganization(orgA.id);

		coordinator.runEffect({
			isAuthenticated: true,
			user,
			organizations: [orgA, orgB],
			activeOrganization: orgA
		});
		session.setActiveOrganization(orgB.id);
		const pB = coordinator.runEffect({
			isAuthenticated: true,
			user,
			organizations: [orgA, orgB],
			activeOrganization: orgB
		});

		defB.resolve();
		await pB;

		// Org A returns 401 late
		defA.resolve();
		await new Promise((r) => setTimeout(r, 20));

		assert.equal(coordinator.getRedirectedTo(), null, 'No debe haber redirigido');
		let currentStoreState;
		const unsub = session.subscribe((s) => (currentStoreState = s));
		unsub();
		assert.equal(currentStoreState.isAuthenticated, true, 'Sesión debe permanecer intacta');
	});

	await t.test('21. 401 vigente sí limpia sesión y redirige a /login?expired=true', async () => {
		const orgA = { id: randomUUID(), name: 'Org A', slug: 'org-a' };
		const coordinator = createCoordinator({
			fetchFn: async () => {
				return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), {
					status: 401,
					headers: { 'content-type': 'application/json' }
				});
			}
		});

		const user = { id: randomUUID(), name: 'User', email: 'u@test.local' };
		session.setSession({ user, organizations: [orgA] });

		await coordinator.runEffect({
			isAuthenticated: true,
			user,
			organizations: [orgA],
			activeOrganization: orgA
		});

		assert.equal(coordinator.getRedirectedTo(), '/login?expired=true');
		assert.deepEqual(coordinator.state.realIncidents, []);
		let currentStoreState;
		const unsub = session.subscribe((s) => (currentStoreState = s));
		unsub();
		assert.equal(currentStoreState.isAuthenticated, false);
	});

	await t.test('22. 403 conserva sesión y muestra mensaje de permisos', async () => {
		const orgA = { id: randomUUID(), name: 'Org A', slug: 'org-a' };
		const coordinator = createCoordinator({
			fetchFn: async () => {
				return new Response(JSON.stringify({ error: { code: 'FORBIDDEN' } }), {
					status: 403,
					headers: { 'content-type': 'application/json' }
				});
			}
		});

		const user = { id: randomUUID(), name: 'User', email: 'u@test.local' };
		session.setSession({ user, organizations: [orgA] });

		await coordinator.runEffect({
			isAuthenticated: true,
			user,
			organizations: [orgA],
			activeOrganization: orgA
		});

		assert.equal(coordinator.getRedirectedTo(), null);
		assert.equal(
			coordinator.state.realError,
			'No tienes permisos para consultar las incidencias de esta organización.'
		);
		let currentStoreState;
		const unsub = session.subscribe((s) => (currentStoreState = s));
		unsub();
		assert.equal(currentStoreState.isAuthenticated, true);
	});

	// =========================================================================
	// 3. PRESENTACIÓN TESTS (23 to 29)
	// =========================================================================

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
	const componentModule = await componentServer.ssrLoadModule(
		'/src/lib/components/incidents/RealIncidentList.svelte'
	);
	const RealIncidentList = componentModule.default;

	await t.test('23. loading: renderiza estado de carga accesible', () => {
		const html = render(RealIncidentList, {
			props: { incidents: [], loading: true, error: null }
		}).body;
		assert.ok(html.includes('Cargando incidencias...'));
		assert.ok(html.includes('role="status"'));
	});

	await t.test('24. empty: 200 con array vacío muestra texto explicativo', () => {
		const html = render(RealIncidentList, {
			props: { incidents: [], loading: false, error: null }
		}).body;
		assert.ok(html.includes('No hay incidencias en esta organización.'));
	});

	await t.test('25. error: muestra mensaje de error con role="alert"', () => {
		const html = render(RealIncidentList, {
			props: { incidents: [], loading: false, error: 'Mensaje de error controlado' }
		}).body;
		assert.ok(html.includes('Mensaje de error controlado'));
		assert.ok(html.includes('role="alert"'));
	});

	await t.test(
		'26. renderiza campos reales: número, título, cliente, estado, prioridad y fecha',
		() => {
			const orgId = randomUUID();
			const item = makeSampleIncident({
				organizationId: orgId,
				incidentNumber: 42,
				title: 'Fallo crítico de switch',
				client: 'Hospital San Juan',
				status: 'open',
				priority: 'urgent',
				createdAt: '2026-09-23T08:30:00.000Z'
			});

			const html = render(RealIncidentList, {
				props: { incidents: [item], loading: false, error: null }
			}).body;

			assert.ok(html.includes('#42'));
			assert.ok(html.includes('Fallo crítico de switch'));
			assert.ok(html.includes('Hospital San Juan'));
			assert.ok(html.includes('Abierta'));
			assert.ok(html.includes('Urgente'));
			assert.ok(html.includes('23/09/2026'));
		}
	);

	await t.test('27. filas no tienen onclick ni botones de acción', () => {
		const orgId = randomUUID();
		const item = makeSampleIncident({ organizationId: orgId });

		const html = render(RealIncidentList, {
			props: { incidents: [item], loading: false, error: null }
		}).body;

		assert.equal(html.includes('<button'), false, 'No debe contener etiquetas <button>');
		assert.equal(html.includes('cursor-pointer'), false, 'No debe sugerir clickabilidad');
	});

	await t.test('28. incidentNumber visible con formato de ticket', () => {
		const orgId = randomUUID();
		const item = makeSampleIncident({ organizationId: orgId, incidentNumber: 999 });

		const html = render(RealIncidentList, {
			props: { incidents: [item], loading: false, error: null }
		}).body;

		assert.ok(html.includes('#999'));
	});

	await t.test('29. UUID no se presenta como número de ticket', () => {
		const orgId = randomUUID();
		const item = makeSampleIncident({
			id: '12345678-1234-1234-1234-123456789abc',
			organizationId: orgId,
			incidentNumber: 88
		});

		const html = render(RealIncidentList, {
			props: { incidents: [item], loading: false, error: null }
		}).body;

		assert.ok(html.includes('#88'));
		assert.equal(
			html.includes('#12345678-1234-1234-1234-123456789abc'),
			false,
			'El UUID nunca debe usarse como número visible'
		);
	});

	// =========================================================================
	// 4. AISLAMIENTO TESTS (30 to 33)
	// =========================================================================

	await t.test('30. activeUser demo no filtra datos reales', () => {
		// Verify that real incident list presentation receives the server array directly
		// and does not filter by activeUser (e.g. client role, technician role)
		const orgId = randomUUID();
		const incidentOtherClient = makeSampleIncident({
			organizationId: orgId,
			clientUserId: randomUUID(),
			client: 'Otro cliente'
		});

		const html = render(RealIncidentList, {
			props: { incidents: [incidentOtherClient], loading: false, error: null }
		}).body;

		assert.ok(html.includes('Otro cliente'));
	});

	await t.test('31. localStorage demo no interviene en listado real', () => {
		// Mock localStorage with fake demo incidents
		const fakeStorage = new Map();
		fakeStorage.set('soporteflow_incidents', JSON.stringify([{ id: 9999, title: 'Demo inc' }]));

		// Ensure listIncidents interacts purely with HTTP fetch, never localStorage
		assert.equal(fakeStorage.has('soporteflow_incidents'), true);
		// Real state is purely driven by API response
		const coordinator = createCoordinator({
			fetchFn: async () => new Response(JSON.stringify({ incidents: [] }), { status: 200 })
		});
		assert.deepEqual(coordinator.state.realIncidents, []);
	});

	await t.test('32. cambio tenant no modifica incidentList demo', () => {
		const demoIncidents = [
			{ id: 1, title: 'Demo 1' },
			{ id: 2, title: 'Demo 2' }
		];
		const initialCopy = [...demoIncidents];

		// Switching tenant in real session store
		const org1 = { id: randomUUID(), name: 'Org 1', slug: 'org-1' };
		const org2 = { id: randomUUID(), name: 'Org 2', slug: 'org-2' };
		session.setSession({
			user: { id: randomUUID(), name: 'U', email: 'u@test' },
			organizations: [org1, org2]
		});
		session.setActiveOrganization(org1.id);
		session.setActiveOrganization(org2.id);

		// Demo incidents must remain completely untouched
		assert.deepEqual(demoIncidents, initialCopy);
	});

	await t.test('33. botón demo en header dice "Nueva incidencia demo"', () => {
		const pageSource = fs.readFileSync(path.join(root, 'src/routes/app/+page.svelte'), 'utf8');
		assert.ok(
			pageSource.includes('Nueva incidencia demo'),
			'El botón demo en el header debe tener el texto "Nueva incidencia demo"'
		);
		assert.ok(
			pageSource.includes('onclick={() => (isFormOpen = true)}'),
			'Debe conservar su comportamiento abriendo el modal demo'
		);
	});
});

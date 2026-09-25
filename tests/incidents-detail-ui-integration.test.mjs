import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIncident, IncidentApiError } from '../src/lib/api/incidents.ts';
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
	const incId = overrides.id ?? randomUUID();
	return {
		id: incId,
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
		supportLevel: overrides.supportLevel ?? 'N1',
		createdAt: '2026-09-23T12:00:00.000Z',
		updatedAt: '2026-09-23T12:30:00.000Z',
		...overrides
	};
}

/**
 * Simulates the coordinator state machine implemented in
 * src/routes/app/incidents/[id]/+page.svelte.
 */
function createDetailCoordinator(options = {}) {
	const fetchFn = options.fetchFn ?? globalThis.fetch;
	let redirectedTo = null;

	const state = {
		incident: null,
		loading: false,
		error: null,
		sessionLoading: false
	};

	let detailRequestId = 0;
	let detailAbortController = null;

	async function bootstrap({
		sessionState,
		urlOrgId,
		getMeFn,
		setSessionFn,
		setActiveOrgFn,
		gotoFn
	}) {
		if (!sessionState.isAuthenticated) {
			state.sessionLoading = true;
			try {
				const context = await getMeFn();
				setSessionFn(context);
				sessionState = {
					...sessionState,
					user: context.user,
					organizations: context.organizations,
					isAuthenticated: true
				};
			} catch (err) {
				if (err instanceof Error && err.status === 401) {
					session.clearSession();
					await gotoFn('/login?expired=true');
					redirectedTo = '/login?expired=true';
					return;
				}
				throw err;
			} finally {
				state.sessionLoading = false;
			}
		}

		// Validate urlOrgId against user organizations
		if (!urlOrgId || !sessionState.organizations.some((org) => org.id === urlOrgId)) {
			await gotoFn('/app');
			redirectedTo = '/app';
			return false;
		}

		setActiveOrgFn(urlOrgId);
		return true;
	}

	async function runEffect({ sessionState, targetIncidentId, targetOrgId }) {
		const isAuth = sessionState.isAuthenticated;
		const currentOrg = sessionState.activeOrganization;
		const currentUserId = sessionState.user?.id;

		detailRequestId += 1;
		const thisRequestId = detailRequestId;

		if (detailAbortController) {
			detailAbortController.abort();
			detailAbortController = null;
		}

		if (
			!isAuth ||
			!currentOrg ||
			!targetOrgId ||
			currentOrg.id !== targetOrgId ||
			!targetIncidentId
		) {
			state.incident = null;
			state.loading = false;
			state.error = null;
			return;
		}

		state.incident = null;
		state.error = null;
		state.loading = true;

		const controller = new AbortController();
		detailAbortController = controller;

		try {
			const data = await getIncident(targetOrgId, targetIncidentId, {
				signal: controller.signal,
				customFetch: fetchFn
			});

			if (
				thisRequestId !== detailRequestId ||
				sessionState.activeOrganization?.id !== targetOrgId ||
				sessionState.user?.id !== currentUserId
			) {
				return;
			}

			state.incident = data;
			state.error = null;
		} catch (err) {
			if (
				thisRequestId !== detailRequestId ||
				sessionState.activeOrganization?.id !== targetOrgId ||
				sessionState.user?.id !== currentUserId
			) {
				return;
			}

			if (err?.name === 'AbortError' || controller.signal.aborted) {
				return;
			}

			if (err instanceof IncidentApiError && err.status === 401) {
				session.clearSession();
				state.incident = null;
				state.error = null;
				state.loading = false;
				redirectedTo = '/login?expired=true';
				return;
			}

			if (err instanceof IncidentApiError) {
				if (err.status === 403) {
					state.error = 'No tienes permisos para consultar esta incidencia.';
				} else if (err.status === 404) {
					state.error = 'La incidencia no está disponible.';
				} else {
					state.error = err.message;
				}
			} else {
				state.error = 'No se pudo cargar la incidencia. Inténtalo de nuevo.';
			}
		} finally {
			if (
				thisRequestId === detailRequestId &&
				sessionState.activeOrganization?.id === targetOrgId &&
				sessionState.user?.id === currentUserId
			) {
				state.loading = false;
			}
		}
	}

	return {
		state,
		bootstrap,
		runEffect,
		getRedirectedTo: () => redirectedTo
	};
}

test('SoporteFlow — Etapa 5.4F: Detalle Real de Incidencias Read-Only', async (t) => {
	// =========================================================================
	// 1. API CLIENT TESTS (1 to 16)
	// =========================================================================

	await t.test('1. URL correcta: invoca /api/incidents/<id>?organizationId=<UUID>', async () => {
		const orgId = randomUUID();
		const incidentId = randomUUID();
		const sample = makeSampleIncident({ id: incidentId, organizationId: orgId });

		let requestedUrl = null;
		const mockFetch = async (url) => {
			requestedUrl = url;
			return new Response(JSON.stringify({ incident: sample, history: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		};

		const result = await getIncident(orgId, incidentId, { customFetch: mockFetch });
		assert.equal(requestedUrl, `/api/incidents/${incidentId}?organizationId=${orgId}`);
		assert.equal(result.id, incidentId);
	});

	await t.test('2. incidentId encodeado en URL', async () => {
		const orgId = randomUUID();
		const incidentId = 'inc#ident/123';
		const sample = makeSampleIncident({ id: incidentId, organizationId: orgId });

		let requestedUrl = null;
		const mockFetch = async (url) => {
			requestedUrl = url;
			return new Response(JSON.stringify({ incident: sample, history: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		};

		await getIncident(orgId, incidentId, { customFetch: mockFetch });
		assert.ok(requestedUrl.includes('/api/incidents/inc%23ident%2F123?'));
	});

	await t.test('3. organizationId encodeado en URL', async () => {
		const orgId = 'org special&param=1';
		const incidentId = randomUUID();
		const sample = makeSampleIncident({ id: incidentId, organizationId: orgId });

		let requestedUrl = null;
		const mockFetch = async (url) => {
			requestedUrl = url;
			return new Response(JSON.stringify({ incident: sample, history: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		};

		await getIncident(orgId, incidentId, { customFetch: mockFetch });
		assert.ok(requestedUrl.includes('organizationId=org%20special%26param%3D1'));
	});

	await t.test('4. método GET strictly used with same-origin relative path', async () => {
		const orgId = randomUUID();
		const incidentId = randomUUID();
		const sample = makeSampleIncident({ id: incidentId, organizationId: orgId });

		let usedMethod = null;
		const mockFetch = async (_url, init) => {
			usedMethod = init?.method;
			return new Response(JSON.stringify({ incident: sample, history: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		};

		await getIncident(orgId, incidentId, { customFetch: mockFetch });
		assert.equal(usedMethod, 'GET');
	});

	await t.test('5. 200 devuelve incident correctamente tipado y completo', async () => {
		const orgId = randomUUID();
		const incidentId = randomUUID();
		const sample = makeSampleIncident({
			id: incidentId,
			organizationId: orgId,
			incidentNumber: 777,
			title: 'Error de conectividad',
			description: 'Cables desconectados en rack B',
			status: 'resolved',
			priority: 'urgent',
			client: 'Gobierno Regional'
		});

		const mockFetch = async () => {
			return new Response(JSON.stringify({ incident: sample, history: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		};

		const incident = await getIncident(orgId, incidentId, { customFetch: mockFetch });
		assert.equal(incident.id, incidentId);
		assert.equal(incident.incidentNumber, 777);
		assert.equal(incident.title, 'Error de conectividad');
		assert.equal(incident.description, 'Cables desconectados en rack B');
		assert.equal(incident.status, 'resolved');
		assert.equal(incident.priority, 'urgent');
		assert.equal(incident.client, 'Gobierno Regional');
	});

	await t.test('6. history recibido NO forma parte del valor visual devuelto', async () => {
		const orgId = randomUUID();
		const incidentId = randomUUID();
		const sample = makeSampleIncident({ id: incidentId, organizationId: orgId });
		const mockHistory = [
			{
				id: randomUUID(),
				incidentId,
				action: 'internal_note_added',
				payload: { secret: 'super_confidential_token' },
				createdAt: '2026-09-23T12:05:00.000Z'
			}
		];

		const mockFetch = async () => {
			return new Response(JSON.stringify({ incident: sample, history: mockHistory }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		};

		const result = await getIncident(orgId, incidentId, { customFetch: mockFetch });
		assert.equal(result.id, incidentId);
		// Crucial privacy guarantee: history is not exposed in returned incident object
		assert.equal(result.history, undefined);
		assert.equal('history' in result, false);
	});

	await t.test('7. 400: lanza IncidentApiError con mensaje controlado', async () => {
		const mockFetch = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'invalid UUID' } }),
				{ status: 400, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => getIncident(randomUUID(), randomUUID(), { customFetch: mockFetch }),
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.status, 400);
				assert.equal(err.code, 'INVALID_INPUT');
				assert.equal(err.message, 'No se pudo consultar la incidencia.');
				return true;
			}
		);
	});

	await t.test('8. 401: lanza IncidentApiError con mensaje de sesión expirada', async () => {
		const mockFetch = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Auth required' } }),
				{ status: 401, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => getIncident(randomUUID(), randomUUID(), { customFetch: mockFetch }),
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.status, 401);
				assert.equal(err.code, 'UNAUTHORIZED');
				assert.equal(err.message, 'Tu sesión ya no es válida.');
				return true;
			}
		);
	});

	await t.test('9. 403: lanza IncidentApiError con mensaje de permisos', async () => {
		const mockFetch = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Permission denied' } }),
				{ status: 403, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => getIncident(randomUUID(), randomUUID(), { customFetch: mockFetch }),
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.status, 403);
				assert.equal(err.code, 'FORBIDDEN');
				assert.equal(err.message, 'No tienes permisos para consultar esta incidencia.');
				return true;
			}
		);
	});

	await t.test('10. 404: lanza IncidentApiError con mensaje de no disponible', async () => {
		const mockFetch = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'INCIDENT_NOT_FOUND', message: 'Not found' } }),
				{ status: 404, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => getIncident(randomUUID(), randomUUID(), { customFetch: mockFetch }),
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.status, 404);
				assert.equal(err.code, 'NOT_FOUND');
				assert.equal(err.message, 'La incidencia no está disponible.');
				return true;
			}
		);
	});

	await t.test('11. 500: lanza IncidentApiError seguro sin filtrar datos internos', async () => {
		const mockFetch = async () => {
			return new Response(
				JSON.stringify({
					error: { code: 'INTERNAL_ERROR', message: 'Database connection failed at postgres:5432' }
				}),
				{ status: 500, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => getIncident(randomUUID(), randomUUID(), { customFetch: mockFetch }),
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.status, 500);
				assert.equal(err.code, 'SERVER_ERROR');
				assert.equal(err.message, 'No se pudo cargar la incidencia. Inténtalo de nuevo.');
				assert.equal(err.message.includes('postgres'), false);
				return true;
			}
		);
	});

	await t.test('12. error de red: lanza IncidentApiError con código NETWORK_ERROR', async () => {
		const mockFetch = async () => {
			throw new TypeError('Failed to fetch');
		};

		await assert.rejects(
			async () => getIncident(randomUUID(), randomUUID(), { customFetch: mockFetch }),
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
		'13. payload malformado: no JSON o payload sin incident válido se rechaza',
		async () => {
			const notJson = async () => new Response('<html>Error</html>', { status: 200 });
			const noIncident = async () =>
				new Response(JSON.stringify({ notIncident: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});

			await assert.rejects(
				async () => getIncident(randomUUID(), randomUUID(), { customFetch: notJson }),
				(err) => {
					assert.ok(err instanceof IncidentApiError);
					assert.equal(err.code, 'INVALID_PAYLOAD');
					return true;
				}
			);

			await assert.rejects(
				async () => getIncident(randomUUID(), randomUUID(), { customFetch: noIncident }),
				(err) => {
					assert.ok(err instanceof IncidentApiError);
					assert.equal(err.code, 'INVALID_PAYLOAD');
					return true;
				}
			);
		}
	);

	await t.test(
		'14. organization mismatch: rechaza respuesta con organizationId diferente',
		async () => {
			const expectedOrgId = randomUUID();
			const foreignOrgId = randomUUID();
			const incidentId = randomUUID();
			const sample = makeSampleIncident({ id: incidentId, organizationId: foreignOrgId });

			const mockFetch = async () => {
				return new Response(JSON.stringify({ incident: sample, history: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			};

			await assert.rejects(
				async () => getIncident(expectedOrgId, incidentId, { customFetch: mockFetch }),
				(err) => {
					assert.ok(err instanceof IncidentApiError);
					assert.equal(err.code, 'INVALID_PAYLOAD');
					return true;
				}
			);
		}
	);

	await t.test('15. incident ID mismatch: rechaza respuesta con incidentId diferente', async () => {
		const orgId = randomUUID();
		const requestedId = randomUUID();
		const differentId = randomUUID();
		const sample = makeSampleIncident({ id: differentId, organizationId: orgId });

		const mockFetch = async () => {
			return new Response(JSON.stringify({ incident: sample, history: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		};

		await assert.rejects(
			async () => getIncident(orgId, requestedId, { customFetch: mockFetch }),
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.code, 'INVALID_PAYLOAD');
				return true;
			}
		);
	});

	await t.test('16. AbortError: re-lanza el error de abort sin enmascarar', async () => {
		const controller = new AbortController();
		controller.abort();

		const mockFetch = async (_url, init) => {
			if (init?.signal?.aborted) {
				const err = new Error('The operation was aborted');
				err.name = 'AbortError';
				throw err;
			}
			return new Response(JSON.stringify({ incident: makeSampleIncident() }));
		};

		await assert.rejects(
			async () =>
				getIncident(randomUUID(), randomUUID(), {
					signal: controller.signal,
					customFetch: mockFetch
				}),
			(err) => {
				assert.equal(err.name, 'AbortError');
				return true;
			}
		);
	});

	await t.test('16a. updatedAt ausente/inválido: rechaza payload con INVALID_PAYLOAD', async () => {
		const orgId = randomUUID();
		const incId = randomUUID();

		// updatedAt missing
		const missingUpdatedAt = makeSampleIncident({ id: incId, organizationId: orgId });
		delete missingUpdatedAt.updatedAt;

		const fetchMissing = async () =>
			new Response(JSON.stringify({ incident: missingUpdatedAt }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});

		await assert.rejects(
			async () => getIncident(orgId, incId, { customFetch: fetchMissing }),
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.code, 'INVALID_PAYLOAD');
				return true;
			}
		);

		// updatedAt is number
		const numberUpdatedAt = makeSampleIncident({
			id: incId,
			organizationId: orgId,
			updatedAt: 123456789
		});

		const fetchNumber = async () =>
			new Response(JSON.stringify({ incident: numberUpdatedAt }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});

		await assert.rejects(
			async () => getIncident(orgId, incId, { customFetch: fetchNumber }),
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.code, 'INVALID_PAYLOAD');
				return true;
			}
		);
	});

	await t.test('16b. clientUserId inválido: rechaza cuando no es string ni null', async () => {
		const orgId = randomUUID();
		const incId = randomUUID();

		// clientUserId is number
		const invalidClient = makeSampleIncident({
			id: incId,
			organizationId: orgId,
			clientUserId: 9999
		});

		const fetchInvalid = async () =>
			new Response(JSON.stringify({ incident: invalidClient }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});

		await assert.rejects(
			async () => getIncident(orgId, incId, { customFetch: fetchInvalid }),
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.code, 'INVALID_PAYLOAD');
				return true;
			}
		);

		// clientUserId as valid string succeeds
		const validClientString = makeSampleIncident({
			id: incId,
			organizationId: orgId,
			clientUserId: randomUUID()
		});
		const fetchValid = async () =>
			new Response(JSON.stringify({ incident: validClientString }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		const res = await getIncident(orgId, incId, { customFetch: fetchValid });
		assert.equal(typeof res.clientUserId, 'string');
	});

	await t.test('16c. siteId inválido: rechaza cuando no es string ni null', async () => {
		const orgId = randomUUID();
		const incId = randomUUID();

		// siteId is boolean
		const invalidSite = makeSampleIncident({
			id: incId,
			organizationId: orgId,
			siteId: true
		});

		const fetchInvalid = async () =>
			new Response(JSON.stringify({ incident: invalidSite }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});

		await assert.rejects(
			async () => getIncident(orgId, incId, { customFetch: fetchInvalid }),
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.code, 'INVALID_PAYLOAD');
				return true;
			}
		);

		// siteId as valid string succeeds
		const validSiteString = makeSampleIncident({
			id: incId,
			organizationId: orgId,
			siteId: randomUUID()
		});
		const fetchValid = async () =>
			new Response(JSON.stringify({ incident: validSiteString }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		const res = await getIncident(orgId, incId, { customFetch: fetchValid });
		assert.equal(typeof res.siteId, 'string');
	});

	await t.test('16d. createdByUserId inválido: rechaza cuando no es string', async () => {
		const orgId = randomUUID();
		const incId = randomUUID();

		// createdByUserId is null
		const nullCreator = makeSampleIncident({
			id: incId,
			organizationId: orgId,
			createdByUserId: null
		});

		const fetchNull = async () =>
			new Response(JSON.stringify({ incident: nullCreator }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});

		await assert.rejects(
			async () => getIncident(orgId, incId, { customFetch: fetchNull }),
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.code, 'INVALID_PAYLOAD');
				return true;
			}
		);

		// createdByUserId is missing
		const missingCreator = makeSampleIncident({ id: incId, organizationId: orgId });
		delete missingCreator.createdByUserId;

		const fetchMissing = async () =>
			new Response(JSON.stringify({ incident: missingCreator }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});

		await assert.rejects(
			async () => getIncident(orgId, incId, { customFetch: fetchMissing }),
			(err) => {
				assert.ok(err instanceof IncidentApiError);
				assert.equal(err.code, 'INVALID_PAYLOAD');
				return true;
			}
		);
	});

	await t.test(
		'16e. status desconocido: rechaza valores no pertenecientes al enum permitido',
		async () => {
			const orgId = randomUUID();
			const incId = randomUUID();

			for (const badStatus of ['archived', 'in_progress', 'cancelled', '', 123]) {
				const badIncident = makeSampleIncident({
					id: incId,
					organizationId: orgId,
					status: badStatus
				});

				const fetchBad = async () =>
					new Response(JSON.stringify({ incident: badIncident }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					});

				await assert.rejects(
					async () => getIncident(orgId, incId, { customFetch: fetchBad }),
					(err) => {
						assert.ok(err instanceof IncidentApiError);
						assert.equal(err.code, 'INVALID_PAYLOAD');
						return true;
					}
				);
			}

			// Valid statuses all succeed
			for (const goodStatus of ['open', 'pending', 'resolved', 'closed']) {
				const goodIncident = makeSampleIncident({
					id: incId,
					organizationId: orgId,
					status: goodStatus
				});

				const fetchGood = async () =>
					new Response(JSON.stringify({ incident: goodIncident }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					});

				const res = await getIncident(orgId, incId, { customFetch: fetchGood });
				assert.equal(res.status, goodStatus);
			}
		}
	);

	await t.test(
		'16f. priority desconocida: rechaza valores no pertenecientes al enum permitido',
		async () => {
			const orgId = randomUUID();
			const incId = randomUUID();

			for (const badPriority of ['critical', 'extreme', 'none', '', 456]) {
				const badIncident = makeSampleIncident({
					id: incId,
					organizationId: orgId,
					priority: badPriority
				});

				const fetchBad = async () =>
					new Response(JSON.stringify({ incident: badIncident }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					});

				await assert.rejects(
					async () => getIncident(orgId, incId, { customFetch: fetchBad }),
					(err) => {
						assert.ok(err instanceof IncidentApiError);
						assert.equal(err.code, 'INVALID_PAYLOAD');
						return true;
					}
				);
			}

			// Valid priorities all succeed
			for (const goodPriority of ['low', 'medium', 'high', 'urgent']) {
				const goodIncident = makeSampleIncident({
					id: incId,
					organizationId: orgId,
					priority: goodPriority
				});

				const fetchGood = async () =>
					new Response(JSON.stringify({ incident: goodIncident }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					});

				const res = await getIncident(orgId, incId, { customFetch: fetchGood });
				assert.equal(res.priority, goodPriority);
			}
		}
	);

	// =========================================================================
	// 2. BOOTSTRAP / DEEP LINK TESTS (17 to 21)
	// =========================================================================

	await t.test('17. store vacío -> invoca getMe para hidratar identidad', async () => {
		const org1 = { id: randomUUID(), name: 'Org Uno' };
		let getMeCalled = false;
		let sessionSet = false;

		const coordinator = createDetailCoordinator();
		const sessionState = { isAuthenticated: false, organizations: [], user: null };

		const mockGetMe = async () => {
			getMeCalled = true;
			return {
				user: { id: randomUUID(), email: 'tech@test.com', name: 'Tech' },
				organizations: [org1]
			};
		};

		const ok = await coordinator.bootstrap({
			sessionState,
			urlOrgId: org1.id,
			getMeFn: mockGetMe,
			setSessionFn: () => {
				sessionSet = true;
			},
			setActiveOrgFn: () => {},
			gotoFn: async () => {}
		});

		assert.equal(getMeCalled, true);
		assert.equal(sessionSet, true);
		assert.equal(ok, true);
	});

	await t.test('18. organizationId URL autorizado -> selección y fetch permitido', async () => {
		const orgId = randomUUID();
		const org = { id: orgId, name: 'Org Autorizada' };
		let selectedOrgId = null;

		const coordinator = createDetailCoordinator();
		const sessionState = {
			isAuthenticated: true,
			organizations: [org],
			user: { id: randomUUID(), email: 'user@test.com' }
		};

		const ok = await coordinator.bootstrap({
			sessionState,
			urlOrgId: orgId,
			getMeFn: async () => {},
			setSessionFn: () => {},
			setActiveOrgFn: (id) => {
				selectedOrgId = id;
			},
			gotoFn: async () => {}
		});

		assert.equal(ok, true);
		assert.equal(selectedOrgId, orgId);
	});

	await t.test('19. organizationId URL no autorizado -> NO fetch detalle y goto /app', async () => {
		const userOrgId = randomUUID();
		const unauthorizedOrgId = randomUUID();
		let redirectedPath = null;
		let selectedOrgId = null;

		const coordinator = createDetailCoordinator();
		const sessionState = {
			isAuthenticated: true,
			organizations: [{ id: userOrgId, name: 'Mi Org' }],
			user: { id: randomUUID() }
		};

		const ok = await coordinator.bootstrap({
			sessionState,
			urlOrgId: unauthorizedOrgId,
			getMeFn: async () => {},
			setSessionFn: () => {},
			setActiveOrgFn: (id) => {
				selectedOrgId = id;
			},
			gotoFn: async (path) => {
				redirectedPath = path;
			}
		});

		assert.equal(ok, false);
		assert.equal(selectedOrgId, null);
		assert.equal(redirectedPath, '/app');
	});

	await t.test(
		'20. múltiples organizaciones -> URL determina contexto explícito con precisión',
		async () => {
			const orgA = { id: randomUUID(), name: 'Empresa A' };
			const orgB = { id: randomUUID(), name: 'Empresa B' };
			let selectedOrgId = null;

			const coordinator = createDetailCoordinator();
			const sessionState = {
				isAuthenticated: true,
				organizations: [orgA, orgB],
				user: { id: randomUUID() }
			};

			// Deep link specifically requests Org B
			const ok = await coordinator.bootstrap({
				sessionState,
				urlOrgId: orgB.id,
				getMeFn: async () => {},
				setSessionFn: () => {},
				setActiveOrgFn: (id) => {
					selectedOrgId = id;
				},
				gotoFn: async () => {}
			});

			assert.equal(ok, true);
			assert.equal(selectedOrgId, orgB.id);
		}
	);

	await t.test(
		'21. F5 conceptual no depende exclusivamente de sessionStorage para seleccionar',
		async () => {
			const orgA = { id: randomUUID(), name: 'Empresa A' };
			const orgB = { id: randomUUID(), name: 'Empresa B' };
			let selectedOrgId = null;

			const coordinator = createDetailCoordinator();
			// Store in memory or previous session storage might have had null or orgA
			const sessionState = {
				isAuthenticated: true,
				organizations: [orgA, orgB],
				user: { id: randomUUID() }
			};

			// Direct F5 on detail of orgB: URL takes absolute precedence over old storage
			await coordinator.bootstrap({
				sessionState,
				urlOrgId: orgB.id,
				getMeFn: async () => {},
				setSessionFn: () => {},
				setActiveOrgFn: (id) => {
					selectedOrgId = id;
				},
				gotoFn: async () => {}
			});

			assert.equal(selectedOrgId, orgB.id);
		}
	);

	// =========================================================================
	// 3. RACES TESTS (22 to 27)
	// =========================================================================

	await t.test('22. respuesta tardía de petición previa es ignorada', async () => {
		const orgId = randomUUID();
		const inc1Id = randomUUID();
		const inc2Id = randomUUID();

		const inc1 = makeSampleIncident({ id: inc1Id, organizationId: orgId, title: 'Incidencia 1' });
		const inc2 = makeSampleIncident({ id: inc2Id, organizationId: orgId, title: 'Incidencia 2' });

		const req1 = createDeferred();
		const req2 = createDeferred();

		const fetchFn = async (url) => {
			if (url.includes(inc1Id)) {
				return req1.promise;
			}
			if (url.includes(inc2Id)) {
				return req2.promise;
			}
			throw new Error('Unexpected URL');
		};

		const coordinator = createDetailCoordinator({ fetchFn });
		const sessionState = {
			isAuthenticated: true,
			activeOrganization: { id: orgId, name: 'Org' },
			user: { id: 'u1' }
		};

		// Launch request 1
		const p1 = coordinator.runEffect({
			sessionState,
			targetIncidentId: inc1Id,
			targetOrgId: orgId
		});

		// Rapidly switch to incident 2
		const p2 = coordinator.runEffect({
			sessionState,
			targetIncidentId: inc2Id,
			targetOrgId: orgId
		});

		// Request 2 completes first
		req2.resolve(
			new Response(JSON.stringify({ incident: inc2, history: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		await p2;

		assert.equal(coordinator.state.incident?.id, inc2Id);
		assert.equal(coordinator.state.incident?.title, 'Incidencia 2');

		// Obsolete request 1 completes later
		req1.resolve(
			new Response(JSON.stringify({ incident: inc1, history: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		await p1;

		// Crucial: state must remain incident 2, never overwritten by obsolete response 1
		assert.equal(coordinator.state.incident?.id, inc2Id);
		assert.equal(coordinator.state.incident?.title, 'Incidencia 2');
	});

	await t.test('23. error tardío de petición previa es ignorado', async () => {
		const orgId = randomUUID();
		const inc1Id = randomUUID();
		const inc2Id = randomUUID();

		const inc2 = makeSampleIncident({ id: inc2Id, organizationId: orgId, title: 'Incidencia 2' });

		const req1 = createDeferred();
		const req2 = createDeferred();

		const fetchFn = async (url) => {
			if (url.includes(inc1Id)) return req1.promise;
			if (url.includes(inc2Id)) return req2.promise;
			throw new Error('Unexpected URL');
		};

		const coordinator = createDetailCoordinator({ fetchFn });
		const sessionState = {
			isAuthenticated: true,
			activeOrganization: { id: orgId, name: 'Org' },
			user: { id: 'u1' }
		};

		const p1 = coordinator.runEffect({
			sessionState,
			targetIncidentId: inc1Id,
			targetOrgId: orgId
		});
		const p2 = coordinator.runEffect({
			sessionState,
			targetIncidentId: inc2Id,
			targetOrgId: orgId
		});

		req2.resolve(
			new Response(JSON.stringify({ incident: inc2, history: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		await p2;
		assert.equal(coordinator.state.incident?.id, inc2Id);
		assert.equal(coordinator.state.error, null);

		// Obsolete request 1 fails with 500
		req1.resolve(new Response(JSON.stringify({ error: { message: 'Crash' } }), { status: 500 }));
		await p1;

		assert.equal(coordinator.state.incident?.id, inc2Id);
		assert.equal(coordinator.state.error, null);
	});

	await t.test('24. 401 obsoleto NO limpia sesión ni redirecciona', async () => {
		const orgId = randomUUID();
		const inc1Id = randomUUID();
		const inc2Id = randomUUID();

		const inc2 = makeSampleIncident({ id: inc2Id, organizationId: orgId, title: 'Incidencia 2' });

		const req1 = createDeferred();
		const req2 = createDeferred();

		const fetchFn = async (url) => {
			if (url.includes(inc1Id)) return req1.promise;
			if (url.includes(inc2Id)) return req2.promise;
			throw new Error('Unexpected URL');
		};

		const coordinator = createDetailCoordinator({ fetchFn });
		const sessionState = {
			isAuthenticated: true,
			activeOrganization: { id: orgId, name: 'Org' },
			user: { id: 'u1' }
		};

		const p1 = coordinator.runEffect({
			sessionState,
			targetIncidentId: inc1Id,
			targetOrgId: orgId
		});
		const p2 = coordinator.runEffect({
			sessionState,
			targetIncidentId: inc2Id,
			targetOrgId: orgId
		});

		req2.resolve(
			new Response(JSON.stringify({ incident: inc2, history: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		await p2;

		// Obsolete request 1 returns 401
		req1.resolve(
			new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 })
		);
		await p1;

		// Obsolete 401 must NOT trigger logout
		assert.equal(coordinator.getRedirectedTo(), null);
	});

	await t.test('25. 401 vigente sí limpia sesión y redirige a /login?expired=true', async () => {
		const orgId = randomUUID();
		const incId = randomUUID();

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Token expired' } }),
				{ status: 401, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const coordinator = createDetailCoordinator({ fetchFn });
		const sessionState = {
			isAuthenticated: true,
			activeOrganization: { id: orgId, name: 'Org' },
			user: { id: 'u1' }
		};

		await coordinator.runEffect({ sessionState, targetIncidentId: incId, targetOrgId: orgId });

		assert.equal(coordinator.getRedirectedTo(), '/login?expired=true');
		assert.equal(coordinator.state.incident, null);
	});

	await t.test('26. 403 conserva sesión y muestra mensaje de permisos', async () => {
		const orgId = randomUUID();
		const incId = randomUUID();

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Permission denied' } }),
				{ status: 403, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const coordinator = createDetailCoordinator({ fetchFn });
		const sessionState = {
			isAuthenticated: true,
			activeOrganization: { id: orgId, name: 'Org' },
			user: { id: 'u1' }
		};

		await coordinator.runEffect({ sessionState, targetIncidentId: incId, targetOrgId: orgId });

		assert.equal(coordinator.getRedirectedTo(), null);
		assert.equal(coordinator.state.error, 'No tienes permisos para consultar esta incidencia.');
		assert.equal(coordinator.state.incident, null);
	});

	await t.test('27. 404 conserva sesión y muestra mensaje seguro de no disponible', async () => {
		const orgId = randomUUID();
		const incId = randomUUID();

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'INCIDENT_NOT_FOUND', message: 'Not found' } }),
				{ status: 404, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const coordinator = createDetailCoordinator({ fetchFn });
		const sessionState = {
			isAuthenticated: true,
			activeOrganization: { id: orgId, name: 'Org' },
			user: { id: 'u1' }
		};

		await coordinator.runEffect({ sessionState, targetIncidentId: incId, targetOrgId: orgId });

		assert.equal(coordinator.getRedirectedTo(), null);
		assert.equal(coordinator.state.error, 'La incidencia no está disponible.');
		assert.equal(coordinator.state.incident, null);
	});

	// =========================================================================
	// 4. PRESENTACIÓN Y LISTADO COMPONENT SSR TESTS (28 to 40)
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
	const detailModule = await componentServer.ssrLoadModule(
		'/src/lib/components/incidents/RealIncidentDetail.svelte'
	);
	const RealIncidentDetail = detailModule.default;
	const listModule = await componentServer.ssrLoadModule(
		'/src/lib/components/incidents/RealIncidentList.svelte'
	);
	const RealIncidentList = listModule.default;

	await t.test(
		'28. campos reales visibles: número, título, cliente, estado, prioridad y fechas',
		() => {
			const item = makeSampleIncident({
				incidentNumber: 42,
				title: 'Fallo masivo de DNS',
				client: 'Red de Salud',
				status: 'open',
				priority: 'urgent',
				createdAt: '2026-09-23T10:00:00.000Z',
				updatedAt: '2026-09-23T11:00:00.000Z'
			});

			const html = render(RealIncidentDetail, {
				props: { incident: item, loading: false, error: null }
			}).body;

			assert.ok(html.includes('#42'));
			assert.ok(html.includes('Fallo masivo de DNS'));
			assert.ok(html.includes('Red de Salud'));
			assert.ok(html.includes('Abierta'));
			assert.ok(html.includes('Urgente'));
			assert.ok(html.includes('23/09/2026'));
		}
	);

	await t.test('29. UUID técnicos no visibles en el DOM del detalle', () => {
		const rawId = '11111111-2222-3333-4444-555555555555';
		const orgId = '66666666-7777-8888-9999-000000000000';
		const createdByUserId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
		const clientUserId = 'ffffffff-0000-1111-2222-333333333333';
		const siteId = '44444444-5555-6666-7777-888888888888';

		const item = makeSampleIncident({
			id: rawId,
			organizationId: orgId,
			createdByUserId,
			clientUserId,
			siteId,
			incidentNumber: 55
		});

		const html = render(RealIncidentDetail, {
			props: { incident: item, loading: false, error: null }
		}).body;

		assert.equal(html.includes(rawId), false, 'incident.id UUID no debe renderizarse');
		assert.equal(html.includes(orgId), false, 'incident.organizationId UUID no debe renderizarse');
		assert.equal(
			html.includes(createdByUserId),
			false,
			'createdByUserId UUID no debe renderizarse'
		);
		assert.equal(html.includes(clientUserId), false, 'clientUserId UUID no debe renderizarse');
		assert.equal(html.includes(siteId), false, 'siteId UUID no debe renderizarse');
	});

	await t.test('30. description visible en RealIncidentDetail', () => {
		const descriptionText = 'Detalle explicativo del problema en el router de entrada';
		const item = makeSampleIncident({ description: descriptionText });

		const html = render(RealIncidentDetail, {
			props: { incident: item, loading: false, error: null }
		}).body;

		assert.ok(html.includes(descriptionText));
	});

	await t.test('31. sin botones de edición', () => {
		const item = makeSampleIncident();
		const html = render(RealIncidentDetail, {
			props: { incident: item, loading: false, error: null }
		}).body;

		assert.equal(html.includes('<button'), false, 'No debe contener botones de edición');
		assert.equal(html.includes('<input'), false, 'No debe contener inputs de formulario');
	});

	await t.test('32. sin acciones en el detalle read-only', () => {
		const item = makeSampleIncident();
		const html = render(RealIncidentDetail, {
			props: { incident: item, loading: false, error: null }
		}).body;

		assert.equal(html.includes('Editar'), false);
		assert.equal(html.includes('Eliminar'), false);
		assert.equal(html.includes('Reasignar'), false);
		assert.equal(html.includes('Cerrar incidencia'), false);
	});

	await t.test('33. history NO renderizado en RealIncidentDetail', () => {
		const item = makeSampleIncident();
		// Even if an unexpected history field was attached to the object
		item.history = [
			{ action: 'note', text: 'Nota secreta de auditoría' },
			{ action: 'reassigned', text: 'Técnico B' }
		];

		const html = render(RealIncidentDetail, {
			props: { incident: item, loading: false, error: null }
		}).body;

		assert.equal(html.includes('Nota secreta de auditoría'), false);
		assert.equal(html.includes('Historial'), false);
		assert.equal(html.includes('Auditoría'), false);
	});

	await t.test('34. internal_note_added NO renderizado en RealIncidentDetail', () => {
		const item = makeSampleIncident();
		item.history = [
			{ action: 'internal_note_added', note: 'Nota técnica interna no para clientes' }
		];

		const html = render(RealIncidentDetail, {
			props: { incident: item, loading: false, error: null }
		}).body;

		assert.equal(html.includes('internal_note_added'), false);
		assert.equal(html.includes('Nota técnica interna no para clientes'), false);
	});

	await t.test('35. enlace volver existe en la plantilla del detalle', () => {
		const pageFile = path.join(root, 'src/routes/app/incidents/[id]/+page.svelte');
		const content = fs.readFileSync(pageFile, 'utf-8');

		assert.ok(content.includes('Volver a incidencias'));
		assert.ok(content.includes('/app'));
	});

	// =========================================================================
	// 5. LISTADO INTEGRATION TESTS (36 to 40)
	// =========================================================================

	await t.test('36. número/título son enlaces reales en RealIncidentList', () => {
		const orgId = randomUUID();
		const incId = randomUUID();
		const item = makeSampleIncident({
			id: incId,
			organizationId: orgId,
			incidentNumber: 88,
			title: 'Corte de fibra óptica'
		});

		const html = render(RealIncidentList, {
			props: { incidents: [item], loading: false, error: null }
		}).body;

		assert.ok(html.includes('<a '), 'Debe contener enlaces <a>');
		assert.ok(html.includes('#88'));
		assert.ok(html.includes('Corte de fibra óptica'));
	});

	await t.test('37. URL contiene incidentId en los enlaces del listado', () => {
		const orgId = randomUUID();
		const incId = 'test-incident-uuid-1234';
		const item = makeSampleIncident({ id: incId, organizationId: orgId });

		const html = render(RealIncidentList, {
			props: { incidents: [item], loading: false, error: null }
		}).body;

		assert.ok(html.includes('/app/incidents/test-incident-uuid-1234'));
	});

	await t.test('38. URL contiene organizationId en query string', () => {
		const orgId = 'test-org-uuid-5678';
		const incId = randomUUID();
		const item = makeSampleIncident({ id: incId, organizationId: orgId });

		const html = render(RealIncidentList, {
			props: { incidents: [item], loading: false, error: null }
		}).body;

		assert.ok(html.includes(`organizationId=test-org-uuid-5678`));
	});

	await t.test('39. filas no tienen onclick en <tr>', () => {
		const item = makeSampleIncident();

		const html = render(RealIncidentList, {
			props: { incidents: [item], loading: false, error: null }
		}).body;

		assert.equal(html.includes('<tr onclick'), false);
		assert.equal(html.includes('cursor-pointer'), false);
	});

	await t.test('40. no abre modal demo ni contiene botones de acción demo', () => {
		const item = makeSampleIncident();

		const html = render(RealIncidentList, {
			props: { incidents: [item], loading: false, error: null }
		}).body;

		assert.equal(html.includes('modal'), false);
		assert.equal(html.includes('dialog'), false);
		assert.equal(html.includes('<button'), false);
	});
});

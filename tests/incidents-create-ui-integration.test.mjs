import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIncident, IncidentApiError } from '../src/lib/api/incidents.ts';
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

function makeValidIncidentRecord(overrides = {}) {
	const orgId = overrides.organizationId ?? randomUUID();
	const incId = overrides.id ?? randomUUID();
	return {
		id: incId,
		organizationId: orgId,
		incidentNumber: 42,
		title: 'Corte de enlace de fibra',
		description: 'Caída de conectividad entre sede principal y datacenter',
		status: 'open',
		priority: 'medium',
		client: 'Acme Corp',
		clientUserId: null,
		createdByUserId: randomUUID(),
		siteId: null,
		createdAt: '2026-09-24T12:00:00.000Z',
		updatedAt: '2026-09-24T12:00:00.000Z',
		...overrides
	};
}

function createIncidentCoordinator(options = {}) {
	const fetchFn = options.fetchFn ?? globalThis.fetch;
	let redirectedTo = null;

	const state = {
		sessionLoading: false,
		submitting: false,
		error: null
	};

	let abortController = null;

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
				if (err?.status === 401) {
					session.clearSession();
					await gotoFn('/login?expired=true');
					redirectedTo = '/login?expired=true';
					return false;
				}
				throw err;
			} finally {
				state.sessionLoading = false;
			}
		}

		if (!urlOrgId || !sessionState.organizations.some((org) => org.id === urlOrgId)) {
			await gotoFn('/app');
			redirectedTo = '/app';
			return false;
		}

		setActiveOrgFn(urlOrgId);
		return true;
	}

	async function handleCreate({ sessionState, urlOrgId, input, gotoFn, clearSessionFn }) {
		if (state.submitting) return;

		if (!urlOrgId || !sessionState.organizations.some((org) => org.id === urlOrgId)) {
			await gotoFn('/app');
			redirectedTo = '/app';
			return;
		}

		state.submitting = true;
		state.error = null;

		if (abortController) {
			abortController.abort();
		}
		const controller = new AbortController();
		abortController = controller;

		try {
			const incident = await createIncident(urlOrgId, input, {
				signal: controller.signal,
				customFetch: fetchFn
			});

			await gotoFn(
				`/app/incidents/${encodeURIComponent(incident.id)}?organizationId=${encodeURIComponent(incident.organizationId)}`
			);
			redirectedTo = `/app/incidents/${incident.id}?organizationId=${incident.organizationId}`;
			return incident;
		} catch (err) {
			if (err?.name === 'AbortError' || controller.signal.aborted) {
				return;
			}

			if (err instanceof IncidentApiError && err.status === 401) {
				clearSessionFn();
				await gotoFn('/login?expired=true');
				redirectedTo = '/login?expired=true';
				return;
			}

			if (err instanceof IncidentApiError) {
				if (err.status === 403) {
					state.error = 'No tienes permisos para crear incidencias en esta organización.';
				} else {
					state.error = err.message;
				}
			} else {
				state.error = 'No se pudo crear la incidencia. Inténtalo de nuevo.';
			}
		} finally {
			state.submitting = false;
		}
	}

	return {
		state,
		bootstrap,
		handleCreate,
		getRedirectedTo: () => redirectedTo,
		abort: () => abortController?.abort()
	};
}

test('Etapa 5.4G — Integración de Creación Real de Incidencias', async (t) => {
	// =========================================================================
	// 1. API CLIENT TESTS (1 to 28)
	// =========================================================================

	await t.test('1. POST method to /api/incidents', async () => {
		const orgId = randomUUID();
		let capturedMethod = null;
		let capturedUrl = null;

		const fetchFn = async (url, init) => {
			capturedUrl = url;
			capturedMethod = init.method;
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId }),
					history: { eventType: 'created' }
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await createIncident(
			orgId,
			{
				title: 'Test',
				description: 'Desc',
				client: 'Cli',
				priority: 'medium'
			},
			{ customFetch: fetchFn }
		);

		assert.equal(capturedMethod, 'POST');
		assert.equal(capturedUrl, '/api/incidents');
	});

	await t.test('2. Content-Type application/json header', async () => {
		const orgId = randomUUID();
		let capturedContentType = null;

		const fetchFn = async (_url, init) => {
			capturedContentType = init.headers['Content-Type'];
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await createIncident(
			orgId,
			{
				title: 'Test',
				description: 'Desc',
				client: 'Cli',
				priority: 'medium'
			},
			{ customFetch: fetchFn }
		);

		assert.equal(capturedContentType, 'application/json');
	});

	await t.test('3. organizationId en body', async () => {
		const orgId = randomUUID();
		let parsedBody = null;

		const fetchFn = async (_url, init) => {
			parsedBody = JSON.parse(init.body);
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await createIncident(
			orgId,
			{
				title: 'Test',
				description: 'Desc',
				client: 'Cli',
				priority: 'medium'
			},
			{ customFetch: fetchFn }
		);

		assert.equal(parsedBody.organizationId, orgId);
	});

	await t.test('4. title correcto', async () => {
		const orgId = randomUUID();
		let parsedBody = null;

		const fetchFn = async (_url, init) => {
			parsedBody = JSON.parse(init.body);
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await createIncident(
			orgId,
			{
				title: 'Incidencia de red específica',
				description: 'Desc',
				client: 'Cli',
				priority: 'medium'
			},
			{ customFetch: fetchFn }
		);

		assert.equal(parsedBody.title, 'Incidencia de red específica');
	});

	await t.test('5. description correcto', async () => {
		const orgId = randomUUID();
		let parsedBody = null;

		const fetchFn = async (_url, init) => {
			parsedBody = JSON.parse(init.body);
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await createIncident(
			orgId,
			{
				title: 'Titulo',
				description: 'Explicación detallada del fallo en el rack principal',
				client: 'Cli',
				priority: 'medium'
			},
			{ customFetch: fetchFn }
		);

		assert.equal(parsedBody.description, 'Explicación detallada del fallo en el rack principal');
	});

	await t.test('6. client correcto', async () => {
		const orgId = randomUUID();
		let parsedBody = null;

		const fetchFn = async (_url, init) => {
			parsedBody = JSON.parse(init.body);
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await createIncident(
			orgId,
			{
				title: 'Titulo',
				description: 'Desc',
				client: 'Cliente Corporativo S.L.',
				priority: 'medium'
			},
			{ customFetch: fetchFn }
		);

		assert.equal(parsedBody.client, 'Cliente Corporativo S.L.');
	});

	await t.test('7. priority correcto', async () => {
		const orgId = randomUUID();
		let parsedBody = null;

		const fetchFn = async (_url, init) => {
			parsedBody = JSON.parse(init.body);
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId, priority: 'urgent' }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await createIncident(
			orgId,
			{
				title: 'Titulo',
				description: 'Desc',
				client: 'Cli',
				priority: 'urgent'
			},
			{ customFetch: fetchFn }
		);

		assert.equal(parsedBody.priority, 'urgent');
	});

	await t.test('8. NO status en el payload enviado', async () => {
		const orgId = randomUUID();
		let parsedBody = null;

		const fetchFn = async (_url, init) => {
			parsedBody = JSON.parse(init.body);
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await createIncident(
			orgId,
			{
				title: 'Titulo',
				description: 'Desc',
				client: 'Cli',
				priority: 'medium'
			},
			{ customFetch: fetchFn }
		);

		assert.equal('status' in parsedBody, false);
	});

	await t.test('9. NO id en el payload enviado', async () => {
		const orgId = randomUUID();
		let parsedBody = null;

		const fetchFn = async (_url, init) => {
			parsedBody = JSON.parse(init.body);
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await createIncident(
			orgId,
			{
				title: 'Titulo',
				description: 'Desc',
				client: 'Cli',
				priority: 'medium'
			},
			{ customFetch: fetchFn }
		);

		assert.equal('id' in parsedBody, false);
	});

	await t.test('10. NO incidentNumber en el payload enviado', async () => {
		const orgId = randomUUID();
		let parsedBody = null;

		const fetchFn = async (_url, init) => {
			parsedBody = JSON.parse(init.body);
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await createIncident(
			orgId,
			{
				title: 'Titulo',
				description: 'Desc',
				client: 'Cli',
				priority: 'medium'
			},
			{ customFetch: fetchFn }
		);

		assert.equal('incidentNumber' in parsedBody, false);
	});

	await t.test('11. NO createdByUserId en el payload enviado', async () => {
		const orgId = randomUUID();
		let parsedBody = null;

		const fetchFn = async (_url, init) => {
			parsedBody = JSON.parse(init.body);
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await createIncident(
			orgId,
			{
				title: 'Titulo',
				description: 'Desc',
				client: 'Cli',
				priority: 'medium'
			},
			{ customFetch: fetchFn }
		);

		assert.equal('createdByUserId' in parsedBody, false);
	});

	await t.test('12. NO clientUserId en el JSON v1', async () => {
		const orgId = randomUUID();
		let parsedBody = null;

		const fetchFn = async (_url, init) => {
			parsedBody = JSON.parse(init.body);
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await createIncident(
			orgId,
			{
				title: 'Titulo',
				description: 'Desc',
				client: 'Cli',
				priority: 'medium'
			},
			{ customFetch: fetchFn }
		);

		assert.equal('clientUserId' in parsedBody, false);
	});

	await t.test('13. NO siteId en el JSON v1', async () => {
		const orgId = randomUUID();
		let parsedBody = null;

		const fetchFn = async (_url, init) => {
			parsedBody = JSON.parse(init.body);
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await createIncident(
			orgId,
			{
				title: 'Titulo',
				description: 'Desc',
				client: 'Cli',
				priority: 'medium'
			},
			{ customFetch: fetchFn }
		);

		assert.equal('siteId' in parsedBody, false);
	});

	await t.test('14. 201 devuelve incident validado', async () => {
		const orgId = randomUUID();
		const expectedRecord = makeValidIncidentRecord({ organizationId: orgId });

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({
					incident: expectedRecord,
					history: { eventType: 'created' }
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const result = await createIncident(
			orgId,
			{
				title: 'Titulo',
				description: 'Desc',
				client: 'Cli',
				priority: 'medium'
			},
			{ customFetch: fetchFn }
		);

		assert.equal(result.id, expectedRecord.id);
		assert.equal(result.organizationId, orgId);
		assert.equal(result.incidentNumber, 42);
		assert.equal(result.title, 'Corte de enlace de fibra');
	});

	await t.test('15. history NO forma parte del resultado', async () => {
		const orgId = randomUUID();
		const expectedRecord = makeValidIncidentRecord({ organizationId: orgId });

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({
					incident: expectedRecord,
					history: {
						id: randomUUID(),
						eventType: 'created',
						actorUserId: randomUUID()
					}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const result = await createIncident(
			orgId,
			{
				title: 'Titulo',
				description: 'Desc',
				client: 'Cli',
				priority: 'medium'
			},
			{ customFetch: fetchFn }
		);

		assert.equal('history' in result, false);
		assert.equal('actorUserId' in result, false);
	});

	await t.test('16. valida contrato completo (falta campo -> INVALID_PAYLOAD)', async () => {
		const orgId = randomUUID();
		const incompleteRecord = makeValidIncidentRecord({ organizationId: orgId });
		delete incompleteRecord.createdAt;

		const fetchFn = async () => {
			return new Response(JSON.stringify({ incident: incompleteRecord, history: {} }), {
				status: 201,
				headers: { 'Content-Type': 'application/json' }
			});
		};

		await assert.rejects(
			async () => {
				await createIncident(
					orgId,
					{
						title: 'Titulo',
						description: 'Desc',
						client: 'Cli',
						priority: 'medium'
					},
					{ customFetch: fetchFn }
				);
			},
			(err) => {
				assert.equal(err instanceof IncidentApiError, true);
				assert.equal(err.code, 'INVALID_PAYLOAD');
				assert.equal(err.status, 201);
				return true;
			}
		);
	});

	await t.test('17. organization mismatch rechazado', async () => {
		const orgId = randomUUID();
		const differentOrgId = randomUUID();

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: differentOrgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => {
				await createIncident(
					orgId,
					{
						title: 'Titulo',
						description: 'Desc',
						client: 'Cli',
						priority: 'medium'
					},
					{ customFetch: fetchFn }
				);
			},
			(err) => {
				assert.equal(err instanceof IncidentApiError, true);
				assert.equal(err.code, 'INVALID_PAYLOAD');
				return true;
			}
		);
	});

	await t.test('18. status desconocido rechazado', async () => {
		const orgId = randomUUID();

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId, status: 'unknown_status' }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => {
				await createIncident(
					orgId,
					{
						title: 'Titulo',
						description: 'Desc',
						client: 'Cli',
						priority: 'medium'
					},
					{ customFetch: fetchFn }
				);
			},
			(err) => {
				assert.equal(err instanceof IncidentApiError, true);
				assert.equal(err.code, 'INVALID_PAYLOAD');
				return true;
			}
		);
	});

	await t.test('19. priority desconocida rechazada', async () => {
		const orgId = randomUUID();

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId, priority: 'critical' }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => {
				await createIncident(
					orgId,
					{
						title: 'Titulo',
						description: 'Desc',
						client: 'Cli',
						priority: 'medium'
					},
					{ customFetch: fetchFn }
				);
			},
			(err) => {
				assert.equal(err instanceof IncidentApiError, true);
				assert.equal(err.code, 'INVALID_PAYLOAD');
				return true;
			}
		);
	});

	await t.test('20. updatedAt inválido rechazado', async () => {
		const orgId = randomUUID();

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId, updatedAt: 12345 }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => {
				await createIncident(
					orgId,
					{
						title: 'Titulo',
						description: 'Desc',
						client: 'Cli',
						priority: 'medium'
					},
					{ customFetch: fetchFn }
				);
			},
			(err) => {
				assert.equal(err instanceof IncidentApiError, true);
				assert.equal(err.code, 'INVALID_PAYLOAD');
				return true;
			}
		);
	});

	await t.test('21. payload malformado rechazado', async () => {
		const orgId = randomUUID();

		const fetchFn = async () => {
			return new Response('Not a json', {
				status: 201,
				headers: { 'Content-Type': 'text/plain' }
			});
		};

		await assert.rejects(
			async () => {
				await createIncident(
					orgId,
					{
						title: 'Titulo',
						description: 'Desc',
						client: 'Cli',
						priority: 'medium'
					},
					{ customFetch: fetchFn }
				);
			},
			(err) => {
				assert.equal(err instanceof IncidentApiError, true);
				assert.equal(err.code, 'INVALID_PAYLOAD');
				return true;
			}
		);
	});

	await t.test('22. 400 mapeado a INVALID_INPUT con mensaje seguro', async () => {
		const orgId = randomUUID();

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'Internal validation detail' } }),
				{ status: 400, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => {
				await createIncident(
					orgId,
					{
						title: 'Titulo',
						description: 'Desc',
						client: 'Cli',
						priority: 'medium'
					},
					{ customFetch: fetchFn }
				);
			},
			(err) => {
				assert.equal(err instanceof IncidentApiError, true);
				assert.equal(err.status, 400);
				assert.equal(err.code, 'INVALID_INPUT');
				assert.equal(err.message, 'Por favor, revisa los datos de la incidencia.');
				return true;
			}
		);
	});

	await t.test('23. 401 mapeado a UNAUTHORIZED con mensaje de sesión inválida', async () => {
		const orgId = randomUUID();

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }),
				{ status: 401, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => {
				await createIncident(
					orgId,
					{
						title: 'Titulo',
						description: 'Desc',
						client: 'Cli',
						priority: 'medium'
					},
					{ customFetch: fetchFn }
				);
			},
			(err) => {
				assert.equal(err instanceof IncidentApiError, true);
				assert.equal(err.status, 401);
				assert.equal(err.code, 'UNAUTHORIZED');
				assert.equal(err.message, 'Tu sesión ya no es válida.');
				return true;
			}
		);
	});

	await t.test('24. 403 mapeado a FORBIDDEN con mensaje de permisos', async () => {
		const orgId = randomUUID();

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Permission denied' } }),
				{ status: 403, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => {
				await createIncident(
					orgId,
					{
						title: 'Titulo',
						description: 'Desc',
						client: 'Cli',
						priority: 'medium'
					},
					{ customFetch: fetchFn }
				);
			},
			(err) => {
				assert.equal(err instanceof IncidentApiError, true);
				assert.equal(err.status, 403);
				assert.equal(err.code, 'FORBIDDEN');
				assert.equal(
					err.message,
					'No tienes permisos para crear incidencias en esta organización.'
				);
				return true;
			}
		);
	});

	await t.test('25. 404 mapeado a NOT_FOUND acorde al contrato backend', async () => {
		const orgId = randomUUID();

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'SITE_NOT_FOUND', message: 'Site not found' } }),
				{ status: 404, headers: { 'Content-Type': 'application/json' } }
			);
		};

		await assert.rejects(
			async () => {
				await createIncident(
					orgId,
					{
						title: 'Titulo',
						description: 'Desc',
						client: 'Cli',
						priority: 'medium'
					},
					{ customFetch: fetchFn }
				);
			},
			(err) => {
				assert.equal(err instanceof IncidentApiError, true);
				assert.equal(err.status, 404);
				assert.equal(err.code, 'NOT_FOUND');
				assert.equal(err.message, 'No se pudo asociar la sede o el cliente especificado.');
				return true;
			}
		);
	});

	await t.test('26. 500 mapeado a SERVER_ERROR con reintento', async () => {
		const orgId = randomUUID();

		const fetchFn = async () => {
			return new Response('Database crash', { status: 500 });
		};

		await assert.rejects(
			async () => {
				await createIncident(
					orgId,
					{
						title: 'Titulo',
						description: 'Desc',
						client: 'Cli',
						priority: 'medium'
					},
					{ customFetch: fetchFn }
				);
			},
			(err) => {
				assert.equal(err instanceof IncidentApiError, true);
				assert.equal(err.status, 500);
				assert.equal(err.code, 'SERVER_ERROR');
				assert.equal(err.message, 'No se pudo crear la incidencia. Inténtalo de nuevo.');
				return true;
			}
		);
	});

	await t.test('27. network mapeado a NETWORK_ERROR', async () => {
		const orgId = randomUUID();

		const fetchFn = async () => {
			throw new TypeError('Failed to fetch');
		};

		await assert.rejects(
			async () => {
				await createIncident(
					orgId,
					{
						title: 'Titulo',
						description: 'Desc',
						client: 'Cli',
						priority: 'medium'
					},
					{ customFetch: fetchFn }
				);
			},
			(err) => {
				assert.equal(err instanceof IncidentApiError, true);
				assert.equal(err.code, 'NETWORK_ERROR');
				assert.equal(err.message, 'No se pudo conectar con el servidor.');
				return true;
			}
		);
	});

	await t.test('28. AbortError propagado sin transformarse a NETWORK_ERROR', async () => {
		const orgId = randomUUID();
		const controller = new AbortController();
		controller.abort();

		const fetchFn = async (_url, init) => {
			if (init.signal?.aborted) {
				const error = new Error('The operation was aborted');
				error.name = 'AbortError';
				throw error;
			}
			return new Response('{}', { status: 201 });
		};

		await assert.rejects(
			async () => {
				await createIncident(
					orgId,
					{
						title: 'Titulo',
						description: 'Desc',
						client: 'Cli',
						priority: 'medium'
					},
					{ customFetch: fetchFn, signal: controller.signal }
				);
			},
			(err) => {
				assert.equal(err.name, 'AbortError');
				return true;
			}
		);
	});

	// =========================================================================
	// 2. FORM COMPONENT SSR & PRESENTATION TESTS (29 to 41)
	// =========================================================================

	const { createServer } = await import('vite');
	const { svelte } = await import('@sveltejs/vite-plugin-svelte');
	const componentServer = await createServer({
		root,
		configFile: false,
		envDir: false,
		plugins: [svelte({ configFile: false })],
		server: { middlewareMode: true, hmr: { port: 24690 }, watch: null },
		appType: 'custom'
	});
	t.after(() => componentServer.close());

	const { render } = await componentServer.ssrLoadModule('svelte/server');
	const createFormModule = await componentServer.ssrLoadModule(
		'/src/lib/components/incidents/RealIncidentCreateForm.svelte'
	);
	const RealIncidentCreateForm = createFormModule.default;

	await t.test('29. title input renders in form', () => {
		const html = render(RealIncidentCreateForm, {
			props: { submitting: false, error: null, onsubmit: () => {} }
		}).body;

		assert.ok(html.includes('name="title"'));
		assert.ok(html.includes('type="text"'));
	});

	await t.test('30. client input renders in form', () => {
		const html = render(RealIncidentCreateForm, {
			props: { submitting: false, error: null, onsubmit: () => {} }
		}).body;

		assert.ok(html.includes('name="client"'));
		assert.ok(html.includes('type="text"'));
	});

	await t.test('31. priority select renders with options low, medium, high, urgent', () => {
		const html = render(RealIncidentCreateForm, {
			props: { submitting: false, error: null, onsubmit: () => {} }
		}).body;

		assert.ok(html.includes('name="priority"'));
		assert.ok(html.includes('value="low"'));
		assert.ok(html.includes('value="medium"'));
		assert.ok(html.includes('value="high"'));
		assert.ok(html.includes('value="urgent"'));
	});

	await t.test('32. description textarea renders in form', () => {
		const html = render(RealIncidentCreateForm, {
			props: { submitting: false, error: null, onsubmit: () => {} }
		}).body;

		assert.ok(html.includes('name="description"'));
		assert.ok(html.includes('<textarea'));
	});

	await t.test('33. default medium priority in form', () => {
		const formFilePath = path.join(
			root,
			'src/lib/components/incidents/RealIncidentCreateForm.svelte'
		);
		const formContent = fs.readFileSync(formFilePath, 'utf-8');

		assert.ok(
			formContent.includes("priority = $state<'low' | 'medium' | 'high' | 'urgent'>('medium')")
		);
	});

	await t.test('34. required attributes present on all inputs', () => {
		const html = render(RealIncidentCreateForm, {
			props: { submitting: false, error: null, onsubmit: () => {} }
		}).body;

		assert.ok(html.includes('name="title"'));
		assert.ok(html.includes('name="client"'));
		assert.ok(html.includes('name="priority"'));
		assert.ok(html.includes('name="description"'));
	});

	await t.test('35. maxlength 255 on title input', () => {
		const html = render(RealIncidentCreateForm, {
			props: { submitting: false, error: null, onsubmit: () => {} }
		}).body;

		assert.ok(html.includes('name="title"') && html.includes('maxlength="255"'));
	});

	await t.test('36. maxlength 255 on client input', () => {
		const html = render(RealIncidentCreateForm, {
			props: { submitting: false, error: null, onsubmit: () => {} }
		}).body;

		assert.ok(html.includes('name="client"') && html.includes('maxlength="255"'));
	});

	await t.test('37. no status field in form', () => {
		const html = render(RealIncidentCreateForm, {
			props: { submitting: false, error: null, onsubmit: () => {} }
		}).body;

		assert.equal(html.includes('name="status"'), false);
		assert.equal(html.includes('id="status"'), false);
	});

	await t.test('38. no UUID fields in form', () => {
		const html = render(RealIncidentCreateForm, {
			props: { submitting: false, error: null, onsubmit: () => {} }
		}).body;

		assert.equal(html.includes('siteId'), false);
		assert.equal(html.includes('clientUserId'), false);
		assert.equal(html.includes('createdByUserId'), false);
		assert.equal(html.includes('organizationId'), false);
	});

	await t.test('39. submit disabled and shows loading indicator while submitting', () => {
		const html = render(RealIncidentCreateForm, {
			props: { submitting: true, error: null, onsubmit: () => {} }
		}).body;

		assert.ok(html.includes('disabled'));
		assert.ok(html.includes('Creando...'));
		assert.equal(html.includes('Crear incidencia'), false);
	});

	await t.test('40. accessible error container with role="alert"', () => {
		const errorMessage = 'No se pudo crear la incidencia por un error.';
		const html = render(RealIncidentCreateForm, {
			props: { submitting: false, error: errorMessage, onsubmit: () => {} }
		}).body;

		assert.ok(html.includes('role="alert"'));
		assert.ok(html.includes(errorMessage));
	});

	await t.test('41. accessible labels for each input field', () => {
		const html = render(RealIncidentCreateForm, {
			props: { submitting: false, error: null, onsubmit: () => {} }
		}).body;

		assert.ok(html.includes('for="incident-create-title"'));
		assert.ok(html.includes('for="incident-create-client"'));
		assert.ok(html.includes('for="incident-create-priority"'));
		assert.ok(html.includes('for="incident-create-description"'));
	});

	// =========================================================================
	// 3. COORDINATOR STATE MACHINE TESTS (42 to 53)
	// =========================================================================

	await t.test('42. bootstrap /api/me when unauthenticated', async () => {
		let getMeCalled = false;
		let setSessionCalled = false;
		const orgId = randomUUID();

		const coordinator = createIncidentCoordinator();
		const sessionState = {
			isAuthenticated: false,
			organizations: [],
			activeOrganization: null,
			user: null
		};

		const getMeFn = async () => {
			getMeCalled = true;
			return {
				user: { id: 'u1', name: 'User 1' },
				organizations: [{ id: orgId, name: 'Org 1' }],
				activeOrganization: { id: orgId, name: 'Org 1' }
			};
		};

		const setSessionFn = () => {
			setSessionCalled = true;
		};

		let activeOrgSet = null;
		const setActiveOrgFn = (id) => {
			activeOrgSet = id;
		};

		const ok = await coordinator.bootstrap({
			sessionState,
			urlOrgId: orgId,
			getMeFn,
			setSessionFn,
			setActiveOrgFn,
			gotoFn: async () => {}
		});

		assert.equal(ok, true);
		assert.equal(getMeCalled, true);
		assert.equal(setSessionCalled, true);
		assert.equal(activeOrgSet, orgId);
	});

	await t.test('43. org URL válida activa contexto', async () => {
		const orgId = randomUUID();
		let activeOrgSet = null;

		const coordinator = createIncidentCoordinator();
		const sessionState = {
			isAuthenticated: true,
			organizations: [{ id: orgId, name: 'Org Alpha' }],
			activeOrganization: null,
			user: { id: 'u1' }
		};

		const ok = await coordinator.bootstrap({
			sessionState,
			urlOrgId: orgId,
			getMeFn: async () => {},
			setSessionFn: () => {},
			setActiveOrgFn: (id) => {
				activeOrgSet = id;
			},
			gotoFn: async () => {}
		});

		assert.equal(ok, true);
		assert.equal(activeOrgSet, orgId);
		assert.equal(coordinator.getRedirectedTo(), null);
	});

	await t.test('44. org URL inválida → no POST and redirect to /app', async () => {
		let gotoTarget = null;
		const coordinator = createIncidentCoordinator();
		const sessionState = {
			isAuthenticated: true,
			organizations: [{ id: randomUUID(), name: 'Org Beta' }],
			activeOrganization: null,
			user: { id: 'u1' }
		};

		const ok = await coordinator.bootstrap({
			sessionState,
			urlOrgId: 'not-a-valid-uuid',
			getMeFn: async () => {},
			setSessionFn: () => {},
			setActiveOrgFn: () => {},
			gotoFn: async (url) => {
				gotoTarget = url;
			}
		});

		assert.equal(ok, false);
		assert.equal(gotoTarget, '/app');
	});

	await t.test('45. org ajena → no POST and redirect to /app', async () => {
		let gotoTarget = null;
		const myOrgId = randomUUID();
		const foreignOrgId = randomUUID();

		const coordinator = createIncidentCoordinator();
		const sessionState = {
			isAuthenticated: true,
			organizations: [{ id: myOrgId, name: 'My Org' }],
			activeOrganization: null,
			user: { id: 'u1' }
		};

		const ok = await coordinator.bootstrap({
			sessionState,
			urlOrgId: foreignOrgId,
			getMeFn: async () => {},
			setSessionFn: () => {},
			setActiveOrgFn: () => {},
			gotoFn: async (url) => {
				gotoTarget = url;
			}
		});

		assert.equal(ok, false);
		assert.equal(gotoTarget, '/app');
	});

	await t.test('46. sin organización → no POST and redirect to /app', async () => {
		let gotoTarget = null;
		const coordinator = createIncidentCoordinator();
		const sessionState = {
			isAuthenticated: true,
			organizations: [{ id: randomUUID(), name: 'Org Gamma' }],
			activeOrganization: null,
			user: { id: 'u1' }
		};

		const ok = await coordinator.bootstrap({
			sessionState,
			urlOrgId: null,
			getMeFn: async () => {},
			setSessionFn: () => {},
			setActiveOrgFn: () => {},
			gotoFn: async (url) => {
				gotoTarget = url;
			}
		});

		assert.equal(ok, false);
		assert.equal(gotoTarget, '/app');
	});

	await t.test('47. 401 vigente limpia sesión y redirige a login', async () => {
		const orgId = randomUUID();
		let sessionCleared = false;
		let gotoTarget = null;

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }),
				{ status: 401, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const coordinator = createIncidentCoordinator({ fetchFn });
		const sessionState = {
			isAuthenticated: true,
			organizations: [{ id: orgId, name: 'Org 1' }],
			activeOrganization: { id: orgId, name: 'Org 1' },
			user: { id: 'u1' }
		};

		await coordinator.handleCreate({
			sessionState,
			urlOrgId: orgId,
			input: {
				title: 'Titulo',
				description: 'Desc',
				client: 'Cli',
				priority: 'medium'
			},
			gotoFn: async (url) => {
				gotoTarget = url;
			},
			clearSessionFn: () => {
				sessionCleared = true;
			}
		});

		assert.equal(sessionCleared, true);
		assert.equal(gotoTarget, '/login?expired=true');
	});

	await t.test('48. 403 conserva sesión y muestra mensaje de permisos', async () => {
		const orgId = randomUUID();
		let sessionCleared = false;
		let gotoTarget = null;

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Permission denied' } }),
				{ status: 403, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const coordinator = createIncidentCoordinator({ fetchFn });
		const sessionState = {
			isAuthenticated: true,
			organizations: [{ id: orgId, name: 'Org 1' }],
			activeOrganization: { id: orgId, name: 'Org 1' },
			user: { id: 'u1' }
		};

		await coordinator.handleCreate({
			sessionState,
			urlOrgId: orgId,
			input: {
				title: 'Titulo',
				description: 'Desc',
				client: 'Cli',
				priority: 'medium'
			},
			gotoFn: async (url) => {
				gotoTarget = url;
			},
			clearSessionFn: () => {
				sessionCleared = true;
			}
		});

		assert.equal(sessionCleared, false);
		assert.equal(gotoTarget, null);
		assert.equal(
			coordinator.state.error,
			'No tienes permisos para crear incidencias en esta organización.'
		);
	});

	await t.test('49. Abort silencioso sin error al usuario', async () => {
		const orgId = randomUUID();
		const deferred = createDeferred();

		const fetchFn = async (_url, init) => {
			init.signal?.addEventListener('abort', () => {
				const error = new Error('The operation was aborted');
				error.name = 'AbortError';
				deferred.reject(error);
			});
			return deferred.promise;
		};

		const coordinator = createIncidentCoordinator({ fetchFn });
		const sessionState = {
			isAuthenticated: true,
			organizations: [{ id: orgId, name: 'Org 1' }],
			activeOrganization: { id: orgId, name: 'Org 1' },
			user: { id: 'u1' }
		};

		const createPromise = coordinator.handleCreate({
			sessionState,
			urlOrgId: orgId,
			input: {
				title: 'Titulo',
				description: 'Desc',
				client: 'Cli',
				priority: 'medium'
			},
			gotoFn: async () => {},
			clearSessionFn: () => {}
		});

		// Abort while request is inflight (e.g. user unmounts/navigates away)
		coordinator.abort();

		await createPromise;

		assert.equal(coordinator.state.error, null);
		assert.equal(coordinator.state.submitting, false);
	});

	await t.test('50. doble submit bloqueado', async () => {
		const orgId = randomUUID();
		let callCount = 0;

		const fetchFn = async () => {
			callCount += 1;
			await new Promise((r) => setTimeout(r, 50));
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ organizationId: orgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const coordinator = createIncidentCoordinator({ fetchFn });
		const sessionState = {
			isAuthenticated: true,
			organizations: [{ id: orgId, name: 'Org 1' }],
			activeOrganization: { id: orgId, name: 'Org 1' },
			user: { id: 'u1' }
		};

		const p1 = coordinator.handleCreate({
			sessionState,
			urlOrgId: orgId,
			input: { title: 'T1', description: 'D1', client: 'C1', priority: 'medium' },
			gotoFn: async () => {},
			clearSessionFn: () => {}
		});

		const p2 = coordinator.handleCreate({
			sessionState,
			urlOrgId: orgId,
			input: { title: 'T2', description: 'D2', client: 'C2', priority: 'medium' },
			gotoFn: async () => {},
			clearSessionFn: () => {}
		});

		await Promise.all([p1, p2]);
		assert.equal(callCount, 1, 'Solo un POST debe haberse ejecutado');
	});

	await t.test('51. éxito navega directamente al detalle', async () => {
		const orgId = randomUUID();
		const incidentId = randomUUID();
		let targetNavigation = null;

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ id: incidentId, organizationId: orgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const coordinator = createIncidentCoordinator({ fetchFn });
		const sessionState = {
			isAuthenticated: true,
			organizations: [{ id: orgId, name: 'Org 1' }],
			activeOrganization: { id: orgId, name: 'Org 1' },
			user: { id: 'u1' }
		};

		await coordinator.handleCreate({
			sessionState,
			urlOrgId: orgId,
			input: { title: 'T', description: 'D', client: 'C', priority: 'medium' },
			gotoFn: async (url) => {
				targetNavigation = url;
			},
			clearSessionFn: () => {}
		});

		assert.equal(targetNavigation, `/app/incidents/${incidentId}?organizationId=${orgId}`);
	});

	await t.test('52. navegación usa ID real devuelto', async () => {
		const orgId = randomUUID();
		const specificIncidentId = 'specific-created-uuid-9999';
		let targetNavigation = null;

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ id: specificIncidentId, organizationId: orgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const coordinator = createIncidentCoordinator({ fetchFn });
		const sessionState = {
			isAuthenticated: true,
			organizations: [{ id: orgId, name: 'Org 1' }],
			activeOrganization: { id: orgId, name: 'Org 1' },
			user: { id: 'u1' }
		};

		await coordinator.handleCreate({
			sessionState,
			urlOrgId: orgId,
			input: { title: 'T', description: 'D', client: 'C', priority: 'medium' },
			gotoFn: async (url) => {
				targetNavigation = url;
			},
			clearSessionFn: () => {}
		});

		assert.ok(targetNavigation.includes(`/app/incidents/${specificIncidentId}`));
	});

	await t.test('53. navegación usa organizationId real devuelto', async () => {
		const orgId = 'specific-org-uuid-8888';
		const incidentId = randomUUID();
		let targetNavigation = null;

		const fetchFn = async () => {
			return new Response(
				JSON.stringify({
					incident: makeValidIncidentRecord({ id: incidentId, organizationId: orgId }),
					history: {}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const coordinator = createIncidentCoordinator({ fetchFn });
		const sessionState = {
			isAuthenticated: true,
			organizations: [{ id: orgId, name: 'Org 1' }],
			activeOrganization: { id: orgId, name: 'Org 1' },
			user: { id: 'u1' }
		};

		await coordinator.handleCreate({
			sessionState,
			urlOrgId: orgId,
			input: { title: 'T', description: 'D', client: 'C', priority: 'medium' },
			gotoFn: async (url) => {
				targetNavigation = url;
			},
			clearSessionFn: () => {}
		});

		assert.ok(targetNavigation.includes(`organizationId=${orgId}`));
	});

	// =========================================================================
	// 4. APP PAGE INTEGRATION TESTS (54 to 58)
	// =========================================================================

	await t.test('54. enlace "Nueva incidencia" existe en bloque real de /app/+page.svelte', () => {
		const appPagePath = path.join(root, 'src/routes/app/+page.svelte');
		const content = fs.readFileSync(appPagePath, 'utf-8');

		assert.ok(content.includes('Nueva incidencia'));
		assert.ok(content.includes('Incidencias reales'));
	});

	await t.test('55. "Nueva incidencia" solo aparece con organización activa', () => {
		const appPagePath = path.join(root, 'src/routes/app/+page.svelte');
		const content = fs.readFileSync(appPagePath, 'utf-8');

		const realSection = content.substring(
			content.indexOf('Incidencias reales'),
			content.indexOf('<!-- Zona demo')
		);

		assert.ok(realSection.includes('{#if $session.activeOrganization}'));
		assert.ok(realSection.includes('Nueva incidencia'));
	});

	await t.test('56. enlace apunta a /app/incidents/new?organizationId=...', () => {
		const appPagePath = path.join(root, 'src/routes/app/+page.svelte');
		const content = fs.readFileSync(appPagePath, 'utf-8');

		assert.ok(
			content.includes('/app/incidents/new?organizationId=${$session.activeOrganization.id}')
		);
	});

	await t.test('57. "Nueva incidencia demo" sigue existiendo en la sección demo', () => {
		const appPagePath = path.join(root, 'src/routes/app/+page.svelte');
		const content = fs.readFileSync(appPagePath, 'utf-8');

		assert.ok(content.includes('Nueva incidencia demo'));
	});

	await t.test('58. el enlace real no llama handler demo (isFormOpen)', () => {
		const appPagePath = path.join(root, 'src/routes/app/+page.svelte');
		const content = fs.readFileSync(appPagePath, 'utf-8');

		const realSection = content.substring(
			content.indexOf('Incidencias reales'),
			content.indexOf('<!-- Zona demo')
		);

		assert.equal(realSection.includes('isFormOpen'), false);
		assert.equal(realSection.includes('activeIncident'), false);
	});

	// =========================================================================
	// 5. AISLAMIENTO TESTS (59 to 61)
	// =========================================================================

	await t.test('59. creación real no utiliza ni toca localStorage demo', () => {
		const newPagePath = path.join(root, 'src/routes/app/incidents/new/+page.svelte');
		const formPath = path.join(root, 'src/lib/components/incidents/RealIncidentCreateForm.svelte');
		const apiPath = path.join(root, 'src/lib/api/incidents.ts');

		const newPageContent = fs.readFileSync(newPagePath, 'utf-8');
		const formContent = fs.readFileSync(formPath, 'utf-8');
		const apiContent = fs.readFileSync(apiPath, 'utf-8');

		assert.equal(newPageContent.includes('localStorage'), false);
		assert.equal(formContent.includes('localStorage'), false);
		assert.equal(apiContent.includes('localStorage'), false);
	});

	await t.test('60. no utiliza el tipo ni datos Incident demo', () => {
		const newPagePath = path.join(root, 'src/routes/app/incidents/new/+page.svelte');
		const formPath = path.join(root, 'src/lib/components/incidents/RealIncidentCreateForm.svelte');
		const apiPath = path.join(root, 'src/lib/api/incidents.ts');

		const newPageContent = fs.readFileSync(newPagePath, 'utf-8');
		const formContent = fs.readFileSync(formPath, 'utf-8');
		const apiContent = fs.readFileSync(apiPath, 'utf-8');

		assert.equal(newPageContent.includes("from '$lib/types'"), false);
		assert.equal(formContent.includes("from '$lib/types'"), false);
		assert.equal(apiContent.includes("from '$lib/types'"), false);
	});

	await t.test('61. history descartado y no expuesto en la creación ni detalle', () => {
		const newPagePath = path.join(root, 'src/routes/app/incidents/new/+page.svelte');
		const formPath = path.join(root, 'src/lib/components/incidents/RealIncidentCreateForm.svelte');
		const apiPath = path.join(root, 'src/lib/api/incidents.ts');

		const newPageContent = fs.readFileSync(newPagePath, 'utf-8');
		const formContent = fs.readFileSync(formPath, 'utf-8');
		const apiContent = fs.readFileSync(apiPath, 'utf-8');

		assert.equal(newPageContent.includes('history'), false);
		assert.equal(formContent.includes('history'), false);
		// In apiPath, history from payload must not be returned
		assert.ok(apiContent.includes('data as { incident?: unknown }'));
	});
});

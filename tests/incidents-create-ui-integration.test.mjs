import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIncident, IncidentApiError } from '../src/lib/api/incidents.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
		supportLevel: 'N1',
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
					incident: makeValidIncidentRecord({ organizationId: orgId })
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

	// 2-3. UI-2B: the legacy form (29-41) and the page coordinator that was reproduced inside
	// this test (42-53) no longer exist. Their guarantees (fields, default priority, required
	// and labels, no status/UUID inputs, single submit, navigation to the created incident,
	// 401/403 handling, organization context) are tested against the real code in
	// tests/ui-incident-create.test.mjs.
	// =========================================================================

	// =========================================================================
	// 4. APP PAGE INTEGRATION TESTS (54 to 58)
	// =========================================================================

	await t.test('54. enlace "Nueva incidencia" existe en bloque real de /app/+page.svelte', () => {
		const appPagePath = path.join(root, 'src/routes/app/demo/+page.svelte');
		const content = fs.readFileSync(appPagePath, 'utf-8');

		assert.ok(content.includes('Nueva incidencia'));
		assert.ok(content.includes('Incidencias reales'));
	});

	await t.test('55. "Nueva incidencia" solo aparece con organización activa', () => {
		const appPagePath = path.join(root, 'src/routes/app/demo/+page.svelte');
		const content = fs.readFileSync(appPagePath, 'utf-8');

		const realSection = content.substring(
			content.indexOf('Incidencias reales'),
			content.indexOf('<!-- Zona demo')
		);

		assert.ok(realSection.includes('{#if $session.activeOrganization}'));
		assert.ok(realSection.includes('Nueva incidencia'));
	});

	await t.test('56. enlace apunta a /app/incidents/new?organizationId=...', () => {
		const appPagePath = path.join(root, 'src/routes/app/demo/+page.svelte');
		const content = fs.readFileSync(appPagePath, 'utf-8');

		assert.ok(
			content.includes('/app/incidents/new?organizationId=${$session.activeOrganization.id}')
		);
	});

	await t.test('57. "Nueva incidencia demo" sigue existiendo en la sección demo', () => {
		const appPagePath = path.join(root, 'src/routes/app/demo/+page.svelte');
		const content = fs.readFileSync(appPagePath, 'utf-8');

		assert.ok(content.includes('Nueva incidencia demo'));
	});

	await t.test('58. el enlace real no llama handler demo (isFormOpen)', () => {
		const appPagePath = path.join(root, 'src/routes/app/demo/+page.svelte');
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
		const formPath = path.join(root, 'src/lib/components/incidents/IncidentCreateForm.svelte');
		const apiPath = path.join(root, 'src/lib/api/incident-create.ts');

		const newPageContent = fs.readFileSync(newPagePath, 'utf-8');
		const formContent = fs.readFileSync(formPath, 'utf-8');
		const apiContent = fs.readFileSync(apiPath, 'utf-8');

		assert.equal(newPageContent.includes('localStorage'), false);
		assert.equal(formContent.includes('localStorage'), false);
		assert.equal(apiContent.includes('localStorage'), false);
	});

	await t.test('60. no utiliza el tipo ni datos Incident demo', () => {
		const newPagePath = path.join(root, 'src/routes/app/incidents/new/+page.svelte');
		const formPath = path.join(root, 'src/lib/components/incidents/IncidentCreateForm.svelte');
		const apiPath = path.join(root, 'src/lib/api/incident-create.ts');

		const newPageContent = fs.readFileSync(newPagePath, 'utf-8');
		const formContent = fs.readFileSync(formPath, 'utf-8');
		const apiContent = fs.readFileSync(apiPath, 'utf-8');

		assert.equal(newPageContent.includes("from '$lib/types'"), false);
		assert.equal(formContent.includes("from '$lib/types'"), false);
		assert.equal(apiContent.includes("from '$lib/types'"), false);
	});

	await t.test('61. history descartado y no expuesto en la creación ni detalle', () => {
		const newPagePath = path.join(root, 'src/routes/app/incidents/new/+page.svelte');
		const formPath = path.join(root, 'src/lib/components/incidents/IncidentCreateForm.svelte');
		const apiPath = path.join(root, 'src/lib/api/incident-create.ts');

		const newPageContent = fs.readFileSync(newPagePath, 'utf-8');
		const formContent = fs.readFileSync(formPath, 'utf-8');
		const apiContent = fs.readFileSync(apiPath, 'utf-8');

		assert.equal(newPageContent.includes('history'), false);
		assert.equal(formContent.includes('history'), false);
		// Only `incident` is read from the POST answer (history is never returned).
		assert.ok(apiContent.includes('parseCreatedIncident(body.incident'));
		assert.equal(apiContent.includes('history'), false);
	});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIncident, IncidentApiError } from '../src/lib/api/incidents.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
			return new Response(JSON.stringify({ incident: sample }), {
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
			return new Response(JSON.stringify({ incident: sample }), {
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
			return new Response(JSON.stringify({ incident: sample }), {
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
			return new Response(JSON.stringify({ incident: sample }), {
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
			return new Response(JSON.stringify({ incident: sample }), {
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
				return new Response(JSON.stringify({ incident: sample }), {
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
			return new Response(JSON.stringify({ incident: sample }), {
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

	// 2-3 and 28-35. UI-2C: the legacy page coordinator that was reproduced inside this test
	// (bootstrap, deep links, races) and RealIncidentDetail no longer exist. Their guarantees
	// (identity-bound loading, stale answers ignored, 401/403/404, visible fields, no raw UUIDs,
	// no history or internal notes, back link) are tested against the real code in
	// tests/ui-incident-detail.test.mjs and tests/ui-incident-detail-controller.test.mjs.
	// =========================================================================

	// =========================================================================
	// 4. LISTADO COMPONENT SSR SETUP (RealIncidentList, used by the demo)
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
	const listModule = await componentServer.ssrLoadModule(
		'/src/lib/components/incidents/RealIncidentList.svelte'
	);
	const RealIncidentList = listModule.default;

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

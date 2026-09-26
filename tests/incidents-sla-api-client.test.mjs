import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
	getIncident,
	listIncidents,
	createIncident,
	updateIncidentSla,
	IncidentApiError
} from '../src/lib/api/incidents.ts';

const ORG = randomUUID();
const INC = randomUUID();
const POLICY = randomUUID();
const SLA = {
	slaPolicyId: POLICY,
	slaFirstResponseMinutes: 60,
	slaResolutionMinutes: 480,
	slaAppliedAt: '2026-09-26T10:00:00.000Z',
	firstResponseDueAt: '2026-09-26T11:00:00.000Z',
	resolutionDueAt: '2026-09-26T18:00:00.000Z',
	firstResponseAt: null,
	firstResolvedAt: null,
	slaOverallStatus: 'on_track',
	slaFirstResponseStatus: 'pending',
	slaResolutionStatus: 'pending'
};
function incident(overrides = {}) {
	return {
		id: INC,
		organizationId: ORG,
		incidentNumber: 1,
		title: 'T',
		description: 'D',
		status: 'open',
		priority: 'medium',
		supportLevel: 'N1',
		client: 'C',
		clientUserId: null,
		createdByUserId: randomUUID(),
		siteId: null,
		assignedToUserId: null,
		teamId: null,
		categoryId: null,
		createdAt: '2026-09-26T10:00:00.000Z',
		updatedAt: '2026-09-26T10:00:00.000Z',
		...SLA,
		...overrides
	};
}
function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}
async function rejectsWith(promise, { status, code }) {
	await assert.rejects(promise, (error) => {
		assert.ok(error instanceof IncidentApiError, `esperado IncidentApiError: ${error}`);
		if (status !== undefined) assert.equal(error.status, status);
		assert.equal(error.code, code);
		return true;
	});
}

test('SoporteFlow — Etapa 5.4T-B: cliente de incidencias con SLA', async (t) => {
	await t.test(
		'parser: SLA completo, sin SLA y payload legado (campos ausentes -> null)',
		async () => {
			const withSla = await getIncident(ORG, INC, {
				customFetch: async () => json({ incident: incident() })
			});
			assert.equal(withSla.slaPolicyId, POLICY);
			assert.equal(withSla.firstResponseDueAt, SLA.firstResponseDueAt);
			const none = await getIncident(ORG, INC, {
				customFetch: async () =>
					json({
						incident: incident({
							slaPolicyId: null,
							slaFirstResponseMinutes: null,
							slaResolutionMinutes: null,
							slaAppliedAt: null,
							firstResponseDueAt: null,
							resolutionDueAt: null,
							firstResponseAt: '2026-09-26T10:30:00.000000+00:00',
							slaOverallStatus: 'not_applicable',
							slaFirstResponseStatus: 'not_applicable',
							slaResolutionStatus: 'not_applicable'
						})
					})
			});
			assert.equal(none.slaPolicyId, null);
			assert.equal(none.firstResponseAt, '2026-09-26T10:30:00.000000+00:00');
			const legacy = incident();
			for (const key of Object.keys(SLA)) delete legacy[key];
			const parsed = await getIncident(ORG, INC, {
				customFetch: async () => json({ incident: legacy })
			});
			for (const key of Object.keys(SLA))
				assert.equal(parsed[key], key.endsWith('Status') ? 'not_applicable' : null, key);
		}
	);

	await t.test('parser: SLA incoherente o con tipos inválidos -> INVALID_PAYLOAD', async () => {
		for (const bad of [
			{ slaPolicyId: null },
			{ slaPolicyId: 'x' },
			{ slaFirstResponseMinutes: 0 },
			{ slaFirstResponseMinutes: 1.5 },
			{ slaResolutionMinutes: 30 },
			{ slaAppliedAt: 'ayer' },
			{ resolutionDueAt: null },
			{ firstResponseAt: 5 }
		])
			await rejectsWith(
				listIncidents(ORG, { customFetch: async () => json({ incidents: [incident(bad)] }) }),
				{ code: 'INVALID_PAYLOAD' }
			);
	});

	await t.test(
		'createIncident: slaPolicyId opcional (UUID o null) en el cuerpo; inválido no llama a fetch',
		async () => {
			const calls = [];
			const fetchFn = async (url, init) => {
				calls.push(JSON.parse(init.body));
				return json({ incident: incident() }, 201);
			};
			const base = { title: 'T', description: 'D', client: 'C', priority: 'medium' };
			await createIncident(ORG, base, { customFetch: fetchFn });
			await createIncident(ORG, { ...base, slaPolicyId: POLICY }, { customFetch: fetchFn });
			await createIncident(ORG, { ...base, slaPolicyId: null }, { customFetch: fetchFn });
			assert.ok(!('slaPolicyId' in calls[0]), 'sin campo: el servidor aplica el default');
			assert.equal(calls[1].slaPolicyId, POLICY);
			assert.equal(calls[2].slaPolicyId, null);
			await rejectsWith(
				createIncident(ORG, { ...base, slaPolicyId: 'x' }, { customFetch: fetchFn }),
				{
					status: 0,
					code: 'INVALID_INPUT'
				}
			);
			assert.equal(calls.length, 3);
			await rejectsWith(
				createIncident(ORG, base, {
					customFetch: async () => json({ error: { code: 'SLA_POLICY_INACTIVE' } }, 409)
				}),
				{ status: 409, code: 'SLA_POLICY_INACTIVE' }
			);
			await rejectsWith(
				createIncident(ORG, base, {
					customFetch: async () => json({ error: { code: 'SLA_POLICY_NOT_FOUND' } }, 404)
				}),
				{ status: 404, code: 'SLA_POLICY_NOT_FOUND' }
			);
		}
	);

	await t.test(
		'updateIncidentSla: PATCH exacto, respuesta coherente, errores tipados',
		async () => {
			const controller = new AbortController();
			const calls = [];
			const result = await updateIncidentSla(
				ORG,
				INC,
				{ slaPolicyId: POLICY },
				{
					signal: controller.signal,
					customFetch: async (url, init) => {
						calls.push({ url, init });
						return json({ incident: incident({ extra: 'x' }) });
					}
				}
			);
			assert.equal(result.slaPolicyId, POLICY);
			assert.equal(calls[0].url, `/api/incidents/${INC}/sla?organizationId=${ORG}`);
			assert.equal(calls[0].init.method, 'PATCH');
			assert.equal(calls[0].init.signal, controller.signal);
			assert.deepEqual(JSON.parse(calls[0].init.body), { slaPolicyId: POLICY });
			await rejectsWith(
				updateIncidentSla(
					ORG,
					INC,
					{ slaPolicyId: null },
					{ customFetch: async () => json({ incident: incident() }) }
				),
				{ code: 'INVALID_PAYLOAD' }
			);
			for (const input of [{ slaPolicyId: 'x' }, {}, null]) {
				await rejectsWith(
					updateIncidentSla(ORG, INC, input, { customFetch: async () => json({}) }),
					{
						status: 0,
						code: 'INVALID_INPUT'
					}
				);
			}
			await rejectsWith(updateIncidentSla('x', INC, { slaPolicyId: null }), {
				status: 0,
				code: 'INVALID_INPUT'
			});
			const res = (status, code) => async () =>
				json({ error: { code, message: 'SQL leak' } }, status);
			const cases = [
				[400, 'INVALID_INPUT', 'INVALID_INPUT'],
				[401, 'UNAUTHORIZED', 'UNAUTHORIZED'],
				[403, 'FORBIDDEN', 'FORBIDDEN'],
				[404, 'SLA_POLICY_NOT_FOUND', 'SLA_POLICY_NOT_FOUND'],
				[404, 'INCIDENT_NOT_FOUND', 'NOT_FOUND'],
				[409, 'SLA_POLICY_INACTIVE', 'SLA_POLICY_INACTIVE'],
				[409, 'INCIDENT_CLOSED', 'INCIDENT_CLOSED'],
				[500, 'INTERNAL_ERROR', 'SERVER_ERROR']
			];
			for (const [status, backend, expected] of cases)
				await assert.rejects(
					updateIncidentSla(
						ORG,
						INC,
						{ slaPolicyId: POLICY },
						{ customFetch: res(status, backend) }
					),
					(e) => {
						assert.equal(e.code, expected);
						assert.ok(!e.message.includes('SQL'));
						return true;
					}
				);
		}
	);

	await t.test(
		'updateIncidentSla: AbortError se propaga; fallo de red -> NETWORK_ERROR',
		async () => {
			const controller = new AbortController();
			controller.abort();
			await assert.rejects(
				updateIncidentSla(
					ORG,
					INC,
					{ slaPolicyId: null },
					{
						signal: controller.signal,
						customFetch: async () => {
							throw new DOMException('aborted', 'AbortError');
						}
					}
				),
				(e) => e.name === 'AbortError'
			);
			await rejectsWith(
				updateIncidentSla(
					ORG,
					INC,
					{ slaPolicyId: null },
					{
						customFetch: async () => {
							throw new TypeError('fetch failed');
						}
					}
				),
				{ status: 0, code: 'NETWORK_ERROR' }
			);
		}
	);
});

test('SoporteFlow — Etapa 5.4T-C: cliente, estados de cumplimiento SLA', async (t) => {
	await t.test('estados: enums estrictos y coherentes con la presencia de SLA', async () => {
		const ok = await getIncident(ORG, INC, {
			customFetch: async () =>
				json({
					incident: incident({
						slaOverallStatus: 'breached',
						slaFirstResponseStatus: 'breached',
						slaResolutionStatus: 'pending',
						firstResolvedAt: null
					})
				})
		});
		assert.equal(ok.slaOverallStatus, 'breached');
		for (const bad of [
			{ slaOverallStatus: 'late' },
			{ slaFirstResponseStatus: 'on_track' },
			{
				slaResolutionStatus: undefined,
				slaOverallStatus: undefined,
				slaFirstResponseStatus: undefined
			},
			{ slaOverallStatus: 'not_applicable' },
			{ firstResolvedAt: 'ayer' }
		])
			await rejectsWith(
				getIncident(ORG, INC, { customFetch: async () => json({ incident: incident(bad) }) }),
				{ code: 'INVALID_PAYLOAD' }
			);
		const noSla = {
			slaPolicyId: null,
			slaFirstResponseMinutes: null,
			slaResolutionMinutes: null,
			slaAppliedAt: null,
			firstResponseDueAt: null,
			resolutionDueAt: null
		};
		await rejectsWith(
			getIncident(ORG, INC, {
				customFetch: async () => json({ incident: incident({ ...noSla }) })
			}),
			{ code: 'INVALID_PAYLOAD' },
			'sin SLA pero con estados activos'
		);
		const legacy = incident({
			...noSla,
			slaOverallStatus: undefined,
			slaFirstResponseStatus: undefined,
			slaResolutionStatus: undefined,
			firstResolvedAt: undefined
		});
		const parsed = await getIncident(ORG, INC, {
			customFetch: async () => json({ incident: legacy })
		});
		assert.equal(parsed.slaOverallStatus, 'not_applicable');
		assert.equal(parsed.firstResolvedAt, null);
	});

	await t.test(
		'listIncidents: filtros SLA en la URL; valor inválido no llama a fetch',
		async () => {
			const calls = [];
			await listIncidents(ORG, {
				slaStatus: 'breached',
				slaFirstResponseStatus: 'pending',
				slaResolutionStatus: 'met',
				customFetch: async (url) => {
					calls.push(url);
					return json({ incidents: [] });
				}
			});
			assert.ok(calls[0].includes('&slaStatus=breached'));
			assert.ok(calls[0].includes('&slaFirstResponseStatus=pending'));
			assert.ok(calls[0].includes('&slaResolutionStatus=met'));
			await rejectsWith(
				listIncidents(ORG, { slaStatus: 'late', customFetch: async () => json({ incidents: [] }) }),
				{ status: 0, code: 'INVALID_INPUT' }
			);
			await rejectsWith(
				listIncidents(ORG, {
					slaResolutionStatus: 'on_track',
					customFetch: async () => json({ incidents: [] })
				}),
				{ status: 0, code: 'INVALID_INPUT' }
			);
		}
	);
});

test('SoporteFlow — Corrección 5.4T-C: dominios objective vs overall en el cliente', async (t) => {
	const withStatuses = (over) =>
		incident({
			slaOverallStatus: 'on_track',
			slaFirstResponseStatus: 'pending',
			slaResolutionStatus: 'pending',
			...over
		});
	await t.test(
		'parser: overall acepta on_track y rechaza pending; objetivos aceptan pending',
		async () => {
			for (const over of [
				{},
				{ slaFirstResponseStatus: 'met', slaResolutionStatus: 'pending' },
				{ slaFirstResponseStatus: 'pending', slaResolutionStatus: 'met' }
			]) {
				const parsed = await getIncident(ORG, INC, {
					customFetch: async () => json({ incident: withStatuses(over) })
				});
				assert.equal(parsed.slaOverallStatus, 'on_track');
			}
			for (const bad of [
				{ slaOverallStatus: 'pending' },
				{ slaFirstResponseStatus: 'on_track' },
				{ slaResolutionStatus: 'on_track' }
			])
				await rejectsWith(
					getIncident(ORG, INC, { customFetch: async () => json({ incident: withStatuses(bad) }) }),
					{ code: 'INVALID_PAYLOAD' }
				);
		}
	);

	await t.test(
		'listIncidents: slaStatus=pending no llama a fetch; objetivos pending sí',
		async () => {
			const calls = [];
			const fetchFn = async (url) => {
				calls.push(url);
				return json({ incidents: [] });
			};
			await rejectsWith(listIncidents(ORG, { slaStatus: 'pending', customFetch: fetchFn }), {
				status: 0,
				code: 'INVALID_INPUT'
			});
			await rejectsWith(
				listIncidents(ORG, { slaFirstResponseStatus: 'on_track', customFetch: fetchFn }),
				{ status: 0, code: 'INVALID_INPUT' }
			);
			assert.equal(calls.length, 0);
			await listIncidents(ORG, { slaStatus: 'on_track', customFetch: fetchFn });
			await listIncidents(ORG, {
				slaFirstResponseStatus: 'pending',
				slaResolutionStatus: 'pending',
				customFetch: fetchFn
			});
			assert.ok(calls[0].includes('&slaStatus=on_track'));
			assert.ok(calls[1].includes('&slaFirstResponseStatus=pending&slaResolutionStatus=pending'));
		}
	);
});

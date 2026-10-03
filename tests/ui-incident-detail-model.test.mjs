import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { ApiError } from '../src/lib/api/errors.ts';
import {
	getIncidentDetail,
	parseCreatedIncident,
	parseIncidentDetail,
	parseStaffIncidentRecord
} from '../src/lib/api/incident-detail.ts';
import {
	buildCreateIncidentPayload,
	CreateIncidentInputError,
	submitIncidentCreation
} from '../src/lib/api/incident-create.ts';
import { toIncidentView } from '../src/lib/api/incident-views.ts';
import { SiteApiError, listSites } from '../src/lib/api/sites.ts';
import { getIncident, IncidentApiError } from '../src/lib/api/incidents.ts';

/**
 * UI-2A — incident detail contract. The payloads are produced by the REAL backend projection
 * (src/lib/server/services/incident-dto.ts, loaded through Vite SSR) and serialized to JSON, so
 * the frontend parser is checked against what the server actually sends — not a hand-written copy.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const INCIDENT = randomUUID();
const REQUESTER = randomUUID();
const TECH = randomUUID();
const TEAM = randomUUID();
const POLICY = randomUUID();
const REQUEST_ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const NOW = new Date('2026-09-28T10:00:00.000Z');
const at = (minutes) => new Date(NOW.getTime() + minutes * 60_000);

/** An incident row exactly as the service returns it (26 columns). */
function row(overrides = {}) {
	return {
		id: INCIDENT,
		organizationId: ORG,
		incidentNumber: 42,
		title: 'VPN caída',
		description: 'No conecta desde la sede.',
		status: 'open',
		priority: 'high',
		client: 'Etiqueta interna del cliente',
		clientUserId: REQUESTER,
		createdByUserId: randomUUID(),
		siteId: randomUUID(),
		categoryId: null,
		subcategoryId: null,
		assignedToUserId: TECH,
		teamId: TEAM,
		supportLevel: 'N2',
		slaPolicyId: POLICY,
		slaFirstResponseMinutes: 60,
		slaResolutionMinutes: 480,
		slaAppliedAt: at(-30),
		firstResponseDueAt: at(30),
		resolutionDueAt: at(450),
		firstResponseAt: at(-10),
		firstResolvedAt: null,
		createdAt: at(-30),
		updatedAt: at(-5),
		...overrides
	};
}
const wire = (value) => JSON.parse(JSON.stringify(value));

test('UI-2A — modelo discriminado de detalle contra el DTO real del backend', async (t) => {
	const server = await createServer({
		root,
		configFile: false,
		envDir: false,
		logLevel: 'silent',
		server: { middlewareMode: true, hmr: false, watch: null },
		appType: 'custom'
	});
	t.after(() => server.close());
	const { toIncidentDto } = await server.ssrLoadModule('/src/lib/server/services/incident-dto.ts');
	const staffDetail = (overrides) =>
		wire(
			toIncidentDto(
				{ ...row(overrides), assignedToUserName: 'Luis Técnico', teamName: 'Redes' },
				'staff',
				NOW
			)
		);
	const expect = { organizationId: ORG, incidentId: INCIDENT };

	await t.test('A. staff conserva campos internos y todo el snapshot/fechas SLA', () => {
		const detail = parseIncidentDetail(staffDetail(), expect);
		assert.equal(detail.audience, 'staff');
		assert.equal(detail.client, 'Etiqueta interna del cliente');
		assert.equal(detail.assignedToUserId, TECH);
		assert.equal(detail.assignedToUserName, 'Luis Técnico');
		assert.equal(detail.teamId, TEAM);
		assert.equal(detail.teamName, 'Redes');
		assert.equal(detail.supportLevel, 'N2');
		assert.equal(detail.slaPolicyId, POLICY);
		assert.equal(detail.slaFirstResponseMinutes, 60);
		assert.equal(detail.slaResolutionMinutes, 480);
		assert.equal(detail.slaAppliedAt, at(-30).toISOString());
		assert.equal(detail.firstResponseDueAt, at(30).toISOString());
		assert.equal(detail.resolutionDueAt, at(450).toISOString());
		assert.equal(detail.firstResponseAt, at(-10).toISOString());
		assert.equal(detail.firstResolvedAt, null);
		// statuses are the server's derivation, kept verbatim (never recomputed client-side)
		assert.equal(detail.slaFirstResponseStatus, 'met');
		assert.equal(detail.slaResolutionStatus, 'pending');
		assert.equal(detail.slaOverallStatus, 'on_track');
		assert.ok(Object.isFrozen(detail));
		// every key the server sent is preserved (plus the discriminator)
		assert.deepEqual(
			Object.keys(detail).sort(),
			['audience', ...Object.keys(staffDetail())].sort()
		);
	});

	await t.test('A. staff sin SLA: snapshot nulo y estados not_applicable', () => {
		const detail = parseIncidentDetail(
			staffDetail({
				slaPolicyId: null,
				slaFirstResponseMinutes: null,
				slaResolutionMinutes: null,
				slaAppliedAt: null,
				firstResponseDueAt: null,
				resolutionDueAt: null,
				firstResponseAt: null,
				assignedToUserId: null,
				teamId: null
			}),
			expect
		);
		assert.equal(detail.audience, 'staff');
		assert.equal(detail.slaOverallStatus, 'not_applicable');
		assert.equal(detail.assignedToUserId, null);
	});

	await t.test('A. requester: solo la allowlist, ninguna propiedad interna', () => {
		const payload = wire(toIncidentDto(row(), 'requester', NOW));
		const detail = parseIncidentDetail(payload, expect);
		assert.equal(detail.audience, 'requester');
		for (const internal of [
			'client',
			'createdByUserId',
			'supportLevel',
			'assignedToUserId',
			'assignedToUserName',
			'teamId',
			'teamName',
			'slaPolicyId',
			'slaFirstResponseMinutes',
			'slaResolutionMinutes',
			'slaAppliedAt',
			'firstResponseDueAt',
			'resolutionDueAt',
			'firstResponseAt',
			'firstResolvedAt'
		])
			assert.equal(internal in detail, false, `${internal} no existe (ni como null)`);
		assert.equal(detail.slaOverallStatus, 'on_track', 'cumplimiento visible para el cliente');
		assert.equal(Object.keys(detail).length, 17);
	});

	await t.test('A. requester con datos internos inesperados -> INVALID_PAYLOAD', () => {
		const payload = wire(toIncidentDto(row(), 'requester', NOW));
		for (const leak of [
			{ client: 'x' },
			{ teamName: 'Redes' },
			{ assignedToUserId: TECH },
			{ slaPolicyId: POLICY },
			{ teamName: null }
		])
			assert.throws(
				() => parseIncidentDetail({ ...payload, ...leak }, expect),
				(error) => error instanceof ApiError && error.code === 'INVALID_PAYLOAD'
			);
	});

	await t.test('A. validación estricta: tenant, id, claves, SLA parcial, tipos', () => {
		const good = staffDetail();
		const invalid = [
			{ ...good, organizationId: OTHER_ORG },
			{ ...good, id: randomUUID() },
			{ ...good, audience: 'staff' },
			{ ...good, extra: 1 },
			(({ teamName, ...rest }) => (void teamName, rest))(good),
			{ ...good, slaResolutionMinutes: null },
			{ ...good, slaOverallStatus: 'at_risk' },
			{ ...good, slaOverallStatus: 'not_applicable' },
			{ ...good, status: 'archived' },
			{ ...good, supportLevel: 'N4' },
			{ ...good, createdAt: 'ayer' },
			{ ...good, clientUserId: 'no-uuid' }
		];
		for (const payload of invalid)
			assert.throws(
				() => parseIncidentDetail(payload, expect),
				(error) => error instanceof ApiError && error.code === 'INVALID_PAYLOAD'
			);
	});

	await t.test('A. mutaciones y POST: registro staff sin nombres unidos (no se inventan)', () => {
		const record = wire(toIncidentDto(row(), 'staff', NOW));
		const parsed = parseStaffIncidentRecord(record, expect);
		assert.equal(parsed.audience, 'staff');
		assert.equal('assignedToUserName' in parsed, false);
		assert.equal('teamName' in parsed, false);
		// a detail parser never accepts a record without the joined names
		assert.throws(() => parseIncidentDetail(record, expect), /./);
		// POST answers with the creator's audience projection
		assert.equal(parseCreatedIncident(record, { organizationId: ORG }).audience, 'staff');
		assert.equal(
			parseCreatedIncident(wire(toIncidentDto(row(), 'requester', NOW)), {
				organizationId: ORG
			}).audience,
			'requester'
		);
	});

	await t.test('A. compatibilidad: el modelo de listado UI-1 sigue aceptando ambos DTO', () => {
		assert.equal(toIncidentView(wire(toIncidentDto(row(), 'staff', NOW)), ORG).audience, 'staff');
		assert.equal(
			toIncidentView(wire(toIncidentDto(row(), 'requester', NOW)), ORG).audience,
			'requester'
		);
	});

	await t.test('A. clasificación: categoría + subcategoría opcional en ambos DTO', () => {
		const CATEGORY = randomUUID();
		const SUBCATEGORY = randomUUID();
		const classified = { categoryId: CATEGORY, subcategoryId: SUBCATEGORY };
		for (const audience of ['staff', 'requester']) {
			const dto = (overrides) =>
				audience === 'staff'
					? staffDetail(overrides)
					: wire(toIncidentDto(row(overrides), 'requester', NOW));
			// the backend sends the subcategory (or null) in both projections
			const detail = parseIncidentDetail(dto(classified), expect);
			assert.equal(detail.categoryId, CATEGORY, audience);
			assert.equal(detail.subcategoryId, SUBCATEGORY, audience);
			assert.equal(parseIncidentDetail(dto({}), expect).subcategoryId, null, audience);
			const list = toIncidentView(dto(classified), ORG);
			assert.equal(list.subcategoryId, SUBCATEGORY, `${audience}: listado`);
			// the DB invariant (no subcategory without its category) is also a contract invariant
			const orphan = dto({ categoryId: null, subcategoryId: SUBCATEGORY });
			assert.throws(() => parseIncidentDetail(orphan, expect), isInvalidPayload, audience);
			assert.throws(() => toIncidentView(orphan, ORG), isInvalidPayload, `${audience}: listado`);
			assert.throws(
				() => parseIncidentDetail({ ...dto(classified), subcategoryId: 'no-uuid' }, expect),
				isInvalidPayload,
				audience
			);
		}
	});
});

const isInvalidPayload = (error) => error instanceof ApiError && error.code === 'INVALID_PAYLOAD';

const jsonResponse = (status, body, headers = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});

test('UI-2A — cliente de detalle: errores normalizados con Retry-After y X-Request-ID', async () => {
	const limited = () =>
		jsonResponse(
			429,
			{ error: { code: 'RATE_LIMITED', message: 'x' } },
			{
				'retry-after': '12',
				'x-request-id': REQUEST_ID
			}
		);
	await assert.rejects(
		getIncidentDetail(ORG, INCIDENT, { customFetch: async () => limited() }),
		(error) =>
			error instanceof ApiError &&
			error.status === 429 &&
			error.retryAfterSeconds === 12 &&
			error.requestId === REQUEST_ID &&
			error.kind === 'rate-limited'
	);
	await assert.rejects(
		getIncidentDetail(ORG, INCIDENT, {
			customFetch: async () =>
				jsonResponse(404, { error: { code: 'INCIDENT_NOT_FOUND', message: 'x' } })
		}),
		(error) => error.code === 'INCIDENT_NOT_FOUND' && error.kind === 'not-found'
	);
	await assert.rejects(
		getIncidentDetail(ORG, INCIDENT, {
			customFetch: async () => {
				throw new TypeError('offline');
			}
		}),
		(error) => error.status === 0 && error.code === 'NETWORK_ERROR'
	);
	await assert.rejects(
		getIncidentDetail(ORG, INCIDENT, {
			customFetch: async () =>
				jsonResponse(200, { incident: { audience: 'requester' } }, { 'x-request-id': REQUEST_ID })
		}),
		(error) => error.code === 'INVALID_PAYLOAD' && error.requestId === REQUEST_ID
	);
	let called = false;
	await assert.rejects(
		getIncidentDetail('no-uuid', INCIDENT, {
			customFetch: async () => ((called = true), jsonResponse(200, {}))
		}),
		(error) => error.status === 0 && error.code === 'INVALID_INPUT'
	);
	assert.equal(called, false, 'no request with an invalid id');
});

test('UI-2A — clientes legacy conservan Retry-After / X-Request-ID (misma clasificación)', async () => {
	const unavailable = async () =>
		jsonResponse(
			503,
			{ error: { code: 'LIMITER_UNAVAILABLE', message: 'x' } },
			{
				'retry-after': '7',
				'x-request-id': REQUEST_ID
			}
		);
	await assert.rejects(
		getIncident(ORG, INCIDENT, { customFetch: unavailable }),
		(error) =>
			error instanceof IncidentApiError &&
			error instanceof ApiError &&
			error.code === 'SERVER_ERROR' &&
			error.retryAfterSeconds === 7 &&
			error.requestId === REQUEST_ID
	);
	await assert.rejects(
		listSites({ organizationId: ORG, customFetch: unavailable }),
		(error) =>
			error instanceof SiteApiError &&
			error instanceof ApiError &&
			error.kind === 'unavailable' &&
			error.retryAfterSeconds === 7 &&
			error.requestId === REQUEST_ID
	);
});

test('UI-2A — contrato de creación: campos reales, nada inventado', async () => {
	const payload = buildCreateIncidentPayload(ORG, {
		title: '  Impresora  ',
		description: ' Sin tóner ',
		client: ' Recepción ',
		priority: 'medium',
		siteId: null,
		categoryId: randomUUID(),
		slaPolicyId: null
	});
	assert.deepEqual(Object.keys(payload).sort(), [
		'categoryId',
		'client',
		'description',
		'organizationId',
		'priority',
		'siteId',
		'slaPolicyId',
		'title'
	]);
	assert.equal(payload.title, 'Impresora');
	assert.equal(payload.client, 'Recepción', '`client` sigue siendo texto explícito');
	assert.equal('clientUserId' in payload, false, 'el solicitante lo fija el servidor');
	// a smuggled requester is refused before any request, never forwarded
	assert.throws(() =>
		buildCreateIncidentPayload(ORG, {
			title: 'T',
			description: 'D',
			priority: 'low',
			clientUserId: REQUESTER
		})
	);
	assert.equal(payload.slaPolicyId, null, 'null (sin SLA) se conserva');
	// omitted optional ids stay omitted (server defaults: requester, default SLA policy)
	const minimal = buildCreateIncidentPayload(ORG, {
		title: 'T',
		description: 'D',
		client: 'C',
		priority: 'low'
	});
	assert.deepEqual(Object.keys(minimal).sort(), [
		'client',
		'description',
		'organizationId',
		'priority',
		'title'
	]);
	for (const invented of [{ status: 'open' }, { supportLevel: 'N1' }, { teamId: TEAM }])
		assert.throws(
			() =>
				buildCreateIncidentPayload(ORG, {
					title: 'T',
					description: 'D',
					client: 'C',
					priority: 'low',
					...invented
				}),
			CreateIncidentInputError
		);
	const long = 'x'.repeat(10_000);
	assert.equal(
		buildCreateIncidentPayload(ORG, { title: 'T', description: long, client: 'C', priority: 'low' })
			.description.length,
		10_000,
		'no se inventa un límite de descripción'
	);
	assert.throws(
		() =>
			buildCreateIncidentPayload(ORG, {
				title: 'x'.repeat(256),
				description: 'D',
				client: 'C',
				priority: 'low'
			}),
		(error) => error.field === 'title'
	);
	assert.throws(
		() =>
			buildCreateIncidentPayload(ORG, {
				title: ' ',
				description: 'D',
				client: 'C',
				priority: 'low'
			}),
		(error) => error.field === 'title' && error.status === 0
	);
	let body;
	const created = await submitIncidentCreation(
		ORG,
		{ title: 'T', description: 'D', client: 'C', priority: 'low' },
		{
			customFetch: async (url, init) => {
				body = JSON.parse(init.body);
				return jsonResponse(201, {
					incident: {
						audience: 'requester',
						id: randomUUID(),
						organizationId: ORG,
						incidentNumber: 1,
						title: 'T',
						description: 'D',
						status: 'open',
						priority: 'low',
						clientUserId: REQUESTER,
						siteId: null,
						categoryId: null,
						subcategoryId: null,
						slaOverallStatus: 'not_applicable',
						slaFirstResponseStatus: 'not_applicable',
						slaResolutionStatus: 'not_applicable',
						createdAt: NOW.toISOString(),
						updatedAt: NOW.toISOString()
					}
				});
			}
		}
	);
	assert.equal('status' in body, false, 'el estado inicial lo fija el servidor');
	assert.equal('supportLevel' in body, false, 'el nivel inicial lo fija el servidor');
	assert.equal(created.audience, 'requester');
});

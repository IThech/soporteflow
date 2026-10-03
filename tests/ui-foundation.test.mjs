import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
	ApiError,
	apiErrorFromResponse,
	parseRetryAfter,
	readRequestId,
	DEFAULT_RETRY_AFTER_SECONDS,
	MAX_RETRY_AFTER_SECONDS
} from '../src/lib/api/errors.ts';
import { IncidentApiError } from '../src/lib/api/incidents.ts';
import { AuthApiError } from '../src/lib/api/auth.ts';
import { createRequestScope, isStaleRequest } from '../src/lib/app/request-scope.ts';
import {
	adminModuleAccess,
	availableQueues,
	canAccessAdmin,
	defaultQueue,
	incidentReadScope,
	navigationModel,
	resolveQueue
} from '../src/lib/app/capabilities.ts';
import { createOrganizationContext } from '../src/lib/app/organization-context.ts';
import {
	buildIncidentPageSearch,
	listIncidentsPage,
	toIncidentView
} from '../src/lib/api/incident-views.ts';
import {
	createIncidentListController,
	hasActiveFilters
} from '../src/lib/app/incident-list-controller.ts';

/** UI-1A foundation: pure modules (no DOM, no Svelte runtime). */
const REQ_ID = '3f2b8a1e-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const deferred = () => {
	let resolve, reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};
const json = (status, body, headers = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});

// ------------------------------------------------------------------------------------------ errors
test('ApiError: code/message/status, Retry-After y X-Request-ID', async () => {
	const res = json(
		429,
		{ error: { code: 'RATE_LIMITED', message: 'Too many requests.' } },
		{ 'retry-after': '17', 'x-request-id': REQ_ID, 'set-cookie': 'x=1' }
	);
	const error = await apiErrorFromResponse(res);
	assert.ok(error instanceof ApiError);
	assert.equal(error.status, 429);
	assert.equal(error.code, 'RATE_LIMITED');
	assert.equal(error.kind, 'rate-limited');
	assert.equal(error.retryAfterSeconds, 17);
	assert.equal(error.requestId, REQ_ID);
	assert.equal(Object.keys(error).includes('headers'), false, 'no se guardan otras cabeceras');
	// 5xx: backend message never shown; request id kept for support
	const server = await apiErrorFromResponse(
		json(
			500,
			{ error: { code: 'INTERNAL_ERROR', message: 'stack at db.ts' } },
			{ 'x-request-id': REQ_ID }
		)
	);
	assert.equal(server.kind, 'server');
	assert.ok(!server.message.includes('db.ts'));
	assert.equal(server.requestId, REQ_ID);
	// 4xx correctable: backend message kept; code preserved
	const conflict = await apiErrorFromResponse(
		json(409, { error: { code: 'INVITATION_ALREADY_PENDING', message: 'Ya existe.' } })
	);
	assert.equal(conflict.code, 'INVITATION_ALREADY_PENDING');
	assert.equal(conflict.message, 'Ya existe.');
	// non-JSON body and hostile request id
	const odd = await apiErrorFromResponse(
		new Response('<html>', { status: 403, headers: { 'x-request-id': 'forged value; not-an-id' } })
	);
	assert.equal(odd.code, 'FORBIDDEN');
	assert.equal(odd.requestId, undefined);
	for (const [status, kind] of [
		[401, 'unauthenticated'],
		[404, 'not-found'],
		[413, 'payload-too-large'],
		[422, 'unprocessable'],
		[503, 'unavailable']
	])
		assert.equal((await apiErrorFromResponse(new Response('', { status }))).kind, kind);
	// client-specific errors specialise the common one
	assert.ok(new IncidentApiError(403, 'FORBIDDEN', 'x') instanceof ApiError);
	assert.ok(new AuthApiError(401, 'UNAUTHORIZED', 'x', { requestId: REQ_ID }) instanceof ApiError);
});

test('Retry-After: segundos, HTTP-date, inválido y límites', () => {
	const now = Date.parse('2026-09-28T10:00:00Z');
	assert.equal(parseRetryAfter('120', now), 120);
	assert.equal(parseRetryAfter('Mon, 28 Sep 2026 10:01:00 GMT', now), 60);
	assert.equal(parseRetryAfter('Mon, 28 Sep 2026 09:00:00 GMT', now), 0, 'fecha pasada -> 0');
	assert.equal(parseRetryAfter('99999999', now), MAX_RETRY_AFTER_SECONDS);
	for (const bad of [null, undefined, '', '  ', '-5', '1.5', 'soon', '12abc'])
		assert.equal(parseRetryAfter(bad, now), null, String(bad));
	assert.equal(readRequestId(new Headers({ 'x-request-id': REQ_ID.toUpperCase() })), REQ_ID);
});

test('429 sin Retry-After válido: espera segura por defecto', async () => {
	const error = await apiErrorFromResponse(
		new Response('', { status: 429, headers: { 'retry-after': 'nope' } })
	);
	assert.equal(error.retryAfterSeconds, DEFAULT_RETRY_AFTER_SECONDS);
});

// ----------------------------------------------------------------------------------- staleness
test('request scope: generación + contexto; AbortController no basta', async () => {
	const scope = createRequestScope('user:A');
	const late = deferred();
	const pending = scope.run(() => late.promise); // ignores the abort signal on purpose
	scope.setContext('user:B');
	late.resolve('data of A');
	await assert.rejects(pending, (e) => isStaleRequest(e));
	// a newer request makes the older one stale even within the same context
	const first = deferred();
	const second = deferred();
	const p1 = scope.run(() => first.promise);
	const p2 = scope.run(() => second.promise);
	second.resolve('B2');
	first.resolve('B1');
	await assert.rejects(p1, (e) => isStaleRequest(e));
	assert.equal(await p2, 'B2');
	// errors of stale requests are swallowed as stale (e.g. a late 401)
	const failing = deferred();
	const p3 = scope.run(() => failing.promise);
	scope.invalidate();
	failing.reject(new ApiError(401, 'UNAUTHORIZED', 'x'));
	await assert.rejects(p3, (e) => isStaleRequest(e));
	const ticket = scope.begin();
	assert.equal(ticket.isCurrent(), true);
	scope.setContext('user:C');
	assert.equal(ticket.isCurrent(), false);
	assert.equal(ticket.signal.aborted, true);
});

// -------------------------------------------------------------------------------- capabilities
test('capabilities: colas, cola por defecto y navegación (sin roles)', () => {
	const admin = ['incidents:view_all', 'incidents:create', 'roles:view', 'audit:view'];
	const own = ['incidents:view_own', 'incidents:edit'];
	const customer = ['incidents:view_requested', 'incidents:create'];
	assert.deepEqual(availableQueues(admin), ['all', 'mine', 'unassigned']);
	assert.deepEqual(availableQueues(own), ['mine']);
	assert.deepEqual(availableQueues(customer), []);
	assert.equal(defaultQueue(admin), 'all');
	assert.equal(defaultQueue(own), 'mine');
	assert.equal(defaultQueue(customer), null);
	assert.equal(incidentReadScope(customer).requesterOnly, true);
	assert.equal(resolveQueue('unassigned', own), 'mine', 'cola no disponible -> por defecto');
	assert.equal(resolveQueue('mine', admin), 'mine');
	assert.deepEqual(navigationModel(admin), {
		incidents: true,
		newIncident: true,
		adminCapable: true
	});
	assert.deepEqual(navigationModel(own), {
		incidents: true,
		newIncident: false,
		adminCapable: false
	});
	assert.deepEqual(navigationModel([]), {
		incidents: false,
		newIncident: false,
		adminCapable: false
	});
	// a role name never grants anything
	assert.deepEqual(navigationModel(['technician', 'organization_admin']), {
		incidents: false,
		newIncident: false,
		adminCapable: false
	});
});

// ------------------------------------------------------------------------ organization context
const ORG_A = { id: randomUUID(), name: 'Alfa', slug: 'alfa' };
const ORG_B = { id: randomUUID(), name: 'Beta', slug: 'beta' };
const USER = { id: randomUUID(), name: 'Ana', email: 'ana@example.test' };
function memoryStorage(initial = null) {
	let value = initial;
	return { read: () => value, write: (v) => (value = v), peek: () => value };
}
/** Scriptable getMe: capabilities per org; `hold(orgId)` delays that org's answer. */
function fakeMe(organizations = [ORG_A, ORG_B], caps = {}) {
	const held = new Map();
	const calls = [];
	const getMe = async (_fetch, options = {}) => {
		calls.push(options.organizationId ?? null);
		const orgId = options.organizationId;
		if (orgId && held.has(orgId)) await held.get(orgId).promise;
		if (orgId && caps[orgId] instanceof Error) throw caps[orgId];
		if (orgId && !organizations.some((o) => o.id === orgId))
			throw new AuthApiError(403, 'FORBIDDEN', 'x');
		const base = { user: USER, organizations };
		if (!orgId) return base;
		const org = organizations.find((o) => o.id === orgId);
		return { ...base, activeOrganization: { ...org, capabilities: caps[orgId] ?? [] } };
	};
	return {
		getMe,
		calls,
		hold(orgId) {
			const d = deferred();
			held.set(orgId, d);
			return () => {
				held.delete(orgId);
				d.resolve();
			};
		}
	};
}

test('administración: se ofrece si alguna página admin se puede abrir (guards reales)', () => {
	const none = { clients: false, sites: false, categories: false, slaPolicies: false };
	const cases = [
		// A-D: each module's managers
		[['clients:manage'], { ...none, clients: true }],
		[['sites:manage'], { ...none, sites: true }],
		[['categories:manage'], { ...none, categories: true }],
		[['sla:view', 'sla:manage'], { ...none, slaPolicies: true }],
		// E: readers open their page too (sla:view reads the SLA policies)
		[['sla:view'], { ...none, slaPolicies: true }],
		[['sites:view'], { ...none, sites: true }],
		[['categories:view'], { ...none, categories: true }],
		// the Clientes page itself requires clients:manage: clients:view opens nothing
		[['clients:view'], none],
		// listing SLA policies needs sla:view (server too): sla:manage / sla:assign alone open nothing
		[['sla:manage'], none],
		[['sla:assign'], none],
		// F: no relevant capability, future modules without a page, role names
		[[], none],
		[['incidents:view_all', 'incidents:create'], none],
		[['roles:view', 'memberships:view', 'webhooks:view', 'audit:view', 'automations:view'], none],
		[['organization_admin', 'technician'], none]
	];
	for (const [caps, expected] of cases) {
		assert.deepEqual(adminModuleAccess(caps), expected, caps.join() || 'ninguna');
		assert.equal(canAccessAdmin(caps), Object.values(expected).some(Boolean), caps.join());
	}
	assert.equal(
		canAccessAdmin(['clients:manage', 'sites:view', 'categories:view', 'sla:view']),
		true
	);
});

test('contexto: org explícita válida, inválida (sin sustitución), recordada, única y varias', async () => {
	const me = fakeMe([ORG_A, ORG_B], {
		[ORG_A.id]: ['incidents:view_all'],
		[ORG_B.id]: ['incidents:view_own']
	});
	const storage = memoryStorage(ORG_B.id);
	const ctx = createOrganizationContext({ getMe: me.getMe, storage });
	await ctx.load(ORG_A.id);
	let s = ctx.get();
	assert.equal(s.status, 'ready');
	assert.equal(s.activeOrganizationId, ORG_A.id, 'la URL manda sobre lo recordado');
	assert.deepEqual(s.capabilities, ['incidents:view_all']);
	assert.equal(storage.peek(), ORG_A.id);
	// explicit invalid: never replaced by the remembered or the only organization
	for (const bad of [randomUUID(), 'not-a-uuid']) {
		await ctx.load(bad);
		s = ctx.get();
		assert.equal(s.status, 'invalid-organization');
		assert.equal(s.rejectedOrganizationId, bad);
		assert.equal(s.activeOrganizationId, null);
		assert.deepEqual(s.capabilities, []);
	}
	// remembered valid
	await ctx.load(null);
	assert.equal(ctx.get().activeOrganizationId, ORG_A.id);
	// remembered but no longer a member -> forgotten, selection required
	const stale = createOrganizationContext({
		getMe: fakeMe([ORG_A, ORG_B]).getMe,
		storage: memoryStorage(randomUUID())
	});
	await stale.load(null);
	assert.equal(stale.get().status, 'selection-required');
	// single organization
	const single = createOrganizationContext({
		getMe: fakeMe([ORG_A], { [ORG_A.id]: [] }).getMe,
		storage: memoryStorage()
	});
	await single.load(null);
	assert.equal(single.get().status, 'ready');
	assert.equal(single.get().activeOrganizationId, ORG_A.id);
	// several without memory -> explicit selection
	const many = createOrganizationContext({ getMe: fakeMe().getMe, storage: memoryStorage() });
	await many.load(null);
	assert.equal(many.get().status, 'selection-required');
	const none = createOrganizationContext({ getMe: fakeMe([]).getMe, storage: memoryStorage() });
	await none.load(null);
	assert.equal(none.get().status, 'no-organizations');
});

test('contexto: cambio A→B limpia capabilities y descarta la respuesta tardía de A', async () => {
	const me = fakeMe([ORG_A, ORG_B], {
		[ORG_A.id]: ['incidents:view_all', 'roles:view'],
		[ORG_B.id]: ['incidents:view_requested']
	});
	const ctx = createOrganizationContext({ getMe: me.getMe, storage: memoryStorage() });
	await ctx.load(ORG_B.id);
	const generationB = ctx.get().generation;
	const releaseA = me.hold(ORG_A.id);
	const switching = ctx.selectOrganization(ORG_A.id);
	assert.equal(ctx.get().status, 'loading');
	assert.deepEqual(ctx.get().capabilities, [], 'capabilities de B borradas al instante');
	assert.ok(ctx.get().generation > generationB);
	// user changes mind back to B while A is still in flight
	const back = ctx.selectOrganization(ORG_B.id);
	releaseA();
	await Promise.all([switching, back]);
	const s = ctx.get();
	assert.equal(s.activeOrganizationId, ORG_B.id);
	assert.deepEqual(s.capabilities, ['incidents:view_requested'], 'sin fuga de capabilities de A');
	assert.equal(s.contextKey, `${USER.id}:${ORG_B.id}`);
	assert.equal(await ctx.selectOrganization(randomUUID()), false, 'org ajena rechazada');
});

test('contexto: 401 vigente invalida; 401 obsoleto se ignora; 403 no cierra sesión', async () => {
	const caps = {
		[ORG_A.id]: new AuthApiError(401, 'UNAUTHORIZED', 'x'),
		[ORG_B.id]: ['incidents:view_own']
	};
	const me = fakeMe([ORG_A, ORG_B], caps);
	const ctx = createOrganizationContext({ getMe: me.getMe, storage: memoryStorage() });
	await ctx.load(ORG_A.id);
	assert.equal(ctx.get().status, 'unauthenticated');
	// stale 401: A answers 401 after the user already moved to B
	await ctx.load(ORG_B.id);
	const release = me.hold(ORG_A.id);
	const toA = ctx.selectOrganization(ORG_A.id);
	const toB = ctx.selectOrganization(ORG_B.id);
	release();
	await Promise.all([toA, toB]);
	assert.equal(ctx.get().status, 'ready', '401 de una petición obsoleta ignorado');
	assert.equal(ctx.get().activeOrganizationId, ORG_B.id);
	// 403 on the organization: forbidden state, identity kept (no sign-out)
	const forbid = fakeMe([ORG_A], { [ORG_A.id]: new AuthApiError(403, 'FORBIDDEN', 'x') });
	const c2 = createOrganizationContext({ getMe: forbid.getMe, storage: memoryStorage() });
	await c2.load(ORG_A.id);
	assert.equal(c2.get().status, 'forbidden');
	assert.equal(c2.get().user.id, USER.id);
});

// --------------------------------------------------------------------------- incident DTO/API
const staffDto = (org, overrides = {}) => ({
	id: randomUUID(),
	organizationId: org,
	incidentNumber: 7,
	title: 'Impresora',
	description: 'No imprime',
	status: 'open',
	priority: 'high',
	supportLevel: 'N1',
	client: 'Etiqueta interna',
	clientUserId: null,
	createdByUserId: randomUUID(),
	siteId: null,
	assignedToUserId: null,
	assignedToUserName: null,
	teamId: null,
	teamName: null,
	categoryId: null,
	slaPolicyId: null,
	slaFirstResponseMinutes: null,
	slaResolutionMinutes: null,
	slaAppliedAt: null,
	firstResponseDueAt: null,
	resolutionDueAt: null,
	firstResponseAt: null,
	firstResolvedAt: null,
	slaOverallStatus: 'not_applicable',
	slaFirstResponseStatus: 'not_applicable',
	slaResolutionStatus: 'not_applicable',
	createdAt: '2026-09-28T10:00:00.000Z',
	updatedAt: '2026-09-28T10:00:00.000Z',
	...overrides
});
const requesterDto = (org, overrides = {}) => ({
	audience: 'requester',
	id: randomUUID(),
	organizationId: org,
	incidentNumber: 8,
	title: 'Mi incidencia',
	description: 'Detalle',
	status: 'pending',
	priority: 'medium',
	clientUserId: randomUUID(),
	siteId: null,
	categoryId: null,
	slaOverallStatus: 'on_track',
	slaFirstResponseStatus: 'pending',
	slaResolutionStatus: 'pending',
	createdAt: '2026-09-28T10:00:00.000000Z',
	updatedAt: '2026-09-28T10:00:00.000000Z',
	...overrides
});

test('DTO: staff y requester válidos; requester sin campos internos; inválidos rechazados', () => {
	const org = ORG_A.id;
	const staff = toIncidentView(staffDto(org), org);
	assert.equal(staff.audience, 'staff');
	assert.equal(staff.client, 'Etiqueta interna');
	const requester = toIncidentView(requesterDto(org), org);
	assert.equal(requester.audience, 'requester');
	for (const internal of [
		'client',
		'assignedToUserId',
		'teamId',
		'supportLevel',
		'slaPolicyId',
		'createdByUserId'
	])
		assert.equal(internal in requester, false, `${internal} no se inventa`);
	const invalid = (raw) =>
		assert.throws(
			() => toIncidentView(raw, org),
			(e) => e.code === 'INVALID_PAYLOAD'
		);
	invalid(requesterDto(org, { assignedToUserId: randomUUID() })); // leak of an internal field
	invalid(requesterDto(org, { status: 'weird' }));
	invalid(requesterDto(ORG_B.id)); // another tenant
	invalid(staffDto(org, { client: undefined }));
	invalid(staffDto(org, { audience: 'admin' }));
	invalid(null);
	invalid([]);
});

test('API paginada: limit, cursor opaco, nextCursor, filtros y errores con metadatos', async () => {
	const org = ORG_A.id;
	const seen = [];
	const fetchFn = async (url) => {
		seen.push(new URL(url, 'http://x'));
		return json(200, { incidents: [staffDto(org), requesterDto(org)], nextCursor: 'b3BhcXVl_Q-1' });
	};
	const page = await listIncidentsPage(
		org,
		{
			queue: 'all',
			status: 'open',
			priority: 'high',
			categoryId: ORG_B.id,
			limit: 2,
			cursor: 'Y3Vyc29y'
		},
		{ customFetch: fetchFn }
	);
	assert.equal(page.nextCursor, 'b3BhcXVl_Q-1', 'cursor devuelto tal cual');
	assert.deepEqual(
		page.incidents.map((i) => i.audience),
		['staff', 'requester']
	);
	const params = seen[0].searchParams;
	assert.equal(params.get('limit'), '2');
	assert.equal(params.get('cursor'), 'Y3Vyc29y', 'cursor reenviado sin reconstruir');
	assert.equal(params.get('queue'), 'all');
	assert.equal(params.get('categoryId'), ORG_B.id);
	// defaults and validation before any request
	assert.equal(buildIncidentPageSearch(org, {}).get('limit'), '25');
	for (const bad of [
		{ limit: 0 },
		{ limit: 101 },
		{ limit: 1.5 },
		{ cursor: 'no/válido' },
		{ status: 'x' },
		{ siteId: 'x' }
	])
		assert.throws(
			() => buildIncidentPageSearch(org, bad),
			(e) => e.code === 'INVALID_INPUT',
			JSON.stringify(bad)
		);
	// invalid payloads
	for (const body of [
		{ incidents: [] },
		{ incidents: {}, nextCursor: null },
		{ incidents: [], nextCursor: 'con espacio' }
	])
		await assert.rejects(
			listIncidentsPage(org, {}, { customFetch: async () => json(200, body) }),
			(e) => e.code === 'INVALID_PAYLOAD'
		);
	// errors keep Retry-After and X-Request-ID
	await assert.rejects(
		listIncidentsPage(
			org,
			{},
			{
				customFetch: async () =>
					json(
						429,
						{ error: { code: 'RATE_LIMITED', message: 'x' } },
						{ 'retry-after': '9', 'x-request-id': REQ_ID }
					)
			}
		),
		(e) => e.status === 429 && e.retryAfterSeconds === 9 && e.requestId === REQ_ID
	);
	await assert.rejects(
		listIncidentsPage(
			org,
			{},
			{
				customFetch: async () => {
					throw new TypeError('offline');
				}
			}
		),
		(e) => e.code === 'NETWORK_ERROR'
	);
});

// --------------------------------------------------------------------------- list controller
function pagedServer(total = 7) {
	const org = ORG_A.id;
	const rows = Array.from({ length: total }, (_, i) =>
		staffDto(org, { incidentNumber: total - i })
	);
	const calls = [];
	const fetchPage = async (orgId, query) => {
		calls.push({ orgId, query });
		const start = query.cursor ? Number(query.cursor.slice(1)) : 0;
		const slice = rows.slice(start, start + query.limit);
		const end = start + query.limit;
		return {
			incidents: slice.map((r) => toIncidentView(r, orgId)),
			nextCursor: end < rows.length ? `c${end}` : null
		};
	};
	return { fetchPage, calls };
}

test('paginación: siguiente, anterior con historial, reset al filtrar y al cambiar de org', async () => {
	const server = pagedServer(7);
	const list = createIncidentListController({ fetchPage: server.fetchPage, limit: 3 });
	list.setContext(`u:${ORG_A.id}`, ORG_A.id);
	await list.setQuery({ queue: 'all' });
	const numbers = () => list.get().incidents.map((i) => i.incidentNumber);
	assert.deepEqual(numbers(), [7, 6, 5]);
	await list.next();
	assert.deepEqual(numbers(), [4, 3, 2]);
	await list.next();
	assert.deepEqual(numbers(), [1]);
	assert.equal(list.get().nextCursor, null);
	await list.previous();
	assert.deepEqual(numbers(), [4, 3, 2]);
	await list.previous();
	assert.deepEqual(numbers(), [7, 6, 5]);
	assert.deepEqual(list.get().cursorHistory, [null]);
	// filter change -> back to first page, cursor reset
	await list.next();
	await list.setQuery({ queue: 'all', status: 'open' });
	assert.deepEqual(list.get().cursorHistory, [null]);
	assert.equal(server.calls.at(-1).query.cursor, null);
	assert.equal(hasActiveFilters({ status: 'open' }), true);
	// organization change -> rows cleared immediately
	list.setContext(`u:${ORG_B.id}`, ORG_B.id);
	assert.deepEqual(list.get().incidents, []);
	assert.equal(list.get().status, 'idle');
});

test('listado: respuesta tardía de otra org descartada; 401/403/429 conservan estado correcto', async () => {
	const pending = deferred();
	let mode = 'hold';
	const fetchPage = async (orgId) => {
		if (mode === 'hold') return pending.promise;
		if (mode === '429')
			throw new ApiError(429, 'RATE_LIMITED', 'x', { retryAfterSeconds: 30, requestId: REQ_ID });
		if (mode === '403') throw new ApiError(403, 'FORBIDDEN', 'x');
		return { incidents: [toIncidentView(staffDto(orgId), orgId)], nextCursor: null };
	};
	let clock = 1_000_000;
	const list = createIncidentListController({ fetchPage, now: () => clock });
	list.setContext('u:A', ORG_A.id);
	const loadingA = list.setQuery({ queue: 'all' });
	list.setContext('u:B', ORG_B.id);
	mode = 'ok';
	await list.setQuery({ queue: 'mine' });
	pending.resolve({ incidents: [toIncidentView(staffDto(ORG_A.id), ORG_A.id)], nextCursor: null });
	await loadingA;
	assert.ok(
		list.get().incidents.every((i) => i.organizationId === ORG_B.id),
		'sin datos de A en B'
	);
	// 429 -> cooldown, retry refused until it elapses (no automatic retry)
	mode = '429';
	await list.setQuery({ queue: 'all' });
	assert.equal(list.get().status, 'error');
	assert.equal(list.get().cooldownUntil, clock + 30_000);
	assert.equal(list.get().error.requestId, REQ_ID);
	mode = 'ok';
	await list.retry();
	assert.equal(list.get().status, 'error', 'reintento bloqueado durante la espera');
	clock += 31_000;
	await list.retry();
	assert.equal(list.get().status, 'ready');
	// 403 is just an error state for the list (the session is untouched by the controller)
	mode = '403';
	await list.setQuery({ queue: 'unassigned' });
	assert.equal(list.get().error.kind, 'forbidden');
});

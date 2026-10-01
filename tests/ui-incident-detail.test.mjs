import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { ApiError } from '../src/lib/api/errors.ts';
import { parseIncidentDetail } from '../src/lib/api/incident-detail.ts';
import {
	catalogSessionExpiry,
	createIncidentDetailCatalogs,
	nameCatalogsFor,
	namesOf
} from '../src/lib/app/incident-detail-catalogs.ts';
import {
	createIncidentDetailController,
	unauthenticatedError
} from '../src/lib/app/incident-detail-controller.ts';
import {
	incidentListPath,
	isIncidentRouteId,
	organizationSwitchTarget
} from '../src/lib/app/incident-detail-navigation.ts';
import {
	catalogName,
	formatDetailDate,
	presentDetailError,
	staffRequesterLabel
} from '../src/lib/app/incident-detail-presentation.ts';
import { tenantIdentityOf } from '../src/lib/app/tenant-identity.ts';

/**
 * UI-2C — /app/incidents/[id] against the real code:
 * - payloads produced by the REAL backend projection (incident-dto.ts via Vite SSR), validated
 *   by the UI-2A parser;
 * - the REAL page, header, description and staff/requester contexts rendered through Vite SSR.
 *   Only the organization context, $app/* and the detail controller's STATE are doubles (SSR runs
 *   no effects, so a doubled store exposes the state under test to the real page);
 * - the real controller, catalogs, presentation and navigation modules the page executes.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER = randomUUID();
const INCIDENT = randomUUID();
const TECH = randomUUID();
const TEAM = randomUUID();
const SITE = randomUUID();
const CATEGORY = randomUUID();
const REQUESTER = randomUUID();
const CREATOR = randomUUID();
const POLICY = randomUUID();
const REQUEST_ID = '3f2b8a1e-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const NOW = new Date('2026-09-28T10:00:00.000Z');
const at = (minutes) => new Date(NOW.getTime() + minutes * 60_000);
const STAFF_CAPS = ['incidents:view_all', 'incidents:edit', 'incidents:assign', 'sites:view'];

function row(overrides = {}) {
	return {
		id: INCIDENT,
		organizationId: ORG_A,
		incidentNumber: 1042,
		title: 'VPN caída en la sede norte',
		description: 'Primera línea.\nSegunda línea <script>alert(1)</script>',
		status: 'pending',
		priority: 'urgent',
		client: 'Etiqueta interna Cliente SL',
		clientUserId: REQUESTER,
		createdByUserId: CREATOR,
		siteId: SITE,
		categoryId: CATEGORY,
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

function contextState(capabilities, organizationId = ORG_A, generation = 1) {
	return {
		status: 'ready',
		user: { id: USER, name: 'Ana Pérez', email: 'ana@example.test' },
		organizations: [
			{ id: ORG_A, name: 'Alfa', slug: 'alfa' },
			{ id: ORG_B, name: 'Beta', slug: 'beta' }
		],
		activeOrganizationId: organizationId,
		activeOrganization: { id: organizationId, name: 'Alfa', slug: 'alfa', capabilities },
		capabilities,
		rejectedOrganizationId: null,
		error: null,
		contextKey: `${USER}:${organizationId}`,
		generation
	};
}
const identity = (capabilities, organizationId = ORG_A, generation = 1) =>
	tenantIdentityOf(contextState(capabilities, organizationId, generation));
const detailState = (overrides = {}) => ({
	status: 'idle',
	key: 'k',
	organizationId: ORG_A,
	incidentId: INCIDENT,
	detail: null,
	error: null,
	cooldownUntil: null,
	channels: {},
	mutations: {},
	...overrides
});
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const INTERNAL_LABELS =
	/Sin asignar|Sin equipo|Técnico|Equipo|Nivel|Cliente|Límite de|Primera resolución/;

test('UI-2C — página de detalle real (SSR)', async (t) => {
	const server = await createServer({
		root,
		configFile: false,
		envDir: false,
		logLevel: 'silent',
		resolve: { alias: { $lib: path.resolve(root, 'src/lib') } },
		plugins: [
			{
				name: 'sf-ui2c-doubles',
				enforce: 'pre',
				resolveId(id) {
					if (['$app/paths', '$app/state', '$app/navigation'].includes(id)) return `\0${id}`;
					if (id === '$lib/app/context' || /[\\/]src[\\/]lib[\\/]app[\\/]context(\.ts)?$/.test(id))
						return '\0sf-context';
					if (
						id === '$lib/app/incident-detail-controller' ||
						/[\\/]src[\\/]lib[\\/]app[\\/]incident-detail-controller(\.ts)?$/.test(id)
					)
						return '\0sf-detail-controller';
				},
				load(id) {
					if (id === '\0$app/paths') return 'export const resolve = (p) => p;';
					if (id === '\0$app/state')
						return `export const page = {
	get url() { return globalThis.__sfUrl; },
	get params() { return globalThis.__sfParams; }
};`;
					if (id === '\0$app/navigation')
						return `export const goto = async (url) => { (globalThis.__sfGotos ??= []).push(url); };
export const beforeNavigate = () => {};`;
					if (id === '\0sf-context')
						return `export function useOrganizationContext() {
	return { subscribe(run) { run(globalThis.__sfContext); return () => {}; }, get: () => globalThis.__sfContext, load: async () => {} };
}`;
					if (id === '\0sf-detail-controller')
						return `export function createIncidentDetailController() {
	const state = () => globalThis.__sfDetail;
	return {
		subscribe(run) { run(state()); return () => {}; },
		get: state,
		setTarget() {}, load: async () => {}, loadChannel: async () => {},
		mutate: async () => ({ status: 'stale' }), clearMutation() {}, dispose() {}
	};
}
export function unauthenticatedError() { return null; }`;
				}
			},
			svelte({ configFile: false })
		],
		server: { middlewareMode: true, hmr: false, watch: null },
		appType: 'custom'
	});
	t.after(() => server.close());
	const { render } = await server.ssrLoadModule('svelte/server');
	const { toIncidentDto } = await server.ssrLoadModule('/src/lib/server/services/incident-dto.ts');
	// Errors rendered by the SSR page must come from the SAME module instance the page uses.
	const { ApiError: PageApiError } = await server.ssrLoadModule('/src/lib/api/errors.ts');
	const Page = (await server.ssrLoadModule('/src/routes/app/incidents/[id]/+page.svelte')).default;
	const StaffContext = (
		await server.ssrLoadModule('/src/lib/components/incidents/IncidentStaffContext.svelte')
	).default;
	const RequesterContext = (
		await server.ssrLoadModule('/src/lib/components/incidents/IncidentRequesterContext.svelte')
	).default;
	const clean = (html) => html.replace(/<!--.*?-->/g, '');
	const wire = (value) => JSON.parse(JSON.stringify(value));
	const expect = { organizationId: ORG_A, incidentId: INCIDENT };
	const staffDetail = (overrides = {}) =>
		parseIncidentDetail(
			wire(
				toIncidentDto(
					{ ...row(overrides), assignedToUserName: 'Luis Técnico', teamName: 'Redes' },
					'staff',
					NOW
				)
			),
			expect
		);
	const requesterDetail = (overrides = {}) =>
		parseIncidentDetail(wire(toIncidentDto(row(overrides), 'requester', NOW)), expect);
	const renderPage = ({
		capabilities = STAFF_CAPS,
		detail = detailState(),
		id = INCIDENT
	} = {}) => {
		globalThis.__sfContext = contextState(capabilities);
		globalThis.__sfDetail = detail;
		globalThis.__sfParams = { id };
		globalThis.__sfUrl = new URL(`http://localhost/app/incidents/${id}?organizationId=${ORG_A}`);
		globalThis.__sfGotos = [];
		return clean(render(Page, { props: {} }).body);
	};

	await t.test('1/20. carga: shell visible, estado anunciable, sin datos previos', () => {
		const html = renderPage({ detail: detailState({ status: 'loading' }) });
		assert.match(html, /data-sf-ui/);
		assert.match(html, /Cargando incidencia…/);
		assert.match(html, /role="status"/);
		assert.equal((html.match(/<h1/g) ?? []).length, 1, 'un único h1 también durante la carga');
		assert.doesNotMatch(html, /VPN caída|Luis Técnico/);
	});

	await t.test('2/5/7/9/10/11/13/22. vista staff completa y en solo lectura', () => {
		const html = renderPage({ detail: detailState({ status: 'ready', detail: staffDetail() }) });
		assert.equal((html.match(/<h1/g) ?? []).length, 1);
		assert.match(html, /<h1[^>]*>VPN caída en la sede norte<\/h1>/);
		assert.match(html, />#1042</);
		assert.match(html, /Pendiente/);
		assert.match(html, /Prioridad urgente/);
		// breadcrumb: list of the same organization + current item
		assert.match(
			html,
			new RegExp(
				`<nav[^>]*aria-label="Ruta de navegación"[\\s\\S]*?href="/app/incidents\\?organizationId=${ORG_A}"`
			)
		);
		assert.match(html, /aria-current="page"[^>]*>#1042</);
		assert.match(html, /data-audience="staff"/);
		for (const text of ['Etiqueta interna Cliente SL', 'Luis Técnico', 'Redes', 'N2', 'En plazo'])
			assert.ok(html.includes(text), text);
		assert.match(html, /Primera respuesta[\s\S]*?Cumplido/);
		assert.match(html, /Resolución[\s\S]*?Pendiente/);
		assert.match(html, /<time datetime="2026-09-28T10:30:00\.000Z">/, 'límite de respuesta');
		assert.match(html, /Primera resolución<\/dt>\s*<dd class="sf-muted[^"]*">\s*Sin registrar/);
		assert.match(html, /<dl[\s>]/);
		// never a raw UUID as content
		for (const uuid of [INCIDENT, TECH, TEAM, SITE, CATEGORY, REQUESTER, CREATOR, POLICY, ORG_A])
			assert.doesNotMatch(html, new RegExp(`>[^<]*${uuid}[^<]*<`), uuid);
		// no percentages, progress bars or countdowns
		assert.doesNotMatch(html, /%|progress|role="progressbar"|restante/);
	});

	await t.test('6/25. descripción literal (sin {@html}), saltos conservados', () => {
		const html = renderPage({ detail: detailState({ status: 'ready', detail: staffDetail() }) });
		assert.match(html, /Primera línea\.\nSegunda línea &lt;script>alert\(1\)&lt;\/script>/);
		assert.doesNotMatch(html, /<script>alert/);
	});

	await t.test('3/4/8/12. vista requester: solo datos públicos, sin nada interno', () => {
		const html = renderPage({
			capabilities: ['incidents:view_requested', ...STAFF_CAPS, 'sla:assign'],
			detail: detailState({ status: 'ready', detail: requesterDetail() })
		});
		assert.match(html, /data-audience="requester"/);
		assert.doesNotMatch(html, /data-audience="staff"/);
		assert.match(html, /<h1[^>]*>VPN caída en la sede norte<\/h1>/);
		assert.match(html, /Compromiso de atención[\s\S]*?En plazo/);
		assert.doesNotMatch(html, INTERNAL_LABELS);
		for (const value of ['Etiqueta interna Cliente SL', 'Luis Técnico', 'Redes', 'N2', '60', '480'])
			assert.equal(html.includes(`>${value}<`), false, value);
		for (const uuid of [SITE, CATEGORY, REQUESTER, CREATOR, POLICY])
			assert.equal(html.includes(uuid), false, uuid);
	});

	await t.test('26. sin acciones falsas; acciones solo staff con capability', () => {
		const forbidden = /Añadir comentario|Añadir nota|Cambiar SLA|Eliminar/;
		const actionsRegex = />\s*(Resolver|Reabrir|Asignar|Reasignar)\s*</;
		const staffNoCaps = renderPage({
			capabilities: ['incidents:view_all'],
			detail: detailState({ status: 'ready', detail: staffDetail() })
		});
		assert.doesNotMatch(staffNoCaps, actionsRegex);
		assert.doesNotMatch(staffNoCaps, forbidden);
		const staffCaps = renderPage({
			detail: detailState({ status: 'ready', detail: staffDetail() })
		});
		assert.match(staffCaps, />\s*Resolver\s*</);
		assert.match(staffCaps, />\s*Reasignar\s*</, 'ya asignada');
		assert.doesNotMatch(staffCaps, forbidden);
		const unassigned = renderPage({
			detail: detailState({
				status: 'ready',
				detail: staffDetail({ assignedToUserId: null, teamId: null })
			})
		});
		assert.match(unassigned, />\s*Asignar\s*</);
		const closed = renderPage({
			detail: detailState({ status: 'ready', detail: staffDetail({ status: 'closed' }) })
		});
		assert.match(closed, />\s*Reabrir\s*</, 'reabrir sigue disponible');
		assert.doesNotMatch(closed, />\s*(Asignar|Reasignar)\s*</, 'cerrada: sin asignación');
		const requester = renderPage({
			capabilities: ['incidents:view_requested', ...STAFF_CAPS],
			detail: detailState({ status: 'ready', detail: requesterDetail() })
		});
		assert.doesNotMatch(requester, actionsRegex);
	});

	await t.test('14/15/18/19. errores: 403/404 neutros, 500/503 con referencia y reintento', () => {
		for (const status of [403, 404]) {
			const html = renderPage({
				detail: detailState({
					status: 'error',
					error: new PageApiError(status, status === 404 ? 'INCIDENT_NOT_FOUND' : 'FORBIDDEN', 'x')
				})
			});
			assert.match(html, /Esta incidencia no está disponible o no tienes acceso a ella\./);
			assert.doesNotMatch(html, />\s*Reintentar\s*</);
			assert.match(html, /Volver a incidencias/);
		}
		for (const status of [500, 503]) {
			const html = renderPage({
				detail: detailState({
					status: 'error',
					error: new PageApiError(status, 'SERVER_ERROR', 'stack trace SQL', {
						requestId: REQUEST_ID
					})
				})
			});
			assert.match(html, new RegExp(REQUEST_ID));
			assert.match(html, />\s*Reintentar\s*</);
			assert.doesNotMatch(html, /stack trace SQL/);
		}
		const lost = renderPage({
			detail: detailState({
				status: 'access-lost',
				error: new PageApiError(404, 'INCIDENT_NOT_FOUND', 'x')
			})
		});
		assert.match(lost, /Esta incidencia ya no está disponible\./);
		assert.doesNotMatch(lost, /VPN caída/);
		const invalid = renderPage({ id: 'no-es-un-uuid' });
		assert.match(invalid, /Incidencia no disponible/);
	});

	await t.test('23. responsive: una columna bajo 1024 px; textos largos con wrap', () => {
		const page = fs.readFileSync(
			path.join(root, 'src/routes/app/incidents/[id]/+page.svelte'),
			'utf8'
		);
		assert.match(
			page,
			/@media \(max-width: 1023px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/
		);
		const header = fs.readFileSync(
			path.join(root, 'src/lib/components/incidents/IncidentHeader.svelte'),
			'utf8'
		);
		assert.match(header, /overflow-wrap: anywhere/);
	});

	await t.test('contexto staff: nombres solo desde catálogos legibles, nunca UUID', () => {
		const incident = staffDetail();
		const html = clean(
			render(StaffContext, {
				props: {
					incident,
					selfUserId: USER,
					selfName: 'Ana',
					siteNames: new Map([[SITE, 'Sede Norte']]),
					categoryNames: null,
					memberNames: null
				}
			}).body
		);
		assert.match(html, /Sede Norte/);
		assert.match(html, /Categoría<\/dt>\s*<dd[^>]*>No disponible/);
		assert.match(html, /Solicitante<\/dt>\s*<dd[^>]*>No disponible/);
		const requesterHtml = clean(
			render(RequesterContext, { props: { incident: requesterDetail() } }).body
		);
		assert.doesNotMatch(requesterHtml, INTERNAL_LABELS);
	});
});

test('13. fechas: formato local, nunca "Invalid Date"', () => {
	assert.equal(formatDetailDate(null), null);
	assert.equal(formatDetailDate('no-fecha'), null);
	assert.match(formatDetailDate('2026-09-28T10:00:00.000Z'), /28\/09\/2026/);
});

test('nombres de staff: honestos y sin UUID', () => {
	const staff = { clientUserId: REQUESTER };
	assert.equal(staffRequesterLabel({ clientUserId: null }, USER, 'Ana', null), 'Sin solicitante');
	assert.equal(staffRequesterLabel({ clientUserId: USER }, USER, 'Ana', null), 'Ana (tú)');
	assert.equal(staffRequesterLabel(staff, USER, 'Ana', null), 'No disponible');
	assert.equal(staffRequesterLabel(staff, USER, 'Ana', new Map([[REQUESTER, 'Bruno']])), 'Bruno');
	assert.equal(catalogName(null, null, 'Sin sede'), 'Sin sede');
	assert.equal(catalogName(SITE, new Map(), 'Sin sede'), 'No disponible');
});

test('15/19. presentación de errores de lectura', () => {
	const notFound = presentDetailError(new ApiError(404, 'INCIDENT_NOT_FOUND', 'x'));
	const forbidden = presentDetailError(new ApiError(403, 'FORBIDDEN', 'x'));
	assert.equal(notFound.message, forbidden.message, '403 y 404 indistinguibles');
	assert.equal(notFound.retry, false);
	assert.equal(
		presentDetailError(new ApiError(404, 'INCIDENT_NOT_FOUND', 'x'), true).message,
		'Esta incidencia ya no está disponible.'
	);
	const limited = presentDetailError(
		new ApiError(429, 'RATE_LIMITED', 'x', { retryAfterSeconds: 9, requestId: REQUEST_ID })
	);
	assert.equal(limited.retry, true);
	assert.equal(limited.requestId, REQUEST_ID);
	assert.equal(presentDetailError(new ApiError(0, 'NETWORK_ERROR', 'x')).retry, true);
});

test('20/22. navegación: breadcrumb y cambio de organización al listado', () => {
	assert.equal(incidentListPath(ORG_A), `/app/incidents?organizationId=${ORG_A}`);
	assert.equal(organizationSwitchTarget(ORG_B), `/app/incidents?organizationId=${ORG_B}`);
	assert.doesNotMatch(
		organizationSwitchTarget(ORG_B),
		new RegExp(INCIDENT),
		'nunca se lleva el id'
	);
	assert.equal(isIncidentRouteId(INCIDENT), true);
	assert.equal(isIncidentRouteId('../admin'), false);
	const page = fs.readFileSync(
		path.join(root, 'src/routes/app/incidents/[id]/+page.svelte'),
		'utf8'
	);
	assert.match(page, /goto\(resolve\(organizationSwitchTarget\(id\)\)\)/);
});

test('catálogos de nombres: solo staff, solo con capability y solo si hay referencia', () => {
	const staff = { audience: 'staff', siteId: SITE, categoryId: CATEGORY, clientUserId: REQUESTER };
	assert.deepEqual(
		nameCatalogsFor(staff, ['sites:view', 'categories:view', 'memberships:view'], USER).sort(),
		['categories', 'memberships', 'sites']
	);
	assert.deepEqual(nameCatalogsFor(staff, ['incidents:view_all'], USER), []);
	assert.deepEqual(
		nameCatalogsFor({ ...staff, clientUserId: USER }, ['memberships:view'], USER),
		[],
		'uno mismo no necesita catálogo'
	);
	assert.deepEqual(
		nameCatalogsFor(
			{ audience: 'requester', siteId: SITE, categoryId: CATEGORY, clientUserId: REQUESTER },
			['sites:view', 'categories:view', 'memberships:view'],
			USER
		),
		[],
		'la vista requester no carga catálogos'
	);
});

test('16/17/20/21. 401 vigente vs obsoleto; cambio de tenant e incidente (código real)', async () => {
	// detail controller (UI-2A) as used by the page
	const gates = [];
	const detail = createIncidentDetailController({
		fetchDetail: () => {
			const d = deferred();
			gates.push(d);
			return d.promise;
		}
	});
	detail.setTarget({ identity: identity(STAFF_CAPS, ORG_A, 1), incidentId: INCIDENT });
	const staleLoad = detail.load();
	detail.setTarget({ identity: identity(STAFF_CAPS, ORG_B, 2), incidentId: randomUUID() });
	gates[0].reject(new ApiError(401, 'UNAUTHORIZED', 'x'));
	await staleLoad;
	assert.equal(unauthenticatedError(detail.get()), null, '17: 401 obsoleto ignorado');
	assert.equal(detail.get().detail, null, '20/21: nada del objetivo anterior');
	const currentLoad = detail.load();
	gates[1].reject(new ApiError(401, 'UNAUTHORIZED', 'x'));
	await currentLoad;
	assert.equal(unauthenticatedError(detail.get())?.status, 401, '16: 401 vigente');

	// name catalogs: current 401 -> expiry; stale 401 -> ignored; 403/5xx -> local error
	const catalogGates = {};
	const loader = (name) => () => {
		const d = deferred();
		(catalogGates[name] ??= []).push(d);
		return d.promise;
	};
	const catalogs = createIncidentDetailCatalogs({
		sites: loader('sites'),
		categories: loader('categories'),
		memberships: loader('memberships'),
		teams: loader('teams'),
		assignees: loader('assignees')
	});
	catalogs.setIdentity(identity(STAFF_CAPS, ORG_A, 1));
	catalogs.loadNames(['sites', 'categories', 'memberships']);
	catalogGates.categories[0].reject(new ApiError(403, 'FORBIDDEN', 'x'));
	catalogGates.memberships[0].reject(new ApiError(503, 'LIMITER_UNAVAILABLE', 'x'));
	await flush();
	assert.equal(catalogSessionExpiry(catalogs.get()), null, '403/503 no cierran sesión');
	assert.equal(
		namesOf(catalogs.get().categories),
		null,
		'fallo -> "No disponible", no lista vacía'
	);
	catalogs.setIdentity(identity(STAFF_CAPS, ORG_B, 2));
	catalogGates.sites[0].reject(new ApiError(401, 'UNAUTHORIZED', 'x'));
	await flush();
	assert.equal(catalogSessionExpiry(catalogs.get()), null, '401 de catálogo obsoleto ignorado');
	catalogs.loadNames(['sites']);
	catalogGates.sites[1].resolve([{ id: SITE, name: 'Sede B' }]);
	await flush();
	assert.equal(namesOf(catalogs.get().sites)?.get(SITE), 'Sede B');
	catalogs.loadNames(['categories']);
	catalogGates.categories[1].reject(new ApiError(401, 'UNAUTHORIZED', 'x'));
	await flush();
	assert.equal(catalogSessionExpiry(catalogs.get())?.status, 401, '401 de catálogo vigente');

	// assignees: a newer team request wins over a late one
	const late = catalogs.loadAssignees(TEAM);
	const newer = catalogs.loadAssignees(null);
	catalogGates.assignees[1].resolve([{ id: TECH, name: 'Todos' }]);
	catalogGates.assignees[0].resolve([{ id: TECH, name: 'Equipo viejo' }]);
	await Promise.all([late, newer]);
	assert.equal(catalogs.get().assignees.items[0].name, 'Todos');
	catalogs.dispose();
	detail.dispose();
});

test('24/25/28. seguridad: sin servidor, {@html}, roles ni staff en el camino requester', () => {
	const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
	const files = [
		'src/routes/app/incidents/[id]/+page.svelte',
		'src/lib/components/incidents/IncidentHeader.svelte',
		'src/lib/components/incidents/IncidentDescription.svelte',
		'src/lib/components/incidents/IncidentStaffContext.svelte',
		'src/lib/components/incidents/IncidentRequesterContext.svelte',
		'src/lib/ui/InfoGroup.svelte',
		'src/lib/app/incident-detail-catalogs.ts',
		'src/lib/app/incident-detail-presentation.ts',
		'src/lib/app/incident-detail-navigation.ts'
	];
	for (const file of files) {
		const code = read(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$|<!--[\s\S]*?-->/gm, '');
		assert.doesNotMatch(
			code,
			/\$lib\/server|drizzle|\{@html|innerHTML|localStorage|sessionStorage/,
			file
		);
		assert.doesNotMatch(code, /role\s*===|organization_admin|technician'/, file);
		assert.doesNotMatch(
			code,
			/as StaffIncidentDetailView|as unknown as/,
			`${file}: sin casts a staff`
		);
	}
	const page = read('src/routes/app/incidents/[id]/+page.svelte');
	assert.doesNotMatch(page, /getMe|\$session\b|fetch\(/, 'sin bootstrap propio ni fetch manual');
	assert.match(page, /useOrganizationContext\(\)/);
	assert.match(page, /createIncidentDetailController/);
	const requester = read('src/lib/components/incidents/IncidentRequesterContext.svelte');
	assert.doesNotMatch(requester, /IncidentStaffContext|StaffIncidentDetailView/);
	assert.match(requester, /incident: RequesterIncidentDetailView/);
	assert.match(
		read('src/lib/components/incidents/IncidentStaffContext.svelte'),
		/incident: StaffIncidentDetailView/
	);
	assert.equal(
		fs.existsSync(path.join(root, 'src/lib/components/incidents/RealIncidentDetail.svelte')),
		false
	);
});

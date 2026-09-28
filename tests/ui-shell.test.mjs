import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { listIncidents } from '../src/lib/api/incidents.ts';
import { userInitials } from '../src/lib/app/user-presentation.ts';

/**
 * UI-1B/2A render tests: shell, capability-driven navigation, list states, staff/requester
 * table, organization gate, demo isolation. Server-side render only (no DOM, no Playwright).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG_A = { id: randomUUID(), name: 'Alfa', slug: 'alfa' };
const ORG_B = { id: randomUUID(), name: 'Beta', slug: 'beta' };
const USER = { id: randomUUID(), name: 'Ana Pérez', email: 'ana@example.test' };
const REQ_ID = '3f2b8a1e-4c5d-4e6f-8a9b-0c1d2e3f4a5b';

function readyContext(capabilities, overrides = {}) {
	return {
		status: 'ready',
		user: USER,
		organizations: [ORG_A, ORG_B],
		activeOrganizationId: ORG_A.id,
		activeOrganization: { ...ORG_A, capabilities },
		capabilities,
		rejectedOrganizationId: null,
		error: null,
		contextKey: `${USER.id}:${ORG_A.id}`,
		generation: 1,
		...overrides
	};
}
const staffView = (overrides = {}) => ({
	audience: 'staff',
	id: randomUUID(),
	organizationId: ORG_A.id,
	incidentNumber: 42,
	title: 'Impresora sin conexión',
	description: 'd',
	status: 'open',
	priority: 'urgent',
	clientUserId: null,
	siteId: null,
	categoryId: null,
	slaOverallStatus: 'breached',
	slaFirstResponseStatus: 'breached',
	slaResolutionStatus: 'pending',
	createdAt: '2026-09-28T10:00:00.000Z',
	updatedAt: '2026-09-28T10:00:00.000Z',
	client: 'Etiqueta Cliente SL',
	supportLevel: 'N2',
	createdByUserId: randomUUID(),
	assignedToUserId: randomUUID(),
	assignedToUserName: 'Luis Técnico',
	teamId: randomUUID(),
	teamName: 'Redes',
	slaPolicyId: randomUUID(),
	firstResponseDueAt: null,
	resolutionDueAt: null,
	...overrides
});
const requesterView = (overrides = {}) => ({
	audience: 'requester',
	id: randomUUID(),
	organizationId: ORG_A.id,
	incidentNumber: 43,
	title: 'Mi portátil',
	description: 'd',
	status: 'pending',
	priority: 'medium',
	clientUserId: USER.id,
	siteId: null,
	categoryId: null,
	slaOverallStatus: 'on_track',
	slaFirstResponseStatus: 'pending',
	slaResolutionStatus: 'pending',
	createdAt: '2026-09-28T10:00:00.000Z',
	updatedAt: '2026-09-28T10:00:00.000Z',
	...overrides
});
const listState = (overrides = {}) => ({
	status: 'ready',
	incidents: [],
	nextCursor: null,
	cursorHistory: [null],
	error: null,
	cooldownUntil: null,
	organizationId: ORG_A.id,
	contextKey: 'k',
	queryKey: 'q',
	...overrides
});

test('UI-1 shell y workspace (render SSR)', async (t) => {
	const server = await createServer({
		root,
		configFile: false,
		envDir: false,
		logLevel: 'silent',
		resolve: { alias: { $lib: path.resolve(root, 'src/lib') } },
		plugins: [
			{
				name: 'sf-test-app-virtuals',
				resolveId: (id) => (id === '$app/paths' ? '\0$app/paths' : undefined),
				load: (id) =>
					id === '\0$app/paths'
						? 'export const base = ""; export const resolve = (p) => p;'
						: undefined
			},
			svelte({ configFile: false })
		],
		server: { middlewareMode: true, hmr: false, watch: null },
		appType: 'custom'
	});
	t.after(() => server.close());
	const { render } = await server.ssrLoadModule('svelte/server');
	const { createRawSnippet } = await server.ssrLoadModule('svelte');
	const load = async (p) => (await server.ssrLoadModule(p)).default;
	const AppShell = await load('/src/lib/components/shell/AppShell.svelte');
	const Panel = await load('/src/lib/components/workspace/IncidentListPanel.svelte');
	const Table = await load('/src/lib/components/workspace/IncidentTable.svelte');
	const Gate = await load('/src/lib/components/shell/OrganizationGate.svelte');
	const Toolbar = await load('/src/lib/components/workspace/IncidentToolbar.svelte');
	const PageHeader = await load('/src/lib/ui/PageHeader.svelte');
	const Switcher = await load('/src/lib/components/shell/OrganizationSwitcher.svelte');
	const text = (html) => html.replace(/<!--.*?-->/g, '');
	const children = createRawSnippet(() => ({ render: () => '<p>Contenido de página</p>' }));
	const shell = (context) =>
		text(
			render(AppShell, {
				props: {
					context,
					title: 'Incidencias',
					current: 'incidents',
					onOrganizationChange: () => {},
					onSignOut: () => {},
					children
				}
			}).body
		);

	await t.test(
		'shell: marca, organización, navegación por capabilities, móvil y accesibilidad',
		() => {
			const html = shell(readyContext(['incidents:view_all', 'incidents:create', 'audit:view']));
			assert.match(html, /data-sf-ui/);
			assert.match(html, /SoporteFlow/);
			assert.match(html, /Contenido de página/);
			assert.match(html, /<main id="sf-main"/);
			assert.match(html, /href="#sf-main"/, 'skip link');
			assert.match(html, /<select[^>]*>/, 'selector de varias organizaciones');
			assert.match(
				html,
				new RegExp(`href="/app/incidents\\?organizationId=${ORG_A.id}"[^>]*aria-current="page"`)
			);
			assert.match(html, /Nueva incidencia/);
			assert.doesNotMatch(
				html,
				/Administración|href="\/app\/admin/,
				'sin enlaces muertos a administración'
			);
			assert.doesNotMatch(
				html,
				/support-app|\/app\/demo/,
				'el shell nuevo no usa la demo ni su tema'
			);
			const toggle = /<button[^>]*aria-controls="([^"]+)"[^>]*aria-expanded="false"/.exec(html);
			assert.ok(toggle, 'botón de navegación móvil con aria-controls/aria-expanded');
			assert.match(html, new RegExp(`<aside id="${toggle[1]}"[^>]*data-open="false"`));
			assert.match(html, /Ana Pérez/);
		}
	);

	await t.test('UI-1C: solo rutas respaldadas; sin búsqueda, campana ni contadores', () => {
		const html = shell(readyContext(['incidents:view_all', 'incidents:create', 'audit:view']));
		const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
		assert.deepEqual(
			[...new Set(hrefs)].sort(),
			[
				'#sf-main',
				`/app/incidents/new?organizationId=${ORG_A.id}`,
				`/app/incidents?organizationId=${ORG_A.id}`
			].sort(),
			'solo Incidencias y Nueva incidencia (capabilities reales); sin rutas futuras'
		);
		assert.doesNotMatch(html, /Inicio|Clientes|Equipo|Administración|Informes|Ajustes/);
		assert.doesNotMatch(html, /type="search"|Buscar|placeholder=/i, 'sin búsqueda textual');
		assert.doesNotMatch(html, /notificaci|campana|\bbell\b/i, 'sin campana (UI-4)');
		assert.match(html, /class="appearance-control/, 'selector de tema presente');
		assert.match(html, /aria-label="Apariencia: /);
		assert.equal((html.match(/<h1/g) ?? []).length, 0, 'el shell no fija el h1 de la página');
		assert.match(html, /<span class="sf-avatar[^"]*"[^>]*aria-hidden="true">AP<\/span>/);
		assert.match(html, /ana@example\.test/);
		assert.match(html, /<span class="sf-sr-only">SoporteFlow<\/span>/);
		assert.match(
			html,
			/<svg[^>]*class="sf-icon[^"]*"[^>]*aria-hidden="true"/,
			'iconos decorativos'
		);
		// without incidents:create the sidebar has no create link
		const readOnly = shell(readyContext(['incidents:view_all']));
		assert.doesNotMatch(readOnly, /incidents\/new|Nueva incidencia/);
	});

	await t.test('UI-1C: page header con eyebrow, h1 y descripción', () => {
		const html = text(
			render(PageHeader, {
				props: {
					eyebrow: 'Alfa',
					title: 'Incidencias',
					description: 'Gestiona y da seguimiento a los casos de tu organización.'
				}
			}).body
		);
		assert.match(html, /<p class="sf-eyebrow[^"]*">Alfa<\/p>/);
		assert.match(html, /<h1[^>]*>Incidencias<\/h1>/);
		assert.match(html, /Gestiona y da seguimiento a los casos de tu organización\./);
		assert.doesNotMatch(text(render(PageHeader, { props: { title: 'X' } }).body), /sf-eyebrow/);
		const source = fs.readFileSync(
			path.join(root, 'src/routes/app/incidents/+page.svelte'),
			'utf8'
		);
		assert.match(source, /<PageHeader[\s\S]*?title="Incidencias"/);
		assert.match(
			source,
			/description="Gestiona y da seguimiento a los casos de tu organización\."/
		);
	});

	await t.test('UI-1C: pestañas de cola con href y aria-current, sin contadores', () => {
		const html = text(
			render(Toolbar, {
				props: {
					queues: ['all', 'mine', 'unassigned'],
					activeQueue: 'unassigned',
					queueHref: (q) => `/app/incidents?organizationId=o&queue=${q}`,
					status: undefined,
					priority: undefined,
					onfilter: () => {},
					onclear: () => {}
				}
			}).body
		);
		const tabs = [...html.matchAll(/<a href="([^"]+)"([^>]*)>([^<]*)<\/a>/g)].map((m) => ({
			href: m[1],
			current: /aria-current="page"/.test(m[2]),
			label: m[3]
		}));
		assert.deepEqual(tabs, [
			{ href: '/app/incidents?organizationId=o&amp;queue=all', current: false, label: 'Todas' },
			{
				href: '/app/incidents?organizationId=o&amp;queue=mine',
				current: false,
				label: 'Asignadas a mí'
			},
			{
				href: '/app/incidents?organizationId=o&amp;queue=unassigned',
				current: true,
				label: 'Sin asignar'
			}
		]);
		// sliding indicator: decorative only; before client measurement the active tab keeps its
		// own surface (no data-indicator="ready" in SSR), so the state never depends on JS
		assert.match(html, /<span class="sf-queue-indicator[^"]*" aria-hidden="true"/);
		assert.doesNotMatch(html, /data-indicator="ready"/);
		assert.match(html, /<label for="[^"]+"[^>]*>Prioridad<\/label>/);
		assert.doesNotMatch(html, /Limpiar filtros|Más filtros|type="search"/);
		assert.equal((html.match(/<select/g) ?? []).length, 2, 'solo Estado y Prioridad');
	});

	await t.test('UI-1C: selector de organización conserva su funcionamiento', () => {
		const many = text(
			render(Switcher, {
				props: {
					organizations: [ORG_A, ORG_B],
					activeOrganizationId: ORG_B.id,
					onchange: () => {}
				}
			}).body
		);
		const label = /<label class="sf-org-label[^"]*" for="([^"]+)">Organización<\/label>/.exec(many);
		assert.ok(label, 'etiqueta asociada');
		assert.match(many, new RegExp(`<select id="${label[1]}"`));
		assert.match(many, new RegExp(`<option value="${ORG_B.id}"[^>]*selected`));
		assert.match(many, new RegExp(`<option value="${ORG_A.id}"`));
		assert.match(many, /<option value="" disabled/);
		const single = text(
			render(Switcher, {
				props: { organizations: [ORG_A], activeOrganizationId: ORG_A.id, onchange: () => {} }
			}).body
		);
		assert.match(single, /Alfa/);
		assert.doesNotMatch(single, /<select/);
		assert.equal(
			text(
				render(Switcher, {
					props: {
						organizations: [ORG_A, ORG_B],
						activeOrganizationId: ORG_A.id,
						disabled: true,
						onchange: () => {}
					}
				}).body
			).includes('disabled=""'),
			true,
			'deshabilitado durante el cambio'
		);
	});

	await t.test(
		'navegación: sin capability no hay enlace; sin capabilities durante la transición',
		() => {
			const readOnly = shell(readyContext(['incidents:view_own']));
			assert.match(readOnly, /Incidencias/);
			assert.doesNotMatch(readOnly, /Nueva incidencia/);
			const none = shell(readyContext([]));
			assert.doesNotMatch(none, /href="\/app\/incidents\?/);
			// switching organization: capabilities of the previous tenant are never shown
			const switching = shell(
				readyContext(['incidents:view_all', 'incidents:create'], {
					status: 'loading',
					capabilities: []
				})
			);
			assert.doesNotMatch(switching, /Nueva incidencia/);
			assert.doesNotMatch(switching, /href="\/app\/incidents\?/);
			// role names are not capabilities
			assert.doesNotMatch(shell(readyContext(['organization_admin'])), /href="\/app\/incidents\?/);
		}
	);

	const panel = (state, extra = {}) =>
		text(
			render(Panel, {
				props: {
					state,
					filtersActive: false,
					createHref: null,
					now: 1_000_000,
					onretry: () => {},
					onnext: () => {},
					onprevious: () => {},
					onclear: () => {},
					...extra
				}
			}).body
		);
	const apiError = async (status, code, meta = {}) => {
		const { ApiError } = await server.ssrLoadModule('/src/lib/api/errors.ts');
		return new ApiError(status, code, 'x', meta);
	};

	await t.test('estados: carga, vacío, sin resultados, paginación', () => {
		assert.match(panel(listState({ status: 'loading' })), /Cargando incidencias/);
		const empty = panel(listState(), {
			queue: 'all',
			createHref: '/app/incidents/new?organizationId=x'
		});
		assert.match(empty, /Todo tranquilo por aquí/);
		assert.match(empty, /Todavía no hay incidencias en esta organización\./);
		assert.match(empty, /Cuando llegue la primera, aparecerá aquí con todo su contexto\./);
		assert.match(empty, /<svg[^>]*class="sf-illustration[^"]*"[^>]*aria-hidden="true"/);
		assert.match(
			empty,
			/<a[^>]*href="\/app\/incidents\/new\?organizationId=x"[^>]*>[\s\S]*?Crear primera incidencia/
		);
		const noCreate = panel(listState(), { queue: 'all' });
		assert.match(noCreate, /Todo tranquilo por aquí/);
		assert.doesNotMatch(
			noCreate,
			/Crear primera incidencia|Nueva incidencia|<a /,
			'sin create no hay CTA'
		);
		// honest copy per view: "no incidents in this organization" only for the `all` queue
		const mine = panel(listState(), { queue: 'mine', createHref: '/x' });
		assert.match(mine, /No tienes incidencias asignadas/);
		assert.doesNotMatch(mine, /en esta organización|Crear primera/);
		assert.match(panel(listState(), { queue: 'unassigned' }), /pendientes de asignar/);
		assert.match(panel(listState(), { queue: null }), /Todavía no tienes incidencias registradas/);
		assert.doesNotMatch(panel(listState(), { queue: null }), /en esta organización/);
		const noResults = panel(listState(), { filtersActive: true });
		assert.match(noResults, /No hay resultados/);
		assert.match(noResults, /Limpiar filtros/);
		const rows = panel(
			listState({ incidents: [staffView()], nextCursor: 'abc', cursorHistory: [null, 'c1'] })
		);
		assert.match(rows, /aria-label="Paginación de incidencias"/);
		assert.match(rows, /Anterior/);
		assert.match(rows, /Siguiente/);
		assert.doesNotMatch(
			rows,
			/Página \d|de \d+ páginas|total/i,
			'sin paginación numérica ni totales'
		);
		const firstPage = panel(listState({ incidents: [staffView()], nextCursor: null }));
		assert.equal(
			(firstPage.match(/<button[^>]*disabled/g) ?? []).length,
			2,
			'sin anterior ni siguiente'
		);
	});

	await t.test(
		'errores: 429 con espera, 500/503 con referencia, 403 sin reintento, payload inválido',
		async () => {
			const limited = panel(
				listState({
					status: 'error',
					error: await apiError(429, 'RATE_LIMITED', { retryAfterSeconds: 30 }),
					cooldownUntil: 1_000_000 + 30_000
				})
			);
			assert.match(limited, /Demasiadas solicitudes/);
			assert.match(limited, /Podrás reintentar en 30 s/);
			assert.match(limited, /<button[^>]*disabled[^>]*>[\s\S]*?Reintentar/);
			const server500 = panel(
				listState({
					status: 'error',
					error: await apiError(500, 'INTERNAL_ERROR', { requestId: REQ_ID })
				})
			);
			assert.match(server500, new RegExp(REQ_ID));
			assert.match(server500, /Reintentar/);
			assert.match(server500, /role="alert"/);
			const unavailable = panel(
				listState({ status: 'error', error: await apiError(503, 'LIMITER_UNAVAILABLE') })
			);
			assert.match(unavailable, /Servicio no disponible/);
			const forbidden = panel(
				listState({ status: 'error', error: await apiError(403, 'FORBIDDEN') })
			);
			assert.match(forbidden, /Acceso no permitido/);
			assert.doesNotMatch(forbidden, /Reintentar/);
			const invalid = panel(
				listState({ status: 'error', error: await apiError(200, 'INVALID_PAYLOAD') })
			);
			assert.match(invalid, /Respuesta inesperada del servidor/);
			const notFound = panel(
				listState({ status: 'error', error: await apiError(404, 'NOT_FOUND') })
			);
			assert.match(notFound, /Recurso no disponible/);
		}
	);

	await t.test('tabla: staff con columnas internas; requester sin campos internos', () => {
		const staff = text(render(Table, { props: { incidents: [staffView()] } }).body);
		for (const expected of [
			'Solicitante',
			'Asignación',
			'Etiqueta Cliente SL',
			'Luis Técnico',
			'Redes',
			'Incumplido',
			'Urgente',
			'#42'
		])
			assert.ok(staff.includes(expected), expected);
		assert.match(staff, /<th scope="col"/);
		assert.match(staff, /<caption/);
		const item = staffView();
		assert.ok(
			text(render(Table, { props: { incidents: [item] } }).body).includes(
				`href="/app/incidents/${item.id}?organizationId=${ORG_A.id}"`
			),
			'enlace real al detalle'
		);
		const requester = text(render(Table, { props: { incidents: [requesterView()] } }).body);
		assert.doesNotMatch(requester, /Solicitante|Asignación|Sin asignar|Técnico/);
		assert.match(requester, /Mi portátil/);
		assert.match(requester, /En plazo/);
	});

	await t.test('toolbar: solo colas disponibles; filtros con etiquetas', () => {
		const html = text(
			render(Toolbar, {
				props: {
					queues: ['mine'],
					activeQueue: 'mine',
					queueHref: (q) => `/app/incidents?queue=${q}`,
					status: 'open',
					priority: undefined,
					onfilter: () => {},
					onclear: () => {}
				}
			}).body
		);
		assert.match(html, /Asignadas a mí/);
		assert.doesNotMatch(html, /queue=(all|unassigned)|Sin asignar/);
		assert.match(html, /aria-current="page"/);
		assert.match(html, /<label for="[^"]+"[^>]*>Estado<\/label>/);
		assert.match(html, /Limpiar filtros/);
	});

	await t.test('organización: enlace inválido no se sustituye; selección explícita', () => {
		const invalid = text(
			render(Gate, {
				props: {
					context: readyContext([], {
						status: 'invalid-organization',
						activeOrganizationId: null,
						rejectedOrganizationId: randomUUID()
					}),
					onretry: () => {},
					children
				}
			}).body
		);
		assert.match(invalid, /Organización no disponible/);
		assert.doesNotMatch(invalid, /Contenido de página/);
		assert.match(invalid, new RegExp(`href="/app/incidents\\?organizationId=${ORG_B.id}"`));
		const select = text(
			render(Gate, {
				props: {
					context: readyContext([], { status: 'selection-required' }),
					onretry: () => {},
					children
				}
			}).body
		);
		assert.match(select, /Selecciona una organización/);
		const ready = text(
			render(Gate, { props: { context: readyContext([]), onretry: () => {}, children } }).body
		);
		assert.match(ready, /Contenido de página/);
	});
});

test('FE-04: el listado legado ya no rechaza la proyección requester', async () => {
	const org = ORG_A.id;
	const payload = { incidents: [{ ...requesterView(), organizationId: org }] };
	const items = await listIncidents(org, {
		customFetch: async () => new Response(JSON.stringify(payload), { status: 200 })
	});
	assert.equal(items[0].audience, 'requester');
	assert.equal(items[0].client, null, 'sin etiqueta inventada');
});

test('UI-1C: iniciales derivadas de datos reales', () => {
	assert.equal(userInitials('Ana Pérez'), 'AP');
	assert.equal(userInitials('  maría  josé   de la  Peña '), 'MP');
	assert.equal(userInitials('Óscar'), 'Ó');
	assert.equal(userInitials('', 'luis@example.test'), 'L');
	assert.equal(userInitials(null, null), '?');
});

test('aislamiento demo: el recorrido nuevo no importa módulos demo', () => {
	const entryPoints = [
		'src/routes/app/+layout.svelte',
		'src/routes/app/+page.svelte',
		'src/routes/app/incidents/+page.svelte'
	];
	const seen = new Set();
	const resolveImport = (from, spec) => {
		let target;
		if (spec.startsWith('$lib/')) target = path.join('src/lib', spec.slice(5));
		else if (spec.startsWith('.')) target = path.join(path.dirname(from), spec);
		else return null;
		for (const candidate of [
			target,
			`${target}.ts`,
			`${target}.svelte`,
			path.join(target, 'index.ts')
		])
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
		return null;
	};
	const visit = (file) => {
		const normalized = file.replace(/\\/g, '/');
		if (seen.has(normalized)) return;
		seen.add(normalized);
		const source = fs.readFileSync(file, 'utf8');
		for (const match of source.matchAll(/(?:import|from)\s+['"]([^'"]+)['"]/g)) {
			const next = resolveImport(file, match[1]);
			if (next) visit(next);
		}
	};
	for (const entry of entryPoints) visit(entry);
	const graph = [...seen];
	assert.ok(
		graph.some((f) => f.endsWith('lib/api/incident-views.ts')),
		'usa el cliente real'
	);
	const forbidden = graph.filter((f) =>
		/lib\/(data|storage|support|users|settings|incidents|classification|reasons|notifications)\/|DemoSessionSelector|routes\/app\/demo|lib\/types\//.test(
			f
		)
	);
	assert.deepEqual(forbidden, [], 'ningún módulo demo en el grafo del nuevo /app');
	// the demo stays reachable only by its own route, never linked from the new experience
	for (const file of graph.filter((f) => f.endsWith('.svelte')))
		assert.doesNotMatch(
			fs.readFileSync(file, 'utf8'),
			/(href=|resolve\(|goto\()\s*['"`{]*\/app\/demo/,
			file
		);
	// no role-name gating in the new experience: capabilities only
	for (const file of graph.filter((f) => !f.startsWith('src/lib/api/')))
		assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\brole\s*===|\.role\s*==/, file);
	assert.ok(fs.existsSync('src/routes/app/demo/+page.svelte'), 'demo aislada, no borrada');
});

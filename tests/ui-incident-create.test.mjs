import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { ApiError } from '../src/lib/api/errors.ts';
import { buildCreateIncidentPayload } from '../src/lib/api/incident-create.ts';
import {
	createFormSections,
	emptyCreateDraft,
	isDraftDirty,
	planCreationFollowUp,
	presentCreateError,
	toCreateRequest,
	validateCreateDraft
} from '../src/lib/app/incident-create-form.ts';
import {
	catalogsFor,
	createIncidentCreateCatalogs,
	requesterOptions
} from '../src/lib/app/incident-create-catalogs.ts';
import { createIncidentCreateController } from '../src/lib/app/incident-create-controller.ts';
import { presentMutationFailure } from '../src/lib/app/error-presentation.ts';
import { tenantIdentityOf } from '../src/lib/app/tenant-identity.ts';

/**
 * UI-2B — /app/incidents/new against the real code:
 * - the REAL page, form and primitives rendered through Vite SSR (only the organization context
 *   and $app/* are test doubles: a ready context with the capabilities under test);
 * - the real form model, follow-up planner, creation controller and tenant-bound catalogs.
 */
/** Cleanups of temporary client builds (run at the end of the test that created them). */
const t_after_cleanup = [];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER = randomUUID();
const OTHER = randomUUID();
const POLICY = randomUUID();
const SITE = randomUUID();
const CATEGORY = randomUUID();
const ALL_CAPS = [
	'incidents:create',
	'incidents:view_all',
	'memberships:view',
	'sites:view',
	'categories:view',
	'sla:assign',
	'sla:view'
];

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

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

test('UI-2B — página y formulario reales (SSR)', async (t) => {
	const server = await createServer({
		root,
		configFile: false,
		envDir: false,
		logLevel: 'silent',
		resolve: { alias: { $lib: path.resolve(root, 'src/lib') } },
		plugins: [
			{
				name: 'sf-ui2b-doubles',
				enforce: 'pre',
				resolveId(id) {
					if (['$app/paths', '$app/state', '$app/navigation', '$lib/app/context'].includes(id))
						return `\0${id}`;
					// `$lib` is aliased before plugins run: match the resolved context module too.
					if (/[\\/]src[\\/]lib[\\/]app[\\/]context(\.ts)?$/.test(id)) return '\0$lib/app/context';
				},
				load(id) {
					if (id === '\0$app/paths') return 'export const resolve = (p) => p;';
					if (id === '\0$app/state')
						return 'export const page = { get url() { return globalThis.__sfUrl; } };';
					if (id === '\0$app/navigation')
						return 'export const goto = async () => {}; export const beforeNavigate = () => {};';
					if (id === '\0$lib/app/context')
						return `export function useOrganizationContext() {
							return {
								subscribe(run) { run(globalThis.__sfContext); return () => {}; },
								get: () => globalThis.__sfContext,
								load: async () => {}
							};
						}`;
				}
			},
			svelte({ configFile: false })
		],
		server: { middlewareMode: true, hmr: false, watch: null },
		appType: 'custom'
	});
	t.after(() => server.close());
	const { render } = await server.ssrLoadModule('svelte/server');
	const Page = (await server.ssrLoadModule('/src/routes/app/incidents/new/+page.svelte')).default;
	const Form = (
		await server.ssrLoadModule('/src/lib/components/incidents/IncidentCreateForm.svelte')
	).default;
	const Notice = (
		await server.ssrLoadModule('/src/lib/components/incidents/IncidentCreatedNotice.svelte')
	).default;
	const clean = (html) => html.replace(/<!--.*?-->/g, '');
	const renderPage = (capabilities) => {
		globalThis.__sfContext = contextState(capabilities);
		globalThis.__sfUrl = new URL(`http://localhost/app/incidents/new?organizationId=${ORG_A}`);
		return clean(render(Page, { props: {} }).body);
	};

	await t.test('1. sin incidents:create no hay formulario funcional', () => {
		const html = renderPage(['incidents:view_all']);
		assert.match(html, /No puedes crear incidencias/);
		assert.doesNotMatch(html, /<form/);
		assert.doesNotMatch(html, /Crear incidencia/);
		assert.match(html, /data-sf-ui/, 'dentro del AppShell');
	});

	await t.test('2-4. campos principales, placeholders aprobados, prioridad media', () => {
		const html = renderPage(['incidents:create']);
		assert.equal((html.match(/<h1/g) ?? []).length, 1, 'un único h1');
		assert.match(html, /<h1[^>]*>Nueva incidencia<\/h1>/);
		assert.match(html, /Registra una nueva solicitud de soporte\./);
		assert.match(
			html,
			/<nav[^>]*aria-label="Ruta de navegación"[\s\S]*?aria-current="page"[^>]*>Nueva incidencia/
		);
		assert.match(
			html,
			new RegExp(`href="/app/incidents\\?organizationId=${ORG_A}"[^>]*>Incidencias`)
		);
		for (const label of ['Título', 'Descripción', 'Cliente', 'Prioridad'])
			assert.match(html, new RegExp(`<label[^>]*for="[^"]+"[^>]*>\\s*${label}`), label);
		assert.match(html, /placeholder="Introduce un título"/);
		assert.match(html, /placeholder="Introduce el cliente"/);
		assert.match(html, /placeholder="Describe el problema o la solicitud"/);
		assert.match(html, /Nombre o referencia del cliente asociado a la incidencia\./);
		assert.match(html, /<option value="medium"[^>]*selected/);
		assert.doesNotMatch(html, /Ej\.|Hospital|PostgreSQL|Empresa XYZ/);
		assert.match(html, /<button[^>]*type="submit"[\s\S]*?Crear incidencia/);
		assert.match(html, /Cancelar/);
		// no inputs for server-owned or internal fields
		assert.doesNotMatch(html, /name="status"|Estado inicial|Nivel de soporte|Equipo|Técnico/);
	});

	await t.test('7-9. contexto opcional solo con las capabilities reales', () => {
		const minimal = renderPage(['incidents:create']);
		for (const label of ['Solicitante', 'Sede', 'Categoría', 'SLA'])
			assert.doesNotMatch(minimal, new RegExp(`>\\s*${label}\\s*<`), label);
		const full = renderPage(ALL_CAPS);
		for (const label of ['Solicitante', 'Sede', 'Categoría', 'SLA'])
			assert.match(full, new RegExp(`<label[^>]*>\\s*${label}`), label);
		assert.match(full, /<option value="auto"[^>]*selected[^>]*>Automático/);
		assert.match(full, /<option value="none"[^>]*>Sin SLA/);
		assert.match(full, /Yo \(Ana Pérez\)/);
		// view_all without memberships:view (or the reverse) never offers other requesters
		assert.doesNotMatch(
			renderPage(['incidents:create', 'incidents:view_all']),
			/>\s*Solicitante\s*</
		);
		assert.doesNotMatch(
			renderPage(['incidents:create', 'memberships:view']),
			/>\s*Solicitante\s*</
		);
		// no UUID text fields anywhere
		assert.doesNotMatch(full, /placeholder="[^"]*(UUID|uuid|0000)/);
	});

	const baseProps = (overrides = {}) => ({
		draft: emptyCreateDraft(),
		errors: {},
		sections: createFormSections(['incidents:create']),
		catalogs: {
			sites: { status: 'idle', options: [], error: null, errorMessage: null },
			categories: { status: 'idle', options: [], error: null, errorMessage: null },
			memberships: { status: 'idle', options: [], error: null, errorMessage: null },
			slaPolicies: { status: 'idle', options: [], error: null, errorMessage: null }
		},
		selfName: 'Ana',
		onsubmit: () => ({}),
		oncancel: () => {},
		onretrycatalog: () => {},
		...overrides
	});

	await t.test('12/21. errores accesibles junto al campo; semántica', () => {
		const html = clean(
			render(Form, {
				props: baseProps({
					errors: { title: 'El título es obligatorio.', client: 'El cliente es obligatorio.' }
				})
			}).body
		);
		const title =
			/<input[^>]*id="([^"]+)"[^>]*aria-invalid="true"[^>]*aria-describedby="([^"]+)"[^>]*placeholder="Introduce un título"/.exec(
				html
			);
		assert.ok(title, 'aria-invalid + aria-describedby en el título');
		assert.match(
			html,
			new RegExp(`<p class="sf-field-error[^"]*" id="${title[2]}">El título es obligatorio\\.</p>`)
		);
		assert.match(html, /required=""/);
		assert.match(html, /aria-required="true"/);
		assert.match(html, /<h2[^>]*>Información principal<\/h2>/);
		assert.match(html, /<form[^>]*novalidate/);
	});

	await t.test('17. cooldown 429: envío deshabilitado con aviso', () => {
		const html = clean(render(Form, { props: baseProps({ submitBlockedSeconds: 12 }) }).body);
		assert.match(html, /Podrás enviar de nuevo en 12 s\./);
		assert.match(html, /<button[^>]*type="submit"[^>]*disabled/);
		const pending = clean(render(Form, { props: baseProps({ submitting: true }) }).body);
		assert.match(pending, /Creando incidencia…/);
		assert.match(pending, /aria-busy="true"/);
	});

	await t.test('catálogo con error: mensaje local y reintento, no "sin opciones"', () => {
		const html = clean(
			render(Form, {
				props: baseProps({
					sections: createFormSections(['incidents:create', 'sites:view']),
					catalogs: {
						...baseProps().catalogs,
						sites: {
							status: 'error',
							options: [],
							error: new ApiError(422, 'RESULT_LIMIT_EXCEEDED', 'x', { requestId: 'ref-1' }),
							errorMessage:
								'Hay demasiadas opciones para mostrarlas aquí. Contacta con un administrador.'
						}
					}
				})
			}).body
		);
		assert.match(html, /role="alert"[\s\S]*Hay demasiadas opciones/);
		assert.match(html, /Reintentar/);
		assert.match(
			html,
			/placeholder="Introduce un título"/,
			'los campos principales siguen disponibles'
		);
	});

	await t.test('15. creada sin lectura: éxito honesto sin enlace al detalle', () => {
		const html = clean(
			render(Notice, {
				props: { incidentNumber: 57, listHref: null, oncreateanother: () => {} }
			}).body
		);
		assert.match(html, /Incidencia creada/);
		assert.match(html, /#57/);
		assert.match(html, /role="status"/);
		assert.doesNotMatch(html, /href="\/app\/incidents\//);
		assert.doesNotMatch(html, /Error|error/);
	});
});

test('5-6/10-11. petición: campos reales, client y clientUserId separados, SLA', () => {
	const sections = createFormSections(ALL_CAPS);
	const draft = {
		...emptyCreateDraft(),
		title: ' T ',
		description: 'D',
		client: 'Etiqueta',
		requester: OTHER,
		siteId: SITE,
		categoryId: CATEGORY
	};
	const auto = toCreateRequest(draft, sections, USER);
	assert.equal('slaPolicyId' in auto, false, 'Automático omite slaPolicyId');
	assert.equal(auto.client, 'Etiqueta');
	assert.equal(auto.clientUserId, OTHER);
	const body = buildCreateIncidentPayload(ORG_A, auto);
	for (const forbidden of ['status', 'supportLevel', 'teamId', 'assignedToUserId'])
		assert.equal(forbidden in body, false, forbidden);
	assert.equal(toCreateRequest({ ...draft, sla: 'none' }, sections, USER).slaPolicyId, null);
	assert.equal(toCreateRequest({ ...draft, sla: POLICY }, sections, USER).slaPolicyId, POLICY);
	// without sla:assign neither null nor a policy is ever sent
	const noSla = createFormSections(['incidents:create', 'sites:view']);
	assert.equal('slaPolicyId' in toCreateRequest({ ...draft, sla: 'none' }, noSla, USER), false);
	assert.equal('slaPolicyId' in toCreateRequest({ ...draft, sla: POLICY }, noSla, USER), false);
	// a policy needs sla:view too (sla:assign alone: Automático / Sin SLA)
	const assignOnly = createFormSections(['incidents:create', 'sla:assign']);
	assert.equal(
		'slaPolicyId' in toCreateRequest({ ...draft, sla: POLICY }, assignOnly, USER),
		false
	);
	// sections not offered never leak their stale values
	const bare = toCreateRequest(draft, createFormSections(['incidents:create']), USER);
	assert.deepEqual(Object.keys(bare).sort(), ['client', 'description', 'priority', 'title']);
	// With the selector, "Yo" is sent explicitly (see the MEDIUM #1 test below)
	assert.equal(toCreateRequest({ ...draft, requester: 'self' }, sections, USER).clientUserId, USER);
});

test('12. validación alineada con el backend', () => {
	const errors = validateCreateDraft({
		...emptyCreateDraft(),
		title: '  ',
		client: 'x'.repeat(256)
	});
	assert.deepEqual(Object.keys(errors).sort(), ['client', 'description', 'title']);
	assert.deepEqual(
		validateCreateDraft({
			...emptyCreateDraft(),
			title: 'T',
			description: 'd'.repeat(20_000),
			client: 'C'
		}),
		{},
		'sin límite inventado de descripción'
	);
	assert.equal(isDraftDirty(emptyCreateDraft()), false);
	assert.equal(isDraftDirty({ ...emptyCreateDraft(), description: 'algo' }), true);
	assert.equal(isDraftDirty({ ...emptyCreateDraft(), priority: 'high' }), true);
});

test('13-18. resultados: detalle, sin lectura, desconocido, 429, obsoleto, doble envío', async () => {
	const owner = identity(['incidents:create', 'incidents:view_all']);
	const incident = {
		audience: 'staff',
		id: randomUUID(),
		organizationId: ORG_A,
		incidentNumber: 9
	};
	assert.deepEqual(
		planCreationFollowUp(
			{ status: 'success', value: { incident, readability: 'readable' } },
			owner,
			owner
		),
		{ kind: 'open-detail', incidentId: incident.id, organizationId: ORG_A }
	);
	assert.deepEqual(
		planCreationFollowUp(
			{ status: 'success', value: { incident, readability: 'not-readable' } },
			owner,
			owner
		),
		{ kind: 'show-created' }
	);
	const unknown = planCreationFollowUp(
		{ status: 'unknown', error: new ApiError(0, 'NETWORK_ERROR', 'x') },
		owner,
		owner
	);
	assert.deepEqual(unknown, {
		kind: 'keep-draft',
		outcome: 'unknown',
		fieldErrors: {},
		cooldownSeconds: null
	});
	assert.equal(
		presentMutationFailure({ status: 'unknown', error: new ApiError(0, 'NETWORK_ERROR', 'x') })
			.action,
		'verify'
	);
	const limited = planCreationFollowUp(
		{ status: 'error', error: new ApiError(429, 'RATE_LIMITED', 'x', { retryAfterSeconds: 20 }) },
		owner,
		owner
	);
	assert.equal(limited.kind, 'keep-draft');
	assert.equal(limited.cooldownSeconds, 20);
	const field = planCreationFollowUp(
		{ status: 'error', error: new ApiError(409, 'CATEGORY_INACTIVE', 'category is not active') },
		owner,
		owner
	);
	assert.deepEqual(field.fieldErrors, { categoryId: 'La categoría seleccionada está inactiva.' });
	// stale: the identity changed while the POST was in flight -> nothing applies
	assert.deepEqual(
		planCreationFollowUp(
			{ status: 'success', value: { incident, readability: 'readable' } },
			owner,
			identity(['incidents:create'], ORG_B, 2)
		),
		{ kind: 'ignore' }
	);
	assert.deepEqual(planCreationFollowUp({ status: 'busy' }, owner, owner), { kind: 'ignore' });

	// the real controller: one POST for two submits, unknown never resent
	let sends = 0;
	const gate = deferred();
	const creator = createIncidentCreateController({ submit: () => (sends++, gate.promise) });
	creator.setIdentity(owner);
	const request = toCreateRequest(
		{ ...emptyCreateDraft(), title: 'T', description: 'D', client: 'C' },
		createFormSections(owner.capabilities),
		owner.userId
	);
	const first = creator.submit(request);
	assert.equal((await creator.submit(request)).status, 'busy');
	gate.reject(new ApiError(0, 'NETWORK_ERROR', 'x'));
	assert.equal((await first).status, 'unknown');
	assert.equal(sends, 1);
});

test('presentación segura de errores del POST (sin mensajes técnicos del backend)', () => {
	const bad = presentCreateError(
		new ApiError(400, 'INVALID_INPUT', 'title must not exceed 255 characters')
	);
	assert.doesNotMatch(bad.message, /must|exceed/);
	const tooLarge = presentCreateError(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'x'));
	assert.match(tooLarge.message, /demasiado extenso/);
	const server = presentCreateError(
		new ApiError(500, 'INTERNAL_ERROR', 'stack', { requestId: 'r-1' })
	);
	assert.doesNotMatch(server.message, /stack/);
	assert.equal(server.requestId, 'r-1');
	assert.equal(
		presentCreateError(new ApiError(404, 'CLIENT_USER_MEMBERSHIP_NOT_FOUND', 'x')).field.name,
		'clientUserId'
	);
});

test('19. catálogos: tenant-bound, error no es lista vacía, cambio de tenant', async () => {
	const calls = [];
	const gates = {};
	const loader = (name) => (organizationId, signal) => {
		calls.push([name, organizationId]);
		const d = deferred();
		(gates[name] ??= []).push({ ...d, signal });
		return d.promise;
	};
	const controller = createIncidentCreateCatalogs({
		sites: loader('sites'),
		categories: loader('categories'),
		memberships: loader('memberships'),
		slaPolicies: loader('slaPolicies')
	});
	const a = identity(ALL_CAPS, ORG_A, 1);
	const names = catalogsFor(createFormSections(ALL_CAPS));
	assert.deepEqual(names.sort(), ['categories', 'memberships', 'sites', 'slaPolicies']);
	controller.setIdentity(a, names);
	assert.equal(controller.get().sites.status, 'loading');
	gates.sites[0].resolve([
		{ id: SITE, name: 'Sede Norte', active: true },
		{ id: randomUUID(), name: 'Sede cerrada', active: false }
	]);
	gates.categories[0].reject(new ApiError(422, 'RESULT_LIMIT_EXCEEDED', 'x'));
	gates.memberships[0].resolve([
		{
			id: randomUUID(),
			active: true,
			user: { id: USER, name: 'Ana', email: null, active: true },
			roles: []
		},
		{
			id: randomUUID(),
			active: true,
			user: { id: OTHER, name: 'Bruno', email: 'b@x.test', active: true },
			roles: []
		},
		{
			id: randomUUID(),
			active: false,
			user: { id: randomUUID(), name: 'Baja', email: null, active: true },
			roles: []
		}
	]);
	await new Promise((resolve) => setImmediate(resolve));
	const state = controller.get();
	assert.deepEqual(state.sites.options, [{ value: SITE, label: 'Sede Norte' }]);
	assert.equal(state.categories.status, 'error');
	assert.deepEqual(state.categories.options, [], 'error, no una lista vacía "lista"');
	assert.match(state.categories.errorMessage, /demasiadas opciones/);
	assert.deepEqual(state.memberships.options, [{ value: OTHER, label: 'Bruno', hint: 'b@x.test' }]);

	// organization B: everything of A disappears at once; A's late answer is ignored
	controller.setIdentity(identity(ALL_CAPS, ORG_B, 2), names);
	assert.equal(gates.slaPolicies[0].signal.aborted, true);
	assert.deepEqual(controller.get().sites.options, []);
	gates.slaPolicies[0].resolve([
		{ id: POLICY, name: 'Política de A', active: true, isDefault: true }
	]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.notEqual(controller.get().slaPolicies.status, 'ready');
	assert.ok(
		calls.some(([name, org]) => name === 'sites' && org === ORG_B),
		'B carga sus propios datos'
	);

	// manual retry of a failed catalog (a safe GET)
	controller.setIdentity(identity(ALL_CAPS, ORG_B, 2), names);
	assert.deepEqual(
		requesterOptions(
			[
				{
					id: randomUUID(),
					active: true,
					user: { id: OTHER, name: 'X', email: null, active: false },
					roles: []
				}
			],
			USER
		),
		[],
		'usuarios inactivos no son solicitantes'
	);
	controller.dispose();
});

test('20. aislamiento: sin demo, servidor, bootstrap propio, storage ni {@html}', () => {
	const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
	const files = {
		page: read('src/routes/app/incidents/new/+page.svelte'),
		form: read('src/lib/components/incidents/IncidentCreateForm.svelte'),
		notice: read('src/lib/components/incidents/IncidentCreatedNotice.svelte'),
		model: read('src/lib/app/incident-create-form.ts'),
		catalogs: read('src/lib/app/incident-create-catalogs.ts')
	};
	for (const [name, source] of Object.entries(files)) {
		const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$|<!--[\s\S]*?-->/gm, '');
		assert.doesNotMatch(
			code,
			/\$lib\/server|drizzle|\$lib\/data|\$lib\/storage|\$lib\/support|routes\/app\/demo/,
			name
		);
		assert.doesNotMatch(code, /localStorage|sessionStorage|\{@html|innerHTML/, name);
		assert.doesNotMatch(code, /role\s*===|organization_admin|technician/, name);
		assert.doesNotMatch(code, /PostgreSQL/, name);
	}
	assert.doesNotMatch(files.page, /getMe|fetch\(/, 'sin bootstrap propio ni fetch manual');
	assert.doesNotMatch(files.form, /fetch\(|goto\(/, 'el formulario solo renderiza');
	assert.match(files.page, /useOrganizationContext\(\)/);
	assert.match(files.page, /createIncidentCreateController/);
	// the legacy session store is only cleared on sign-out/expiry, never read as authority
	assert.doesNotMatch(files.page, /\$session\b/);
	assert.equal(
		fs.existsSync(path.join(root, 'src/lib/components/incidents/RealIncidentCreateForm.svelte')),
		false
	);
});

/**
 * Regression (UI-2B bug found in a real browser): the form binds `bind:element={controls.x}` to
 * element refs that are still undefined. The primitives declared `element = $bindable(null)`;
 * Svelte's CLIENT runtime rejects binding `undefined` to a bindable prop with a fallback
 * (props_invalid_value) when mounting Input. That aborted the render: a direct load stayed on
 * "Cargando organización…" (the ready state could not be rendered) and an SPA navigation to
 * /app/incidents/new kept the previous page on screen. SSR never runs that check, so this test
 * compiles the REAL primitives for the client and runs them with the REAL Svelte client runtime,
 * exactly as a parent binding an unset ref would. Without a DOM in Node the component stops at
 * its first DOM access — after props initialization, which is the part under test.
 */
test('regresión: las primitivas aceptan bind:element de una referencia aún undefined (runtime cliente)', async () => {
	const { compile } = await import('svelte/compiler');
	const runtime = import.meta.resolve('svelte/internal/client');
	const disclose = import.meta.resolve('svelte/internal/disclose-version');
	const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ui2b-client-'));
	t_after_cleanup.push(() => fs.rmSync(out, { recursive: true, force: true }));
	const compiled = new Map();
	/** Compiles a component (and its relative .svelte imports) for the client into `out`. */
	function compileForClient(relative) {
		if (compiled.has(relative)) return compiled.get(relative);
		const source = fs.readFileSync(path.join(root, relative), 'utf8');
		const { js } = compile(source, { generate: 'client', dev: true, filename: relative });
		const target = path.join(
			out,
			relative.split(path.sep).join('/').split('/').join('__') + '.mjs'
		);
		compiled.set(relative, target);
		const code = js.code
			.replaceAll("'svelte/internal/client'", `'${runtime}'`)
			.replaceAll("'svelte/internal/disclose-version'", `'${disclose}'`)
			.replace(/from '\.\/([A-Za-z]+)\.svelte'/g, (_, name) => {
				const dependency = compileForClient(path.join(path.dirname(relative), `${name}.svelte`));
				return `from '${pathToFileURL(dependency).href}'`;
			});
		fs.writeFileSync(target, code);
		return target;
	}
	const control = { id: 'campo', describedBy: undefined, invalid: false, required: true };
	for (const primitive of [
		'src/lib/ui/Input.svelte',
		'src/lib/ui/Textarea.svelte',
		'src/lib/ui/Select.svelte'
	]) {
		const Component = (await import(pathToFileURL(compileForClient(primitive)).href)).default;
		let ref; // like `controls.title` before the element exists
		const props = {
			control,
			options: [{ value: 'medium', label: 'Media' }],
			get value() {
				return '';
			},
			set value(_) {},
			get element() {
				return ref;
			},
			set element(value) {
				ref = value;
			}
		};
		let failure = null;
		try {
			Component(null, props);
		} catch (error) {
			failure = error;
		}
		assert.doesNotMatch(String(failure?.message ?? ''), /props_invalid_value/, primitive);
		// it got past props initialization and only stopped at the missing DOM of Node
		assert.match(String(failure?.message ?? ''), /document is not defined/, primitive);
	}
	for (const cleanup of t_after_cleanup.splice(0)) cleanup();
});

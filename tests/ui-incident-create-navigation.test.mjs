import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { ApiError } from '../src/lib/api/errors.ts';
import { signOut } from '../src/lib/api/auth.ts';
import { buildCreateIncidentPayload } from '../src/lib/api/incident-create.ts';
import {
	createFormSections,
	emptyCreateDraft,
	planCreationFollowUp,
	toCreateRequest
} from '../src/lib/app/incident-create-form.ts';
import {
	createIncidentCreateCatalogs,
	requesterOptions
} from '../src/lib/app/incident-create-catalogs.ts';
import { createIncidentCreateController } from '../src/lib/app/incident-create-controller.ts';
import {
	createDraftLeaveGuard,
	currentSessionExpiry,
	DISCARD_DRAFT_PROMPT,
	incidentDetailPath,
	incidentListPath,
	newIncidentPath,
	SESSION_EXPIRED_PATH
} from '../src/lib/app/incident-create-navigation.ts';
import { applyOrganizationChoice } from '../src/lib/app/organization-switch.ts';
import { attemptSignOut, SIGN_OUT_FAILED_MESSAGE } from '../src/lib/app/sign-out.ts';
import { tenantIdentityOf } from '../src/lib/app/tenant-identity.ts';

/**
 * UI-2B post-audit (MEDIUM #1-#4). Everything here is the code the page imports and executes:
 * the request model, the navigation helpers and draft guard, the session-expiry decision, the
 * sign-out outcome and the organization-switch veto — plus the REAL page rendered through Vite
 * SSR, whose own beforeNavigate handler is captured and exercised.
 * Not covered here (no DOM/router in Node): the SvelteKit router actually cancelling a navigation
 * and the browser DOM of the switcher; those were exercised in a real-browser client harness.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER = randomUUID();
const OTHER = randomUUID();
const INCIDENT = randomUUID();
const PICKER = ['incidents:create', 'incidents:view_all', 'memberships:view'];

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
const flush = () => new Promise((resolve) => setImmediate(resolve));
const filled = { ...emptyCreateDraft(), title: 'T', description: 'D', client: 'Etiqueta' };

// ------------------------------------------------------------------------------------------------
// MEDIUM #1 — "Yo" as requester
// ------------------------------------------------------------------------------------------------

test('#1 A. con selector, "Yo" envía el userId real (el servidor no lo rellena para quien puede elegir)', () => {
	const request = toCreateRequest(filled, createFormSections(PICKER), USER);
	const body = buildCreateIncidentPayload(ORG_A, request);
	assert.equal(body.clientUserId, USER);
	assert.equal(body.client, 'Etiqueta', '`client` sigue siendo el texto explícito');
});

test('#1 B. con selector y otro miembro, se envía el userId elegido', () => {
	const request = toCreateRequest(
		{ ...filled, requester: OTHER },
		createFormSections(PICKER),
		USER
	);
	assert.equal(buildCreateIncidentPayload(ORG_A, request).clientUserId, OTHER);
});

test('#1 C. sin capacidad de elegir: sin selector y sin clientUserId (el servidor usa al actor)', () => {
	for (const caps of [
		['incidents:create'],
		['incidents:create', 'memberships:view'],
		['incidents:create', 'incidents:view_all']
	]) {
		const sections = createFormSections(caps);
		assert.equal(sections.requester, false, caps.join(','));
		// even a stale select value can never target another user
		const request = toCreateRequest({ ...filled, requester: OTHER }, sections, USER);
		assert.equal('clientUserId' in buildCreateIncidentPayload(ORG_A, request), false);
	}
});

test('#1 D. nunca un UUID como etiqueta visible', () => {
	const options = requesterOptions(
		[
			{
				id: randomUUID(),
				active: true,
				user: { id: OTHER, name: 'Bruno Díaz', email: null, active: true },
				roles: []
			},
			{
				id: randomUUID(),
				active: true,
				user: { id: randomUUID(), name: '  ', email: 'x@y.z', active: true },
				roles: []
			}
		],
		USER
	);
	assert.deepEqual(options, [{ value: OTHER, label: 'Bruno Díaz' }], 'sin nombre -> no se ofrece');
	const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-/i;
	for (const option of options) assert.doesNotMatch(option.label, uuid);
});

// ------------------------------------------------------------------------------------------------
// MEDIUM #2 — sign-out that looked successful
// ------------------------------------------------------------------------------------------------

test('#2 logout: solo 2xx o 401 (sesión ya inexistente) cuentan como cerrado', async () => {
	// 204 cannot carry a body (the Response constructor would throw).
	const answer = (status) => async () => new Response(status === 204 ? null : '{}', { status });
	for (const status of [200, 204, 401])
		assert.equal((await attemptSignOut(() => signOut(answer(status)))).ok, true, String(status));
	for (const status of [403, 500, 503]) {
		const result = await attemptSignOut(() => signOut(answer(status)));
		assert.equal(result.ok, false, String(status));
		assert.equal(result.error.status, status);
	}
	const offline = await attemptSignOut(() =>
		signOut(async () => {
			throw new TypeError('Failed to fetch');
		})
	);
	assert.equal(offline.ok, false);
	assert.equal(offline.error.status, 0);
	let sends = 0;
	await attemptSignOut(() =>
		signOut(async () => {
			sends++;
			return new Response('{}', { status: 503 });
		})
	);
	assert.equal(sends, 1, 'sin reintento automático');
});

// ------------------------------------------------------------------------------------------------
// MEDIUM #3 — current 401 of a catalog
// ------------------------------------------------------------------------------------------------

test('#3 catálogos: 401 vigente -> sesión expirada; stale -> ignorado; 403/5xx -> error local', async () => {
	const gates = {};
	const loader = (name) => () => {
		const d = deferred();
		(gates[name] ??= []).push(d);
		return d.promise;
	};
	const catalogs = createIncidentCreateCatalogs({
		sites: loader('sites'),
		categories: loader('categories'),
		memberships: loader('memberships'),
		slaPolicies: loader('slaPolicies')
	});
	const idle = { error: null };
	const all = ['sites', 'categories', 'memberships', 'slaPolicies'];
	catalogs.setIdentity(identity(PICKER, ORG_A, 1), all);
	gates.categories[0].reject(new ApiError(403, 'FORBIDDEN', 'x'));
	gates.memberships[0].reject(new ApiError(500, 'INTERNAL_ERROR', 'x'));
	gates.slaPolicies[0].reject(new ApiError(503, 'LIMITER_UNAVAILABLE', 'x'));
	await flush();
	assert.equal(currentSessionExpiry(idle, catalogs.get()), null, '403/500/503 no cierran sesión');
	assert.equal(catalogs.get().categories.status, 'error');
	assert.equal(catalogs.get().memberships.status, 'error');
	assert.equal(catalogs.get().slaPolicies.status, 'error');

	// a 401 answered for a PREVIOUS identity never reaches the state of the new one
	catalogs.setIdentity(identity(PICKER, ORG_B, 2), all);
	gates.sites[0].reject(new ApiError(401, 'UNAUTHORIZED', 'x'));
	await flush();
	assert.equal(currentSessionExpiry(idle, catalogs.get()), null, '401 obsoleto ignorado');
	assert.notEqual(catalogs.get().sites.status, 'error');

	// the same 401 for the CURRENT identity is a session expiry
	gates.sites[1].reject(new ApiError(401, 'UNAUTHORIZED', 'x'));
	await flush();
	assert.equal(currentSessionExpiry(idle, catalogs.get())?.status, 401);
	assert.equal(SESSION_EXPIRED_PATH, '/login?expired=true');
	catalogs.dispose();
});

test('#4 I/J. 401 del envío: vigente -> login; obsoleto -> nada', async () => {
	const gates = [];
	const creator = createIncidentCreateController({
		submit: () => {
			const d = deferred();
			gates.push(d);
			return d.promise;
		}
	});
	const noCatalogs = createIncidentCreateCatalogs({
		sites: async () => [],
		categories: async () => [],
		memberships: async () => [],
		slaPolicies: async () => []
	}).get();
	creator.setIdentity(identity(PICKER, ORG_A, 1));
	const stale = creator.submit({ title: 'T', description: 'D', client: 'C', priority: 'low' });
	creator.setIdentity(identity(PICKER, ORG_B, 2));
	gates[0].reject(new ApiError(401, 'UNAUTHORIZED', 'x'));
	assert.equal((await stale).status, 'stale');
	assert.equal(currentSessionExpiry(creator.get(), noCatalogs), null, 'J: sin navegación');
	const current = creator.submit({ title: 'T', description: 'D', client: 'C', priority: 'low' });
	gates[1].reject(new ApiError(401, 'UNAUTHORIZED', 'x'));
	await current;
	assert.equal(currentSessionExpiry(creator.get(), noCatalogs)?.status, 401, 'I: login');
});

// ------------------------------------------------------------------------------------------------
// MEDIUM #4 — navigation and draft guard (real helpers used by the page)
// ------------------------------------------------------------------------------------------------

function guardFor({ dirty = false, settled = false, answer = true } = {}) {
	const asked = [];
	const state = { dirty, settled };
	const guard = createDraftLeaveGuard({
		isDirty: () => state.dirty,
		isSettled: () => state.settled,
		confirm: (message) => (asked.push(message), answer),
		currentUrl: () => new URL(`http://localhost/app/incidents/new?organizationId=${ORG_A}`)
	});
	const leave = (to = incidentListPath(ORG_A), type = 'link') => {
		let cancelled = false;
		guard.onBeforeNavigate({
			to: { url: new URL(`http://localhost${to}`) },
			type,
			cancel: () => (cancelled = true)
		});
		return cancelled;
	};
	return { guard, asked, state, leave };
}

test('#4 A. formulario limpio: salir no pide confirmación', () => {
	const { asked, leave } = guardFor();
	assert.equal(leave(), false);
	assert.deepEqual(asked, []);
});

test('#4 B/C. borrador modificado: pide confirmación y, si se rechaza, se cancela', () => {
	const { asked, leave } = guardFor({ dirty: true, answer: false });
	assert.equal(leave(), true);
	assert.deepEqual(asked, [DISCARD_DRAFT_PROMPT]);
	// tab close / reload: cancelled so the browser shows its own prompt (no confirm())
	const tab = guardFor({ dirty: true, answer: false });
	assert.equal(tab.leave(incidentListPath(ORG_A), 'leave'), true);
	assert.deepEqual(tab.asked, []);
});

test('#4 D. borrador modificado y el usuario confirma: la navegación continúa', () => {
	const { asked, leave } = guardFor({ dirty: true, answer: true });
	assert.equal(leave(), false);
	assert.equal(asked.length, 1);
});

test('#4 guarda: no actúa al entrar, en la misma página ni tras un éxito o decisión previa', () => {
	const same = guardFor({ dirty: true, answer: false });
	assert.equal(same.leave(newIncidentPath(ORG_A)), false, 'misma página/organización');
	const settled = guardFor({ dirty: true, settled: true, answer: false });
	assert.equal(settled.leave(), false, 'creación confirmada: nada que perder');
	const decided = guardFor({ dirty: true, answer: false });
	decided.guard.allowNextNavigation();
	assert.equal(
		decided.leave(incidentDetailPath(ORG_A, INCIDENT)),
		false,
		'éxito / 401 / confirmado'
	);
	assert.equal(decided.leave(), true, 'solo la siguiente navegación');
});

test('#4 E. cambio de organización rechazado: el selector vuelve a la organización actual', () => {
	const dirty = guardFor({ dirty: true, answer: false });
	const choose = () => dirty.guard.confirmDiscard() || false;
	assert.equal(applyOrganizationChoice(choose, ORG_B, ORG_A), ORG_A);
	const clean = guardFor();
	assert.equal(
		applyOrganizationChoice(() => clean.guard.confirmDiscard(), ORG_B, ORG_A),
		null
	);
	assert.equal(
		applyOrganizationChoice(() => undefined, ORG_B, ORG_A),
		null,
		'páginas sin veto'
	);
});

test('#4 F/G/H. destinos exactos: Cancelar, éxito legible y éxito sin lectura', () => {
	assert.equal(incidentListPath(ORG_A), `/app/incidents?organizationId=${ORG_A}`);
	assert.equal(
		incidentDetailPath(ORG_A, INCIDENT),
		`/app/incidents/${INCIDENT}?organizationId=${ORG_A}`
	);
	assert.equal(newIncidentPath(ORG_B), `/app/incidents/new?organizationId=${ORG_B}`);
	const owner = identity(PICKER);
	const incident = { audience: 'staff', id: INCIDENT, organizationId: ORG_A, incidentNumber: 3 };
	const readable = planCreationFollowUp(
		{ status: 'success', value: { incident, readability: 'readable' } },
		owner,
		owner
	);
	assert.equal(
		incidentDetailPath(readable.organizationId, readable.incidentId),
		`/app/incidents/${INCIDENT}?organizationId=${ORG_A}`
	);
	const hidden = planCreationFollowUp(
		{ status: 'success', value: { incident, readability: 'not-readable' } },
		owner,
		owner
	);
	assert.deepEqual(hidden, { kind: 'show-created' }, 'H: ningún destino de detalle');
});

// ------------------------------------------------------------------------------------------------
// The REAL page: its registered beforeNavigate handler, the "Yo" selector and the shell
// ------------------------------------------------------------------------------------------------

test('página real (SSR): registra la guarda y renderiza el selector y el logout fallido', async (t) => {
	const server = await createServer({
		root,
		configFile: false,
		envDir: false,
		logLevel: 'silent',
		resolve: { alias: { $lib: path.resolve(root, 'src/lib') } },
		plugins: [
			{
				name: 'sf-nav-doubles',
				enforce: 'pre',
				resolveId(id) {
					if (['$app/paths', '$app/state', '$app/navigation', '$lib/app/context'].includes(id))
						return `\0${id}`;
					if (/[\\/]src[\\/]lib[\\/]app[\\/]context(\.ts)?$/.test(id)) return '\0$lib/app/context';
				},
				load(id) {
					if (id === '\0$app/paths') return 'export const resolve = (p) => p;';
					if (id === '\0$app/state')
						return 'export const page = { get url() { return globalThis.__sfUrl; } };';
					if (id === '\0$app/navigation')
						return `export const goto = async (url) => { (globalThis.__sfGotos ??= []).push(url); };
export const beforeNavigate = (fn) => { (globalThis.__sfBefore ??= []).push(fn); };`;
					if (id === '\0$lib/app/context')
						return `export function useOrganizationContext() {
	return { subscribe(run) { run(globalThis.__sfContext); return () => {}; }, get: () => globalThis.__sfContext, load: async () => {} };
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
	const Topbar = (await server.ssrLoadModule('/src/lib/components/shell/Topbar.svelte')).default;
	const clean = (html) => html.replace(/<!--.*?-->/g, '');

	globalThis.__sfBefore = [];
	globalThis.__sfGotos = [];
	globalThis.__sfContext = contextState(PICKER);
	globalThis.__sfUrl = new URL(`http://localhost/app/incidents/new?organizationId=${ORG_A}`);
	const html = clean(render(Page, { props: {} }).body);
	assert.match(html, /<label[^>]*>\s*Solicitante/);
	assert.match(html, /<option value="self"[^>]*selected[^>]*>Yo \(Ana Pérez\)/);
	assert.doesNotMatch(html, new RegExp(`>[^<]*${USER}[^<]*<`), 'el UUID nunca es texto visible');

	// the page registered exactly one beforeNavigate handler: its draft guard
	assert.equal(globalThis.__sfBefore.length, 1);
	const pageGuard = globalThis.__sfBefore[0];
	let cancelled = false;
	pageGuard({
		to: { url: new URL(`http://localhost${incidentListPath(ORG_A)}`) },
		type: 'link',
		cancel: () => (cancelled = true)
	});
	assert.equal(cancelled, false, 'borrador vacío: salir sin preguntar');
	assert.deepEqual(globalThis.__sfGotos, [], 'renderizar la página no navega');

	const menu = clean(
		render(Topbar, {
			props: {
				title: 'X',
				userName: 'Ana',
				navOpen: false,
				navId: 'n',
				signOutError: SIGN_OUT_FAILED_MESSAGE,
				onToggleNav: () => {},
				onSignOut: () => {}
			}
		}).body
	);
	assert.match(menu, /role="alert"[^>]*>No se pudo cerrar la sesión/);
	assert.match(menu, /Cerrar sesión/, 'reintento manual disponible');
});

test('#2 las tres páginas del shell usan el resultado real del logout', async () => {
	const fs = await import('node:fs');
	for (const file of [
		'src/routes/app/+page.svelte',
		'src/routes/app/incidents/+page.svelte',
		'src/routes/app/incidents/new/+page.svelte'
	]) {
		const source = fs.readFileSync(path.join(root, file), 'utf8');
		assert.match(source, /attemptSignOut\(/, file);
		assert.doesNotMatch(source, /leave anyway/, `${file}: ya no se ignora el fallo`);
	}
});

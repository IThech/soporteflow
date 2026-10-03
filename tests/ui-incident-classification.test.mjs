import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import {
	fixture,
	createCredentialUser,
	createSession,
	grantPermission
} from './helpers/auth-fixture.mjs';
import { isApiError } from '../src/lib/api/errors.ts';
import {
	buildCreateIncidentPayload,
	submitIncidentCreation
} from '../src/lib/api/incident-create.ts';
import { getIncidentDetail } from '../src/lib/api/incident-detail.ts';
import { listIncidentHistory, updateIncidentCategory } from '../src/lib/api/incidents.ts';
import { getCategoryTree } from '../src/lib/api/subcategories.ts';
import {
	classificationChanged,
	classificationChoices,
	reconcileSubcategory,
	subcategoryChoices,
	subcategoryHint,
	toClassification
} from '../src/lib/app/classification.ts';
import { createIncidentCreateCatalogs } from '../src/lib/app/incident-create-catalogs.ts';
import {
	createFormSections,
	emptyCreateDraft,
	presentCreateError,
	toCreateRequest
} from '../src/lib/app/incident-create-form.ts';
import { tenantIdentityOf } from '../src/lib/app/tenant-identity.ts';

/*
 * Category -> OPTIONAL subcategory in the normal incident flow (creation form and classification
 * change of an existing incident). Observable behaviour at three levels:
 *   A. choices / reconciliation / request the form produces (pure models the UI uses);
 *   B. the real creation form, rendered;
 *   C. the real frontend API clients against the real SvelteKit handlers (PGlite): what is
 *      persisted, and that another organization's (or another category's) subcategory is never
 *      accepted, whatever a manipulated client sends.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG = randomUUID();
const T = '2026-10-02T10:00:00.000Z';
const node = (name, active = true, subcategories) => ({
	id: randomUUID(),
	name,
	active,
	createdAt: T,
	updatedAt: T,
	description: null,
	...(subcategories ? { subcategories } : {})
});

// Redes { VPN, Wi-Fi, Antigua (inactiva) }, Hardware { }, Archivada (inactiva) { Vieja }
const vpn = node('VPN');
const wifi = node('Wi-Fi');
const old = node('Antigua', false);
const redes = node('Redes', true, [wifi, vpn, old]);
const hardware = node('Hardware', true, []);
const legacySub = node('Vieja');
const archived = node('Archivada', false, [legacySub]);
const TREE = [redes, hardware, archived];

// ------------------------------------------------------------------------------------------------
// A. Choices, reconciliation and the request the form sends
// ------------------------------------------------------------------------------------------------

test('A1. cada categoría ofrece solo SUS subcategorías activas, por nombre', () => {
	const choices = classificationChoices(TREE);
	assert.deepEqual(
		choices.map((c) => c.label),
		['Hardware', 'Redes'],
		'categorías inactivas fuera'
	);
	assert.deepEqual(
		subcategoryChoices(choices, redes.id).map((s) => s.label),
		['VPN', 'Wi-Fi'],
		'solo las de Redes, activas y ordenadas'
	);
	assert.deepEqual(subcategoryChoices(choices, hardware.id), [], 'categoría sin subcategorías');
	assert.deepEqual(subcategoryChoices(choices, ''), [], 'sin categoría no hay subcategorías');
	for (const sub of subcategoryChoices(choices, redes.id))
		assert.ok([vpn.id, wifi.id].includes(sub.value), 'nunca una subcategoría de otra categoría');
});

test('A2. el valor actual inactivo se conserva (marcado) para no perderlo en silencio', () => {
	const choices = classificationChoices(TREE, {
		categoryId: archived.id,
		subcategoryId: legacySub.id
	});
	assert.ok(choices.some((c) => c.value === archived.id && c.label === 'Archivada (inactiva)'));
	assert.deepEqual(
		subcategoryChoices(choices, archived.id).map((s) => s.label),
		['Vieja']
	);
	const keepOldSub = classificationChoices(TREE, { categoryId: redes.id, subcategoryId: old.id });
	assert.ok(subcategoryChoices(keepOldSub, redes.id).some((s) => s.label === 'Antigua (inactiva)'));
});

test('A3. cambiar de categoría limpia la subcategoría incompatible (A→A la conserva)', () => {
	const choices = classificationChoices(TREE);
	assert.equal(reconcileSubcategory(choices, redes.id, vpn.id), vpn.id, 'A → A conserva');
	assert.equal(reconcileSubcategory(choices, hardware.id, vpn.id), '', 'A → B limpia');
	assert.equal(reconcileSubcategory(choices, '', vpn.id), '', 'categoría → ninguna limpia');
	assert.equal(reconcileSubcategory(choices, redes.id, legacySub.id), '', 'ajena a Redes');
});

test('A9. secuencias del formulario y del modal (casos D–H): estado, cambio y payload', () => {
	const choices = classificationChoices(TREE);
	// What both components do on a category change: keep the subcategory only if it belongs.
	const pickCategory = (state, categoryId) => ({
		categoryId,
		subcategoryId: reconcileSubcategory(choices, categoryId, state.subcategoryId)
	});
	const send = (state) => toClassification(state.categoryId, state.subcategoryId);
	const sections = createFormSections(['incidents:create', 'categories:view']);
	const createPayload = (state) => {
		const { categoryId, subcategoryId } = toCreateRequest(
			{ ...emptyCreateDraft(), ...state },
			sections
		);
		return { categoryId, subcategoryId };
	};

	// D. creación: Redes -> VPN y, antes de guardar, Hardware: no queda ningún UUID oculto
	let draft = pickCategory({ categoryId: '', subcategoryId: '' }, redes.id);
	draft = { ...draft, subcategoryId: vpn.id };
	assert.deepEqual(createPayload(draft), { categoryId: redes.id, subcategoryId: vpn.id });
	draft = pickCategory(draft, hardware.id);
	assert.deepEqual(draft, { categoryId: hardware.id, subcategoryId: '' }, 'estado interno');
	assert.deepEqual(createPayload(draft), { categoryId: hardware.id, subcategoryId: null });
	// ... y sin categoría la subcategoría no se envía
	draft = pickCategory({ categoryId: redes.id, subcategoryId: vpn.id }, '');
	assert.deepEqual(createPayload(draft), { categoryId: undefined, subcategoryId: undefined });

	// Modal sobre una incidencia Redes / VPN: se abre con ambas preseleccionadas, sin cambios
	const current = { categoryId: redes.id, subcategoryId: vpn.id };
	const opened = { categoryId: current.categoryId, subcategoryId: current.subcategoryId };
	assert.equal(classificationChanged(current, send(opened)), false, 'abrir no es un cambio');

	// E. solo la subcategoría: Redes / Wi-Fi
	const e = { ...opened, subcategoryId: wifi.id };
	assert.equal(classificationChanged(current, send(e)), true);
	assert.deepEqual(send(e), { categoryId: redes.id, subcategoryId: wifi.id });

	// F. quitar la subcategoría: Redes / Sin subcategoría -> null explícito
	const f = { ...opened, subcategoryId: '' };
	assert.equal(classificationChanged(current, send(f)), true);
	assert.deepEqual(send(f), { categoryId: redes.id, subcategoryId: null });

	// G. otra categoría: Hardware limpia VPN
	const g = pickCategory(opened, hardware.id);
	assert.deepEqual(send(g), { categoryId: hardware.id, subcategoryId: null });

	// H. después, de Hardware a Redes / Wi-Fi
	const fromHardware = { categoryId: hardware.id, subcategoryId: null };
	const h = pickCategory({ categoryId: hardware.id, subcategoryId: '' }, redes.id);
	assert.equal(h.subcategoryId, '');
	h.subcategoryId = wifi.id;
	assert.equal(classificationChanged(fromHardware, send(h)), true);
	assert.deepEqual(send(h), { categoryId: redes.id, subcategoryId: wifi.id });

	// volver a la misma categoría conserva la subcategoría elegida (A -> A)
	assert.deepEqual(pickCategory(e, redes.id), e);
});

test('A4. el selector explica por qué está deshabilitado (no solo con color)', () => {
	const choices = classificationChoices(TREE);
	assert.equal(subcategoryHint('', []), 'Elige primero una categoría.');
	assert.equal(
		subcategoryHint(hardware.id, subcategoryChoices(choices, hardware.id)),
		'Esta categoría no tiene subcategorías.'
	);
	assert.match(subcategoryHint(redes.id, subcategoryChoices(choices, redes.id)), /Opcional/);
});

test('A5. creación: categoryId + subcategoryId (UUID o null) solo con categoría', () => {
	const sections = createFormSections(['incidents:create', 'categories:view']);
	const base = { ...emptyCreateDraft(), title: 'T', description: 'D', client: 'Acme' };
	const body = (draft) => buildCreateIncidentPayload(ORG, toCreateRequest(draft, sections));

	const none = body(base);
	assert.equal('categoryId' in none, false, 'sin categoría: nada');
	assert.equal('subcategoryId' in none, false);
	// a stale subcategory without category is never sent
	assert.equal('subcategoryId' in body({ ...base, subcategoryId: vpn.id }), false);

	const onlyCategory = body({ ...base, categoryId: hardware.id });
	assert.equal(onlyCategory.categoryId, hardware.id);
	assert.equal(onlyCategory.subcategoryId, null, '"Sin subcategoría" es null explícito');

	const both = body({ ...base, categoryId: redes.id, subcategoryId: vpn.id });
	assert.deepEqual([both.categoryId, both.subcategoryId], [redes.id, vpn.id]);

	// without categories:view the classification is never sent at all
	const noView = toCreateRequest(
		{ ...base, categoryId: redes.id, subcategoryId: vpn.id },
		createFormSections(['incidents:create'])
	);
	assert.equal('categoryId' in noView || 'subcategoryId' in noView, false);
});

test('A6. contrato del cliente: subcategoría sin categoría o mal formada se rechaza sin enviar', async () => {
	assert.throws(
		() =>
			buildCreateIncidentPayload(ORG, {
				title: 'T',
				description: 'D',
				client: 'Acme',
				priority: 'low',
				subcategoryId: vpn.id
			}),
		(error) => error.field === 'subcategoryId'
	);
	assert.throws(
		() =>
			buildCreateIncidentPayload(ORG, {
				title: 'T',
				description: 'D',
				client: 'Acme',
				priority: 'low',
				categoryId: redes.id,
				subcategoryId: 'no-uuid'
			}),
		(error) => error.field === 'subcategoryId'
	);
	let calls = 0;
	const spy = async () => (calls++, new Response('{}'));
	for (const input of [
		{ categoryId: null, subcategoryId: vpn.id },
		{ categoryId: redes.id, subcategoryId: 'no-uuid' }
	])
		await assert.rejects(
			updateIncidentCategory(ORG, randomUUID(), input, { customFetch: spy }),
			(error) => error.code === 'INVALID_INPUT'
		);
	assert.equal(calls, 0, 'nada llega al servidor');
});

test('A7. errores del servidor de subcategoría se muestran junto a su campo', () => {
	const view = presentCreateError(
		Object.assign(new Error('x'), {
			name: 'ApiError',
			status: 404,
			code: 'SUBCATEGORY_NOT_FOUND',
			kind: 'not-found'
		})
	);
	assert.equal(view.field?.name, 'subcategoryId');
});

test('A8. catálogo de creación: el árbol (una petición) trae las subcategorías de cada categoría', async () => {
	let requests = 0;
	const catalogs = createIncidentCreateCatalogs({
		clients: async () => [],
		sites: async () => [],
		categories: async () => (requests++, TREE),
		slaPolicies: async () => []
	});
	const identity = tenantIdentityOf({
		status: 'ready',
		user: { id: randomUUID() },
		activeOrganizationId: ORG,
		generation: 1,
		capabilities: ['categories:view']
	});
	catalogs.setIdentity(identity, ['categories']);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const options = catalogs.get().categories.options;
	assert.equal(requests, 1);
	assert.deepEqual(
		subcategoryChoices(options, redes.id).map((s) => s.label),
		['VPN', 'Wi-Fi']
	);
	catalogs.dispose();
});

// ------------------------------------------------------------------------------------------------
// B. The real creation form (SSR)
// ------------------------------------------------------------------------------------------------

test('B. formulario real: Subcategoría dependiente de Categoría, accesible', async (t) => {
	const server = await createServer({
		root,
		configFile: false,
		envDir: false,
		logLevel: 'silent',
		resolve: { alias: { $lib: path.resolve(root, 'src/lib') } },
		plugins: [svelte({ configFile: false })],
		server: { middlewareMode: true, hmr: false, watch: null },
		appType: 'custom'
	});
	t.after(() => server.close());
	const { render } = await server.ssrLoadModule('svelte/server');
	const Form = (
		await server.ssrLoadModule('/src/lib/components/incidents/IncidentCreateForm.svelte')
	).default;
	const ready = (options) => ({ status: 'ready', options, error: null, errorMessage: null });
	const idle = { status: 'idle', options: [], error: null, errorMessage: null };
	const html = (draft) =>
		render(Form, {
			props: {
				draft: { ...emptyCreateDraft(), ...draft },
				errors: {},
				sections: createFormSections(['incidents:create', 'categories:view']),
				catalogs: {
					clients: idle,
					sites: idle,
					categories: ready(classificationChoices(TREE)),
					slaPolicies: idle
				},
				onsubmit: () => ({}),
				oncancel: () => {},
				onretrycatalog: () => {}
			}
		}).body.replace(/<!--.*?-->/g, '');
	const subSelect = (markup) => {
		const label = /<label class="sf-field-label[^"]*" for="([^"]+)">\s*Subcategoría/.exec(markup);
		assert.ok(label, 'label "Subcategoría" asociado (for)');
		const select = new RegExp(`<select[^>]*id="${label[1]}"[^>]*>([\\s\\S]*?)</select>`).exec(
			markup
		);
		assert.ok(select, 'el label apunta a su select');
		return {
			tag: select[0].slice(0, select[0].indexOf('>') + 1),
			options: [...select[1].matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1])
		};
	};

	await t.test('sin categoría: deshabilitada y explicada', () => {
		const markup = html({});
		const sub = subSelect(markup);
		assert.match(sub.tag, /disabled/);
		assert.deepEqual(sub.options, ['Sin subcategoría']);
		assert.match(markup, /Elige primero una categoría\./);
		assert.match(sub.tag, /aria-describedby="[^"]+-hint"/, 'el texto de ayuda está enlazado');
	});

	await t.test('Redes: habilitada con VPN y Wi-Fi, nada de otras categorías', () => {
		const sub = subSelect(html({ categoryId: redes.id }));
		assert.doesNotMatch(sub.tag, /disabled/);
		assert.deepEqual(sub.options, ['Sin subcategoría', 'VPN', 'Wi-Fi']);
	});

	await t.test('Hardware (sin subcategorías): deshabilitada y explicada', () => {
		const markup = html({ categoryId: hardware.id });
		const sub = subSelect(markup);
		assert.match(sub.tag, /disabled/);
		assert.deepEqual(sub.options, ['Sin subcategoría']);
		assert.match(markup, /Esta categoría no tiene subcategorías\./);
	});
});

// ------------------------------------------------------------------------------------------------
// C. Real frontend clients <-> real handlers (PGlite): persistence and tenant isolation
// ------------------------------------------------------------------------------------------------

test('C. contrato UI ↔ backend: persistencia y aislamiento multi-tenant', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;
	const ORIGIN = 'http://localhost';
	const routes = [
		[/^\/api\/incidents$/, '/src/routes/api/incidents/+server.ts', []],
		[/^\/api\/incidents\/([^/]+)$/, '/src/routes/api/incidents/[id]/+server.ts', ['id']],
		[
			/^\/api\/incidents\/([^/]+)\/category$/,
			'/src/routes/api/incidents/[id]/category/+server.ts',
			['id']
		],
		[
			/^\/api\/incidents\/([^/]+)\/history$/,
			'/src/routes/api/incidents/[id]/history/+server.ts',
			['id']
		],
		[/^\/api\/categories$/, '/src/routes/api/categories/+server.ts', []],
		[/^\/api\/subcategories$/, '/src/routes/api/subcategories/+server.ts', []]
	];
	const fetchAs =
		(cookie) =>
		async (input, init = {}) => {
			const url = new URL(String(input), ORIGIN);
			const [, file, names] = routes.find(([re]) => re.test(url.pathname));
			const match = url.pathname.match(routes.find(([re]) => re.test(url.pathname))[0]);
			const params = Object.fromEntries(names.map((n, i) => [n, match[i + 1]]));
			const method = init.method ?? 'GET';
			const headers = new Headers(init.headers);
			headers.set('origin', ORIGIN);
			headers.set('cookie', cookie);
			const handler = (await server.ssrLoadModule(file))[method];
			return handler({
				url,
				params,
				request: new Request(url, { method, headers, body: init.body }),
				route: { id: file }
			});
		};
	const [orgA, orgB] = await db
		.insert(s.organizations)
		.values([
			{ name: 'Org A', slug: 'class-a-' + randomUUID(), status: 'active' },
			{ name: 'Org B', slug: 'class-b-' + randomUUID(), status: 'active' }
		])
		.returning();
	const PERMS = [
		'incidents:create',
		'incidents:view_all',
		'incidents:edit',
		'categories:view',
		'categories:manage'
	];
	async function actor(org) {
		const user = await createCredentialUser(f, { email: `cls-${randomUUID()}@example.test` });
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
		for (const permissionId of PERMS)
			await grantPermission(f, {
				organizationId: org.id,
				membershipId: membership.id,
				permissionId
			});
		const session = await createSession(f, user.id, {
			expiresAt: new Date(Date.now() + 3600000)
		});
		return fetchAs(session.cookieHeader);
	}
	const fetchA = await actor(orgA);
	const fetchB = await actor(orgB);
	async function post(fetchFn, org, pathname, body) {
		const res = await fetchFn(`${pathname}?organizationId=${org.id}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		assert.equal(res.status, 201, `${pathname} ${await res.clone().text()}`);
		return res.json();
	}
	const cat = async (fetchFn, org, name) =>
		(await post(fetchFn, org, '/api/categories', { name })).category;
	const sub = async (fetchFn, org, categoryId, name) =>
		(await post(fetchFn, org, '/api/subcategories', { categoryId, name })).subcategory;

	const aRedes = await cat(fetchA, orgA, 'Redes');
	const aVpn = await sub(fetchA, orgA, aRedes.id, 'VPN');
	const aWifi = await sub(fetchA, orgA, aRedes.id, 'Wi-Fi');
	const aHardware = await cat(fetchA, orgA, 'Hardware');
	const aSoftware = await cat(fetchA, orgA, 'Software');
	const aOffice = await sub(fetchA, orgA, aSoftware.id, 'Office');
	const bRedes = await cat(fetchB, orgB, 'Redes B');
	const bVpn = await sub(fetchB, orgB, bRedes.id, 'VPN B');

	const create = (classification) =>
		submitIncidentCreation(
			orgA.id,
			{ title: 'LAB', description: 'D', client: 'Acme', priority: 'low', ...classification },
			{ customFetch: fetchA }
		);
	const read = async (id) => {
		const detail = await getIncidentDetail(orgA.id, id, { customFetch: fetchA });
		return [detail.categoryId, detail.subcategoryId];
	};
	const count = async () => (await db.select().from(s.incidents)).length;

	await t.test(
		'el árbol de la organización activa no contiene nada de otra organización',
		async () => {
			const tree = await getCategoryTree({ organizationId: orgA.id, customFetch: fetchA });
			const ids = classificationChoices(tree).flatMap((c) => [
				c.value,
				...c.subcategories.map((x) => x.value)
			]);
			assert.ok(ids.includes(aVpn.id));
			assert.equal(ids.includes(bRedes.id) || ids.includes(bVpn.id), false);
			assert.deepEqual(
				subcategoryChoices(classificationChoices(tree), aRedes.id).map((x) => x.label),
				['VPN', 'Wi-Fi']
			);
		}
	);

	await t.test('crear: sin categoría · Hardware · Redes→VPN · Redes→Wi-Fi', async () => {
		const sections = createFormSections(['incidents:create', 'categories:view']);
		const draft = (categoryId = '', subcategoryId = '') =>
			toCreateRequest({ ...emptyCreateDraft(), categoryId, subcategoryId }, sections);
		const strip = ({ categoryId, subcategoryId }) => ({
			...(categoryId !== undefined ? { categoryId } : {}),
			...(subcategoryId !== undefined ? { subcategoryId } : {})
		});
		for (const [label, request, expected] of [
			['sin categoría', draft(), [null, null]],
			['Hardware', draft(aHardware.id), [aHardware.id, null]],
			['Redes → VPN', draft(aRedes.id, aVpn.id), [aRedes.id, aVpn.id]],
			['Redes → Wi-Fi', draft(aRedes.id, aWifi.id), [aRedes.id, aWifi.id]]
		]) {
			const created = await create(strip(request));
			assert.deepEqual(await read(created.id), expected, label);
		}
	});

	await t.test(
		'crear manipulado: subcategoría de otra organización u otra categoría → nunca',
		async () => {
			const before = await count();
			for (const [label, subcategoryId] of [
				['otra organización', bVpn.id],
				['otra categoría', aOffice.id]
			]) {
				const error = await create({ categoryId: aRedes.id, subcategoryId }).catch((e) => e);
				assert.ok(isApiError(error), label);
				assert.equal(error.code, 'SUBCATEGORY_NOT_FOUND', label);
				assert.equal(presentCreateError(error).field?.name, 'subcategoryId', label);
			}
			assert.equal(await count(), before, 'no se creó nada');
		}
	);

	await t.test(
		'cambiar: VPN→Wi-Fi conserva Redes; →Hardware limpia; →ninguna; ajena rechazada',
		async () => {
			const incident = await create({ categoryId: aRedes.id, subcategoryId: aVpn.id });
			const change = (input) =>
				updateIncidentCategory(orgA.id, incident.id, input, { customFetch: fetchA });

			await change({ categoryId: aRedes.id, subcategoryId: aWifi.id, reason: 'Es Wi-Fi' });
			assert.deepEqual(await read(incident.id), [aRedes.id, aWifi.id], 'A → A cambia solo la sub');

			for (const [label, subcategoryId] of [
				['otra organización', bVpn.id],
				['otra categoría', aOffice.id]
			]) {
				const error = await change({ categoryId: aRedes.id, subcategoryId, reason: 'x' }).catch(
					(e) => e
				);
				assert.equal(error.code, 'SUBCATEGORY_NOT_FOUND', label);
				assert.deepEqual(await read(incident.id), [aRedes.id, aWifi.id], `${label}: sin cambios`);
			}

			// what the modal sends after picking Hardware (its subcategory was cleared)
			const choices = classificationChoices(
				await getCategoryTree({ organizationId: orgA.id, customFetch: fetchA })
			);
			const cleared = reconcileSubcategory(choices, aHardware.id, aWifi.id);
			assert.equal(cleared, '');
			await change({
				categoryId: aHardware.id,
				subcategoryId: cleared || null,
				reason: 'Hardware'
			});
			assert.deepEqual(await read(incident.id), [aHardware.id, null], 'A → B: subcategoría null');

			await change({ categoryId: null, subcategoryId: null, reason: 'Sin clasificar' });
			assert.deepEqual(await read(incident.id), [null, null], 'categoría → ninguna');
		}
	);

	await t.test('cambiar: Redes/VPN → Redes/sin subcategoría; Hardware → Redes/Wi-Fi', async () => {
		const incident = await create({ categoryId: aRedes.id, subcategoryId: aVpn.id });
		const change = (input) =>
			updateIncidentCategory(orgA.id, incident.id, input, { customFetch: fetchA });

		const updated = await change({ categoryId: aRedes.id, subcategoryId: null, reason: 'Sin sub' });
		assert.deepEqual([updated.categoryId, updated.subcategoryId], [aRedes.id, null], 'respuesta');
		assert.deepEqual(await read(incident.id), [aRedes.id, null], 'F: persistido');

		await change({ categoryId: aHardware.id, subcategoryId: null, reason: 'Hardware' });
		await change({ categoryId: aRedes.id, subcategoryId: aWifi.id, reason: 'Wi-Fi' });
		assert.deepEqual(await read(incident.id), [aRedes.id, aWifi.id], 'H: persistido');
	});

	await t.test(
		'historial: un cambio solo de subcategoría queda en category_changed (auditoría completa)',
		async () => {
			const incident = await create({ categoryId: aRedes.id, subcategoryId: aVpn.id });
			await updateIncidentCategory(
				orgA.id,
				incident.id,
				{ categoryId: aRedes.id, subcategoryId: aWifi.id, reason: 'Es Wi-Fi' },
				{ customFetch: fetchA }
			);
			// stored audit row: the existing event, with both subcategory ids and the reason
			const rows = (await db.select().from(s.incidentHistory)).filter(
				(row) => row.incidentId === incident.id && row.eventType === 'category_changed'
			);
			assert.equal(rows.length, 1);
			assert.equal(rows[0].reason, 'Es Wi-Fi');
			assert.deepEqual(
				{ ...rows[0].payload },
				{
					fromCategoryId: aRedes.id,
					toCategoryId: aRedes.id,
					fromSubcategoryId: aVpn.id,
					toSubcategoryId: aWifi.id
				}
			);
			// public history: the existing signal only, never ids
			const page = await listIncidentHistory({
				organizationId: orgA.id,
				incidentId: incident.id,
				customFetch: fetchA
			});
			const event = page.items.find((item) => item.type === 'category_changed');
			assert.deepEqual(event?.changes, { categoryChanged: true });
			const json = JSON.stringify(page);
			for (const id of [aVpn.id, aWifi.id, aRedes.id]) assert.equal(json.includes(id), false);
		}
	);

	await t.test('otra organización no puede reclasificar la incidencia', async () => {
		const incident = await create({ categoryId: aRedes.id, subcategoryId: aVpn.id });
		// B, in its own organization: the incident does not exist there
		const own = await updateIncidentCategory(
			orgB.id,
			incident.id,
			{ categoryId: bRedes.id, subcategoryId: bVpn.id, reason: 'x' },
			{ customFetch: fetchB }
		).catch((e) => e);
		assert.equal(own.status, 404);
		// B, naming A's organization: not a member there -> refused
		const foreign = await updateIncidentCategory(
			orgA.id,
			incident.id,
			{ categoryId: aRedes.id, subcategoryId: aWifi.id, reason: 'x' },
			{ customFetch: fetchB }
		).catch((e) => e);
		assert.equal(foreign.status, 403);
		assert.deepEqual(await read(incident.id), [aRedes.id, aVpn.id], 'sin cambios');
	});
});

test('D. detalle: «Clasificar» solo para staff con incidents:edit, categorías legibles y no cerrada', async (t) => {
	const { incidentActions } = await import('../src/lib/app/incident-actions.ts');
	const server = await createServer({
		root,
		configFile: false,
		envDir: false,
		logLevel: 'silent',
		resolve: { alias: { $lib: path.resolve(root, 'src/lib') } },
		plugins: [svelte({ configFile: false })],
		server: { middlewareMode: true, hmr: false, watch: null },
		appType: 'custom'
	});
	t.after(() => server.close());
	const { render } = await server.ssrLoadModule('svelte/server');
	const Toolbar = (
		await server.ssrLoadModule('/src/lib/components/incidents/IncidentActionToolbar.svelte')
	).default;
	const noop = () => {};
	const html = ({
		audience = 'staff',
		status = 'open',
		caps = ['incidents:edit'],
		open = noop
	}) => {
		const incident = { audience, status, priority: 'low', assignedToUserId: null, teamId: null };
		return render(Toolbar, {
			props: {
				incident,
				available: incidentActions(incident, caps),
				onStatusChange: noop,
				onPriorityChange: noop,
				onOpenAssign: noop,
				// null = the page does not pass it (no categories:view)
				onOpenClassification: open ?? undefined,
				onRequestClose: noop,
				onRequestReopen: noop
			}
		}).body;
	};
	assert.match(html({}), />\s*Clasificar\s*</, 'staff + incidents:edit + categorías legibles');
	assert.doesNotMatch(html({ open: null }), /Clasificar/, 'sin categories:view no se ofrece');
	assert.doesNotMatch(html({ caps: [] }), /Clasificar/, 'sin incidents:edit');
	assert.doesNotMatch(html({ status: 'closed' }), /Clasificar/, 'cerrada: solo lectura');
	assert.doesNotMatch(html({ audience: 'requester' }), /Clasificar/, 'el solicitante nunca');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
	fixture,
	createCredentialUser,
	createSession,
	grantPermission
} from './helpers/auth-fixture.mjs';
import {
	SLA_TARGET_MAX_MINUTES,
	createSlaPolicy,
	listSlaPolicies,
	updateSlaPolicy
} from '../src/lib/api/sla-policies.ts';
import {
	draftFromPolicy,
	emptySlaPolicyDraft,
	formatSlaDuration,
	slaPolicyErrorField,
	splitDuration,
	toCreateSlaPolicy,
	toMinutes,
	toSlaPolicyPatch,
	validateSlaPolicyDraft
} from '../src/lib/app/sla-policy-form.ts';

/*
 * SLA-1A — Administración → Políticas SLA. Observable behaviour at three levels:
 *   A. the form model the page uses (human durations, validation, payloads);
 *   B. the real frontend API client against the real SvelteKit handlers (PGlite): RBAC
 *      (sla:view reads, sla:manage writes), tenant isolation, default switch and deactivation
 *      handled by the backend, immutable code;
 *   C. the page and the admin card (wiring the UI depends on).
 */

const T = '2026-10-03T10:00:00.000Z';
const policy = (overrides = {}) => ({
	id: randomUUID(),
	code: 'soporte_estandar',
	name: 'Soporte estándar',
	description: null,
	active: true,
	isDefault: false,
	firstResponseMinutes: 240,
	resolutionMinutes: 1440,
	createdAt: T,
	updatedAt: T,
	...overrides
});
const draft = (overrides = {}) => ({
	...emptySlaPolicyDraft(),
	code: 'soporte_estandar',
	name: 'Soporte estándar',
	firstResponseValue: '4',
	firstResponseUnit: 'hours',
	resolutionValue: '1',
	resolutionUnit: 'days',
	...overrides
});

// ------------------------------------------------------------------------------------------------
// A. Form model
// ------------------------------------------------------------------------------------------------

test('A1. duraciones legibles y deterministas (nunca "90 minutos")', () => {
	for (const [minutes, text] of [
		[15, '15 min'],
		[60, '1 h'],
		[90, '1 h 30 min'],
		[240, '4 h'],
		[1440, '1 d'],
		[1500, '1 d 1 h'],
		[1441, '1 d 1 min'],
		[4320, '3 d'],
		[SLA_TARGET_MAX_MINUTES, '3650 d']
	])
		assert.equal(formatSlaDuration(minutes), text, `${minutes}`);
	for (const invalid of [0, -5, 1.5, Number.NaN]) assert.equal(formatSlaDuration(invalid), '—');
});

test('A2. valor + unidad -> minutos exactos; editar nunca pierde precisión', () => {
	assert.deepEqual(toMinutes('15', 'minutes'), { ok: true, minutes: 15 });
	assert.deepEqual(toMinutes('4', 'hours'), { ok: true, minutes: 240 });
	assert.deepEqual(toMinutes(' 3 ', 'days'), { ok: true, minutes: 4320 });
	for (const minutes of [1, 15, 59, 60, 90, 240, 1440, 1500, 4320, SLA_TARGET_MAX_MINUTES]) {
		const { value, unit } = splitDuration(minutes);
		assert.deepEqual(toMinutes(value, unit), { ok: true, minutes }, `${minutes} ida y vuelta`);
	}
	assert.deepEqual(splitDuration(90), { value: '90', unit: 'minutes' });
	assert.deepEqual(splitDuration(240), { value: '4', unit: 'hours' });
	assert.deepEqual(splitDuration(2880), { value: '2', unit: 'days' });
});

test('A3. solo enteros positivos dentro del límite del backend', () => {
	for (const value of ['', ' ', '0', '-1', '4.5', '4,5', '1e3', '4h', '0x10', 'Infinity'])
		assert.equal(toMinutes(value, 'hours').ok, false, `"${value}"`);
	assert.equal(toMinutes('3650', 'days').ok, true);
	assert.equal(toMinutes('3651', 'days').ok, false, 'por encima de 5.256.000 min');
	assert.equal(toMinutes(String(SLA_TARGET_MAX_MINUTES + 1), 'minutes').ok, false);
	assert.equal(toMinutes('4', 'weeks').ok, false, 'unidad desconocida');
});

test('A4. validación: obligatorios, código, longitudes y resolución >= respuesta', () => {
	const errors = (d, mode = 'create') => {
		const result = validateSlaPolicyDraft(d, mode);
		return result.ok ? {} : result.errors;
	};
	assert.deepEqual(errors(draft()), {});
	assert.ok(errors(draft({ name: '   ' })).name);
	assert.ok(errors(draft({ name: 'x'.repeat(101) })).name);
	for (const code of [
		'',
		'ab',
		'Soporte',
		'1soporte',
		'soporte-estandar',
		'soporte__x',
		'x'.repeat(51)
	])
		assert.ok(errors(draft({ code })).code, `código "${code}"`);
	assert.deepEqual(errors(draft({ code: '' }), 'edit'), {}, 'en edición el código no se valida');
	assert.ok(errors(draft({ description: 'x'.repeat(1001) })).description);
	assert.ok(errors(draft({ firstResponseValue: '' })).firstResponse);
	assert.match(
		errors(draft({ firstResponseValue: '2', firstResponseUnit: 'days' })).resolution,
		/no puede ser menor/
	);
	assert.deepEqual(errors(draft({ resolutionValue: '4', resolutionUnit: 'hours' })), {}, 'iguales');
});

test('A5. creación: payload del contrato real (siempre activa, sin `active`)', () => {
	const checked = validateSlaPolicyDraft(
		draft({ description: '  ', isDefault: true, active: false }),
		'create'
	);
	assert.ok(checked.ok);
	assert.deepEqual(toCreateSlaPolicy(checked.value), {
		code: 'soporte_estandar',
		name: 'Soporte estándar',
		description: null,
		firstResponseMinutes: 240,
		resolutionMinutes: 1440,
		isDefault: true
	});
});

test('A6. edición: precarga, PATCH solo con cambios, nunca el código', () => {
	const original = policy({ isDefault: true, description: 'Horario general' });
	const loaded = draftFromPolicy(original);
	assert.deepEqual(
		[
			loaded.firstResponseValue,
			loaded.firstResponseUnit,
			loaded.resolutionValue,
			loaded.resolutionUnit
		],
		['4', 'hours', '1', 'days']
	);
	const unchanged = validateSlaPolicyDraft(loaded, 'edit');
	assert.ok(unchanged.ok);
	assert.deepEqual(toSlaPolicyPatch(original, unchanged.value), {}, 'sin cambios: nada que enviar');

	const edited = validateSlaPolicyDraft(
		{ ...loaded, code: 'otro_codigo', name: 'Soporte 8x5', resolutionValue: '2' },
		'edit'
	);
	assert.ok(edited.ok);
	assert.deepEqual(toSlaPolicyPatch(original, edited.value), {
		name: 'Soporte 8x5',
		resolutionMinutes: 2880
	});

	// deactivating the default also drops the default flag (a default is always active)
	const deactivated = validateSlaPolicyDraft({ ...loaded, active: false }, 'edit');
	assert.ok(deactivated.ok);
	assert.deepEqual(toSlaPolicyPatch(original, deactivated.value), {
		active: false,
		isDefault: false
	});
	// clearing the description sends an explicit null
	const cleared = validateSlaPolicyDraft({ ...loaded, description: '' }, 'edit');
	assert.ok(cleared.ok);
	assert.deepEqual(toSlaPolicyPatch(original, cleared.value), { description: null });
});

test('A7. errores del servidor que pertenecen a un campo', () => {
	assert.equal(slaPolicyErrorField('SLA_POLICY_CODE_CONFLICT'), 'code');
	assert.equal(slaPolicyErrorField('SLA_POLICY_INVALID_TARGET'), 'resolution');
	assert.equal(slaPolicyErrorField('SLA_POLICY_INVALID_DEFAULT'), null);
	assert.equal(slaPolicyErrorField('FORBIDDEN'), null);
});

// ------------------------------------------------------------------------------------------------
// B. Real frontend client <-> real handlers (PGlite)
// ------------------------------------------------------------------------------------------------

test('B. cliente real ↔ API real: RBAC, tenant, por defecto y desactivación', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;
	const ORIGIN = 'http://localhost';
	const routes = [
		[/^\/api\/sla-policies$/, '/src/routes/api/sla-policies/+server.ts', []],
		[/^\/api\/sla-policies\/([^/]+)$/, '/src/routes/api/sla-policies/[id]/+server.ts', ['id']]
	];
	const fetchAs =
		(cookie) =>
		async (input, init = {}) => {
			const url = new URL(String(input), ORIGIN);
			const [re, file, names] = routes.find(([pattern]) => pattern.test(url.pathname));
			const match = url.pathname.match(re);
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
			{ name: 'Org A', slug: 'sla-a-' + randomUUID(), status: 'active' },
			{ name: 'Org B', slug: 'sla-b-' + randomUUID(), status: 'active' }
		])
		.returning();
	async function actor(org, permissions) {
		const user = await createCredentialUser(f, { email: `sla-${randomUUID()}@example.test` });
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
		for (const permissionId of permissions)
			await grantPermission(f, {
				organizationId: org.id,
				membershipId: membership.id,
				permissionId
			});
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return fetchAs(session.cookieHeader);
	}
	const manager = await actor(orgA, ['sla:view', 'sla:manage']);
	const viewer = await actor(orgA, ['sla:view']);
	const outsider = await actor(orgB, ['sla:view', 'sla:manage']);

	const list = (fetchFn = manager, org = orgA) =>
		listSlaPolicies({ organizationId: org.id, customFetch: fetchFn });
	const create = (d, fetchFn = manager) => {
		const checked = validateSlaPolicyDraft(draft(d), 'create');
		assert.ok(checked.ok, JSON.stringify(checked));
		return createSlaPolicy({
			organizationId: orgA.id,
			policy: toCreateSlaPolicy(checked.value),
			customFetch: fetchFn
		});
	};
	const edit = (original, changes, fetchFn = manager) => {
		const checked = validateSlaPolicyDraft({ ...draftFromPolicy(original), ...changes }, 'edit');
		assert.ok(checked.ok, JSON.stringify(checked));
		return updateSlaPolicy({
			organizationId: orgA.id,
			policyId: original.id,
			patch: toSlaPolicyPatch(original, checked.value),
			customFetch: fetchFn
		});
	};

	await t.test('organización sin políticas: listado vacío (empty state)', async () => {
		assert.deepEqual(await list(), []);
		assert.deepEqual(await list(viewer), []);
	});

	let standard;
	let critical;
	await t.test('crear: minutos exactos, siempre activa, por defecto opcional', async () => {
		standard = await create({});
		assert.equal(standard.firstResponseMinutes, 240);
		assert.equal(standard.resolutionMinutes, 1440);
		assert.equal(standard.active, true);
		assert.equal(standard.isDefault, false, 'sin política por defecto: es opcional');
		critical = await create({
			code: 'critica',
			name: 'Crítica',
			firstResponseValue: '15',
			firstResponseUnit: 'minutes',
			resolutionValue: '4',
			resolutionUnit: 'hours',
			isDefault: true
		});
		assert.equal(critical.isDefault, true);
		assert.equal((await list()).filter((p) => p.isDefault).length, 1);
	});

	await t.test('código duplicado: 409 que la UI muestra junto al campo Código', async () => {
		const error = await create({ name: 'Otra' }).catch((e) => e);
		assert.equal(error.status, 409);
		assert.equal(error.code, 'SLA_POLICY_CODE_CONFLICT');
		assert.equal(slaPolicyErrorField(error.code), 'code');
	});

	await t.test('cambiar la por defecto: el backend desmarca la anterior (una sola)', async () => {
		await edit(standard, { isDefault: true });
		const after = await list();
		assert.deepEqual(
			after.filter((p) => p.isDefault).map((p) => p.code),
			['soporte_estandar']
		);
		// the page re-reads the list: the previous default is no longer marked
		assert.equal(after.find((p) => p.id === critical.id).isDefault, false);
	});

	await t.test(
		'desactivar la por defecto: queda inactiva y la organización sin defecto',
		async () => {
			const current = (await list()).find((p) => p.id === standard.id);
			await updateSlaPolicy({
				organizationId: orgA.id,
				policyId: current.id,
				patch: { active: false },
				customFetch: manager
			});
			const after = (await list()).find((p) => p.id === standard.id);
			assert.deepEqual([after.active, after.isDefault], [false, false]);
			assert.equal(
				(await list()).some((p) => p.isDefault),
				false,
				'ninguna por defecto (D11)'
			);
			// reactivate (the table's Activar button)
			await updateSlaPolicy({
				organizationId: orgA.id,
				policyId: current.id,
				patch: { active: true },
				customFetch: manager
			});
			assert.equal((await list()).find((p) => p.id === standard.id).active, true);
		}
	);

	await t.test('una política inactiva no puede ser la por defecto (409)', async () => {
		const inactive = await updateSlaPolicy({
			organizationId: orgA.id,
			policyId: critical.id,
			patch: { active: false },
			customFetch: manager
		});
		const error = await updateSlaPolicy({
			organizationId: orgA.id,
			policyId: inactive.id,
			patch: { isDefault: true },
			customFetch: manager
		}).catch((e) => e);
		assert.equal(error.status, 409);
		assert.equal(error.code, 'SLA_POLICY_INVALID_DEFAULT');
	});

	await t.test('editar: objetivos y nombre; el código no cambia nunca', async () => {
		const current = (await list()).find((p) => p.id === standard.id);
		const updated = await edit(current, {
			code: 'intento_de_cambio',
			name: 'Estándar 8x5',
			firstResponseValue: '90',
			firstResponseUnit: 'minutes'
		});
		assert.equal(updated.code, 'soporte_estandar');
		assert.equal(updated.name, 'Estándar 8x5');
		assert.equal(updated.firstResponseMinutes, 90);
		// even a manipulated client cannot PATCH the code (the client allowlist refuses it)
		const error = await updateSlaPolicy({
			organizationId: orgA.id,
			policyId: current.id,
			patch: { code: 'otro' },
			customFetch: manager
		}).catch((e) => e);
		assert.equal(error.code, 'INVALID_INPUT');
	});

	await t.test('sla:view sin sla:manage: lee pero no puede mutar (403 del servidor)', async () => {
		assert.ok((await list(viewer)).length >= 2);
		const createError = await create({ code: 'del_lector', name: 'Lector' }, viewer).catch(
			(e) => e
		);
		assert.equal(createError.status, 403);
		const current = (await list()).find((p) => p.id === standard.id);
		const updateError = await updateSlaPolicy({
			organizationId: orgA.id,
			policyId: current.id,
			patch: { active: false },
			customFetch: viewer
		}).catch((e) => e);
		assert.equal(updateError.status, 403);
		assert.equal((await list()).find((p) => p.id === standard.id).active, true, 'sin cambios');
	});

	await t.test('otra organización: no ve, no edita ni infiere las políticas de A', async () => {
		assert.deepEqual(await list(outsider, orgB), [], 'B solo ve lo suyo');
		const foreignList = await list(outsider, orgA).catch((e) => e);
		assert.equal(foreignList.status, 403, 'pedir el listado de A: sin permiso en A');
		const viaOwnOrg = await updateSlaPolicy({
			organizationId: orgB.id,
			policyId: standard.id,
			patch: { name: 'Robada' },
			customFetch: outsider
		}).catch((e) => e);
		assert.equal(viaOwnOrg.status, 404, 'indistinguible de una política inexistente');
		assert.equal(viaOwnOrg.code, 'SLA_POLICY_NOT_FOUND');
		assert.notEqual((await list()).find((p) => p.id === standard.id).name, 'Robada');
	});
});

// ------------------------------------------------------------------------------------------------
// C. Page and admin card
// ------------------------------------------------------------------------------------------------

const read = (rel) => fs.readFileSync(path.resolve(rel), 'utf8');

test('C1. tarjeta Políticas SLA activa y enlazada a /app/admin/sla-policies', () => {
	const admin = read('src/routes/app/admin/+page.svelte');
	assert.match(admin, /const slaPoliciesHref = \$derived\(/);
	assert.match(admin, /resolve\('\/app\/admin\/sla-policies'\)/);
	const card = admin.slice(admin.indexOf("title: 'Políticas SLA'"));
	const body = card.slice(0, card.indexOf('}'));
	assert.match(body, /active: true/);
	assert.match(body, /href: slaPoliciesHref/);
	// opened with sla:view (the page guard); the label tells a reader it is read-only
	assert.match(body, /module: 'slaPolicies'/);
	assert.match(
		body,
		/actionLabel: capabilities\.includes\('sla:manage'\)\s*\?\s*'Gestionar políticas SLA'\s*:\s*'Ver políticas SLA'/
	);
	assert.equal(admin.match(/title: 'Políticas SLA'/g).length, 1, 'sin tarjetas duplicadas');
	assert.ok(fs.existsSync('src/routes/app/admin/sla-policies/+page.svelte'));
});

test('C2. página: permisos reales, contrato real y accesibilidad', () => {
	const source = read('src/routes/app/admin/sla-policies/+page.svelte');
	assert.match(source, /const canView = \$derived\(capabilities\.includes\('sla:view'\)\);/);
	assert.match(
		source,
		/const canManage = \$derived\(canView && capabilities\.includes\('sla:manage'\)\);/
	);
	// mutations only through the existing API client; no delete anywhere
	assert.match(source, /from '\$lib\/api\/sla-policies'/);
	assert.doesNotMatch(source, /fetch\(|DELETE|deleteSlaPolicy/);
	// the code is only an input when creating; editing shows it read-only
	const editBranch = source.slice(source.indexOf("{#if dialogMode === 'create'}"));
	const readOnly = editBranch.slice(editBranch.indexOf('{:else}'), editBranch.indexOf('{/if}'));
	assert.match(readOnly, /El código no se puede modificar\./);
	assert.doesNotMatch(readOnly, /<Input/);
	// "Activa" only when editing (a new policy is always active); default disabled when inactive
	assert.match(source, /\{#if dialogMode === 'edit'\}\s*<label class="sf-check">/);
	assert.match(source, /disabled=\{formSubmitting \|\| !draft\.active\}/);
	// after a mutation the list is re-read from the server (default switch changes other rows)
	assert.equal(source.match(/await loadPolicies\(orgId, true\);/g)?.length, 2);
	// duration groups: fieldset + legend, with their own hint
	assert.equal(source.match(/<fieldset class="sf-duration"/g)?.length, 1, 'un snippet reutilizado');
	assert.match(source, /<legend class="sf-duration-legend">/);
	assert.match(source, /<title>Políticas SLA · SoporteFlow<\/title>/);
	assert.match(source, /No hay políticas SLA configuradas/);
	assert.match(source, /<span>Crear política<\/span>/);
});

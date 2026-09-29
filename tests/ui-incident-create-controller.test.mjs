import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../src/lib/api/errors.ts';
import {
	createIncidentCreateController,
	createdIncidentReadability
} from '../src/lib/app/incident-create-controller.ts';
import { createTenantCatalogCache, catalogKey } from '../src/lib/app/tenant-catalog.ts';
import { isStaleRequest } from '../src/lib/app/request-scope.ts';
import { bindToTenant, tenantIdentityOf, valueFor } from '../src/lib/app/tenant-identity.ts';

/** UI-2A — creation outcome modelling and tenant-bound catalogs (real controllers/caches). */
const USER_A = randomUUID();
const USER_B = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();

function identity(userId, organizationId, generation, capabilities) {
	return tenantIdentityOf({
		status: 'ready',
		user: { id: userId, name: 'U', email: 'u@example.test' },
		organizations: [],
		activeOrganizationId: organizationId,
		activeOrganization: null,
		capabilities,
		rejectedOrganizationId: null,
		error: null,
		contextKey: `${userId}:${organizationId}`,
		generation
	});
}
const created = (audience, clientUserId) => ({
	audience,
	id: randomUUID(),
	organizationId: ORG_A,
	clientUserId,
	status: 'open'
});
const INPUT = { title: 'T', description: 'D', client: 'C', priority: 'low' };
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

test('E. create no presupone lectura posterior', () => {
	const onlyCreate = identity(USER_A, ORG_A, 1, ['incidents:create']);
	assert.equal(
		createdIncidentReadability(created('requester', USER_A), onlyCreate),
		'not-readable',
		'sin ningún alcance de lectura'
	);
	const ownOnly = identity(USER_A, ORG_A, 1, ['incidents:create', 'incidents:view_own']);
	assert.equal(
		createdIncidentReadability(created('requester', USER_A), ownOnly),
		'not-readable',
		'view_own no cubre una incidencia nueva sin asignar'
	);
	const requester = identity(USER_A, ORG_A, 1, ['incidents:create', 'incidents:view_requested']);
	assert.equal(createdIncidentReadability(created('requester', USER_A), requester), 'readable');
	assert.equal(
		createdIncidentReadability(created('requester', USER_B), requester),
		'not-readable',
		'solicitante distinto'
	);
	const all = identity(USER_A, ORG_A, 1, ['incidents:create', 'incidents:view_all']);
	assert.equal(createdIncidentReadability(created('staff', USER_B), all), 'readable');
});

test('E. resultado confirmado, incierto y obsoleto; nunca reintento automático', async () => {
	let sends = 0;
	const gates = [];
	const c = createIncidentCreateController({
		submit: () => {
			sends++;
			const d = deferred();
			gates.push(d);
			return d.promise;
		}
	});
	const onlyCreate = identity(USER_A, ORG_A, 1, ['incidents:create']);
	c.setIdentity(onlyCreate);

	const ok = c.submit(INPUT);
	assert.equal(c.get().status, 'submitting');
	assert.equal((await c.submit(INPUT)).status, 'busy', 'doble envío bloqueado');
	gates[0].resolve(created('requester', USER_A));
	const okResult = await ok;
	assert.equal(okResult.status, 'success');
	assert.equal(c.get().status, 'created');
	assert.equal(c.get().created.readability, 'not-readable');

	c.reset();
	const lost = c.submit(INPUT);
	gates[1].reject(new ApiError(0, 'NETWORK_ERROR', 'x'));
	assert.equal((await lost).status, 'unknown');
	assert.equal(c.get().status, 'unknown');
	assert.equal(sends, 2, 'la respuesta perdida no se reenvía');

	c.reset();
	const stale = c.submit(INPUT);
	c.setIdentity(identity(USER_A, ORG_B, 2, ['incidents:create']));
	gates[2].resolve(created('requester', USER_A));
	assert.equal((await stale).status, 'stale');
	assert.equal(c.get().status, 'idle', 'el éxito de A no aparece en B');
	assert.equal(c.get().created, null);
});

test('E. un borrador nunca pasa silenciosamente a otra organización o usuario', () => {
	const a1 = identity(USER_A, ORG_A, 1, []);
	const draft = bindToTenant(a1, { title: 'borrador' });
	assert.deepEqual(valueFor(draft, a1), { title: 'borrador' });
	assert.equal(valueFor(draft, identity(USER_A, ORG_B, 2, [])), null);
	assert.equal(valueFor(draft, identity(USER_B, ORG_A, 1, [])), null);
	assert.equal(valueFor(draft, identity(USER_A, ORG_A, 3, [])), null, 'A -> B -> A tampoco');
});

test('F. catálogos: la clave de A nunca satisface B; usuarios no comparten', async () => {
	const a = identity(USER_A, ORG_A, 1, []);
	assert.notEqual(catalogKey(a, 'sites'), catalogKey(identity(USER_A, ORG_B, 1, []), 'sites'));
	assert.notEqual(catalogKey(a, 'sites'), catalogKey(identity(USER_B, ORG_A, 1, []), 'sites'));
	assert.notEqual(catalogKey(a, 'sites'), catalogKey(identity(USER_A, ORG_A, 2, []), 'sites'));
	assert.notEqual(catalogKey(a, 'assignees', { teamId: 'x' }), catalogKey(a, 'assignees'));
	assert.equal(
		catalogKey(a, 'sites', { activeOnly: true, x: undefined }),
		catalogKey(a, 'sites', { activeOnly: true })
	);

	const cache = createTenantCatalogCache();
	const loads = [];
	const loader = (value) => async (organizationId) => (loads.push(organizationId), value);
	cache.setIdentity(a);
	assert.deepEqual(await cache.load('sites', {}, loader(['sede A'])), ['sede A']);
	assert.deepEqual(await cache.load('sites', {}, loader(['otra'])), ['sede A'], 'cacheado');
	cache.setIdentity(identity(USER_A, ORG_B, 2, []));
	assert.equal(cache.peek('sites'), undefined, 'nada de A visible en B');
	assert.deepEqual(await cache.load('sites', {}, loader(['sede B'])), ['sede B']);
	cache.setIdentity(identity(USER_B, ORG_B, 3, []));
	assert.equal(cache.peek('sites'), undefined, 'otro usuario, otra caché');
	assert.deepEqual(loads, [ORG_A, ORG_B]);
});

test('F. catálogos: error no es lista vacía; deduplicación; respuesta tardía obsoleta', async () => {
	const cache = createTenantCatalogCache();
	cache.setIdentity(identity(USER_A, ORG_A, 1, []));
	await assert.rejects(
		cache.load('teams', {}, async () => {
			throw new ApiError(422, 'RESULT_LIMIT_EXCEEDED', 'x');
		}),
		(error) => error.status === 422
	);
	assert.equal(cache.peek('teams'), undefined, 'el fallo no se guarda como []');

	let calls = 0;
	const gate = deferred();
	const shared = () => (calls++, gate.promise);
	const first = cache.load('categories', {}, shared);
	const second = cache.load('categories', {}, shared);
	gate.resolve(['cat']);
	assert.deepEqual(await Promise.all([first, second]), [['cat'], ['cat']]);
	assert.equal(calls, 1, 'peticiones idénticas simultáneas deduplicadas');

	const late = deferred();
	let signal;
	const pending = cache.load(
		'slaPolicies',
		{},
		(organizationId, s) => ((signal = s), late.promise)
	);
	cache.setIdentity(identity(USER_A, ORG_B, 2, []));
	assert.equal(signal.aborted, true);
	late.resolve(['política de A']);
	await assert.rejects(pending, (error) => isStaleRequest(error));
	assert.equal(cache.peek('slaPolicies'), undefined);
});

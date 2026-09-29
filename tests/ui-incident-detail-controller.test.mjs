import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../src/lib/api/errors.ts';
import {
	createIncidentDetailController,
	unauthenticatedError
} from '../src/lib/app/incident-detail-controller.ts';
import { createRequestChannels } from '../src/lib/app/request-channels.ts';
import { tenantIdentityOf, tenantKey } from '../src/lib/app/tenant-identity.ts';

/**
 * UI-2A — the real detail controller: identity isolation (user/org/generation/incident),
 * independent channels, pessimistic mutations and stale 401 protection. Fetchers are injected
 * deferreds so every interleaving is explicit.
 */
const USER_A = randomUUID();
const USER_B = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const INC_1 = randomUUID();
const INC_2 = randomUUID();

function identity(userId, organizationId, generation, capabilities = ['incidents:view_all']) {
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
const detailOf = (organizationId, incidentId, extra = {}) => ({
	audience: 'requester',
	id: incidentId,
	organizationId,
	title: `detalle ${organizationId.slice(0, 4)}`,
	status: 'open',
	...extra
});

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}
/** fetchDetail that answers each call from a queue of deferreds; records signals. */
function scriptedFetch() {
	const calls = [];
	const fetchDetail = (organizationId, incidentId, { signal }) => {
		const d = deferred();
		calls.push({ organizationId, incidentId, signal, ...d });
		return d.promise;
	};
	return { calls, fetchDetail };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const err = (status, code) => new ApiError(status, code, 'x');

test('B. respuesta de la organización A no modifica B', async () => {
	const f = scriptedFetch();
	const c = createIncidentDetailController({ fetchDetail: f.fetchDetail });
	c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_1 });
	const loadA = c.load();
	c.setTarget({ identity: identity(USER_A, ORG_B, 2), incidentId: INC_2 });
	assert.equal(c.get().detail, null, 'datos del tenant anterior retirados al instante');
	assert.equal(f.calls[0].signal.aborted, true, 'la lectura de A se aborta');
	const loadB = c.load();
	f.calls[0].resolve(detailOf(ORG_A, INC_1));
	await loadA;
	assert.equal(c.get().detail, null, 'la respuesta tardía de A no se aplica en B');
	assert.equal(c.get().organizationId, ORG_B);
	f.calls[1].resolve(detailOf(ORG_B, INC_2));
	await loadB;
	assert.equal(c.get().detail.organizationId, ORG_B);
	assert.equal(c.get().status, 'ready');
});

test('B. A -> B -> A no resucita el resultado antiguo (la generación cambia)', async () => {
	const f = scriptedFetch();
	const c = createIncidentDetailController({ fetchDetail: f.fetchDetail });
	c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_1 });
	const first = c.load();
	c.setTarget({ identity: identity(USER_A, ORG_B, 2), incidentId: INC_2 });
	c.setTarget({ identity: identity(USER_A, ORG_A, 3), incidentId: INC_1 });
	assert.notEqual(
		tenantKey(identity(USER_A, ORG_A, 1)),
		tenantKey(identity(USER_A, ORG_A, 3)),
		'misma org y usuario, otra activación'
	);
	f.calls[0].resolve(detailOf(ORG_A, INC_1, { title: 'antiguo' }));
	await first;
	assert.equal(c.get().detail, null);
	assert.equal(c.get().status, 'idle');
});

test('B. cambio de usuario o de incidencia invalida el resultado', async () => {
	for (const next of [
		{ identity: identity(USER_B, ORG_A, 1), incidentId: INC_1 },
		{ identity: identity(USER_A, ORG_A, 1), incidentId: INC_2 }
	]) {
		const f = scriptedFetch();
		const c = createIncidentDetailController({ fetchDetail: f.fetchDetail });
		c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_1 });
		const pending = c.load();
		c.setTarget(next);
		f.calls[0].resolve(detailOf(ORG_A, INC_1));
		await pending;
		assert.equal(c.get().detail, null);
		assert.equal(c.get().incidentId, next.incidentId);
	}
});

test('B. un 401 antiguo no llega al estado actual; uno actual sí', async () => {
	const f = scriptedFetch();
	const c = createIncidentDetailController({ fetchDetail: f.fetchDetail });
	c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_1 });
	const stale = c.load();
	c.setTarget({ identity: identity(USER_B, ORG_B, 2), incidentId: INC_2 });
	const current = c.load();
	f.calls[0].reject(err(401, 'UNAUTHORIZED'));
	await stale;
	assert.equal(unauthenticatedError(c.get()), null, 'la sesión de B no se toca');
	assert.equal(c.get().error, null);
	f.calls[1].reject(err(401, 'UNAUTHORIZED'));
	await current;
	assert.equal(unauthenticatedError(c.get())?.status, 401);
});

test('C. canales independientes: detalle, comentarios, historial y catálogo coexisten', async () => {
	const f = scriptedFetch();
	const c = createIncidentDetailController({ fetchDetail: f.fetchDetail });
	c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_1 });
	const channelCalls = {};
	const loader = (name) => (organizationId, incidentId, signal) => {
		const d = deferred();
		(channelCalls[name] ??= []).push({ signal, ...d });
		return d.promise;
	};
	const detail = c.load();
	const comments = c.loadChannel('comments', loader('comments'));
	const history = c.loadChannel('history', loader('history'));
	const notes = c.loadChannel('internalNotes', loader('internalNotes'));
	for (const signal of [
		f.calls[0].signal,
		channelCalls.comments[0].signal,
		channelCalls.history[0].signal,
		channelCalls.internalNotes[0].signal
	])
		assert.equal(signal.aborted, false, 'ninguna petición cancela a otra');
	f.calls[0].resolve(detailOf(ORG_A, INC_1));
	channelCalls.comments[0].resolve(['c1']);
	channelCalls.history[0].resolve(['h1']);
	channelCalls.internalNotes[0].reject(err(503, 'LIMITER_UNAVAILABLE'));
	await Promise.all([detail, comments, history, notes]);
	const state = c.get();
	assert.equal(state.status, 'ready');
	assert.deepEqual(state.channels.comments.data, ['c1']);
	assert.deepEqual(state.channels.history.data, ['h1']);
	assert.equal(state.channels.internalNotes.status, 'error');
	assert.equal(state.channels.internalNotes.data, null, 'un fallo no es una lista vacía');

	// the SAME channel: a new request supersedes the previous one
	const older = c.loadChannel('comments', loader('comments'));
	const newer = c.loadChannel('comments', loader('comments'));
	assert.equal(channelCalls.comments[1].signal.aborted, true);
	channelCalls.comments[2].resolve(['nuevo']);
	channelCalls.comments[1].resolve(['viejo']);
	await Promise.all([older, newer]);
	assert.deepEqual(c.get().channels.comments.data, ['nuevo']);

	// catalogs use the same primitive: a catalog channel does not cancel the detail channel
	const channels = createRequestChannels('k');
	const detailTicket = channels.channel('detail').begin();
	channels.channel('sites').begin();
	assert.equal(detailTicket.isCurrent(), true);
	channels.setContext('k2');
	assert.equal(detailTicket.isCurrent(), false, 'un cambio de contexto alcanza a todos');
});

test('C. cambio de organización retira los paneles internos al instante', async () => {
	const f = scriptedFetch();
	const c = createIncidentDetailController({ fetchDetail: f.fetchDetail });
	c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_1 });
	const notes = c.loadChannel('internalNotes', async () => ['nota interna A']);
	await notes;
	assert.deepEqual(c.get().channels.internalNotes.data, ['nota interna A']);
	c.setTarget({ identity: identity(USER_A, ORG_B, 2), incidentId: INC_1 });
	assert.deepEqual(c.get().channels, {}, 'nada del tenant anterior, ni con el mismo UUID');
});

test('Mutaciones: pesimistas, sin reintento, con relectura y acceso perdido', async (t) => {
	await t.test('éxito -> relee el detalle (no confía en la respuesta de la mutación)', async () => {
		const f = scriptedFetch();
		const c = createIncidentDetailController({ fetchDetail: f.fetchDetail });
		c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_1 });
		let sends = 0;
		const done = c.mutate('status', async () => (sends++, { ok: true }));
		await flush();
		assert.equal(f.calls.length, 1, 'relectura tras confirmar');
		f.calls[0].resolve(detailOf(ORG_A, INC_1, { status: 'pending' }));
		const result = await done;
		assert.equal(result.status, 'success');
		assert.equal(sends, 1);
		assert.equal(c.get().detail.status, 'pending');
	});

	await t.test('tras reasignar, 404 en la relectura -> access-lost (sin datos)', async () => {
		const f = scriptedFetch();
		const c = createIncidentDetailController({ fetchDetail: f.fetchDetail });
		c.setTarget({
			identity: identity(USER_A, ORG_A, 1, ['incidents:view_own']),
			incidentId: INC_1
		});
		const first = c.load();
		f.calls[0].resolve(detailOf(ORG_A, INC_1, { audience: 'staff' }));
		await first;
		const done = c.mutate('assign', async () => ({ ok: true }));
		await flush();
		f.calls[1].reject(err(404, 'INCIDENT_NOT_FOUND'));
		await done;
		assert.equal(c.get().status, 'access-lost');
		assert.equal(c.get().detail, null);
	});

	await t.test('respuesta perdida -> unknown, sin reintento automático', async () => {
		const f = scriptedFetch();
		const c = createIncidentDetailController({ fetchDetail: f.fetchDetail });
		c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_1 });
		let sends = 0;
		const done = c.mutate('priority', async () => {
			sends++;
			throw new ApiError(0, 'NETWORK_ERROR', 'x');
		});
		await flush();
		f.calls[0].resolve(detailOf(ORG_A, INC_1));
		const result = await done;
		assert.equal(result.status, 'unknown');
		assert.equal(sends, 1, 'nunca se repite');
		assert.equal(c.get().mutations.priority.status, 'unknown');
	});

	await t.test('error definitivo -> error; doble envío -> busy (no se envía)', async () => {
		const f = scriptedFetch();
		const c = createIncidentDetailController({ fetchDetail: f.fetchDetail });
		c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_1 });
		const gate = deferred();
		let sends = 0;
		const first = c.mutate('status', () => (sends++, gate.promise));
		assert.equal((await c.mutate('status', async () => sends++)).status, 'busy');
		gate.reject(err(409, 'INCIDENT_CLOSED'));
		assert.equal((await first).status, 'error');
		assert.equal(sends, 1);
		assert.equal(f.calls.length, 0, 'un error definitivo no relee');
	});

	await t.test('mutación antigua no aplica nada en el contexto nuevo (ni su 401)', async () => {
		const f = scriptedFetch();
		const c = createIncidentDetailController({ fetchDetail: f.fetchDetail });
		c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_1 });
		const gate = deferred();
		const pending = c.mutate('status', () => gate.promise);
		c.setTarget({ identity: identity(USER_A, ORG_B, 2), incidentId: INC_2 });
		gate.reject(err(401, 'UNAUTHORIZED'));
		assert.equal((await pending).status, 'stale');
		assert.deepEqual(c.get().mutations, {});
		assert.equal(unauthenticatedError(c.get()), null);
		assert.equal(f.calls.length, 0, 'no relee en el contexto nuevo');
		// the old pending mutation does not block the new context
		const fresh = c.mutate('status', async () => ({ ok: true }));
		await flush();
		f.calls[0].resolve(detailOf(ORG_B, INC_2));
		assert.equal((await fresh).status, 'success');
	});
});

// UI-2C M1/M2: use the real controller and hold reconciliation independently of the write.
const reconciliationSwitches = [
	['incident', (c) => c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_2 })],
	['tenant', (c) => c.setTarget({ identity: identity(USER_A, ORG_B, 2), incidentId: INC_1 })],
	['user', (c) => c.setTarget({ identity: identity(USER_B, ORG_A, 1), incidentId: INC_1 })],
	[
		'A-B-A with identical final key',
		(c) => {
			c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_2 });
			c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_1 });
		}
	],
	['dispose', (c) => c.dispose()]
];
for (const outcome of ['success', 'unknown']) {
	for (const [change, switchTarget] of reconciliationSwitches) {
		test(
			'M1: ' + outcome + ' becomes stale after ' + change + ' during reconciliation',
			async () => {
				const f = scriptedFetch();
				const c = createIncidentDetailController({ fetchDetail: f.fetchDetail });
				c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_1 });
				const write = deferred();
				const pending = c.mutate('edit', () => write.promise);
				if (outcome === 'success') write.resolve({ ok: true });
				else write.reject(err(0, 'NETWORK_ERROR'));
				await flush();
				assert.equal(f.calls.length, 1);
				assert.equal(c.get().mutations.edit.status, 'pending');
				switchTarget(c);
				assert.equal(f.calls[0].signal.aborted, true);
				const freshWrite = deferred();
				const fresh = change === 'dispose' ? null : c.mutate('edit', () => freshWrite.promise);
				const snapshot = c.get();
				// Neither a successful stale read nor a stale 401 may affect the new context.
				if (outcome === 'success') f.calls[0].resolve(detailOf(ORG_A, INC_1));
				else f.calls[0].reject(err(401, 'UNAUTHORIZED'));
				assert.equal((await pending).status, 'stale');
				assert.equal(c.get(), snapshot);
				assert.equal(unauthenticatedError(c.get()), null);
				if (fresh) {
					let accidentalSends = 0;
					assert.equal((await c.mutate('edit', async () => accidentalSends++)).status, 'busy');
					assert.equal(accidentalSends, 0, 'old cleanup must not unlock the fresh operation');
					freshWrite.reject(err(409, 'CONFLICT'));
					assert.equal((await fresh).status, 'error');
				}
				c.dispose();
			}
		);
	}
	test('M2: ' + outcome + ' stays pending through write and reconciliation', async () => {
		const f = scriptedFetch();
		const c = createIncidentDetailController({ fetchDetail: f.fetchDetail });
		c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_1 });
		const initial = c.load();
		f.calls[0].resolve(detailOf(ORG_A, INC_1));
		await initial;
		let sends = 0;
		const write = deferred();
		const done = c.mutate('assign', () => (sends++, write.promise));
		assert.equal((await c.mutate('assign', async () => sends++)).status, 'busy');
		if (outcome === 'success') write.resolve({ ok: true });
		else write.reject(err(0, 'NETWORK_ERROR'));
		await flush();
		assert.equal(c.get().status, 'refreshing');
		assert.equal(c.get().mutations.assign.status, 'pending');
		c.clearMutation('assign');
		assert.equal(c.get().mutations.assign.status, 'pending', 'cannot hide a busy lifecycle');
		assert.equal((await c.mutate('assign', async () => sends++)).status, 'busy');
		assert.equal(sends, 1);
		f.calls[1].resolve(detailOf(ORG_A, INC_1, { title: 'reconciled' }));
		assert.equal((await done).status, outcome);
		assert.equal(c.get().mutations.assign.status, outcome);
		assert.equal(c.get().detail.title, 'reconciled');
		const next = await c.mutate('assign', async () => {
			sends++;
			throw err(409, 'CONFLICT');
		});
		assert.equal(next.status, 'error', 'lock released after full reconciliation');
		assert.equal(sends, 2);
		c.dispose();
	});
}
for (const status of [401, 403, 404, 500]) {
	test('Reconciliation preserves current ' + status + ' and releases busy', async () => {
		const f = scriptedFetch();
		const c = createIncidentDetailController({ fetchDetail: f.fetchDetail });
		c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_1 });
		const initial = c.load();
		f.calls[0].resolve(detailOf(ORG_A, INC_1));
		await initial;
		const done = c.mutate('assign', async () => ({ ok: true }));
		await flush();
		assert.equal(c.get().mutations.assign.status, 'pending');
		f.calls[1].reject(err(status, 'SAFE_TEST_ERROR'));
		assert.equal((await done).status, 'success', 'write outcome remains confirmed');
		assert.equal(c.get().detail, null);
		assert.equal(c.get().status, status === 403 || status === 404 ? 'access-lost' : 'error');
		assert.equal(unauthenticatedError(c.get())?.status ?? null, status === 401 ? 401 : null);
		assert.equal(c.get().mutations.assign.status, 'success');
		c.dispose();
	});
}
test('Current write 401 is published without reconciliation', async () => {
	const f = scriptedFetch();
	const c = createIncidentDetailController({ fetchDetail: f.fetchDetail });
	c.setTarget({ identity: identity(USER_A, ORG_A, 1), incidentId: INC_1 });
	const result = await c.mutate('edit', async () => {
		throw err(401, 'UNAUTHORIZED');
	});
	assert.equal(result.status, 'error');
	assert.equal(unauthenticatedError(c.get())?.status, 401);
	assert.equal(f.calls.length, 0);
	c.dispose();
});

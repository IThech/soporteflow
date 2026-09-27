import test from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import {
	log,
	pausingDb,
	settle,
	waitForLockWait,
	withTimeout,
	SCENARIO_TIMEOUT_MS
} from './lab.mjs';
import { createLab } from './setup.mjs';

const MIN = 60_000;

test('5.4W-A #4-#8, #12: ejecuciones de automatización bajo concurrencia real', async (t) => {
	const lab = await createLab(t);
	const { monitor, fixtures: fx, schema: s, load } = lab;
	const { createAutomationRule, updateAutomationRule } = await load(
		'/src/lib/server/services/automation-rules.ts'
	);
	const { processAutomationExecutions } = await load(
		'/src/lib/server/services/automation-processor.ts'
	);
	const { fanoutAutomationExecutions } = await load(
		'/src/lib/server/services/automation-rule-fanout.ts'
	);

	// Lab-only hygiene: executions left non-terminal by an aborted earlier run would be claimed by
	// these global processors and distort per-scenario counts.
	await monitor.sql`DELETE FROM automation_executions WHERE status IN ('pending', 'processing')`;

	const noteRule = (name, sortOrder = 0) => ({
		name,
		eventType: 'incident.created',
		conditions: { all: [] },
		actions: [{ type: 'incident.add_internal_note', text: `Nota automática ${name}` }],
		sortOrder
	});
	async function setup(rules) {
		const o = await fx.organization('automation');
		const admin = await fx.member(o, [o.admin]);
		const created = [];
		for (const rule of rules)
			created.push(await createAutomationRule(monitor.db, o.id, admin.userId, rule));
		return { o, admin, rules: created };
	}
	const executionsOf = (o) =>
		monitor.db
			.select()
			.from(s.automationExecutions)
			.where(eq(s.automationExecutions.organizationId, o.id));
	const notesOf = async (incidentId) =>
		(
			await monitor.db
				.select()
				.from(s.incidentMessages)
				.where(
					and(
						eq(s.incidentMessages.incidentId, incidentId),
						eq(s.incidentMessages.visibility, 'internal')
					)
				)
		).length;

	await t.test(
		'#4 doble claim: SKIP LOCKED reparte; ninguna ejecución procesada dos veces',
		async () => {
			const { o, admin } = await setup([noteRule('claim')]);
			const incidents = [];
			for (let i = 0; i < 4; i++) incidents.push(await fx.incident(o, admin));
			assert.equal((await executionsOf(o)).length, 4);
			const A = await lab.session('auto-a');
			const B = await lab.session('auto-b');
			const paused = pausingDb(A.db, { call: 1, at: 'beforeCommit' });
			const runA = processAutomationExecutions(paused.db, { limit: 2 });
			await paused.reached.wait(); // A's claim tx holds FOR UPDATE on its 2 rows (uncommitted)
			const resultB = await withTimeout(
				processAutomationExecutions(B.db, { limit: 10 }),
				SCENARIO_TIMEOUT_MS,
				'B while A holds its claim'
			);
			log('#4', `B claimed ${resultB.claimed} while A held 2 locked rows`);
			assert.equal(resultB.claimed, 2, 'B no espera ni toma las filas bloqueadas por A');
			paused.release.notify();
			const resultA = await withTimeout(runA, SCENARIO_TIMEOUT_MS, 'A');
			assert.equal(resultA.claimed, 2);
			assert.equal(resultA.succeeded + resultB.succeeded, 4);
			const rows = await executionsOf(o);
			assert.ok(
				rows.every((r) => r.status === 'succeeded' && r.attemptCount === 1 && r.leaseToken === null)
			);
			for (const inc of incidents)
				assert.equal(await notesOf(inc.id), 1, 'un único efecto por ejecución');
		}
	);

	await t.test(
		'#5 worker obsoleto: A reclama, lease expira, B recupera y completa; A no escribe',
		async () => {
			const { o, admin } = await setup([noteRule('stale')]);
			const inc = await fx.incident(o, admin);
			const A = await lab.session('stale-a');
			const B = await lab.session('stale-b');
			const now = new Date();
			const paused = pausingDb(A.db, { call: 2, at: 'beforeStart' }); // claim committed, action tx not started
			const runA = processAutomationExecutions(paused.db, { now, limit: 1 });
			await paused.reached.wait();
			const [claimedByA] = await executionsOf(o);
			assert.equal(claimedByA.status, 'processing');
			const resultB = await withTimeout(
				processAutomationExecutions(B.db, { now: new Date(now.getTime() + 6 * MIN), limit: 10 }),
				SCENARIO_TIMEOUT_MS,
				'B reclaims'
			);
			assert.deepEqual([resultB.claimed, resultB.succeeded], [1, 1]);
			paused.release.notify();
			const resultA = await withTimeout(runA, SCENARIO_TIMEOUT_MS, 'A late');
			log(
				'#5',
				`A late: claimed=${resultA.claimed} succeeded=${resultA.succeeded} failed=${resultA.failed}`
			);
			assert.deepEqual([resultA.succeeded, resultA.failed, resultA.skipped], [0, 0, 0]);
			const [final] = await executionsOf(o);
			assert.equal(final.status, 'succeeded');
			assert.equal(final.attemptCount, 2);
			assert.notEqual(final.leaseToken, claimedByA.leaseToken);
			assert.equal(await notesOf(inc.id), 1, 'sin efecto duplicado');
		}
	);

	await t.test(
		'#6 lease expira DURANTE la tx de acciones: nadie puede reclamar hasta el commit',
		async () => {
			const { o, admin } = await setup([noteRule('slow')]);
			const inc = await fx.incident(o, admin);
			const A = await lab.session('slow-a');
			const B = await lab.session('slow-b');
			const now = new Date();
			const paused = pausingDb(A.db, { call: 2, at: 'beforeCommit' }); // actions done, not committed
			const runA = processAutomationExecutions(paused.db, { now, limit: 1 });
			await paused.reached.wait();
			const resultB = await withTimeout(
				processAutomationExecutions(B.db, { now: new Date(now.getTime() + 10 * MIN), limit: 10 }),
				SCENARIO_TIMEOUT_MS,
				'B during A action tx'
			);
			log('#6', `B with lease expired (clock +10 min) claimed ${resultB.claimed}`);
			assert.equal(
				resultB.claimed,
				0,
				'la fila está bloqueada por la tx de acciones de A (SKIP LOCKED)'
			);
			paused.release.notify();
			const resultA = await withTimeout(runA, SCENARIO_TIMEOUT_MS, 'A');
			assert.equal(resultA.succeeded, 1);
			const after = await processAutomationExecutions(B.db, {
				now: new Date(now.getTime() + 10 * MIN),
				limit: 10
			});
			assert.equal(after.claimed, 0, 'terminada: no se reclama');
			assert.equal(await notesOf(inc.id), 1);
		}
	);

	await t.test(
		'#7 dos ejecuciones sobre la misma incidencia: serializadas, cadena coherente',
		async () => {
			const priorityRule = (name, priority, sortOrder) => ({
				name,
				eventType: 'incident.created',
				conditions: { all: [] },
				actions: [{ type: 'incident.set_priority', priority }],
				sortOrder
			});
			const { o, admin } = await setup([
				priorityRule('to-high', 'high', 1),
				priorityRule('to-low', 'low', 2),
				noteRule('note-1', 3),
				noteRule('note-2', 4)
			]);
			const inc = await fx.incident(o, admin, { priority: 'medium' });
			const A = await lab.session('same-a');
			const B = await lab.session('same-b');
			const paused = pausingDb(A.db, { call: 2, at: 'beforeCommit' });
			const runA = processAutomationExecutions(paused.db, { limit: 1 }); // to-high
			await paused.reached.wait(); // A updated priority, holds the incident row lock
			const runB = processAutomationExecutions(B.db, { limit: 1 }); // to-low, must wait for A
			await waitForLockWait(monitor.sql, B.appName);
			paused.release.notify();
			await withTimeout(settle([runA, runB]), SCENARIO_TIMEOUT_MS, 'same incident');
			await processAutomationExecutions(A.db, { limit: 10 }); // the two note rules
			const [row] = await monitor.db.select().from(s.incidents).where(eq(s.incidents.id, inc.id));
			const history = await monitor.db
				.select()
				.from(s.incidentHistory)
				.where(
					and(
						eq(s.incidentHistory.incidentId, inc.id),
						eq(s.incidentHistory.eventType, 'priority_changed')
					)
				)
				.orderBy(s.incidentHistory.createdAt);
			const events = await monitor.db
				.select()
				.from(s.automationEvents)
				.where(
					and(
						eq(s.automationEvents.aggregateId, inc.id),
						eq(s.automationEvents.eventType, 'incident.priority_changed')
					)
				)
				.orderBy(s.automationEvents.position);
			log(
				'#7',
				`final priority=${row.priority}, history=${history.length}, events=${events.length}`
			);
			assert.equal(row.priority, 'low', 'last committed write wins (B after A)');
			assert.deepEqual(
				history.map((h) => [h.payload.oldPriority, h.payload.newPriority]),
				[
					['medium', 'high'],
					['high', 'low']
				],
				'B leyó el estado confirmado por A (sin lost update silencioso)'
			);
			assert.deepEqual(
				events.map((e) => [e.payload.previousPriority, e.payload.newPriority]),
				[
					['medium', 'high'],
					['high', 'low']
				]
			);
			assert.equal(await notesOf(inc.id), 2);
			assert.ok((await executionsOf(o)).every((e) => e.status === 'succeeded'));
		}
	);

	await t.test(
		'#8a regla desactivada tras el claim y antes de las acciones: se omite',
		async () => {
			const { o, rules, admin } = await setup([noteRule('disable-before')]);
			const inc = await fx.incident(o, admin);
			const A = await lab.session('dis-a');
			const B = await lab.session('dis-b');
			const paused = pausingDb(A.db, { call: 2, at: 'beforeStart' });
			const runA = processAutomationExecutions(paused.db, { limit: 1 });
			await paused.reached.wait();
			await withTimeout(
				updateAutomationRule(B.db, o.id, rules[0].id, { active: false }),
				SCENARIO_TIMEOUT_MS,
				'disable'
			);
			paused.release.notify();
			const resultA = await withTimeout(runA, SCENARIO_TIMEOUT_MS, 'A');
			const [execution] = await executionsOf(o);
			log('#8a', `status=${execution.status} error=${execution.errorCode}`);
			assert.equal(resultA.skipped, 1);
			assert.deepEqual([execution.status, execution.errorCode], ['skipped', 'RULE_INACTIVE']);
			assert.equal(await notesOf(inc.id), 0);
		}
	);

	await t.test(
		'#8b desactivación mientras la tx de acciones está abierta: espera y la ejecución completa',
		async () => {
			const { o, rules, admin } = await setup([noteRule('disable-during')]);
			const inc = await fx.incident(o, admin);
			const A = await lab.session('dis2-a');
			const B = await lab.session('dis2-b');
			const paused = pausingDb(A.db, { call: 2, at: 'beforeCommit' });
			const runA = processAutomationExecutions(paused.db, { limit: 1 });
			await paused.reached.wait();
			const disable = updateAutomationRule(B.db, o.id, rules[0].id, { active: false });
			await waitForLockWait(monitor.sql, B.appName); // organization/rule locks held by A's action tx
			paused.release.notify();
			const [ra, rd] = await withTimeout(
				settle([runA, disable]),
				SCENARIO_TIMEOUT_MS,
				'disable-during'
			);
			log('#8b', `A=${ra.value?.succeeded ?? ra.status} disable=${rd.status}`);
			assert.equal(ra.value.succeeded, 1);
			assert.equal(rd.status, 'fulfilled');
			assert.equal(rd.value.active, false);
			assert.equal(await notesOf(inc.id), 1);
			// after the disable, new events create no execution
			await fx.incident(o, admin);
			assert.equal((await executionsOf(o)).length, 1);
		}
	);

	await t.test(
		'#12 fanout regla+evento concurrente: una única ejecución (UNIQUE real)',
		async () => {
			const o = await fx.organization('fanout-rule');
			const admin = await fx.member(o, [o.admin]);
			const inc = await fx.incident(o, admin); // no rules yet: no execution
			await createAutomationRule(monitor.db, o.id, admin.userId, noteRule('late-rule'));
			const [event] = await monitor.db
				.select()
				.from(s.automationEvents)
				.where(
					and(
						eq(s.automationEvents.aggregateId, inc.id),
						eq(s.automationEvents.eventType, 'incident.created')
					)
				);
			const stored = { ...event, occurredAt: event.occurredAt.toISOString() };
			const A = await lab.session('fan-a');
			const B = await lab.session('fan-b');
			const reached = { resolve: null };
			const reachedP = new Promise((r) => (reached.resolve = r));
			let release;
			const releaseP = new Promise((r) => (release = r));
			const txA = A.db.transaction(async (tx) => {
				const r = await fanoutAutomationExecutions(tx, stored);
				reached.resolve();
				await releaseP;
				return r;
			});
			await reachedP;
			const txB = B.db.transaction((tx) => fanoutAutomationExecutions(tx, stored));
			await waitForLockWait(monitor.sql, B.appName); // B waits on A's uncommitted unique key
			release();
			const [ra, rb] = await withTimeout(settle([txA, txB]), SCENARIO_TIMEOUT_MS, 'fanout');
			log('#12', `A created=${ra.value?.created} B created=${rb.value?.created}`);
			assert.deepEqual([ra.value.created, rb.value.created], [1, 0]);
			const rows = await monitor.db
				.select()
				.from(s.automationExecutions)
				.where(eq(s.automationExecutions.sourceEventId, event.id));
			assert.equal(rows.length, 1);
			// ON CONFLICT only covers (rule_id, source_event_id): other violations still fail loudly
			await assert.rejects(
				B.db.transaction((tx) =>
					fanoutAutomationExecutions(tx, { ...stored, id: '00000000-0000-4000-8000-000000000000' })
				),
				(e) => ['23503'].includes(e.code ?? e.cause?.code),
				'FK violation is not masked by ON CONFLICT DO NOTHING'
			);
			await monitor.sql`DELETE FROM automation_executions WHERE id = ANY(${rows.map((r) => r.id)})`;
		}
	);
});

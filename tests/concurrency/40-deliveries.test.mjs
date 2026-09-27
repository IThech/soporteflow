import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
	createSignal,
	log,
	pausingDb,
	settle,
	waitForLockWait,
	withTimeout,
	SCENARIO_TIMEOUT_MS
} from './lab.mjs';
import { createLab } from './setup.mjs';

const MIN = 60_000;

test('5.4W-A #9-#11, #13: claims de webhooks y emails bajo concurrencia real', async (t) => {
	const lab = await createLab(t);
	const { monitor, fixtures: fx, schema: s, load } = lab;
	const subs = await load('/src/lib/server/services/webhook-subscriptions.ts');
	const webhooks = await load('/src/lib/server/services/webhook-deliveries.ts');
	const { fanoutWebhookDeliveries } = await load('/src/lib/server/services/webhook-fanout.ts');
	const emails = await load('/src/lib/server/services/notification-deliveries.ts');
	const prefs = await load('/src/lib/server/services/notification-preferences.ts');
	const { assignIncidentRecord } = await load('/src/lib/server/services/incidents.ts');
	const { parseWebhookEncryptionKey } = await load('/src/lib/server/webhooks/secrets.ts');
	const KEY = parseWebhookEncryptionKey(randomBytes(32).toString('hex'));
	const lookup = async () => [{ address: '93.184.216.34', family: 4 }]; // never real DNS
	const future = (ms = 0) => new Date(Date.now() + 10 * MIN + ms);

	// Lab-only hygiene: rows left non-terminal by an aborted earlier run.
	await monitor.sql`DELETE FROM webhook_deliveries WHERE status IN ('pending', 'retry', 'processing')`;
	await monitor.sql`DELETE FROM notification_deliveries WHERE status IN ('pending', 'retry', 'processing')`;

	/** HTTP client stub: records calls per delivery id; optional gate holds the POST in flight. */
	function httpStub({ gate } = {}) {
		const calls = [];
		const started = createSignal('http-started');
		return {
			calls,
			started,
			post: async (request) => {
				calls.push(request.headers['X-SoporteFlow-Delivery-Id']);
				started.notify();
				if (gate) await gate.wait();
				return { status: 200, retryAfter: null };
			}
		};
	}
	async function webhookSetup(count) {
		const o = await fx.organization('webhooks');
		const admin = await fx.member(o, [o.admin]);
		const created = await subs.createWebhookSubscription(
			monitor.db,
			{ organizationId: o.id, actorUserId: admin.userId },
			{ name: 'Lab', targetUrl: 'https://hooks.example.com/lab', eventTypes: ['incident.created'] },
			{ encryptionKey: KEY }
		);
		for (let i = 0; i < count; i++) await fx.incident(o, admin);
		const rows = await monitor.db
			.select()
			.from(s.webhookDeliveries)
			.where(eq(s.webhookDeliveries.subscriptionId, created.webhook.id));
		return { o, admin, subscriptionId: created.webhook.id, rows };
	}
	const webhookRows = (subscriptionId) =>
		monitor.db
			.select()
			.from(s.webhookDeliveries)
			.where(eq(s.webhookDeliveries.subscriptionId, subscriptionId));
	const run = (db, http, now, limit = 10) =>
		webhooks.processDueWebhookDeliveries(db, {
			now,
			limit,
			httpClient: http,
			lookup,
			encryptionKey: KEY
		});

	await t.test('#9 doble claim de webhooks: SKIP LOCKED reparte; un POST por entrega', async () => {
		const { subscriptionId, rows } = await webhookSetup(4);
		assert.equal(rows.length, 4);
		const A = await lab.session('wh-a');
		const B = await lab.session('wh-b');
		const httpA = httpStub();
		const httpB = httpStub();
		const now = future();
		const paused = pausingDb(A.db, { call: 1, at: 'beforeCommit' });
		const runA = run(paused.db, httpA, now, 2);
		await paused.reached.wait();
		const resultB = await withTimeout(run(B.db, httpB, now, 10), SCENARIO_TIMEOUT_MS, 'B');
		log('#9', `B claimed ${resultB.claimed} while A held 2`);
		assert.equal(resultB.claimed, 2);
		paused.release.notify();
		const resultA = await withTimeout(runA, SCENARIO_TIMEOUT_MS, 'A');
		const all = [...httpA.calls, ...httpB.calls];
		assert.equal(all.length, 4);
		assert.equal(new Set(all).size, 4, 'ninguna entrega enviada dos veces');
		assert.equal(resultA.sent + resultB.sent, 4);
		assert.ok(
			(await webhookRows(subscriptionId)).every((r) => r.status === 'sent' && r.attemptCount === 1)
		);
	});

	await t.test(
		'#10 worker obsoleto: A envía, lease expira, B reenvía; A no sobrescribe (at-least-once)',
		async () => {
			const { subscriptionId } = await webhookSetup(1);
			const A = await lab.session('whs-a');
			const B = await lab.session('whs-b');
			const gate = createSignal('A http gate', 45_000);
			const httpA = httpStub({ gate });
			const httpB = httpStub();
			const now = future();
			const runA = run(A.db, httpA, now, 1);
			await httpA.started.wait(); // A claimed (committed) and is inside the HTTP call: no DB locks
			const later = new Date(now.getTime() + webhooks.WEBHOOK_LEASE_MS + 1000);
			const resultB = await withTimeout(run(B.db, httpB, later, 10), SCENARIO_TIMEOUT_MS, 'B');
			assert.deepEqual([resultB.claimed, resultB.sent], [1, 1]);
			gate.notify(); // A's slow receiver finally answers 200
			const resultA = await withTimeout(runA, SCENARIO_TIMEOUT_MS, 'A');
			const [row] = await webhookRows(subscriptionId);
			log(
				'#10',
				`A leaseLost=${resultA.leaseLost}, POSTs=${httpA.calls.length + httpB.calls.length}`
			);
			assert.equal(resultA.leaseLost, 1, 'el token antiguo no puede marcar el resultado');
			assert.equal(row.status, 'sent');
			assert.equal(row.attemptCount, 2);
			assert.equal(row.deliveredAt.getTime(), later.getTime(), 'resultado escrito por B');
			// Documented at-least-once: a worker stalled beyond the lease causes a duplicate POST with
			// the same event id (receivers dedupe by X-SoporteFlow-Event-Id).
			assert.equal(httpA.calls.length + httpB.calls.length, 2);
		}
	);

	await t.test(
		'#10b [H2 corregido] lote: A no envía el ítem que B reclamó tras expirar el lease',
		async () => {
			// H2 (confirmed in the first CT 105 run: 2 duplicate POSTs). Fix: the lease of each item is
			// renewed atomically (token-guarded) right before its POST. Expected now: only the POST
			// that was already in flight when B reclaimed is duplicated (inherent at-least-once for a
			// worker stalled beyond its lease); the unsent item is skipped by A.
			const { subscriptionId } = await webhookSetup(2);
			const A = await lab.session('whb-a');
			const B = await lab.session('whb-b');
			const gate = createSignal('A first POST gate', 45_000);
			let firstCall = true;
			const callsA = [];
			const httpA = {
				post: async (request) => {
					callsA.push(request.headers['X-SoporteFlow-Delivery-Id']);
					if (firstCall) {
						firstCall = false;
						started.notify();
						await gate.wait();
					}
					return { status: 200, retryAfter: null };
				}
			};
			const started = createSignal('A first POST started');
			const httpB = httpStub();
			const now = future();
			const runA = run(A.db, httpA, now, 2); // A claims BOTH, sends the first slowly
			await started.wait();
			const later = new Date(now.getTime() + webhooks.WEBHOOK_LEASE_MS + 1000);
			const resultB = await withTimeout(run(B.db, httpB, later, 10), SCENARIO_TIMEOUT_MS, 'B');
			gate.notify();
			const resultA = await withTimeout(runA, SCENARIO_TIMEOUT_MS, 'A');
			const rows = await webhookRows(subscriptionId);
			const duplicates = callsA.filter((id) => httpB.calls.includes(id)).length;
			log(
				'#10b',
				`B claimed ${resultB.claimed}; A leaseLost=${resultA.leaseLost}; duplicate POSTs=${duplicates} (H2)`
			);
			assert.equal(resultB.claimed, 2, 'both leases expired, including the unsent one');
			assert.equal(resultA.leaseLost, 2, 'A cannot overwrite B for either delivery');
			assert.ok(rows.every((r) => r.status === 'sent' && r.attemptCount === 2));
			assert.equal(callsA.length, 1, 'A skipped the item it no longer owned');
			assert.equal(duplicates, 1, 'only the in-flight POST is duplicated (at-least-once)');
		}
	);

	await t.test(
		'#13 fanout suscripción+evento concurrente: una única entrega (UNIQUE real)',
		async () => {
			const o = await fx.organization('webhook-fanout');
			const admin = await fx.member(o, [o.admin]);
			const inc = await fx.incident(o, admin); // no subscription yet
			const created = await subs.createWebhookSubscription(
				monitor.db,
				{ organizationId: o.id, actorUserId: admin.userId },
				{
					name: 'Late',
					targetUrl: 'https://hooks.example.com/late',
					eventTypes: ['incident.created']
				},
				{ encryptionKey: KEY }
			);
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
			const A = await lab.session('whf-a');
			const B = await lab.session('whf-b');
			const reached = createSignal('A inserted');
			const release = createSignal('A commit');
			const txA = A.db.transaction(async (tx) => {
				const r = await fanoutWebhookDeliveries(tx, stored);
				reached.notify();
				await release.wait();
				return r;
			});
			await reached.wait();
			const txB = B.db.transaction((tx) => fanoutWebhookDeliveries(tx, stored));
			await waitForLockWait(monitor.sql, B.appName);
			release.notify();
			const [ra, rb] = await withTimeout(settle([txA, txB]), SCENARIO_TIMEOUT_MS, 'fanout');
			log('#13', `A created=${ra.value?.created} B created=${rb.value?.created}`);
			assert.deepEqual([ra.value.created, rb.value.created], [1, 0]);
			assert.equal((await webhookRows(created.webhook.id)).length, 1);
			await subs.deactivateWebhookSubscription(monitor.db, o.id, created.webhook.id);
			await monitor.sql`DELETE FROM webhook_deliveries WHERE subscription_id = ${created.webhook.id}`;
		}
	);

	// ----------------------------------------------------------------- notification email deliveries
	async function emailSetup(count) {
		const o = await fx.organization('emails');
		const admin = await fx.member(o, [o.admin]);
		const recipients = [];
		for (let i = 0; i < count; i++) {
			const tech = await fx.member(o, [o.tech]);
			await prefs.setNotificationPreference(
				monitor.db,
				{ organizationId: o.id, userId: tech.userId },
				'incident.assigned',
				{ emailEnabled: true }
			);
			const inc = await fx.incident(o, admin);
			await assignIncidentRecord(
				monitor.db,
				{ organizationId: o.id, actorUserId: admin.userId },
				inc.id,
				{
					assignedToUserId: tech.userId
				}
			);
			recipients.push(tech);
		}
		return { o, recipients };
	}
	const emailRows = (o) =>
		monitor.db
			.select()
			.from(s.notificationDeliveries)
			.where(eq(s.notificationDeliveries.organizationId, o.id));
	function senderStub({ gate } = {}) {
		const sent = [];
		const started = createSignal('email-started');
		return {
			sent,
			started,
			sendNotification: async (message) => {
				sent.push(message.to);
				started.notify();
				if (gate) await gate.wait();
				return { providerMessageId: 'lab' };
			}
		};
	}

	await t.test(
		'#11a doble claim de emails: SKIP LOCKED reparte; un envío por entrega',
		async () => {
			const { o } = await emailSetup(4);
			assert.equal((await emailRows(o)).length, 4);
			const A = await lab.session('em-a');
			const B = await lab.session('em-b');
			const senderA = senderStub();
			const senderB = senderStub();
			const now = future();
			const paused = pausingDb(A.db, { call: 1, at: 'beforeCommit' });
			const runA = emails.processDueNotificationDeliveries(paused.db, {
				now,
				limit: 2,
				sender: senderA
			});
			await paused.reached.wait();
			const resultB = await withTimeout(
				emails.processDueNotificationDeliveries(B.db, { now, limit: 10, sender: senderB }),
				SCENARIO_TIMEOUT_MS,
				'B'
			);
			log('#11a', `B claimed ${resultB.claimed} while A held 2`);
			assert.equal(resultB.claimed, 2);
			paused.release.notify();
			await withTimeout(runA, SCENARIO_TIMEOUT_MS, 'A');
			const all = [...senderA.sent, ...senderB.sent];
			assert.equal(all.length, 4);
			assert.equal(new Set(all).size, 4);
			assert.ok((await emailRows(o)).every((r) => r.status === 'sent' && r.attemptCount === 1));
		}
	);

	await t.test(
		'#11b email con worker obsoleto: token antiguo no sobrescribe (at-least-once)',
		async () => {
			const { o } = await emailSetup(1);
			const A = await lab.session('ems-a');
			const B = await lab.session('ems-b');
			const gate = createSignal('A smtp gate', 45_000);
			const senderA = senderStub({ gate });
			const senderB = senderStub();
			const now = future();
			const runA = emails.processDueNotificationDeliveries(A.db, {
				now,
				limit: 1,
				sender: senderA
			});
			await senderA.started.wait();
			const later = new Date(now.getTime() + emails.NOTIFICATION_DELIVERY_LEASE_MS + 1000);
			const resultB = await withTimeout(
				emails.processDueNotificationDeliveries(B.db, { now: later, limit: 10, sender: senderB }),
				SCENARIO_TIMEOUT_MS,
				'B'
			);
			assert.deepEqual([resultB.claimed, resultB.sent], [1, 1]);
			gate.notify();
			const resultA = await withTimeout(runA, SCENARIO_TIMEOUT_MS, 'A');
			const [row] = await emailRows(o);
			log('#11b', `A leaseLost=${resultA.leaseLost}`);
			assert.equal(resultA.leaseLost, 1);
			assert.deepEqual(
				[row.status, row.attemptCount, row.sentAt.getTime()],
				['sent', 2, later.getTime()]
			);
		}
	);

	await t.test(
		'#11c [H2 corregido] lote de emails: A no envía el ítem que B reclamó tras expirar el lease',
		async () => {
			const { o } = await emailSetup(2);
			const A = await lab.session('emb-a');
			const B = await lab.session('emb-b');
			const gate = createSignal('A first send gate', 45_000);
			const started = createSignal('A first send started');
			const sentA = [];
			const senderA = {
				sendNotification: async (message) => {
					sentA.push(message.to);
					if (sentA.length === 1) {
						started.notify();
						await gate.wait();
					}
					return { providerMessageId: 'a' };
				}
			};
			const senderB = senderStub();
			const now = future();
			const runA = emails.processDueNotificationDeliveries(A.db, {
				now,
				limit: 2,
				sender: senderA
			});
			await started.wait();
			const later = new Date(now.getTime() + emails.NOTIFICATION_DELIVERY_LEASE_MS + 1000);
			const resultB = await withTimeout(
				emails.processDueNotificationDeliveries(B.db, { now: later, limit: 10, sender: senderB }),
				SCENARIO_TIMEOUT_MS,
				'B'
			);
			gate.notify();
			const resultA = await withTimeout(runA, SCENARIO_TIMEOUT_MS, 'A');
			const duplicates = sentA.filter((to) => senderB.sent.includes(to)).length;
			log(
				'#11c',
				`B claimed ${resultB.claimed}; A leaseLost=${resultA.leaseLost}; duplicates=${duplicates}`
			);
			assert.deepEqual([resultB.claimed, resultB.sent], [2, 2]);
			assert.equal(resultA.leaseLost, 2);
			assert.equal(sentA.length, 1, 'A skipped the email it no longer owned');
			assert.equal(duplicates, 1, 'only the in-flight send is duplicated (at-least-once)');
			assert.ok((await emailRows(o)).every((r) => r.status === 'sent' && r.attemptCount === 2));
		}
	);

	await t.test('#11d renovación atómica frente a un claim concurrente real', async () => {
		// A renews while B's claim transaction (lease expired by B's clock) holds the row: whichever
		// commits first owns it; the loser must not send.
		const { o } = await emailSetup(1);
		const [row] = await emailRows(o);
		const A = await lab.session('emr-a');
		const B = await lab.session('emr-b');
		const now = future();
		const [claim] = await emails.claimDueDeliveries(A.db, { now });
		const later = new Date(now.getTime() + emails.NOTIFICATION_DELIVERY_LEASE_MS + 1000);
		const paused = pausingDb(B.db, { call: 1, at: 'beforeCommit' });
		const claimB = emails.claimDueDeliveries(paused.db, { now: later });
		await paused.reached.wait(); // B holds the row (claimed, uncommitted)
		const renewA = emails.renewDeliveryLease(A.db, {
			id: row.id,
			leaseToken: claim.leaseToken,
			now: later
		});
		await waitForLockWait(monitor.sql, A.appName); // A's renewal waits on B's row lock
		paused.release.notify();
		const [ra, rb] = await withTimeout(settle([renewA, claimB]), SCENARIO_TIMEOUT_MS, 'renew');
		log('#11d', `A renewed=${ra.value} B claimed=${rb.value?.length}`);
		assert.equal(rb.value.length, 1);
		assert.equal(ra.value, false, 'B committed first: A lost ownership and must not send');
	});
});

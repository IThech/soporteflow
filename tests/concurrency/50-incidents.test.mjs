import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
	errorCode,
	log,
	pausingDb,
	settle,
	waitForLockWait,
	withTimeout,
	SCENARIO_TIMEOUT_MS
} from './lab.mjs';
import { createLab } from './setup.mjs';

test('5.4W-A #14-#19: escrituras concurrentes sobre la misma incidencia (PostgreSQL real)', async (t) => {
	const lab = await createLab(t);
	const { monitor, fixtures: fx, schema: s, load } = lab;
	const incidents = await load('/src/lib/server/services/incidents.ts');
	const { createPublicComment } = await load('/src/lib/server/services/incident-messages.ts');
	const { createSlaPolicy } = await load('/src/lib/server/services/sla-policies.ts');
	const subs = await load('/src/lib/server/services/webhook-subscriptions.ts');
	const { parseWebhookEncryptionKey } = await load('/src/lib/server/webhooks/secrets.ts');
	const KEY = parseWebhookEncryptionKey(randomBytes(32).toString('hex'));

	async function setup({ sla = false } = {}) {
		const o = await fx.organization('incidents');
		const admin = await fx.member(o, [o.admin]);
		const tech1 = await fx.member(o, [o.tech]);
		const tech2 = await fx.member(o, [o.tech]);
		const customer = await fx.member(o, [o.customer]);
		if (sla)
			await createSlaPolicy(monitor.db, o.id, {
				code: 'lab_std',
				name: 'Lab std',
				firstResponseMinutes: 60,
				resolutionMinutes: 120,
				isDefault: true
			});
		const inc = await fx.incident(o, admin, { clientUserId: customer.userId });
		return { o, admin, tech1, tech2, customer, inc };
	}
	const ctx = (o, actor) => ({ organizationId: o.id, actorUserId: actor.userId });
	const reload = async (inc) =>
		(await monitor.db.select().from(s.incidents).where(eq(s.incidents.id, inc.id)))[0];
	const history = (inc, type) =>
		monitor.db
			.select()
			.from(s.incidentHistory)
			.where(
				type
					? and(eq(s.incidentHistory.incidentId, inc.id), eq(s.incidentHistory.eventType, type))
					: eq(s.incidentHistory.incidentId, inc.id)
			)
			.orderBy(asc(s.incidentHistory.createdAt));
	const events = async (inc, prefix = '') =>
		(
			await monitor.db
				.select()
				.from(s.automationEvents)
				.where(eq(s.automationEvents.aggregateId, inc.id))
				.orderBy(asc(s.automationEvents.position))
		).filter((e) => e.eventType.startsWith(prefix));

	/** A runs `first` paused before COMMIT; B runs `second` and must block; then A commits. */
	async function race(label, first, second, { failWith } = {}) {
		const A = await lab.session(`${label}-a`);
		const B = await lab.session(`${label}-b`);
		const paused = pausingDb(A.db, { failWith });
		const pa = first(paused.db);
		await paused.reached.wait();
		const pb = second(B.db);
		await waitForLockWait(monitor.sql, B.appName);
		paused.release.notify();
		const [ra, rb] = await withTimeout(settle([pa, pb]), SCENARIO_TIMEOUT_MS, label);
		log(
			label,
			`A=${ra.status}${ra.reason ? ':' + errorCode(ra.reason) : ''} B=${rb.status}${rb.reason ? ':' + errorCode(rb.reason) : ''}`
		);
		return [ra, rb];
	}

	await t.test(
		'#14a dos cambios de estado: B espera y parte del estado confirmado por A',
		async () => {
			const { o, admin, inc } = await setup();
			const [ra, rb] = await race(
				'#14a',
				(db) => incidents.updateIncidentRecord(db, ctx(o, admin), inc.id, { status: 'pending' }),
				(db) => incidents.updateIncidentRecord(db, ctx(o, admin), inc.id, { status: 'resolved' })
			);
			assert.equal(ra.status, 'fulfilled');
			assert.equal(rb.status, 'fulfilled');
			assert.equal((await reload(inc)).status, 'resolved');
			const statusEvents = await events(inc, 'incident.status');
			assert.deepEqual(
				statusEvents.map((e) => [e.payload.previousStatus, e.payload.newStatus]),
				[
					['open', 'pending'],
					['pending', 'resolved']
				],
				'cadena coherente: sin previous obsoleto'
			);
			const notifications = (await monitor.db.select().from(s.notifications)).filter(
				(n) => n.payload?.incidentId === inc.id && n.type === 'incident.status_changed'
			);
			assert.deepEqual(notifications.map((n) => n.payload.previousStatus).sort(), [
				'open',
				'pending'
			]);
		}
	);

	await t.test(
		'#14b transición inválida tras la de A: error de dominio, sin escrituras parciales',
		async () => {
			const { o, admin, inc } = await setup();
			const [ra, rb] = await race(
				'#14b',
				(db) => incidents.updateIncidentRecord(db, ctx(o, admin), inc.id, { status: 'resolved' }),
				(db) => incidents.updateIncidentRecord(db, ctx(o, admin), inc.id, { status: 'pending' })
			);
			assert.equal(ra.status, 'fulfilled');
			assert.equal(errorCode(rb.reason), 'INVALID_INPUT', 'resolved -> pending no está permitido');
			assert.equal((await reload(inc)).status, 'resolved');
			assert.equal((await events(inc, 'incident.status')).length, 1);
		}
	);

	await t.test('#15 asignar/desasignar concurrentes: B ve la asignación de A', async () => {
		const { o, admin, tech1, inc } = await setup();
		const [ra, rb] = await race(
			'#15',
			(db) =>
				incidents.assignIncidentRecord(db, ctx(o, admin), inc.id, {
					assignedToUserId: tech1.userId
				}),
			(db) =>
				incidents.assignIncidentRecord(db, ctx(o, admin), inc.id, {
					assignedToUserId: null,
					reason: 'Lab unassign'
				})
		);
		assert.equal(ra.status, 'fulfilled');
		assert.equal(rb.status, 'fulfilled');
		assert.equal((await reload(inc)).assignedToUserId, null);
		assert.deepEqual(
			(await events(inc, 'incident.'))
				.filter((e) => /assigned/.test(e.eventType))
				.map((e) => [e.eventType, e.payload.previousAssigneeUserId ?? null]),
			[
				['incident.assigned', null],
				['incident.unassigned', tech1.userId]
			]
		);
		const forTech = (await monitor.db.select().from(s.notifications)).filter(
			(n) => n.recipientUserId === tech1.userId && n.payload?.incidentId === inc.id
		);
		assert.deepEqual(forTech.map((n) => n.type).sort(), [
			'incident.assigned',
			'incident.unassigned'
		]);
	});

	await t.test(
		'#16 comentario público (primera respuesta) + cambio de estado concurrentes',
		async () => {
			const { o, tech1, admin, inc } = await setup({ sla: true });
			const [ra, rb] = await race(
				'#16',
				(db) =>
					createPublicComment(
						db,
						{
							organizationId: o.id,
							incidentId: inc.id,
							actorUserId: tech1.userId,
							supportResponse: true
						},
						'Primera respuesta'
					),
				(db) => incidents.updateIncidentRecord(db, ctx(o, admin), inc.id, { status: 'resolved' })
			);
			assert.equal(ra.status, 'fulfilled');
			assert.equal(rb.status, 'fulfilled');
			const row = await reload(inc);
			assert.ok(row.firstResponseAt && row.firstResolvedAt);
			assert.ok(row.firstResponseAt <= row.firstResolvedAt);
			assert.equal((await history(inc, 'sla_first_response_met')).length, 1);
			assert.equal((await history(inc, 'sla_resolution_met')).length, 1);
			assert.deepEqual(
				(await events(inc, 'sla.')).map((e) => e.eventType),
				['sla.first_response_met', 'sla.resolution_met']
			);
		}
	);

	await t.test(
		'#17 reabrir vs cerrar sobre una resuelta: solo una transición efectiva',
		async () => {
			const { o, admin, inc } = await setup();
			await incidents.updateIncidentRecord(monitor.db, ctx(o, admin), inc.id, {
				status: 'resolved'
			});
			const [ra, rb] = await race(
				'#17',
				(db) => incidents.updateIncidentRecord(db, ctx(o, admin), inc.id, { status: 'open' }),
				(db) => incidents.updateIncidentRecord(db, ctx(o, admin), inc.id, { status: 'closed' })
			);
			assert.equal(ra.status, 'fulfilled');
			assert.equal(errorCode(rb.reason), 'INVALID_INPUT', 'open -> closed no está permitido');
			assert.equal((await reload(inc)).status, 'open');
			assert.equal((await events(inc, 'incident.reopened')).length, 1);
			assert.equal((await history(inc, 'closed')).length, 0);
		}
	);

	await t.test(
		'#18a firstResolvedAt: dos resoluciones concurrentes, first-write-wins, un evento SLA',
		async () => {
			const { o, admin, tech1, inc } = await setup({ sla: true });
			const [ra, rb] = await race(
				'#18a',
				(db) => incidents.updateIncidentRecord(db, ctx(o, admin), inc.id, { status: 'resolved' }),
				(db) => incidents.updateIncidentRecord(db, ctx(o, tech1), inc.id, { status: 'resolved' })
			);
			assert.equal(ra.status, 'fulfilled');
			assert.equal(rb.status, 'fulfilled', 'B es no-op (ya resuelta)');
			const row = await reload(inc);
			assert.equal(row.firstResolvedAt.getTime(), ra.value.incident.firstResolvedAt.getTime());
			assert.equal((await history(inc, 'resolved')).length, 1);
			const slaHistory = [
				...(await history(inc, 'sla_resolution_met')),
				...(await history(inc, 'sla_resolution_breached'))
			];
			assert.equal(slaHistory.length, 1);
			assert.equal((await events(inc, 'sla.resolution')).length, 1);
		}
	);

	await t.test(
		'#18b firstResponseAt: dos respuestas de soporte concurrentes, un único resultado SLA',
		async () => {
			const { o, tech1, tech2, inc } = await setup({ sla: true });
			const reply = (actor, text) => (db) =>
				createPublicComment(
					db,
					{
						organizationId: o.id,
						incidentId: inc.id,
						actorUserId: actor.userId,
						supportResponse: true
					},
					text
				);
			const [ra, rb] = await race('#18b', reply(tech1, 'A'), reply(tech2, 'B'));
			assert.equal(ra.status, 'fulfilled');
			assert.equal(rb.status, 'fulfilled');
			assert.equal((await history(inc, 'sla_first_response_met')).length, 1);
			assert.equal((await events(inc, 'sla.first_response')).length, 1);
			assert.equal((await events(inc, 'incident.public_comment_added')).length, 2);
		}
	);

	await t.test(
		'#19 rollback bajo contención libera locks; sin efectos parciales de A',
		async () => {
			const { o, admin, tech2, inc } = await setup();
			const created = await subs.createWebhookSubscription(
				monitor.db,
				{ organizationId: o.id, actorUserId: admin.userId },
				{
					name: 'Rollback',
					targetUrl: 'https://hooks.example.com/rollback',
					eventTypes: ['incident.status_changed', 'incident.assigned']
				},
				{ encryptionKey: KEY }
			);
			const before = {
				history: (await history(inc)).length,
				events: (await events(inc)).length
			};
			const [ra, rb] = await race(
				'#19',
				(db) => incidents.updateIncidentRecord(db, ctx(o, admin), inc.id, { status: 'pending' }),
				(db) =>
					incidents.assignIncidentRecord(db, ctx(o, admin), inc.id, {
						assignedToUserId: tech2.userId
					}),
				{ failWith: new Error('LAB_FORCED_ROLLBACK') }
			);
			assert.equal(ra.status, 'rejected', 'A aborta tras obtener locks y escribir');
			assert.equal(rb.status, 'fulfilled', 'B continúa en cuanto A libera los locks');
			const row = await reload(inc);
			assert.equal(row.status, 'open', 'estado de A revertido');
			assert.equal(row.assignedToUserId, tech2.userId);
			assert.equal((await history(inc)).length, before.history + 1, 'solo el historial de B');
			const newEvents = (await events(inc)).slice(before.events).map((e) => e.eventType);
			assert.deepEqual(newEvents, ['incident.assigned']);
			const deliveries = await monitor.db
				.select()
				.from(s.webhookDeliveries)
				.where(eq(s.webhookDeliveries.subscriptionId, created.webhook.id));
			assert.deepEqual(
				deliveries.map((d) => d.eventType),
				['incident.assigned']
			);
			const statusNotifications = (await monitor.db.select().from(s.notifications)).filter(
				(n) => n.payload?.incidentId === inc.id && n.type === 'incident.status_changed'
			);
			assert.equal(statusNotifications.length, 0);
			await subs.deactivateWebhookSubscription(monitor.db, o.id, created.webhook.id);
			await monitor.sql`DELETE FROM webhook_deliveries WHERE subscription_id = ${created.webhook.id}`;
		}
	);

	await t.test(
		'#30 tenant: sede propia vs sede de otra organización en carrera; FK compuesta final',
		async () => {
			const { o, admin, inc } = await setup();
			const other = await fx.organization('foreign');
			const [own] = await monitor.db
				.insert(s.sites)
				.values({ organizationId: o.id, name: 'Propia' })
				.returning();
			const [foreign] = await monitor.db
				.insert(s.sites)
				.values({ organizationId: other.id, name: 'Ajena' })
				.returning();
			const [ra, rb] = await race(
				'#30',
				(db) => incidents.changeIncidentSite(db, ctx(o, admin), inc.id, { siteId: own.id }),
				(db) =>
					incidents.changeIncidentSite(db, ctx(o, admin), inc.id, {
						siteId: foreign.id,
						reason: 'x'
					})
			);
			assert.equal(ra.status, 'fulfilled');
			assert.equal(rb.status, 'rejected');
			assert.ok(/^SITE_/.test(errorCode(rb.reason)) || errorCode(rb.reason) === 'INVALID_INPUT');
			assert.equal((await reload(inc)).siteId, own.id);
			// even bypassing service validation, the composite FK rejects a cross-tenant link
			await assert.rejects(
				monitor.sql`UPDATE incidents SET site_id = ${foreign.id} WHERE id = ${inc.id}`,
				(e) => e.code === '23503'
			);
		}
	);
});

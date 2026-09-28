import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
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

/**
 * 5.4X-C #34-#36 — invitation outbox on real PostgreSQL (SKIP LOCKED, leases, resend/revoke vs an
 * in-flight claim). PGlite serializes everything, so these races only exist here (CT 105).
 */
test('5.4X-C #34-#36: outbox de invitaciones (PostgreSQL real)', async (t) => {
	const lab = await createLab(t);
	const { monitor, fixtures: fx, schema: s, load } = lab;
	const outbox = await load('/src/lib/server/services/invitation-deliveries.ts');
	const invitations = await load('/src/lib/server/services/invitations.ts');
	const { PERMISSION_IDS } = await load('/src/lib/server/auth/permissions.ts');
	const KEY = randomBytes(32);

	async function setup(count = 1) {
		const o = await fx.organization('invitation-outbox');
		const admin = await fx.member(o, [o.admin]);
		const ctx = {
			organizationId: o.id,
			actorUserId: admin.userId,
			actorPermissions: PERMISSION_IDS
		};
		const issued = [];
		for (let i = 0; i < count; i++)
			issued.push(
				await invitations.createInvitation(
					monitor.db,
					ctx,
					{
						email: `lab-${i}-${randomBytes(4).toString('hex')}@example.test`,
						roleId: o.customer.id
					},
					{ encryptionKey: KEY }
				)
			);
		return { o, ctx, issued };
	}
	function recorder() {
		const attempts = [];
		return {
			attempts,
			async sendInvitation(message) {
				attempts.push(message.token);
			}
		};
	}
	const deliveriesOf = (invitationId) =>
		monitor.db
			.select()
			.from(s.invitationDeliveries)
			.where(eq(s.invitationDeliveries.invitationId, invitationId))
			.orderBy(s.invitationDeliveries.createdAt);
	const future = () => new Date(Date.now() + 60_000);

	await t.test(
		'#34 dos workers concurrentes: SKIP LOCKED reparte, cada entrega una sola vez',
		async () => {
			const { issued } = await setup(12);
			const A = await lab.session('io34-a');
			const B = await lab.session('io34-b');
			const sender = recorder();
			const now = future();
			const [ra, rb] = await withTimeout(
				settle([
					outbox.processDueInvitationDeliveries(A.db, {
						sender,
						encryptionKey: KEY,
						now,
						limit: 8
					}),
					outbox.processDueInvitationDeliveries(B.db, { sender, encryptionKey: KEY, now, limit: 8 })
				]),
				SCENARIO_TIMEOUT_MS,
				'#34'
			);
			assert.equal(ra.status, 'fulfilled');
			assert.equal(rb.status, 'fulfilled');
			const rest = await outbox.processDueInvitationDeliveries(monitor.db, {
				sender,
				encryptionKey: KEY,
				now
			});
			log('#34', `A=${ra.value.sent} B=${rb.value.sent} rest=${rest.sent}`);
			const mine = new Set(issued.map((i) => i.delivery.token));
			const delivered = sender.attempts.filter((token) => mine.has(token));
			assert.equal(delivered.length, 12, 'todas entregadas');
			assert.equal(new Set(delivered).size, 12, 'sin duplicados');
			for (const i of issued) {
				const [d] = await deliveriesOf(i.invitation.id);
				assert.equal(d.status, 'sent');
				assert.equal(d.tokenCiphertext, null);
			}
		}
	);

	await t.test(
		'#35 reenvío mientras el worker tiene el claim: el enlace viejo nunca sale',
		async () => {
			const { ctx, issued } = await setup(1);
			const [inv] = issued;
			const A = await lab.session('io35-a');
			const B = await lab.session('io35-b');
			const sender = recorder();
			const paused = pausingDb(A.db); // claim transaction paused before COMMIT (rows locked)
			const worker = outbox.processDueInvitationDeliveries(paused.db, {
				sender,
				encryptionKey: KEY,
				now: future()
			});
			await paused.reached.wait();
			const resend = invitations.resendInvitation(B.db, ctx, inv.invitation.id, {
				encryptionKey: KEY
			});
			await waitForLockWait(monitor.sql, B.appName);
			paused.release.notify();
			const [rw, rr] = await withTimeout(settle([worker, resend]), SCENARIO_TIMEOUT_MS, '#35');
			log(
				'#35',
				`worker=${rw.status} resend=${rr.status}${rr.reason ? ':' + errorCode(rr.reason) : ''}`
			);
			assert.equal(rw.status, 'fulfilled');
			assert.equal(rr.status, 'fulfilled');
			assert.ok(!sender.attempts.includes(inv.delivery.token), 'token anterior nunca enviado');
			const [old, fresh] = await deliveriesOf(inv.invitation.id);
			assert.equal(old.status, 'cancelled');
			assert.equal(old.tokenCiphertext, null);
			assert.equal(fresh.status, 'pending');
			await outbox.processDueInvitationDeliveries(monitor.db, {
				sender,
				encryptionKey: KEY,
				now: future()
			});
			assert.ok(sender.attempts.includes(rr.value.delivery.token), 'el enlace nuevo sí sale');
		}
	);

	await t.test('#36 revocación mientras el worker tiene el claim: ningún envío útil', async () => {
		const { o, issued } = await setup(1);
		const [inv] = issued;
		const A = await lab.session('io36-a');
		const B = await lab.session('io36-b');
		const sender = recorder();
		const paused = pausingDb(A.db);
		const worker = outbox.processDueInvitationDeliveries(paused.db, {
			sender,
			encryptionKey: KEY,
			now: future()
		});
		await paused.reached.wait();
		const revoke = invitations.revokeInvitation(B.db, o.id, inv.invitation.id);
		await waitForLockWait(monitor.sql, B.appName);
		paused.release.notify();
		const [rw, rr] = await withTimeout(settle([worker, revoke]), SCENARIO_TIMEOUT_MS, '#36');
		log('#36', `worker=${rw.status} revoke=${rr.status}`);
		assert.equal(rr.status, 'fulfilled');
		assert.equal(sender.attempts.length, 0);
		const [d] = await deliveriesOf(inv.invitation.id);
		assert.equal(d.status, 'cancelled');
		assert.equal(d.tokenCiphertext, null);
	});
});

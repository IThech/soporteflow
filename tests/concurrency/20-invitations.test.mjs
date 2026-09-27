import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
	errorCode,
	log,
	pausingDb,
	settle,
	waitForLockWait,
	withTimeout,
	SCENARIO_TIMEOUT_MS
} from './lab.mjs';
import { createLab, RUN_ID } from './setup.mjs';

test('5.4W-A #3: aceptación concurrente de invitaciones (PostgreSQL real)', async (t) => {
	const lab = await createLab(t);
	const { monitor, fixtures: fx, schema: s, load } = lab;
	const { createInvitation, resendInvitation, revokeInvitation } = await load(
		'/src/lib/server/services/invitations.ts'
	);
	const { acceptInvitation } = await load('/src/lib/server/services/invitation-acceptance.ts');
	const { PERMISSION_IDS: ALL } = await load('/src/lib/server/auth/permissions.ts');
	const onboarding = { name: 'Lab invitee', password: 'Lab-Password-1234567' };

	async function invite(email) {
		const o = await fx.organization('invitations');
		const admin = await fx.member(o, [o.admin]);
		const issued = await createInvitation(
			monitor.db,
			{ organizationId: o.id, actorUserId: admin.userId, actorPermissions: ALL },
			{ email, roleId: o.tech.id }
		);
		return { o, admin, issued, token: issued.delivery.token, id: issued.invitation.id };
	}
	const newEmail = () => `wa-${RUN_ID}-${randomUUID()}@example.test`;
	const identitiesFor = async (email) =>
		(
			await monitor.db
				.select()
				.from(s.userEmails)
				.where(sql`lower(${s.userEmails.email}) = ${email}`)
		).length;
	const membershipsOf = async (o) =>
		(await monitor.db.select().from(s.memberships).where(eq(s.memberships.organizationId, o.id)))
			.length;
	const statusOf = async (id) =>
		(await monitor.db.select().from(s.invitations).where(eq(s.invitations.id, id)))[0].status;

	await t.test('#3a doble aceptación coordinada (onboarding): una sola efectiva', async () => {
		const email = newEmail();
		const { o, token, id } = await invite(email);
		const before = await membershipsOf(o);
		const A = await lab.session('inv-a');
		const B = await lab.session('inv-b');
		const paused = pausingDb(A.db);
		const first = acceptInvitation(paused.db, { token, principalUserId: null, ...onboarding });
		await paused.reached.wait(); // A holds the invitation FOR UPDATE, identity created, not committed
		const second = acceptInvitation(B.db, { token, principalUserId: null, ...onboarding });
		await waitForLockWait(monitor.sql, B.appName);
		paused.release.notify();
		const [ra, rb] = await withTimeout(settle([first, second]), SCENARIO_TIMEOUT_MS, 'accept');
		log(
			'#3a',
			`A=${ra.status} B=${rb.status}:${rb.status === 'rejected' ? errorCode(rb.reason) : ''}`
		);
		assert.equal(ra.status, 'fulfilled');
		assert.ok(['INVALID_INVITATION', 'ACCEPTANCE_CONFLICT'].includes(errorCode(rb.reason)));
		assert.equal(await identitiesFor(email), 1);
		assert.equal(await membershipsOf(o), before + 1);
		assert.equal(await statusOf(id), 'accepted');
	});

	await t.test(
		'#3b doble aceptación sin coordinar (x5): nunca identidades/membresías duplicadas',
		async () => {
			for (let i = 0; i < 5; i++) {
				const email = newEmail();
				const { o, token } = await invite(email);
				const before = await membershipsOf(o);
				const A = await lab.session(`invf-a${i}`);
				const B = await lab.session(`invf-b${i}`);
				const results = await withTimeout(
					settle([
						acceptInvitation(A.db, { token, principalUserId: null, ...onboarding }),
						acceptInvitation(B.db, { token, principalUserId: null, ...onboarding })
					]),
					SCENARIO_TIMEOUT_MS,
					'accept-free'
				);
				assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, `iteración ${i}`);
				assert.equal(await identitiesFor(email), 1);
				assert.equal(await membershipsOf(o), before + 1);
				await A.sql.end();
				await B.sql.end();
			}
		}
	);

	await t.test(
		'#3c identidad existente: dos aceptaciones del mismo principal, una asignación',
		async () => {
			const existing = await fx.user('Existing invitee');
			const { o, token } = await invite(existing.email);
			const A = await lab.session('inve-a');
			const B = await lab.session('inve-b');
			const results = await withTimeout(
				settle([
					acceptInvitation(A.db, { token, principalUserId: existing.id }),
					acceptInvitation(B.db, { token, principalUserId: existing.id })
				]),
				SCENARIO_TIMEOUT_MS,
				'accept-existing'
			);
			assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
			const rows = await monitor.db
				.select()
				.from(s.memberships)
				.where(
					sql`${s.memberships.organizationId} = ${o.id} AND ${s.memberships.userId} = ${existing.id}`
				);
			assert.equal(rows.length, 1);
			const assignments = await monitor.db
				.select()
				.from(s.roleAssignments)
				.where(eq(s.roleAssignments.membershipId, rows[0].id));
			assert.equal(assignments.length, 1);
		}
	);

	await t.test(
		'#3d reenvío (rota token) concurrente con aceptación del token anterior',
		async () => {
			const email = newEmail();
			const { o, admin, token, id } = await invite(email);
			const A = await lab.session('invr-a');
			const B = await lab.session('invr-b');
			const paused = pausingDb(A.db);
			const resend = resendInvitation(
				paused.db,
				{ organizationId: o.id, actorUserId: admin.userId, actorPermissions: ALL },
				id
			);
			await paused.reached.wait();
			const accept = acceptInvitation(B.db, { token, principalUserId: null, ...onboarding });
			await waitForLockWait(monitor.sql, B.appName);
			paused.release.notify();
			const [rr, ra] = await withTimeout(settle([resend, accept]), SCENARIO_TIMEOUT_MS, 'resend');
			log('#3d', `resend=${rr.status} accept(old token)=${ra.status}:${errorCode(ra.reason)}`);
			assert.equal(rr.status, 'fulfilled');
			assert.equal(errorCode(ra.reason), 'INVALID_INVITATION', 'el token anterior ya no es válido');
			assert.equal(await identitiesFor(email), 0);
			assert.equal(await statusOf(id), 'pending');
			// the new token works exactly once
			await acceptInvitation(monitor.db, {
				token: rr.value.delivery.token,
				principalUserId: null,
				...onboarding
			});
			assert.equal(await statusOf(id), 'accepted');
		}
	);

	await t.test('#3e aceptación en curso vs revocación: estado final coherente', async () => {
		const email = newEmail();
		const { o, token, id } = await invite(email);
		const A = await lab.session('invk-a');
		const B = await lab.session('invk-b');
		const paused = pausingDb(A.db);
		const accept = acceptInvitation(paused.db, { token, principalUserId: null, ...onboarding });
		await paused.reached.wait();
		const revoke = revokeInvitation(B.db, o.id, id);
		await waitForLockWait(monitor.sql, B.appName);
		paused.release.notify();
		const [ra, rk] = await withTimeout(settle([accept, revoke]), SCENARIO_TIMEOUT_MS, 'revoke');
		log(
			'#3e',
			`accept=${ra.status} revoke=${rk.status}:${rk.status === 'rejected' ? errorCode(rk.reason) : ''}`
		);
		assert.equal(ra.status, 'fulfilled');
		assert.equal(rk.status, 'rejected', 'una invitación aceptada no se puede revocar');
		assert.equal(await statusOf(id), 'accepted');
		assert.equal(await identitiesFor(email), 1);
	});
});

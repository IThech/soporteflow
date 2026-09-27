import test from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import {
	errorCode,
	log,
	pausingDb,
	settle,
	waitForForeignLockWait,
	waitForLockWait,
	withTimeout,
	SCENARIO_TIMEOUT_MS
} from './lab.mjs';
import { createLab, LAB_ORIGIN } from './setup.mjs';

test('5.4W-A #1-#2: último administrador y TOCTOU de autorización (PostgreSQL real)', async (t) => {
	const lab = await createLab(t);
	const { monitor, fixtures: fx, schema: s, load } = lab;
	const { revokeRoleFromMembership } = await load('/src/lib/server/services/memberships.ts');
	const { createCustomRole, updateCustomRole, countTenantAdministrators } = await load(
		'/src/lib/server/services/roles.ts'
	);
	const { PERMISSION_IDS } = await load('/src/lib/server/auth/permissions.ts');
	const ALL = PERMISSION_IDS;
	const admins = (o) => countTenantAdministrators(monitor.db, o.id);
	const assignmentOf = async (m, roleId) =>
		(
			await monitor.db
				.select()
				.from(s.roleAssignments)
				.where(
					and(
						eq(s.roleAssignments.membershipId, m.membershipId),
						eq(s.roleAssignments.roleId, roleId)
					)
				)
		).length;

	await t.test(
		'#1a dos revocaciones concurrentes de los 2 últimos admins: nunca 0 admins',
		async () => {
			const o = await fx.organization('last-admin');
			const x = await fx.member(o, [o.admin]);
			const y = await fx.member(o, [o.admin]);
			assert.equal(await admins(o), 2);
			const A = await lab.session('la-a');
			const B = await lab.session('la-b');
			const paused = pausingDb(A.db, { at: 'beforeCommit' });
			const first = revokeRoleFromMembership(paused.db, o.id, x.membershipId, o.admin.id, ALL);
			await paused.reached.wait(); // A deleted X's admin role and holds the organization lock
			const second = revokeRoleFromMembership(B.db, o.id, y.membershipId, o.admin.id, ALL);
			await waitForLockWait(monitor.sql, B.appName); // B really waits on A's lock
			paused.release.notify();
			const [ra, rb] = await withTimeout(
				settle([first, second]),
				SCENARIO_TIMEOUT_MS,
				'last-admin'
			);
			log(
				'#1a',
				`A=${ra.status} B=${rb.status}:${rb.status === 'rejected' ? errorCode(rb.reason) : ''}`
			);
			assert.equal(ra.status, 'fulfilled');
			assert.equal(rb.status, 'rejected');
			assert.equal(errorCode(rb.reason), 'LAST_ADMIN_REQUIRED');
			assert.equal(await admins(o), 1);
			assert.equal(await assignmentOf(y, o.admin.id), 1);
		}
	);

	await t.test('#1b carrera sin coordinación (Promise.all x10): nunca 0 admins', async () => {
		for (let i = 0; i < 10; i++) {
			const o = await fx.organization('last-admin-free');
			const x = await fx.member(o, [o.admin]);
			const y = await fx.member(o, [o.admin]);
			const A = await lab.session(`laf-a${i}`);
			const B = await lab.session(`laf-b${i}`);
			const results = await withTimeout(
				settle([
					revokeRoleFromMembership(A.db, o.id, x.membershipId, o.admin.id, ALL),
					revokeRoleFromMembership(B.db, o.id, y.membershipId, o.admin.id, ALL)
				]),
				SCENARIO_TIMEOUT_MS,
				'last-admin-free'
			);
			assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, `iteración ${i}`);
			assert.equal(
				errorCode(results.find((r) => r.status === 'rejected').reason),
				'LAST_ADMIN_REQUIRED'
			);
			assert.equal(await admins(o), 1, `iteración ${i}`);
			await A.sql.end();
			await B.sql.end();
		}
	});

	await t.test(
		'#1c revocación + degradación de rol personalizado concurrentes: nunca 0 admins',
		async () => {
			const o = await fx.organization('last-admin-downgrade');
			const x = await fx.member(o, [o.admin]);
			const adminPermissions = (
				await monitor.db
					.select({ id: s.rolePermissions.permissionId })
					.from(s.rolePermissions)
					.where(eq(s.rolePermissions.roleId, o.admin.id))
			).map((r) => r.id);
			const custom = await createCustomRole(monitor.db, o.id, ALL, {
				code: 'lab_full_admin',
				name: 'Lab full admin',
				permissions: adminPermissions
			});
			await fx.member(o, [{ id: custom.id }]);
			assert.equal(await admins(o), 2);
			const A = await lab.session('lad-a');
			const B = await lab.session('lad-b');
			const paused = pausingDb(A.db);
			const revoke = revokeRoleFromMembership(paused.db, o.id, x.membershipId, o.admin.id, ALL);
			await paused.reached.wait();
			const downgrade = updateCustomRole(B.db, o.id, custom.id, ALL, {
				permissions: ['incidents:create']
			});
			await waitForLockWait(monitor.sql, B.appName);
			paused.release.notify();
			const [ra, rb] = await withTimeout(
				settle([revoke, downgrade]),
				SCENARIO_TIMEOUT_MS,
				'downgrade'
			);
			log('#1c', `revoke=${ra.status} downgrade=${rb.status}`);
			assert.equal(ra.status, 'fulfilled');
			assert.equal(errorCode(rb.reason), 'LAST_ADMIN_REQUIRED');
			assert.equal(await admins(o), 1);
		}
	);

	await t.test(
		'#2 TOCTOU: permisos resueltos antes de la tx; el actor pierde admin antes de mutar',
		async () => {
			// Hypothesis H1 (inspection): routes resolve actorPermissions/authorization BEFORE the
			// service transaction and the service never re-checks the actor inside it.
			const o = await fx.organization('toctou');
			const x = await fx.member(o, [o.admin]); // actor of the HTTP request
			await fx.member(o, [o.admin]); // concurrent admin removing x
			const target = await fx.member(o, [o.admin]); // victim of x's request
			const cookie = await fx.session(x.userId);
			const route = await load('/src/routes/api/memberships/[id]/roles/[roleId]/+server.ts');
			const call = (membershipId, roleId) => {
				const url = new URL(
					`${LAB_ORIGIN}/api/memberships/${membershipId}/roles/${roleId}?organizationId=${o.id}`
				);
				return route.DELETE({
					url,
					params: { id: membershipId, roleId },
					request: new Request(url, { method: 'DELETE', headers: { cookie, origin: LAB_ORIGIN } })
				});
			};

			// Control: the lab session really authenticates and authorizes X through the production
			// auth stack (a 401/403 here would make the race meaningless, as in the first CT run).
			const control = await withTimeout(
				call(x.membershipId, o.customer.id),
				SCENARIO_TIMEOUT_MS,
				'control'
			);
			log('#2', `control (unassigned role) status=${control.status}`);
			assert.equal(control.status, 404, 'X autenticado y autorizado (ROLE_ASSIGNMENT_NOT_FOUND)');

			// Y demotes X inside an open transaction holding the organization lock (what every
			// administrator mutation takes first). X's HTTP authorization reads committed state (X is
			// still admin), then X's service transaction blocks on the organization lock.
			const Y = await lab.session('toctou-y');
			let yReady;
			const yHolding = new Promise((r) => (yReady = r));
			let releaseY;
			const yRelease = new Promise((r) => (releaseY = r));
			const yTx = Y.sql.begin(async (sql) => {
				await sql`SELECT id FROM organizations WHERE id = ${o.id} FOR UPDATE`;
				await sql`DELETE FROM role_assignments WHERE membership_id = ${x.membershipId} AND role_id = ${o.admin.id}`;
				yReady();
				await yRelease;
			});
			await yHolding;
			let xSettled = false;
			const request = call(target.membershipId, o.admin.id).finally(() => (xSettled = true));
			// Either X blocks on the lock (it passed authorization with pre-demotion state) or it
			// finished early; the latter must be reported, never mistaken for a race.
			const blocked = await Promise.race([
				waitForForeignLockWait(monitor.sql, [monitor.pid, Y.pid]).then(() => true),
				request.then(() => false)
			]);
			if (!blocked || xSettled) {
				releaseY();
				await yTx.catch(() => {});
				const early = await request;
				assert.fail(`X finished before reaching its transaction: status ${early.status}`);
			}
			log('#2', 'X authorized with pre-demotion state and is blocked in its service transaction');
			releaseY(); // Y commits: X is no longer an administrator
			await withTimeout(yTx, SCENARIO_TIMEOUT_MS, 'toctou-y');
			const response = await withTimeout(request, SCENARIO_TIMEOUT_MS, 'toctou-x');
			const targetStillAdmin = await assignmentOf(target, o.admin.id);
			log(
				'#2',
				`x request status=${response.status}, target admin assignments=${targetStillAdmin}`
			);
			assert.equal(await assignmentOf(x, o.admin.id), 0, 'Y retiró el admin de X');
			assert.notEqual(response.status, 204, 'X ya no es admin: su revocación no debe aplicarse');
			// 5.4W-A H1 fix: X is re-validated inside its transaction after the organization lock.
			assert.equal(response.status, 403, 'rechazo coherente con la API (FORBIDDEN)');
			assert.equal((await response.json()).error.code, 'FORBIDDEN');
			assert.equal(targetStillAdmin, 1, 'el objetivo conserva su rol');
		}
	);

	await t.test(
		'#2b TOCTOU en mutación con lock FOR SHARE (crear webhook): revalidada tras la degradación',
		async () => {
			// Same race on a mutation family whose transaction locks the organization FOR SHARE: the
			// share lock waits for Y's FOR UPDATE, so the re-validation reads the committed demotion.
			const o = await fx.organization('toctou-share');
			const x = await fx.member(o, [o.admin]);
			await fx.member(o, [o.admin]);
			const cookie = await fx.session(x.userId);
			const route = await load('/src/routes/api/webhooks/+server.ts');
			const url = new URL(`${LAB_ORIGIN}/api/webhooks?organizationId=${o.id}`);
			const Y = await lab.session('toctou2-y');
			let yReady;
			const yHolding = new Promise((r) => (yReady = r));
			let releaseY;
			const yRelease = new Promise((r) => (releaseY = r));
			const yTx = Y.sql.begin(async (sql) => {
				await sql`SELECT id FROM organizations WHERE id = ${o.id} FOR UPDATE`;
				await sql`DELETE FROM role_assignments WHERE membership_id = ${x.membershipId} AND role_id = ${o.admin.id}`;
				yReady();
				await yRelease;
			});
			await yHolding;
			let xSettled = false;
			const request = route
				.POST({
					url,
					params: {},
					request: new Request(url, {
						method: 'POST',
						headers: { cookie, origin: LAB_ORIGIN, 'content-type': 'application/json' },
						body: JSON.stringify({
							name: 'Lab',
							targetUrl: 'https://hooks.example.com/toctou',
							eventTypes: ['incident.created']
						})
					})
				})
				.finally(() => (xSettled = true));
			const blocked = await Promise.race([
				waitForForeignLockWait(monitor.sql, [monitor.pid, Y.pid]).then(() => true),
				request.then(() => false)
			]);
			if (!blocked || xSettled) {
				releaseY();
				await yTx.catch(() => {});
				assert.fail(`X finished before reaching its transaction: status ${(await request).status}`);
			}
			releaseY();
			await withTimeout(yTx, SCENARIO_TIMEOUT_MS, 'toctou2-y');
			const response = await withTimeout(request, SCENARIO_TIMEOUT_MS, 'toctou2-x');
			const created = await monitor.db
				.select()
				.from(s.webhookSubscriptions)
				.where(eq(s.webhookSubscriptions.organizationId, o.id));
			log('#2b', `x request status=${response.status}, subscriptions created=${created.length}`);
			assert.equal(response.status, 403);
			assert.equal(created.length, 0, 'nada escrito');
		}
	);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { log, waitForForeignLockWait, withTimeout, SCENARIO_TIMEOUT_MS } from './lab.mjs';
import { createLab, LAB_ORIGIN } from './setup.mjs';

/**
 * 5.4W-B: operational incident mutations re-validate the actor and the incident scope inside
 * their own transaction (withIncidentActor: organization FOR SHARE -> actor -> incident FOR
 * UPDATE). These races need real row locks, so they run only on the lab PostgreSQL (CT 105).
 */
test('5.4W-B #31-#33: autorización transaccional de mutaciones de incidencias (PostgreSQL real)', async (t) => {
	const lab = await createLab(t);
	const { monitor, fixtures: fx, schema: s, load } = lab;
	const detailRoute = await load('/src/routes/api/incidents/[id]/+server.ts');
	const commentsRoute = await load('/src/routes/api/incidents/[id]/comments/+server.ts');

	const reload = async (id) =>
		(await monitor.db.select().from(s.incidents).where(eq(s.incidents.id, id)))[0];
	const historyCount = async (id) =>
		(await monitor.db.select().from(s.incidentHistory).where(eq(s.incidentHistory.incidentId, id)))
			.length;
	const messageCount = async (id) =>
		(
			await monitor.db
				.select()
				.from(s.incidentMessages)
				.where(eq(s.incidentMessages.incidentId, id))
		).length;

	/**
	 * Y opens a transaction, runs `hold` (which takes the conflicting lock and applies the change)
	 * and keeps it open; X sends the HTTP request, which must block on Y's lock inside its own
	 * transaction; then Y commits and X must observe the committed state.
	 */
	async function raceRoute(label, hold, send) {
		const Y = await lab.session(`${label}-y`);
		let yReady;
		const yHolding = new Promise((r) => (yReady = r));
		let releaseY;
		const yRelease = new Promise((r) => (releaseY = r));
		const yTx = Y.sql.begin(async (sql) => {
			await hold(sql);
			yReady();
			await yRelease;
		});
		await yHolding;
		let xSettled = false;
		const request = send().finally(() => (xSettled = true));
		const blocked = await Promise.race([
			waitForForeignLockWait(monitor.sql, [monitor.pid, Y.pid]).then(() => true),
			request.then(() => false)
		]);
		if (!blocked || xSettled) {
			releaseY();
			await yTx.catch(() => {});
			assert.fail(`${label}: X finished before blocking: status ${(await request).status}`);
		}
		releaseY();
		await withTimeout(yTx, SCENARIO_TIMEOUT_MS, `${label}-y`);
		const response = await withTimeout(request, SCENARIO_TIMEOUT_MS, `${label}-x`);
		const text = await response.text();
		log(label, `x status=${response.status}`);
		return { status: response.status, json: text ? JSON.parse(text) : null };
	}
	const patchIncident = (cookie, o, id, body) => () => {
		const url = new URL(`${LAB_ORIGIN}/api/incidents/${id}?organizationId=${o.id}`);
		return detailRoute.PATCH({
			url,
			params: { id },
			request: new Request(url, {
				method: 'PATCH',
				headers: { cookie, origin: LAB_ORIGIN, 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		});
	};

	await t.test(
		'#31 técnico pierde incidents:edit mientras su PATCH espera: 403 y nada escrito',
		async () => {
			const o = await fx.organization('wb-revoke');
			const admin = await fx.member(o, [o.admin]);
			const tech = await fx.member(o, [o.tech]);
			const inc = await fx.incident(o, admin);
			const cookie = await fx.session(tech.userId);
			const before = await historyCount(inc.id);
			const res = await raceRoute(
				'#31',
				async (sql) => {
					// same lock the role/membership administration takes before revoking
					await sql`SELECT id FROM organizations WHERE id = ${o.id} FOR UPDATE`;
					await sql`DELETE FROM role_assignments WHERE membership_id = ${tech.membershipId} AND role_id = ${o.tech.id}`;
				},
				patchIncident(cookie, o, inc.id, { priority: 'urgent' })
			);
			assert.equal(res.status, 403);
			assert.equal(res.json.error.code, 'FORBIDDEN');
			assert.equal((await reload(inc.id)).priority, inc.priority, 'prioridad intacta');
			assert.equal(await historyCount(inc.id), before, 'sin historial');
		}
	);

	await t.test(
		'#32 membership desactivada mientras el comentario espera: 403 y ningún mensaje',
		async () => {
			const o = await fx.organization('wb-membership');
			const admin = await fx.member(o, [o.admin]);
			const tech = await fx.member(o, [o.tech]);
			const inc = await fx.incident(o, admin);
			const cookie = await fx.session(tech.userId);
			const url = new URL(`${LAB_ORIGIN}/api/incidents/${inc.id}/comments?organizationId=${o.id}`);
			const res = await raceRoute(
				'#32',
				async (sql) => {
					await sql`SELECT id FROM organizations WHERE id = ${o.id} FOR UPDATE`;
					await sql`UPDATE memberships SET active = false WHERE id = ${tech.membershipId}`;
				},
				() =>
					commentsRoute.POST({
						url,
						params: { id: inc.id },
						request: new Request(url, {
							method: 'POST',
							headers: { cookie, origin: LAB_ORIGIN, 'content-type': 'application/json' },
							body: JSON.stringify({ body: 'Respuesta tardía' })
						})
					})
			);
			assert.equal(res.status, 403);
			assert.equal(await messageCount(inc.id), 0, 'nada escrito');
		}
	);

	await t.test(
		'#33 view_own: la incidencia se reasigna a otro mientras el PATCH espera: 404 y nada escrito',
		async () => {
			const o = await fx.organization('wb-reassign');
			const admin = await fx.member(o, [o.admin]);
			const [ownRole] = await monitor.db
				.insert(s.roles)
				.values({ organizationId: o.id, name: 'Own', code: 'wb_own', isCustom: true })
				.returning();
			for (const permissionId of ['incidents:view_own', 'incidents:edit'])
				await monitor.db.insert(s.rolePermissions).values({ roleId: ownRole.id, permissionId });
			const own = await fx.member(o, [ownRole]);
			const other = await fx.member(o, [o.tech]);
			const inc = await fx.incident(o, admin);
			await monitor.db
				.update(s.incidents)
				.set({ assignedToUserId: own.userId })
				.where(eq(s.incidents.id, inc.id));
			const cookie = await fx.session(own.userId);
			const before = await historyCount(inc.id);
			const res = await raceRoute(
				'#33',
				// the reassignment holds the incident row lock (no organization lock involved)
				(sql) =>
					sql`UPDATE incidents SET assigned_to_user_id = ${other.userId} WHERE id = ${inc.id}`,
				patchIncident(cookie, o, inc.id, { priority: 'urgent' })
			);
			assert.equal(res.status, 404, 'fuera de su alcance tras la reasignación');
			assert.equal(res.json.error.code, 'INCIDENT_NOT_FOUND');
			const row = await reload(inc.id);
			assert.equal(row.priority, inc.priority);
			assert.equal(row.assignedToUserId, other.userId);
			assert.equal(await historyCount(inc.id), before);
		}
	);
});

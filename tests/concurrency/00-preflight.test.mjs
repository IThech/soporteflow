import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { assertLabDatabaseName, log, withTimeout, SCENARIO_TIMEOUT_MS } from './lab.mjs';
import { createLab } from './setup.mjs';

test('5.4W-A preflight: PostgreSQL real, aislamiento, sesiones independientes, Proxy', async (t) => {
	const lab = await createLab(t);
	const { monitor, fixtures: fx, schema: s, load } = lab;

	await t.test('salvaguardas: solo bases de laboratorio claramente identificadas', () => {
		for (const ok of ['soporteflow_concurrency_lab', 'soporteflow_test', 'lab_soporteflow'])
			assert.equal(assertLabDatabaseName(ok), ok);
		for (const bad of [
			'soporteflow',
			'production',
			'prod',
			'soporteflow_prod_lab',
			'postgres',
			'template1',
			'soporteflowlab',
			'Soporteflow_Lab',
			'soporteflow-lab'
		])
			assert.throws(() => assertLabDatabaseName(bad), /LAB SAFETY/, bad);
		assert.equal(lab.target.database, lab.target.redacted.split('/').at(-1));
		assert.ok(!lab.target.redacted.includes(':' + new URL(lab.target.url).password + '@'));
	});

	await t.test('servidor PostgreSQL real (no PGlite) y nivel de aislamiento', async () => {
		const [info] = await monitor.sql`
			SELECT version() AS version,
			       current_setting('default_transaction_isolation') AS isolation,
			       current_setting('lock_timeout') AS lock_timeout,
			       current_setting('statement_timeout') AS statement_timeout,
			       inet_server_port() AS port`;
		assert.match(info.version, /^PostgreSQL \d+/);
		assert.doesNotMatch(info.version, /pglite|emscripten|wasm/i);
		log('preflight', `server ${String(info.version).split(' ')[1]}, default ${info.isolation}`);
		assert.equal(info.isolation, 'read committed', 'las garantías NO dependen de SERIALIZABLE');
		assert.notEqual(info.lock_timeout, '0');
		assert.notEqual(info.statement_timeout, '0');
		const isolationInTx = await monitor.db.transaction(async (tx) => {
			const [row] = await tx.execute(
				(await import('drizzle-orm')).sql`SELECT current_setting('transaction_isolation') AS level`
			);
			return row.level;
		});
		assert.equal(isolationInTx, 'read committed', 'drizzle transaction() usa READ COMMITTED');
	});

	await t.test(
		'dos sesiones independientes: backends distintos y bloqueo real entre ellas',
		async () => {
			const a = await lab.session('pre-a');
			const b = await lab.session('pre-b');
			assert.notEqual(a.pid, b.pid);
			const o = await fx.organization('preflight');
			const holding = a.sql.begin(async (sql) => {
				await sql`SELECT id FROM organizations WHERE id = ${o.id} FOR UPDATE`;
				await new Promise((r) => setTimeout(r, 300));
				return 'released';
			});
			await new Promise((r) => setTimeout(r, 50));
			const started = Date.now();
			const waiting = b.sql`SELECT id FROM organizations WHERE id = ${o.id} FOR UPDATE NOWAIT`;
			await assert.rejects(
				waiting,
				(e) => e.code === '55P03',
				'NOWAIT: la fila está bloqueada por A'
			);
			assert.equal(await withTimeout(holding, SCENARIO_TIMEOUT_MS, 'holding'), 'released');
			assert.ok(Date.now() - started < 5000);
		}
	);

	await t.test('automation_events append-only en PostgreSQL real', async () => {
		const o = await fx.organization('append-only');
		const creator = await fx.member(o, [o.admin]);
		const inc = await fx.incident(o, creator);
		const [event] = await monitor.db
			.select()
			.from(s.automationEvents)
			.where(eq(s.automationEvents.aggregateId, inc.id));
		assert.ok(event);
		await assert.rejects(
			monitor.sql`UPDATE automation_events SET payload = '{}'::jsonb WHERE id = ${event.id}`,
			/append-only/
		);
	});

	await t.test('#20 regresión del Proxy de db: `transaction` in db y rollback real', async () => {
		const appDb = await load('/src/lib/server/db/index.ts');
		assert.equal('transaction' in appDb.db, true, "'transaction' in db debe ser true (has trap)");
		assert.equal(typeof appDb.db.transaction, 'function');
		const { revokeRoleFromMembership } = await load('/src/lib/server/services/memberships.ts');
		const { PERMISSION_IDS } = await load('/src/lib/server/auth/permissions.ts');
		const o = await fx.organization('proxy');
		const onlyAdmin = await fx.member(o, [o.admin]);
		// Deleting the only admin assignment is rejected AFTER the DELETE ran: only a real
		// transaction through the Proxy can undo it.
		await assert.rejects(
			revokeRoleFromMembership(appDb.db, o.id, onlyAdmin.membershipId, o.admin.id, PERMISSION_IDS),
			(e) => e.code === 'LAST_ADMIN_REQUIRED'
		);
		const rows = await monitor.db
			.select()
			.from(s.roleAssignments)
			.where(eq(s.roleAssignments.membershipId, onlyAdmin.membershipId));
		assert.equal(rows.length, 1, 'la asignación sigue: el Proxy entró en transacción');
		// Same statement pair inside db.transaction via the Proxy shares one backend transaction.
		const ids = await appDb.db.transaction(async (tx) => {
			const [x] = await tx.execute((await import('drizzle-orm')).sql`SELECT txid_current() AS id`);
			const [y] = await tx.execute((await import('drizzle-orm')).sql`SELECT txid_current() AS id`);
			return [String(x.id), String(y.id)];
		});
		assert.equal(ids[0], ids[1]);
	});

	await t.test(
		'#21 parámetros Date en PostgreSQL real: processors y retención (regresión 1ª ejecución CT 105)',
		async () => {
			// First CT run: processAutomationExecutions failed with ERR_INVALID_ARG_TYPE because a JS
			// Date was interpolated in a raw sql template (drizzle's postgres-js serializers pass
			// timestamps through). Every Date-taking processor/retention entry point runs here on real
			// PostgreSQL, inside one transaction that is always rolled back (no lab side effects).
			const automation = await load('/src/lib/server/services/automation-processor.ts');
			const rules = await load('/src/lib/server/services/automation-rules.ts');
			const webhooks = await load('/src/lib/server/services/webhook-deliveries.ts');
			const emails = await load('/src/lib/server/services/notification-deliveries.ts');
			const ROLLBACK = new Error('LAB_ROLLBACK');
			const calls = [];
			await assert.rejects(
				monitor.db.transaction(async (tx) => {
					const epoch = new Date(0);
					const run = async (name, fn) => {
						await fn();
						calls.push(name);
					};
					await run('processAutomationExecutions', () =>
						automation.processAutomationExecutions(tx, { now: epoch, limit: 1 })
					);
					await run('deleteOldAutomationExecutions', () =>
						rules.deleteOldAutomationExecutions(tx, epoch)
					);
					await run('claimDueWebhookDeliveries', () =>
						webhooks.claimDueWebhookDeliveries(tx, { now: epoch })
					);
					await run('deleteOldWebhookDeliveries', () =>
						webhooks.deleteOldWebhookDeliveries(tx, { before: epoch })
					);
					await run('claimDueDeliveries', () => emails.claimDueDeliveries(tx, { now: epoch }));
					await run('deleteOldNotificationDeliveries', () =>
						emails.deleteOldNotificationDeliveries(tx, { before: epoch })
					);
					throw ROLLBACK;
				}),
				(e) => e === ROLLBACK
			);
			log('#21', `Date-taking entry points OK on real PostgreSQL: ${calls.length}`);
			assert.equal(calls.length, 6);
		}
	);
});

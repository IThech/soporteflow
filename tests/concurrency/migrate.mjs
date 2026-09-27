#!/usr/bin/env node
/**
 * 5.4W-A: applies ALL drizzle migrations (0000..HEAD) to the lab PostgreSQL database with the
 * production migrator (drizzle-orm/postgres-js/migrator), then verifies the result.
 *
 *   DATABASE_URL=postgresql://…/soporteflow_concurrency_lab node tests/concurrency/migrate.mjs
 *   … node tests/concurrency/migrate.mjs --reset-lab-database   (drops ONLY the lab schemas first)
 *
 * --reset-lab-database drops and recreates the `public` and `drizzle` schemas inside the
 * verified lab database (never DROP DATABASE, never another database).
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { closeAll, connect, labTarget, LabSafetyError } from './lab.mjs';
import { journal, migrationsFolder } from './setup.mjs';

const reset = process.argv.includes('--reset-lab-database');

async function main() {
	const target = labTarget();
	console.log(`[lab] target: ${target.redacted}`);
	const { sql, db } = await connect('migrate');
	const [info] = await sql`
		SELECT current_database() AS db, current_user AS usr, version() AS version,
		       current_setting('server_version_num')::int AS num,
		       current_setting('default_transaction_isolation') AS isolation`;
	console.log(`[lab] server: ${String(info.version).split(' ').slice(0, 2).join(' ')}`);
	console.log(`[lab] database=${info.db} user=${info.usr} default_isolation=${info.isolation}`);
	if (info.num < 130000) throw new LabSafetyError('PostgreSQL >= 13 required (gen_random_uuid)');

	if (reset) {
		console.log('[lab] resetting schemas public + drizzle inside the lab database');
		await sql.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
		await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
		await sql.unsafe('CREATE SCHEMA public');
	}

	const expected = journal().entries.map((e) => e.tag);
	await migrate(db, { migrationsFolder });
	const [applied] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
	console.log(
		`[lab] migrations applied: ${applied.n}/${expected.length} (last: ${expected.at(-1)})`
	);
	if (applied.n !== expected.length) throw new Error('migration count mismatch (drift)');

	// Structural spot checks on the real server (constraints, triggers, indexes, composite FKs).
	const checks = {
		constraints: await sql`
			SELECT conname FROM pg_constraint WHERE conname = ANY(${[
				'webhook_deliveries_subscription_event_unique',
				'notification_deliveries_state_check',
				'webhook_deliveries_state_check',
				'automation_events_depth_check',
				'webhook_deliveries_subscription_fk',
				'notification_preferences_override_check'
			]})`,
		triggers: await sql`
			SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'automation_events_append_only'`,
		executions: await sql`
			SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'automation_executions'`
	};
	console.log(
		`[lab] constraints found: ${checks.constraints.length}/6, append-only trigger: ${checks.triggers.length}, automation_executions table: ${checks.executions[0].n}`
	);
	if (
		checks.constraints.length !== 6 ||
		checks.triggers.length !== 1 ||
		checks.executions[0].n !== 1
	)
		throw new Error('schema verification failed');
	console.log('[lab] OK — lab database migrated and verified');
}

main()
	.catch((error) => {
		console.error(`[lab] FAILED: ${error?.message ?? error}`);
		if (error?.cause?.message) console.error(`[lab] cause: ${error.cause.message}`);
		process.exitCode = 1;
	})
	.finally(() => closeAll());

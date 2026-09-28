/**
 * 5.4W-A lab setup: loads the REAL SoporteFlow modules through Vite SSR (same mechanism as the
 * unit tests) but WITHOUT the PGlite virtual database: `$lib/server/db` is the production module,
 * so routes and the db Proxy talk to the lab PostgreSQL through their own pool.
 *
 * Fixtures create fresh, uniquely named organizations/users per scenario; nothing is shared
 * between scenarios and nothing outside the lab database is touched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { closeAll, connect, labTarget, log } from './lab.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const migrationsFolder = path.join(root, 'drizzle/migrations');
export const LAB_AUTH_SECRET = 'synthetic-concurrency-lab-secret-0123456789';
export const LAB_ORIGIN = 'http://localhost';
export const RUN_ID = randomBytes(4).toString('hex');

export function journal() {
	return JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
}

async function createLabServer(target) {
	return createServer({
		root,
		configFile: false,
		envDir: false,
		logLevel: 'error',
		server: { middlewareMode: true, hmr: false, watch: null },
		appType: 'custom',
		resolve: { alias: { $lib: path.resolve(root, 'src/lib') } },
		plugins: [
			{
				name: 'soporteflow-concurrency-lab-env',
				resolveId(id) {
					if (id === '$env/dynamic/private') return '\0$env/dynamic/private';
					if (id === '$app/environment') return '\0$app/environment';
				},
				load(id) {
					if (id === '\0$env/dynamic/private')
						return `export const env = {
							BETTER_AUTH_ENABLED: 'true',
							BETTER_AUTH_SECRET: ${JSON.stringify(LAB_AUTH_SECRET)},
							BETTER_AUTH_URL: ${JSON.stringify(LAB_ORIGIN)},
							DATABASE_URL: ${JSON.stringify(target.url)}
						};`;
					if (id === '\0$app/environment')
						return `export const building = false;\nexport const dev = true;`;
				}
			}
		]
	});
}

/**
 * Per test file: Vite loader, schema, a monitor connection, migration preflight and fixtures.
 * Registers cleanup on `t.after`.
 */
export async function createLab(t) {
	const target = labTarget();
	process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString('hex');
	// 5.4W-E: keep the lab output readable; LOG_LEVEL=info shows worker/security events.
	process.env.LOG_LEVEL ??= 'silent';
	const server = await createLabServer(target);
	const load = (p) => server.ssrLoadModule(p);
	// Cleanup is registered before any connection so a failed preflight never leaves the process
	// hanging on an open Vite server or pool.
	t.after(async () => {
		try {
			const appDb = await load('/src/lib/server/db/index.ts');
			// the production module keeps its own pool; close it if it was opened
			const instance = appDb.getDb?.();
			await instance?.$client?.end?.({ timeout: 2 });
		} catch {
			// not opened
		}
		await closeAll();
		await server.close();
	});
	const schema = await load('/src/lib/server/db/schema/index.ts');
	const monitor = await connect('monitor', schema);

	// Preflight: the lab database must be fully migrated (npm run test:concurrency:migrate).
	const expected = journal().entries.length;
	const [applied] = await monitor.sql`
		SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`.catch(() => [{ n: -1 }]);
	if (applied.n !== expected)
		throw new Error(
			`[LAB] lab database has ${applied.n} applied migrations, expected ${expected}. ` +
				'Run: npm run test:concurrency:migrate'
		);

	const fixtures = createFixtures({ db: monitor.db, schema, load });
	return {
		target,
		server,
		load,
		schema,
		monitor,
		fixtures,
		/** A new independent session bound to the lab schema. */
		session: (label) => connect(label, schema)
	};
}

export function createFixtures({ db, schema: s, load }) {
	let rolesModule;
	const roles = async () => (rolesModule ??= await load('/src/lib/server/services/roles.ts'));

	async function organization(name = 'org') {
		const [org] = await db
			.insert(s.organizations)
			.values({ name: `WA ${name}`, slug: `wa-${RUN_ID}-${randomUUID()}`, status: 'active' })
			.returning();
		const { ensureOrganizationRoles } = await roles();
		const { roles: created } = await ensureOrganizationRoles(db, org.id);
		const byCode = (code) => created.find((r) => r.code === code);
		return {
			org,
			id: org.id,
			admin: byCode('organization_admin'),
			tech: byCode('technician'),
			customer: byCode('customer')
		};
	}

	/** users + primary user_emails + auth_users (enough for Better Auth sessions). */
	async function user(name = 'Lab user') {
		const email = `wa-${RUN_ID}-${randomUUID()}@example.test`;
		const [u] = await db.insert(s.users).values({ name }).returning();
		await db.insert(s.userEmails).values({ userId: u.id, email, isPrimary: true });
		await db.insert(s.authUsers).values({ id: u.id, name, email });
		return { ...u, email };
	}

	async function member(o, roleRows = [], existing) {
		const u = existing ?? (await user());
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: o.id, userId: u.id, active: true })
			.returning();
		for (const role of roleRows)
			await db.insert(s.roleAssignments).values({
				organizationId: o.id,
				membershipId: membership.id,
				roleId: role.id,
				scopeType: 'organization'
			});
		return { user: u, membership, userId: u.id, membershipId: membership.id };
	}

	/** Signed Better Auth session cookie for route-level scenarios. */
	async function session(userId) {
		const token = randomUUID();
		await db.insert(s.authSessions).values({
			userId,
			token,
			expiresAt: new Date(Date.now() + 3_600_000),
			createdAt: new Date(Date.now() - 60_000),
			updatedAt: new Date(Date.now() - 60_000)
		});
		const signature = createHmac('sha256', LAB_AUTH_SECRET).update(token).digest('base64');
		return `soporteflow-auth.session_token=${encodeURIComponent(token + '.' + signature)}`;
	}

	async function incident(o, creator, input = {}) {
		const { createIncidentRecord } = await load('/src/lib/server/services/incidents.ts');
		const { incident: row } = await createIncidentRecord(
			db,
			{ organizationId: o.id, creatorUserId: creator.userId },
			{ title: 'Lab incident', description: 'Lab', client: 'Lab client', ...input }
		);
		return row;
	}

	return { organization, user, member, session, incident };
}

export { log };

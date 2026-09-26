import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { applyMigrations } from './persistence-migrations.mjs';
import { createHmac, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const directory = path.join(root, 'drizzle/migrations');
export const expectedMigrations = [
	'0000_regular_masque.sql',
	'0001_authentication.sql',
	'0002_incidents.sql',
	'0003_keen_namora.sql',
	'0004_curious_morlocks.sql',
	'0005_flippant_abomination.sql',
	'0006_gifted_princess_powerful.sql',
	'0007_polite_rictor.sql',
	'0008_smooth_james_howlett.sql',
	'0009_lumpy_hellion.sql',
	'0010_odd_angel.sql',
	'0011_permissions_catalog.sql',
	'0012_role_templates.sql',
	'0013_roles_admin_permissions.sql',
	'0014_memberships_admin_permissions.sql',
	'0015_invitations_customer.sql',
	'0016_invitation_role_snapshot.sql',
	'0017_sla_policies.sql'
];

export const TEST_SECRET = 'synthetic-phase-b-only-secret-123456789';
export const TEST_ORIGIN = 'http://localhost';

export async function fixture(t, migrate = true) {
	const pg = new PGlite();
	t.after(() => pg.close());

	const server = await createServer({
		root,
		configFile: false,
		envDir: false,
		server: { middlewareMode: true, hmr: false, watch: null },
		appType: 'custom',
		resolve: {
			alias: {
				$lib: path.resolve(root, 'src/lib')
			}
		},
		plugins: [
			{
				name: 'soporteflow-test-virtuals',
				resolveId(id) {
					if (id === '$env/dynamic/private') return '\0$env/dynamic/private';
					if (id === '$app/environment') return '\0$app/environment';
					if (id === '$lib/server/db') return '\0virtual:soporteflow-test-db';
				},
				load(id) {
					if (id === '\0$env/dynamic/private') {
						return `export const env = {
							BETTER_AUTH_ENABLED: 'true',
							BETTER_AUTH_SECRET: ${JSON.stringify(TEST_SECRET)},
							BETTER_AUTH_URL: ${JSON.stringify(TEST_ORIGIN)},
							DATABASE_URL: 'postgresql://synthetic:synthetic@invalid.example/test'
						};`;
					}
					if (id === '\0$app/environment') {
						return `export const building = false;\nexport const dev = true;`;
					}
					const normId = id.split('\\').join('/');
					if (
						id === '\0virtual:soporteflow-test-db' ||
						normId.endsWith('/src/lib/server/db/index.ts') ||
						normId.endsWith('/src/lib/server/db')
					) {
						return `
							export function getDb() {
								const db = globalThis.__SOPORTEFLOW_ACTIVE_TEST_DB__;
								if (!db) throw new Error("No active test PGlite database attached.");
								return db;
							}
							export const db = new Proxy({}, {
								get(_target, prop, receiver) {
									const instance = getDb();
									const val = Reflect.get(instance, prop, receiver);
									return typeof val === 'function' ? val.bind(instance) : val;
								},
								has(_target, prop) {
									return Reflect.has(getDb(), prop);
								}
							});
							export class DatabaseConfigurationError extends Error {
								constructor(message = 'DATABASE_URL error') {
									super(message);
									this.name = 'DatabaseConfigurationError';
								}
							}
							export * from '/src/lib/server/db/schema/index.ts';
						`;
					}
				}
			}
		]
	});
	t.after(() => server.close());

	const schema = await server.ssrLoadModule('/src/lib/server/db/schema/index.ts');
	if (migrate) assert.deepEqual(await applyMigrations(pg, directory), expectedMigrations);

	const db = drizzle(pg, { schema });
	globalThis.__SOPORTEFLOW_ACTIVE_TEST_DB__ = db;
	t.after(() => {
		if (globalThis.__SOPORTEFLOW_ACTIVE_TEST_DB__ === db) {
			globalThis.__SOPORTEFLOW_ACTIVE_TEST_DB__ = null;
		}
	});

	return { pg, schema, db, server };
}

export async function identity(f, withProfile = true) {
	const [user] = await f.db
		.insert(f.schema.users)
		.values({ name: 'Synthetic identity' })
		.returning();
	const email = user.id + '@example.test';
	const [contact] = await f.db
		.insert(f.schema.userEmails)
		.values({ userId: user.id, email })
		.returning();
	if (withProfile)
		await f.db.insert(f.schema.authUsers).values({ id: user.id, name: user.name, email });
	return { id: user.id, email, contactId: contact.id };
}

export async function createCredentialUser(f, options = {}) {
	const [user] = await f.db
		.insert(f.schema.users)
		.values({ name: options.name ?? 'Credential User', active: options.active ?? true })
		.returning();
	const email = options.email ?? `${user.id}@example.test`;
	const password = options.password ?? 'Password12345!';
	const [contact] = await f.db
		.insert(f.schema.userEmails)
		.values({ userId: user.id, email })
		.returning();
	const [authUser] = await f.db
		.insert(f.schema.authUsers)
		.values({ id: user.id, name: user.name, email })
		.returning();
	const hashedPassword = await hashPassword(password);
	const [account] = await f.db
		.insert(f.schema.authAccounts)
		.values({
			userId: user.id,
			providerId: 'credential',
			accountId: user.id,
			password: hashedPassword
		})
		.returning();

	return {
		user,
		authUser,
		account,
		email,
		password,
		contactId: contact.id,
		id: user.id
	};
}

export async function createSession(f, userId, options = {}) {
	const token = options.token ?? randomUUID();
	const expiresAt = options.expiresAt ?? new Date(Date.now() + 60000);
	const [session] = await f.db
		.insert(f.schema.authSessions)
		.values({
			userId,
			token,
			expiresAt,
			createdAt: options.createdAt ?? new Date(Date.now() - 86400000),
			updatedAt: options.updatedAt ?? new Date(Date.now() - 86400000)
		})
		.returning();
	const secret = options.secret ?? TEST_SECRET;
	const signature = createHmac('sha256', secret).update(token).digest('base64');
	const signed = encodeURIComponent(token + '.' + signature);
	const cookieHeader = `soporteflow-auth.session_token=${signed}`;
	return {
		session,
		token,
		cookieHeader,
		headers: new Headers({ cookie: cookieHeader })
	};
}

export function createTamperedCookie(token = randomUUID()) {
	const signature = createHmac('sha256', 'wrong-secret-tampered').update(token).digest('base64');
	return `soporteflow-auth.session_token=${encodeURIComponent(token + '.' + signature)}`;
}

export async function grantPermission(
	f,
	{ organizationId, membershipId, permissionId = 'incidents:create' }
) {
	await f.db
		.insert(f.schema.permissions)
		.values({
			id: permissionId,
			name: permissionId,
			category: 'incidents',
			allowedScopeTypes: ['organization', 'department', 'team', 'site', 'personal']
		})
		.onConflictDoNothing();

	const [role] = await f.db
		.insert(f.schema.roles)
		.values({
			organizationId,
			name: 'Incident Manager ' + randomUUID().slice(0, 8),
			code: 'ROLE_' + randomUUID(),
			active: true
		})
		.returning();

	await f.db
		.insert(f.schema.rolePermissions)
		.values({
			roleId: role.id,
			permissionId
		})
		.onConflictDoNothing();

	const [assignment] = await f.db
		.insert(f.schema.roleAssignments)
		.values({
			organizationId,
			membershipId,
			roleId: role.id,
			scopeType: 'organization'
		})
		.returning();

	return { role, assignment };
}

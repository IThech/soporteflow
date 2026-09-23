import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { applyMigrations } from './persistence-migrations.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const directory = path.join(root, 'drizzle/migrations');
export const expectedMigrations = [
	'0000_regular_masque.sql',
	'0001_authentication.sql',
	'0002_incidents.sql'
];
export async function fixture(t, migrate = true) {
	const server = await createServer({
		configFile: false,
		envDir: false,
		server: { middlewareMode: true, hmr: false, watch: null },
		appType: 'custom'
	});
	t.after(() => server.close());
	const schema = await server.ssrLoadModule('/src/lib/server/db/schema/index.ts');
	const pg = new PGlite();
	t.after(() => pg.close());
	if (migrate) assert.deepEqual(await applyMigrations(pg, directory), expectedMigrations);
	return { pg, schema, db: drizzle(pg, { schema }), server };
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

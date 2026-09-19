import { fixture, identity, directory, expectedMigrations } from './helpers/auth-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

const isUuid = (value) =>
	assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
function errorCode(error) {
	return error?.code ?? error?.cause?.code;
}
async function rejected(operation, code) {
	await assert.rejects(operation, (error) =>
		(Array.isArray(code) ? code : [code]).includes(errorCode(error))
	);
}
async function executeFile(pg, filename) {
	for (const statement of fs
		.readFileSync(path.join(directory, filename), 'utf8')
		.split('--> statement-breakpoint')) {
		if (statement.trim()) await pg.exec(statement);
	}
}
// No getDb import, dotenv loading, disk-backed database or PostgreSQL client.
test('Authentication 0001: constraints on the actual migrated schema', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, pg } = f;
	await t.test('UUIDs, nullability, defaults and explicit shared identity', async () => {
		const p = await identity(f);
		isUuid(p.id);
		const [profile] = await db.select().from(s.authUsers).where(eq(s.authUsers.id, p.id));
		assert.equal(profile.emailVerified, false);
		assert.ok(profile.createdAt instanceof Date);
		await rejected(
			db.insert(s.authUsers).values({ name: 'No identity', email: 'missing@example.test' }),
			'23502'
		);
		await rejected(
			db
				.insert(s.authUsers)
				.values({ id: randomUUID(), name: 'Orphan', email: 'orphan@example.test' }),
			'23503'
		);
		const [account] = await db
			.insert(s.authAccounts)
			.values({
				userId: p.id,
				providerId: 'credential',
				accountId: p.id,
				password: 'synthetic-hash'
			})
			.returning();
		isUuid(account.id);
		const [session] = await db
			.insert(s.authSessions)
			.values({ userId: p.id, token: randomUUID(), expiresAt: new Date(Date.now() + 60000) })
			.returning();
		isUuid(session.id);
		const [verification] = await db
			.insert(s.authVerifications)
			.values({
				identifier: 'synthetic',
				value: 'generic payload',
				expiresAt: new Date(Date.now() + 60000)
			})
			.returning();
		isUuid(verification.id);
		await rejected(
			db.insert(s.authSessions).values({ userId: p.id, expiresAt: new Date() }),
			'23502'
		);
		await rejected(
			db.insert(s.authSessions).values({ userId: p.id, token: randomUUID() }),
			'23502'
		);
	});
	await t.test('email belongs to the same identity; profile is unique', async () => {
		const a = await identity(f),
			b = await identity(f, false);
		await rejected(
			db.insert(s.authUsers).values({ id: b.id, name: 'Wrong owner', email: a.email }),
			'23505'
		);
		// Remove the owner's access profile: ownership still prevents borrowing a contact-only email.
		await db.delete(s.authUsers).where(eq(s.authUsers.id, a.id));
		await rejected(
			db.insert(s.authUsers).values({ id: b.id, name: 'Wrong owner', email: a.email }),
			'23503'
		);
		await db.insert(s.authUsers).values({ id: a.id, name: 'Restored', email: a.email });
		await rejected(
			db.insert(s.authUsers).values({ id: a.id, name: 'Duplicate', email: a.email }),
			'23505'
		);
		await rejected(
			db.insert(s.userEmails).values({ userId: b.id, email: a.email.toUpperCase() }),
			'23505'
		);
		await rejected(
			db.update(s.authUsers).set({ email: b.email }).where(eq(s.authUsers.id, a.id)),
			'23503'
		);
	});
	await t.test(
		'normalization affects new access profiles only; login email need not be primary',
		async () => {
			const p = await identity(f, false);
			assert.equal(
				(await db.select().from(s.userEmails).where(eq(s.userEmails.id, p.contactId)))[0].isPrimary,
				false
			);
			for (const email of ['', p.email.toUpperCase(), ' ' + p.email, p.email + ' '])
				await rejected(
					db.insert(s.authUsers).values({ id: p.id, name: 'Invalid', email }),
					'23514'
				);
			await db
				.insert(s.authUsers)
				.values({ id: p.id, name: 'Valid secondary contact', email: p.email });
		}
	);
	await t.test(
		'credential constraints reject wrong identity and null or empty hashes',
		async () => {
			const p = await identity(f);
			for (const values of [
				{ accountId: randomUUID(), password: 'hash' },
				{ accountId: p.id, password: null },
				{ accountId: p.id, password: '' }
			]) {
				await rejected(
					db.insert(s.authAccounts).values({ userId: p.id, providerId: 'credential', ...values }),
					'23514'
				);
			}
			await db
				.insert(s.authAccounts)
				.values({ userId: p.id, providerId: 'credential', accountId: p.id, password: 'hash' });
			await rejected(
				db
					.insert(s.authAccounts)
					.values({ userId: p.id, providerId: 'credential', accountId: p.id, password: 'other' }),
				'23505'
			);
			await rejected(
				db.update(s.authAccounts).set({ password: null }).where(eq(s.authAccounts.userId, p.id)),
				'23514'
			);
			// Standard optional fields remain usable without enabling OAuth.
			await db.insert(s.authAccounts).values({
				userId: p.id,
				providerId: 'synthetic-provider',
				accountId: 'external-id',
				accessToken: 'synthetic',
				scope: 'test'
			});
			await rejected(
				db
					.insert(s.authAccounts)
					.values({ userId: p.id, providerId: 'synthetic-provider', accountId: 'external-id' }),
				'23505'
			);
		}
	);
	await t.test('account/session FKs and session token uniqueness', async () => {
		const p = await identity(f),
			token = randomUUID();
		await rejected(
			db
				.insert(s.authAccounts)
				.values({ userId: randomUUID(), providerId: 'synthetic', accountId: 'orphan' }),
			'23503'
		);
		await rejected(
			db.insert(s.authSessions).values({ userId: randomUUID(), token, expiresAt: new Date() }),
			'23503'
		);
		await db.insert(s.authSessions).values({ userId: p.id, token, expiresAt: new Date() });
		await rejected(
			db.insert(s.authSessions).values({ userId: p.id, token, expiresAt: new Date() }),
			'23505'
		);
		await db.delete(s.authSessions).where(eq(s.authSessions.token, token));
		assert.equal(
			(await db.select().from(s.authSessions).where(eq(s.authSessions.token, token))).length,
			0
		);
	});
	await t.test(
		'restrict identity/email changes; profile deletion cascades only authentication children',
		async () => {
			const p = await identity(f),
				other = await identity(f, false);
			const [org] = await db
				.insert(s.organizations)
				.values({ name: 'Synthetic', slug: randomUUID() })
				.returning();
			const [membership] = await db
				.insert(s.memberships)
				.values({ organizationId: org.id, userId: p.id })
				.returning();
			await db
				.insert(s.authAccounts)
				.values({ userId: p.id, providerId: 'credential', accountId: p.id, password: 'hash' });
			await db
				.insert(s.authSessions)
				.values({ userId: p.id, token: randomUUID(), expiresAt: new Date() });
			await rejected(db.delete(s.users).where(eq(s.users.id, p.id)), ['23503', '23001']);
			await rejected(db.delete(s.userEmails).where(eq(s.userEmails.id, p.contactId)), [
				'23503',
				'23001'
			]);
			await rejected(
				db
					.update(s.userEmails)
					.set({ email: 'replacement@example.test' })
					.where(eq(s.userEmails.id, p.contactId)),
				['23503', '23001']
			);
			await rejected(
				db.update(s.userEmails).set({ userId: other.id }).where(eq(s.userEmails.id, p.contactId)),
				['23503', '23001']
			);
			await db.delete(s.authUsers).where(eq(s.authUsers.id, p.id));
			for (const table of [s.authAccounts, s.authSessions])
				assert.equal((await db.select().from(table).where(eq(table.userId, p.id))).length, 0);
			assert.equal((await db.select().from(s.users).where(eq(s.users.id, p.id))).length, 1);
			assert.equal(
				(await db.select().from(s.userEmails).where(eq(s.userEmails.id, p.contactId))).length,
				1
			);
			assert.equal(
				(await db.select().from(s.memberships).where(eq(s.memberships.id, membership.id))).length,
				1
			);
		}
	);
	await t.test(
		'generic verification payloads allow repeated identifiers; expiry cleanup indexes exist',
		async () => {
			for (let i = 0; i < 2; i++)
				await db
					.insert(s.authVerifications)
					.values({ identifier: 'repeat', value: 'not-a-user-uuid', expiresAt: new Date(0) });
			assert.equal(
				(
					await db
						.select()
						.from(s.authVerifications)
						.where(eq(s.authVerifications.identifier, 'repeat'))
				).length,
				2
			);
			const { rows } = await pg.query("select indexname from pg_indexes where schemaname='public'");
			const names = new Set(rows.map((r) => r.indexname));
			for (const name of [
				'auth_accounts_user_idx',
				'auth_sessions_user_idx',
				'auth_sessions_expiry_idx',
				'auth_verifications_identifier_idx',
				'auth_verifications_expiry_idx',
				'user_emails_user_email_unique'
			])
				assert.ok(names.has(name), name);
		}
	);
});

test('0000 to 0001 preserves existing Core rows exactly and creates no auth profiles', async (t) => {
	const f = await fixture(t, false);
	await executeFile(f.pg, expectedMigrations[0]);
	const p = await identity(f, false);
	await f.db
		.update(f.schema.userEmails)
		.set({
			email: '  Existing.Mixed@Example.Test  ',
			isPrimary: true,
			verifiedAt: new Date('2026-01-01T00:00:00Z')
		})
		.where(eq(f.schema.userEmails.id, p.contactId));
	const [org] = await f.db
		.insert(f.schema.organizations)
		.values({ name: 'Existing organization', slug: 'existing' })
		.returning();
	await f.db.insert(f.schema.memberships).values({ userId: p.id, organizationId: org.id });
	async function coreRows() {
		const result = {};
		for (const table of ['users', 'user_emails', 'organizations', 'memberships'])
			result[table] = (await f.pg.query(`select * from ${table} order by id`)).rows;
		return result;
	}
	const before = await coreRows();
	await executeFile(f.pg, expectedMigrations[1]);
	assert.deepEqual(await coreRows(), before);
	for (const table of ['auth_users', 'auth_accounts', 'auth_sessions', 'auth_verifications'])
		assert.equal((await f.pg.query(`select count(*)::int as n from ${table}`)).rows[0].n, 0);
});

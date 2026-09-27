import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
	fixture,
	directory,
	createCredentialUser,
	createSession
} from './helpers/auth-fixture.mjs';
import fs from 'node:fs';
import path from 'node:path';

test('5.4U-A notification migration is journal-idempotent and coherent', async () => {
	const pg = new PGlite();
	try {
		const db = drizzle(pg);
		await migrate(db, { migrationsFolder: directory });
		const before = await pg.query('select count(*)::int as n from drizzle.__drizzle_migrations');
		await migrate(db, { migrationsFolder: directory });
		// every journal entry applied once (0021+ appended by later stages); the re-run applies none
		const journal = JSON.parse(fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8'));
		assert.equal(before.rows[0].n, journal.entries.length);
		assert.ok(journal.entries.some((e) => e.tag === '0020_notifications'));
		assert.deepEqual(
			await pg.query('select count(*)::int as n from drizzle.__drizzle_migrations'),
			before
		);
		const snapshot = JSON.parse(
			fs.readFileSync(path.join(directory, 'meta/0020_snapshot.json'), 'utf8')
		);
		assert.ok(snapshot.tables['public.notifications']);
		const migration = fs.readFileSync(path.join(directory, '0020_notifications.sql'), 'utf8');
		assert.ok(!/INSERT INTO|DROP TABLE|UPDATE "/.test(migration));
	} finally {
		await pg.close();
	}
});

test('5.4U-A notifications core and HTTP, in-memory PGlite only', async (t) => {
	const f = await fixture(t),
		{ db, pg, schema: s, server } = f;
	const svc = await server.ssrLoadModule('/src/lib/server/services/notifications.ts');
	const collection = await server.ssrLoadModule('/src/routes/api/notifications/+server.ts');
	const resource = await server.ssrLoadModule('/src/routes/api/notifications/[id]/+server.ts');
	const readAll = await server.ssrLoadModule('/src/routes/api/notifications/read-all/+server.ts');
	const count = await server.ssrLoadModule('/src/routes/api/notifications/unread-count/+server.ts');
	const [orgA, orgB, off] = await db
		.insert(s.organizations)
		.values([
			{ name: 'A', slug: randomUUID(), status: 'active' },
			{ name: 'B', slug: randomUUID(), status: 'active' },
			{ name: 'Off', slug: randomUUID(), status: 'suspended' }
		])
		.returning();
	const a = await createCredentialUser(f),
		b = await createCredentialUser(f),
		onlyB = await createCredentialUser(f);
	const sa = await createSession(f, a.id, { expiresAt: new Date(Date.now() + 3600000) });
	const sb = await createSession(f, b.id, { expiresAt: new Date(Date.now() + 3600000) });
	await db.insert(s.memberships).values([
		{ organizationId: orgA.id, userId: a.id },
		{ organizationId: orgB.id, userId: a.id },
		{ organizationId: orgA.id, userId: b.id },
		{ organizationId: orgB.id, userId: onlyB.id },
		{ organizationId: off.id, userId: a.id }
	]);
	const ca = { organizationId: orgA.id, recipientUserId: a.id },
		cab = { organizationId: orgB.id, recipientUserId: a.id },
		cb = { organizationId: orgA.id, recipientUserId: b.id };
	const input = { type: 'synthetic.notice', title: 'Notice', message: 'Plain <b>text</b>' };
	const create = (context = ca, extra = {}) =>
		svc.createNotification(db, { ...context, ...input, ...extra });
	const call = async (
		route,
		method = 'GET',
		{
			id,
			org = orgA.id,
			cookie = sa.cookieHeader,
			query = '',
			body,
			origin = 'http://localhost'
		} = {}
	) => {
		const url = new URL(
			'http://localhost/api/notifications' + (id ? '/' + id : '') + '?organizationId=' + org + query
		);
		const headers = new Headers({ origin });
		if (cookie) headers.set('cookie', cookie);
		if (body !== undefined) headers.set('content-type', 'application/json');
		const response = await route[method]({
			url,
			params: { id },
			request: new Request(url, {
				method,
				headers,
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			})
		});
		return {
			status: response.status,
			data: response.status === 204 ? null : await response.json(),
			response
		};
	};
	const reject = (promise, code) => assert.rejects(promise, (e) => e.code === code);
	const own = await create(),
		other = await create(cb),
		otherTenant = await create(cab);
	await t.test(
		'schema columns/nullability/defaults/constraints/indexes and tenant FK',
		async () => {
			const columns = (
				await pg.query(
					"select column_name,is_nullable from information_schema.columns where table_name='notifications'"
				)
			).rows;
			assert.equal(columns.length, 10);
			assert.equal(columns.find((c) => c.column_name === 'read_at').is_nullable, 'YES');
			assert.equal(own.readAt, null);
			assert.ok(own.createdAt);
			assert.ok(own.updatedAt);
			const indexes = (
				await pg.query("select indexname,indexdef from pg_indexes where tablename='notifications'")
			).rows;
			assert.equal(indexes.length, 3);
			assert.ok(indexes.some((i) => i.indexdef.includes('WHERE (read_at IS NULL)')));
			const raw = { ...ca, ...input };
			for (const extra of [
				{ recipientUserId: onlyB.id },
				{ type: 'bad TYPE' },
				{ title: '' },
				{ message: 'x'.repeat(2001) },
				{ payload: [] }
			]) {
				await assert.rejects(db.insert(s.notifications).values({ ...raw, ...extra }));
			}
			assert.deepEqual(Object.keys(own).sort(), [
				'createdAt',
				'id',
				'message',
				'readAt',
				'title',
				'type',
				'updatedAt'
			]);
		}
	);
	for (const [name, ctx] of [
		['missing org', { ...ca, organizationId: randomUUID() }],
		['inactive org', { ...ca, organizationId: off.id }],
		['foreign recipient', { ...ca, recipientUserId: onlyB.id }]
	]) {
		await t.test('create rejects ' + name, () => reject(create(ctx), 'FORBIDDEN'));
	}
	await t.test('inactive recipient and membership rejected service-side', async () => {
		await db.update(s.users).set({ active: false }).where(eq(s.users.id, b.id));
		await reject(create(cb), 'FORBIDDEN');
		await db.update(s.users).set({ active: true }).where(eq(s.users.id, b.id));
		await db
			.update(s.memberships)
			.set({ active: false })
			.where(and(eq(s.memberships.userId, b.id), eq(s.memberships.organizationId, orgA.id)));
		await reject(create(cb), 'FORBIDDEN');
		await db
			.update(s.memberships)
			.set({ active: true })
			.where(and(eq(s.memberships.userId, b.id), eq(s.memberships.organizationId, orgA.id)));
	});
	for (const [name, extra] of [
		['empty title', { title: ' ' }],
		['oversize title', { title: 'x'.repeat(161) }],
		['oversize message', { message: 'x'.repeat(2001) }],
		['type', { type: 'bad type' }],
		['payload array', { payload: [] }],
		['payload secret', { payload: { nested: { accessToken: 'secret' } } }],
		['payload huge', { payload: { text: 'x'.repeat(5000) } }],
		['payload nonfinite', { payload: { number: Infinity } }],
		['payload bigint', { payload: { number: 1n } }],
		['payload undefined', { payload: { value: undefined } }]
	])
		await t.test('invalid input ' + name, () => reject(create(ca, extra), 'INVALID_INPUT'));
	await t.test('circular/prototype payload rejected; metadata never in DTO', async () => {
		const circular = {};
		circular.self = circular;
		await reject(create(ca, { payload: circular }), 'INVALID_INPUT');
		await reject(
			create(ca, { payload: JSON.parse('{"__proto__":{"admin":true}}') }),
			'INVALID_INPUT'
		);
		const dto = await create(ca, { payload: { safe: { items: [1, true, null, 'value'] } } });
		assert.equal('payload' in dto, false);
		assert.deepEqual(
			(await db.select().from(s.notifications).where(eq(s.notifications.id, dto.id)))[0].payload,
			{ safe: { items: [1, true, null, 'value'] } }
		);
	});
	await t.test('no public create POST', () => assert.equal(collection.POST, undefined));
	for (const [name, opts, status] of [
		['no session', { cookie: '' }, 401],
		['invalid cookie', { cookie: 'invalid' }, 401],
		['inactive org', { org: off.id }, 403],
		['no membership', { org: orgB.id, cookie: sb.cookieHeader }, 403]
	]) {
		await t.test('auth ' + name, async () =>
			assert.equal((await call(collection, 'GET', opts)).status, status)
		);
	}
	for (const [name, id] of [
		['other recipient', other.id],
		['other tenant', otherTenant.id],
		['nonexistent', randomUUID()]
	]) {
		for (const method of ['GET', 'PATCH', 'DELETE']) {
			await t.test(method + ' 404 ' + name, async () => {
				const result = await call(resource, method, {
					id,
					...(method === 'PATCH' ? { body: { read: true } } : {})
				});
				assert.equal(result.status, 404);
				assert.equal(result.data.error.code, 'NOTIFICATION_NOT_FOUND');
			});
		}
	}
	await t.test('list/count are own and tenant local without roles', async () => {
		const res = await call(collection);
		assert.equal(res.status, 200);
		assert.ok(res.data.items.some((n) => n.id === own.id));
		assert.ok(!res.data.items.some((n) => [other.id, otherTenant.id].includes(n.id)));
		const nb = await call(count, 'GET', { org: orgB.id });
		assert.deepEqual(nb.data, { unreadCount: 1 });
		assert.deepEqual(
			(await call(collection, 'GET', { org: orgB.id })).data.items.map((n) => n.id),
			[otherTenant.id]
		);
	});
	await t.test('read/unread first-write-wins and repeat does not change updatedAt', async () => {
		const first = await call(resource, 'PATCH', { id: own.id, body: { read: true } });
		assert.equal(first.status, 200);
		assert.ok(first.data.notification.readAt);
		const second = await call(resource, 'PATCH', { id: own.id, body: { read: true } });
		assert.deepEqual(second.data, first.data);
		const unread = await call(resource, 'PATCH', { id: own.id, body: { read: false } });
		assert.equal(unread.data.notification.readAt, null);
		assert.deepEqual(
			(await call(resource, 'PATCH', { id: own.id, body: { read: false } })).data,
			unread.data
		);
		assert.equal((await svc.getNotification(db, cab, otherTenant.id)).readAt, null);
	});
	await t.test(
		'read-all preserves already-read timestamps and other recipients/tenants',
		async () => {
			await svc.markNotificationRead(db, ca, own.id);
			const before = await svc.getNotification(db, ca, own.id);
			const result = await call(readAll, 'POST', { body: {} });
			assert.equal(result.status, 204);
			assert.equal(await svc.countUnreadNotifications(db, ca), 0);
			assert.deepEqual(await svc.getNotification(db, ca, own.id), before);
			assert.equal(await svc.countUnreadNotifications(db, cab), 1);
			assert.equal((await svc.getNotification(db, cb, other.id)).readAt, null);
			assert.equal((await call(readAll, 'POST', { body: {} })).status, 204);
		}
	);
	await t.test('strict status filters', async () => {
		const fresh = await create();
		const unread = await call(collection, 'GET', { query: '&status=unread' });
		assert.deepEqual(
			unread.data.items.map((n) => n.id),
			[fresh.id]
		);
		const read = await call(collection, 'GET', { query: '&status=read' });
		assert.ok(read.data.items.length > 0);
		assert.ok(read.data.items.every((n) => n.readAt !== null));
	});
	for (const query of [
		'&recipientUserId=' + b.id,
		'&status=all',
		'&limit=0',
		'&limit=101',
		'&limit=1.5',
		'&cursor=bad',
		'&cursor=',
		'&limit=1&limit=2',
		'&unknown=x',
		'&organizationId=' + orgB.id
	]) {
		await t.test('reject query ' + query, async () =>
			assert.equal((await call(collection, 'GET', { query })).status, 400)
		);
	}
	for (const body of [
		{ read: 'true' },
		{ read: true, recipientUserId: b.id },
		{ readAt: null },
		{},
		{ read: null },
		[],
		null
	]) {
		await t.test('strict PATCH ' + JSON.stringify(body), async () =>
			assert.equal((await call(resource, 'PATCH', { id: own.id, body })).status, 400)
		);
	}
	await t.test('oversized mutation body and cross-origin denied', async () => {
		assert.equal(
			(await call(resource, 'PATCH', { id: own.id, body: { read: true, extra: 'x'.repeat(300) } }))
				.status,
			400
		);
		assert.equal(
			(
				await call(resource, 'PATCH', {
					id: own.id,
					body: { read: true },
					origin: 'https://evil.example'
				})
			).status,
			403
		);
		assert.equal(
			(await call(collection, 'DELETE', { query: '&scope=all', origin: 'https://evil.example' }))
				.status,
			403
		);
		assert.equal((await call(readAll, 'POST', { body: { recipientUserId: b.id } })).status, 400);
	});
	await t.test('all handlers require session; DELETE body spoofing rejected', async () => {
		for (const [route, method, opts] of [
			[collection, 'GET', {}],
			[resource, 'GET', { id: own.id }],
			[resource, 'PATCH', { id: own.id, body: { read: true } }],
			[resource, 'DELETE', { id: own.id }],
			[collection, 'DELETE', { query: '&scope=all' }],
			[readAll, 'POST', { body: {} }],
			[count, 'GET', {}]
		]) {
			assert.equal((await call(route, method, { ...opts, cookie: '' })).status, 401);
		}
		assert.equal(
			(await call(collection, 'DELETE', { query: '&scope=all', body: { recipientUserId: b.id } }))
				.status,
			400
		);
		assert.equal(
			(await call(resource, 'DELETE', { id: own.id, body: { read: true } })).status,
			400
		);
	});
	await t.test('delete own then 404; never domain data', async () => {
		const n = await create();
		const before = (await pg.query('select count(*)::int as n from incident_history')).rows;
		assert.equal((await call(resource, 'DELETE', { id: n.id })).status, 204);
		assert.equal((await call(resource, 'DELETE', { id: n.id })).status, 404);
		assert.deepEqual(
			(await pg.query('select count(*)::int as n from incident_history')).rows,
			before
		);
	});
	await t.test(
		'clear requires explicit scope; read preserves unread; all is user+tenant scoped',
		async () => {
			for (const query of [
				'',
				'&scope=unread',
				'&scope=all&scope=read',
				'&scope=all&recipientUserId=' + b.id
			]) {
				assert.equal((await call(collection, 'DELETE', { query })).status, 400);
			}
			const fresh = await create();
			assert.equal((await call(collection, 'DELETE', { query: '&scope=read' })).status, 204);
			assert.ok((await svc.getNotification(db, ca, fresh.id)).id);
			assert.ok((await svc.getNotification(db, cb, other.id)).id);
			assert.ok((await svc.getNotification(db, cab, otherTenant.id)).id);
			assert.equal((await call(collection, 'DELETE', { query: '&scope=all' })).status, 204);
			assert.deepEqual((await call(collection)).data, { items: [], nextCursor: null });
			assert.equal(await svc.countUnreadNotifications(db, ca), 0);
			assert.equal(await svc.countUnreadNotifications(db, cab), 1);
			assert.equal((await svc.getNotification(db, cb, other.id)).readAt, null);
		}
	);
	await t.test('pagination exact with timestamp ties/microseconds; default 50 max100', async () => {
		for (let i = 0; i < 105; i++)
			await db.insert(s.notifications).values({
				...ca,
				...input,
				id: randomUUID(),
				createdAt: sql.raw(
					"'2026-01-01T00:00:00.000" + String(i % 3).padStart(3, '0') + "Z'::timestamptz"
				)
			});
		assert.equal((await call(collection)).data.items.length, 50);
		assert.equal((await call(collection, 'GET', { query: '&limit=100' })).data.items.length, 100);
		const expected = (
			await pg.query(
				'select id from notifications where organization_id=$1 and recipient_user_id=$2 order by created_at desc,id desc',
				[orgA.id, a.id]
			)
		).rows.map((r) => r.id);
		const ids = [];
		let cursor = null;
		do {
			const result = await call(collection, 'GET', {
				query: '&limit=7' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
			});
			assert.equal(result.status, 200);
			ids.push(...result.data.items.map((n) => n.id));
			cursor = result.data.nextCursor;
		} while (cursor);
		assert.deepEqual(ids, expected);
		assert.equal(new Set(ids).size, 105);
		for (const data of [
			[],
			['2026-02-30T00:00:00.000000Z', randomUUID()],
			['2026-01-01T00:00:00.000000Z', 'bad']
		]) {
			assert.equal(
				(
					await call(collection, 'GET', {
						query: '&cursor=' + Buffer.from(JSON.stringify(data)).toString('base64url')
					})
				).status,
				400
			);
		}
	});
	await t.test('revoked membership blocks operations, inactive user loses session', async () => {
		await db
			.update(s.memberships)
			.set({ active: false })
			.where(and(eq(s.memberships.userId, a.id), eq(s.memberships.organizationId, orgA.id)));
		for (const [route, method, options] of [
			[collection, 'GET', {}],
			[collection, 'DELETE', { query: '&scope=all' }],
			[count, 'GET', {}],
			[readAll, 'POST', { body: {} }]
		]) {
			assert.equal((await call(route, method, options)).status, 403);
		}
		await db.update(s.users).set({ active: false }).where(eq(s.users.id, a.id));
		assert.equal((await call(collection)).status, 401);
	});
});

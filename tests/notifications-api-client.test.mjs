import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as api from '../src/lib/api/notifications.ts';
const org = randomUUID(),
	id = randomUUID();
const sample = {
	id,
	type: 'synthetic.notice',
	title: 'Notice',
	message: 'Plain <script>text</script>',
	readAt: null,
	createdAt: '2026-09-26T12:00:00.123456Z',
	updatedAt: '2026-09-26T12:00:00.123456Z'
};
const options = (data) => ({ customFetch: async () => Response.json(data) });
test('5.4U-A typed notification client', async (t) => {
	await t.test('list URL, GET same-origin, status/limit/cursor, signal and raw dates', async () => {
		const controller = new AbortController();
		const result = await api.listNotifications(org, {
			status: 'unread',
			limit: 20,
			cursor: 'YWJj',
			signal: controller.signal,
			customFetch: async (url, init) => {
				assert.equal(
					url,
					'/api/notifications?organizationId=' +
						encodeURIComponent(org) +
						'&status=unread&limit=20&cursor=YWJj'
				);
				assert.equal(init.method, 'GET');
				assert.equal(init.credentials, 'same-origin');
				assert.equal(init.signal, controller.signal);
				return Response.json({ items: [sample], nextCursor: 'YWJj' });
			}
		});
		assert.deepEqual(result, { items: [sample], nextCursor: 'YWJj' });
	});
	await t.test('empty page', async () =>
		assert.deepEqual(await api.listNotifications(org, options({ items: [], nextCursor: null })), {
			items: [],
			nextCursor: null
		})
	);
	await t.test('unknown fields discarded, including payload and recipient ids', async () => {
		const result = await api.getNotification(
			org,
			id,
			options({
				notification: {
					...sample,
					recipientUserId: randomUUID(),
					payload: { secret: 'private' },
					unknown: true
				},
				rawHistory: ['secret']
			})
		);
		assert.deepEqual(result, sample);
	});
	for (const [key, value] of [
		['id', 'invalid'],
		['type', 'bad type'],
		['title', ''],
		['message', 'x'.repeat(2001)],
		['readAt', false],
		['createdAt', '2026-02-30T12:00:00.000Z'],
		['updatedAt', null]
	]) {
		await t.test('reject invalid DTO ' + key, async () =>
			assert.rejects(
				api.getNotification(org, id, options({ notification: { ...sample, [key]: value } })),
				(e) => e.code === 'INVALID_PAYLOAD'
			)
		);
	}
	await t.test('reject mismatched detail id', async () =>
		assert.rejects(
			api.getNotification(org, randomUUID(), options({ notification: sample })),
			(e) => e.code === 'INVALID_PAYLOAD'
		)
	);
	for (const data of [
		null,
		[],
		{},
		{ items: null, nextCursor: null },
		{ items: [null], nextCursor: null },
		{ items: [], nextCursor: 42 }
	]) {
		await t.test('reject malformed page ' + JSON.stringify(data), async () =>
			assert.rejects(api.listNotifications(org, options(data)), (e) => e.code === 'INVALID_PAYLOAD')
		);
	}
	for (const code of [400, 401, 403, 404, 500]) {
		await t.test('safe HTTP ' + code, async () => {
			await assert.rejects(
				api.getNotification(org, id, {
					customFetch: async () =>
						Response.json({ error: { code: 'secret', message: 'SQL secret' } }, { status: code })
				}),
				(e) => e.status === code && !e.message.includes('secret') && !e.code.includes('secret')
			);
		});
	}
	await t.test('network error', async () =>
		assert.rejects(
			api.listNotifications(org, {
				customFetch: async () => {
					throw new Error('secret transport');
				}
			}),
			(e) => e.code === 'NETWORK_ERROR' && !e.message.includes('secret')
		)
	);
	await t.test('AbortError retained', async () => {
		const error = new DOMException('aborted', 'AbortError');
		await assert.rejects(
			api.listNotifications(org, {
				customFetch: async () => {
					throw error;
				}
			}),
			(e) => e === error
		);
	});
	await t.test('invalid JSON', async () =>
		assert.rejects(
			api.getNotification(org, id, { customFetch: async () => new Response('{') }),
			(e) => e.code === 'INVALID_PAYLOAD'
		)
	);
	for (const method of [
		'getNotification',
		'markNotificationRead',
		'markNotificationUnread',
		'deleteNotification'
	]) {
		await t.test('UUID checked before fetch ' + method, async () =>
			assert.rejects(
				api[method](org, 'bad', { customFetch: () => assert.fail('must not fetch') }),
				(e) => e.code === 'INVALID_INPUT'
			)
		);
	}
	await t.test('invalid org/list/bulk input rejected before fetch', async () => {
		for (const [fn, args] of [
			['listNotifications', ['bad']],
			['listNotifications', [org, { limit: 101 }]],
			['listNotifications', [org, { status: 'all' }]],
			['listNotifications', [org, { cursor: 'bad cursor' }]],
			['clearNotifications', [org, 'unread']],
			['getUnreadNotificationCount', ['bad']],
			['markAllNotificationsRead', ['bad']]
		])
			await assert.rejects(api[fn](...args), (e) => e.code === 'INVALID_INPUT');
	});
	for (const [fn, read] of [
		['markNotificationRead', true],
		['markNotificationUnread', false]
	]) {
		await t.test(fn + ' PATCH strict boolean', async () => {
			const result = await api[fn](org, id, {
				customFetch: async (url, init) => {
					assert.equal(url, '/api/notifications/' + id + '?organizationId=' + org);
					assert.equal(init.method, 'PATCH');
					assert.deepEqual(JSON.parse(init.body), { read });
					assert.equal(init.headers['Content-Type'], 'application/json');
					return Response.json({ notification: sample });
				}
			});
			assert.deepEqual(result, sample);
		});
	}
	await t.test('read-all POST empty object; bulk scope explicit; delete own resource', async () => {
		for (const [fn, args, url, method, body] of [
			[
				'markAllNotificationsRead',
				[org],
				'/api/notifications/read-all?organizationId=' + org,
				'POST',
				'{}'
			],
			[
				'clearNotifications',
				[org, 'read'],
				'/api/notifications?organizationId=' + org + '&scope=read',
				'DELETE',
				undefined
			],
			[
				'clearNotifications',
				[org, 'all'],
				'/api/notifications?organizationId=' + org + '&scope=all',
				'DELETE',
				undefined
			],
			[
				'deleteNotification',
				[org, id],
				'/api/notifications/' + id + '?organizationId=' + org,
				'DELETE',
				undefined
			]
		])
			assert.equal(
				await api[fn](...args, {
					customFetch: async (endpoint, init) => {
						assert.equal(endpoint, url);
						assert.equal(init.method, method);
						assert.equal(init.body, body);
						return new Response(null, { status: 204 });
					}
				}),
				undefined
			);
	});
	await t.test('mutation requires 204', async () =>
		assert.rejects(
			api.deleteNotification(org, id, options({})),
			(e) => e.code === 'INVALID_PAYLOAD'
		)
	);
	await t.test('count endpoint and strict nonnegative integer', async () => {
		assert.equal(
			await api.getUnreadNotificationCount(org, {
				customFetch: async (url) => {
					assert.equal(url, '/api/notifications/unread-count?organizationId=' + org);
					return Response.json({ unreadCount: 2, secret: 'ignored' });
				}
			}),
			2
		);
		for (const value of [-1, 1.2, '1', null])
			await assert.rejects(
				api.getUnreadNotificationCount(org, options({ unreadCount: value })),
				(e) => e.code === 'INVALID_PAYLOAD'
			);
	});
});

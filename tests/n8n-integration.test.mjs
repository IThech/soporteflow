import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

const require = createRequire(import.meta.url);
const doc = fs.readFileSync('docs/integrations/n8n.md', 'utf8');
const example = doc
	.split('<!-- BEGIN TESTED N8N CODE -->')[1]
	.split('<!-- END TESTED N8N CODE -->')[0]
	.match(/```js\n([\s\S]*?)\n```/)[1];
// Execute the repository-owned documentation example, never data received from a webhook.
const runCode = new Function('$input', '$env', 'require', 'Buffer', 'Date', example);
function receive(body, headers, secret, organizationId, now, overrides = {}) {
	const item = {
		json: {
			headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
			body: { ignored: true }
		},
		binary: { data: { data: Buffer.from(body, 'utf8').toString('base64') } },
		...overrides
	};
	return runCode(
		{ all: () => [item] },
		{ SOPORTEFLOW_WEBHOOK_SECRET: secret, SOPORTEFLOW_ORGANIZATION_ID: organizationId },
		require,
		Buffer,
		{ now: () => now.getTime() }
	);
}

test('5.4V-D: n8n consumes V-B; mandatory closure gates', async (t) => {
	const previous = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
	const key = randomBytes(32);
	process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = key.toString('hex');
	t.after(() => {
		if (previous === undefined) delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
		else process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = previous;
	});
	const f = await fixture(t);
	const { db, schema: s, server, pg } = f;
	const load = (name) => server.ssrLoadModule('/src/lib/server/' + name + '.ts');
	const subs = await load('services/webhook-subscriptions');
	const processor = await load('services/webhook-deliveries');
	const safety = await load('webhooks/url-safety');
	const secrets = await load('webhooks/secrets');
	const { WebhookTransportError } = await load('webhooks/http-client');
	const { createIncidentRecord } = await load('services/incidents');
	const { ensureOrganizationRoles } = await load('services/roles');
	const api = await server.ssrLoadModule('/src/routes/api/webhooks/+server.ts');
	const [org] = await db
		.insert(s.organizations)
		.values({ name: 'n8n synthetic', slug: randomUUID(), status: 'active' })
		.returning();
	const { user } = await createCredentialUser(f, { email: 'vd-' + randomUUID() + '@example.test' });
	const [membership] = await db
		.insert(s.memberships)
		.values({ organizationId: org.id, userId: user.id, active: true })
		.returning();
	const { roles } = await ensureOrganizationRoles(db, org.id);
	await db.insert(s.roleAssignments).values({
		organizationId: org.id,
		membershipId: membership.id,
		roleId: roles.find((r) => r.code === 'organization_admin').id,
		scopeType: 'organization'
	});
	const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
	const context = { organizationId: org.id, actorUserId: user.id };
	const now = new Date(Date.now() + 60000);
	const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
	const incident = async () =>
		(
			await createIncidentRecord(
				db,
				{ organizationId: org.id, creatorUserId: user.id },
				{ title: 'Incidencia sintética', description: 'Sin datos reales', client: 'Laboratorio' }
			)
		).incident;
	const subscribe = (url = 'https://n8n.example.com/webhook/soporteflow') =>
		subs.createWebhookSubscription(
			db,
			context,
			{ name: 'n8n', targetUrl: url, eventTypes: ['incident.created'] },
			{ encryptionKey: key }
		);
	const delivery = async (id) =>
		(
			await db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.subscriptionId, id))
		)[0];
	const disable = (id) => subs.deactivateWebhookSubscription(db, org.id, id);
	const run = (httpClient) =>
		processor.processDueWebhookDeliveries(db, { now, encryptionKey: key, lookup, httpClient });

	await t.test(
		'gate 1: admin uses existing /api/webhooks, existing tables, unchanged envelope, reads hide secret',
		async () => {
			const url = new URL('http://localhost/api/webhooks?organizationId=' + org.id);
			const response = await api.POST({
				url,
				request: new Request(url, {
					method: 'POST',
					headers: {
						origin: 'http://localhost',
						cookie: session.cookieHeader,
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						name: 'n8n Cloud',
						targetUrl: 'https://tenant.n8n.cloud/webhook/soporteflow',
						eventTypes: ['incident.created']
					})
				})
			});
			assert.equal(response.status, 201);
			const created = await response.json();
			await incident();
			const row = await delivery(created.webhook.id);
			assert.ok(row);
			const event = JSON.parse(row.body);
			assert.deepEqual(
				Object.keys(event).sort(),
				['id', 'type', 'schemaVersion', 'occurredAt', 'organizationId', 'aggregate', 'data'].sort()
			);
			assert.equal(event.type, 'incident.created');
			assert.equal(event.organizationId, org.id);
			const dto = await subs.getWebhookSubscription(db, org.id, created.webhook.id);
			assert.equal(JSON.stringify(dto).includes(created.secret), false);
			assert.equal('secret' in dto, false);
			const tables = await pg.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
			);
			assert.equal(
				tables.rows.some((r) => /^n8n_/i.test(r.table_name)),
				false
			);
			await disable(created.webhook.id);
		}
	);

	await t.test(
		'gate 2: exact documented Code node verifies original UTF-8 bytes; never reserialized JSON',
		() => {
			assert.equal(
				secrets.signWebhookPayload('whsec_test_vector_secret', 1700000000, '{"id":"evt","n":1}'),
				'v1=978afe23f68e8726abbd36d389741f87d9923e0d718f64c74d26de860a2953f7'
			);
			const event = {
				id: randomUUID(),
				type: 'incident.created',
				schemaVersion: 1,
				organizationId: org.id,
				aggregate: { type: 'incident', id: randomUUID() },
				data: { text: 'á 🚀', priority: 'urgent' }
			};
			const raw = '  ' + JSON.stringify(event, null, 2) + '\r\n';
			const secret = randomBytes(32).toString('base64url');
			const headers = processor.buildWebhookHeaders({
				deliveryId: randomUUID(),
				eventId: event.id,
				eventType: event.type,
				timestamp: Math.floor(now.getTime() / 1000),
				secret,
				body: raw
			});
			assert.deepEqual(receive(raw, headers, secret, org.id, now), [{ json: { event } }]);
			assert.throws(
				() => receive(JSON.stringify(event), headers, secret, org.id, now),
				/SF_WEBHOOK_REJECTED/
			);
			assert.throws(() => receive(raw + ' ', headers, secret, org.id, now), /SF_WEBHOOK_REJECTED/);
			assert.throws(
				() => receive(raw, headers, secret, org.id, now, { binary: undefined }),
				/SF_WEBHOOK_REJECTED/
			);
			assert.throws(
				() =>
					receive(raw, headers, secret, org.id, now, {
						binary: { data: { data: 'filesystem-v2:reference' } }
					}),
				/SF_WEBHOOK_REJECTED/
			);
			assert.throws(
				() => receive(raw, headers, secret, org.id, new Date(now.getTime() + 301000)),
				/SF_WEBHOOK_REJECTED/
			);
			assert.throws(
				() => receive(raw, headers, secret, org.id, new Date(now.getTime() - 301000)),
				/SF_WEBHOOK_REJECTED/
			);
			assert.throws(
				() =>
					receive(raw, { ...headers, 'X-SoporteFlow-Event-Id': randomUUID() }, secret, org.id, now),
				/SF_WEBHOOK_REJECTED/
			);
			assert.throws(() => receive(raw, headers, secret, randomUUID(), now), /SF_WEBHOOK_REJECTED/);
			assert.throws(() => receive(raw, headers, '', org.id, now), /SF_WEBHOOK_REJECTED/);
			assert.throws(
				() =>
					receive(raw, { ...headers, 'X-SoporteFlow-Signature': 'v1=bad' }, secret, org.id, now),
				/SF_WEBHOOK_REJECTED/
			);
			assert.throws(
				() => receive(raw, headers, randomBytes(32).toString('hex'), org.id, now),
				/SF_WEBHOOK_REJECTED/
			);
			const item = {
				json: {
					headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
				},
				binary: { data: { data: Buffer.from(raw).toString('base64') } }
			};
			assert.deepEqual(
				runCode(
					{ all: () => [item] },
					{
						SOPORTEFLOW_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
						SOPORTEFLOW_WEBHOOK_PREVIOUS_SECRET: secret,
						SOPORTEFLOW_ORGANIZATION_ID: org.id
					},
					require,
					Buffer,
					{ now: () => now.getTime() }
				),
				[{ json: { event } }]
			);
		}
	);

	for (const scenario of [
		{ name: '200', status: 200, expected: 'sent', code: null },
		{ name: '500', status: 500, expected: 'retry', code: 'HTTP_5XX', delay: 60000 },
		{ name: 'timeout', timeout: true, expected: 'retry', code: 'TIMEOUT', delay: 60000 },
		{
			name: '429',
			status: 429,
			retryAfter: '120',
			expected: 'retry',
			code: 'RATE_LIMITED',
			delay: 120000
		}
	])
		await t.test(
			'gate 3: simulated n8n ' + scenario.name + ' preserves committed domain/event',
			async () => {
				const sub = await subscribe();
				const record = await incident();
				const before = await delivery(sub.webhook.id);
				const incidentBefore = await db
					.select()
					.from(s.incidents)
					.where(eq(s.incidents.id, record.id));
				const eventBefore = await db
					.select()
					.from(s.automationEvents)
					.where(eq(s.automationEvents.id, before.eventId));
				let calls = 0;
				await run({
					post: async (request) => {
						calls++;
						assert.equal(request.body, before.body);
						assert.equal(request.url, sub.webhook.targetUrl);
						assert.equal(request.timeoutMs, 10000);
						assert.deepEqual(
							receive(request.body, request.headers, sub.secret, org.id, now)[0].json.event,
							JSON.parse(before.body)
						);
						if (scenario.timeout) throw new WebhookTransportError('TIMEOUT');
						return { status: scenario.status, retryAfter: scenario.retryAfter ?? null };
					}
				});
				assert.equal(calls, 1);
				const after = await delivery(sub.webhook.id);
				assert.equal(after.status, scenario.expected);
				assert.equal(after.lastErrorCode, scenario.code);
				if (scenario.delay)
					assert.equal(after.nextAttemptAt.getTime(), now.getTime() + scenario.delay);
				assert.deepEqual(
					await db.select().from(s.incidents).where(eq(s.incidents.id, record.id)),
					incidentBefore
				);
				assert.deepEqual(
					await db
						.select()
						.from(s.automationEvents)
						.where(eq(s.automationEvents.id, before.eventId)),
					eventBefore
				);
				await disable(sub.webhook.id);
			}
		);

	await t.test(
		'disable and rotation reuse V-B version snapshots, no second delivery path',
		async () => {
			const sub = await subscribe();
			await incident();
			const old = await delivery(sub.webhook.id);
			const rotated = await subs.rotateWebhookSecret(db, org.id, sub.webhook.id, {
				encryptionKey: key
			});
			assert.notEqual(rotated.secret, sub.secret);
			let calls = 0;
			await run({
				post: async (request) => {
					calls++;
					assert.equal(request.body, old.body);
					assert.ok(receive(request.body, request.headers, sub.secret, org.id, now));
					assert.throws(
						() => receive(request.body, request.headers, rotated.secret, org.id, now),
						/SF_WEBHOOK_REJECTED/
					);
					return { status: 200, retryAfter: null };
				}
			});
			assert.equal(calls, 1);
			await incident();
			await disable(sub.webhook.id);
			await run({
				post: async () => {
					assert.fail('disabled subscription sent');
				}
			});
			const rows = await db
				.select()
				.from(s.webhookDeliveries)
				.where(eq(s.webhookDeliveries.subscriptionId, sub.webhook.id));
			assert.ok(rows.some((r) => r.lastErrorCode === 'SUBSCRIPTION_INACTIVE'));
		}
	);

	await t.test(
		'gate 4: same SSRF rules for n8n literals and DNS; no private exception',
		async () => {
			for (const host of [
				'localhost',
				'127.0.0.1',
				'[::1]',
				'10.0.0.1',
				'172.16.0.1',
				'192.168.1.2',
				'169.254.169.254',
				'[fe80::1]'
			]) {
				await assert.rejects(() => subscribe('https://' + host + '/webhook/n8n'));
			}
			for (const address of [
				'127.0.0.1',
				'::1',
				'10.0.0.1',
				'172.16.0.1',
				'192.168.1.2',
				'169.254.169.254',
				'fe80::1'
			]) {
				await assert.rejects(() =>
					safety.resolvePublicAddresses('n8n.example.com', async () => [
						{ address, family: address.includes(':') ? 6 : 4 }
					])
				);
			}
			assert.throws(() => safety.normalizeWebhookTargetUrl('http://n8n.example.com/webhook/a'));
			const sub = await subscribe();
			await incident();
			await processor.processDueWebhookDeliveries(db, {
				now,
				encryptionKey: key,
				lookup: async () => [{ address: '192.168.1.2', family: 4 }],
				httpClient: {
					post: async () => {
						assert.fail('private n8n target reached transport');
					}
				}
			});
			assert.equal((await delivery(sub.webhook.id)).lastErrorCode, 'SSRF_BLOCKED');
			await disable(sub.webhook.id);
		}
	);

	await t.test(
		'gate 5: no n8n runtime client, callback, scheduler, new tables or generic HTTP action',
		() => {
			const files = (dir) =>
				fs
					.readdirSync(dir, { withFileTypes: true })
					.flatMap((e) =>
						e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]
					);
			const source = files('src')
				.filter((p) => /\.(ts|js|svelte)$/.test(p))
				.map((p) => fs.readFileSync(p, 'utf8'))
				.join('\n');
			assert.doesNotMatch(
				source,
				/N8N_API_KEY|n8n_deliveries|n8n_jobs|n8n_event_queue|allowPrivate\s*[:=]\s*true/
			);
			const serverSource = files('src/lib/server')
				.concat(files('src/routes/api'))
				.filter((p) => /\.ts$/.test(p))
				.map((p) =>
					fs
						.readFileSync(p, 'utf8')
						.replace(/\/\*[\s\S]*?\*\//g, '')
						.replace(/^\s*\/\/.*$/gm, '')
				)
				.join('\n');
			assert.doesNotMatch(
				serverSource,
				/setInterval\s*\(|node-cron|node-schedule|N8N_|n8n\.cloud|api\/v1\/workflows/
			);
			assert.equal(
				files('src/routes/api').some((p) => /n8n/i.test(p)),
				false
			);
			const rules = fs.readFileSync('src/lib/automation/rules.ts', 'utf8');
			assert.doesNotMatch(rules, /['"](?:http|shell|script|eval|n8n)\./);
			const schemas = files('src/lib/server/db/schema')
				.map((p) => fs.readFileSync(p, 'utf8'))
				.join('\n');
			assert.doesNotMatch(schemas, /pgTable\(['"]n8n/);
			assert.equal(
				fs.readdirSync('drizzle/migrations').some((p) => p.startsWith('0026')),
				false
			);
		}
	);
});

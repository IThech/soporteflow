import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import {
	fixture,
	directory,
	createCredentialUser,
	createSession
} from './helpers/auth-fixture.mjs';

async function applyRange(pg, from, to) {
	const journal = JSON.parse(fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8'));
	for (const entry of journal.entries.slice(from, to + 1)) {
		const sql = fs.readFileSync(path.join(directory, entry.tag + '.sql'), 'utf8');
		await pg.exec('BEGIN');
		try {
			for (const statement of sql.split('--> statement-breakpoint'))
				if (statement.trim()) await pg.exec(statement);
			await pg.exec('COMMIT');
		} catch (error) {
			await pg.exec('ROLLBACK');
			throw error;
		}
	}
}

const ORIGIN = 'http://localhost';
const MIN = 60_000;
const KEY_HEX = randomBytes(32).toString('hex');

test('SoporteFlow — Etapa 5.4V-B: webhooks salientes, HMAC y reintentos', async (t) => {
	const previousKey = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
	process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = KEY_HEX;
	t.after(() => {
		if (previousKey === undefined) delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
		else process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = previousKey;
	});

	const f = await fixture(t);
	const { db, schema: s, server, pg } = f;
	const { ensureOrganizationRoles } = await server.ssrLoadModule(
		'/src/lib/server/services/roles.ts'
	);
	const { createIncidentRecord, assignIncidentRecord } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);
	const { createPublicComment } = await server.ssrLoadModule(
		'/src/lib/server/services/incident-messages.ts'
	);
	const prefs = await server.ssrLoadModule('/src/lib/server/services/notification-preferences.ts');
	const subs = await server.ssrLoadModule('/src/lib/server/services/webhook-subscriptions.ts');
	const fanout = await server.ssrLoadModule('/src/lib/server/services/webhook-fanout.ts');
	const proc = await server.ssrLoadModule('/src/lib/server/services/webhook-deliveries.ts');
	const events = await server.ssrLoadModule('/src/lib/server/services/automation-events.ts');
	const safety = await server.ssrLoadModule('/src/lib/server/webhooks/url-safety.ts');
	const secrets = await server.ssrLoadModule('/src/lib/server/webhooks/secrets.ts');
	const client = await server.ssrLoadModule('/src/lib/server/webhooks/http-client.ts');
	const routes = {
		collection: await server.ssrLoadModule('/src/routes/api/webhooks/+server.ts'),
		item: await server.ssrLoadModule('/src/routes/api/webhooks/[id]/+server.ts'),
		rotate: await server.ssrLoadModule('/src/routes/api/webhooks/[id]/rotate-secret/+server.ts'),
		deliveries: await server.ssrLoadModule('/src/routes/api/webhooks/[id]/deliveries/+server.ts')
	};
	const KEY = secrets.parseWebhookEncryptionKey(KEY_HEX);

	async function organization(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'vb-' + randomUUID(), status: 'active' })
			.returning();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		const byCode = (c) => roles.find((r) => r.code === c);
		return {
			org,
			admin: byCode('organization_admin'),
			tech: byCode('technician'),
			customer: byCode('customer')
		};
	}
	async function member(o, roles = []) {
		const { user } = await createCredentialUser(f, { email: `vb-${randomUUID()}@example.test` });
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: o.org.id, userId: user.id, active: true })
			.returning();
		for (const role of roles)
			await db.insert(s.roleAssignments).values({
				organizationId: o.org.id,
				membershipId: membership.id,
				roleId: role.id,
				scopeType: 'organization'
			});
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, cookie: session.cookieHeader };
	}
	async function call(
		handler,
		{ method = 'GET', who, org, id, query, body, rawBody, origin = ORIGIN }
	) {
		const suffix = id ? `/${id}` : '';
		const url = new URL(
			`${ORIGIN}/api/webhooks${suffix}?${query ?? `organizationId=${org.org.id}`}`
		);
		const headers = new Headers();
		if (origin) headers.set('origin', origin);
		if (who) headers.set('cookie', who.cookie);
		const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
		if (payload !== undefined) headers.set('content-type', 'application/json');
		const response = await handler({
			url,
			params: id ? { id } : {},
			request: new Request(url, { method, headers, body: payload })
		});
		const text = await response.text();
		return {
			status: response.status,
			json: text ? JSON.parse(text) : null,
			text,
			headers: response.headers
		};
	}
	const post = (who, org, body, extra = {}) =>
		call(routes.collection.POST, { method: 'POST', who, org, body, ...extra });

	/** DNS stub: hostname -> addresses (unknown host = NXDOMAIN). */
	const dns = new Map();
	const lookup = async (hostname) => {
		const answer = dns.get(hostname);
		if (!answer) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
		return answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
	};
	/** Scripted HTTP client: each call consumes the next response (object) or error. */
	function httpMock(...script) {
		const calls = [];
		return {
			calls,
			script,
			post: async (request) => {
				calls.push(request);
				const next = script.length ? script.shift() : { status: 200 };
				if (next instanceof Error) throw next;
				return { status: next.status, retryAfter: next.retryAfter ?? null };
			}
		};
	}

	const A = await organization('Alfa');
	const B = await organization('Beta');
	const admin = await member(A, [A.admin]);
	const tech = await member(A, [A.tech]);
	const customer = await member(A, [A.customer]);
	const adminB = await member(B, [B.admin]);
	dns.set('hooks.example.com', ['93.184.216.34']);
	dns.set('hooks-b.example.com', ['93.184.216.35', '2606:2800:220:1:248:1893:25c8:1946']);

	async function subscribe(
		o = A,
		eventTypes = ['incident.created', 'incident.assigned'],
		host = 'hooks.example.com'
	) {
		return subs.createWebhookSubscription(
			db,
			{ organizationId: o.org.id, actorUserId: (o === A ? admin : adminB).user.id },
			{
				name: 'Hook ' + randomUUID().slice(0, 8),
				targetUrl: `https://${host}/sf/events?x=1`,
				eventTypes
			},
			{ encryptionKey: KEY }
		);
	}
	async function incident(o = A, creator = admin) {
		return (
			await createIncidentRecord(
				db,
				{ organizationId: o.org.id, creatorUserId: creator.user.id },
				{ title: 'Título privado', description: 'Descripción privada', client: 'Cliente SL' }
			)
		).incident;
	}
	const deliveriesOf = (subscriptionId) =>
		db
			.select()
			.from(s.webhookDeliveries)
			.where(eq(s.webhookDeliveries.subscriptionId, subscriptionId));
	const byId = async (id) =>
		(await db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.id, id)))[0];
	/** Keeps only the given subscriptions active so each processor test sees its own rows. */
	async function isolate(...keep) {
		await db
			.update(s.webhookDeliveries)
			.set({
				status: 'failed',
				failedAt: new Date(),
				nextAttemptAt: null,
				leaseToken: null,
				lastErrorCode: 'SUBSCRIPTION_INACTIVE'
			})
			.where(inArray(s.webhookDeliveries.status, ['pending', 'retry', 'processing']));
		for (const row of await db.select().from(s.webhookSubscriptions))
			if (!keep.includes(row.id))
				await db
					.update(s.webhookSubscriptions)
					.set({ active: false })
					.where(eq(s.webhookSubscriptions.id, row.id));
	}
	const future = (ms = 0) => new Date(Date.now() + 10 * MIN + ms);
	const run = (options = {}) =>
		proc.processDueWebhookDeliveries(db, { lookup, encryptionKey: KEY, now: future(), ...options });
	async function withFailing(table, runFn) {
		await pg.exec(`
			CREATE OR REPLACE FUNCTION vb_fail() RETURNS trigger AS $$
			BEGIN RAISE EXCEPTION 'vb forced failure'; END $$ LANGUAGE plpgsql;
			CREATE TRIGGER vb_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION vb_fail();`);
		try {
			await runFn();
		} finally {
			await pg.exec(`DROP TRIGGER vb_fail ON ${table}; DROP FUNCTION vb_fail();`);
		}
	}
	const verify = (secret, request) => {
		const ts = request.headers['X-SoporteFlow-Timestamp'];
		const expected =
			'v1=' + createHmac('sha256', secret).update(`${ts}.${request.body}`, 'utf8').digest('hex');
		return request.headers['X-SoporteFlow-Signature'] === expected;
	};

	// =========================================================================
	// Migración 0024 y permisos
	// =========================================================================
	await t.test(
		'migración 0023 -> 0024: tablas, checks, FKs, unique, permisos; idempotente',
		async () => {
			const up = new PGlite();
			try {
				const journal = JSON.parse(
					fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')
				);
				const index = journal.entries.findIndex((e) => e.tag === '0024_webhooks');
				assert.equal(journal.entries[index - 1].tag, '0023_automation_events');
				await applyRange(up, 0, index);
				await applyRange(up, index, index);
				const tables = (
					await up.query(
						`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'webhook_%' ORDER BY 1`
					)
				).rows.map((r) => r.table_name);
				assert.deepEqual(tables, [
					'webhook_deliveries',
					'webhook_secrets',
					'webhook_subscriptions'
				]);
				const cols = (
					await up.query(
						`SELECT table_name, column_name FROM information_schema.columns WHERE table_name LIKE 'webhook_%'`
					)
				).rows.map((r) => `${r.table_name}.${r.column_name}`);
				assert.ok(
					!cols.some((c) => /plain|response_body|raw/.test(c)),
					'sin secreto ni respuesta en claro'
				);
				const org = randomUUID();
				await up.query(
					`INSERT INTO organizations (id, name, slug, status) VALUES ($1,'U',$2,'active')`,
					[org, 'u-' + org]
				);
				const sub = (over = {}) => {
					const v = {
						organization_id: org,
						name: 'H',
						target_url: 'https://hooks.example.com/x',
						event_types: '["incident.created"]',
						...over
					};
					const keys = Object.keys(v);
					return up.query(
						`INSERT INTO webhook_subscriptions (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
						Object.values(v)
					);
				};
				const [row] = (await sub()).rows;
				assert.equal(row.active, true);
				assert.equal(row.current_secret_version, 1);
				for (const [over, constraint] of [
					[{ target_url: 'http://hooks.example.com/x' }, 'webhook_subscriptions_target_url_check'],
					[{ event_types: '[]' }, 'webhook_subscriptions_event_types_check'],
					[{ event_types: '{"a":1}' }, 'webhook_subscriptions_event_types_check'],
					[{ name: '  ' }, 'webhook_subscriptions_name_check'],
					[{ organization_id: randomUUID() }, 'webhook_subscriptions_organization_fk']
				])
					await assert.rejects(sub(over), new RegExp(constraint));
				await assert.rejects(
					up.query(
						`INSERT INTO webhook_secrets (subscription_id, organization_id, version, ciphertext, iv, auth_tag) VALUES ($1,$2,1,'c','i','t')`,
						[row.id, randomUUID()]
					),
					/webhook_secrets_subscription_fk/
				);
				await up.query(
					`INSERT INTO webhook_secrets (subscription_id, organization_id, version, ciphertext, iv, auth_tag) VALUES ($1,$2,1,'c','i','t')`,
					[row.id, org]
				);
				const [evt] = (
					await up.query(
						`INSERT INTO automation_events (organization_id, event_type, aggregate_type, aggregate_id, payload, occurred_at) VALUES ($1,'incident.created','incident',$2,'{}',now()) RETURNING id`,
						[org, randomUUID()]
					)
				).rows;
				const delivery = (over = {}) => {
					const v = {
						organization_id: org,
						subscription_id: row.id,
						event_id: evt.id,
						event_type: 'incident.created',
						target_url: 'https://hooks.example.com/x',
						secret_version: 1,
						body: '{}',
						...over
					};
					const keys = Object.keys(v);
					return up.query(
						`INSERT INTO webhook_deliveries (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
						Object.values(v)
					);
				};
				const [d] = (await delivery()).rows;
				assert.equal(d.status, 'pending');
				await assert.rejects(delivery(), /webhook_deliveries_subscription_event_unique/);
				for (const [over, constraint] of [
					[{ secret_version: 2, event_id: randomUUID() }, 'webhook_deliveries_(secret|event)_fk'],
					[{ event_id: randomUUID() }, 'webhook_deliveries_event_fk'],
					[{ body: 'x'.repeat(40000) }, 'webhook_deliveries_body_check'],
					[{ status: 'sent' }, 'webhook_deliveries_state_check'],
					[{ last_error_code: 'raw error' }, 'webhook_deliveries_error_code_check'],
					[{ last_status_code: 700 }, 'webhook_deliveries_status_code_check'],
					[{ target_url: 'ftp://x/y' }, 'webhook_deliveries_target_url_check']
				])
					await assert.rejects(
						delivery(over),
						new RegExp(constraint),
						JSON.stringify(over).slice(0, 60)
					);
				const perms = (
					await up.query(
						`SELECT id, category FROM permissions WHERE id LIKE 'webhooks:%' ORDER BY id`
					)
				).rows;
				assert.deepEqual(perms, [
					{ id: 'webhooks:manage', category: 'webhooks' },
					{ id: 'webhooks:view', category: 'webhooks' }
				]);
				const templates = (
					await up.query(
						`SELECT role_template_id, permission_id FROM role_template_permissions WHERE permission_id LIKE 'webhooks:%' ORDER BY 1, 2`
					)
				).rows;
				assert.deepEqual(templates, [
					{ role_template_id: 'tpl_organization_admin', permission_id: 'webhooks:manage' },
					{ role_template_id: 'tpl_organization_admin', permission_id: 'webhooks:view' }
				]);
			} finally {
				await up.close();
			}
		}
	);

	// =========================================================================
	// URL / SSRF / DNS
	// =========================================================================
	await t.test('URL: https obligatorio, normalizada, sin credenciales ni fragmento', () => {
		assert.equal(
			safety.normalizeWebhookTargetUrl('HTTPS://Hooks.Example.COM:443/Path/To?Q=1&b=2'),
			'https://hooks.example.com/Path/To?Q=1&b=2'
		);
		assert.equal(
			safety.normalizeWebhookTargetUrl('https://hooks.example.com:8443/x'),
			'https://hooks.example.com:8443/x'
		);
		for (const [raw, code] of [
			['http://hooks.example.com/x', 'INVALID_TARGET'],
			['ftp://hooks.example.com/x', 'INVALID_TARGET'],
			['file:///etc/passwd', 'INVALID_TARGET'],
			['gopher://hooks.example.com/', 'INVALID_TARGET'],
			['data:text/plain,hi', 'INVALID_TARGET'],
			['javascript:alert(1)', 'INVALID_TARGET'],
			['https://user:pass@hooks.example.com/x', 'INVALID_TARGET'],
			['https://hooks.example.com/x#frag', 'INVALID_TARGET'],
			['https://hooks.example.com/x y', 'INVALID_TARGET'],
			['https://' + 'a'.repeat(2050) + '.com', 'INVALID_TARGET'],
			['not a url', 'INVALID_TARGET'],
			['https://localhost/x', 'SSRF_BLOCKED'],
			['https://localhost./x', 'SSRF_BLOCKED'],
			['https://api.localhost/x', 'SSRF_BLOCKED'],
			['https://printer.local/x', 'SSRF_BLOCKED'],
			['https://metadata.google.internal/computeMetadata', 'SSRF_BLOCKED'],
			['https://intranet/x', 'SSRF_BLOCKED'],
			['https://127.0.0.1/x', 'SSRF_BLOCKED'],
			['https://2130706433/x', 'SSRF_BLOCKED'],
			['https://0x7f.1/x', 'SSRF_BLOCKED'],
			['https://[::1]/x', 'SSRF_BLOCKED'],
			['https://[::ffff:169.254.169.254]/x', 'SSRF_BLOCKED'],
			['https://169.254.169.254/latest/meta-data', 'SSRF_BLOCKED'],
			['https://10.0.0.1/x', 'SSRF_BLOCKED']
		])
			assert.throws(
				() => safety.normalizeWebhookTargetUrl(raw),
				(e) => e.code === code,
				raw
			);
	});

	await t.test('clasificación de IPs: privadas/reservadas bloqueadas, públicas permitidas', () => {
		for (const ip of [
			'127.0.0.1',
			'127.0.0.2',
			'0.0.0.0',
			'10.0.0.1',
			'172.16.0.1',
			'172.31.255.255',
			'192.168.1.1',
			'169.254.169.254',
			'100.64.0.1',
			'192.0.2.10',
			'198.18.0.1',
			'224.0.0.1',
			'240.0.0.1',
			'255.255.255.255',
			'::',
			'::1',
			'fc00::1',
			'fd12:3456::1',
			'fe80::1',
			'fe80::1%eth0',
			'ff02::1',
			'::ffff:127.0.0.1',
			'::ffff:169.254.169.254',
			'::ffff:10.1.2.3',
			'64:ff9b::a9fe:a9fe',
			'2002:7f00:1::1',
			'2001:db8::1',
			'2001::1',
			'not-an-ip',
			''
		])
			assert.equal(safety.isPublicAddress(ip), false, ip);
		for (const ip of [
			'1.1.1.1',
			'8.8.8.8',
			'93.184.216.34',
			'172.32.0.1',
			'2606:4700:4700::1111',
			'2a00:1450:4001:80b::200e',
			'::ffff:8.8.8.8'
		])
			assert.equal(safety.isPublicAddress(ip), true, ip);
	});

	await t.test(
		'DNS: todas las respuestas deben ser públicas; mixtas o privadas bloqueadas',
		async () => {
			const resolve = (answer) =>
				safety.resolvePublicAddresses('x.example.com', async () => answer);
			assert.equal((await resolve([{ address: '8.8.8.8', family: 4 }])).length, 1);
			for (const answer of [
				[{ address: '10.0.0.5', family: 4 }],
				[
					{ address: '8.8.8.8', family: 4 },
					{ address: '127.0.0.1', family: 4 }
				],
				[{ address: '::1', family: 6 }]
			])
				await assert.rejects(resolve(answer), (e) => e.code === 'SSRF_BLOCKED');
			await assert.rejects(resolve([]), (e) => e.code === 'DNS_RESOLUTION_FAILED');
			await assert.rejects(
				safety.resolvePublicAddresses('x.example.com', async () => {
					throw new Error('ENOTFOUND');
				}),
				(e) => e.code === 'DNS_RESOLUTION_FAILED'
			);
		}
	);

	// =========================================================================
	// Secretos y firma
	// =========================================================================
	await t.test(
		'HMAC-SHA256: vector conocido, formato v1=<hex>, sin ambigüedad de saltos de línea',
		() => {
			assert.equal(
				secrets.signWebhookPayload('whsec_test_vector_secret', 1700000000, '{"id":"evt","n":1}'),
				'v1=978afe23f68e8726abbd36d389741f87d9923e0d718f64c74d26de860a2953f7'
			);
			assert.notEqual(
				secrets.signWebhookPayload('whsec_test_vector_secret', 1700000000, '{"id":"evt","n":1}\n'),
				secrets.signWebhookPayload('whsec_test_vector_secret', 1700000000, '{"id":"evt","n":1}')
			);
			assert.throws(() => secrets.signWebhookPayload('s', 1.5, '{}'));
		}
	);

	await t.test('secretos: AES-256-GCM con binding; clave de entorno validada', () => {
		const binding = { subscriptionId: randomUUID(), version: 1 };
		const secret = secrets.generateWebhookSecret();
		assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
		const enc = secrets.encryptWebhookSecret(KEY, secret, binding);
		assert.ok(!JSON.stringify(enc).includes(secret.slice(6)));
		assert.equal(secrets.decryptWebhookSecret(KEY, enc, binding), secret);
		for (const [key, bind] of [
			[randomBytes(32), binding],
			[KEY, { ...binding, version: 2 }],
			[KEY, { ...binding, subscriptionId: randomUUID() }]
		])
			assert.throws(
				() => secrets.decryptWebhookSecret(key, enc, bind),
				(e) => e.name === 'WebhookConfigurationError'
			);
		assert.equal(secrets.parseWebhookEncryptionKey(randomBytes(32).toString('base64')).length, 32);
		for (const bad of [undefined, '', 'abc', randomBytes(16).toString('hex'), 'z'.repeat(64)])
			assert.throws(
				() => secrets.parseWebhookEncryptionKey(bad),
				(e) => e.name === 'WebhookConfigurationError'
			);
	});

	// =========================================================================
	// API de suscripciones
	// =========================================================================
	await t.test('API: crear devuelve el secreto una vez; GET nunca; cifrado en BD', async () => {
		const created = await post(admin, A, {
			name: 'CRM',
			targetUrl: 'https://Hooks.Example.com/sf',
			eventTypes: ['incident.status_changed', 'incident.created']
		});
		assert.equal(created.status, 201);
		const { webhook, secret } = created.json;
		assert.match(secret, /^whsec_/);
		assert.deepEqual(Object.keys(webhook).sort(), [
			'active',
			'createdAt',
			'eventTypes',
			'hasSecret',
			'id',
			'name',
			'targetUrl',
			'updatedAt'
		]);
		assert.equal(webhook.targetUrl, 'https://hooks.example.com/sf');
		assert.deepEqual(webhook.eventTypes, ['incident.created', 'incident.status_changed']);
		assert.equal(created.headers.get('cache-control'), 'private, no-store');
		const list = await call(routes.collection.GET, { who: admin, org: A });
		const one = await call(routes.item.GET, { who: admin, org: A, id: webhook.id });
		for (const res of [list, one]) {
			assert.equal(res.status, 200);
			assert.ok(!res.text.includes(secret), 'GET sin secreto');
			assert.ok(!/ciphertext|authTag|secretVersion/.test(res.text));
		}
		const [stored] = await db
			.select()
			.from(s.webhookSecrets)
			.where(eq(s.webhookSecrets.subscriptionId, webhook.id));
		assert.ok(
			!JSON.stringify(stored).includes(secret) && !JSON.stringify(stored).includes(secret.slice(6))
		);
		assert.equal(
			secrets.decryptWebhookSecret(KEY, stored, { subscriptionId: webhook.id, version: 1 }),
			secret
		);
	});

	await t.test('API: validación estricta del cuerpo, eventos, URL y SSRF', async () => {
		const base = {
			name: 'X',
			targetUrl: 'https://hooks.example.com/x',
			eventTypes: ['incident.created']
		};
		for (const [body, code] of [
			[{ ...base, secret: 'mine' }, 'INVALID_INPUT'],
			[{ ...base, organizationId: B.org.id }, 'INVALID_INPUT'],
			[{ ...base, eventTypes: ['*'] }, 'INVALID_INPUT'],
			[{ ...base, eventTypes: ['incident.deleted'] }, 'INVALID_INPUT'],
			[{ ...base, eventTypes: [] }, 'INVALID_INPUT'],
			[{ ...base, eventTypes: ['incident.created', 'incident.created'] }, 'INVALID_INPUT'],
			[{ ...base, eventTypes: 'incident.created' }, 'INVALID_INPUT'],
			[{ ...base, name: 'x'.repeat(121) }, 'INVALID_INPUT'],
			[{ ...base, name: ' ' }, 'INVALID_INPUT'],
			[{ name: 'X', eventTypes: ['incident.created'] }, 'INVALID_TARGET'],
			[{ ...base, targetUrl: 'http://hooks.example.com/x' }, 'INVALID_TARGET'],
			[{ ...base, targetUrl: 'https://u:p@hooks.example.com/x' }, 'INVALID_TARGET'],
			[{ ...base, targetUrl: 'https://192.168.0.10/x' }, 'TARGET_NOT_ALLOWED'],
			[{ ...base, targetUrl: 'https://localhost/x' }, 'TARGET_NOT_ALLOWED']
		]) {
			const res = await post(admin, A, body);
			assert.equal(res.status, 400, JSON.stringify(body));
			assert.equal(res.json.error.code, code, JSON.stringify(body));
		}
		assert.equal((await post(admin, A, undefined, { rawBody: 'x'.repeat(9000) })).status, 400);
		assert.equal((await post(admin, A, undefined, { rawBody: '[1]' })).status, 400);
		const created = await post(admin, A, {
			...base,
			eventTypes: [
				...(await server.ssrLoadModule('/src/lib/automation/events.ts')).AUTOMATION_EVENT_TYPES
			]
		});
		assert.equal(created.status, 201, 'todos los tipos del catálogo');
	});

	await t.test(
		'API: RBAC (admin sí; técnico, cliente, anónimo no); Origin; aislamiento',
		async () => {
			const created = await post(admin, A, {
				name: 'RBAC',
				targetUrl: 'https://hooks.example.com/rbac',
				eventTypes: ['incident.created']
			});
			const id = created.json.webhook.id;
			for (const who of [tech, customer])
				for (const res of [
					await call(routes.collection.GET, { who, org: A }),
					await post(who, A, {
						name: 'x',
						targetUrl: 'https://hooks.example.com/x',
						eventTypes: ['incident.created']
					}),
					await call(routes.item.PATCH, {
						method: 'PATCH',
						who,
						org: A,
						id,
						body: { active: false }
					}),
					await call(routes.rotate.POST, { method: 'POST', who, org: A, id })
				])
					assert.equal(res.status, 403);
			assert.equal((await call(routes.collection.GET, { org: A })).status, 401);
			assert.equal(
				(
					await post(
						admin,
						A,
						{
							name: 'x',
							targetUrl: 'https://hooks.example.com/x',
							eventTypes: ['incident.created']
						},
						{ origin: 'https://evil.example' }
					)
				).status,
				403
			);
			assert.equal(
				(await call(routes.item.DELETE, { method: 'DELETE', who: admin, org: A, id, origin: null }))
					.status,
				403
			);
			// otra organización: sin permiso en A, y el id de A no existe en B
			assert.equal((await call(routes.collection.GET, { who: adminB, org: A })).status, 403);
			for (const res of [
				await call(routes.item.GET, { who: adminB, org: B, id }),
				await call(routes.item.PATCH, {
					method: 'PATCH',
					who: adminB,
					org: B,
					id,
					body: { active: false }
				}),
				await call(routes.rotate.POST, { method: 'POST', who: adminB, org: B, id }),
				await call(routes.deliveries.GET, { who: adminB, org: B, id })
			])
				assert.ok([404].includes(res.status), String(res.status));
			const listB = await call(routes.collection.GET, { who: adminB, org: B });
			assert.ok(!listB.json.webhooks.some((w) => w.id === id));
			assert.equal(
				(await call(routes.item.GET, { who: admin, org: A, id })).json.webhook.active,
				true
			);
		}
	);

	await t.test(
		'API: PATCH estricto, DELETE desactiva (204 idempotente), rotación una vez',
		async () => {
			const created = await post(admin, A, {
				name: 'Patch',
				targetUrl: 'https://hooks.example.com/p',
				eventTypes: ['incident.created']
			});
			const id = created.json.webhook.id;
			const patch = (body) =>
				call(routes.item.PATCH, { method: 'PATCH', who: admin, org: A, id, body });
			const ok = await patch({
				name: 'Nuevo',
				eventTypes: ['incident.assigned'],
				targetUrl: 'https://hooks.example.com/q'
			});
			assert.equal(ok.status, 200);
			assert.equal(ok.json.webhook.name, 'Nuevo');
			assert.deepEqual(ok.json.webhook.eventTypes, ['incident.assigned']);
			for (const body of [
				{},
				{ secret: 'x' },
				{ active: 'false' },
				{ targetUrl: 'https://10.0.0.1/' },
				{ eventTypes: ['*'] }
			])
				assert.equal((await patch(body)).status, 400, JSON.stringify(body));
			const rotated = await call(routes.rotate.POST, { method: 'POST', who: admin, org: A, id });
			assert.equal(rotated.status, 200);
			assert.match(rotated.json.secret, /^whsec_/);
			assert.notEqual(rotated.json.secret, created.json.secret);
			const [row] = await db
				.select()
				.from(s.webhookSubscriptions)
				.where(eq(s.webhookSubscriptions.id, id));
			assert.equal(row.currentSecretVersion, 2);
			const after = await call(routes.item.GET, { who: admin, org: A, id });
			assert.ok(
				!after.text.includes(rotated.json.secret) && !after.text.includes(created.json.secret)
			);
			for (let i = 0; i < 2; i++)
				assert.equal(
					(await call(routes.item.DELETE, { method: 'DELETE', who: admin, org: A, id })).status,
					204
				);
			assert.equal(
				(await call(routes.item.GET, { who: admin, org: A, id })).json.webhook.active,
				false
			);
			assert.equal(
				(await call(routes.item.GET, { who: admin, org: A, id: randomUUID() })).status,
				404
			);
		}
	);

	await t.test('sin clave de cifrado: crear/rotar responde 503 y no escribe nada', async () => {
		const count = async () => (await db.select().from(s.webhookSubscriptions)).length;
		const before = await count();
		delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
		try {
			const res = await post(admin, A, {
				name: 'K',
				targetUrl: 'https://hooks.example.com/k',
				eventTypes: ['incident.created']
			});
			assert.equal(res.status, 503);
			assert.equal(res.json.error.code, 'WEBHOOKS_NOT_CONFIGURED');
			assert.equal(await count(), before);
		} finally {
			process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = KEY_HEX;
		}
	});

	// =========================================================================
	// Fanout
	// =========================================================================
	await t.test(
		'fanout: coincidentes sí, no coincidentes/inactivas/otra org no; idempotente',
		async () => {
			const match1 = await subscribe(A, ['incident.created']);
			const match2 = await subscribe(A, ['incident.created', 'incident.assigned']);
			const other = await subscribe(A, ['incident.status_changed']);
			const inactive = await subscribe(A, ['incident.created']);
			await subs.deactivateWebhookSubscription(db, A.org.id, inactive.webhook.id);
			const inB = await subscribe(B, ['incident.created'], 'hooks-b.example.com');
			const inc = await incident(A);
			const [event] = (
				await events.listAutomationEventsInternal(db, {
					organizationId: A.org.id,
					aggregateId: inc.id
				})
			).events;
			const [d1] = await deliveriesOf(match1.webhook.id);
			const [d2] = await deliveriesOf(match2.webhook.id);
			assert.ok(d1 && d2);
			assert.equal((await deliveriesOf(other.webhook.id)).length, 0);
			assert.equal((await deliveriesOf(inactive.webhook.id)).length, 0);
			assert.equal((await deliveriesOf(inB.webhook.id)).length, 0);
			assert.equal(d1.eventId, event.id);
			assert.equal(d1.secretVersion, 1);
			assert.equal(d1.targetUrl, 'https://hooks.example.com/sf/events?x=1');
			assert.deepEqual(JSON.parse(d1.body), {
				id: event.id,
				type: 'incident.created',
				schemaVersion: 1,
				occurredAt: event.occurredAt,
				organizationId: A.org.id,
				aggregate: { type: 'incident', id: inc.id },
				data: event.payload
			});
			assert.ok(!d1.body.includes('privad') && !d1.body.includes('Cliente SL'));
			assert.ok(!d1.body.includes('whsec_'));
			// segunda pasada de fanout del mismo evento: sin duplicados
			const again = await db.transaction((tx) => fanout.fanoutWebhookDeliveries(tx, event));
			assert.equal(again.created, 0);
			assert.equal((await deliveriesOf(match1.webhook.id)).length, 1);
			for (const sub of [match1, match2, other, inB])
				await subs.deactivateWebhookSubscription(
					db,
					sub === inB ? B.org.id : A.org.id,
					sub.webhook.id
				);
		}
	);

	await t.test(
		'atomicidad: fallo del intent webhook revierte dominio, historial, evento, notificaciones',
		async () => {
			const sub = await subscribe(A, [
				'incident.created',
				'incident.assigned',
				'incident.public_comment_added'
			]);
			await isolate(sub.webhook.id);
			const who = await member(A, [A.tech]);
			await prefs.setNotificationPreference(
				db,
				{ organizationId: A.org.id, userId: who.user.id },
				'incident.assigned',
				{ emailEnabled: true }
			);
			const countOf = async (table) => (await db.select().from(table)).length;
			const snapshot = async () => ({
				incidents: await countOf(s.incidents),
				history: await countOf(s.incidentHistory),
				events: await countOf(s.automationEvents),
				notifications: await countOf(s.notifications),
				emails: await countOf(s.notificationDeliveries),
				webhooks: await countOf(s.webhookDeliveries),
				messages: await countOf(s.incidentMessages)
			});
			const inc = await incident(A);
			const before = await snapshot();
			await withFailing('webhook_deliveries', async () => {
				await assert.rejects(incident(A));
				await assert.rejects(
					assignIncidentRecord(
						db,
						{ organizationId: A.org.id, actorUserId: admin.user.id },
						inc.id,
						{ assignedToUserId: who.user.id }
					)
				);
				await assert.rejects(
					createPublicComment(
						db,
						{ organizationId: A.org.id, incidentId: inc.id, actorUserId: admin.user.id },
						'Hola'
					)
				);
			});
			assert.deepEqual(await snapshot(), before);
			const [row] = await db.select().from(s.incidents).where(eq(s.incidents.id, inc.id));
			assert.equal(row.assignedToUserId, null);
			// flujo representativo sin fallo: todo junto
			await assignIncidentRecord(
				db,
				{ organizationId: A.org.id, actorUserId: admin.user.id },
				inc.id,
				{ assignedToUserId: who.user.id }
			);
			const after = await snapshot();
			assert.equal(after.events, before.events + 1);
			assert.equal(after.webhooks, before.webhooks + 1);
			assert.equal(after.notifications, before.notifications + 1);
			assert.equal(after.emails, before.emails + 1);
			await subs.deactivateWebhookSubscription(db, A.org.id, sub.webhook.id);
		}
	);

	// =========================================================================
	// Processor
	// =========================================================================
	await t.test(
		'éxito: un POST, cabeceras exactas, firma verificable, sent, sin reenvío',
		async () => {
			const sub = await subscribe(A, ['incident.created']);
			await isolate(sub.webhook.id);
			const inc = await incident(A);
			const [d] = await deliveriesOf(sub.webhook.id);
			const http = httpMock({ status: 204 });
			let tick = 0;
			const now = future();
			const result = await run({ httpClient: http, now, clock: () => (tick += 37) });
			assert.deepEqual(result, { claimed: 1, sent: 1, retried: 0, failed: 0, leaseLost: 0 });
			assert.equal(http.calls.length, 1);
			const [req] = http.calls;
			assert.equal(req.url, 'https://hooks.example.com/sf/events?x=1');
			assert.deepEqual(req.addresses, [{ address: '93.184.216.34', family: 4 }]);
			assert.equal(req.timeoutMs, 10_000);
			assert.equal(req.body, d.body);
			assert.deepEqual(Object.keys(req.headers).sort(), [
				'Content-Type',
				'User-Agent',
				'X-SoporteFlow-Delivery-Id',
				'X-SoporteFlow-Event-Id',
				'X-SoporteFlow-Event-Type',
				'X-SoporteFlow-Signature',
				'X-SoporteFlow-Timestamp'
			]);
			assert.equal(req.headers['Content-Type'], 'application/json');
			assert.equal(req.headers['User-Agent'], 'SoporteFlow-Webhooks/1.0');
			assert.equal(req.headers['X-SoporteFlow-Event-Id'], d.eventId);
			assert.equal(req.headers['X-SoporteFlow-Event-Type'], 'incident.created');
			assert.equal(req.headers['X-SoporteFlow-Delivery-Id'], d.id);
			assert.equal(
				req.headers['X-SoporteFlow-Timestamp'],
				String(Math.floor(now.getTime() / 1000))
			);
			assert.ok(verify(sub.secret, req), 'firma verificable con el secreto mostrado al crear');
			assert.equal(JSON.parse(req.body).aggregate.id, inc.id);
			const row = await byId(d.id);
			assert.equal(row.status, 'sent');
			assert.equal(row.deliveredAt.getTime(), now.getTime());
			assert.equal(row.attemptCount, 1);
			assert.equal(row.lastStatusCode, 204);
			assert.equal(row.responseTimeMs, 37);
			assert.equal((await run({ httpClient: http, now: future(MIN) })).claimed, 0);
			assert.equal(http.calls.length, 1);
		}
	);

	await t.test('historial de entregas: DTO seguro, paginado, solo admin', async () => {
		const sub = await subscribe(A, ['incident.created']);
		await isolate(sub.webhook.id);
		await incident(A);
		await incident(A);
		await incident(A);
		const get = (who, query) =>
			routes.deliveries.GET({
				url: new URL(`${ORIGIN}/api/webhooks/${sub.webhook.id}/deliveries?${query}`),
				params: { id: sub.webhook.id },
				request: new Request(`${ORIGIN}/x`, { headers: { cookie: who.cookie } })
			});
		const page1 = await get(admin, `organizationId=${A.org.id}&limit=2`);
		assert.equal(page1.status, 200);
		const body1 = await page1.json();
		assert.equal(body1.deliveries.length, 2);
		assert.ok(body1.nextCursor);
		assert.deepEqual(Object.keys(body1.deliveries[0]).sort(), [
			'attemptCount',
			'createdAt',
			'deliveredAt',
			'eventId',
			'eventType',
			'failedAt',
			'id',
			'lastErrorCode',
			'lastStatusCode',
			'nextAttemptAt',
			'responseTimeMs',
			'status'
		]);
		const body2 = await (
			await get(admin, `organizationId=${A.org.id}&limit=2&cursor=${body1.nextCursor}`)
		).json();
		assert.equal(body2.deliveries.length, 1);
		assert.equal(body2.nextCursor, null);
		const ids = [...body1.deliveries, ...body2.deliveries].map((d) => d.id);
		assert.equal(new Set(ids).size, 3);
		assert.equal((await get(tech, `organizationId=${A.org.id}`)).status, 403);
		for (const q of ['limit=0', 'limit=101', 'limit=x', 'cursor=@@', 'extra=1'])
			assert.equal((await get(admin, `organizationId=${A.org.id}&${q}`)).status, 400, q);
		await subs.deactivateWebhookSubscription(db, A.org.id, sub.webhook.id);
	});

	await t.test(
		'reintentos: 500/408/429/timeout/red con backoff; nada antes de tiempo; misma fila -> sent',
		async () => {
			const sub = await subscribe(A, ['incident.created']);
			await isolate(sub.webhook.id);
			await incident(A);
			const [d] = await deliveriesOf(sub.webhook.id);
			const TE = client.WebhookTransportError;
			const http = httpMock(
				{ status: 500 },
				{ status: 408 },
				new TE('TIMEOUT'),
				new TE('CONNECTION_FAILED'),
				{ status: 200 }
			);
			let now = future();
			const seen = [];
			for (let i = 0; i < 5; i++) {
				const r = await run({ httpClient: http, now });
				assert.equal(r.claimed, 1);
				const row = await byId(d.id);
				seen.push([row.status, row.attemptCount, row.lastErrorCode, row.lastStatusCode]);
				if (row.status === 'retry') {
					assert.equal(
						(await run({ httpClient: http, now: new Date(row.nextAttemptAt.getTime() - 1000) }))
							.claimed,
						0,
						'antes de nextAttemptAt no se reintenta'
					);
					now = row.nextAttemptAt;
				}
			}
			assert.deepEqual(seen, [
				['retry', 1, 'HTTP_5XX', 500],
				['retry', 2, 'HTTP_4XX', 408],
				['retry', 3, 'TIMEOUT', null],
				['retry', 4, 'CONNECTION_FAILED', null],
				['sent', 5, null, 200]
			]);
			assert.equal(http.calls.length, 5);
			assert.equal((await deliveriesOf(sub.webhook.id)).length, 1, 'misma fila');
			assert.equal(new Set(http.calls.map((c) => c.headers['X-SoporteFlow-Event-Id'])).size, 1);
		}
	);

	await t.test('backoff y Retry-After: segundos, fecha HTTP, límites', async () => {
		const now = new Date('2026-01-01T00:00:00Z');
		assert.deepEqual(
			[1, 2, 3, 4, 5].map(
				(n) => proc.nextWebhookAttemptAt(n, now)?.getTime() - now.getTime() || null
			),
			[MIN, 5 * MIN, 30 * MIN, 120 * MIN, null]
		);
		assert.equal(proc.parseRetryAfter('120', now), 120_000);
		assert.equal(proc.parseRetryAfter('1', now), 60_000, 'mínimo 1 min');
		assert.equal(proc.parseRetryAfter('999999999', now), 24 * 60 * MIN, 'máximo 24 h');
		assert.equal(proc.parseRetryAfter('Thu, 01 Jan 2026 00:10:00 GMT', now), 10 * MIN);
		for (const bad of [null, '', 'soon', '-5', '1e9', '12:00'])
			assert.equal(proc.parseRetryAfter(bad, now), null, String(bad));
		const sub = await subscribe(A, ['incident.created']);
		await isolate(sub.webhook.id);
		await incident(A);
		const [d] = await deliveriesOf(sub.webhook.id);
		const t0 = future();
		await run({ httpClient: httpMock({ status: 429, retryAfter: '600' }), now: t0 });
		let row = await byId(d.id);
		assert.deepEqual([row.status, row.lastErrorCode], ['retry', 'RATE_LIMITED']);
		assert.equal(row.nextAttemptAt.getTime(), t0.getTime() + 10 * MIN);
		const t1 = row.nextAttemptAt;
		await run({ httpClient: httpMock({ status: 503, retryAfter: '86400000' }), now: t1 });
		row = await byId(d.id);
		assert.equal(
			row.nextAttemptAt.getTime(),
			t1.getTime() + 24 * 60 * MIN,
			'503 + Retry-After acotado'
		);
	});

	await t.test('máximo de intentos: 5 fallos transitorios -> failed MAX_ATTEMPTS', async () => {
		const sub = await subscribe(A, ['incident.created']);
		await isolate(sub.webhook.id);
		await incident(A);
		const [d] = await deliveriesOf(sub.webhook.id);
		let now = future();
		for (let i = 0; i < 5; i++) {
			await run({ httpClient: httpMock({ status: 502 }), now });
			const row = await byId(d.id);
			if (row.nextAttemptAt) now = row.nextAttemptAt;
		}
		const row = await byId(d.id);
		assert.deepEqual(
			[row.status, row.attemptCount, row.lastErrorCode, row.lastStatusCode],
			['failed', 5, 'MAX_ATTEMPTS', 502]
		);
		assert.equal(
			(await run({ httpClient: httpMock(), now: new Date(now.getTime() + 48 * 60 * MIN) })).claimed,
			0
		);
	});

	await t.test(
		'fallos permanentes: 4xx, redirect, SSRF por DNS, URL inválida -> failed sin reintento',
		async () => {
			const cases = [
				[{ status: 400 }, 'HTTP_4XX'],
				[{ status: 401 }, 'HTTP_4XX'],
				[{ status: 403 }, 'HTTP_4XX'],
				[{ status: 404 }, 'HTTP_4XX'],
				[{ status: 301 }, 'REDIRECT_NOT_ALLOWED'],
				[{ status: 307 }, 'REDIRECT_NOT_ALLOWED'],
				[{ status: 99 }, 'INVALID_RESPONSE']
			];
			for (const [response, code] of cases) {
				const sub = await subscribe(A, ['incident.created']);
				await isolate(sub.webhook.id);
				await incident(A);
				const [d] = await deliveriesOf(sub.webhook.id);
				await run({ httpClient: httpMock(response) });
				const row = await byId(d.id);
				assert.deepEqual(
					[row.status, row.lastErrorCode, row.attemptCount],
					['failed', code, 1],
					String(response.status)
				);
			}
			// DNS que resuelve a privado (o mixto): bloqueado, sin POST
			for (const answer of [['10.1.2.3'], ['93.184.216.34', '169.254.169.254']]) {
				dns.set('rebind.example.com', answer);
				const sub = await subscribe(A, ['incident.created'], 'rebind.example.com');
				await isolate(sub.webhook.id);
				await incident(A);
				const [d] = await deliveriesOf(sub.webhook.id);
				const http = httpMock();
				await run({ httpClient: http });
				assert.equal(http.calls.length, 0);
				assert.deepEqual(
					[(await byId(d.id)).status, (await byId(d.id)).lastErrorCode],
					['failed', 'SSRF_BLOCKED']
				);
			}
			// DNS que falla: transitorio
			const sub = await subscribe(A, ['incident.created'], 'gone.example.com');
			await isolate(sub.webhook.id);
			await incident(A);
			const [d] = await deliveriesOf(sub.webhook.id);
			await run({ httpClient: httpMock() });
			assert.deepEqual(
				[(await byId(d.id)).status, (await byId(d.id)).lastErrorCode],
				['retry', 'DNS_RESOLUTION_FAILED']
			);
		}
	);

	await t.test('DNS se revalida en cada intento (rebinding entre creación y envío)', async () => {
		dns.set('flip.example.com', ['93.184.216.40']);
		const sub = await subscribe(A, ['incident.created'], 'flip.example.com');
		await isolate(sub.webhook.id);
		await incident(A);
		const [d] = await deliveriesOf(sub.webhook.id);
		const t0 = future();
		await run({ httpClient: httpMock({ status: 500 }), now: t0 });
		dns.set('flip.example.com', ['127.0.0.1']);
		const http = httpMock();
		await run({ httpClient: http, now: (await byId(d.id)).nextAttemptAt });
		assert.equal(http.calls.length, 0);
		assert.equal((await byId(d.id)).lastErrorCode, 'SSRF_BLOCKED');
	});

	await t.test(
		'lease: sin doble envío secuencial; recuperación tras expirar; token antiguo no escribe',
		async () => {
			const sub = await subscribe(A, ['incident.created']);
			await isolate(sub.webhook.id);
			await incident(A);
			const [d] = await deliveriesOf(sub.webhook.id);
			const now = future();
			const [first] = await proc.claimDueWebhookDeliveries(db, { now });
			assert.equal(first.id, d.id);
			assert.equal((await proc.claimDueWebhookDeliveries(db, { now })).length, 0);
			assert.equal(
				(await run({ httpClient: httpMock(), now })).claimed,
				0,
				'en proceso: no se reenvía'
			);
			const later = new Date(now.getTime() + proc.WEBHOOK_LEASE_MS);
			const [second] = await proc.claimDueWebhookDeliveries(db, { now: later });
			assert.notEqual(second.leaseToken, first.leaseToken);
			assert.equal(
				await proc.markWebhookDeliverySent(db, {
					id: d.id,
					leaseToken: first.leaseToken,
					now: later
				}),
				false
			);
			assert.equal(
				await proc.markWebhookDeliverySent(db, {
					id: d.id,
					leaseToken: second.leaseToken,
					now: later
				}),
				true
			);
			assert.equal(
				await proc.markWebhookDeliverySent(db, {
					id: d.id,
					leaseToken: second.leaseToken,
					now: later
				}),
				false
			);
			for (const limit of [0, 101, 2.5])
				await assert.rejects(
					proc.claimDueWebhookDeliveries(db, { now, limit }),
					(e) => e.code === 'INVALID_INPUT'
				);
		}
	);

	await t.test('desactivar la suscripción cancela entregas pendientes (no se envían)', async () => {
		const sub = await subscribe(A, ['incident.created']);
		await isolate(sub.webhook.id);
		await incident(A);
		const [d] = await deliveriesOf(sub.webhook.id);
		await subs.deactivateWebhookSubscription(db, A.org.id, sub.webhook.id);
		const http = httpMock();
		await run({ httpClient: http });
		assert.equal(http.calls.length, 0);
		assert.deepEqual(
			[(await byId(d.id)).status, (await byId(d.id)).lastErrorCode],
			['failed', 'SUBSCRIPTION_INACTIVE']
		);
		await subs.updateWebhookSubscription(db, A.org.id, sub.webhook.id, { active: true });
		await run({ httpClient: http });
		assert.equal(http.calls.length, 0, 'reactivar no revive entregas canceladas');
		assert.equal(
			(await incident(A)) && (await deliveriesOf(sub.webhook.id)).length,
			2,
			'eventos nuevos sí'
		);
		await subs.deactivateWebhookSubscription(db, A.org.id, sub.webhook.id);
	});

	await t.test(
		'rotación con entregas pendientes: cada entrega se firma con su versión',
		async () => {
			const sub = await subscribe(A, ['incident.created']);
			await isolate(sub.webhook.id);
			await incident(A);
			const rotated = await subs.rotateWebhookSecret(db, A.org.id, sub.webhook.id, {
				encryptionKey: KEY
			});
			await incident(A);
			const rows = (await deliveriesOf(sub.webhook.id)).sort(
				(a, b) => a.secretVersion - b.secretVersion
			);
			assert.deepEqual(
				rows.map((r) => r.secretVersion),
				[1, 2]
			);
			const http = httpMock({ status: 200 }, { status: 200 });
			await run({ httpClient: http });
			const byDelivery = new Map(
				http.calls.map((c) => [c.headers['X-SoporteFlow-Delivery-Id'], c])
			);
			const old = byDelivery.get(rows[0].id);
			const fresh = byDelivery.get(rows[1].id);
			assert.ok(
				verify(sub.secret, old) && !verify(rotated.secret, old),
				'pendiente previa: secreto v1'
			);
			assert.ok(verify(rotated.secret, fresh) && !verify(sub.secret, fresh), 'nueva: secreto v2');
		}
	);

	await t.test(
		'sin clave al enviar: reintento CONFIGURATION_ERROR; el dominio no se ve afectado',
		async () => {
			const sub = await subscribe(A, ['incident.created']);
			await isolate(sub.webhook.id);
			delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
			let d;
			try {
				const inc = await incident(A); // el fanout no necesita la clave
				assert.ok(inc.id);
				[d] = await deliveriesOf(sub.webhook.id);
				const http = httpMock();
				await proc.processDueWebhookDeliveries(db, { lookup, httpClient: http, now: future() });
				assert.equal(http.calls.length, 0);
				assert.deepEqual(
					[(await byId(d.id)).status, (await byId(d.id)).lastErrorCode],
					['retry', 'CONFIGURATION_ERROR']
				);
				await run({
					httpClient: http,
					encryptionKey: randomBytes(32),
					now: (await byId(d.id)).nextAttemptAt
				});
				assert.equal((await byId(d.id)).lastErrorCode, 'CONFIGURATION_ERROR', 'clave equivocada');
			} finally {
				process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = KEY_HEX;
			}
			const http = httpMock();
			await proc.processDueWebhookDeliveries(db, {
				lookup,
				httpClient: http,
				now: (await byId(d.id)).nextAttemptAt
			});
			assert.equal((await byId(d.id)).status, 'sent');
			assert.ok(verify(sub.secret, http.calls[0]));
		}
	);

	await t.test('retención: solo sent/failed antiguos', async () => {
		const sub = await subscribe(A, ['incident.created']);
		await isolate(sub.webhook.id);
		await incident(A);
		await run({ httpClient: httpMock() });
		await incident(A);
		const pendingBefore = (await deliveriesOf(sub.webhook.id)).filter(
			(d) => d.status === 'pending'
		).length;
		assert.ok(pendingBefore >= 1);
		const deleted = await proc.deleteOldWebhookDeliveries(db, { before: future(24 * 60 * MIN) });
		assert.ok(deleted >= 1);
		const left = await db.select().from(s.webhookDeliveries);
		assert.ok(
			left.every(
				(d) => !['sent', 'failed'].includes(d.status) || d.updatedAt >= future(24 * 60 * MIN)
			)
		);
		assert.equal(
			(await deliveriesOf(sub.webhook.id)).filter((d) => d.status === 'pending').length,
			pendingBefore
		);
		await assert.rejects(
			proc.deleteOldWebhookDeliveries(db, { before: 'x' }),
			(e) => e.code === 'INVALID_INPUT'
		);
	});

	await t.test(
		'cliente HTTP por defecto: conexión fijada a la IP validada y timeout acotado',
		async () => {
			const silent = net.createServer(() => {}); // accepts, never answers the TLS handshake
			await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
			const closing = net.createServer((socket) => socket.destroy());
			await new Promise((resolve) => closing.listen(0, '127.0.0.1', resolve));
			try {
				const request = (port, timeoutMs) =>
					client.defaultWebhookHttpClient.post({
						// hostname never resolves: only the pinned address can be used
						url: `https://pinned.invalid:${port}/hook`,
						addresses: [{ address: '127.0.0.1', family: 4 }],
						headers: { 'Content-Type': 'application/json' },
						body: '{}',
						timeoutMs
					});
				const started = Date.now();
				await assert.rejects(request(silent.address().port, 300), (e) => e.code === 'TIMEOUT');
				assert.ok(Date.now() - started < 5000, 'timeout total acotado');
				await assert.rejects(request(closing.address().port, 5000), (e) =>
					['CONNECTION_FAILED', 'TLS_ERROR'].includes(e.code)
				);
			} finally {
				silent.close();
				closing.close();
			}
		}
	);

	// =========================================================================
	// Fronteras
	// =========================================================================
	await t.test(
		'5.4W-A H2: un ítem del lote recuperado por otro worker no se envía (renovación de lease)',
		async () => {
			const sub = await subscribe(A, ['incident.created']);
			await isolate(sub.webhook.id);
			await incident(A);
			await incident(A);
			let startedA;
			const started = new Promise((r) => (startedA = r));
			let openGate;
			const gate = new Promise((r) => (openGate = r));
			const callsA = [];
			const httpA = {
				post: async (request) => {
					callsA.push(request.headers['X-SoporteFlow-Delivery-Id']);
					if (callsA.length === 1) {
						startedA();
						await gate;
					}
					return { status: 200, retryAfter: null };
				}
			};
			const now = future();
			const runA = run({ httpClient: httpA, now, limit: 2 }); // A claims both
			await started; // first POST in flight
			const httpB = httpMock({ status: 200 }, { status: 200 });
			const resultB = await run({
				httpClient: httpB,
				now: new Date(now.getTime() + proc.WEBHOOK_LEASE_MS + 1000)
			});
			openGate();
			const resultA = await runA;
			assert.deepEqual([resultB.claimed, resultB.sent], [2, 2]);
			assert.equal(resultA.leaseLost, 2, 'A no escribe ninguno de los dos resultados');
			assert.equal(callsA.length, 1, 'A no envía el ítem que B ya había reclamado');
			const rows = await deliveriesOf(sub.webhook.id);
			assert.ok(rows.every((r) => r.status === 'sent' && r.attemptCount === 2));
		}
	);

	await t.test(
		'5.4W-A H2: la renovación reinicia el lease desde el reloj actual del worker',
		async () => {
			const sub = await subscribe(A, ['incident.created']);
			await isolate(sub.webhook.id);
			await incident(A);
			const [d] = await deliveriesOf(sub.webhook.id);
			const now = future();
			const [claim] = await proc.claimDueWebhookDeliveries(db, { now });
			const later = new Date(now.getTime() + 4 * MIN);
			assert.equal(
				await proc.renewWebhookLease(db, { id: d.id, leaseToken: claim.leaseToken, now: later }),
				true
			);
			assert.equal(
				(await byId(d.id)).nextAttemptAt.getTime(),
				later.getTime() + proc.WEBHOOK_LEASE_MS
			);
			// not reclaimable at the original expiry anymore
			assert.equal(
				(await proc.claimDueWebhookDeliveries(db, { now: new Date(now.getTime() + 6 * MIN) }))
					.length,
				0
			);
			assert.equal(
				await proc.renewWebhookLease(db, { id: d.id, leaseToken: randomUUID(), now: later }),
				false,
				'otro token no renueva'
			);
		}
	);

	await t.test(
		'fronteras: sin cursor por position, sin reglas/n8n/scheduler/inbound, sin logs',
		() => {
			const strip = (code) => code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
			const files = [
				'src/lib/server/services/webhook-fanout.ts',
				'src/lib/server/services/webhook-deliveries.ts',
				'src/lib/server/services/webhook-subscriptions.ts',
				'src/lib/server/webhooks/url-safety.ts',
				'src/lib/server/webhooks/secrets.ts',
				'src/lib/server/webhooks/http-client.ts'
			];
			for (const file of files) {
				const code = strip(fs.readFileSync(file, 'utf8'));
				assert.doesNotMatch(
					code,
					/automationEvents\.position|afterPosition|listAutomationEventsInternal|lastPosition/,
					file
				);
				assert.doesNotMatch(
					code,
					/n8n|automation_rule|automationRule|setInterval|cron|console\./i,
					file
				);
				assert.doesNotMatch(code, /redirect:\s*'follow'|followRedirects/, file);
			}
			const fanoutCode = strip(fs.readFileSync(files[0], 'utf8'));
			assert.doesNotMatch(fanoutCode, /fetch\(|https|request\(/, 'fanout sin HTTP');
			assert.match(strip(fs.readFileSync(files[5], 'utf8')), /lookup:/, 'conexión fijada');
			const producer = fs.readFileSync(
				'src/lib/server/services/automation-event-producer.ts',
				'utf8'
			);
			assert.match(producer, /from '\.\/webhook-fanout'/);
			assert.doesNotMatch(producer, /webhook-deliveries|webhooks\/http-client/);
			for (const file of ['incidents.ts', 'incident-messages.ts'])
				assert.doesNotMatch(
					fs.readFileSync('src/lib/server/services/' + file, 'utf8'),
					/webhook/i,
					file
				);
			const routeFiles = fs.readdirSync('src/routes/api/webhooks', { recursive: true }).map(String);
			assert.ok(
				!routeFiles.some((f) => /inbound|receive|test|ping|retry/i.test(f)),
				routeFiles.join()
			);
			for (const file of fs.readdirSync('src/routes', { recursive: true }))
				if (/\.(ts|svelte)$/.test(String(file)))
					assert.doesNotMatch(
						fs.readFileSync('src/routes/' + file, 'utf8'),
						/processDueWebhookDeliveries|webhook-fanout|fanoutWebhookDeliveries/,
						String(file)
					);
		}
	);
});

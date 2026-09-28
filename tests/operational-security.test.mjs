import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fixture, createCredentialUser } from './helpers/auth-fixture.mjs';

/**
 * 5.4W-E — secrets, structured logging, correlation, email/webhook worker safety.
 * Deterministic: in-memory PGlite, scripted senders/HTTP clients, captured log sink. All secrets
 * below are synthetic.
 */
const KEY_HEX = randomBytes(32).toString('hex');
const STRONG_SECRET = randomBytes(32).toString('base64url');
const PROD = { development: false };
const DEV = { development: true };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('SoporteFlow — Etapa 5.4W-E: seguridad operacional', async (t) => {
	const previousLevel = process.env.LOG_LEVEL;
	const f = await fixture(t);
	process.env.LOG_LEVEL = 'debug';
	t.after(() => {
		if (previousLevel === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = previousLevel;
	});
	const { db, schema: s, server } = f;
	const load = (p) => server.ssrLoadModule(p);
	const logging = await load('/src/lib/server/logging/logger.ts');
	const redact = await load('/src/lib/server/logging/redact.ts');
	const { validateServerEnvironment, ServerConfigurationError } = await load(
		'/src/lib/server/config/env.ts'
	);
	const hooks = await load('/src/hooks.server.ts');
	const abuse = await load('/src/lib/server/security/api-abuse.ts');
	const deliveries = await load('/src/lib/server/services/notification-deliveries.ts');
	const emailModule = await load('/src/lib/server/email/notification-email.ts');
	const webhookDeliveries = await load('/src/lib/server/services/webhook-deliveries.ts');
	const subs = await load('/src/lib/server/services/webhook-subscriptions.ts');
	const secrets = await load('/src/lib/server/webhooks/secrets.ts');
	const invitations = await load('/src/lib/server/services/invitations.ts');
	const { ensureOrganizationRoles } = await load('/src/lib/server/services/roles.ts');
	const { createIncidentRecord } = await load('/src/lib/server/services/incidents.ts');

	/** Captured log lines (parsed) for the current block. */
	let lines = [];
	let raw = [];
	logging.setLogSink((line) => {
		raw.push(line);
		lines.push(JSON.parse(line));
	});
	t.after(() => logging.setLogSink(undefined));
	const capture = () => {
		lines = [];
		raw = [];
		logging.resetLogThrottles();
	};
	const allText = () => raw.join('\n');
	const events = (name) => lines.filter((l) => l.event === name);

	// ---------------------------------------------------------------- HTTP helpers (hooks)
	let ipSeq = 0;
	function event({ method = 'GET', pathname = '/api/me', route, body, headers = {}, ip } = {}) {
		const url = new URL('http://localhost' + pathname);
		const h = new Headers(headers);
		if (body !== undefined) h.set('content-type', 'application/json');
		if (method !== 'GET' && !h.has('origin')) h.set('origin', 'http://localhost');
		const address = ip ?? `198.51.100.${++ipSeq % 250}`;
		return {
			url,
			request: new Request(url, {
				method,
				headers: h,
				body: body === undefined ? undefined : JSON.stringify(body)
			}),
			route: { id: route ?? pathname },
			params: {},
			locals: {},
			getClientAddress: () => address
		};
	}
	const handle = (e, resolve = () => Response.json({ ok: true })) =>
		hooks.handle({ event: e, resolve });

	// =========================================================================
	// 1-5. Startup configuration validation
	// =========================================================================
	const prodEnv = {
		NODE_ENV: 'production',
		BETTER_AUTH_ENABLED: 'true',
		BETTER_AUTH_SECRET: STRONG_SECRET,
		BETTER_AUTH_URL: 'https://support.example.com',
		DATABASE_URL: 'postgresql://app:db-password-9f8e7d@db.internal:5432/soporteflow',
		WEBHOOK_SECRET_ENCRYPTION_KEY: KEY_HEX
	};
	const configIssues = (env, options = PROD) => {
		try {
			validateServerEnvironment(env, options);
			return null;
		} catch (error) {
			assert.ok(error instanceof ServerConfigurationError, String(error));
			return error;
		}
	};

	await t.test('1. producción: secretos y variables requeridos', () => {
		const ok = validateServerEnvironment(prodEnv, PROD);
		assert.equal(ok.mode, 'production');
		assert.equal(ok.auth, 'enabled');
		assert.equal(ok.webhookSigning, 'configured');
		assert.equal(ok.database, 'postgresql://db.internal:5432/soporteflow', 'sin credenciales');
		for (const variable of ['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'DATABASE_URL']) {
			const error = configIssues({ ...prodEnv, [variable]: undefined });
			assert.ok(error, variable);
			assert.deepEqual(
				error.issues.map((i) => i.variable),
				[variable]
			);
			assert.match(error.message, new RegExp(`${variable} is missing`));
		}
		// production needs the public origin even with auth disabled (W-C Origin policy)
		const noAuth = configIssues({ NODE_ENV: 'production' });
		assert.deepEqual(
			noAuth.issues.map((i) => i.variable),
			['BETTER_AUTH_URL']
		);
		// development/test: nothing required unless the feature is enabled
		assert.equal(validateServerEnvironment({}, DEV).auth, 'disabled');
	});

	await t.test('2. secreto débil/por defecto rechazado (y de laboratorio en producción)', () => {
		for (const weak of [
			'changeme',
			'secret',
			'a'.repeat(40),
			'changemechangemechangemechangeme',
			'1234567890123456789012345678901234',
			'short-but-random-9f8e'
		]) {
			const error = configIssues({ ...prodEnv, BETTER_AUTH_SECRET: weak });
			assert.ok(error, weak);
			assert.equal(error.issues[0].variable, 'BETTER_AUTH_SECRET');
		}
		for (const labValue of [
			'synthetic-phase-b-only-secret-123456789',
			'my-test-secret-for-the-app-0123456789abc',
			'example-value-please-replace-0123456789xyz'
		]) {
			assert.match(
				configIssues({ ...prodEnv, BETTER_AUTH_SECRET: labValue }).message,
				/development\/test value/
			);
			// the practical dev/test mode accepts lab secrets (tests never need real secrets)
			assert.equal(
				validateServerEnvironment(
					{ ...prodEnv, NODE_ENV: 'development', BETTER_AUTH_SECRET: labValue },
					DEV
				).auth,
				'enabled'
			);
		}
		for (const key of [
			'00'.repeat(32),
			'ab'.repeat(32),
			'not-a-key',
			randomBytes(16).toString('hex')
		])
			assert.equal(
				configIssues({ ...prodEnv, WEBHOOK_SECRET_ENCRYPTION_KEY: key }).issues[0].variable,
				'WEBHOOK_SECRET_ENCRYPTION_KEY'
			);
		assert.equal(
			configIssues({ ...prodEnv, NODE_ENV: 'test' }).issues[0].variable,
			'NODE_ENV',
			'valores de test en producción'
		);
	});

	await t.test('3-4. BETTER_AUTH_URL inválida; HTTP solo en desarrollo loopback', () => {
		for (const url of [
			'not a url',
			'ftp://support.example.com',
			'https://user:pw@support.example.com',
			'https://support.example.com/app',
			'https://support.example.com/?x=1'
		])
			assert.equal(
				configIssues({ ...prodEnv, BETTER_AUTH_URL: url }).issues[0].variable,
				'BETTER_AUTH_URL',
				url
			);
		const local = { ...prodEnv, NODE_ENV: 'development', BETTER_AUTH_URL: 'http://localhost:5173' };
		assert.equal(validateServerEnvironment(local, DEV).publicOrigin, 'http://localhost:5173');
		assert.match(
			configIssues({ ...prodEnv, BETTER_AUTH_URL: 'http://localhost:5173' }).message,
			/must use HTTPS in production/
		);
		assert.ok(configIssues({ ...local, BETTER_AUTH_URL: 'http://support.example.com' }, DEV));
	});

	await t.test('5. los errores de configuración nunca incluyen valores', () => {
		const values = {
			BETTER_AUTH_SECRET: 'changeme',
			BETTER_AUTH_URL: 'http://intranet.corp.example:8080/secret-path',
			DATABASE_URL: 'mysql://root:hunter2-db-pass@db.example/app',
			WEBHOOK_SECRET_ENCRYPTION_KEY: 'zz-not-hex-but-sensitive-value',
			LOG_LEVEL: 'verbose-sensitive'
		};
		const error = configIssues({ ...prodEnv, ...values });
		assert.deepEqual(error.issues.map((i) => i.variable).sort(), Object.keys(values).sort());
		for (const value of Object.values(values)) assert.ok(!error.message.includes(value), value);
		assert.ok(!error.message.includes('hunter2'));
		assert.ok(!JSON.stringify(error.issues).includes('hunter2'));
		// hooks.server.ts runs it at startup
		const source = fs.readFileSync('src/hooks.server.ts', 'utf8');
		assert.match(source, /export const init: ServerInit/);
		assert.match(source, /validateServerEnvironment\(/);
	});

	// =========================================================================
	// 6-13. Redaction
	// =========================================================================
	await t.test('6-13. redacción central por clave, cabecera, URL y anidamiento', () => {
		const secretValues = {
			authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
			cookie: 'soporteflow-auth.session_token=abc123.def456',
			setCookie: 'soporteflow-auth.session_token=tok-987; HttpOnly',
			password: 'Pa55word!-hunter2',
			invitationToken: randomBytes(32).toString('base64url'),
			webhookSecret: 'whsec_' + randomBytes(32).toString('base64url'),
			databaseUrl: 'postgresql://app:db-pass-123@db.internal/sf',
			apiKey: 'sk_live_0123456789abcdef',
			smtpPass: 'smtp-pass-xyz',
			BETTER_AUTH_SECRET: STRONG_SECRET,
			encryptionKey: KEY_HEX
		};
		// key-based
		const byKey = redact.redactValue(secretValues);
		for (const key of Object.keys(secretValues)) assert.equal(byKey[key], redact.REDACTED, key);
		// headers
		const headers = new Headers({
			Authorization: secretValues.authorization,
			Cookie: secretValues.cookie,
			'Set-Cookie': secretValues.setCookie,
			'X-Api-Key': secretValues.apiKey,
			Accept: 'application/json'
		});
		const h = redact.redactValue(headers);
		for (const name of ['authorization', 'cookie', 'set-cookie', 'x-api-key'])
			assert.equal(h[name], redact.REDACTED, name);
		assert.equal(h.accept, 'application/json');
		// free text (values under innocent keys / error messages)
		const text = redact.redactString(
			[
				'connect postgresql://app:db-pass-123@db.internal/sf failed',
				'Authorization: Bearer abc.def.ghi',
				'cookie soporteflow-auth.session_token=abc123.def456',
				'password=Pa55word!-hunter2&x=1',
				'{"password":"Pa55word!-hunter2","token":"t0k"}',
				`secret ${secretValues.webhookSecret}`,
				`key ${KEY_HEX}`,
				`key64 ${randomBytes(32).toString('base64')}`,
				`invitation ${secretValues.invitationToken}`
			].join(' | '),
			4000
		);
		for (const leak of [
			'db-pass-123',
			'abc.def.ghi',
			'abc123.def456',
			'Pa55word',
			't0k',
			secretValues.webhookSecret.slice(6),
			KEY_HEX,
			secretValues.invitationToken
		])
			assert.ok(!text.includes(leak), leak);
		assert.match(text, /postgresql:\/\/\[REDACTED\]@db\.internal\/sf/);
		// nested + arrays + Error objects
		const nested = redact.redactValue({
			level1: { level2: { credentials: { user: 'u', password: 'p' }, note: 'ok' } },
			list: [{ token: 'x' }, { safe: 'y' }],
			error: new Error('failed for postgresql://u:secret-pw@h/db')
		});
		assert.equal(nested.level1.level2.credentials, redact.REDACTED);
		assert.equal(nested.level1.level2.note, 'ok');
		assert.equal(nested.list[0].token, redact.REDACTED);
		assert.equal(nested.list[1].safe, 'y');
		assert.ok(!JSON.stringify(nested).includes('secret-pw'));
		assert.equal(
			redact.describeDatabaseUrl(secretValues.databaseUrl),
			'postgresql://db.internal/sf'
		);
		// Requests/bodies are never serialized
		assert.equal(
			redact.redactValue(new Request('http://x/', { method: 'POST', body: '{"password":"p"}' })),
			'[omitted]'
		);
	});

	// =========================================================================
	// 14-18. Request id, correlation, safe 500
	// =========================================================================
	await t.test('14-16. requestId generado, estable durante la petición y devuelto', async () => {
		capture();
		let insideId;
		const e = event({ headers: { 'x-request-id': 'forged-id level=error' } });
		const response = await handle(e, () => {
			insideId = e.locals.requestId;
			logging.logger.info('test.inside_request', { step: 1 });
			return Response.json({ ok: true });
		});
		const id = response.headers.get('x-request-id');
		assert.match(id, UUID_V4);
		assert.equal(id, insideId, 'locals y cabecera coinciden');
		assert.notEqual(id, 'forged-id level=error', 'nunca se confía en la cabecera cliente');
		const inside = events('test.inside_request');
		const access = events('http.request');
		assert.equal(inside[0].requestId, id);
		assert.equal(access.length, 1);
		assert.equal(access[0].requestId, id, 'misma correlación en todo el ciclo');
		assert.equal(access[0].status, 200);
		assert.equal(access[0].route, '/api/me');
		assert.ok(!allText().includes('forged-id'));
		// a second request gets a different id
		const other = await handle(event());
		assert.notEqual(other.headers.get('x-request-id'), id);
		// 4xx rejected by W-C before any handler: still correlated
		const rejected = await handle(
			event({
				method: 'POST',
				pathname: '/api/incidents',
				body: {},
				headers: { origin: 'https://evil.test' }
			})
		);
		assert.equal(rejected.status, 403);
		assert.match(rejected.headers.get('x-request-id'), UUID_V4);
		const security = events('security.request_rejected');
		assert.equal(security.at(-1).reason, 'ORIGIN_REJECTED');
		assert.equal(security.at(-1).requestId, rejected.headers.get('x-request-id'));
		assert.ok(!allText().includes('evil.test'), 'el Origin atacante no se registra');
	});

	await t.test('17-18. 500 sin stack en la respuesta; stack redactado en el log', async () => {
		capture();
		const boom = new Error('query failed: postgresql://app:db-pass-500@db.internal/sf');
		const res = await handle(event(), () => {
			throw boom;
		});
		assert.equal(res.status, 500);
		const body = await res.text();
		assert.deepEqual(JSON.parse(body), {
			error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' }
		});
		for (const leak of ['stack', 'db-pass-500', 'postgresql', 'at ', '.ts'])
			assert.ok(!body.includes(leak), leak);
		assert.match(res.headers.get('x-request-id'), UUID_V4);
		const [logged] = events('http.unhandled_error');
		assert.ok(logged, 'error registrado');
		assert.equal(logged.requestId, res.headers.get('x-request-id'));
		assert.equal(logged.error.name, 'Error');
		assert.ok(logged.error.stack.includes('operational-security'), 'stack server-side');
		assert.ok(!allText().includes('db-pass-500'));
		assert.equal(events('http.request')[0].level, 'error');
		// route-level 500s log through logUnexpectedError too (guard over every INTERNAL_ERROR route)
		const routes = fs
			.readdirSync('src/routes/api', { recursive: true })
			.map((p) => path.join('src/routes/api', String(p)))
			.filter((p) => p.endsWith('.ts') && fs.readFileSync(p, 'utf8').includes("'INTERNAL_ERROR'"));
		for (const file of routes) {
			const source = fs.readFileSync(file, 'utf8');
			// invitation public paths are deliberately log-free (W-S guard): access log + requestId only
			if (file.replace(/\\/g, '/').endsWith('invitations/public.ts')) {
				assert.ok(!/logger|logUnexpectedError|console\./.test(source), file);
				continue;
			}
			assert.ok(source.includes('logUnexpectedError('), file);
		}
		// hooks.handleError logs 5xx only, with a generic public message
		capture();
		assert.deepEqual(hooks.handleError({ error: boom, status: 500, event: event() }), {
			message: 'Internal server error.'
		});
		assert.equal(events('http.unhandled_error').length, 1);
		hooks.handleError({ error: new Error('not found'), status: 404, event: event() });
		assert.equal(events('http.unhandled_error').length, 1, '404 no genera ruido');
	});

	// =========================================================================
	// 19-20, 29. Rate limiting events and login privacy
	// =========================================================================
	await t.test(
		'19-20, 29. limitador W-D activo; eventos sin identidad; login nunca registrado',
		async () => {
			capture();
			const ip = '203.0.113.77';
			const email = 'victim.user@example.com';
			const password = 'CorrectHorse-Battery-9';
			const login = () =>
				handle(
					event({
						method: 'POST',
						pathname: '/api/auth/sign-in/email',
						route: '/api/auth/[...all]',
						body: { email, password },
						ip
					}),
					() => Response.json({ code: 'INVALID_EMAIL_OR_PASSWORD' }, { status: 401 })
				);
			const statuses = [];
			for (let i = 0; i < 7; i++) {
				const res = await login();
				statuses.push(res.status);
				assert.match(res.headers.get('x-request-id'), UUID_V4, 'también en 429');
			}
			assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429], 'loginBurst 5/10 s');
			const limited = events('security.rate_limited');
			assert.equal(limited.length, 2);
			assert.equal(limited[0].policy, 'loginBurst');
			assert.equal(typeof limited[0].retryAfterSeconds, 'number');
			const text = allText();
			for (const leak of [email, password, ip, 'victim', abuse.abuseKey('ip', ip)])
				assert.ok(!text.includes(leak), `no registra ${leak}`);
			// 429 responses are not double-logged as access entries
			assert.equal(events('http.request').filter((l) => l.status === 429).length, 0);

			// limiter unavailable: fail-closed 503 for mutations, logged without key material
			capture();
			const guard = abuse.createApiAbuseGuard({
				store: {
					consume() {
						throw new Error('redis://:store-pass@cache.internal down');
					}
				}
			});
			const unavailable = await guard(
				event({ method: 'POST', pathname: '/api/incidents', body: {} })
			);
			assert.equal(unavailable.status, 503);
			const [down] = events('security.limiter_unavailable');
			assert.equal(down.failClosed, true);
			assert.ok(!allText().includes('store-pass'));
		}
	);

	// =========================================================================
	// 21-22. Log injection / DoS
	// =========================================================================
	await t.test('21-22. inyección CRLF/ANSI serializada; metadata truncada; volumen acotado', () => {
		capture();
		const hostile = 'ok\r\n{"level":"error","event":"forged"}\u001b[31mred\u009b2J\u2028\u2029end';
		logging.logger.warn('test.injection', { value: hostile, [hostile]: 1 });
		assert.equal(raw.length, 1);
		const line = raw[0];
		const rawControls = [0x0d, 0x0a, 0x1b, 0x9b, 0x2028, 0x2029].map((c) => String.fromCharCode(c));
		assert.ok(
			rawControls.every((c) => !line.includes(c)),
			'una sola línea sin escapes crudos'
		);
		const parsed = JSON.parse(line);
		assert.equal(parsed.event, 'test.injection');
		assert.equal(parsed.level, 'warn');
		assert.ok(parsed.value.includes('\u001b'), 'el valor original se conserva escapado');
		// forged event names are neutralized
		logging.log('info', 'bad event\nname', {});
		assert.equal(lines.at(-1).event, 'log.invalid_event_name');
		// reserved fields cannot be overwritten
		logging.logger.info('test.reserved', { level: 'error', event: 'x', requestId: 'forged' });
		assert.equal(lines.at(-1).level, 'info');
		assert.equal(lines.at(-1).field_requestId, 'forged');
		assert.equal(lines.at(-1).requestId, undefined);
		// oversized metadata
		capture();
		const huge = 'ab '.repeat(20_000);
		const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, huge]));
		const deep = { a: { b: { c: { d: { e: { f: 'deep' } } } } } };
		logging.logger.info('test.huge', {
			huge,
			wide,
			deep,
			list: Array.from({ length: 500 }, (_, i) => i)
		});
		assert.ok(Buffer.byteLength(raw[0]) <= logging.MAX_LOG_LINE_BYTES);
		const big = JSON.parse(raw[0]);
		assert.equal(big.event, 'test.huge');
		assert.ok(big.truncated || big.huge.length < 1000);
		logging.logger.info('test.bounded', {
			huge,
			deep,
			list: Array.from({ length: 500 }, (_, i) => i)
		});
		const bounded = lines.at(-1);
		assert.ok(bounded.huge.length < 700 && bounded.huge.includes('[truncated'));
		assert.equal(bounded.deep.a.b.c, '[max-depth]');
		assert.equal(bounded.list.length, 21);
		// attacker-triggered events are throttled per bucket
		capture();
		for (let i = 0; i < 100; i++)
			logging.throttled('warn', 'security.request_rejected', 'INVALID_JSON', { i }, 1_000);
		assert.equal(events('security.request_rejected').length, 20);
		logging.throttled('warn', 'security.request_rejected', 'INVALID_JSON', {}, 1_000 + 61_000);
		assert.deepEqual(
			events('log.suppressed').map((l) => l.count),
			[80]
		);
	});

	// =========================================================================
	// 23, 25-26. Email worker
	// =========================================================================
	const [org] = await db
		.insert(s.organizations)
		.values({ name: 'W-E', slug: 'we-' + randomUUID(), status: 'active' })
		.returning();
	const recipient = await createCredentialUser(f, { email: `we-${randomUUID()}@example.test` });
	const [recipientMembership] = await db
		.insert(s.memberships)
		.values({ organizationId: org.id, userId: recipient.id })
		.returning();
	const queue = (title = 'Aviso') =>
		deliveries.createNotificationDelivery(db, {
			organizationId: org.id,
			recipientUserId: recipient.id,
			channel: 'email',
			eventType: 'incident.assigned',
			title,
			message: 'Mensaje con dato interno 4242'
		});
	const deliveryRow = async (id) =>
		(
			await db.select().from(s.notificationDeliveries).where(eq(s.notificationDeliveries.id, id))
		)[0];
	let clock = Date.now() + 60_000;
	const later = (ms = 10 * 60 * 60_000) => new Date((clock += ms));

	await t.test(
		'23. fallo del proveedor de email: sin credenciales, dirección ni contenido',
		async () => {
			capture();
			const d = await queue();
			const sender = new emailModule.MemoryNotificationEmailSender();
			sender.failures.push(
				new emailModule.NotificationEmailError(
					'PROVIDER_ERROR',
					'SMTP 535 auth failed for smtp://mailer:smtp-pass-535@smtp.example.com'
				)
			);
			const result = await deliveries.processDueNotificationDeliveries(db, {
				now: later(),
				sender
			});
			assert.equal(result.retried, 1);
			const [retry] = events('email.delivery_retry');
			assert.equal(retry.deliveryId, d.id);
			assert.equal(retry.code, 'PROVIDER_ERROR');
			assert.equal(retry.attempt, 1);
			assert.equal(retry.worker, 'notification_email');
			assert.match(retry.jobId, UUID_V4);
			const text = allText();
			for (const leak of ['smtp-pass-535', 'SMTP 535', recipient.email, 'Mensaje con dato interno'])
				assert.ok(!text.includes(leak), leak);
			assert.equal((await deliveryRow(d.id)).lastErrorCode, 'PROVIDER_ERROR');
		}
	);

	await t.test('25. un elemento que falla inesperadamente no derriba el lote', async () => {
		capture();
		await db.delete(s.notificationDeliveries);
		const first = await queue('Primero');
		const second = await queue('Segundo');
		let thrown = false;
		// Database wrapper whose first top-level SELECT (recipient lookup of item 1) fails.
		const flaky = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === 'select' && !thrown) {
					return () => {
						thrown = true;
						throw new Error('connection reset; password=db-secret-25');
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const sender = new emailModule.MemoryNotificationEmailSender();
		const result = await deliveries.processDueNotificationDeliveries(flaky, {
			now: later(),
			sender
		});
		assert.equal(result.claimed, 2);
		assert.equal(result.errors, 1);
		assert.equal(result.sent, 1, 'el segundo se envía');
		assert.equal(sender.sent.length, 1);
		const [error] = events('email.delivery_error');
		assert.ok([first.id, second.id].includes(error.deliveryId));
		assert.ok(!allText().includes('db-secret-25'));
		assert.deepEqual(events('email.batch_completed')[0].errors, 1);
		// the failed item keeps its lease: reclaimed after expiry (no lost message)
		const stuck = await deliveryRow(error.deliveryId);
		assert.equal(stuck.status, 'processing');
		const retry = await deliveries.processDueNotificationDeliveries(db, { now: later(), sender });
		assert.equal(retry.sent, 1);
		assert.equal((await deliveryRow(error.deliveryId)).status, 'sent');
	});

	await t.test('26. reintentos agotados: detectables en BD y en el log', async () => {
		capture();
		await db.delete(s.notificationDeliveries);
		const d = await queue();
		await db
			.update(s.notificationDeliveries)
			.set({ attemptCount: deliveries.NOTIFICATION_DELIVERY_MAX_ATTEMPTS - 1 })
			.where(eq(s.notificationDeliveries.id, d.id));
		const sender = new emailModule.MemoryNotificationEmailSender();
		sender.failures.push(new emailModule.NotificationEmailError('NETWORK_ERROR'));
		const result = await deliveries.processDueNotificationDeliveries(db, { now: later(), sender });
		assert.equal(result.failed, 1);
		const row = await deliveryRow(d.id);
		assert.equal(row.status, 'failed');
		assert.equal(row.lastErrorCode, 'MAX_ATTEMPTS');
		const [exhausted] = events('email.delivery_exhausted');
		assert.equal(exhausted.level, 'error');
		assert.equal(exhausted.deliveryId, d.id);
		assert.equal(exhausted.lastCode, 'NETWORK_ERROR');
		// a worker that died holding the last attempt: closed on the next claim, also logged
		capture();
		const orphan = await queue();
		await db
			.update(s.notificationDeliveries)
			.set({
				status: 'processing',
				attemptCount: deliveries.NOTIFICATION_DELIVERY_MAX_ATTEMPTS,
				leaseToken: randomUUID(),
				nextAttemptAt: new Date(clock)
			})
			.where(eq(s.notificationDeliveries.id, orphan.id));
		await deliveries.processDueNotificationDeliveries(db, { now: later(), sender });
		assert.equal((await deliveryRow(orphan.id)).lastErrorCode, 'MAX_ATTEMPTS');
		assert.equal(events('email.delivery_exhausted')[0].deliveryId, orphan.id);
		void recipientMembership;
	});

	// =========================================================================
	// 24. Webhook worker
	// =========================================================================
	await t.test('24. fallos de webhook: sin secreto, firma, URL ni cuerpo en el log', async () => {
		capture();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		const admin = await createCredentialUser(f, { email: `we-admin-${randomUUID()}@example.test` });
		const [adminMembership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: admin.id })
			.returning();
		await db.insert(s.roleAssignments).values({
			organizationId: org.id,
			membershipId: adminMembership.id,
			roleId: roles.find((r) => r.code === 'organization_admin').id,
			scopeType: 'organization'
		});
		const KEY = secrets.parseWebhookEncryptionKey(KEY_HEX);
		const created = await subs.createWebhookSubscription(
			db,
			{ organizationId: org.id, actorUserId: admin.id },
			{
				name: 'Receptor',
				targetUrl: 'https://hooks.example.com/in?api_key=receiver-key-24',
				eventTypes: ['incident.created']
			},
			{ encryptionKey: KEY }
		);
		assert.ok(created.secret.startsWith('whsec_'));
		await createIncidentRecord(
			db,
			{ organizationId: org.id, creatorUserId: admin.id },
			{ title: 'Cuerpo privado 2424', description: 'Descripción privada', client: 'X' }
		);
		const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
		const calls = [];
		const httpClient = {
			post: async (request) => {
				calls.push(request);
				return { status: 503, retryAfter: null };
			}
		};
		const result = await webhookDeliveries.processDueWebhookDeliveries(db, {
			now: later(),
			encryptionKey: KEY,
			lookup,
			httpClient
		});
		assert.equal(result.retried, 1);
		assert.equal(calls.length, 1);
		const [retry] = events('webhook.delivery_retry');
		assert.equal(retry.subscriptionId, created.webhook.id);
		assert.equal(retry.eventType, 'incident.created');
		assert.equal(retry.statusCode, 503);
		assert.equal(retry.worker, 'webhook');
		// unexpected failure path (rethrown by attempt): still redacted
		capture();
		let thrown = false;
		// Database wrapper whose first top-level SELECT (subscription + secret lookup) fails with a
		// message that echoes the secret and credentials.
		const flaky = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === 'select' && !thrown) {
					return () => {
						thrown = true;
						throw new Error(
							`driver crashed with ${created.secret} for https://u:pw-24@hooks.example.com`
						);
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const failed = await webhookDeliveries.processDueWebhookDeliveries(flaky, {
			now: later(),
			encryptionKey: KEY,
			lookup,
			httpClient
		});
		assert.equal(failed.errors, 1);
		assert.equal(events('webhook.delivery_error').length, 1);
		const text = allText();
		for (const leak of [
			created.secret,
			created.secret.slice(6),
			'receiver-key-24',
			'pw-24',
			calls[0].headers['X-SoporteFlow-Signature'],
			'Cuerpo privado 2424',
			KEY_HEX
		])
			assert.ok(!text.includes(leak), `no registra ${String(leak).slice(0, 12)}`);
		await subs.deactivateWebhookSubscription(db, org.id, created.webhook.id);
	});

	// =========================================================================
	// 27. Timeouts on every external call
	// =========================================================================
	await t.test('27. timeouts explícitos: email, webhook e invitación', async () => {
		assert.equal(deliveries.NOTIFICATION_EMAIL_SEND_TIMEOUT_MS, 30_000);
		assert.equal(webhookDeliveries.WEBHOOK_TIMEOUT_MS, 10_000);
		assert.equal(invitations.INVITATION_EMAIL_SEND_TIMEOUT_MS, 15_000);
		const client = fs.readFileSync('src/lib/server/webhooks/http-client.ts', 'utf8');
		assert.match(client, /setTimeout\([\s\S]*TIMEOUT[\s\S]*req\.destroy\(\)/);
		// hung notification provider -> NETWORK_ERROR retry, bounded
		capture();
		await db.delete(s.notificationDeliveries);
		await queue();
		const hung = { sendNotification: () => new Promise(() => {}) };
		const started = Date.now();
		const r = await deliveries.processDueNotificationDeliveries(db, {
			now: later(),
			sender: hung,
			sendTimeoutMs: 25
		});
		assert.equal(r.retried, 1);
		assert.equal(events('email.delivery_retry')[0].code, 'NETWORK_ERROR');
		// hung invitation provider -> EMAIL_DELIVERY_FAILED, no token in the log
		capture();
		const token = randomBytes(32).toString('base64url');
		await assert.rejects(
			invitations.deliverInvitation(
				{ sendInvitation: () => new Promise(() => {}) },
				{
					invitation: { id: randomUUID() },
					delivery: {
						email: 'invitee@example.com',
						organizationName: 'Org',
						roleName: 'Rol',
						token,
						expiresAt: new Date()
					}
				},
				{ timeoutMs: 25 }
			),
			(error) => error.code === 'EMAIL_DELIVERY_FAILED'
		);
		assert.ok(Date.now() - started < 10_000);
		assert.equal(events('email.invitation_delivery_failed').length, 1);
		assert.ok(!allText().includes(token) && !allText().includes('invitee@example.com'));
	});

	// =========================================================================
	// 28. W-C headers retained (plus correlation)
	// =========================================================================
	await t.test('28. cabeceras de seguridad W-C intactas', async () => {
		const res = await handle(event());
		assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
		assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
		assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
		assert.equal(res.headers.get('cache-control'), 'private, no-store');
		assert.match(res.headers.get('x-request-id'), UUID_V4);
	});

	// =========================================================================
	// 30. Private env never reachable from client code
	// =========================================================================
	await t.test('30. entorno privado y $lib/server nunca importados desde código cliente', () => {
		const files = fs
			.readdirSync('src', { recursive: true })
			.map((p) => String(p).replace(/\\/g, '/'))
			.filter((p) => /\.(ts|js|svelte)$/.test(p));
		const serverOnly = (p) =>
			p.startsWith('lib/server/') ||
			p === 'hooks.server.ts' ||
			/(^|\/)\+(server|page\.server|layout\.server)\.ts$/.test(p) ||
			/^routes\/api\/.*\.ts$/.test(p) ||
			p === 'app.d.ts';
		const offenders = [];
		for (const p of files) {
			if (serverOnly(p)) continue;
			const source = fs.readFileSync(path.join('src', p), 'utf8');
			if (
				/\$env\/(static|dynamic)\/private|\$lib\/server|process\.env|lib\/server\//.test(source) ||
				/BETTER_AUTH_SECRET|WEBHOOK_SECRET_ENCRYPTION_KEY|DATABASE_URL/.test(source)
			)
				offenders.push(p);
		}
		assert.deepEqual(offenders, []);
		// no public env is used for secrets either
		for (const p of files) {
			const source = fs.readFileSync(path.join('src', p), 'utf8');
			assert.ok(!/\$env\/(static|dynamic)\/public/.test(source), p);
		}
		// the only server load returns the principal id, never configuration
		const layout = fs.readFileSync('src/routes/app/+layout.server.ts', 'utf8');
		assert.ok(!/env|secret|process/i.test(layout));
		// no runtime console debugging in server code: everything goes through the logger
		for (const p of files.filter((x) => x.startsWith('lib/server/') || x === 'hooks.server.ts')) {
			const source = fs.readFileSync(path.join('src', p), 'utf8');
			assert.ok(!/console\.(log|debug|info|warn|error)/.test(source), p);
		}
	});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers/auth-fixture.mjs';

/** 5.4X-B — liveness/readiness: minimal public contract, DB checks, no leaks, no rate limiting. */
const REPORT_KEYS = ['checks', 'service', 'status', 'timestamp', 'version'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('SoporteFlow — Etapa 5.4X-B: health y readiness', async (t) => {
	const previousLevel = process.env.LOG_LEVEL;
	const f = await fixture(t);
	process.env.LOG_LEVEL = 'debug';
	t.after(() => {
		if (previousLevel === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = previousLevel;
	});
	const load = (p) => f.server.ssrLoadModule(p);
	const health = await load('/src/lib/server/observability/health.ts');
	const logging = await load('/src/lib/server/logging/logger.ts');
	const hooks = await load('/src/hooks.server.ts');
	const healthz = await load('/src/routes/healthz/+server.ts');
	const readyz = await load('/src/routes/readyz/+server.ts');

	let lines = [];
	logging.setLogSink((line) => lines.push(JSON.parse(line)));
	t.after(() => logging.setLogSink(undefined));
	const capture = () => {
		lines = [];
		logging.resetLogThrottles();
	};

	function event(pathname, { method = 'GET', ip = '198.51.100.7' } = {}) {
		const url = new URL('http://localhost' + pathname);
		return {
			url,
			request: new Request(url, { method }),
			route: { id: pathname },
			params: {},
			locals: {},
			getClientAddress: () => ip
		};
	}
	const through = (pathname, handler, options) => {
		const e = event(pathname, options);
		return hooks.handle({ event: e, resolve: (ev) => handler({ ...ev, request: ev.request }) });
	};
	const devEnv = {
		BETTER_AUTH_ENABLED: 'true',
		BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
		BETTER_AUTH_URL: 'http://localhost',
		DATABASE_URL: 'postgresql://synthetic:synthetic-pw-xb@db.internal/sf'
	};

	await t.test('healthz: 200 mínimo, sin BD, cabeceras seguras y requestId', async () => {
		capture();
		const res = await through('/healthz', healthz.GET);
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.deepEqual(Object.keys(body).sort(), REPORT_KEYS);
		assert.equal(body.status, 'ok');
		assert.equal(body.service, 'soporteflow-core');
		assert.equal(body.version, 'test-build');
		assert.deepEqual(body.checks, { process: 'ok' });
		assert.equal(res.headers.get('cache-control'), 'no-store');
		assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
		assert.match(res.headers.get('content-security-policy'), /default-src/);
		assert.match(res.headers.get('x-request-id'), UUID_V4);
		assert.equal(lines.filter((l) => l.event === 'http.request').length, 0, 'sonda OK sin ruido');
		// liveness never reaches the database or configuration
		const source = fs.readFileSync('src/routes/healthz/+server.ts', 'utf8');
		assert.ok(!/\$lib\/server\/db|getDb|\$env/.test(source));
		const head = await through('/healthz', healthz.HEAD, { method: 'HEAD' });
		assert.equal(head.status, 200);
		assert.equal(await head.text(), '');
	});

	await t.test('readyz: BD y configuración correctas -> 200', async () => {
		const res = await through('/readyz', readyz.GET);
		assert.equal(res.status, 200, await res.clone().text());
		const body = await res.json();
		assert.deepEqual(body.checks, { config: 'ok', database: 'ok' });
		assert.equal(body.status, 'ok');
		assert.deepEqual(Object.keys(body).sort(), REPORT_KEYS);
	});

	await t.test('readyz: una sola consulta barata (SELECT 1)', async () => {
		const queries = [];
		const report = await health.readinessReport({
			env: devEnv,
			development: true,
			version: 'v',
			db: {
				execute: async (query) => {
					queries.push(query);
					return [];
				}
			}
		});
		assert.equal(report.status, 'ok');
		assert.equal(queries.length, 1);
		const text = JSON.stringify(queries[0].queryChunks ?? queries[0]);
		assert.match(text, /select 1/);
	});

	await t.test(
		'readyz: fallo de BD o timeout -> 503 sin fugas; detalle solo en el log',
		async () => {
			capture();
			const failing = await health.readinessReport({
				env: devEnv,
				development: true,
				version: 'v',
				db: {
					execute: () =>
						Promise.reject(new Error('connect ECONNREFUSED postgresql://u:db-pw-503@10.0.0.5/sf'))
				}
			});
			const res = health.healthResponse(failing, 'GET');
			assert.equal(res.status, 503);
			const text = await res.text();
			assert.deepEqual(JSON.parse(text).checks, { config: 'ok', database: 'fail' });
			for (const leak of [
				'ECONNREFUSED',
				'db-pw-503',
				'10.0.0.5',
				'postgresql',
				'synthetic-pw-xb',
				'stack'
			])
				assert.ok(!text.includes(leak), leak);
			const [logged] = lines.filter((l) => l.event === 'health.readiness_failed');
			assert.equal(logged.check, 'database');
			assert.ok(!JSON.stringify(lines).includes('db-pw-503'), 'log redactado');
			const hung = await health.readinessReport({
				env: devEnv,
				development: true,
				version: 'v',
				db: { execute: () => new Promise(() => {}) },
				timeoutMs: 20
			});
			assert.equal(hung.checks.database, 'fail', 'timeout acotado');
			const none = await health.readinessReport({
				env: devEnv,
				development: true,
				version: 'v',
				db: null
			});
			assert.equal(none.checks.database, 'unconfigured');
			assert.equal(health.healthResponse(none, 'GET').status, 503);
		}
	);

	await t.test('readyz: configuración inválida -> 503 sin nombrar valores', async () => {
		const report = await health.readinessReport({
			env: {
				...devEnv,
				NODE_ENV: 'production',
				BETTER_AUTH_SECRET: 'changeme',
				BETTER_AUTH_URL: 'http://x'
			},
			development: false,
			version: 'v',
			db: { execute: async () => [] }
		});
		assert.equal(report.checks.config, 'fail');
		const text = JSON.stringify(report);
		assert.ok(!text.includes('changeme') && !text.includes('BETTER_AUTH'));
	});

	await t.test('sondas no limitadas por W-D y fallos sí registrados', async () => {
		capture();
		const statuses = new Set();
		for (let i = 0; i < 650; i++)
			statuses.add((await through('/healthz', healthz.GET, { ip: '203.0.113.5' })).status);
		assert.deepEqual([...statuses], [200], 'sin 429 aunque supere el umbral flood de /api');
		const failing = await through('/readyz', () =>
			health.healthResponse(
				{
					status: 'unavailable',
					service: 's',
					version: 'v',
					checks: { database: 'fail' },
					timestamp: ''
				},
				'GET'
			)
		);
		assert.equal(failing.status, 503);
		assert.equal(lines.filter((l) => l.event === 'http.request' && l.status === 503).length, 1);
	});
});

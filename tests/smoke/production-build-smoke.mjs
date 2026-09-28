/**
 * 5.4W-F production-build smoke (manual, not part of `tests/*.test.mjs`).
 *
 *   npm run build && node tests/smoke/production-build-smoke.mjs
 *
 * Runs the COMPILED server (`vite preview`: dev === false, production code paths) with SYNTHETIC
 * configuration only, never real secrets, and checks:
 *   - startup env gate: missing secret / weak secret / invalid auth URL -> server refuses to serve;
 *     valid synthetic configuration -> serves;
 *   - W-C headers on the compiled output (CSP with nonce on documents, nosniff, Referrer-Policy,
 *     Permissions-Policy, Cache-Control), X-Request-ID (W-E), cross-origin mutation rejected,
 *     generic error bodies;
 *   - no secret value ever appears in responses or in the server output.
 *
 * DATABASE_URL points to an unreachable synthetic host: only DB-free paths are exercised.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const SECRET = randomBytes(32).toString('base64url');
const WEBHOOK_KEY = randomBytes(32).toString('hex');
const DB_PASSWORD = 'smoke-db-' + randomBytes(6).toString('hex');
const valid = {
	NODE_ENV: 'production',
	LOG_LEVEL: 'info',
	BETTER_AUTH_ENABLED: 'true',
	BETTER_AUTH_SECRET: SECRET,
	BETTER_AUTH_URL: 'https://support.smoke.invalid',
	DATABASE_URL: `postgresql://smoke:${DB_PASSWORD}@127.0.0.1:9/smoke`,
	WEBHOOK_SECRET_ENCRYPTION_KEY: WEBHOOK_KEY
};
const SECRETS = [SECRET, WEBHOOK_KEY, DB_PASSWORD];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let port = 4300 + Math.floor(Math.random() * 500);

async function withServer(env, run) {
	const p = ++port;
	const child = spawn(
		process.execPath,
		['node_modules/vite/bin/vite.js', 'preview', '--port', String(p), '--strictPort'],
		{ env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	let output = '';
	child.stdout.on('data', (d) => (output += d));
	child.stderr.on('data', (d) => (output += d));
	const base = `http://localhost:${p}`;
	try {
		for (let i = 0; i < 100 && !/Local/.test(output); i++)
			await new Promise((r) => setTimeout(r, 100));
		return await run(base, () => output);
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise((r) => child.once('exit', r));
			child.kill();
			await exited;
		}
		for (const secret of SECRETS) assert.ok(!output.includes(secret), 'secret in server output');
	}
}

async function request(base, path, init = {}) {
	try {
		const res = await fetch(base + path, { redirect: 'manual', ...init });
		return { status: res.status, headers: res.headers, text: await res.text() };
	} catch (error) {
		return { status: 0, error };
	}
}

const results = [];
const check = async (name, fn) => {
	try {
		await fn();
		results.push(['PASS', name]);
	} catch (error) {
		results.push(['FAIL', name + ': ' + error.message]);
	}
};

// ---------------------------------------------------------------- startup env gate
for (const [name, override, variable] of [
	['missing secret', { BETTER_AUTH_SECRET: '' }, 'BETTER_AUTH_SECRET'],
	['weak secret', { BETTER_AUTH_SECRET: 'changeme'.repeat(5) }, 'BETTER_AUTH_SECRET'],
	[
		'invalid auth URL (http)',
		{ BETTER_AUTH_URL: 'http://support.smoke.invalid' },
		'BETTER_AUTH_URL'
	],
	[
		'lab secret in production',
		{ BETTER_AUTH_SECRET: 'synthetic-phase-b-only-secret-123456789' },
		'BETTER_AUTH_SECRET'
	]
]) {
	await check(`env gate rejects: ${name}`, () =>
		withServer({ ...valid, ...override }, async (base, output) => {
			const res = await request(base, '/api/me');
			assert.notEqual(res.status, 200);
			assert.notEqual(res.status, 401, 'must not serve normally with invalid config');
			assert.ok(output().includes(variable), 'variable named in the failure');
			assert.ok(
				!output().includes(override[variable] || 'never-present-value'),
				'value never printed'
			);
		})
	);
}

// ---------------------------------------------------------------- valid configuration
await check('valid synthetic configuration serves (headers, requestId, generic errors)', () =>
	withServer(valid, async (base, output) => {
		const me = await request(base, '/api/me');
		assert.equal(me.status, 401, `GET /api/me -> ${me.status}`);
		assert.equal(me.headers.get('x-content-type-options'), 'nosniff');
		assert.equal(me.headers.get('referrer-policy'), 'no-referrer');
		assert.match(me.headers.get('permissions-policy') ?? '', /camera=\(\)/);
		assert.equal(me.headers.get('cache-control'), 'private, no-store');
		assert.match(me.headers.get('content-security-policy') ?? '', /default-src 'none'/);
		assert.match(me.headers.get('x-request-id') ?? '', UUID_V4);
		// `vite preview` (tooling) adds `Access-Control-Allow-Origin: *` via SvelteKit's Vite plugin;
		// the adapter output does not. `*` can never authorize credentialed (cookie) reads, and the app
		// itself never grants credentials:
		assert.equal(me.headers.get('access-control-allow-credentials'), null);
		// cross-origin mutation rejected before any handler (W-C), still correlated
		const csrf = await request(base, '/api/incidents', {
			method: 'POST',
			headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' },
			body: '{}'
		});
		assert.equal(csrf.status, 403);
		assert.match(csrf.headers.get('x-request-id') ?? '', UUID_V4);
		// document CSP with a per-response nonce
		const page = await request(base, '/login');
		assert.equal(page.status, 200, `GET /login -> ${page.status}`);
		const csp = page.headers.get('content-security-policy') ?? '';
		assert.match(csp, /script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/);
		assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), 'no unsafe-inline scripts');
		const again = await request(base, '/login');
		const nonce = (h) => /'nonce-([^']+)'/.exec(h.get('content-security-policy') ?? '')?.[1];
		assert.notEqual(nonce(page.headers), nonce(again.headers), 'nonce per response');
		assert.equal(page.headers.get('strict-transport-security'), null, 'no HSTS over plain HTTP');
		for (const res of [me, csrf, page])
			for (const secret of SECRETS) assert.ok(!res.text.includes(secret));
		// structured log lines present and parseable
		const lines = output()
			.split('\n')
			.filter((l) => l.startsWith('{'));
		assert.ok(
			lines.some((l) => JSON.parse(l).event === 'config.validated'),
			'config.validated'
		);
		assert.ok(
			lines.some((l) => JSON.parse(l).event === 'http.request'),
			'access log'
		);
	})
);

for (const [status, name] of results) console.log(`${status}  ${name}`);
process.exitCode = results.some(([s]) => s === 'FAIL') ? 1 : 0;

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { eq } from 'drizzle-orm';
import { render } from 'svelte/server';
import { compile } from 'svelte/compiler';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
const module = { exports: {} };
vm.runInNewContext(
	ts.transpileModule(read('src/lib/server/security/web.ts'), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
	}).outputText,
	{ module, exports: module.exports, Request, Response, Headers, URL, Uint8Array, TextDecoder, Set }
);
const web = module.exports;
const origin = 'https://support.example.test';
const policy = { origin, development: false };
function event(options = {}) {
	const { method = 'POST', pathname = '/api/incidents', body = '{}', headers = {} } = options;
	const h = new Headers({ origin, 'content-type': 'application/json', ...headers });
	for (const [k, v] of Object.entries(headers)) if (v === null) h.delete(k);
	const request = new Request(origin + pathname, {
		method,
		headers: h,
		...(!['GET', 'HEAD'].includes(method) && body !== null
			? { body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) }
			: {})
	});
	return { request, url: new URL(request.url), params: {}, locals: {} };
}
async function run(e, resolve = () => Response.json({ ok: true }), p = policy) {
	return web.handleWebRequest(e, resolve, p);
}

test('W-C: origin policy is exact and fails closed', async (t) => {
	for (const [value, allowed] of [
		[origin, true],
		[null, false],
		['null', false],
		['https://evil.test', false],
		['https://support.example.test.evil.test', false],
		['http://support.example.test', false],
		[origin + '/', false],
		[origin + ':444', false]
	]) {
		await t.test(String(value), async () => {
			let called = false;
			const r = await run(event({ headers: { origin: value } }), () => {
				called = true;
				return new Response();
			});
			assert.equal(r.status, allowed ? 200 : 403);
			assert.equal(called, allowed);
		});
	}
	for (const site of ['cross-site', 'same-site'])
		assert.equal((await run(event({ headers: { 'sec-fetch-site': site } }))).status, 403);
	for (const p of [
		{ development: false },
		{ origin: 'http://support.example.test', development: false },
		{ origin: origin + '/path', development: false }
	])
		assert.equal((await run(event(), undefined, p)).status, 403);
	assert.equal(
		web.configuredOrigin({ development: true }, new URL('http://localhost:5173')),
		'http://localhost:5173'
	);
	assert.equal(web.configuredOrigin({ development: true }, new URL('http://evil.test')), null);
	const spoof = event({
		headers: {
			origin: 'https://evil.test',
			'x-forwarded-host': 'evil.test',
			forwarded: 'host=evil.test;proto=https'
		}
	});
	spoof.url = new URL('https://evil.test/api/incidents');
	assert.equal((await run(spoof)).status, 403);
});

test('W-C: all inventoried mutating endpoints pass through central CSRF gate', async (t) => {
	const files = fs
		.readdirSync(new URL('src/routes/api', root), { recursive: true })
		.filter((x) => x.endsWith('+server.ts'));
	for (const file of files) {
		const source = read('src/routes/api/' + file.replaceAll('\\', '/'));
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'].filter((m) =>
			source.includes('export const ' + m)
		))
			await t.test(method + ' ' + file, async () => {
				const pathname =
					'/api/' +
					file
						.replaceAll('\\', '/')
						.replace('/+server.ts', '')
						.replaceAll('[id]', '00000000-0000-4000-8000-000000000001')
						.replace('[...all]', 'sign-in/email');
				let called = false;
				const r = await run(
					event({ method, pathname, headers: { origin: 'https://evil.test' } }),
					() => {
						called = true;
						throw Error('must not reach DB');
					}
				);
				assert.equal(r.status, 403);
				assert.equal(called, false);
				assert.equal(r.headers.get('cache-control'), 'private, no-store');
			});
	}
	assert.match(read('src/hooks.server.ts'), /handleWebRequest\(event, resolve/);
});

test('W-C: content types, malformed JSON, shape, encoding and byte limits', async (t) => {
	for (const type of [
		null,
		'text/plain',
		'multipart/form-data',
		'application/jsonp',
		'application/json; charset=latin1'
	])
		await t.test(String(type), async () =>
			assert.equal((await run(event({ headers: { 'content-type': type } }))).status, 415)
		);
	for (const body of ['{', 'null', '[]', '1', '"text"'])
		assert.equal((await run(event({ body }))).status, 400);
	assert.equal(
		(await run(event({ headers: { 'content-type': 'application/json; charset=utf-8' } }))).status,
		200
	);
	assert.equal(
		(await run(event({ body: JSON.stringify({ text: 'x'.repeat(web.MAX_JSON_BYTES) }) }))).status,
		413
	);
	assert.equal(
		(await run(event({ headers: { 'content-length': String(web.MAX_JSON_BYTES + 1) } }))).status,
		413
	);
	const stream = new ReadableStream({
		start(c) {
			c.enqueue(new Uint8Array(web.MAX_JSON_BYTES));
			c.enqueue(new Uint8Array(1));
			c.close();
		}
	});
	assert.equal((await run(event({ body: stream }))).status, 413);
	assert.equal((await run(event({ headers: { 'content-encoding': 'gzip' } }))).status, 415);
	const bytes = ' { "token" : "opaque", "text": "á" } ';
	let received;
	assert.equal(
		(
			await run(event({ body: bytes }), async (e) => {
				received = await e.request.text();
				return new Response();
			})
		).status,
		200
	);
	assert.equal(received, bytes);
	assert.equal((await run(event({ body: null, headers: { 'content-type': null } }))).status, 200);
});

test('W-C: security headers, CORS, private caching and sanitized failures', async () => {
	const r = await run(
		event(),
		() =>
			new Response('ok', {
				headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Credentials': 'true' }
			})
	);
	assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
	assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
	assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
	assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000');
	assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
	assert.equal(r.headers.get('access-control-allow-origin'), null);
	assert.equal(r.headers.get('access-control-allow-credentials'), null);
	const landing = await run(event({ method: 'GET', pathname: '/' }));
	assert.equal(landing.headers.get('cache-control'), null);
	for (const pathname of ['/api/me', '/app', '/app/__data.json', '/login'])
		assert.equal(
			(await run(event({ method: 'GET', pathname }))).headers.get('cache-control'),
			'private, no-store'
		);
	const dev = await run(event(), undefined, { origin, development: true });
	assert.equal(dev.headers.get('strict-transport-security'), null);
	for (const resolve of [
		() => {
			throw Error('secret SQL C:/server');
		},
		() =>
			new Response('secret SQL C:/server', {
				status: 500,
				headers: { 'set-cookie': 'secret=token' }
			})
	]) {
		const e = await run(event(), resolve);
		assert.equal(e.status, 500);
		assert.doesNotMatch(await e.text(), /secret|SQL|C:/);
		assert.equal(e.headers.get('set-cookie'), null);
	}
	const cookie =
		'__Secure-soporteflow-auth.session_token=opaque; HttpOnly; Secure; SameSite=Lax; Path=/';
	const cookies = await run(
		event(),
		() => new Response(null, { headers: { 'set-cookie': cookie } })
	);
	assert.equal(cookies.headers.get('set-cookie'), cookie);
});

test('W-C: internal callbacks, methods and query ambiguity', async () => {
	for (const value of [
		'javascript:alert(1)',
		'data:text/html,x',
		'//evil.test',
		'/\\evil.test',
		'/%2f%2fevil.test',
		'/%252f%252fevil.test',
		'https://evil.test',
		'/%0aevil',
		'/a%5cb'
	])
		assert.equal(web.isInternalLocation(value), false, value);
	for (const value of ['/app', '/app?tab=mine', '/login'])
		assert.equal(web.isInternalLocation(value), true, value);
	assert.equal(
		(
			await run(
				event({
					pathname: '/api/auth/sign-in/email',
					body: JSON.stringify({ callbackURL: '//evil.test' })
				})
			)
		).status,
		400
	);
	assert.equal((await run(event({ method: 'PROPFIND' }))).status, 405);
	assert.equal((await run(event({ headers: { 'x-http-method-override': 'GET' } }))).status, 400);
	assert.equal(
		(
			await run(
				event({ method: 'GET', pathname: '/api/incidents?organizationId=a&organizationId=b' })
			)
		).status,
		400
	);
	for (const method of ['GET', 'HEAD', 'OPTIONS'])
		assert.equal((await run(event({ method, body: null }))).status, 200);
});

test('W-C: CSP uses framework nonce; application has no raw HTML sinks or dynamic code', () => {
	const config = read('vite.config.ts');
	assert.match(config, /mode: 'nonce'/);
	assert.match(config, /'script-src': \['self'\]/);
	assert.doesNotMatch(config, /unsafe-eval/);
	assert.match(read('src/app.html'), /nonce="%sveltekit.nonce%"/);
	const files = fs
		.readdirSync(new URL('src', root), { recursive: true })
		.filter((p) => /\.(svelte|ts)$/.test(p));
	for (const f of files) {
		const s = read('src/' + f.replaceAll('\\', '/'));
		assert.doesNotMatch(
			s,
			/\{@html|innerHTML\s*=|new Function\(|\beval\(|from ['"]node:(child_process|vm)['"]/,
			f
		);
	}
	const serverFiles = files.filter((p) => p.replaceAll('\\', '/').startsWith('lib/server/'));
	for (const f of serverFiles)
		assert.doesNotMatch(read('src/' + f.replaceAll('\\', '/')), /sql\.raw\(|\.unsafe\(/, f);
});

test('W-C: actual Svelte text interpolation renders attack payloads as data', async () => {
	const { js } = compile('<script>let { text } = $props();</script><p>{text}</p>', {
		generate: 'server'
	});
	// Compiler output is trusted build code, not customer input. Resolve only its fixed Svelte import.
	const generated = js.code.replace(
		/from ['"]svelte\/internal\/server['"]/,
		'from ' +
			JSON.stringify(
				new URL('../node_modules/svelte/src/internal/server/index.js', import.meta.url).href
			)
	);
	const component = await import(
		'data:text/javascript;base64,' + Buffer.from(generated).toString('base64')
	);
	for (const payload of [
		'<script>alert(1)</script>',
		'<img src=x onerror=alert(1)>',
		'<svg onload=alert(1)>',
		'javascript:alert(1)',
		'&#x3c;script&#x3e;'
	]) {
		const output = render(component.default, { props: { text: payload } }).body;
		assert.doesNotMatch(output, /<script>|<img|<svg/);
		if (payload.includes('<')) assert.match(output, /&lt;/);
	}
});

test('W-C: integrated hook, real API validation, inactive auth and read-only expired sessions', async (t) => {
	const f = await fixture(t);
	const load = (p) => f.server.ssrLoadModule('/src/' + p);
	const { handle } = await load('hooks.server.ts');
	const invoke = async (route, method, pathname, body, headers = {}) => {
		const h = new Headers({ origin: 'http://localhost', ...headers });
		if (body !== undefined) h.set('content-type', 'application/json');
		const req = new Request('http://localhost' + pathname, {
			method,
			headers: h,
			...(body !== undefined ? { body: JSON.stringify(body) } : {})
		});
		const e = {
			request: req,
			url: new URL(req.url),
			params: {},
			locals: {},
			getClientAddress: () => '127.0.0.1'
		};
		const handler = (await load(route))[method];
		return handle({ event: e, resolve: handler });
	};
	const invalid = await invoke(
		'routes/api/incidents/+server.ts',
		'GET',
		'/api/incidents?organizationId=invalid'
	);
	assert.equal(invalid.status, 400);
	for (const limit of ['101', '-1', 'NaN', 'Infinity', '1e2']) {
		const r = await invoke(
			'routes/api/notifications/+server.ts',
			'GET',
			'/api/notifications?organizationId=00000000-0000-4000-8000-000000000001&limit=' + limit
		);
		assert.equal(r.status, 400);
	}
	const invalidEnum = await invoke(
		'routes/api/notifications/+server.ts',
		'GET',
		'/api/notifications?organizationId=00000000-0000-4000-8000-000000000001&status=unexpected'
	);
	assert.equal(invalidEnum.status, 400);
	const user = await createCredentialUser(f, { active: false });
	const session = await createSession(f, user.id);
	const me = await invoke('routes/api/me/+server.ts', 'GET', '/api/me', undefined, {
		cookie: session.cookieHeader
	});
	assert.equal(me.status, 401);
	const expired = await createSession(f, user.id, { expiresAt: new Date(0) });
	const expiredResponse = await invoke('routes/api/me/+server.ts', 'GET', '/api/me', undefined, {
		cookie: expired.cookieHeader
	});
	assert.equal(expiredResponse.status, 401);
	assert.equal(
		(
			await f.db
				.select()
				.from(f.schema.authSessions)
				.where(eq(f.schema.authSessions.id, expired.session.id))
		).length,
		1,
		'GET must not delete expired session'
	);
	const { listIncidents } = await load('lib/server/services/incidents.ts');
	for (const filters of [
		{ status: '' },
		{ priority: '' },
		{ status: "open' OR 1=1 --" },
		{ priority: 'unknown' }
	])
		await assert.rejects(
			() =>
				listIncidents(f.db, { organizationId: '00000000-0000-4000-8000-000000000001' }, filters),
			(e) => e.code === 'INVALID_INPUT'
		);
	const { normalizeWebhookTargetUrl } = await load('lib/server/webhooks/url-safety.ts');
	for (const url of [
		'javascript:alert(1)',
		'http://example.com',
		'https://127.0.0.1',
		'https://[::1]',
		'https://169.254.169.254',
		'https://example.com/#x'
	])
		assert.throws(() => normalizeWebhookTargetUrl(url));
	assert.equal(normalizeWebhookTargetUrl('https://example.com/hook'), 'https://example.com/hook');
});

test('W-C: encoded API aliases, empty streams and unsafe reads', async () => {
	const e = event({ pathname: '/%61pi/incidents', headers: { origin: 'https://evil.test' } });
	e.route = { id: '/api/incidents' };
	assert.equal((await run(e)).status, 403);
	assert.equal(
		(await run(event({ pathname: '/%61pi/incidents', headers: { origin: 'https://evil.test' } })))
			.status,
		403
	);
	assert.equal((await run(event({ body: '' }))).status, 200);
	const callback = event({
		pathname: '/%61pi/auth/sign-in/email',
		body: JSON.stringify({ callbackURL: '//evil.test' })
	});
	callback.route = { id: '/api/auth/[...all]' };
	assert.equal((await run(callback)).status, 400);
});

test('W-C: actual Better Auth production cookie attributes', async () => {
	const { getCookies } = await import('better-auth/cookies');
	const options = {
		baseURL: origin,
		advanced: {
			useSecureCookies: true,
			cookiePrefix: 'soporteflow-auth',
			defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' }
		}
	};
	const { sessionToken } = getCookies(options);
	assert.equal(sessionToken.name, '__Secure-soporteflow-auth.session_token');
	assert.equal(sessionToken.attributes.httpOnly, true);
	assert.equal(sessionToken.attributes.secure, true);
	assert.equal(sessionToken.attributes.sameSite, 'lax');
	assert.equal(sessionToken.attributes.path, '/');
	assert.equal(sessionToken.attributes.domain, undefined);
	assert.equal(sessionToken.attributes.maxAge, 604800);
	const instance = read('src/lib/server/auth/instance.ts');
	assert.match(instance, /useSecureCookies: config.secureCookies/);
	assert.match(instance, /cookiePrefix: 'soporteflow-auth'/);
	assert.match(instance, /cookieCache: \{ enabled: false \}/);
	assert.match(instance, /deferSessionRefresh: true/);
});

test('W-C: SQL remains bound, and legacy query endpoints reject unknown fields', async (t) => {
	const f = await fixture(t);
	const load = (p) => f.server.ssrLoadModule('/src/' + p);
	const { listIncidents } = await load('lib/server/services/incidents.ts');
	let compiled;
	function wrap(builder) {
		return new Proxy(builder, {
			get(obj, key) {
				if (key === 'then')
					return (resolve, reject) => {
						try {
							compiled = obj.toSQL();
							return Promise.resolve([]).then(resolve, reject);
						} catch (e) {
							return Promise.reject(e).then(resolve, reject);
						}
					};
				const value = Reflect.get(obj, key, obj);
				return typeof value === 'function'
					? (...args) => {
							const next = value.apply(obj, args);
							return next && typeof next === 'object' ? wrap(next) : next;
						}
					: value;
			}
		});
	}
	const recording = { select: (...args) => wrap(f.db.select(...args)) };
	const org = '00000000-0000-4000-8000-000000000001';
	await listIncidents(recording, { organizationId: org }, { status: 'open', priority: 'high' });
	assert.ok(compiled.params.includes(org));
	assert.ok(compiled.params.includes('open'));
	assert.ok(compiled.params.includes('high'));
	assert.ok(!compiled.sql.includes(org));
	assert.match(compiled.sql, /\$\d+/);
	for (const route of ['incidents', 'teams', 'me']) {
		const { GET } = await load('routes/api/' + route + '/+server.ts');
		const url = new URL(
			'http://localhost/api/' + route + '?organizationId=' + org + '&limit=Infinity'
		);
		const r = await GET({ request: new Request(url), url });
		assert.equal(r.status, 400);
	}
});

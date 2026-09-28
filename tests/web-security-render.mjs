/** Run after npm run build. Exercises compiled SvelteKit in-process; no socket or database. */
import assert from 'node:assert/strict';
import { Server } from '../.svelte-kit/output/server/index.js';
import { manifest } from '../.svelte-kit/output/server/manifest.js';

const origin = 'https://support.example.test';
const server = new Server(manifest);
await server.init({ env: { BETTER_AUTH_ENABLED: 'false', BETTER_AUTH_URL: origin } });
const respond = (path, init = {}) =>
	server.respond(new Request(origin + path, init), { getClientAddress: () => '127.0.0.1' });
let checks = 0;
for (const path of ['/', '/login']) {
	const response = await respond(path);
	assert.equal(response.status, 200);
	const csp = response.headers.get('content-security-policy');
	assert.ok(csp);
	assert.doesNotMatch(csp, /unsafe-eval/);
	const script = csp.split(';').find((s) => s.trim().startsWith('script-src '));
	assert.ok(script);
	assert.doesNotMatch(script, /unsafe-inline/);
	const nonces = [...script.matchAll(/'nonce-([^']+)'/g)].map((m) => m[1]);
	assert.ok(nonces.length);
	const html = await response.text();
	let inlineScripts = 0;
	for (const match of html.matchAll(/<script\b([^>]*)>/g)) {
		if (/\bsrc=/.test(match[1])) continue;
		inlineScripts++;
		const nonce = /\bnonce="([^"]+)"/.exec(match[1])?.[1];
		assert.ok(nonces.includes(nonce), 'every inline script needs allowed nonce');
	}
	assert.ok(inlineScripts >= 2, 'theme and hydration scripts were checked');
	assert.match(csp, /frame-ancestors 'none'/);
	assert.match(csp, /object-src 'none'/);
	assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
	if (path === '/login') assert.equal(response.headers.get('cache-control'), 'private, no-store');
	checks++;
}
const first = await respond('/login'),
	second = await respond('/login');
assert.notEqual(
	first.headers.get('content-security-policy'),
	second.headers.get('content-security-policy')
);
checks++;
const redirect = await respond('/app?returnTo=https://evil.test');
assert.equal(redirect.status, 303);
assert.equal(redirect.headers.get('location'), '/login');
assert.equal(redirect.headers.get('cache-control'), 'private, no-store');
checks++;
for (const path of [
	'/api/incidents',
	'/%61pi/incidents',
	'/api/invitations/accept',
	'/api/webhooks'
]) {
	const r = await respond(path, {
		method: 'POST',
		headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
		body: '{}'
	});
	assert.equal(r.status, 403);
	assert.equal(r.headers.get('cache-control'), 'private, no-store');
	checks++;
}
const disabled = await respond('/api/auth/sign-in/email', {
	method: 'POST',
	headers: { origin, 'content-type': 'application/json' },
	body: '{}'
});
assert.equal(disabled.status, 503);
assert.equal((await disabled.json()).error.code, 'UNAVAILABLE');
checks++;
const me = await respond('/api/me');
assert.equal(me.status, 401);
assert.equal(me.headers.get('cache-control'), 'private, no-store');
checks++;
for (const method of ['PUT', 'PATCH', 'DELETE']) {
	const r = await respond('/api/auth/sign-in/email', { method, headers: { origin }, body: null });
	assert.equal(r.status, 405);
	checks++;
}
const preflight = await respond('/api/incidents', {
	method: 'OPTIONS',
	headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' }
});
assert.equal(preflight.headers.get('access-control-allow-origin'), null);
checks++;
console.log(
	'W-C compiled SvelteKit smoke: ' + checks + ' checks PASS; auth disabled; no network/database.'
);

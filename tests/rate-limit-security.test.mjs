import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

test('5.4W-D: abuse controls, trusted scopes, memory and HTTP contracts', async (t) => {
	const f = await fixture(t);
	const { server, db, schema: s } = f;
	const security = await server.ssrLoadModule('/src/lib/server/security/api-abuse.ts');
	const { FixedWindowRateLimiter } = await server.ssrLoadModule(
		'/src/lib/server/security/rate-limit.ts'
	);
	const web = await server.ssrLoadModule('/src/lib/server/security/web.ts');
	const bounded = await server.ssrLoadModule('/src/lib/server/security/bounded-read.ts');
	const invitation = await server.ssrLoadModule(
		'/src/lib/server/security/invitation-rate-limits.ts'
	);
	const accept = await server.ssrLoadModule('/src/routes/api/invitations/accept/+server.ts');
	const origin = 'http://localhost';
	const A = randomUUID(),
		B = randomUUID();
	let now = 1000;
	const event = (pathname = '/api/incidents', options = {}) => {
		const method = options.method ?? 'POST';
		const headers = new Headers({ origin, 'content-type': 'application/json', ...options.headers });
		if (options.noOrigin) headers.delete('origin');
		const url = new URL(origin + pathname);
		return {
			url,
			request: new Request(url, {
				method,
				headers,
				...(method === 'GET' ? {} : { body: JSON.stringify(options.body ?? {}) })
			}),
			params: {},
			locals: {},
			getClientAddress: () => options.ip ?? '127.0.0.1'
		};
	};
	const guard = (extra = {}) =>
		security.createApiAbuseGuard({
			store: security.memoryAbuseStore(() => now),
			principal: async (h) => (h.get('test-user') ? { userId: h.get('test-user') } : null),
			membership: async (h, org) =>
				org === B && h.get('foreign')
					? null
					: { userId: h.get('test-user'), organizationId: org, membershipId: randomUUID() },
			...extra
		});
	const run = (g, e, resolve = () => Response.json({ ok: true })) =>
		web.handleWebRequest(e, resolve, { development: true, origin, beforeResolve: g });
	const login = (overrides = {}) =>
		event('/api/auth/sign-in/email', {
			body: { email: 'Person@example.test', password: 'synthetic' },
			...overrides
		});
	const business = (org = A, user = 'user-a', path = '/api/incidents') =>
		event(path + '?organizationId=' + org, {
			headers: { 'test-user': user },
			body: { organizationId: org }
		});
	await t.test('fixed windows: under/over, exact Retry-After, expiry and backwards clock', () => {
		let time = 0;
		const l = new FixedWindowRateLimiter({ limit: 2, windowMs: 10000, now: () => time });
		assert.equal(l.consume('x').allowed, true);
		assert.equal(l.consume('x').allowed, true);
		time = 1001;
		assert.deepEqual(l.consume('x'), { allowed: false, retryAfterSeconds: 9 });
		time = 0;
		assert.equal(l.consume('x').allowed, false);
		time = 10000;
		assert.equal(l.consume('x').allowed, true);
	});
	await t.test('TTL cleanup, capacity, key churn never evicts active protection', () => {
		let time = 0;
		const l = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 2, now: () => time });
		l.consume('protected');
		l.consume('other');
		for (let i = 0; i < 1000; i++) assert.equal(l.consume('churn' + i).allowed, false);
		assert.equal(l.size, 2);
		assert.equal(l.consume('protected').allowed, false);
		time = 1000;
		l.consume('new');
		assert.equal(l.size, 1);
		assert.throws(() => new FixedWindowRateLimiter({ limit: 1, windowMs: 1, maxKeys: 0 }));
	});
	await t.test(
		'login brute force: five allowed, sixth 429, no leaks, expiry recovers',
		async () => {
			const g = guard();
			for (let i = 0; i < 5; i++) assert.equal((await run(g, login())).status, 200);
			const r = await run(g, login());
			assert.equal(r.status, 429);
			assert.equal(r.headers.get('retry-after'), '10');
			assert.deepEqual(await r.json(), {
				error: { code: 'RATE_LIMITED', message: 'Too many requests.' }
			});
			assert.match(r.headers.get('cache-control'), /no-store/);
			now += 10000;
			assert.equal((await run(g, login())).status, 200);
		}
	);
	await t.test(
		'different IP bucket; XFF, X-Real-IP, Forwarded and custom peer headers cannot bypass',
		async () => {
			const g = guard();
			for (let i = 0; i < 5; i++) await run(g, login());
			for (const headers of [
				{ 'x-forwarded-for': '8.8.8.8' },
				{ 'x-real-ip': '8.8.4.4' },
				{ forwarded: 'for=8.8.8.8' },
				{ 'x-soporteflow-peer': '8.8.8.8' }
			])
				assert.equal((await run(g, login({ headers }))).status, 429);
			assert.equal((await run(g, login({ ip: '8.8.8.8' }))).status, 200);
		}
	);
	await t.test(
		'normalized email throttles across IPs, independent of whether identity exists',
		async () => {
			const g = guard();
			for (let i = 0; i < 10; i++)
				assert.equal(
					(
						await run(
							g,
							login({
								ip: '10.0.0.' + (i + 1),
								body: { email: i % 2 ? ' person@EXAMPLE.test ' : 'PERSON@example.test' }
							})
						)
					).status,
					200
				);
			assert.equal((await run(g, login({ ip: '10.0.1.1' }))).status, 429);
			assert.equal(
				(await run(g, login({ ip: '10.0.1.2', body: { email: 'different@example.test' } }))).status,
				200
			);
		}
	);
	await t.test('missing adapter IP cannot bypass; mapped IPv4 is canonical', () => {
		assert.equal(
			security.trustedClientAddress({
				getClientAddress() {
					throw Error();
				}
			}),
			'unknown'
		);
		assert.equal(
			security.trustedClientAddress({ getClientAddress: () => '::ffff:127.0.0.1' }),
			'127.0.0.1'
		);
		assert.equal(security.trustedClientAddress({ getClientAddress: () => 'spoof' }), 'unknown');
		assert.equal(security.abuseKey('email', 'private@example.test').includes('private'), false);
	});
	await t.test('CSRF and malformed queries reject before consuming budgets', async () => {
		const g = guard({
			store: {
				consume() {
					assert.fail('invalid request spent quota');
				}
			}
		});
		assert.equal((await run(g, login({ noOrigin: true }))).status, 403);
		assert.equal(
			(await run(g, event('/api/incidents?limit=1&limit=2', { method: 'GET' }))).status,
			400
		);
	});
	await t.test('sign-out and forbidden recovery are not classified as login', async () => {
		const seen = [];
		const g = guard({
			store: {
				consume(p) {
					seen.push(p);
					return { allowed: true, retryAfterSeconds: 0 };
				}
			}
		});
		for (const p of [
			'sign-out',
			'get-session',
			'sign-up/email',
			'request-password-reset',
			'reset-password'
		])
			await run(g, event('/api/auth/' + p));
		assert.equal(
			seen.some((p) => p.startsWith('login')),
			false
		);
	});
	await t.test('user mutation budget is independent, authenticated tenant is checked', async () => {
		const g = guard();
		for (let i = 0; i < 20; i++) assert.equal((await run(g, business())).status, 200);
		assert.equal((await run(g, business())).status, 429);
		assert.equal((await run(g, business(A, 'other-user'))).status, 200);
	});
	await t.test('tenant cap shared across users, another tenant independent', async () => {
		const g = guard();
		for (let i = 0; i < 100; i++)
			assert.equal((await run(g, business(A, 'user-' + Math.floor(i / 20)))).status, 200);
		assert.equal((await run(g, business(A, 'new-user'))).status, 429);
		assert.equal((await run(g, business(B, 'new-user'))).status, 200);
	});
	await t.test(
		'foreign org cannot spend tenant budgets; route keeps 403/404 semantics',
		async () => {
			const seen = [];
			const g = guard({
				store: {
					consume(p) {
						seen.push(p);
						return { allowed: true, retryAfterSeconds: 0 };
					}
				}
			});
			const e = business(B);
			e.request.headers.set('foreign', 'true');
			assert.equal((await run(g, e, () => new Response(null, { status: 403 }))).status, 403);
			assert.equal(seen.includes('incidentOrg'), false);
			assert.equal(
				(await run(guard(), business(), () => new Response(null, { status: 404 }))).status,
				404
			);
		}
	);
	await t.test(
		'invitation resend budget stops before side effects, recovers by window',
		async () => {
			const g = guard();
			let sent = 0;
			const e = () => business(A, 'admin', '/api/invitations/' + randomUUID() + '/resend');
			for (let i = 0; i < 10; i++)
				assert.equal(
					(
						await run(g, e(), () => {
							sent++;
							return new Response();
						})
					).status,
					200
				);
			assert.equal(
				(
					await run(g, e(), () => {
						sent++;
						return new Response();
					})
				).status,
				429
			);
			assert.equal(sent, 10);
			now += 15 * 60000;
			assert.equal((await run(g, e())).status, 200);
		}
	);
	await t.test(
		'public invitation acceptance: actual route rejects repeated token before work',
		async () => {
			invitation.resetInvitationRateLimits(() => now);
			try {
				const g = guard();
				const e = () => event('/api/invitations/accept', { body: { token: 'a'.repeat(43) } });
				for (let i = 0; i < 5; i++) assert.notEqual((await run(g, e(), accept.POST)).status, 429);
				const r = await run(g, e(), accept.POST);
				assert.equal(r.status, 429);
				assert.ok(Number(r.headers.get('retry-after')) > 0);
				assert.equal((await r.json()).error.message, 'Too many requests.');
			} finally {
				invitation.resetInvitationRateLimits();
			}
		}
	);
	await t.test('costly reads and general API floods are bounded; assets bypass', async () => {
		const g = guard();
		for (let i = 0; i < 120; i++)
			assert.equal(
				(
					await run(
						g,
						event('/api/incidents?organizationId=' + A, {
							method: 'GET',
							headers: { 'test-user': 'a' }
						})
					)
				).status,
				200
			);
		assert.equal(
			(
				await run(
					g,
					event('/api/incidents?organizationId=' + A, {
						method: 'GET',
						headers: { 'test-user': 'a' }
					})
				)
			).status,
			429
		);
		const flood = guard();
		for (let i = 0; i < 600; i++) await run(flood, event('/api/me', { method: 'GET' }));
		assert.equal((await run(flood, event('/api/me', { method: 'GET' }))).status, 429);
		assert.equal((await run(flood, event('/favicon.ico', { method: 'GET' }))).status, 200);
	});
	await t.test(
		'store failure: sensitive writes/auth 503, read fail-open, no raw error',
		async () => {
			const g = guard({
				store: {
					consume() {
						throw Error('SECRET_STORE_ENDPOINT');
					}
				}
			});
			const r = await run(g, login());
			assert.equal(r.status, 503);
			assert.equal(r.headers.get('retry-after'), '30');
			assert.equal((await r.text()).includes('SECRET'), false);
			assert.equal((await run(g, business())).status, 503);
			assert.equal((await run(g, event('/api/me', { method: 'GET' }))).status, 200);
		}
	);
	await t.test('parallel in-process attempts cannot overspend individual window', async () => {
		const g = guard();
		const results = await Promise.all(Array.from({ length: 40 }, () => run(g, login())));
		assert.equal(results.filter((r) => r.status === 200).length, 5);
	});
	await t.test(
		'SQL bound is real, filters applied before cap, overflow is explicit 422',
		async () => {
			const [org] = await db
				.insert(s.organizations)
				.values({ name: 'bound', slug: randomUUID(), status: 'active' })
				.returning();
			await db.insert(s.categories).values(
				Array.from({ length: 501 }, (_, i) => ({
					organizationId: org.id,
					name: 'Category ' + i,
					active: true
				}))
			);
			const service = await server.ssrLoadModule('/src/lib/server/services/categories.ts');
			const http = await server.ssrLoadModule('/src/routes/api/categories/http.ts');
			let error;
			try {
				await service.listCategories(db, org.id);
			} catch (e) {
				error = e;
			}
			assert.ok(error instanceof bounded.ResultLimitError);
			assert.equal(http.categoryServiceFailure(error).status, 422);
			assert.equal((await service.listCategories(db, randomUUID())).length, 0);
			assert.equal(
				(
					await bounded.boundedRows(
						db.select().from(s.categories).where(eq(s.categories.name, 'Category 1'))
					)
				).length,
				1
			);
		}
	);
	await t.test(
		'real inactive/no-session identity remains 401; forbidden tenant remains 403',
		async () => {
			const { user } = await createCredentialUser(f, { email: randomUUID() + '@example.test' });
			const session = await createSession(f, user.id, {
				expiresAt: new Date(Date.now() + 3600000)
			});
			const rolesRoute = await server.ssrLoadModule('/src/routes/api/roles/+server.ts');
			const g = security.createApiAbuseGuard({ store: security.memoryAbuseStore(() => now) });
			const e = () =>
				event('/api/roles?organizationId=' + A, {
					method: 'GET',
					headers: { cookie: session.cookieHeader }
				});
			assert.equal((await run(g, e(), rolesRoute.GET)).status, 403);
			await db.update(s.users).set({ active: false }).where(eq(s.users.id, user.id));
			assert.equal((await run(g, e(), rolesRoute.GET)).status, 401);
			assert.equal(
				(await run(g, event('/api/roles?organizationId=' + A, { method: 'GET' }), rolesRoute.GET))
					.status,
				401
			);
		}
	);
	await t.test(
		'hook wiring, no spoofable Better Auth IP or duplicate limiter; SQL bounds inventoried',
		() => {
			const read = (p) => fs.readFileSync(p, 'utf8');
			assert.match(read('src/hooks.server.ts'), /beforeResolve:\s*limitApiAbuse/);
			assert.match(read('src/lib/server/auth/instance.ts'), /disableIpTracking:\s*true/);
			assert.match(read('src/lib/server/auth/instance.ts'), /rateLimit:\s*\{\s*enabled:\s*false/);
			for (const file of [
				'incidents',
				'categories',
				'sites',
				'teams',
				'memberships',
				'roles',
				'invitations',
				'sla-policies',
				'webhook-subscriptions'
			])
				assert.match(read('src/lib/server/services/' + file + '.ts'), /boundedRows/);
			assert.doesNotMatch(read('src/lib/server/security/rate-limit.ts'), /setInterval/);
		}
	);
});

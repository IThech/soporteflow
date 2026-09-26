import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { fixture, directory, createCredentialUser, TEST_ORIGIN } from './helpers/auth-fixture.mjs';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const PASSWORD = 'Contraseña-segura-1';
const CUSTOMER_CAPABILITIES = [
	'incidents:create',
	'incidents:view_requested',
	'incidents:add_comment',
	'sites:view',
	'categories:view'
];

function makeEvent(request, params = {}, { address, route = '/api/invitations' } = {}) {
	const url = new URL(request.url);
	return {
		request,
		url,
		params,
		locals: {},
		cookies: { get: () => undefined, getAll: () => [], set() {}, delete() {}, serialize: () => '' },
		fetch: globalThis.fetch,
		...(address ? { getClientAddress: () => address } : {}),
		isDataRequest: false,
		isSubRequest: false,
		platform: {},
		route: { id: route },
		setHeaders() {}
	};
}

let ip = 1;
const nextIp = () => `10.20.${Math.floor(ip / 250)}.${ip++ % 250}`;

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

test('SoporteFlow — Etapa 5.4S-D: verificación y aceptación pública de invitaciones', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server, pg } = f;
	const { ensureOrganizationRoles } = await server.ssrLoadModule(
		'/src/lib/server/services/roles.ts'
	);
	const email = await server.ssrLoadModule('/src/lib/server/email/invitation-email.ts');
	const limits = await server.ssrLoadModule('/src/lib/server/security/invitation-rate-limits.ts');
	const { FixedWindowRateLimiter } = await server.ssrLoadModule(
		'/src/lib/server/security/rate-limit.ts'
	);
	const acceptance = await server.ssrLoadModule(
		'/src/lib/server/services/invitation-acceptance.ts'
	);
	const routes = {
		admin: await server.ssrLoadModule('/src/routes/api/invitations/+server.ts'),
		item: await server.ssrLoadModule('/src/routes/api/invitations/[id]/+server.ts'),
		resend: await server.ssrLoadModule('/src/routes/api/invitations/[id]/resend/+server.ts'),
		verify: await server.ssrLoadModule('/src/routes/api/invitations/verify/+server.ts'),
		accept: await server.ssrLoadModule('/src/routes/api/invitations/accept/+server.ts'),
		auth: await server.ssrLoadModule('/src/routes/api/auth/[...all]/+server.ts'),
		me: await server.ssrLoadModule('/src/routes/api/me/+server.ts'),
		incidents: await server.ssrLoadModule('/src/routes/api/incidents/+server.ts')
	};
	const mail = new email.MemoryInvitationEmailSender();
	email.setInvitationEmailSender(mail);
	t.after(() => email.setInvitationEmailSender(undefined));
	let clock = Date.now();
	limits.resetInvitationRateLimits(() => clock);
	t.after(() => limits.resetInvitationRateLimits());
	const fresh = () => {
		clock += 60 * 60 * 1000;
	};

	let seq = 0;
	const address = (tag = 'inv') => `${tag}${++seq}-${randomUUID().slice(0, 6)}@example.test`;

	async function organization(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'sd-' + randomUUID(), status: 'active' })
			.returning();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		const byCode = (code) => roles.find((r) => r.code === code);
		return {
			org,
			admin: byCode('organization_admin'),
			tech: byCode('technician'),
			customer: byCode('customer')
		};
	}
	async function http(
		handler,
		{ method = 'POST', url, body, cookie, params = {}, headers = {}, addr }
	) {
		const h = new Headers(headers);
		if (cookie) h.set('cookie', cookie);
		if (body !== undefined && !h.has('content-type')) h.set('content-type', 'application/json');
		const request = new Request(url, {
			method,
			headers: h,
			body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
		});
		const response = await handler(makeEvent(request, params, { address: addr }));
		const text = await response.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* not JSON */
		}
		return { status: response.status, json, text, headers: response.headers };
	}
	async function signIn(userEmail, password) {
		const res = await http(routes.auth.POST, {
			url: `${TEST_ORIGIN}/api/auth/sign-in/email`,
			body: { email: userEmail, password },
			params: { all: 'sign-in/email' },
			headers: { origin: TEST_ORIGIN, 'x-forwarded-for': nextIp() }
		});
		return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? null };
	}
	async function adminOf(org, role) {
		const user = await createCredentialUser(f, { email: address('admin'), password: PASSWORD });
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
		await db.insert(s.roleAssignments).values({
			organizationId: org.id,
			membershipId: membership.id,
			roleId: role.id,
			scopeType: 'organization'
		});
		return { user, cookie: (await signIn(user.email, PASSWORD)).cookie };
	}
	async function issue(who, org, role, to = address()) {
		const res = await http(routes.admin.POST, {
			url: `${TEST_ORIGIN}/api/invitations?organizationId=${org.id}`,
			body: { email: to, roleId: role.id },
			cookie: who.cookie
		});
		assert.equal(res.status, 201, res.text);
		const normalized = to.trim().toLowerCase();
		return {
			invitation: res.json.invitation,
			token: mail.lastTo(normalized).token,
			email: normalized
		};
	}
	const verify = (body, extra = {}) =>
		http(routes.verify.POST, { url: `${TEST_ORIGIN}/api/invitations/verify`, body, ...extra });
	const accept = (body, extra = {}) =>
		http(routes.accept.POST, { url: `${TEST_ORIGIN}/api/invitations/accept`, body, ...extra });
	async function me(cookie, org) {
		const res = await http(routes.me.GET, {
			method: 'GET',
			url: `${TEST_ORIGIN}/api/me?organizationId=${org.id}`,
			cookie
		});
		return res.json;
	}
	async function invitationRow(id) {
		const [row] = await db.select().from(s.invitations).where(eq(s.invitations.id, id));
		return row;
	}
	async function counts() {
		const { rows } = await pg.query(
			`SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM user_emails)::int AS emails,
			        (SELECT count(*) FROM auth_users)::int AS auth_users, (SELECT count(*) FROM auth_accounts)::int AS accounts,
			        (SELECT count(*) FROM memberships)::int AS memberships, (SELECT count(*) FROM role_assignments)::int AS assignments,
			        (SELECT count(*) FROM invitations WHERE status = 'accepted')::int AS accepted`
		);
		return rows[0];
	}
	const INVALID = {
		error: { code: 'INVALID_INVITATION', message: 'This invitation is not valid.' }
	};

	const A = await organization('Alfa');
	const B = await organization('Beta');
	const adminA = await adminOf(A.org, A.admin);
	const adminB = await adminOf(B.org, B.admin);

	// =========================================================================
	// Verify
	// =========================================================================
	await t.test(
		'verify: POST con token en body; DTO público mínimo, email enmascarado',
		async () => {
			fresh();
			const { token, email: to } = await issue(
				adminA,
				A.org,
				A.customer,
				'carla.cliente@example.test'
			);
			const res = await verify({ token });
			assert.equal(res.status, 200);
			assert.equal(res.headers.get('cache-control'), 'no-store');
			assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
			assert.deepEqual(Object.keys(res.json).sort(), ['invitation', 'valid']);
			assert.deepEqual(Object.keys(res.json.invitation).sort(), [
				'expiresAt',
				'maskedEmail',
				'organizationName',
				'roleName'
			]);
			assert.equal(res.json.valid, true);
			assert.equal(res.json.invitation.organizationName, 'Alfa');
			assert.equal(res.json.invitation.roleName, 'Cliente');
			assert.equal(res.json.invitation.maskedEmail, 'c***@example.test');
			assert.ok(
				!res.text.includes(to) && !res.text.includes(A.org.id) && !res.text.includes(A.customer.id)
			);
			assert.ok(!/userExists|token|hash|permission/i.test(res.text));
			assert.deepEqual(
				Object.keys(routes.verify),
				['POST'],
				'sin GET: el token nunca va en la URL'
			);
			assert.deepEqual(Object.keys(routes.accept), ['POST']);
		}
	);

	await t.test(
		'verify: no enumera cuentas (misma forma para email existente o nuevo)',
		async () => {
			fresh();
			const existing = await createCredentialUser(f, { email: address('exists') });
			const a = await issue(adminA, A.org, A.customer, existing.email);
			const b = await issue(adminA, A.org, A.customer);
			const ra = await verify({ token: a.token });
			const rb = await verify({ token: b.token });
			assert.equal(ra.status, rb.status);
			assert.deepEqual(Object.keys(ra.json.invitation), Object.keys(rb.json.invitation));
		}
	);

	await t.test(
		'verify: desconocido, mal formado, revocado, caducado, usado y token viejo -> mismo 404',
		async () => {
			fresh();
			const revoked = await issue(adminA, A.org, A.customer);
			await http(routes.item.DELETE, {
				method: 'DELETE',
				url: `${TEST_ORIGIN}/api/invitations/${revoked.invitation.id}?organizationId=${A.org.id}`,
				params: { id: revoked.invitation.id },
				cookie: adminA.cookie
			});
			const expired = await issue(adminA, A.org, A.customer);
			await db
				.update(s.invitations)
				.set({ expiresAt: new Date(Date.now() - 1000) })
				.where(eq(s.invitations.id, expired.invitation.id));
			const used = await issue(adminA, A.org, A.customer);
			assert.equal(
				(await accept({ token: used.token, name: 'Usada', password: PASSWORD })).status,
				200
			);
			const resent = await issue(adminA, A.org, A.customer);
			await http(routes.resend.POST, {
				url: `${TEST_ORIGIN}/api/invitations/${resent.invitation.id}/resend?organizationId=${A.org.id}`,
				params: { id: resent.invitation.id },
				cookie: adminA.cookie
			});
			const newToken = mail.lastTo(resent.email).token;
			for (const token of [
				'A'.repeat(43),
				'corto',
				revoked.token,
				expired.token,
				used.token,
				resent.token,
				` ${revoked.token}`
			]) {
				const res = await verify({ token });
				assert.equal(res.status, 404, token);
				assert.deepEqual(res.json, INVALID);
			}
			assert.equal((await verify({ token: newToken })).status, 200, 'el token nuevo sí vale');
			assert.equal(
				(await verify({ token: ` ${newToken}\n` })).status,
				200,
				'solo espacios externos'
			);
			assert.equal((await verify({ token: newToken.toLowerCase() })).status, 404, 'case-sensitive');
		}
	);

	await t.test('verify: entrada estricta (body, content-type, query, tamaño) -> 400', async () => {
		fresh();
		const { token } = await issue(adminA, A.org, A.customer);
		for (const [body, extra] of [
			[{}, {}],
			[{ token, email: 'x@y.zz' }, {}],
			[{ token: 5 }, {}],
			[`token=${token}`, { headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
			[{ token }, { url: `${TEST_ORIGIN}/api/invitations/verify?token=${token}` }],
			[{ token, padding: 'x'.repeat(5000) }, {}],
			['{bad', {}]
		]) {
			const res = await verify(body, extra);
			assert.equal(res.status, 400, JSON.stringify(extra));
			assert.equal(res.json.error.code, 'INVALID_INPUT');
		}
	});

	await t.test(
		'rate limit verify: 10/min por token y 60/min por dirección; 429 con Retry-After',
		async () => {
			fresh();
			const { token } = await issue(adminA, A.org, A.customer);
			for (let i = 0; i < 10; i++) assert.equal((await verify({ token })).status, 200);
			const limited = await verify({ token });
			assert.equal(limited.status, 429);
			assert.equal(limited.json.error.code, 'RATE_LIMITED');
			assert.ok(Number(limited.headers.get('retry-after')) >= 1);
			clock += 61_000;
			assert.equal((await verify({ token })).status, 200, 'la ventana se reinicia');
			fresh();
			for (let i = 0; i < 60; i++)
				await verify({ token: `${'b'.repeat(40)}${i}`.slice(-43) }, { addr: '192.0.2.7' });
			assert.equal((await verify({ token }, { addr: '192.0.2.7' })).status, 429, 'por dirección');
			assert.equal((await verify({ token }, { addr: '192.0.2.8' })).status, 200, 'otra dirección');
		}
	);

	await t.test('limitador: acotado en memoria (barrido y expulsión), reloj inyectable', () => {
		let now = 0;
		const limiter = new FixedWindowRateLimiter({
			limit: 1,
			windowMs: 1000,
			maxKeys: 3,
			now: () => now
		});
		for (const k of ['a', 'b', 'c', 'd']) limiter.consume(k);
		assert.equal(limiter.size, 3, 'nunca supera maxKeys');
		assert.equal(limiter.consume('d').allowed, false);
		now = 2000;
		assert.equal(limiter.consume('d').allowed, true);
	});

	// =========================================================================
	// Accept — usuario nuevo + E2E Customer
	// =========================================================================
	await t.test(
		'E2E Customer: invita, verifica, acepta, inicia sesión, /api/me, crea y ve su incidencia',
		async () => {
			fresh();
			const to = address('nuevo');
			const { token, invitation } = await issue(adminA, A.org, A.customer, to);
			assert.equal((await verify({ token })).status, 200);
			const before = await counts();
			const res = await accept({ token, name: '  Nora Nueva  ', password: PASSWORD });
			assert.equal(res.status, 200, res.text);
			assert.deepEqual(res.json, {
				accepted: true,
				organization: { name: 'Alfa' },
				requiresLogin: true
			});
			assert.equal(res.headers.get('set-cookie'), null, 'sin auto-login');
			assert.ok(!res.text.includes(PASSWORD));
			const after = await counts();
			assert.deepEqual(
				{ ...after },
				{
					...before,
					users: before.users + 1,
					emails: before.emails + 1,
					auth_users: before.auth_users + 1,
					accounts: before.accounts + 1,
					memberships: before.memberships + 1,
					assignments: before.assignments + 1,
					accepted: before.accepted + 1
				}
			);
			const [emailRow] = await db.select().from(s.userEmails).where(eq(s.userEmails.email, to));
			const userId = emailRow.userId;
			assert.equal(emailRow.isPrimary, true);
			assert.ok(emailRow.verifiedAt instanceof Date, 'posesión del token = email verificado');
			const [user] = await db.select().from(s.users).where(eq(s.users.id, userId));
			assert.equal(user.name, 'Nora Nueva');
			const [authUser] = await db.select().from(s.authUsers).where(eq(s.authUsers.id, userId));
			assert.equal(authUser.email, to);
			assert.equal(authUser.emailVerified, true);
			const [account] = await db
				.select()
				.from(s.authAccounts)
				.where(eq(s.authAccounts.userId, userId));
			assert.equal(account.providerId, 'credential');
			assert.equal(account.accountId, userId);
			assert.notEqual(account.password, PASSWORD);
			assert.ok(!account.password.includes(PASSWORD));
			const [membership] = await db
				.select()
				.from(s.memberships)
				.where(and(eq(s.memberships.userId, userId), eq(s.memberships.organizationId, A.org.id)));
			assert.equal(membership.active, true);
			const assigned = await db
				.select()
				.from(s.roleAssignments)
				.where(eq(s.roleAssignments.membershipId, membership.id));
			assert.deepEqual(
				assigned.map((r) => [r.roleId, r.scopeType, r.organizationId]),
				[[A.customer.id, 'organization', A.org.id]]
			);
			const row = await invitationRow(invitation.id);
			assert.equal(row.status, 'accepted');
			assert.ok(row.acceptedAt instanceof Date);

			// login normal con Better Auth
			const login = await signIn(to, PASSWORD);
			assert.equal(login.status, 200);
			assert.ok(login.cookie);
			assert.equal((await signIn(to, 'otra-contraseña-mal')).status, 401);
			const profile = await me(login.cookie, A.org);
			assert.deepEqual(profile.activeOrganization.capabilities, CUSTOMER_CAPABILITIES);

			// Customer crea una incidencia (para sí mismo) y la ve
			const created = await http(routes.incidents.POST, {
				url: `${TEST_ORIGIN}/api/incidents`,
				body: {
					organizationId: A.org.id,
					title: 'No funciona',
					description: 'Detalle',
					client: 'Nora'
				},
				cookie: login.cookie
			});
			assert.equal(created.status, 201, created.text);
			assert.equal(created.json.incident.clientUserId, userId);
			const listed = await http(routes.incidents.GET, {
				method: 'GET',
				url: `${TEST_ORIGIN}/api/incidents?organizationId=${A.org.id}`,
				cookie: login.cookie
			});
			assert.deepEqual(
				listed.json.incidents.map((i) => i.id),
				[created.json.incident.id]
			);

			// replay: el token ya no sirve y no escribe nada
			const snapshot = await counts();
			const replay = await accept({ token, name: 'Otra', password: PASSWORD });
			assert.equal(replay.status, 404);
			assert.deepEqual(replay.json, INVALID);
			assert.deepEqual(await counts(), snapshot);
			assert.equal((await verify({ token })).status, 404);
		}
	);

	await t.test(
		'usuario nuevo: validación de nombre/contraseña sin trimming destructivo',
		async () => {
			fresh();
			const { token, email: to } = await issue(adminA, A.org, A.customer);
			const before = await counts();
			for (const body of [
				{ token },
				{ token, name: 'Sin clave' },
				{ token, password: PASSWORD },
				{ token, name: '   ', password: PASSWORD },
				{ token, name: 'Corta', password: 'x'.repeat(11) },
				{ token, name: 'Larga', password: 'x'.repeat(129) },
				{ token, name: 'x'.repeat(256), password: PASSWORD },
				{ token, name: 5, password: PASSWORD },
				{ token, name: 'Extra', password: PASSWORD, email: 'otro@example.test' },
				{ token, name: 'Extra', password: PASSWORD, roleId: A.admin.id },
				{ token, name: 'Extra', password: PASSWORD, organizationId: B.org.id }
			]) {
				fresh(); // cada intento en una ventana nueva: aquí se prueba la validación, no el límite
				const res = await accept(body);
				assert.equal(res.status, 400, JSON.stringify(Object.keys(body)));
				assert.equal(res.json.error.code, 'INVALID_INPUT');
			}
			assert.deepEqual(await counts(), before, 'nada escrito');
			const spaced = '  espacios dentro y fuera  ';
			fresh();
			assert.equal((await accept({ token, name: 'Espacios', password: spaced })).status, 200);
			assert.equal((await signIn(to, spaced)).status, 200, 'contraseña exacta, sin trim');
			assert.equal((await signIn(to, spaced.trim())).status, 401);
		}
	);

	await t.test('CSRF/entrada: form-urlencoded, token en query y cuerpo enorme -> 400', async () => {
		fresh();
		const { token } = await issue(adminA, A.org, A.customer);
		const form = await accept(`token=${token}&name=X&password=${PASSWORD}`, {
			headers: { 'content-type': 'application/x-www-form-urlencoded' }
		});
		assert.equal(form.status, 400);
		assert.equal(
			(await accept({ token }, { url: `${TEST_ORIGIN}/api/invitations/accept?token=${token}` }))
				.status,
			400
		);
		assert.equal(
			(await accept({ token, name: 'X', password: 'y'.repeat(5000) })).status,
			400,
			'límite de tamaño'
		);
		assert.equal((await verify({ token })).status, 200, 'la invitación sigue intacta');
	});

	// =========================================================================
	// Accept — usuario existente
	// =========================================================================
	await t.test(
		'usuario existente: sin sesión 401 genérico sin escribir; con su sesión se une a otra org',
		async () => {
			fresh();
			const alice = await createCredentialUser(f, { email: address('alice'), password: PASSWORD });
			const [inA] = await db
				.insert(s.memberships)
				.values({ organizationId: A.org.id, userId: alice.id })
				.returning();
			await db.insert(s.roleAssignments).values({
				organizationId: A.org.id,
				membershipId: inA.id,
				roleId: A.tech.id,
				scopeType: 'organization'
			});
			const { token, invitation } = await issue(
				adminB,
				B.org,
				B.customer,
				alice.email.toUpperCase()
			);
			const before = await counts();
			const anon = await accept({ token });
			assert.equal(anon.status, 401);
			assert.equal(anon.json.error.code, 'AUTHENTICATION_REQUIRED');
			assert.ok(!/exist|already|ya/i.test(anon.text));
			// intentar fijar contraseña sin sesión no la cambia
			const hijack = await accept({ token, name: 'Mallory', password: 'contraseña-atacante' });
			assert.equal(hijack.status, 401);
			assert.deepEqual(await counts(), before);
			assert.equal(
				(await signIn(alice.email, PASSWORD)).status,
				200,
				'contraseña original intacta'
			);
			assert.equal((await signIn(alice.email, 'contraseña-atacante')).status, 401);

			const session = await signIn(alice.email, PASSWORD);
			const withFields = await accept(
				{ token, name: 'X', password: PASSWORD },
				{ cookie: session.cookie }
			);
			assert.equal(withFields.status, 400, 'con sesión no se aceptan campos de alta');
			const ok = await accept({ token }, { cookie: session.cookie });
			assert.equal(ok.status, 200, ok.text);
			assert.deepEqual(ok.json, {
				accepted: true,
				organization: { name: 'Beta' },
				requiresLogin: false
			});
			const mine = await db.select().from(s.memberships).where(eq(s.memberships.userId, alice.id));
			assert.deepEqual(mine.map((m) => m.organizationId).sort(), [A.org.id, B.org.id].sort());
			assert.equal((await db.select().from(s.users).where(eq(s.users.id, alice.id))).length, 1);
			const after = await counts();
			assert.equal(after.users, before.users, 'misma identidad, sin usuario nuevo');
			assert.equal(after.accounts, before.accounts);
			const profileA = await me(session.cookie, A.org);
			assert.ok(
				profileA.activeOrganization.capabilities.includes('incidents:view_all'),
				'org A intacta'
			);
			assert.deepEqual(
				(await me(session.cookie, B.org)).activeOrganization.capabilities,
				CUSTOMER_CAPABILITIES
			);
			assert.equal((await invitationRow(invitation.id)).status, 'accepted');
			const [auth] = await db.select().from(s.authUsers).where(eq(s.authUsers.id, alice.id));
			assert.equal(auth.emailVerified, false, 'no se toca la verificación de un usuario existente');
		}
	);

	await t.test(
		'sesión equivocada: token de alice + sesión de bob -> 403 sin escrituras',
		async () => {
			fresh();
			const bob = await createCredentialUser(f, { email: address('bob'), password: PASSWORD });
			const bobSession = await signIn(bob.email, PASSWORD);
			const alice = await createCredentialUser(f, { email: address('alice') });
			const toExisting = await issue(adminA, A.org, A.customer, alice.email);
			const toNew = await issue(adminA, A.org, A.customer);
			const before = await counts();
			for (const body of [
				{ token: toExisting.token },
				{ token: toNew.token },
				{ token: toNew.token, name: 'Nueva', password: PASSWORD }
			]) {
				const res = await accept(body, { cookie: bobSession.cookie });
				assert.equal(res.status, 403, JSON.stringify(Object.keys(body)));
				assert.equal(res.json.error.code, 'INVALID_ACCEPTOR');
			}
			assert.deepEqual(await counts(), before);
			assert.equal((await verify({ token: toNew.token })).status, 200, 'sigue pendiente');
			const bobMemberships = await db
				.select()
				.from(s.memberships)
				.where(eq(s.memberships.userId, bob.id));
			assert.equal(bobMemberships.length, 0);
		}
	);

	await t.test('multi-org: el mismo email nuevo acepta dos orgs; una sola identidad', async () => {
		fresh();
		const to = address('multi');
		const inA = await issue(adminA, A.org, A.customer, to);
		const inB = await issue(adminB, B.org, B.tech, to);
		assert.equal(
			(await accept({ token: inA.token, name: 'Multi', password: PASSWORD })).status,
			200
		);
		const second = await accept({ token: inB.token, name: 'Multi', password: 'otra-clave-12345' });
		assert.equal(second.status, 401, 'ya existe: requiere iniciar sesión, no crea otra identidad');
		const session = await signIn(to, PASSWORD);
		assert.equal((await accept({ token: inB.token }, { cookie: session.cookie })).status, 200);
		const owners = await db.select().from(s.userEmails).where(eq(s.userEmails.email, to));
		assert.equal(owners.length, 1);
		const memberships = await db
			.select()
			.from(s.memberships)
			.where(eq(s.memberships.userId, owners[0].userId));
		assert.equal(memberships.length, 2);
		const roleIds = (
			await db
				.select({ roleId: s.roleAssignments.roleId })
				.from(s.roleAssignments)
				.innerJoin(s.memberships, eq(s.memberships.id, s.roleAssignments.membershipId))
				.where(eq(s.memberships.userId, owners[0].userId))
		)
			.map((r) => r.roleId)
			.sort();
		assert.deepEqual(roleIds, [A.customer.id, B.tech.id].sort(), 'cada org con su rol');
	});

	// =========================================================================
	// Estado del rol / org / membresía
	// =========================================================================
	await t.test(
		'rol desactivado u org suspendida: verify/accept inválidos, sin escrituras',
		async () => {
			fresh();
			const C = await organization('Suspendible');
			const adminC = await adminOf(C.org, C.admin);
			const orgInvite = await issue(adminC, C.org, C.customer);
			const [role] = await db
				.insert(s.roles)
				.values({
					organizationId: A.org.id,
					name: 'Temporal',
					code: `tmp_${++seq}`,
					isCustom: true
				})
				.returning();
			await db.insert(s.rolePermissions).values({ roleId: role.id, permissionId: 'sites:view' });
			const roleInvite = await issue(adminA, A.org, role);
			await db.update(s.roles).set({ active: false }).where(eq(s.roles.id, role.id));
			await db
				.update(s.organizations)
				.set({ status: 'suspended' })
				.where(eq(s.organizations.id, C.org.id));
			const before = await counts();
			for (const token of [orgInvite.token, roleInvite.token]) {
				assert.deepEqual((await verify({ token })).json, INVALID);
				const res = await accept({ token, name: 'X', password: PASSWORD });
				assert.equal(res.status, 404);
				assert.deepEqual(res.json, INVALID);
			}
			assert.deepEqual(await counts(), before);
		}
	);

	await t.test(
		'decisión 64: rol ampliado tras invitar invalida la invitación hasta reenviar',
		async () => {
			fresh();
			const [role] = await db
				.insert(s.roles)
				.values({
					organizationId: A.org.id,
					name: 'Soporte ligero',
					code: `lite_${++seq}`,
					isCustom: true
				})
				.returning();
			await db.insert(s.rolePermissions).values({ roleId: role.id, permissionId: 'sites:view' });
			const { token, invitation, email: to } = await issue(adminA, A.org, role);
			assert.deepEqual((await invitationRow(invitation.id)).rolePermissionIds, ['sites:view']);
			// otro admin amplía el rol
			await db.insert(s.rolePermissions).values({ roleId: role.id, permissionId: 'sites:manage' });
			assert.deepEqual((await verify({ token })).json, INVALID);
			const before = await counts();
			assert.deepEqual((await accept({ token, name: 'X', password: PASSWORD })).json, INVALID);
			assert.deepEqual(await counts(), before, 'la ampliación nunca se concede por la invitación');
			// reenviar (revalida delegación del actor actual) re-captura el rol ampliado
			const resent = await http(routes.resend.POST, {
				url: `${TEST_ORIGIN}/api/invitations/${invitation.id}/resend?organizationId=${A.org.id}`,
				params: { id: invitation.id },
				cookie: adminA.cookie
			});
			assert.equal(resent.status, 200);
			assert.deepEqual([...(await invitationRow(invitation.id)).rolePermissionIds].sort(), [
				'sites:manage',
				'sites:view'
			]);
			const newToken = mail.lastTo(to).token;
			assert.equal((await verify({ token: newToken })).status, 200);
			// reducir el rol sigue permitido (nunca da más de lo delegado)
			await db
				.delete(s.rolePermissions)
				.where(
					and(
						eq(s.rolePermissions.roleId, role.id),
						eq(s.rolePermissions.permissionId, 'sites:manage')
					)
				);
			assert.equal(
				(await accept({ token: newToken, name: 'Lite', password: PASSWORD })).status,
				200
			);
		}
	);

	await t.test(
		'membresía: activa aparecida después se reutiliza; inactiva -> 409 sin reactivar',
		async () => {
			fresh();
			const dora = await createCredentialUser(f, { email: address('dora'), password: PASSWORD });
			const { token } = await issue(adminA, A.org, A.customer, dora.email);
			const [membership] = await db
				.insert(s.memberships)
				.values({ organizationId: A.org.id, userId: dora.id, active: true })
				.returning();
			const session = await signIn(dora.email, PASSWORD);
			assert.equal((await accept({ token }, { cookie: session.cookie })).status, 200);
			const all = await db.select().from(s.memberships).where(eq(s.memberships.userId, dora.id));
			assert.equal(all.length, 1, 'sin membresía duplicada');
			const roles = await db
				.select()
				.from(s.roleAssignments)
				.where(eq(s.roleAssignments.membershipId, membership.id));
			assert.deepEqual(
				roles.map((r) => r.roleId),
				[A.customer.id]
			);

			const eve = await createCredentialUser(f, { email: address('eve'), password: PASSWORD });
			const invite = await issue(adminA, A.org, A.customer, eve.email);
			await db
				.insert(s.memberships)
				.values({ organizationId: A.org.id, userId: eve.id, active: false });
			const eveSession = await signIn(eve.email, PASSWORD);
			const before = await counts();
			const res = await accept({ token: invite.token }, { cookie: eveSession.cookie });
			assert.equal(res.status, 409);
			assert.equal(res.json.error.code, 'ACCEPTANCE_CONFLICT');
			assert.deepEqual(await counts(), before);
			const [still] = await db.select().from(s.memberships).where(eq(s.memberships.userId, eve.id));
			assert.equal(still.active, false);
			assert.equal((await invitationRow(invite.invitation.id)).status, 'pending');
		}
	);

	await t.test('invitador desactivado: la invitación sigue siendo aceptable', async () => {
		fresh();
		const temp = await adminOf(A.org, A.admin);
		const { token } = await issue(temp, A.org, A.customer);
		await db.update(s.users).set({ active: false }).where(eq(s.users.id, temp.user.id));
		assert.equal((await accept({ token, name: 'Tras baja', password: PASSWORD })).status, 200);
	});

	// =========================================================================
	// Concurrencia y atomicidad
	// =========================================================================
	await t.test('doble aceptación simultánea: solo una gana; una sola identidad', async () => {
		fresh();
		const { token, email: to } = await issue(adminA, A.org, A.customer);
		const results = await Promise.all([
			accept({ token, name: 'Rápida', password: PASSWORD }),
			accept({ token, name: 'Lenta', password: PASSWORD })
		]);
		assert.deepEqual(results.map((r) => r.status).sort(), [200, 404]);
		assert.equal(
			(await db.select().from(s.userEmails).where(eq(s.userEmails.email, to))).length,
			1
		);
	});

	await t.test(
		'atomicidad: fallo al asignar el rol -> rollback total (sin usuario, membresía ni aceptación)',
		async () => {
			fresh();
			const { token, invitation, email: to } = await issue(adminA, A.org, A.customer);
			await pg.exec(`
			CREATE FUNCTION test_fail_ra() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'forced'; END $$;
			CREATE TRIGGER test_fail_ra BEFORE INSERT ON role_assignments
			FOR EACH ROW EXECUTE FUNCTION test_fail_ra();`);
			const before = await counts();
			let res;
			try {
				res = await accept({ token, name: 'Rollback', password: PASSWORD });
			} finally {
				await pg.exec(
					'DROP TRIGGER test_fail_ra ON role_assignments; DROP FUNCTION test_fail_ra();'
				);
			}
			assert.equal(res.status, 500);
			assert.deepEqual(res.json, {
				error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' }
			});
			assert.ok(!/forced|role_assignments/.test(res.text));
			assert.deepEqual(await counts(), before);
			assert.equal(
				(await db.select().from(s.userEmails).where(eq(s.userEmails.email, to))).length,
				0
			);
			assert.equal((await invitationRow(invitation.id)).status, 'pending');
			assert.equal((await accept({ token, name: 'Reintento', password: PASSWORD })).status, 200);
		}
	);

	await t.test('rate limit accept: 5 por token en 15 min -> 429', async () => {
		fresh();
		const { token } = await issue(adminA, A.org, A.customer);
		for (let i = 0; i < 5; i++)
			assert.equal((await accept({ token, name: 'X', password: 'corta' })).status, 400);
		const limited = await accept({ token, name: 'X', password: PASSWORD });
		assert.equal(limited.status, 429);
		assert.equal((await verify({ token })).status, 200, 'la invitación no se consumió');
		clock += 15 * 60_000 + 1000;
		assert.equal((await accept({ token, name: 'X', password: PASSWORD })).status, 200);
	});

	// =========================================================================
	// Better Auth, fugas y migración
	// =========================================================================
	await t.test(
		'Better Auth: sign-up sigue cerrado; la invitación no abre alta lateral',
		async () => {
			const res = await http(routes.auth.POST, {
				url: `${TEST_ORIGIN}/api/auth/sign-up/email`,
				body: { email: address('signup'), password: PASSWORD, name: 'X' },
				params: { all: 'sign-up/email' },
				headers: { origin: TEST_ORIGIN, 'x-forwarded-for': nextIp() }
			});
			assert.ok([403, 404].includes(res.status), String(res.status));
			const source = fs.readFileSync('src/lib/server/auth/instance.ts', 'utf8');
			assert.match(source, /disableSignUp: true/);
			// sin token válido no hay alta
			const before = await counts();
			fresh();
			assert.equal(
				(await accept({ token: 'Z'.repeat(43), name: 'X', password: PASSWORD })).status,
				404
			);
			assert.deepEqual(await counts(), before);
		}
	);

	await t.test(
		'seguridad: sin logs de secretos; respuestas sin ids, hash, email completo ni estado de cuenta',
		async () => {
			for (const file of [
				'src/lib/server/services/invitation-acceptance.ts',
				'src/routes/api/invitations/verify/+server.ts',
				'src/routes/api/invitations/accept/+server.ts',
				'src/routes/api/invitations/public.ts',
				'src/lib/server/security/rate-limit.ts',
				'src/lib/server/security/invitation-rate-limits.ts'
			]) {
				const source = fs.readFileSync(file, 'utf8');
				assert.ok(!/console\.|logger/.test(source), file);
			}
			fresh();
			const { token, email: to } = await issue(adminA, A.org, A.customer);
			const v = await verify({ token });
			const a = await accept({ token, name: 'Segura', password: PASSWORD });
			for (const res of [v, a]) {
				for (const leak of [
					to,
					sha256(token),
					token,
					PASSWORD,
					A.org.id,
					A.customer.id,
					'userId',
					'membership'
				])
					assert.ok(!res.text.includes(leak), leak);
			}
		}
	);

	await t.test(
		'migración 0016: backfill de la instantánea con los permisos actuales del rol; idempotente',
		async () => {
			const up = new PGlite();
			try {
				const journal = JSON.parse(
					fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')
				);
				const index = journal.entries.findIndex((e) => e.tag === '0016_invitation_role_snapshot');
				assert.ok(index > 0);
				await applyRange(up, 0, index - 1);
				const org = randomUUID();
				await up.query(
					`INSERT INTO organizations (id, name, slug, status) VALUES ($1,'U',$2,'active')`,
					[org, 'u-' + org]
				);
				const {
					rows: [role]
				} = await up.query(
					`INSERT INTO roles (organization_id, name, code, is_custom) VALUES ($1,'R','r',true) RETURNING id`,
					[org]
				);
				await up.query(
					`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,'sites:view'), ($1,'categories:view')`,
					[role.id]
				);
				const {
					rows: [user]
				} = await up.query(`INSERT INTO users (name) VALUES ('U') RETURNING id`);
				await up.query(
					`INSERT INTO invitations (organization_id, email, role_id, token_hash, invited_by_user_id, expires_at)
				 VALUES ($1,'u@example.test',$2,$3,$4, now() + interval '1 day')`,
					[org, role.id, 'a'.repeat(64), user.id]
				);
				await applyRange(up, index, index);
				await applyRange(up, index, index);
				const { rows } = await up.query(`SELECT role_permission_ids FROM invitations`);
				assert.deepEqual(rows[0].role_permission_ids, ['categories:view', 'sites:view']);
			} finally {
				await up.close();
			}
		}
	);

	await t.test('servicio: normalización de token y máscara', () => {
		assert.equal(acceptance.maskEmail('ana@example.test'), 'a***@example.test');
		assert.equal(acceptance.normalizeInvitationToken('  abc \n'), 'abc');
		assert.throws(
			() => acceptance.normalizeInvitationToken(5),
			(e) => e.code === 'INVALID_INPUT'
		);
	});
});

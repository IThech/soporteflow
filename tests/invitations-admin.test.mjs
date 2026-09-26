import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

test('SoporteFlow — Etapa 5.4S-C: invitaciones administrativas', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server, pg } = f;
	const { ensureOrganizationRoles } = await server.ssrLoadModule(
		'/src/lib/server/services/roles.ts'
	);
	const service = await server.ssrLoadModule('/src/lib/server/services/invitations.ts');
	const {
		generateInvitationToken,
		hashInvitationToken,
		normalizeInvitationEmail,
		createInvitation,
		resendInvitation,
		INVITATION_TTL_HOURS
	} = service;
	const email = await server.ssrLoadModule('/src/lib/server/email/invitation-email.ts');
	const { IncidentServiceError } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);
	const listRoute = await server.ssrLoadModule('/src/routes/api/invitations/+server.ts');
	const itemRoute = await server.ssrLoadModule('/src/routes/api/invitations/[id]/+server.ts');
	const resendRoute = await server.ssrLoadModule(
		'/src/routes/api/invitations/[id]/resend/+server.ts'
	);
	const mail = new email.MemoryInvitationEmailSender();
	email.setInvitationEmailSender(mail);
	t.after(() => email.setInvitationEmailSender(undefined));

	const DTO_KEYS = [
		'acceptedAt',
		'createdAt',
		'email',
		'expiresAt',
		'id',
		'invitedBy',
		'role',
		'status',
		'updatedAt'
	];
	let seq = 0;
	const address = (tag = 'p') => `${tag}${++seq}-${randomUUID().slice(0, 6)}@example.test`;

	async function rejectsWith(operation, code) {
		await assert.rejects(operation, (error) => {
			assert.ok(error instanceof IncidentServiceError, `esperado IncidentServiceError: ${error}`);
			assert.equal(error.code, code);
			return true;
		});
	}
	async function organization(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'sc-' + randomUUID(), status: 'active' })
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
	async function rawRole(org, permissionIds, values = {}) {
		const [role] = await db
			.insert(s.roles)
			.values({
				organizationId: org.id,
				name: 'Raw',
				code: `raw_${++seq}`,
				isCustom: true,
				...values
			})
			.returning();
		for (const permissionId of permissionIds)
			await db.insert(s.rolePermissions).values({ roleId: role.id, permissionId });
		return role;
	}
	async function member(org, roles = [], { active = true, mail: userEmail } = {}) {
		const user = await createCredentialUser(f, { email: userEmail ?? address('m') });
		await db.update(s.userEmails).set({ isPrimary: true }).where(eq(s.userEmails.userId, user.id));
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id, active })
			.returning();
		for (const role of roles)
			await db.insert(s.roleAssignments).values({
				organizationId: org.id,
				membershipId: membership.id,
				roleId: role.id,
				scopeType: 'organization'
			});
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, headers: session.headers, cookie: session.cookieHeader };
	}
	async function call(
		handler,
		{ method = 'GET', path, who, query = '', params = {}, body, rawBody }
	) {
		const url = new URL(`http://localhost${path}?${query}`);
		const headers = new Headers();
		if (who) headers.set('cookie', who.cookie);
		const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
		if (payload !== undefined) headers.set('content-type', 'application/json');
		const response = await handler({
			url,
			params,
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
	const create = (who, org, body, extra = {}) =>
		call(listRoute.POST, {
			method: 'POST',
			path: '/api/invitations',
			who,
			query: `organizationId=${org.id}`,
			body,
			...extra
		});
	const list = (who, org, query = '') =>
		call(listRoute.GET, {
			path: '/api/invitations',
			who,
			query: `organizationId=${org.id}${query}`
		});
	const detail = (who, org, id, query = '') =>
		call(itemRoute.GET, {
			path: `/api/invitations/${id}`,
			who,
			query: `organizationId=${org.id}${query}`,
			params: { id }
		});
	const revoke = (who, org, id) =>
		call(itemRoute.DELETE, {
			method: 'DELETE',
			path: `/api/invitations/${id}`,
			who,
			query: `organizationId=${org.id}`,
			params: { id }
		});
	const resend = (who, org, id, extra = {}) =>
		call(resendRoute.POST, {
			method: 'POST',
			path: `/api/invitations/${id}/resend`,
			who,
			query: `organizationId=${org.id}`,
			params: { id },
			...extra
		});
	async function row(id) {
		const [r] = await db.select().from(s.invitations).where(eq(s.invitations.id, id));
		return r;
	}
	async function invite(who, org, role, to = address()) {
		const res = await create(who, org, { email: to, roleId: role.id });
		assert.equal(res.status, 201, res.text);
		return res.json.invitation;
	}

	const A = await organization('Alfa');
	const B = await organization('Beta');
	const admin = await member(A.org, [A.admin]);
	const adminB = await member(B.org, [B.admin]);
	const tech = await member(A.org, [A.tech]);

	// =========================================================================
	// Tokens (40)
	// =========================================================================
	await t.test('40. token: 256 bits base64url, distintos; hash SHA-256 hex', () => {
		const tokens = new Set(Array.from({ length: 50 }, () => generateInvitationToken()));
		assert.equal(tokens.size, 50);
		for (const token of tokens) {
			assert.match(token, /^[A-Za-z0-9_-]{43}$/);
			assert.equal(Buffer.from(token, 'base64url').length, 32);
			assert.equal(hashInvitationToken(token), sha256(token));
			assert.match(hashInvitationToken(token), /^[0-9a-f]{64}$/);
		}
		assert.equal(normalizeInvitationEmail('  Foo@Example.COM '), 'foo@example.com');
		for (const bad of ['', '   ', 'no-at', 'a@b', 'a b@c.de', 'x'.repeat(250) + '@e.com', 3, null])
			assert.throws(
				() => normalizeInvitationEmail(bad),
				(e) => e.code === 'INVALID_INPUT'
			);
		assert.equal(INVITATION_TTL_HOURS, 48);
	});

	// =========================================================================
	// Create (41)
	// =========================================================================
	await t.test(
		'41. Admin invita Customer: 201, email normalizado, solo hash en DB, token solo al sender',
		async () => {
			mail.reset();
			const before = Date.now();
			const res = await create(admin, A.org, {
				email: '  Foo.Bar@Example.COM ',
				roleId: A.customer.id
			});
			assert.equal(res.status, 201, res.text);
			assert.equal(res.headers.get('cache-control'), 'private, no-store');
			const dto = res.json.invitation;
			assert.deepEqual(Object.keys(res.json), ['invitation']);
			assert.deepEqual(Object.keys(dto).sort(), DTO_KEYS);
			assert.equal(dto.email, 'foo.bar@example.com');
			assert.equal(dto.status, 'pending');
			assert.equal(dto.acceptedAt, null);
			assert.deepEqual(dto.role, {
				id: A.customer.id,
				code: 'customer',
				name: 'Cliente',
				active: true
			});
			assert.deepEqual(dto.invitedBy, { id: admin.user.id, name: 'Credential User' });
			const ttl = Date.parse(dto.expiresAt) - before;
			assert.ok(ttl >= 48 * 3600000 - 5000 && ttl <= 48 * 3600000 + 5000, `ttl ${ttl}`);
			assert.equal(mail.sent.length, 1);
			const message = mail.sent[0];
			assert.equal(message.email, 'foo.bar@example.com');
			assert.equal(message.organizationName, 'Alfa');
			assert.equal(message.roleName, 'Cliente');
			assert.equal(message.expiresAt.toISOString(), dto.expiresAt);
			const stored = await row(dto.id);
			assert.equal(stored.tokenHash, sha256(message.token));
			assert.equal(stored.invitedByUserId, admin.user.id);
			assert.ok(!res.text.includes(message.token), 'el token no sale en la API');
			assert.ok(!res.text.includes(stored.tokenHash), 'el hash no sale en la API');
			const dump = JSON.stringify((await pg.query(`SELECT * FROM invitations`)).rows);
			assert.ok(!dump.includes(message.token), 'el token en claro no se persiste');
		}
	);

	await t.test('41. rol de otro tenant o inexistente: 404 idéntico; inactivo 409', async () => {
		const foreign = await create(admin, A.org, { email: address(), roleId: B.customer.id });
		const missing = await create(admin, A.org, { email: address(), roleId: randomUUID() });
		assert.equal(foreign.status, 404);
		assert.deepEqual(foreign.json, missing.json);
		assert.equal(foreign.json.error.code, 'ROLE_NOT_FOUND');
		const off = await rawRole(A.org, ['sites:view'], { active: false });
		const inactive = await create(admin, A.org, { email: address(), roleId: off.id });
		assert.equal(inactive.status, 409);
		assert.equal(inactive.json.error.code, 'ROLE_INACTIVE');
		assert.equal(
			(await db.select().from(s.invitations).where(eq(s.invitations.roleId, off.id))).length,
			0
		);
	});

	await t.test(
		'41/36. delegación: inferior no invita Customer ni Admin; legacy fail-closed',
		async () => {
			const weak = await member(A.org, [
				await rawRole(A.org, ['invitations:create', 'roles:assign', 'sites:view'])
			]);
			const r1 = await create(weak, A.org, { email: address(), roleId: A.customer.id });
			assert.equal(r1.status, 403);
			assert.equal(r1.json.error.code, 'PERMISSION_NOT_DELEGABLE');
			const r2 = await create(weak, A.org, { email: address(), roleId: A.admin.id });
			assert.equal(r2.json.error.code, 'PERMISSION_NOT_DELEGABLE');
			// con todos los permisos de Customer sí puede invitar Customer (por capability, no por code)
			const able = await member(A.org, [
				await rawRole(A.org, [
					'invitations:create',
					'roles:assign',
					'incidents:create',
					'incidents:view_requested',
					'incidents:add_comment',
					'sites:view',
					'categories:view'
				])
			]);
			assert.equal(
				(await create(able, A.org, { email: address(), roleId: A.customer.id })).status,
				201
			);
			assert.equal(
				(await create(able, A.org, { email: address(), roleId: A.admin.id })).status,
				403
			);
			await db
				.insert(s.permissions)
				.values({
					id: 'legacy:invite',
					name: 'Legacy',
					description: 'Legacy',
					category: 'legacy',
					allowedScopeTypes: ['organization']
				})
				.onConflictDoNothing();
			const legacy = await rawRole(A.org, ['sites:view', 'legacy:invite']);
			const r3 = await create(admin, A.org, { email: address(), roleId: legacy.id });
			assert.equal(r3.status, 403);
			assert.equal(r3.json.error.code, 'PERMISSION_NOT_DELEGABLE');
		}
	);

	await t.test(
		'47. permisos: invitations:create Y roles:assign; sin ellos 403; sin sesión 401',
		async () => {
			const body = { email: address(), roleId: A.customer.id };
			assert.equal((await create(null, A.org, body)).status, 401);
			assert.equal((await create(tech, A.org, body)).status, 403);
			const noAssign = await member(A.org, [
				await rawRole(A.org, [
					'invitations:create',
					'incidents:create',
					'incidents:view_requested',
					'incidents:add_comment',
					'sites:view',
					'categories:view'
				])
			]);
			const denied = await create(noAssign, A.org, body);
			assert.equal(denied.status, 403);
			assert.equal(denied.json.error.code, 'FORBIDDEN');
			const noCreate = await member(A.org, [await rawRole(A.org, ['roles:assign'])]);
			assert.equal((await create(noCreate, A.org, body)).status, 403);
			assert.equal((await create(admin, B.org, body)).status, 403, 'org ajena');
		}
	);

	await t.test(
		'41. pending duplicada (también con otra capitalización) -> 409, sin segunda fila',
		async () => {
			const to = address('dup');
			await invite(admin, A.org, A.customer, to);
			const again = await create(admin, A.org, { email: to.toUpperCase(), roleId: A.tech.id });
			assert.equal(again.status, 409);
			assert.equal(again.json.error.code, 'INVITATION_ALREADY_PENDING');
			const rows = await db.select().from(s.invitations).where(eq(s.invitations.email, to));
			assert.equal(rows.length, 1);
			// en otra org, el mismo email se puede invitar
			assert.equal((await create(adminB, B.org, { email: to, roleId: B.customer.id })).status, 201);
		}
	);

	await t.test(
		'41. miembro activo 409 ALREADY_MEMBER; inactivo 409 MEMBERSHIP_INACTIVE; otra org no filtra',
		async () => {
			const activeMail = address('act');
			await member(A.org, [], { mail: activeMail });
			const r1 = await create(admin, A.org, {
				email: activeMail.toUpperCase(),
				roleId: A.customer.id
			});
			assert.equal(r1.status, 409);
			assert.equal(r1.json.error.code, 'ALREADY_MEMBER');
			const idleMail = address('idle');
			await member(A.org, [], { mail: idleMail, active: false });
			const r2 = await create(admin, A.org, { email: idleMail, roleId: A.customer.id });
			assert.equal(r2.status, 409);
			assert.equal(r2.json.error.code, 'MEMBERSHIP_INACTIVE');
			// miembro de B, no de A: invitación normal, sin revelar nada de B
			const bMail = address('b');
			await member(B.org, [B.admin], { mail: bMail });
			const r3 = await create(admin, A.org, { email: bMail, roleId: A.customer.id });
			assert.equal(r3.status, 201);
			assert.ok(!r3.text.includes('Beta'));
		}
	);

	await t.test(
		'30. body/query estrictos: campos de servidor, email inválido, query extra -> 400',
		async () => {
			const good = { email: address(), roleId: A.customer.id };
			for (const extra of [
				{ organizationId: A.org.id },
				{ invitedByUserId: admin.user.id },
				{ token: 'x' },
				{ tokenHash: 'x' },
				{ status: 'accepted' },
				{ expiresAt: new Date().toISOString() },
				{ acceptedAt: null }
			]) {
				const r = await create(admin, A.org, { ...good, ...extra });
				assert.equal(r.status, 400, JSON.stringify(extra));
				assert.equal(r.json.error.code, 'INVALID_INPUT');
			}
			for (const body of [
				{ email: 'no-es-email', roleId: A.customer.id },
				{ email: address() },
				{ roleId: A.customer.id },
				{ email: address(), roleId: 'x' },
				{ email: 5, roleId: A.customer.id }
			])
				assert.equal((await create(admin, A.org, body)).status, 400, JSON.stringify(body));
			assert.equal((await create(admin, A.org, undefined, { rawBody: '{bad' })).status, 400);
			assert.equal(
				(await create(admin, A.org, good, { query: `organizationId=${A.org.id}&x=1` })).status,
				400
			);
			assert.equal((await create(admin, { id: 'nope' }, good)).status, 400);
			assert.equal(
				(await db.select().from(s.invitations).where(eq(s.invitations.email, good.email))).length,
				0
			);
		}
	);

	// =========================================================================
	// List / detail (42)
	// =========================================================================
	await t.test('42. listado: scope del tenant, orden desc, filtros, DTO sin hash', async () => {
		const C = await organization('Listado');
		const adminC = await member(C.org, [C.admin]);
		const first = await invite(adminC, C.org, C.customer);
		const second = await invite(adminC, C.org, C.tech);
		const third = await invite(adminC, C.org, C.customer);
		await revoke(adminC, C.org, second.id);
		const res = await list(adminC, C.org);
		assert.equal(res.status, 200);
		assert.deepEqual(
			res.json.invitations.map((i) => i.id),
			[third.id, second.id, first.id]
		);
		for (const i of res.json.invitations) assert.deepEqual(Object.keys(i).sort(), DTO_KEYS);
		assert.ok(!/token/i.test(res.text));
		assert.ok(!res.text.includes(C.org.id));
		assert.deepEqual(
			(await list(adminC, C.org, '&status=revoked')).json.invitations.map((i) => i.id),
			[second.id]
		);
		assert.deepEqual(
			(await list(adminC, C.org, '&status=pending')).json.invitations.map((i) => i.id),
			[third.id, first.id]
		);
		assert.deepEqual(
			(
				await list(adminC, C.org, `&email=${encodeURIComponent(first.email.toUpperCase())}`)
			).json.invitations.map((i) => i.id),
			[first.id]
		);
		for (const q of ['&status=sent', '&sort=email', '&status=pending&status=revoked', '&email=bad'])
			assert.equal((await list(adminC, C.org, q)).status, 400, q);
		// tenant: A no ve las de C; C no ve las de A
		assert.ok(!(await list(admin, A.org)).json.invitations.some((i) => i.id === first.id));
		assert.equal((await list(admin, C.org)).status, 403);
		assert.equal((await list(tech, A.org)).status, 403, 'sin invitations:view');
		assert.equal((await list(null, A.org)).status, 401);
	});

	await t.test('42. detalle: 200 seguro; otro tenant 404 idéntico a inexistente', async () => {
		const inv = await invite(admin, A.org, A.customer);
		const ok = await detail(admin, A.org, inv.id);
		assert.equal(ok.status, 200);
		assert.deepEqual(ok.json.invitation, inv);
		const foreign = await invite(adminB, B.org, B.customer);
		const cross = await detail(admin, A.org, foreign.id);
		const missing = await detail(admin, A.org, randomUUID());
		assert.equal(cross.status, 404);
		assert.deepEqual(cross.json, missing.json);
		assert.equal(cross.json.error.code, 'INVITATION_NOT_FOUND');
		assert.equal((await detail(admin, A.org, 'nope')).status, 400);
		assert.equal((await detail(admin, A.org, inv.id, '&x=1')).status, 400);
		assert.equal((await detail(tech, A.org, inv.id)).status, 403);
	});

	// =========================================================================
	// Expiración derivada (19)
	// =========================================================================
	await t.test(
		'19. expiración: derivada en lecturas sin efectos; persistida al crear de nuevo',
		async () => {
			const to = address('exp');
			const inv = await invite(admin, A.org, A.customer, to);
			await db
				.update(s.invitations)
				.set({ expiresAt: new Date(Date.now() - 1000) })
				.where(eq(s.invitations.id, inv.id));
			assert.equal((await detail(admin, A.org, inv.id)).json.invitation.status, 'expired');
			assert.equal((await row(inv.id)).status, 'pending', 'GET sin efectos');
			assert.ok(
				(await list(admin, A.org, '&status=expired')).json.invitations.some((i) => i.id === inv.id)
			);
			assert.ok(
				!(await list(admin, A.org, '&status=pending')).json.invitations.some((i) => i.id === inv.id)
			);
			const fresh = await create(admin, A.org, { email: to, roleId: A.customer.id });
			assert.equal(fresh.status, 201, 'la pending caducada no bloquea una nueva');
			assert.equal((await row(inv.id)).status, 'expired', 'transición persistida en la mutación');
			// reenviar la antigua caducada mientras hay otra pending -> 409
			const conflict = await resend(admin, A.org, inv.id);
			assert.equal(conflict.status, 409);
			assert.equal(conflict.json.error.code, 'INVITATION_ALREADY_PENDING');
		}
	);

	// =========================================================================
	// Revoke (43)
	// =========================================================================
	await t.test(
		'43. revocar: pending -> revoked 204 (fila conservada); idempotente; accepted/expired 409',
		async () => {
			const inv = await invite(admin, A.org, A.customer);
			const before = await row(inv.id);
			const res = await revoke(admin, A.org, inv.id);
			assert.equal(res.status, 204);
			assert.equal(res.text, '');
			const after = await row(inv.id);
			assert.equal(after.status, 'revoked');
			assert.ok(after.updatedAt > before.updatedAt);
			assert.equal(after.tokenHash, before.tokenHash);
			assert.equal((await revoke(admin, A.org, inv.id)).status, 204, 'idempotente');
			const accepted = await invite(admin, A.org, A.customer);
			await db
				.update(s.invitations)
				.set({ status: 'accepted', acceptedAt: new Date() })
				.where(eq(s.invitations.id, accepted.id));
			const r1 = await revoke(admin, A.org, accepted.id);
			assert.equal(r1.status, 409);
			assert.equal(r1.json.error.code, 'INVITATION_NOT_REVOCABLE');
			const expired = await invite(admin, A.org, A.customer);
			await db
				.update(s.invitations)
				.set({ expiresAt: new Date(Date.now() - 1000) })
				.where(eq(s.invitations.id, expired.id));
			assert.equal((await revoke(admin, A.org, expired.id)).status, 409);
			assert.equal((await row(expired.id)).status, 'pending', 'sin escritura en error');
		}
	);

	await t.test('43/46. revocar: otro tenant 404; requiere invitations:revoke', async () => {
		const foreign = await invite(adminB, B.org, B.customer);
		assert.equal((await revoke(admin, A.org, foreign.id)).status, 404);
		assert.equal((await row(foreign.id)).status, 'pending');
		const inv = await invite(admin, A.org, A.customer);
		const creatorOnly = await member(A.org, [
			await rawRole(A.org, ['invitations:create', 'invitations:view'])
		]);
		assert.equal((await revoke(creatorOnly, A.org, inv.id)).status, 403);
		const revoker = await member(A.org, [await rawRole(A.org, ['invitations:revoke'])]);
		assert.equal((await revoke(revoker, A.org, inv.id)).status, 204);
	});

	// =========================================================================
	// Resend (44)
	// =========================================================================
	await t.test(
		'44/22. reenviar pending: misma fila, token y hash nuevos, expiración nueva, email',
		async () => {
			mail.reset();
			const inv = await invite(admin, A.org, A.customer);
			const firstToken = mail.lastTo(inv.email).token;
			const before = await row(inv.id);
			await db
				.update(s.invitations)
				.set({ expiresAt: new Date(Date.now() + 3600000) })
				.where(eq(s.invitations.id, inv.id));
			const res = await resend(admin, A.org, inv.id);
			assert.equal(res.status, 200, res.text);
			assert.equal(res.json.invitation.id, inv.id);
			assert.equal(res.json.invitation.status, 'pending');
			const after = await row(inv.id);
			const secondToken = mail.lastTo(inv.email).token;
			assert.equal(mail.sent.length, 2);
			assert.notEqual(secondToken, firstToken);
			assert.equal(after.tokenHash, sha256(secondToken));
			assert.notEqual(after.tokenHash, before.tokenHash);
			assert.ok(after.expiresAt.getTime() > Date.now() + 47 * 3600000);
			assert.ok(after.updatedAt > before.updatedAt);
			const old = await db
				.select()
				.from(s.invitations)
				.where(eq(s.invitations.tokenHash, sha256(firstToken)));
			assert.equal(old.length, 0, 'el token anterior ya no coincide con nada');
			assert.ok(!res.text.includes(secondToken) && !res.text.includes(after.tokenHash));
			assert.equal(
				(await db.select().from(s.invitations).where(eq(s.invitations.email, inv.email))).length,
				1,
				'sin segunda fila'
			);
		}
	);

	await t.test(
		'44. reenviar: expired se reactiva; revoked/accepted 409; body 400; otro tenant 404',
		async () => {
			const expired = await invite(admin, A.org, A.customer);
			await db
				.update(s.invitations)
				.set({ status: 'expired', expiresAt: new Date(Date.now() - 1000) })
				.where(eq(s.invitations.id, expired.id));
			const reactivated = await resend(admin, A.org, expired.id);
			assert.equal(reactivated.status, 200);
			assert.equal(reactivated.json.invitation.status, 'pending');
			assert.equal((await row(expired.id)).status, 'pending');
			const revoked = await invite(admin, A.org, A.customer);
			await revoke(admin, A.org, revoked.id);
			const r1 = await resend(admin, A.org, revoked.id);
			assert.equal(r1.status, 409);
			assert.equal(r1.json.error.code, 'INVITATION_NOT_RESENDABLE');
			const accepted = await invite(admin, A.org, A.customer);
			await db
				.update(s.invitations)
				.set({ status: 'accepted', acceptedAt: new Date() })
				.where(eq(s.invitations.id, accepted.id));
			assert.equal(
				(await resend(admin, A.org, accepted.id)).json.error.code,
				'INVITATION_NOT_RESENDABLE'
			);
			const pending = await invite(admin, A.org, A.customer);
			assert.equal(
				(await resend(admin, A.org, pending.id, { body: { email: 'x@y.zz' } })).status,
				400
			);
			const foreign = await invite(adminB, B.org, B.customer);
			assert.equal((await resend(admin, A.org, foreign.id)).status, 404);
			assert.equal((await resend(tech, A.org, pending.id)).status, 403);
			assert.equal((await resend(null, A.org, pending.id)).status, 401);
		}
	);

	await t.test('44. reenviar re-verifica delegación, rol activo y membresía actuales', async () => {
		const role = await rawRole(A.org, ['sites:view']);
		const inv = await invite(admin, A.org, role);
		const weak = await member(A.org, [
			await rawRole(A.org, ['invitations:create', 'roles:assign', 'categories:view'])
		]);
		assert.equal((await resend(weak, A.org, inv.id)).json.error.code, 'PERMISSION_NOT_DELEGABLE');
		await db.update(s.roles).set({ active: false }).where(eq(s.roles.id, role.id));
		assert.equal((await resend(admin, A.org, inv.id)).json.error.code, 'ROLE_INACTIVE');
		const joined = await invite(admin, A.org, A.customer);
		await member(A.org, [], { mail: joined.email });
		assert.equal((await resend(admin, A.org, joined.id)).json.error.code, 'ALREADY_MEMBER');
	});

	// =========================================================================
	// Fallo de email (45)
	// =========================================================================
	await t.test(
		'45. fallo de email: 502 seguro, invitación pending persistida, reenvío posterior OK',
		async () => {
			mail.reset();
			mail.failing = true;
			const to = address('fail');
			const res = await create(admin, A.org, { email: to, roleId: A.customer.id });
			assert.equal(res.status, 502);
			assert.deepEqual(Object.keys(res.json), ['error']);
			assert.equal(res.json.error.code, 'EMAIL_DELIVERY_FAILED');
			assert.ok(!/simulated|token/i.test(res.text));
			const [saved] = await db.select().from(s.invitations).where(eq(s.invitations.email, to));
			assert.equal(saved.status, 'pending');
			mail.failing = false;
			const retry = await resend(admin, A.org, saved.id);
			assert.equal(retry.status, 200);
			assert.equal((await row(saved.id)).tokenHash, sha256(mail.lastTo(to).token));
		}
	);

	await t.test(
		'25. sin proveedor configurado: falla explícitamente (no simula éxito)',
		async () => {
			email.setInvitationEmailSender(undefined);
			try {
				assert.ok(
					email.getInvitationEmailSender() instanceof email.UnconfiguredInvitationEmailSender
				);
				const res = await create(admin, A.org, { email: address('none'), roleId: A.customer.id });
				assert.equal(res.status, 502);
				assert.equal(res.json.error.code, 'EMAIL_DELIVERY_FAILED');
			} finally {
				email.setInvitationEmailSender(mail);
			}
		}
	);

	// =========================================================================
	// Servicio directo, multi-tenant y límites de S-C
	// =========================================================================
	await t.test(
		'servicio: nunca devuelve el token en el DTO; entrada inválida fail-closed',
		async () => {
			const ctx = {
				organizationId: A.org.id,
				actorUserId: admin.user.id,
				actorPermissions: [...delegablePermissions()]
			};
			const issued = await createInvitation(db, ctx, {
				email: address('svc'),
				roleId: A.customer.id
			});
			assert.ok(!JSON.stringify(issued.invitation).includes(issued.delivery.token));
			assert.equal((await row(issued.invitation.id)).tokenHash, sha256(issued.delivery.token));
			const again = await resendInvitation(db, ctx, issued.invitation.id);
			assert.notEqual(again.delivery.token, issued.delivery.token);
			await rejectsWith(
				createInvitation(db, ctx, { email: 'x', roleId: A.customer.id }),
				'INVALID_INPUT'
			);
			await rejectsWith(
				createInvitation(
					db,
					{ ...ctx, organizationId: B.org.id },
					{ email: address(), roleId: A.customer.id }
				),
				'ROLE_NOT_FOUND'
			);
			await rejectsWith(resendInvitation(db, ctx, randomUUID()), 'INVITATION_NOT_FOUND');
		}
	);

	function delegablePermissions() {
		return [
			'incidents:view_all',
			'incidents:create',
			'incidents:view_requested',
			'incidents:add_comment',
			'sites:view',
			'categories:view',
			'roles:assign',
			'invitations:create'
		];
	}

	await t.test(
		'49. la administración (S-C) no crea usuarios, membresías, asignaciones ni cuentas',
		async () => {
			const counts = async () =>
				(
					await pg.query(
						`SELECT (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM memberships)::int AS m,
					        (SELECT count(*) FROM role_assignments)::int AS ra, (SELECT count(*) FROM auth_accounts)::int AS aa,
					        (SELECT count(*) FROM auth_users)::int AS au`
					)
				).rows[0];
			const before = await counts();
			const inv = await invite(admin, A.org, A.customer);
			await resend(admin, A.org, inv.id);
			await revoke(admin, A.org, inv.id);
			assert.deepEqual(await counts(), before);
			assert.deepEqual(Object.keys(listRoute).sort(), ['GET', 'POST']);
			assert.deepEqual(Object.keys(itemRoute).sort(), ['DELETE', 'GET']);
			assert.deepEqual(Object.keys(resendRoute).sort(), ['POST']);
			const source = fs.readFileSync('src/lib/server/services/invitations.ts', 'utf8');
			for (const forbidden of [
				'insert(users',
				'insert(memberships',
				'insert(roleAssignments',
				'authAccounts'
			])
				assert.ok(!source.includes(forbidden), forbidden);
			const instance = fs.readFileSync('src/lib/server/auth/instance.ts', 'utf8');
			assert.match(instance, /disableSignUp: true/);
		}
	);

	await t.test(
		'32/34. errores seguros: sin SQL, constraints, stacks ni datos de otros tenants',
		async () => {
			const foreign = await invite(adminB, B.org, B.customer);
			const to = address('err');
			await invite(admin, A.org, A.customer, to);
			const responses = [
				await create(admin, A.org, { email: to, roleId: A.customer.id }),
				await detail(admin, A.org, foreign.id),
				await revoke(admin, A.org, foreign.id),
				await resend(admin, A.org, foreign.id),
				await create(admin, A.org, { email: address(), roleId: B.customer.id })
			];
			for (const r of responses) {
				assert.deepEqual(Object.keys(r.json), ['error']);
				for (const leak of [
					'select',
					'constraint',
					'invitations_',
					'stack',
					'token',
					foreign.email,
					'Beta'
				])
					assert.ok(!r.text.toLowerCase().includes(leak.toLowerCase()), leak);
			}
			const { rows } = await pg.query(
				`SELECT count(*)::int AS n FROM invitations WHERE organization_id = $1 AND role_id = $2`,
				[A.org.id, B.customer.id]
			);
			assert.equal(rows[0].n, 0);
			assert.ok(
				(
					await db
						.select()
						.from(s.invitations)
						.where(and(eq(s.invitations.id, foreign.id)))
				).length === 1
			);
		}
	);
});

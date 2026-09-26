import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
	listInvitations,
	getInvitation,
	createInvitation,
	revokeInvitation,
	resendInvitation,
	verifyInvitation,
	acceptInvitation,
	InvitationApiError
} from '../src/lib/api/invitations.ts';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

const ORG = randomUUID();
const INV = randomUUID();
const ROLE = randomUUID();
const USER = randomUUID();
const NOW = '2026-09-26T10:00:00.000Z';

function invitation(overrides = {}) {
	return {
		id: INV,
		email: 'ana@example.test',
		status: 'pending',
		expiresAt: '2026-09-28T10:00:00.000Z',
		acceptedAt: null,
		createdAt: NOW,
		updatedAt: NOW,
		role: { id: ROLE, code: 'customer', name: 'Cliente', active: true },
		invitedBy: { id: USER, name: 'Admin' },
		...overrides
	};
}
function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}
function mockFetch(respond) {
	const calls = [];
	const fetchFn = async (url, init) => {
		calls.push({ url, init });
		return typeof respond === 'function' ? respond(url, init) : respond;
	};
	return { fetchFn, calls };
}
async function rejectsWith(promise, { status, code }) {
	await assert.rejects(promise, (error) => {
		assert.ok(error instanceof InvitationApiError, `esperado InvitationApiError: ${error}`);
		if (status !== undefined) assert.equal(error.status, status);
		assert.equal(error.code, code);
		return true;
	});
}
const ids = { organizationId: ORG, invitationId: INV };

test('SoporteFlow — Etapa 5.4S-C: cliente API de invitaciones', async (t) => {
	await t.test(
		'listInvitations: GET, filtros normalizados, signal, customFetch, sin cabeceras',
		async () => {
			const controller = new AbortController();
			const { fetchFn, calls } = mockFetch(json({ invitations: [invitation()] }));
			const result = await listInvitations({
				organizationId: ORG,
				status: 'pending',
				email: ' Ana@Example.TEST ',
				customFetch: fetchFn,
				signal: controller.signal
			});
			assert.deepEqual(result, [invitation()]);
			assert.equal(
				calls[0].url,
				`/api/invitations?organizationId=${ORG}&status=pending&email=ana%40example.test`
			);
			assert.equal(calls[0].init.method, 'GET');
			assert.equal(calls[0].init.signal, controller.signal);
			assert.equal(calls[0].init.headers, undefined);
		}
	);

	await t.test(
		'getInvitation / createInvitation / revokeInvitation / resendInvitation: contratos',
		async () => {
			const { fetchFn, calls } = mockFetch((url, init) => {
				if (init.method === 'DELETE') return new Response(null, { status: 204 });
				if (init.method === 'POST' && url.includes('/resend'))
					return json({ invitation: invitation() });
				if (init.method === 'POST') return json({ invitation: invitation() }, 201);
				return json({ invitation: invitation() });
			});
			assert.deepEqual(await getInvitation({ ...ids, customFetch: fetchFn }), invitation());
			assert.equal(calls[0].url, `/api/invitations/${INV}?organizationId=${ORG}`);
			const created = await createInvitation({
				organizationId: ORG,
				email: '  ANA@example.test',
				roleId: ROLE,
				customFetch: fetchFn
			});
			assert.equal(created.id, INV);
			assert.equal(calls[1].init.method, 'POST');
			assert.equal(calls[1].url, `/api/invitations?organizationId=${ORG}`);
			assert.deepEqual(calls[1].init.headers, { 'Content-Type': 'application/json' });
			assert.deepEqual(JSON.parse(calls[1].init.body), { email: 'ana@example.test', roleId: ROLE });
			assert.equal(await revokeInvitation({ ...ids, customFetch: fetchFn }), undefined);
			assert.equal(calls[2].init.method, 'DELETE');
			assert.equal(calls[2].init.body, undefined);
			const resent = await resendInvitation({ ...ids, customFetch: fetchFn });
			assert.equal(resent.status, 'pending');
			assert.equal(calls[3].url, `/api/invitations/${INV}/resend?organizationId=${ORG}`);
			assert.equal(calls[3].init.body, undefined, 'resend sin body');
		}
	);

	await t.test('validación previa: UUID, email y filtros inválidos no llaman a fetch', async () => {
		const { fetchFn, calls } = mockFetch(json({}));
		for (const promise of [
			listInvitations({ organizationId: 'x', customFetch: fetchFn }),
			listInvitations({ organizationId: ORG, status: 'sent', customFetch: fetchFn }),
			listInvitations({ organizationId: ORG, email: 'bad', customFetch: fetchFn }),
			getInvitation({ organizationId: ORG, invitationId: 'x', customFetch: fetchFn }),
			createInvitation({ organizationId: ORG, email: 'bad', roleId: ROLE, customFetch: fetchFn }),
			createInvitation({ organizationId: ORG, email: 'a@b.cd', roleId: 'x', customFetch: fetchFn }),
			createInvitation({ organizationId: ORG, roleId: ROLE, customFetch: fetchFn }),
			revokeInvitation({ ...ids, invitationId: `${INV}/../x`, customFetch: fetchFn }),
			resendInvitation({ ...ids, organizationId: '', customFetch: fetchFn })
		])
			await rejectsWith(promise, { status: 0, code: 'INVALID_INPUT' });
		assert.equal(calls.length, 0);
	});

	await t.test(
		'parser estricto: token/tokenHash y extras descartados; payload inválido',
		async () => {
			const [clean] = await listInvitations({
				organizationId: ORG,
				customFetch: async () =>
					json({
						invitations: [
							{
								...invitation(),
								token: 'raw-token',
								tokenHash: 'a'.repeat(64),
								organizationId: ORG,
								role: { ...invitation().role, permissions: ['x:y'] },
								invitedBy: { ...invitation().invitedBy, email: 'admin@example.test' }
							}
						]
					})
			});
			assert.deepEqual(clean, invitation());
			assert.ok(!JSON.stringify(clean).includes('raw-token'));
			for (const bad of [
				{},
				{ invitations: 'x' },
				{ invitations: [invitation(), invitation()] },
				{ invitations: [invitation({ status: 'sent' })] },
				{ invitations: [invitation({ email: 'Ana@Example.test' })] },
				{ invitations: [invitation({ expiresAt: 'mañana' })] },
				{ invitations: [invitation({ role: null })] },
				{ invitations: [invitation({ invitedBy: { id: 'x', name: 'A' } })] },
				{ invitations: [invitation({ acceptedAt: 5 })] }
			])
				await rejectsWith(
					listInvitations({ organizationId: ORG, customFetch: async () => json(bad) }),
					{
						code: 'INVALID_PAYLOAD'
					}
				);
			for (const response of [
				json({ invitation: invitation() }, 200),
				json({ invitation: invitation({ email: 'otro@example.test' }) }, 201),
				json({ invitation: invitation({ role: { ...invitation().role, id: randomUUID() } }) }, 201)
			])
				await rejectsWith(
					createInvitation({
						organizationId: ORG,
						email: 'ana@example.test',
						roleId: ROLE,
						customFetch: async () => response
					}),
					{ code: 'INVALID_PAYLOAD' }
				);
			await rejectsWith(
				getInvitation({
					...ids,
					customFetch: async () => json({ invitation: invitation({ id: randomUUID() }) })
				}),
				{ code: 'INVALID_PAYLOAD' }
			);
			await rejectsWith(
				resendInvitation({
					...ids,
					customFetch: async () => json({ invitation: invitation({ status: 'revoked' }) })
				}),
				{ code: 'INVALID_PAYLOAD' }
			);
			await rejectsWith(revokeInvitation({ ...ids, customFetch: async () => json({}) }), {
				code: 'INVALID_PAYLOAD'
			});
		}
	);

	await t.test('mapeo HTTP: 400/401/403/404/409/502/5xx con mensajes fijos', async () => {
		const res = (status, code) => async () =>
			json({ error: { code, message: 'SQL: invitations_token_hash_unique' } }, status);
		const create = (customFetch) =>
			createInvitation({ organizationId: ORG, email: 'a@b.cd', roleId: ROLE, customFetch });
		await rejectsWith(create(res(400, 'INVALID_INPUT')), { status: 400, code: 'INVALID_INPUT' });
		await rejectsWith(create(res(401, 'UNAUTHORIZED')), { status: 401, code: 'UNAUTHORIZED' });
		await rejectsWith(create(res(403, 'FORBIDDEN')), { status: 403, code: 'FORBIDDEN' });
		await rejectsWith(create(res(403, 'PERMISSION_NOT_DELEGABLE')), {
			status: 403,
			code: 'PERMISSION_NOT_DELEGABLE'
		});
		for (const code of ['INVITATION_NOT_FOUND', 'ROLE_NOT_FOUND'])
			await rejectsWith(create(res(404, code)), { status: 404, code });
		await rejectsWith(create(res(404, 'OTHER')), { status: 404, code: 'NOT_FOUND' });
		for (const code of [
			'INVITATION_ALREADY_PENDING',
			'ALREADY_MEMBER',
			'MEMBERSHIP_INACTIVE',
			'ROLE_INACTIVE',
			'INVITATION_NOT_REVOCABLE',
			'INVITATION_NOT_RESENDABLE'
		])
			await assert.rejects(create(res(409, code)), (e) => {
				assert.equal(e.code, code);
				assert.ok(!e.message.includes('SQL'));
				return true;
			});
		await rejectsWith(create(res(409, 'OTHER')), { status: 409, code: 'CONFLICT' });
		await assert.rejects(create(res(502, 'EMAIL_DELIVERY_FAILED')), (e) => {
			assert.equal(e.code, 'EMAIL_DELIVERY_FAILED');
			assert.match(e.message, /reenviarla/);
			return true;
		});
		await rejectsWith(create(res(500, 'INTERNAL_ERROR')), { status: 500, code: 'SERVER_ERROR' });
	});

	await t.test('AbortError se propaga; fallo de red -> NETWORK_ERROR', async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			listInvitations({
				organizationId: ORG,
				signal: controller.signal,
				customFetch: async () => {
					throw new DOMException('aborted', 'AbortError');
				}
			}),
			(e) => e.name === 'AbortError'
		);
		await rejectsWith(
			revokeInvitation({
				...ids,
				customFetch: async () => {
					throw new TypeError('fetch failed');
				}
			}),
			{ status: 0, code: 'NETWORK_ERROR' }
		);
	});

	await t.test(
		'hardening: sin storage, demo, cabeceras de identidad ni token en el cliente',
		() => {
			const source = fs.readFileSync('src/lib/api/invitations.ts', 'utf8');
			assert.ok(!/^import /m.test(source));
			for (const forbidden of [
				'localStorage',
				'sessionStorage',
				'demo',
				'x-user-id',
				'x-organization-id',
				'tokenHash',
				'actorUserId'
			])
				assert.ok(!source.includes(forbidden), forbidden);
		}
	);

	await t.test(
		'E2E cliente: Admin crea, lista, reenvía y revoca vía handlers reales',
		async (st) => {
			const f = await fixture(st);
			const { db, schema: s, server } = f;
			const { ensureOrganizationRoles } = await server.ssrLoadModule(
				'/src/lib/server/services/roles.ts'
			);
			const email = await server.ssrLoadModule('/src/lib/server/email/invitation-email.ts');
			const mail = new email.MemoryInvitationEmailSender();
			email.setInvitationEmailSender(mail);
			st.after(() => email.setInvitationEmailSender(undefined));
			const routes = {
				list: await server.ssrLoadModule('/src/routes/api/invitations/+server.ts'),
				item: await server.ssrLoadModule('/src/routes/api/invitations/[id]/+server.ts'),
				resend: await server.ssrLoadModule('/src/routes/api/invitations/[id]/resend/+server.ts')
			};
			const [org] = await db
				.insert(s.organizations)
				.values({ name: 'E2E SC', slug: 'e2e-sc-' + randomUUID(), status: 'active' })
				.returning();
			const { roles } = await ensureOrganizationRoles(db, org.id);
			const admin = roles.find((r) => r.code === 'organization_admin');
			const customer = roles.find((r) => r.code === 'customer');
			const user = await createCredentialUser(f);
			const [membership] = await db
				.insert(s.memberships)
				.values({ organizationId: org.id, userId: user.id })
				.returning();
			await db.insert(s.roleAssignments).values({
				organizationId: org.id,
				membershipId: membership.id,
				roleId: admin.id,
				scopeType: 'organization'
			});
			const session = await createSession(f, user.id, {
				expiresAt: new Date(Date.now() + 3600000)
			});
			const bridge = async (url, init) => {
				const parsed = new URL(url, 'http://localhost');
				const parts = parsed.pathname.split('/').filter(Boolean);
				const request = new Request(parsed, {
					method: init.method,
					headers: { ...(init.headers ?? {}), cookie: session.cookieHeader },
					body: init.body
				});
				const event = { url: parsed, request };
				if (parts.length === 2) return routes.list[init.method]({ ...event, params: {} });
				if (parts.length === 3)
					return routes.item[init.method]({ ...event, params: { id: parts[2] } });
				return routes.resend.POST({ ...event, params: { id: parts[2] } });
			};
			const created = await createInvitation({
				organizationId: org.id,
				email: 'Cliente@Example.test',
				roleId: customer.id,
				customFetch: bridge
			});
			assert.equal(created.email, 'cliente@example.test');
			assert.equal(created.role.code, 'customer');
			const listed = await listInvitations({ organizationId: org.id, customFetch: bridge });
			assert.deepEqual(listed, [created]);
			const resent = await resendInvitation({
				organizationId: org.id,
				invitationId: created.id,
				customFetch: bridge
			});
			assert.equal(resent.id, created.id);
			assert.equal(mail.sent.length, 2);
			assert.notEqual(mail.sent[0].token, mail.sent[1].token);
			await revokeInvitation({
				organizationId: org.id,
				invitationId: created.id,
				customFetch: bridge
			});
			assert.equal(
				(
					await getInvitation({
						organizationId: org.id,
						invitationId: created.id,
						customFetch: bridge
					})
				).status,
				'revoked'
			);
			await rejectsWith(
				resendInvitation({ organizationId: org.id, invitationId: created.id, customFetch: bridge }),
				{ status: 409, code: 'INVITATION_NOT_RESENDABLE' }
			);
			await rejectsWith(
				createInvitation({
					organizationId: org.id,
					email: 'otro@example.test',
					roleId: randomUUID(),
					customFetch: bridge
				}),
				{ status: 404, code: 'ROLE_NOT_FOUND' }
			);
		}
	);
});

test('SoporteFlow — Etapa 5.4S-D: cliente público verify/accept', async (t) => {
	const TOKEN = 'A'.repeat(21) + '_-' + 'b'.repeat(20);
	const publicInvitation = {
		organizationName: 'Alfa',
		roleName: 'Cliente',
		expiresAt: '2026-09-28T10:00:00.000Z',
		maskedEmail: 'a***@example.test'
	};

	await t.test(
		'verifyInvitation: POST con token en body (nunca en URL); parser estricto',
		async () => {
			const controller = new AbortController();
			const { fetchFn, calls } = mockFetch(
				json({ valid: true, invitation: { ...publicInvitation, organizationId: ORG, email: 'x' } })
			);
			const result = await verifyInvitation({
				token: ` ${TOKEN} `,
				customFetch: fetchFn,
				signal: controller.signal
			});
			assert.deepEqual(result, publicInvitation);
			assert.equal(calls[0].url, '/api/invitations/verify');
			assert.ok(!calls[0].url.includes(TOKEN));
			assert.equal(calls[0].init.method, 'POST');
			assert.equal(calls[0].init.signal, controller.signal);
			assert.deepEqual(JSON.parse(calls[0].init.body), { token: TOKEN });
			for (const bad of [
				{ valid: false, invitation: publicInvitation },
				{ valid: true },
				{ valid: true, invitation: { ...publicInvitation, maskedEmail: 'ana@example.test' } },
				{ valid: true, invitation: { ...publicInvitation, expiresAt: 'x' } },
				{ valid: true, invitation: { ...publicInvitation, roleName: '' } }
			])
				await rejectsWith(verifyInvitation({ token: TOKEN, customFetch: async () => json(bad) }), {
					code: 'INVALID_PAYLOAD'
				});
		}
	);

	await t.test(
		'acceptInvitation: nuevo usuario (name+password) y usuario con sesión (solo token)',
		async () => {
			const { fetchFn, calls } = mockFetch(() =>
				json({
					accepted: true,
					organization: { name: 'Alfa', id: ORG },
					requiresLogin: true,
					userId: USER
				})
			);
			const created = await acceptInvitation({
				token: TOKEN,
				name: '  Nora ',
				password: '  clave con espacios  ',
				customFetch: fetchFn
			});
			assert.deepEqual(created, { organizationName: 'Alfa', requiresLogin: true });
			assert.equal(calls[0].url, '/api/invitations/accept');
			assert.deepEqual(JSON.parse(calls[0].init.body), {
				token: TOKEN,
				name: 'Nora',
				password: '  clave con espacios  '
			});
			await acceptInvitation({ token: TOKEN, customFetch: fetchFn });
			assert.deepEqual(
				JSON.parse(calls[1].init.body),
				{ token: TOKEN },
				'sin flag de usuario existente'
			);
			for (const bad of [
				{ accepted: false, organization: { name: 'A' }, requiresLogin: true },
				{ accepted: true, requiresLogin: true },
				{ accepted: true, organization: { name: 'A' } }
			])
				await rejectsWith(acceptInvitation({ token: TOKEN, customFetch: async () => json(bad) }), {
					code: 'INVALID_PAYLOAD'
				});
		}
	);

	await t.test('validación previa: token, nombre y contraseña no llaman a fetch', async () => {
		const { fetchFn, calls } = mockFetch(json({}));
		for (const promise of [
			verifyInvitation({ token: 'corto', customFetch: fetchFn }),
			verifyInvitation({ customFetch: fetchFn }),
			acceptInvitation({ token: 'x', customFetch: fetchFn }),
			acceptInvitation({ token: TOKEN, name: 'A', customFetch: fetchFn }),
			acceptInvitation({ token: TOKEN, name: ' ', password: 'x'.repeat(12), customFetch: fetchFn }),
			acceptInvitation({ token: TOKEN, name: 'A', password: 'x'.repeat(11), customFetch: fetchFn }),
			acceptInvitation({ token: TOKEN, name: 'A', password: 'x'.repeat(129), customFetch: fetchFn })
		])
			await rejectsWith(promise, { status: 0, code: 'INVALID_INPUT' });
		assert.equal(calls.length, 0);
	});

	await t.test(
		'errores públicos tipados: 400/401/403/404/409/429/5xx sin eco del backend',
		async () => {
			const res = (status, code) => async () =>
				json({ error: { code, message: 'SQL: user_emails_email_lower_unique_idx' } }, status);
			const cases = [
				[400, 'INVALID_INPUT'],
				[401, 'AUTHENTICATION_REQUIRED'],
				[403, 'INVALID_ACCEPTOR'],
				[404, 'INVALID_INVITATION'],
				[409, 'ACCEPTANCE_CONFLICT'],
				[429, 'RATE_LIMITED']
			];
			for (const [status, code] of cases)
				await assert.rejects(
					acceptInvitation({ token: TOKEN, customFetch: res(status, code) }),
					(e) => {
						assert.equal(e.status, status);
						assert.equal(e.code, code);
						assert.ok(!e.message.includes('SQL'));
						return true;
					}
				);
			await rejectsWith(
				verifyInvitation({ token: TOKEN, customFetch: res(404, 'ROLE_NOT_FOUND') }),
				{
					status: 404,
					code: 'INVALID_INVITATION'
				}
			);
			await rejectsWith(verifyInvitation({ token: TOKEN, customFetch: res(429, 'OTHER') }), {
				status: 429,
				code: 'RATE_LIMITED'
			});
			await rejectsWith(
				acceptInvitation({ token: TOKEN, customFetch: res(500, 'INTERNAL_ERROR') }),
				{
					status: 500,
					code: 'SERVER_ERROR'
				}
			);
		}
	);

	await t.test('AbortError se propaga; fallo de red -> NETWORK_ERROR', async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			verifyInvitation({
				token: TOKEN,
				signal: controller.signal,
				customFetch: async () => {
					throw new DOMException('aborted', 'AbortError');
				}
			}),
			(e) => e.name === 'AbortError'
		);
		await rejectsWith(
			acceptInvitation({
				token: TOKEN,
				customFetch: async () => {
					throw new TypeError('fetch failed');
				}
			}),
			{ status: 0, code: 'NETWORK_ERROR' }
		);
	});
});

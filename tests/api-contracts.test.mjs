import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

/**
 * 5.4X-C — API contract regression. Pins the stable response shapes (exact key sets) of the key
 * endpoints and the uniform error envelope `{ error: { code, message } }`. A change that adds,
 * renames or leaks a field must update this file deliberately.
 */
const ORIGIN = 'http://localhost';
const KEY_HEX = randomBytes(32).toString('hex');
const keys = (value) => Object.keys(value).sort();
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertErrorEnvelope(res, status, code) {
	assert.equal(res.status, status, res.text);
	assert.deepEqual(keys(res.json), ['error'], res.text);
	assert.deepEqual(keys(res.json.error), ['code', 'message'], res.text);
	assert.match(res.json.error.code, /^[A-Z][A-Z_]*$/);
	assert.equal(typeof res.json.error.message, 'string');
	if (code) assert.equal(res.json.error.code, code);
	for (const leak of ['stack', 'Error:', 'SELECT', 'postgres', '.ts:'])
		assert.ok(!res.text.includes(leak), `${leak} in ${res.text}`);
}

test('SoporteFlow — Etapa 5.4X-C: contratos API', async (t) => {
	const previousKey = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
	process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = KEY_HEX;
	t.after(() => {
		if (previousKey === undefined) delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
		else process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = previousKey;
	});
	const f = await fixture(t);
	const { db, schema: s, server } = f;
	const load = (p) => server.ssrLoadModule(p);
	const { ensureOrganizationRoles } = await load('/src/lib/server/services/roles.ts');
	const { createIncidentRecord } = await load('/src/lib/server/services/incidents.ts');
	const { createNotification } = await load('/src/lib/server/services/notifications.ts');
	const { createInvitation } = await load('/src/lib/server/services/invitations.ts');
	const { PERMISSION_IDS } = await load('/src/lib/server/auth/permissions.ts');
	const { rateLimitedResponse } = await load('/src/lib/server/security/rate-limit.ts');
	const { resultLimitFailure, ResultLimitError } = await load(
		'/src/lib/server/security/bounded-read.ts'
	);
	const hooks = await load('/src/hooks.server.ts');
	const r = {
		incidents: await load('/src/routes/api/incidents/+server.ts'),
		incident: await load('/src/routes/api/incidents/[id]/+server.ts'),
		comments: await load('/src/routes/api/incidents/[id]/comments/+server.ts'),
		memberships: await load('/src/routes/api/memberships/+server.ts'),
		invitations: await load('/src/routes/api/invitations/+server.ts'),
		audit: await load('/src/routes/api/audit-events/+server.ts'),
		webhooks: await load('/src/routes/api/webhooks/+server.ts'),
		webhook: await load('/src/routes/api/webhooks/[id]/+server.ts'),
		notifications: await load('/src/routes/api/notifications/+server.ts'),
		notification: await load('/src/routes/api/notifications/[id]/+server.ts')
	};

	const [org] = await db
		.insert(s.organizations)
		.values({ name: 'Contratos', slug: 'xc-' + randomUUID(), status: 'active' })
		.returning();
	const { roles } = await ensureOrganizationRoles(db, org.id);
	const role = (code) => roles.find((x) => x.code === code);
	async function member(code) {
		const user = await createCredentialUser(f, { email: `xc-${randomUUID()}@example.test` });
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
		if (code)
			await db.insert(s.roleAssignments).values({
				organizationId: org.id,
				membershipId: membership.id,
				roleId: role(code).id,
				scopeType: 'organization'
			});
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, cookie: session.cookieHeader };
	}
	const admin = await member('organization_admin');
	const customer = await member('customer');
	const nobody = await member(null);
	async function call(
		handler,
		{ method = 'GET', path, who, params = {}, body, query = `organizationId=${org.id}` }
	) {
		const url = new URL(`${ORIGIN}${path}?${query}`);
		const headers = new Headers({ origin: ORIGIN });
		if (who) headers.set('cookie', who.cookie);
		if (body !== undefined) headers.set('content-type', 'application/json');
		const response = await handler({
			url,
			params,
			request: new Request(url, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body)
			}),
			route: { id: path }
		});
		const text = await response.text();
		return {
			status: response.status,
			headers: response.headers,
			json: text ? JSON.parse(text) : null,
			text
		};
	}

	const { incident } = await createIncidentRecord(
		db,
		{ organizationId: org.id, creatorUserId: customer.user.id },
		{ title: 'Contrato', description: 'Descripción', client: 'X', clientUserId: customer.user.id }
	);
	await createNotification(db, {
		organizationId: org.id,
		recipientUserId: admin.user.id,
		type: 'synthetic.notice',
		title: 'Aviso',
		message: 'Texto'
	});
	await db.transaction((tx) =>
		createInvitation(
			tx,
			{ organizationId: org.id, actorUserId: admin.user.id, actorPermissions: PERMISSION_IDS },
			{ email: 'contract.xc@example.com', roleId: role('customer').id }
		)
	);

	await t.test(
		'errores: sobre uniforme { error: { code, message } } en 400/401/403/404/409/413/415/422/429',
		async () => {
			assertErrorEnvelope(
				await call(r.incidents.GET, {
					path: '/api/incidents',
					who: admin,
					query: 'organizationId=bad'
				}),
				400,
				'INVALID_INPUT'
			);
			assertErrorEnvelope(
				await call(r.incidents.GET, { path: '/api/incidents', who: null }),
				401,
				'UNAUTHORIZED'
			);
			assertErrorEnvelope(
				await call(r.memberships.GET, { path: '/api/memberships', who: nobody }),
				403,
				'FORBIDDEN'
			);
			assertErrorEnvelope(
				await call(r.incident.GET, {
					path: `/api/incidents/${randomUUID()}`,
					who: admin,
					params: { id: randomUUID() }
				}),
				404,
				'INCIDENT_NOT_FOUND'
			);
			assertErrorEnvelope(
				await call(r.webhook.GET, {
					path: `/api/webhooks/${randomUUID()}`,
					who: admin,
					params: { id: randomUUID() }
				}),
				404,
				'WEBHOOK_NOT_FOUND'
			);
			assertErrorEnvelope(
				await call(r.invitations.POST, {
					method: 'POST',
					path: '/api/invitations',
					who: admin,
					body: { email: 'contract.xc@example.com', roleId: role('customer').id }
				}),
				409
			);
			assertErrorEnvelope(
				await call(r.audit.GET, {
					path: '/api/audit-events',
					who: admin,
					query: `organizationId=${org.id}&limit=0`
				}),
				400,
				'INVALID_INPUT'
			);
			const tooMany = rateLimitedResponse(3);
			assertErrorEnvelope(
				{ status: tooMany.status, text: await tooMany.clone().text(), json: await tooMany.json() },
				429,
				'RATE_LIMITED'
			);
			const limit = resultLimitFailure(new ResultLimitError());
			assertErrorEnvelope(
				{ status: limit.status, text: await limit.clone().text(), json: await limit.json() },
				422,
				'RESULT_LIMIT_EXCEEDED'
			);
			// W-C early rejections share the envelope
			for (const [headers, body, status] of [
				[{ 'content-type': 'text/plain' }, 'x', 415],
				[{ 'content-type': 'application/json' }, '{"a":"' + 'x'.repeat(70 * 1024) + '"}', 413]
			]) {
				const url = new URL(`${ORIGIN}/api/incidents`);
				const res = await hooks.handle({
					event: {
						url,
						request: new Request(url, {
							method: 'POST',
							headers: { origin: ORIGIN, ...headers },
							body
						}),
						route: { id: '/api/incidents' },
						params: {},
						locals: {},
						getClientAddress: () => '198.51.100.30'
					},
					resolve: () => Response.json({ ok: true })
				});
				const text = await res.text();
				assertErrorEnvelope({ status: res.status, text, json: JSON.parse(text) }, status);
			}
		}
	);

	await t.test(
		'incidencias: listado y detalle (staff completo, solicitante allowlist)',
		async () => {
			const staff = await call(r.incidents.GET, { path: '/api/incidents', who: admin });
			assert.equal(staff.status, 200);
			assert.deepEqual(keys(staff.json), ['incidents']);
			const item = staff.json.incidents.find((i) => i.id === incident.id);
			for (const key of [
				'id',
				'organizationId',
				'incidentNumber',
				'title',
				'status',
				'priority',
				'assignedToUserId',
				'teamId',
				'supportLevel',
				'slaOverallStatus',
				'createdAt',
				'updatedAt'
			])
				assert.ok(key in item, key);
			assert.equal('audience' in item, false, 'staff DTO sin audience');
			assert.match(item.createdAt, ISO);
			const requester = await call(r.incidents.GET, { path: '/api/incidents', who: customer });
			assert.deepEqual(keys(requester.json.incidents[0]), [
				'audience',
				'categoryId',
				'clientUserId',
				'createdAt',
				'description',
				'id',
				'incidentNumber',
				'organizationId',
				'priority',
				'siteId',
				'slaFirstResponseStatus',
				'slaOverallStatus',
				'slaResolutionStatus',
				'status',
				'title',
				'updatedAt'
			]);
			const detail = await call(r.incident.GET, {
				path: `/api/incidents/${incident.id}`,
				who: customer,
				params: { id: incident.id }
			});
			assert.deepEqual(keys(detail.json), ['incident']);
			assert.equal(detail.json.incident.audience, 'requester');
		}
	);

	await t.test(
		'paginadas por cursor: { items, nextCursor } (comentarios, notificaciones, auditoría)',
		async () => {
			const comments = await call(r.comments.GET, {
				path: `/api/incidents/${incident.id}/comments`,
				who: admin,
				params: { id: incident.id }
			});
			assert.deepEqual(keys(comments.json), ['items', 'nextCursor']);
			const notifications = await call(r.notifications.GET, {
				path: '/api/notifications',
				who: admin
			});
			assert.deepEqual(keys(notifications.json), ['items', 'nextCursor']);
			const n = notifications.json.items[0];
			for (const key of ['id', 'type', 'title', 'message', 'readAt', 'createdAt'])
				assert.ok(key in n, key);
			assert.equal('recipientUserId' in n && n.recipientUserId !== admin.user.id, false);
			const audit = await call(r.audit.GET, { path: '/api/audit-events', who: admin });
			assert.deepEqual(keys(audit.json), ['items', 'nextCursor']);
			for (const page of [comments, notifications, audit])
				assert.ok(page.json.nextCursor === null || typeof page.json.nextCursor === 'string');
		}
	);

	await t.test(
		'colecciones acotadas: { <plural>: [...] } (membresías, invitaciones, webhooks)',
		async () => {
			const memberships = await call(r.memberships.GET, { path: '/api/memberships', who: admin });
			assert.deepEqual(keys(memberships.json), ['memberships']);
			const m = memberships.json.memberships.find((x) => x.id === admin.membership.id);
			assert.deepEqual(keys(m), ['active', 'id', 'roles', 'user']);
			assert.deepEqual(keys(m.user), ['active', 'email', 'id', 'name']);
			const invitations = await call(r.invitations.GET, { path: '/api/invitations', who: admin });
			assert.deepEqual(keys(invitations.json), ['invitations']);
			const inv = invitations.json.invitations[0];
			assert.deepEqual(keys(inv), [
				'acceptedAt',
				'createdAt',
				'delivery', // 5.4X-C: outbox state (status, lastErrorCode, attemptCount)
				'email',
				'expiresAt',
				'id',
				'invitedBy',
				'role',
				'status',
				'updatedAt'
			]);
			assert.ok(!invitations.text.includes('token'), 'nunca token ni hash');
			assert.deepEqual(keys(inv.delivery), ['attemptCount', 'lastErrorCode', 'status']);
			assert.ok(!invitations.text.includes('ciphertext'), 'nunca material cifrado');
			assert.match(inv.id, UUID);
			const created = await call(r.webhooks.POST, {
				method: 'POST',
				path: '/api/webhooks',
				who: admin,
				body: {
					name: 'C',
					targetUrl: 'https://hooks.example.com/c',
					eventTypes: ['incident.created']
				}
			});
			assert.equal(created.status, 201, created.text);
			assert.deepEqual(keys(created.json), ['secret', 'webhook'], 'secreto solo en la creación');
			const webhooks = await call(r.webhooks.GET, { path: '/api/webhooks', who: admin });
			assert.deepEqual(keys(webhooks.json), ['webhooks']);
			assert.ok(!webhooks.text.includes('whsec_') && !webhooks.text.includes('ciphertext'));
			assert.deepEqual(
				keys(webhooks.json.webhooks[0]),
				keys(created.json.webhook),
				'mismo DTO en lista y creación'
			);
		}
	);
});

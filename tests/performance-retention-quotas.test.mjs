import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

/** 5.4X-D — growth indexes, keyset pagination of incidents, opt-in retention, technical quotas. */
const ORIGIN = 'http://localhost';
const DAY = 24 * 60 * 60_000;

test('SoporteFlow — Etapa 5.4X-D: rendimiento, retención y cuotas', async (t) => {
	const previousKey = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
	process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = randomBytes(32).toString('hex');
	t.after(() => {
		if (previousKey === undefined) delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
		else process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = previousKey;
		delete process.env.QUOTA_MAX_ACTIVE_WEBHOOKS;
		delete process.env.QUOTA_MAX_ACTIVE_AUTOMATION_RULES;
	});
	const f = await fixture(t);
	const { db, pg, schema: s, server } = f;
	const load = (p) => server.ssrLoadModule(p);
	const { ensureOrganizationRoles } = await load('/src/lib/server/services/roles.ts');
	const { createIncidentRecord } = await load('/src/lib/server/services/incidents.ts');
	const retention = await load('/src/lib/server/services/retention.ts');
	const quotas = await load('/src/lib/server/services/quotas.ts');
	const notifications = await load('/src/lib/server/services/notification-deliveries.ts');
	const email = await load('/src/lib/server/email/notification-email.ts');
	const invitationsService = await load('/src/lib/server/services/invitations.ts');
	const invitationOutbox = await load('/src/lib/server/services/invitation-deliveries.ts');
	const audit = await load('/src/lib/server/services/audit-events.ts');
	const { PERMISSION_IDS } = await load('/src/lib/server/auth/permissions.ts');
	const { validateServerEnvironment } = await load('/src/lib/server/config/env.ts');
	const r = {
		incidents: await load('/src/routes/api/incidents/+server.ts'),
		webhooks: await load('/src/routes/api/webhooks/+server.ts'),
		webhook: await load('/src/routes/api/webhooks/[id]/+server.ts'),
		automations: await load('/src/routes/api/automations/+server.ts')
	};

	const [org] = await db
		.insert(s.organizations)
		.values({ name: 'Crecimiento', slug: 'xd-' + randomUUID(), status: 'active' })
		.returning();
	const { roles } = await ensureOrganizationRoles(db, org.id);
	const role = (code) => roles.find((x) => x.code === code);
	async function member(code) {
		const user = await createCredentialUser(f, { email: `xd-${randomUUID()}@example.test` });
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
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
	async function call(handler, { method = 'GET', path, who, body, query = '' }) {
		const url = new URL(`${ORIGIN}${path}?organizationId=${org.id}${query}`);
		const headers = new Headers({ origin: ORIGIN, cookie: who.cookie });
		if (body !== undefined) headers.set('content-type', 'application/json');
		const response = await handler({
			url,
			params: {},
			request: new Request(url, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body)
			}),
			route: { id: path }
		});
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null, text };
	}

	await t.test('índices: 0028 solo crea índices ligados a consultas reales', async () => {
		const { rows } = await pg.query(
			`SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('incidents_org_assignee_created_idx','incidents_org_client_created_idx','memberships_user_idx','audit_events_org_created_idx','invitation_deliveries_due_idx') ORDER BY indexname`
		);
		const idx = Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));
		assert.match(
			idx.incidents_org_assignee_created_idx,
			/\(organization_id, assigned_to_user_id, created_at\)/
		);
		assert.match(
			idx.incidents_org_client_created_idx,
			/\(organization_id, client_user_id, created_at\)/
		);
		assert.match(idx.memberships_user_idx, /\(user_id\)/);
		assert.ok(idx.audit_events_org_created_idx && idx.invitation_deliveries_due_idx);
		const sql = fs.readFileSync('drizzle/migrations/0028_growth_indexes.sql', 'utf8');
		assert.doesNotMatch(sql, /DROP|ALTER|DELETE|UPDATE|TRUNCATE/i, 'aditiva');
	});

	await t.test(
		'paginación keyset de incidencias: estable, sin solapes, mismo alcance',
		async () => {
			for (let i = 0; i < 7; i++)
				await createIncidentRecord(
					db,
					{ organizationId: org.id, creatorUserId: customer.user.id },
					{
						title: `Página ${i}`,
						description: 'x',
						client: 'x',
						clientUserId: i < 3 ? customer.user.id : null
					}
				);
			const legacy = await call(r.incidents.GET, { path: '/api/incidents', who: admin });
			assert.deepEqual(Object.keys(legacy.json), ['incidents'], 'contrato legado intacto');
			const seen = [];
			const sizes = [];
			let cursor = null;
			do {
				const page = await call(r.incidents.GET, {
					path: '/api/incidents',
					who: admin,
					query: `&limit=3${cursor ? `&cursor=${cursor}` : ''}`
				});
				assert.equal(page.status, 200, page.text);
				assert.deepEqual(Object.keys(page.json).sort(), ['incidents', 'nextCursor']);
				sizes.push(page.json.incidents.length);
				seen.push(...page.json.incidents);
				cursor = page.json.nextCursor;
			} while (cursor);
			assert.deepEqual(sizes, [3, 3, 1]);
			assert.deepEqual(
				seen.map((i) => i.id),
				legacy.json.incidents.map((i) => i.id),
				'mismo orden que la lista acotada'
			);
			// requester scope applies to pages too, with the requester projection
			const mine = await call(r.incidents.GET, {
				path: '/api/incidents',
				who: customer,
				query: '&limit=100'
			});
			assert.equal(mine.json.incidents.length, 3);
			assert.ok(
				mine.json.incidents.every(
					(i) => i.audience === 'requester' && i.clientUserId === customer.user.id
				)
			);
			for (const bad of [
				'&limit=0',
				'&limit=101',
				'&limit=x',
				'&cursor=%%',
				'&cursor=abc',
				`&cursor=${Buffer.from('["2026-01-01T00:00:00.000000Z",-1]').toString('base64url')}`
			])
				assert.equal(
					(await call(r.incidents.GET, { path: '/api/incidents', who: admin, query: bad })).status,
					400,
					bad
				);
		}
	);

	await t.test(
		'retención: opt-in, solo terminales antiguas, por lotes; nunca audit_events',
		async () => {
			const recipient = admin.user.id;
			const queue = (title) =>
				notifications.createNotificationDelivery(db, {
					organizationId: org.id,
					recipientUserId: recipient,
					channel: 'email',
					eventType: 'incident.assigned',
					title,
					message: 'm'
				});
			const oldSent = await Promise.all([1, 2, 3, 4, 5].map((i) => queue(`sent ${i}`)));
			await notifications.processDueNotificationDeliveries(db, {
				sender: new email.MemoryNotificationEmailSender(),
				now: new Date(Date.now() + 1000),
				limit: 100
			});
			const active = await queue('pendiente antigua');
			const recent = await queue('reciente');
			await notifications.processDueNotificationDeliveries(db, {
				sender: new email.MemoryNotificationEmailSender(),
				now: new Date(Date.now() + 2000),
				limit: 100
			});
			const old = new Date(Date.now() - 40 * DAY);
			await db
				.update(s.notificationDeliveries)
				.set({ updatedAt: old })
				.where(inArray(s.notificationDeliveries.id, [...oldSent.map((d) => d.id), active.id]));
			// the "active" row goes back to pending (in flight) but is old
			await db
				.update(s.notificationDeliveries)
				.set({
					status: 'pending',
					sentAt: null,
					nextAttemptAt: new Date(),
					providerMessageId: null
				})
				.where(eq(s.notificationDeliveries.id, active.id));
			// invitation outbox terminal row (no token material) + an audit event, both old
			const issued = await invitationsService.createInvitation(
				db,
				{
					organizationId: org.id,
					actorUserId: admin.user.id,
					actorPermissions: PERMISSION_IDS
				},
				{ email: `ret-${randomUUID()}@example.test`, roleId: role('customer').id }
			);
			await invitationsService.revokeInvitation(db, org.id, issued.invitation.id);
			await db
				.update(s.invitationDeliveries)
				.set({ updatedAt: old })
				.where(eq(s.invitationDeliveries.invitationId, issued.invitation.id));
			await audit.appendAuditEvent(db, {
				organizationId: org.id,
				actor: { type: 'system' },
				action: 'retention.probe',
				entityType: 'test'
			});
			const auditBefore = (await db.select().from(s.auditEvents)).length;

			// no policy -> nothing deleted
			const none = await retention.runRetention(db, { policy: {} });
			assert.deepEqual(none.deleted, {});
			// policy of 30 days, batches of 2, budget of 2 batches -> truncated, then completes
			const first = await retention.runRetention(db, {
				policy: { notificationDeliveries: 30, invitationDeliveries: 30, automationExecutions: 30 },
				batchSize: 2,
				maxBatches: 2
			});
			assert.equal(first.deleted.notificationDeliveries, 4);
			assert.ok(first.truncated.includes('notificationDeliveries'));
			const second = await retention.runRetention(db, {
				policy: { notificationDeliveries: 30 },
				batchSize: 2
			});
			assert.equal(second.deleted.notificationDeliveries, 1);
			const remaining = await db.select().from(s.notificationDeliveries);
			const ids = remaining.map((d) => d.id).sort();
			assert.deepEqual(ids, [active.id, recent.id].sort(), 'en vuelo y recientes intactas');
			assert.equal(
				(
					await db
						.select()
						.from(s.invitationDeliveries)
						.where(eq(s.invitationDeliveries.invitationId, issued.invitation.id))
				).length,
				0
			);
			assert.equal(
				(await db.select().from(s.auditEvents)).length,
				auditBefore,
				'audit trail nunca purgado'
			);
			// idempotent
			assert.equal(
				(await retention.runRetention(db, { policy: { notificationDeliveries: 30 } })).deleted
					.notificationDeliveries,
				0
			);
			// config
			assert.deepEqual(
				retention.retentionPolicyFromEnv({ RETENTION_WEBHOOK_DELIVERIES_DAYS: '90' }),
				{ webhookDeliveries: 90 }
			);
			for (const bad of ['0', '3651', '-1', 'x', '1.5'])
				assert.throws(() => retention.parseRetentionDays(bad), bad);
			await assert.rejects(retention.runRetention(db, { policy: { auditEvents: 1 } }));
			await assert.rejects(retention.runRetention(db, { policy: { notificationDeliveries: 0 } }));
			void invitationOutbox;
		}
	);

	await t.test('cuotas técnicas: webhooks activos y reglas, configurables a la baja', async () => {
		process.env.QUOTA_MAX_ACTIVE_WEBHOOKS = '2';
		const create = (name) =>
			call(r.webhooks.POST, {
				method: 'POST',
				path: '/api/webhooks',
				who: admin,
				body: { name, targetUrl: 'https://hooks.example.com/q', eventTypes: ['incident.created'] }
			});
		const a = await create('A');
		const b = await create('B');
		assert.equal(a.status, 201);
		assert.equal(b.status, 201);
		const c = await create('C');
		assert.equal(c.status, 409, c.text);
		assert.equal(c.json.error.code, 'WEBHOOK_LIMIT_REACHED');
		// deactivating frees a slot; reactivating beyond the limit is refused
		const deactivate = await r.webhook.DELETE({
			url: new URL(`${ORIGIN}/api/webhooks/${a.json.webhook.id}?organizationId=${org.id}`),
			params: { id: a.json.webhook.id },
			request: new Request(`${ORIGIN}/api/webhooks/${a.json.webhook.id}?organizationId=${org.id}`, {
				method: 'DELETE',
				headers: { origin: ORIGIN, cookie: admin.cookie }
			})
		});
		assert.equal(deactivate.status, 204);
		assert.equal((await create('D')).status, 201);
		const reactivate = await r.webhook.PATCH({
			url: new URL(`${ORIGIN}/api/webhooks/${a.json.webhook.id}?organizationId=${org.id}`),
			params: { id: a.json.webhook.id },
			request: new Request(`${ORIGIN}/api/webhooks/${a.json.webhook.id}?organizationId=${org.id}`, {
				method: 'PATCH',
				headers: { origin: ORIGIN, cookie: admin.cookie, 'content-type': 'application/json' },
				body: JSON.stringify({ active: true })
			})
		});
		assert.equal(reactivate.status, 409);
		// automation rules: same framework (default ceiling 100 kept)
		assert.equal(quotas.quotaLimit('activeAutomationRules', {}), 100);
		process.env.QUOTA_MAX_ACTIVE_AUTOMATION_RULES = '1';
		const rule = (name) =>
			call(r.automations.POST, {
				method: 'POST',
				path: '/api/automations',
				who: admin,
				body: {
					name,
					eventType: 'incident.created',
					conditions: { all: [] },
					actions: [{ type: 'incident.add_internal_note', text: 'x' }]
				}
			});
		assert.equal((await rule('R1')).status, 201);
		const second = await rule('R2');
		assert.equal(second.status, 409);
		assert.equal(second.json.error.code, 'RULE_LIMIT_REACHED');
		// operators may lower, never raise above the technical ceiling
		assert.throws(() => quotas.quotaLimit('activeWebhooks', { QUOTA_MAX_ACTIVE_WEBHOOKS: '1000' }));
		assert.throws(() => quotas.quotaLimit('activeWebhooks', { QUOTA_MAX_ACTIVE_WEBHOOKS: '0' }));
		assert.throws(
			() =>
				validateServerEnvironment(
					{ QUOTA_MAX_ACTIVE_WEBHOOKS: '1000', RETENTION_WEBHOOK_DELIVERIES_DAYS: 'forever' },
					{ development: true }
				),
			(e) =>
				e.issues
					.map((i) => i.variable)
					.sort()
					.join() === 'QUOTA_MAX_ACTIVE_WEBHOOKS,RETENTION_WEBHOOK_DELIVERIES_DAYS'
		);
	});
});

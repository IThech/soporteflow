import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

/**
 * 5.4X-A — administrative audit trail: transactional append, tenant isolation, RBAC, pagination,
 * filters, immutability and secret hygiene. Synthetic data only.
 */
const ORIGIN = 'http://localhost';
const KEY_HEX = randomBytes(32).toString('hex');

test('SoporteFlow — Etapa 5.4X-A: audit trail administrativo', async (t) => {
	const previousKey = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
	process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = KEY_HEX;
	t.after(() => {
		if (previousKey === undefined) delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
		else process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = previousKey;
	});
	const f = await fixture(t);
	const { db, schema: s, server } = f;
	const load = (p) => server.ssrLoadModule(p);
	const audit = await load('/src/lib/server/services/audit-events.ts');
	const logging = await load('/src/lib/server/logging/logger.ts');
	const { ensureOrganizationRoles } = await load('/src/lib/server/services/roles.ts');
	const { createInvitation } = await load('/src/lib/server/services/invitations.ts');
	const { acceptInvitation } = await load('/src/lib/server/services/invitation-acceptance.ts');
	const { PERMISSION_IDS } = await load('/src/lib/server/auth/permissions.ts');
	const r = {
		audit: await load('/src/routes/api/audit-events/+server.ts'),
		categories: await load('/src/routes/api/categories/+server.ts'),
		category: await load('/src/routes/api/categories/[id]/+server.ts'),
		sites: await load('/src/routes/api/sites/+server.ts'),
		site: await load('/src/routes/api/sites/[id]/+server.ts'),
		roles: await load('/src/routes/api/roles/+server.ts'),
		role: await load('/src/routes/api/roles/[id]/+server.ts'),
		grant: await load('/src/routes/api/memberships/[id]/roles/+server.ts'),
		revoke: await load('/src/routes/api/memberships/[id]/roles/[roleId]/+server.ts'),
		sla: await load('/src/routes/api/sla-policies/+server.ts'),
		slaOne: await load('/src/routes/api/sla-policies/[id]/+server.ts'),
		webhooks: await load('/src/routes/api/webhooks/+server.ts'),
		webhook: await load('/src/routes/api/webhooks/[id]/+server.ts'),
		rotate: await load('/src/routes/api/webhooks/[id]/rotate-secret/+server.ts'),
		automations: await load('/src/routes/api/automations/+server.ts'),
		automation: await load('/src/routes/api/automations/[id]/+server.ts'),
		invitation: await load('/src/routes/api/invitations/[id]/+server.ts')
	};

	async function organization(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'xa-' + randomUUID(), status: 'active' })
			.returning();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		const byCode = (code) => roles.find((x) => x.code === code);
		return {
			org,
			admin: byCode('organization_admin'),
			tech: byCode('technician'),
			customer: byCode('customer')
		};
	}
	async function member(o, roles = []) {
		const user = await createCredentialUser(f, { email: `xa-${randomUUID()}@example.test` });
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: o.org.id, userId: user.id })
			.returning();
		const assignments = [];
		for (const role of roles) {
			const [a] = await db
				.insert(s.roleAssignments)
				.values({
					organizationId: o.org.id,
					membershipId: membership.id,
					roleId: role.id,
					scopeType: 'organization'
				})
				.returning();
			assignments.push(a);
		}
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, assignments, cookie: session.cookieHeader };
	}
	async function call(
		handler,
		{ method = 'GET', path: p, who, org, params = {}, body, query = '' }
	) {
		const url = new URL(`${ORIGIN}${p}?organizationId=${org.id}${query}`);
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
			route: { id: p }
		});
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null, text };
	}
	const events = async (org) =>
		db.select().from(s.auditEvents).where(eq(s.auditEvents.organizationId, org.id));
	const list = (who, org, query = '') =>
		call(r.audit.GET, { path: '/api/audit-events', who, org, query });

	const A = await organization('A');
	const B = await organization('B');
	const adminA = await member(A, [A.admin]);
	const techA = await member(A, [A.tech]);
	const custA = await member(A, [A.customer]);
	const adminB = await member(B, [B.admin]);

	// =========================================================================
	await t.test(
		'1. mutación administrativa correcta -> evento con actor, tenant y requestId',
		async () => {
			const requestId = randomUUID();
			const created = await logging.runWithLogContext({ requestId }, () =>
				call(r.categories.POST, {
					method: 'POST',
					path: '/api/categories',
					who: adminA,
					org: A.org,
					body: { name: 'Redes' }
				})
			);
			assert.equal(created.status, 201, created.text);
			const [event] = (await events(A.org)).filter((e) => e.entityId === created.json.category.id);
			assert.equal(event.action, 'category.created');
			assert.equal(event.entityType, 'category');
			assert.equal(event.organizationId, A.org.id);
			assert.equal(event.actorType, 'user');
			assert.equal(event.actorUserId, adminA.user.id);
			assert.equal(event.requestId, requestId, 'correlación W-E');
			assert.deepEqual(event.metadata, {});
			// update + deactivate
			const id = created.json.category.id;
			const upd = await call(r.category.PATCH, {
				method: 'PATCH',
				path: `/api/categories/${id}`,
				who: adminA,
				org: A.org,
				params: { id },
				body: { action: 'update', name: 'Redes y VPN' }
			});
			assert.equal(upd.status, 200, upd.text);
			const off = await call(r.category.PATCH, {
				method: 'PATCH',
				path: `/api/categories/${id}`,
				who: adminA,
				org: A.org,
				params: { id },
				body: { action: 'set_active', active: false }
			});
			assert.equal(off.status, 200);
			const actions = (await events(A.org)).filter((e) => e.entityId === id).map((e) => e.action);
			assert.deepEqual(actions.sort(), [
				'category.created',
				'category.deactivated',
				'category.updated'
			]);
			const updated = (await events(A.org)).find((e) => e.action === 'category.updated');
			assert.deepEqual(updated.metadata, { fields: ['name'] });
		}
	);

	await t.test('2. fallo o rollback -> ningún evento de éxito', async () => {
		const before = (await events(A.org)).length;
		// domain failure (duplicate name) inside the transaction
		const dup = await call(r.categories.POST, {
			method: 'POST',
			path: '/api/categories',
			who: adminA,
			org: A.org,
			body: { name: 'Redes y VPN' }
		});
		assert.equal(dup.status, 409, dup.text);
		// actor without capability (pre-check) and a demoted actor (in-transaction re-validation)
		assert.equal(
			(
				await call(r.categories.POST, {
					method: 'POST',
					path: '/api/categories',
					who: techA,
					org: A.org,
					body: { name: 'X' }
				})
			).status,
			403
		);
		// explicit rollback after the event was appended on the same transaction
		await assert.rejects(
			db.transaction(async (tx) => {
				await audit.auditByUser(tx, A.org.id, adminA.user.id, {
					action: 'category.created',
					entityType: 'category',
					entityId: randomUUID()
				});
				throw new Error('rollback');
			}),
			/rollback/
		);
		assert.equal((await events(A.org)).length, before, 'sin eventos huérfanos');
	});

	await t.test(
		'3-4. actor de sistema/automatización; combinaciones inválidas rechazadas',
		async () => {
			const system = await audit.appendAuditEvent(db, {
				organizationId: A.org.id,
				actor: { type: 'system' },
				action: 'retention.purged',
				entityType: 'notification_delivery',
				metadata: { deleted: 12 }
			});
			const [row] = await db.select().from(s.auditEvents).where(eq(s.auditEvents.id, system.id));
			assert.equal(row.actorType, 'system');
			assert.equal(row.actorUserId, null);
			for (const bad of [
				{ actor: { type: 'user' } },
				{ actor: { type: 'root' } },
				{ action: 'Category.Created' },
				{ action: 'nodot' },
				{ entityType: 'Bad-Type' },
				{ entityId: 'not-a-uuid' },
				{ metadata: { nested: { a: 1 } } },
				{ metadata: { huge: Array.from({ length: 60 }, () => 'x') } }
			])
				await assert.rejects(
					audit.appendAuditEvent(db, {
						organizationId: A.org.id,
						actor: { type: 'automation' },
						action: 'automation_rule.fired',
						entityType: 'automation_rule',
						...bad
					}),
					(e) => e.code === 'INVALID_INPUT',
					JSON.stringify(bad)
				);
			// DB CHECK backs the service rule
			await assert.rejects(
				db.insert(s.auditEvents).values({
					organizationId: A.org.id,
					actorType: 'user',
					actorUserId: null,
					action: 'x.y',
					entityType: 'x'
				})
			);
		}
	);

	await t.test(
		'5. secretos nunca almacenados (webhook, invitación, metadata sensible)',
		async () => {
			const hook = await call(r.webhooks.POST, {
				method: 'POST',
				path: '/api/webhooks',
				who: adminA,
				org: A.org,
				body: {
					name: 'Receptor',
					targetUrl: 'https://hooks.example.com/in?api_key=receiver-key-xa',
					eventTypes: ['incident.created']
				}
			});
			assert.equal(hook.status, 201, hook.text);
			const hookId = hook.json.webhook.id;
			const rotated = await call(r.rotate.POST, {
				method: 'POST',
				path: `/api/webhooks/${hookId}/rotate-secret`,
				who: adminA,
				org: A.org,
				params: { id: hookId }
			});
			assert.equal(rotated.status, 200, rotated.text);
			const issued = await db.transaction((tx) =>
				createInvitation(
					tx,
					{
						organizationId: A.org.id,
						actorUserId: adminA.user.id,
						actorPermissions: PERMISSION_IDS
					},
					{ email: 'invitee.xa@example.com', roleId: A.customer.id }
				)
			);
			const stored = JSON.stringify(await events(A.org));
			for (const secret of [
				hook.json.secret,
				rotated.json.secret,
				'receiver-key-xa',
				'hooks.example.com',
				issued.delivery.token
			])
				assert.ok(!stored.includes(secret), `no almacena ${String(secret).slice(0, 10)}`);
			const actions = (await events(A.org)).map((e) => e.action);
			assert.ok(actions.includes('webhook.created') && actions.includes('webhook.secret_rotated'));
			// sanitizer drops credential-named keys and redacts embedded credentials in values
			assert.deepEqual(
				audit.sanitizeAuditMetadata({
					password: 'p',
					apiKey: 'k',
					sessionToken: 't',
					note: 'postgresql://u:pw-xa@db/x',
					roleId: A.admin.id
				}),
				{ note: 'postgresql://[REDACTED]@db/x', roleId: A.admin.id }
			);
		}
	);

	await t.test('6-7. lectura: permiso audit:view, sin cruce de tenant', async () => {
		assert.equal((await list(adminA, A.org)).status, 200);
		for (const who of [techA, custA]) assert.equal((await list(who, A.org)).status, 403);
		assert.equal((await list(null, A.org)).status, 401);
		assert.equal((await list(adminA, B.org)).status, 403, 'org sin membresía');
		// B's events never appear in A's listing
		await call(r.categories.POST, {
			method: 'POST',
			path: '/api/categories',
			who: adminB,
			org: B.org,
			body: { name: 'Solo B' }
		});
		const a = await list(adminA, A.org, '&limit=100');
		assert.ok(a.json.items.length > 0);
		assert.ok(!a.text.includes(B.org.id) && !a.text.includes(adminB.user.id));
		const b = await list(adminB, B.org, '&limit=100');
		assert.deepEqual(
			b.json.items.map((i) => i.action),
			['category.created']
		);
		// DTO shape (stable contract)
		assert.deepEqual(Object.keys(a.json).sort(), ['items', 'nextCursor']);
		assert.deepEqual(Object.keys(a.json.items[0]).sort(), [
			'action',
			'actorType',
			'actorUserId',
			'createdAt',
			'entityId',
			'entityType',
			'id',
			'metadata',
			'requestId',
			'targetUserId'
		]);
		// only administrators receive audit:view by default
		const perms = await db
			.select()
			.from(s.rolePermissions)
			.where(eq(s.rolePermissions.permissionId, 'audit:view'));
		assert.deepEqual(perms.map((p) => p.roleId).sort(), [A.admin.id, B.admin.id].sort());
	});

	await t.test('8. paginación estable, descendente y sin solapes', async () => {
		const O = await organization('Paginación');
		const admin = await member(O, [O.admin]);
		for (let i = 0; i < 7; i++)
			await audit.appendAuditEvent(db, {
				organizationId: O.org.id,
				actor: { type: 'system' },
				action: 'test.paged',
				entityType: 'test',
				metadata: { i }
			});
		const seen = [];
		let cursor = null;
		const sizes = [];
		do {
			const page = await list(admin, O.org, `&limit=3${cursor ? `&cursor=${cursor}` : ''}`);
			assert.equal(page.status, 200, page.text);
			sizes.push(page.json.items.length);
			seen.push(...page.json.items);
			cursor = page.json.nextCursor;
		} while (cursor);
		assert.deepEqual(sizes, [3, 3, 1]);
		assert.equal(new Set(seen.map((e) => e.id)).size, 7);
		const times = seen.map((e) => e.createdAt);
		assert.deepEqual(times, [...times].sort().reverse(), 'más reciente primero');
		for (const bad of [
			'&limit=0',
			'&limit=101',
			'&cursor=%%%',
			'&cursor=abc',
			'&limit=1&limit=2',
			'&unknown=1'
		])
			assert.equal((await list(admin, O.org, bad)).status, 400, bad);
	});

	await t.test('9. filtros: actor, acción, tipo, entidad y rango de fechas', async () => {
		const byAction = await list(adminA, A.org, '&action=category.created&limit=100');
		assert.ok(byAction.json.items.every((e) => e.action === 'category.created'));
		const cat = byAction.json.items[0];
		const byEntity = await list(
			adminA,
			A.org,
			`&entityType=category&entityId=${cat.entityId}&limit=100`
		);
		assert.deepEqual(byEntity.json.items.map((e) => e.action).sort(), [
			'category.created',
			'category.deactivated',
			'category.updated'
		]);
		const byActor = await list(adminA, A.org, `&actorUserId=${adminA.user.id}&limit=100`);
		assert.ok(
			byActor.json.items.length > 0 &&
				byActor.json.items.every((e) => e.actorUserId === adminA.user.id)
		);
		const future = new Date(Date.now() + 3600_000).toISOString();
		assert.equal(
			(await list(adminA, A.org, `&from=${encodeURIComponent(future)}`)).json.items.length,
			0
		);
		const past = new Date(Date.now() - 3600_000).toISOString();
		const ranged = await list(
			adminA,
			A.org,
			`&from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}&limit=100`
		);
		assert.equal(
			ranged.json.items.length,
			byActor.json.items.length +
				(await events(A.org)).filter((e) => e.actorUserId !== adminA.user.id).length
		);
		for (const bad of [
			'&action=DROP TABLE',
			'&entityId=nope',
			'&actorUserId=1',
			'&from=yesterday',
			`&from=${encodeURIComponent(future)}&to=${encodeURIComponent(past)}`
		])
			assert.equal((await list(adminA, A.org, bad)).status, 400, bad);
	});

	await t.test('10. inmutable: sin rutas de escritura; UPDATE rechazado por la BD', async () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
			assert.equal(r.audit[method], undefined, method);
		const [one] = await events(A.org);
		await assert.rejects(
			db
				.update(s.auditEvents)
				.set({ action: 'category.forged' })
				.where(eq(s.auditEvents.id, one.id)),
			(e) => /append-only/.test(String(e?.cause?.message ?? e?.message))
		);
		const service = fs.readFileSync('src/lib/server/services/audit-events.ts', 'utf8');
		assert.ok(!/\.update\(auditEvents\)|\.delete\(auditEvents\)/.test(service));
		assert.ok(!fs.existsSync(path.join('src/routes/api/audit-events/[id]')));
	});

	await t.test('11. mutaciones concurrentes -> eventos distintos', async () => {
		const results = await Promise.all(
			Array.from({ length: 6 }, (_, i) =>
				call(r.sites.POST, {
					method: 'POST',
					path: '/api/sites',
					who: adminA,
					org: A.org,
					body: { name: `Sede ${i}` }
				})
			)
		);
		assert.ok(results.every((res) => res.status === 201));
		const siteEvents = (await events(A.org)).filter((e) => e.action === 'site.created');
		assert.equal(siteEvents.length, 6);
		assert.equal(new Set(siteEvents.map((e) => e.entityId)).size, 6);
		assert.equal(new Set(siteEvents.map((e) => e.id)).size, 6);
	});

	await t.test('12. cobertura de dominios administrativos', async () => {
		// roles: create/update; memberships: grant/revoke
		const role = await call(r.roles.POST, {
			method: 'POST',
			path: '/api/roles',
			who: adminA,
			org: A.org,
			body: { name: 'Auditor', code: 'auditor_xa', permissions: ['sites:view'] }
		});
		assert.equal(role.status, 201, role.text);
		const roleId = role.json.role.id;
		const upd = await call(r.role.PATCH, {
			method: 'PATCH',
			path: `/api/roles/${roleId}`,
			who: adminA,
			org: A.org,
			params: { id: roleId },
			body: { permissions: ['sites:view', 'categories:view'] }
		});
		assert.equal(upd.status, 200, upd.text);
		const grant = await call(r.grant.POST, {
			method: 'POST',
			path: `/api/memberships/${techA.membership.id}/roles`,
			who: adminA,
			org: A.org,
			params: { id: techA.membership.id },
			body: { roleId }
		});
		assert.equal(grant.status, 201, grant.text);
		const again = await call(r.grant.POST, {
			method: 'POST',
			path: `/api/memberships/${techA.membership.id}/roles`,
			who: adminA,
			org: A.org,
			params: { id: techA.membership.id },
			body: { roleId }
		});
		assert.equal(again.status, 200, 'idempotente');
		const revoke = await call(r.revoke.DELETE, {
			method: 'DELETE',
			path: `/api/memberships/${techA.membership.id}/roles/${roleId}`,
			who: adminA,
			org: A.org,
			params: { id: techA.membership.id, roleId }
		});
		assert.equal(revoke.status, 204, revoke.text);
		// SLA
		const sla = await call(r.sla.POST, {
			method: 'POST',
			path: '/api/sla-policies',
			who: adminA,
			org: A.org,
			body: { code: 'std_xa', name: 'Estándar', firstResponseMinutes: 60, resolutionMinutes: 480 }
		});
		assert.equal(sla.status, 201, sla.text);
		const slaUpd = await call(r.slaOne.PATCH, {
			method: 'PATCH',
			path: `/api/sla-policies/${sla.json.slaPolicy.id}`,
			who: adminA,
			org: A.org,
			params: { id: sla.json.slaPolicy.id },
			body: { active: false }
		});
		assert.equal(slaUpd.status, 200, slaUpd.text);
		// automations
		const rule = await call(r.automations.POST, {
			method: 'POST',
			path: '/api/automations',
			who: adminA,
			org: A.org,
			body: {
				name: 'Nota',
				eventType: 'incident.created',
				conditions: { all: [] },
				actions: [{ type: 'incident.add_internal_note', text: 'Auto' }]
			}
		});
		assert.equal(rule.status, 201, rule.text);
		const disabled = await call(r.automation.DELETE, {
			method: 'DELETE',
			path: `/api/automations/${rule.json.rule.id}`,
			who: adminA,
			org: A.org,
			params: { id: rule.json.rule.id }
		});
		assert.equal(disabled.status, 204, disabled.text);
		// invitation revoke + accept (acceptor is the actor)
		const pending = await db.transaction((tx) =>
			createInvitation(
				tx,
				{ organizationId: A.org.id, actorUserId: adminA.user.id, actorPermissions: PERMISSION_IDS },
				{ email: 'revoked.xa@example.com', roleId: A.customer.id }
			)
		);
		const revoked = await call(r.invitation.DELETE, {
			method: 'DELETE',
			path: `/api/invitations/${pending.invitation.id}`,
			who: adminA,
			org: A.org,
			params: { id: pending.invitation.id }
		});
		assert.equal(revoked.status, 204, revoked.text);
		const accepted = await db.transaction((tx) =>
			createInvitation(
				tx,
				{ organizationId: A.org.id, actorUserId: adminA.user.id, actorPermissions: PERMISSION_IDS },
				{ email: 'accepted.xa@example.com', roleId: A.customer.id }
			)
		);
		const password = 'Very-Long-Password-xa-1';
		await acceptInvitation(db, {
			token: accepted.delivery.token,
			principalUserId: null,
			name: 'Invitada',
			password
		});
		const all = await events(A.org);
		const acceptedEvent = all.find((e) => e.action === 'invitation.accepted');
		assert.equal(acceptedEvent.entityId, accepted.invitation.id);
		assert.equal(
			acceptedEvent.actorUserId,
			acceptedEvent.targetUserId,
			'actor = identidad que acepta'
		);
		assert.equal(acceptedEvent.metadata.identityCreated, true);
		assert.equal(acceptedEvent.metadata.roleId, A.customer.id);
		const actions = new Set(all.map((e) => e.action));
		for (const expected of [
			'role.created',
			'role.updated',
			'membership.role_granted',
			'membership.role_revoked',
			'sla_policy.created',
			'sla_policy.updated',
			'automation_rule.created',
			'automation_rule.deactivated',
			'invitation.revoked',
			'invitation.accepted',
			'webhook.created',
			'webhook.secret_rotated'
		])
			assert.ok(actions.has(expected), expected);
		assert.equal(
			all.filter((e) => e.action === 'membership.role_granted').length,
			1,
			'regrant idempotente sin evento'
		);
		const roleUpdated = all.find((e) => e.action === 'role.updated');
		assert.deepEqual(roleUpdated.metadata.permissionIds.sort(), ['categories:view', 'sites:view']);
		const stored = JSON.stringify(all);
		for (const leak of [
			password,
			accepted.delivery.token,
			'accepted.xa@example.com',
			'revoked.xa@example.com'
		])
			assert.ok(!stored.includes(leak), leak);
	});
});

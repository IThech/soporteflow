import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
	fixture,
	createCredentialUser,
	createSession,
	directory
} from './helpers/auth-fixture.mjs';

test('5.4V-C: automation rules, actions and system actor', async (t) => {
	const f = await fixture(t),
		{ db, schema: s, server, pg } = f;
	const load = (n) => server.ssrLoadModule('/src/lib/server/services/' + n + '.ts');
	const rules = await load('automation-rules'),
		proc = await load('automation-processor'),
		fan = await load('automation-rule-fanout');
	const domain = await load('incidents'),
		messages = await load('incident-messages'),
		events = await load('automation-events');
	const authority = await load('automation-authority'),
		roles = await load('roles');
	const dsl = await server.ssrLoadModule('/src/lib/automation/rules.ts');
	const collection = await server.ssrLoadModule('/src/routes/api/automations/+server.ts');
	const item = await server.ssrLoadModule('/src/routes/api/automations/[id]/+server.ts');
	const history = await server.ssrLoadModule(
		'/src/routes/api/automations/[id]/executions/+server.ts'
	);
	async function org(name) {
		const [o] = await db
			.insert(s.organizations)
			.values({ name, slug: randomUUID(), status: 'active' })
			.returning();
		return { ...o, roles: (await roles.ensureOrganizationRoles(db, o.id)).roles };
	}
	async function member(o, code) {
		const { user } = await createCredentialUser(f, { email: randomUUID() + '@example.test' });
		const [m] = await db
			.insert(s.memberships)
			.values({ organizationId: o.id, userId: user.id, active: true })
			.returning();
		await db.insert(s.roleAssignments).values({
			organizationId: o.id,
			membershipId: m.id,
			roleId: o.roles.find((r) => r.code === code).id,
			scopeType: 'organization'
		});
		return {
			...user,
			cookie: (await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) }))
				.cookieHeader,
			membership: m
		};
	}
	const A = await org('A'),
		B = await org('B'),
		admin = await member(A, 'organization_admin'),
		tech = await member(A, 'technician'),
		customer = await member(A, 'customer'),
		outsider = await member(B, 'organization_admin');
	const human = { organizationId: A.id, actorUserId: admin.id };
	const create = async (input = {}) =>
		(
			await domain.createIncidentRecord(
				db,
				{ organizationId: A.id, creatorUserId: admin.id },
				{ title: 'Synthetic', description: 'Synthetic incident', client: 'Synthetic', ...input }
			)
		).incident;
	const rule = (actions, eventType = 'incident.created', conditions = { all: [] }, extra = {}) =>
		rules.createAutomationRule(db, A.id, admin.id, {
			name: 'Synthetic rule',
			eventType,
			conditions,
			actions,
			...extra
		});
	const note = { type: 'incident.add_internal_note', text: 'Automated literal' };
	const row = async (i) => (await db.select().from(s.incidents).where(eq(s.incidents.id, i.id)))[0];
	const exec = async (r) =>
		db.select().from(s.automationExecutions).where(eq(s.automationExecutions.ruleId, r.id));
	const run = () => proc.processAutomationExecutions(db, { limit: 100 });
	async function scenario(name, fn) {
		await t.test(name, async () => {
			await db.update(s.automationRules).set({ active: false });
			await run();
			await fn();
		});
	}
	async function call(
		handler,
		{ method = 'GET', who = admin, org = A.id, id, body, query, origin = 'http://localhost' } = {}
	) {
		const url = new URL('http://localhost/api/automations?' + (query ?? 'organizationId=' + org));
		const headers = new Headers({ origin });
		if (who) headers.set('cookie', who.cookie);
		if (body !== undefined) headers.set('content-type', 'application/json');
		const res = await handler({
			url,
			params: { id },
			request: new Request(url, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body)
			})
		});
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : null };
	}
	await scenario('CRUD HTTP, soft disable and execution history', async () => {
		const input = {
			name: 'HTTP',
			eventType: 'incident.created',
			conditions: { all: [] },
			actions: [note]
		};
		const r = await call(collection.POST, { method: 'POST', body: input });
		assert.equal(r.status, 201);
		const id = r.json.rule.id;
		assert.equal((await call(item.GET, { id })).status, 200);
		assert.equal((await call(collection.GET)).json.items.length > 0, true);
		assert.equal(
			(await call(item.PATCH, { id, method: 'PATCH', body: { name: 'Edited' } })).json.rule.name,
			'Edited'
		);
		assert.equal((await call(history.GET, { id })).status, 200);
		assert.equal((await call(item.DELETE, { id, method: 'DELETE' })).status, 204);
		assert.equal((await rules.getAutomationRule(db, A.id, id)).active, false);
	});
	for (const [label, who, status] of [
		['anonymous', null, 401],
		['technician', tech, 403],
		['customer', customer, 403],
		['foreign admin', outsider, 403]
	])
		await scenario('RBAC ' + label, async () =>
			assert.equal((await call(collection.GET, { who })).status, status)
		);
	await scenario('BOLA foreign rule and history', async () => {
		const r = await rules.createAutomationRule(db, B.id, outsider.id, {
			name: 'B',
			eventType: 'incident.created',
			conditions: { all: [] },
			actions: [note]
		});
		for (const handler of [item.GET, history.GET])
			assert.equal((await call(handler, { id: r.id })).status, 404);
		assert.equal(
			(await call(item.PATCH, { id: r.id, method: 'PATCH', body: { active: false } })).status,
			404
		);
	});
	await scenario('HTTP rejects spoofed system flags and wrong origin', async () => {
		for (const field of [
			'system',
			'actorType',
			'actorUserId',
			'organizationId',
			'executionId',
			'transaction'
		])
			assert.equal(
				(
					await call(collection.POST, {
						method: 'POST',
						body: {
							name: 'x',
							eventType: 'incident.created',
							conditions: { all: [] },
							actions: [note],
							[field]: 'system'
						}
					})
				).status,
				400
			);
		assert.equal(
			(await call(collection.POST, { method: 'POST', origin: 'http://evil.test', body: {} }))
				.status,
			403
		);
		assert.equal(
			(await call(collection.GET, { query: 'organizationId=' + A.id + '&organizationId=' + A.id }))
				.status,
			400
		);
		assert.equal(
			(await call(collection.POST, { method: 'POST', body: { name: 'x'.repeat(17000) } })).status,
			400
		);
	});
	await scenario('DSL strongly typed fields, operators and limits', async () => {
		const base = {
			name: 'x',
			eventType: 'incident.created',
			conditions: { all: [] },
			actions: [note]
		};
		for (const conditions of [
			{ all: [{ field: 'payload.secret', operator: 'eq', value: 'x' }] },
			{ all: [{ field: 'payload.priority', operator: 'eq', value: 'critical' }] },
			{ all: [{ field: 'payload.incidentNumber', operator: 'eq', value: '1' }] },
			{ all: [{ field: 'payload.priority', operator: 'contains', value: 'high' }] },
			{ all: [{ field: 'payload.priority', operator: 'is_null' }] },
			{ all: [{ field: 'payload.siteId', operator: 'is_null', value: null }] },
			{ all: [], any: [] },
			{ all: Array(21).fill({ field: 'payload.priority', operator: 'eq', value: 'high' }) }
		])
			assert.throws(() => dsl.parseRule({ ...base, conditions }));
		for (const actions of [
			[{ type: 'http', url: 'https://example.test' }],
			[{ ...note, system: true }],
			[{ ...note, text: '{{payload}}' }],
			[{ ...note, text: '<b>x</b>' }],
			[{ ...note, text: 'x'.repeat(1001) }],
			Array(11).fill(note)
		])
			assert.throws(() => dsl.parseRule({ ...base, actions }));
		for (const operator of ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null']) {
			const nullable = operator.startsWith('is_'),
				field = nullable ? 'payload.siteId' : 'payload.priority';
			const value = operator.includes('in') ? ['high'] : 'high';
			const c = dsl.validateConditions('incident.created', {
				all: [{ field, operator, ...(nullable ? {} : { value }) }]
			});
			const expected = ['eq', 'in', 'is_null'].includes(operator);
			assert.equal(
				dsl.evaluateConditions('incident.created', c, { priority: 'high', siteId: null }),
				expected
			);
		}
		const c = dsl.validateConditions('incident.created', {
			all: [{ field: 'payload.incidentNumber', operator: 'neq', value: 1 }]
		});
		assert.equal(dsl.evaluateConditions('incident.created', c, { incidentNumber: '2' }), false);
	});
	await scenario('fanout future-only, matching, snapshots and unique rule-event', async () => {
		const old = await create(),
			r = await rule([note]);
		assert.equal((await exec(r)).length, 0);
		const i = await create();
		const [e] = await exec(r);
		assert.ok(e);
		const event = (
			await events.listAutomationEventsInternal(db, { organizationId: A.id, aggregateId: i.id })
		).events[0];
		await db.transaction((tx) => fan.fanoutAutomationExecutions(tx, event));
		assert.equal((await exec(r)).length, 1);
		await rules.updateAutomationRule(db, A.id, r.id, { actions: [{ ...note, text: 'Changed' }] });
		await run();
		const notes = await messages.listInternalNotes(
			db,
			{ organizationId: A.id, incidentId: i.id },
			new URLSearchParams()
		);
		assert.equal(notes.items[0].body, note.text);
		assert.equal(notes.items[0].author.name, 'Sistema');
		assert.equal(
			(await db.select().from(s.incidentMessages).where(eq(s.incidentMessages.incidentId, old.id)))
				.length,
			0
		);
	});
	await scenario('inactive, event mismatch and condition mismatch', async () => {
		const inactive = await rule([note], 'incident.created', { all: [] }, { active: false });
		const other = await rule([note], 'incident.reopened');
		const r = await rule([note], 'incident.created', {
			all: [{ field: 'payload.priority', operator: 'eq', value: 'urgent' }]
		});
		await create({ priority: 'low' });
		assert.equal((await exec(inactive)).length, 0);
		assert.equal((await exec(other)).length, 0);
		await run();
		assert.equal((await exec(r))[0].errorCode, 'CONDITION_NOT_MATCHED');
	});
	await scenario('disable pending prevents all actions', async () => {
		const r = await rule([note]);
		await create();
		await rules.updateAutomationRule(db, A.id, r.id, { active: false });
		await run();
		assert.equal((await exec(r))[0].errorCode, 'RULE_INACTIVE');
	});
	for (const [action, field, value] of [
		[{ type: 'incident.set_priority', priority: 'high' }, 'priority', 'high'],
		[{ type: 'incident.set_support_level', supportLevel: 'N3' }, 'supportLevel', 'N3'],
		[{ type: 'incident.set_status', status: 'pending' }, 'status', 'pending'],
		[{ type: 'incident.assign_user', userId: tech.id }, 'assignedToUserId', tech.id]
	])
		await scenario(action.type + ' canonical action + no-op', async () => {
			const r = await rule([action, action]);
			const i = await create();
			await run();
			assert.equal((await row(i))[field], value);
			assert.equal((await exec(r))[0].status, 'succeeded');
			const historyRows = await db
				.select()
				.from(s.incidentHistory)
				.where(eq(s.incidentHistory.incidentId, i.id));
			assert.ok(historyRows.some((h) => h.actorType === 'system' && h.actorUserId === null));
			const generated = (
				await db.select().from(s.automationEvents).where(eq(s.automationEvents.aggregateId, i.id))
			).filter((e) => e.automationDepth === 1);
			const executionId = (await exec(r))[0].id;
			assert.ok(
				historyRows
					.filter((h) => h.actorType === 'system')
					.every(
						(h) =>
							h.payload.automation?.executionId === executionId &&
							h.payload.automation?.ruleId === r.id
					)
			);
			assert.ok(generated.length);
			assert.ok(
				generated.every(
					(e) =>
						e.actorUserId === null && e.causationEventId && e.automationExecutionId === executionId
				)
			);
			const total = historyRows.length;
			await run();
			assert.equal(
				(await db.select().from(s.incidentHistory).where(eq(s.incidentHistory.incidentId, i.id)))
					.length,
				total
			);
			if (field === 'assignedToUserId') {
				const ns = await db
					.select()
					.from(s.notifications)
					.where(eq(s.notifications.recipientUserId, tech.id));
				assert.ok(ns.some((n) => n.payload?.incidentId === i.id));
			}
		});
	await scenario('internal system note, human note and public author constraints', async () => {
		const r = await rule([note]);
		const i = await create();
		await run();
		const [m] = await db
			.select()
			.from(s.incidentMessages)
			.where(eq(s.incidentMessages.incidentId, i.id));
		assert.equal(m.authorType, 'system');
		assert.equal(m.authorUserId, null);
		const noteHistory = await db
			.select()
			.from(s.incidentHistory)
			.where(eq(s.incidentHistory.incidentId, i.id));
		assert.ok(
			noteHistory.some(
				(h) =>
					h.eventType === 'internal_note_added' &&
					h.actorType === 'system' &&
					h.payload.automation?.ruleId === r.id
			)
		);
		await messages.createInternalNote(db, { ...human, incidentId: i.id }, 'Human note');
		await messages.createPublicComment(db, { ...human, incidentId: i.id }, 'Human comment');
		for (const data of [
			{ authorType: 'user', authorUserId: null, visibility: 'public' },
			{ authorType: 'system', authorUserId: null, visibility: 'public' },
			{ authorType: 'system', authorUserId: admin.id, visibility: 'internal' }
		])
			await assert.rejects(
				db
					.insert(s.incidentMessages)
					.values({ organizationId: A.id, incidentId: i.id, body: 'Forbidden', ...data })
			);
		await assert.rejects(
			messages.createPublicComment(
				db,
				{ organizationId: A.id, incidentId: i.id, actorUserId: null },
				'Forbidden'
			)
		);
		assert.equal((await exec(r))[0].status, 'succeeded');
	});
	await scenario(
		'system capability cannot be forged or reused on another transaction',
		async () => {
			const i = await create();
			await assert.rejects(
				domain.updateIncidentRecord(
					db,
					{ organizationId: A.id, actorUserId: null, system: true, actorType: 'system' },
					i.id,
					{ priority: 'urgent' }
				)
			);
			await assert.rejects(
				db.transaction((tx) =>
					authority.withAutomationAuthority(tx, randomUUID(), randomUUID(), () => Promise.resolve())
				)
			);
			const r = await rule([note]);
			await create();
			const [e] = await exec(r),
				token = randomUUID();
			await db
				.update(s.automationExecutions)
				.set({ status: 'processing', leaseToken: token, leaseUntil: new Date(Date.now() + 300000) })
				.where(eq(s.automationExecutions.id, e.id));
			await assert.rejects(
				authority.withAutomationAuthority(db, e.id, token, () => Promise.resolve())
			);
			await db.transaction((tx) =>
				authority.withAutomationAuthority(tx, e.id, token, async () => {
					assert.ok(authority.automationAuthority(tx, A.id));
					assert.equal(authority.automationAuthority(db, A.id), undefined);
					assert.equal(authority.automationAuthority(tx, B.id), undefined);
					await assert.rejects(
						domain.updateIncidentRecord(db, { organizationId: A.id, actorUserId: null }, i.id, {
							priority: 'urgent'
						})
					);
				})
			);
			assert.equal(authority.automationAuthority(db, A.id), undefined);
			await db
				.update(s.automationExecutions)
				.set({ status: 'failed', leaseToken: null, leaseUntil: null })
				.where(eq(s.automationExecutions.id, e.id));
		}
	);
	await scenario('multi-action failure rolls back incident, history, events and note', async () => {
		const r = await rule([
			{ type: 'incident.set_priority', priority: 'urgent' },
			note,
			{ type: 'incident.assign_user', userId: outsider.id }
		]);
		const i = await create({ priority: 'low' });
		await run();
		assert.equal((await row(i)).priority, 'low');
		assert.equal((await exec(r))[0].status, 'failed');
		assert.equal((await exec(r))[0].actionsCompleted, 0);
		assert.equal(
			(await db.select().from(s.incidentMessages).where(eq(s.incidentMessages.incidentId, i.id)))
				.length,
			0
		);
		assert.equal(
			(await db.select().from(s.automationEvents).where(eq(s.automationEvents.aggregateId, i.id)))
				.length,
			1
		);
	});
	await scenario('same priority self trigger stops at no-op', async () => {
		const r = await rule(
			[{ type: 'incident.set_priority', priority: 'high' }],
			'incident.priority_changed',
			{ all: [{ field: 'payload.newPriority', operator: 'eq', value: 'high' }] }
		);
		const i = await create({ priority: 'low' });
		await domain.updateIncidentRecord(db, human, i.id, { priority: 'high' });
		await run();
		await run();
		assert.equal((await exec(r)).length, 1);
		assert.equal((await exec(r))[0].status, 'succeeded');
		assert.equal(
			(await db.select().from(s.automationEvents).where(eq(s.automationEvents.aggregateId, i.id)))
				.length,
			2
		);
	});
	await scenario('oscillating rules stop at depth five with observable skip', async () => {
		await rule([{ type: 'incident.set_priority', priority: 'high' }]);
		const high = await rule(
			[{ type: 'incident.set_priority', priority: 'low' }],
			'incident.priority_changed',
			{ all: [{ field: 'payload.newPriority', operator: 'eq', value: 'high' }] }
		);
		const low = await rule(
			[{ type: 'incident.set_priority', priority: 'high' }],
			'incident.priority_changed',
			{ all: [{ field: 'payload.newPriority', operator: 'eq', value: 'low' }] }
		);
		const i = await create({ priority: 'low' });
		for (let n = 0; n < 9; n++) await run();
		const facts = await db
			.select()
			.from(s.automationEvents)
			.where(eq(s.automationEvents.aggregateId, i.id));
		assert.equal(Math.max(...facts.map((e) => e.automationDepth)), 5);
		assert.equal(facts.length, 6);
		assert.ok(
			[...(await exec(high)), ...(await exec(low))].some((e) => e.errorCode === 'MAX_DEPTH_REACHED')
		);
	});
	await scenario('disabled organization skips pending execution', async () => {
		const r = await rule([note]);
		await create();
		await db
			.update(s.organizations)
			.set({ status: 'suspended' })
			.where(eq(s.organizations.id, A.id));
		await run();
		assert.equal((await exec(r))[0].errorCode, 'TARGET_INACTIVE');
		await db.update(s.organizations).set({ status: 'active' }).where(eq(s.organizations.id, A.id));
	});
	await scenario('action-generated events keep webhook fanout and stable body v1', async () => {
		const subs = await load('webhook-subscriptions');
		const w = await subs.createWebhookSubscription(
			db,
			{ organizationId: A.id, actorUserId: admin.id },
			{
				name: 'Synthetic',
				targetUrl: 'https://example.test/hook',
				eventTypes: ['incident.priority_changed']
			},
			{ encryptionKey: randomBytes(32) }
		);
		await rule([{ type: 'incident.set_priority', priority: 'urgent' }]);
		const i = await create({ priority: 'low' });
		await run();
		const facts = await db
			.select()
			.from(s.automationEvents)
			.where(eq(s.automationEvents.aggregateId, i.id));
		const event = facts.find((e) => e.eventType === 'incident.priority_changed');
		const ds = await db
			.select()
			.from(s.webhookDeliveries)
			.where(eq(s.webhookDeliveries.eventId, event.id));
		assert.equal(ds.length, 1);
		assert.equal(JSON.parse(ds[0].body).schemaVersion, 1);
		assert.equal(Object.hasOwn(JSON.parse(ds[0].body), 'automationDepth'), false);
		assert.ok(w);
	});
	await scenario('failed intent insertion rolls back original human mutation', async () => {
		await rule([note]);
		const before = (await db.select().from(s.incidents)).length;
		await pg.exec(
			"CREATE FUNCTION vc_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$ LANGUAGE plpgsql; CREATE TRIGGER vc_fail BEFORE INSERT ON automation_executions FOR EACH ROW EXECUTE FUNCTION vc_fail();"
		);
		try {
			await assert.rejects(create());
			assert.equal((await db.select().from(s.incidents)).length, before);
		} finally {
			await pg.exec('DROP TRIGGER vc_fail ON automation_executions; DROP FUNCTION vc_fail();');
		}
	});
	await scenario('active rule cap 100, inactive permitted and activation checked', async () => {
		for (let n = 0; n < 100; n++) await rule([note]);
		await assert.rejects(rule([note]), (e) => e.code === 'RULE_LIMIT_REACHED');
		const r = await rule([note], 'incident.created', { all: [] }, { active: false });
		await assert.rejects(
			rules.updateAutomationRule(db, A.id, r.id, { active: true }),
			(e) => e.code === 'RULE_LIMIT_REACHED'
		);
	});
	await scenario('retention terminal only and processor bounded', async () => {
		await assert.rejects(proc.processAutomationExecutions(db, { limit: 101 }));
		const r = await rule([note]);
		await create();
		const [e] = await exec(r);
		await rules.deleteOldAutomationExecutions(db, new Date(Date.now() + 1000), 100);
		assert.equal((await exec(r)).length, 1);
		await run();
		await rules.deleteOldAutomationExecutions(db, new Date(Date.now() + 1000), 100);
		assert.equal((await exec(r)).length, 0);
		assert.ok(e);
	});

	await scenario('team/site/category actions validate same-tenant targets and no-op', async () => {
		for (const [table, type, key, column] of [
			[s.teams, 'incident.assign_team', 'teamId', 'teamId'],
			[s.sites, 'incident.set_site', 'siteId', 'siteId'],
			[s.categories, 'incident.set_category', 'categoryId', 'categoryId']
		]) {
			const [target] = await db
				.insert(table)
				.values({ organizationId: A.id, name: 'Synthetic ' + randomUUID(), active: true })
				.returning();
			const [foreign] = await db
				.insert(table)
				.values({ organizationId: B.id, name: 'Foreign ' + randomUUID(), active: true })
				.returning();
			for (const value of [target.id, foreign.id, randomUUID()]) {
				await db.update(s.automationRules).set({ active: false });
				const r = await rule([
					{ type, [key]: value },
					{ type, [key]: value }
				]);
				const i = await create();
				await run();
				assert.equal((await exec(r))[0].status, value === target.id ? 'succeeded' : 'failed');
				assert.equal((await row(i))[column], value === target.id ? target.id : null);
			}
			await db.update(table).set({ active: false }).where(eq(table.id, target.id));
			await db.update(s.automationRules).set({ active: false });
			const r = await rule([{ type, [key]: target.id }]);
			await create();
			await run();
			assert.equal((await exec(r))[0].status, 'failed');
		}
	});
	await scenario(
		'automated resolution preserves first resolution, SLA and requester notification',
		async () => {
			const sla = await load('sla-policies');
			const policy = await sla.createSlaPolicy(db, A.id, {
				code: 'synthetic_sla',
				name: 'Synthetic SLA',
				firstResponseMinutes: 10,
				resolutionMinutes: 60,
				active: true
			});
			const policyId = policy.id ?? policy.policy?.id;
			assert.ok(policyId);
			await rule([{ type: 'incident.set_status', status: 'resolved' }]);
			const i = await create({ slaPolicyId: policyId, clientUserId: customer.id });
			await run();
			const resolved = await row(i);
			assert.ok(resolved.firstResolvedAt);
			assert.equal(resolved.slaPolicyId, policyId);
			const hs = await db
				.select()
				.from(s.incidentHistory)
				.where(eq(s.incidentHistory.incidentId, i.id));
			assert.ok(hs.some((h) => h.eventType === 'sla_resolution_met' && h.actorType === 'system'));
			const ns = await db
				.select()
				.from(s.notifications)
				.where(eq(s.notifications.recipientUserId, customer.id));
			assert.ok(ns.some((n) => n.payload?.incidentId === i.id));
			await domain.updateIncidentRecord(db, human, i.id, { status: 'open' });
			await domain.updateIncidentRecord(db, human, i.id, { status: 'resolved' });
			assert.equal((await row(i)).firstResolvedAt.getTime(), resolved.firstResolvedAt.getTime());
		}
	);
	await scenario(
		'rule creator inactive does not impersonate creator or disable system authority',
		async () => {
			const r = await rule([note]);
			const i = await create();
			await db.update(s.users).set({ active: false }).where(eq(s.users.id, admin.id));
			try {
				await run();
				assert.equal((await exec(r))[0].status, 'succeeded');
				const [n] = await db
					.select()
					.from(s.incidentMessages)
					.where(eq(s.incidentMessages.incidentId, i.id));
				assert.equal(n.authorUserId, null);
			} finally {
				await db.update(s.users).set({ active: true }).where(eq(s.users.id, admin.id));
			}
		}
	);
	await scenario(
		'expired lease recovery, live lease exclusion and duplicate processor',
		async () => {
			const r = await rule([note]);
			const i = await create();
			const [e] = await exec(r);
			const now = new Date();
			await db
				.update(s.automationExecutions)
				.set({
					status: 'processing',
					attemptCount: 1,
					leaseToken: randomUUID(),
					leaseUntil: new Date(now.getTime() + 1000)
				})
				.where(eq(s.automationExecutions.id, e.id));
			assert.equal((await proc.processAutomationExecutions(db, { now })).claimed, 0);
			await proc.processAutomationExecutions(db, { now: new Date(now.getTime() + 2000) });
			await run();
			assert.equal((await exec(r))[0].attemptCount, 2);
			assert.equal(
				(await db.select().from(s.incidentMessages).where(eq(s.incidentMessages.incidentId, i.id)))
					.length,
				1
			);
			const r2 = await rule([note]);
			await create();
			const pending = (await exec(r2))[0];
			await db
				.update(s.automationExecutions)
				.set({
					status: 'processing',
					attemptCount: 3,
					leaseToken: randomUUID(),
					leaseUntil: new Date(0)
				})
				.where(eq(s.automationExecutions.id, pending.id));
			await run();
			assert.equal((await exec(r2))[0].errorCode, 'CONCURRENCY_CONFLICT');
		}
	);
	await scenario('unknown schema version skips without evaluation', async () => {
		const r = await rule([note]);
		const i = await create();
		await run();
		const id = randomUUID();
		await db.insert(s.automationEvents).values({
			id,
			organizationId: A.id,
			eventType: 'incident.created',
			schemaVersion: 2,
			aggregateType: 'incident',
			aggregateId: i.id,
			actorUserId: null,
			payload: { incidentId: i.id, incidentNumber: i.incidentNumber },
			occurredAt: new Date()
		});
		const event = await events.getAutomationEventInternal(db, { organizationId: A.id, id });
		await db.transaction((tx) => fan.fanoutAutomationExecutions(tx, event));
		await run();
		assert.ok((await exec(r)).some((e) => e.errorCode === 'UNSUPPORTED_EVENT_VERSION'));
	});
	await scenario('note self-loop is bounded, not executed inline', async () => {
		const r = await rule([note], 'incident.internal_note_added');
		const i = await create();
		await messages.createInternalNote(db, { ...human, incidentId: i.id }, 'Human starts chain');
		assert.equal((await exec(r)).length, 1);
		assert.equal((await exec(r))[0].status, 'pending');
		for (let n = 0; n < 7; n++) await run();
		assert.equal((await exec(r)).length, 6);
		assert.equal((await exec(r)).filter((e) => e.status === 'succeeded').length, 5);
	});
	await scenario('execution snapshot and rules pagination stay tenant scoped', async () => {
		const r = await rule([note]);
		for (let n = 0; n < 3; n++) await create();
		let page = await rules.listAutomationExecutions(db, A.id, r.id, new URLSearchParams('limit=2'));
		assert.equal(page.items.length, 2);
		assert.ok(page.nextCursor);
		const next = await rules.listAutomationExecutions(
			db,
			A.id,
			r.id,
			new URLSearchParams('limit=2&cursor=' + page.nextCursor)
		);
		assert.equal(next.items.length, 1);
		assert.equal(new Set([...page.items, ...next.items].map((x) => x.id)).size, 3);
		await assert.rejects(
			rules.listAutomationExecutions(db, B.id, r.id, new URLSearchParams()),
			(e) => e.code === 'RULE_NOT_FOUND'
		);
		assert.equal(Object.hasOwn(page.items[0], 'actions'), false);
		assert.equal(Object.hasOwn(page.items[0], 'leaseToken'), false);
	});

	await scenario(
		'migration 0025 defaults, indexes, tenant FKs and Drizzle idempotence',
		async () => {
			const pg2 = new PGlite();
			try {
				const db2 = drizzle(pg2);
				await migrate(db2, { migrationsFolder: directory });
				await migrate(db2, { migrationsFolder: directory });
				assert.equal(
					(await pg2.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0].n,
					26
				);
				const columns = (
					await pg2.query(
						"SELECT column_name FROM information_schema.columns WHERE table_name='incident_messages'"
					)
				).rows.map((r) => r.column_name);
				assert.ok(columns.includes('author_type'));
				const indices = (
					await pg2.query(
						"SELECT indexname FROM pg_indexes WHERE tablename IN ('automation_rules','automation_executions')"
					)
				).rows.map((r) => r.indexname);
				for (const name of [
					'automation_rules_fanout_idx',
					'automation_executions_rule_event_unique',
					'automation_executions_due_idx',
					'automation_executions_history_idx'
				])
					assert.ok(indices.includes(name));
			} finally {
				await pg2.close();
			}
			const r = await rule([note]);
			const i = await create(),
				[e] = await exec(r);
			await assert.rejects(
				db.insert(s.automationExecutions).values({
					organizationId: B.id,
					ruleId: r.id,
					sourceEventId: e.sourceEventId,
					ruleName: 'x',
					conditions: { all: [] },
					actions: [note],
					sortOrder: 0
				})
			);
			const [event] = await db
				.select()
				.from(s.automationEvents)
				.where(eq(s.automationEvents.id, e.sourceEventId));
			assert.equal(event.automationDepth, 0);
			assert.equal(event.causationEventId, null);
			const humanNote = await messages.createInternalNote(
				db,
				{ ...human, incidentId: i.id },
				'Human default'
			);
			const [m] = await db
				.select()
				.from(s.incidentMessages)
				.where(eq(s.incidentMessages.id, humanNote.id));
			assert.equal(m.authorType, 'user');
		}
	);

	await scenario('HTTP incident notes reject all client-controlled actor fields', async () => {
		const route = await server.ssrLoadModule(
			'/src/routes/api/incidents/[id]/internal-notes/+server.ts'
		);
		const i = await create();
		for (const field of ['system', 'actorType', 'actorUserId', 'authorType', 'authorUserId']) {
			const res = await call(route.POST, {
				method: 'POST',
				id: i.id,
				body: { body: 'Synthetic note', [field]: 'system' }
			});
			assert.equal(res.status, 400);
		}
		assert.equal(
			(await db.select().from(s.incidentMessages).where(eq(s.incidentMessages.incidentId, i.id)))
				.length,
			0
		);
	});
	await scenario('inactive and missing assignees fail without domain changes', async () => {
		for (const target of [tech.id, randomUUID()]) {
			await db.update(s.automationRules).set({ active: false });
			const r = await rule([{ type: 'incident.assign_user', userId: target }]);
			const i = await create();
			await db.update(s.users).set({ active: false }).where(eq(s.users.id, tech.id));
			try {
				await run();
				assert.equal((await exec(r))[0].status, 'failed');
				assert.equal((await row(i)).assignedToUserId, null);
			} finally {
				await db.update(s.users).set({ active: true }).where(eq(s.users.id, tech.id));
			}
		}
	});
	await scenario('fanout failure rolls back human assignment and public comment', async () => {
		const i = await create();
		await rule([note], 'incident.assigned');
		await rule([note], 'incident.public_comment_added');
		await pg.exec(
			"CREATE FUNCTION vc_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$ LANGUAGE plpgsql; CREATE TRIGGER vc_fail BEFORE INSERT ON automation_executions FOR EACH ROW EXECUTE FUNCTION vc_fail();"
		);
		try {
			await assert.rejects(
				domain.assignIncidentRecord(db, human, i.id, { assignedToUserId: tech.id })
			);
			assert.equal((await row(i)).assignedToUserId, null);
			await assert.rejects(
				messages.createPublicComment(db, { ...human, incidentId: i.id }, 'Synthetic')
			);
			assert.equal(
				(await db.select().from(s.incidentMessages).where(eq(s.incidentMessages.incidentId, i.id)))
					.length,
				0
			);
			assert.equal(
				(await db.select().from(s.automationEvents).where(eq(s.automationEvents.aggregateId, i.id)))
					.length,
				1
			);
		} finally {
			await pg.exec('DROP TRIGGER vc_fail ON automation_executions; DROP FUNCTION vc_fail();');
		}
	});

	await scenario('metadata immutable and no external execution mechanisms', async () => {
		const [e] = await db.select().from(s.automationEvents).limit(1);
		await assert.rejects(
			pg.query(
				'UPDATE automation_events SET automation_depth=1,causation_event_id=$1,automation_execution_id=$2,actor_user_id=NULL WHERE id=$1',
				[e.id, randomUUID()]
			)
		);
		const code = fs.readFileSync('src/lib/server/services/automation-processor.ts', 'utf8');
		assert.doesNotMatch(code, /fetch\s*\(|node:child_process|setInterval\s*\(|eval\s*\(/);
		assert.equal(fs.existsSync('src/routes/api/automations/[id]/run/+server.ts'), false);
	});
});

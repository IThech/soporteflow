import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
	fixture,
	createCredentialUser,
	createSession,
	grantPermission
} from './helpers/auth-fixture.mjs';
import { getIncident, createIncident } from '../src/lib/api/incidents.ts';

test('5.4M-A operational history: isolated PGlite', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;
	const historyService = await server.ssrLoadModule('/src/lib/server/services/incident-history.ts');
	const { listIncidentHistory, projectHistoryItem, SAFE_HISTORY_TYPES } = historyService;
	const service = await server.ssrLoadModule('/src/lib/server/services/incidents.ts');
	const { GET } = await server.ssrLoadModule('/src/routes/api/incidents/[id]/history/+server.ts');
	const { GET: detail } = await server.ssrLoadModule('/src/routes/api/incidents/[id]/+server.ts');
	const { POST } = await server.ssrLoadModule('/src/routes/api/incidents/+server.ts');
	const [org, otherOrg] = await db
		.insert(s.organizations)
		.values([
			{ name: 'History A', slug: randomUUID(), status: 'active' },
			{ name: 'History B', slug: randomUUID(), status: 'active' }
		])
		.returning();
	async function actor(organization, permissions) {
		const user = await createCredentialUser(f);
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: organization.id, userId: user.id })
			.returning();
		for (const permissionId of permissions)
			await grantPermission(f, {
				organizationId: organization.id,
				membershipId: membership.id,
				permissionId
			});
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, session };
	}
	const manager = await actor(org, ['incidents:view_all', 'incidents:create']);
	const own = await actor(org, ['incidents:view_own']);
	const none = await actor(org, []);
	const outsider = await actor(otherOrg, ['incidents:view_all']);
	const input = {
		title: 'Synthetic incident',
		description: 'Synthetic description',
		client: 'Synthetic client'
	};
	async function ticket(organization = org, creator = manager) {
		return (
			await service.createIncidentRecord(
				db,
				{ organizationId: organization.id, creatorUserId: creator.user.id },
				input
			)
		).incident;
	}
	const incident = await ticket();
	const other = await ticket(otherOrg, outsider);
	async function request({
		id = incident.id,
		organizationId = org.id,
		cookie = manager.session.cookieHeader,
		query = '',
		handler = GET,
		method = 'GET',
		body
	} = {}) {
		const url = new URL(
			'http://localhost/api/incidents/' + id + '/history?organizationId=' + organizationId + query
		);
		const headers = new Headers();
		if (cookie) headers.set('cookie', cookie);
		if (body) headers.set('content-type', 'application/json');
		const response = await handler({
			url,
			params: { id },
			request: new Request(url, {
				method,
				headers,
				...(body ? { body: JSON.stringify(body) } : {})
			})
		});
		return { status: response.status, body: await response.json() };
	}
	// 5.4O-D: site_changed pasa a ser visible (solo changes.siteChanged); el resto sigue oculto.
	const blocked = [
		'escalated',
		'resolution_accepted',
		'resolution_rejected',
		'reclassified',
		'priority_override_applied',
		'priority_override_modified',
		'priority_override_removed',
		'internal_note_added'
	];
	const secret = 'DO-NOT-EXPOSE-HISTORY-SECRET';
	const privateId = randomUUID();
	async function event(eventType, payload = {}, extra = {}, target = incident) {
		return (
			await db
				.insert(s.incidentHistory)
				.values({
					incidentId: target.id,
					organizationId: target.organizationId,
					eventType,
					actorType: 'user',
					actorUserId: manager.user.id,
					payload,
					comment: secret,
					reason: secret,
					...extra
				})
				.returning()
		)[0];
	}
	const payloads = {
		created: { title: secret, clientUserId: privateId },
		status_changed: { oldStatus: 'open', newStatus: 'pending' },
		resolved: { oldStatus: 'pending', newStatus: 'resolved' },
		closed: { oldStatus: 'resolved', newStatus: 'closed' },
		reopened: { oldStatus: 'closed', newStatus: 'open' },
		priority_changed: { oldPriority: 'low', newPriority: 'high' },
		support_level_changed: { previousSupportLevel: 'N1', newSupportLevel: 'N3' },
		assigned: { newTeamId: privateId, newAssigneeUserId: privateId },
		reassigned: { previousTeamId: privateId, newAssigneeUserId: privateId },
		site_changed: { fromSiteId: privateId, toSiteId: privateId }
	};
	for (const type of SAFE_HISTORY_TYPES)
		await event(type, { ...payloads[type], malicious: secret, siteId: privateId });
	for (const type of blocked) await event(type, { secret, actorUserId: privateId });

	for (const [name, options, expected] of [
		['401 without session', { cookie: '' }, 401],
		['401 without session precedes query validation', { cookie: '', query: '&limit=0' }, 401],
		['403 without permission', { cookie: none.session.cookieHeader }, 403],
		[
			'403 without permission precedes query validation',
			{ cookie: none.session.cookieHeader, query: '&limit=0' },
			403
		],
		['403 view_own is insufficient', { cookie: own.session.cookieHeader }, 403],
		['403 unauthorized organization', { organizationId: otherOrg.id }, 403],
		['404 cross tenant incident', { id: other.id }, 404],
		['404 missing incident', { id: randomUUID() }, 404],
		['400 invalid incident UUID', { id: 'invalid' }, 400],
		['400 invalid organization UUID', { organizationId: 'invalid' }, 400]
	])
		await t.test(name, async () => assert.equal((await request(options)).status, expected));

	await t.test(
		'POST and detail omit history; audit stays persisted; frontend parsers accept both',
		async () => {
			const created = await request({
				handler: POST,
				method: 'POST',
				body: { organizationId: org.id, ...input }
			});
			assert.equal(created.status, 201);
			assert.deepEqual(Object.keys(created.body), ['incident']);
			const rows = await db
				.select()
				.from(s.incidentHistory)
				.where(eq(s.incidentHistory.incidentId, created.body.incident.id));
			assert.equal(rows.length, 1);
			assert.equal(rows[0].eventType, 'created');
			const before = await db
				.select()
				.from(s.incidentHistory)
				.where(eq(s.incidentHistory.incidentId, incident.id));
			const read = await request({ handler: detail });
			assert.equal(read.status, 200);
			assert.deepEqual(Object.keys(read.body), ['incident']);
			assert.deepEqual(
				await db
					.select()
					.from(s.incidentHistory)
					.where(eq(s.incidentHistory.incidentId, incident.id)),
				before
			);
			const readParsed = await getIncident(org.id, incident.id, {
				customFetch: async () => Response.json(read.body)
			});
			assert.equal(readParsed.id, incident.id);
			const createParsed = await createIncident(org.id, input, {
				customFetch: async () => Response.json(created.body, { status: 201 })
			});
			assert.equal(createParsed.id, created.body.incident.id);
		}
	);
	await t.test('detail service never queries incident_history', async () => {
		const guarded = new Proxy(db, {
			get(target, key) {
				if (key === 'select')
					return (...args) => {
						const query = target.select(...args);
						const from = query.from.bind(query);
						query.from = (table) => {
							assert.notEqual(table, s.incidentHistory);
							return from(table);
						};
						return query;
					};
				const value = target[key];
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const value = await service.getIncidentById(guarded, { organizationId: org.id }, incident.id);
		assert.deepEqual(Object.keys(value), ['incident']);
	});
	await t.test('whitelist cerrada: exactamente estos tipos seguros', () => {
		assert.deepEqual(
			[...SAFE_HISTORY_TYPES].sort(),
			[
				'assigned',
				'closed',
				'created',
				'priority_changed',
				'reassigned',
				'reopened',
				'resolved',
				'site_changed',
				'status_changed',
				'support_level_changed'
			].sort()
		);
		assert.ok(!SAFE_HISTORY_TYPES.includes('internal_note_added'));
	});
	for (const type of SAFE_HISTORY_TYPES)
		await t.test('visible ' + type, async () => {
			const result = await request();
			assert.equal(result.status, 200);
			assert.ok(result.body.items.some((item) => item.type === type));
		});
	for (const type of blocked)
		await t.test('excluded ' + type, async () => {
			assert.ok(!(await request()).body.items.some((item) => item.type === type));
		});
	await t.test('internal_note_added with secrets is invisible (type, actor, content)', async () => {
		const noteSecret = 'INTERNAL-NOTE-' + randomUUID();
		const note = await event(
			'internal_note_added',
			{ note: noteSecret, authorUserId: privateId },
			{ comment: noteSecret, reason: noteSecret }
		);
		const systemNote = await event(
			'internal_note_added',
			{ note: noteSecret },
			{ actorType: 'system', actorUserId: null, comment: noteSecret, reason: noteSecret }
		);
		const result = await request({ query: '&limit=100' });
		assert.equal(result.status, 200);
		const json = JSON.stringify(result.body);
		for (const token of [noteSecret, note.id, systemNote.id, 'internal_note_added'])
			assert.ok(!json.includes(token));
	});
	await t.test(
		'typed changes and generic actors; no raw data or sensitive identifiers',
		async () => {
			const { body } = await request();
			const forbidden = [
				'payload',
				'comment',
				'reason',
				'organizationId',
				'incidentId',
				'actorUserId',
				'teamId',
				'assignedToUserId',
				'clientUserId',
				'siteId',
				'fromSiteId',
				'toSiteId'
			];
			function check(value) {
				if (!value || typeof value !== 'object') return;
				for (const [key, child] of Object.entries(value)) {
					assert.ok(!forbidden.includes(key));
					check(child);
				}
			}
			check(body);
			const json = JSON.stringify(body);
			for (const token of [secret, privateId, manager.user.id, org.id, incident.id])
				assert.ok(!json.includes(token));
			assert.deepEqual(body.items.find((i) => i.type === 'priority_changed').changes, {
				priority: { from: 'low', to: 'high' }
			});
			assert.deepEqual(body.items.find((i) => i.type === 'support_level_changed').changes, {
				supportLevel: { from: 'N1', to: 'N3' }
			});
			assert.deepEqual(body.items.find((i) => i.type === 'assigned').changes, {
				assignmentChanged: true
			});
			// 5.4O-D: site_changed solo señala el cambio; ni ids de sede, ni reason, ni payload
			const siteChanged = body.items.find((i) => i.type === 'site_changed');
			assert.deepEqual(siteChanged.changes, { siteChanged: true });
			assert.deepEqual(Object.keys(siteChanged).sort(), [
				'actor',
				'changes',
				'id',
				'occurredAt',
				'type'
			]);
			assert.deepEqual(body.items[0].actor, { type: 'user', label: 'Usuario' });
			assert.equal(body.items.find((i) => i.type === 'created').changes, undefined);
		}
	);
	for (const [name, payload, expected] of [
		['empty', {}, undefined],
		['JSON null', sql.raw("'null'::jsonb"), undefined],
		['array', [], undefined],
		['incomplete', { oldStatus: 'open' }, { status: { from: 'open' } }],
		['invalid enums', { oldStatus: 'SECRET', newStatus: 123 }, undefined],
		[
			'extra fields',
			{ oldStatus: 'open', newStatus: 'pending', reason: secret },
			{ status: { from: 'open', to: 'pending' } }
		]
	])
		await t.test('legacy ' + name, async () => {
			const row = await event('status_changed', payload);
			const result = (await request()).body.items.find((i) => i.id === row.id);
			assert.ok(result);
			assert.deepEqual(result.changes, expected);
		});
	for (const [name, payload] of [
		['JSON null', sql.raw("'null'::jsonb")],
		['array', [privateId]]
	])
		await t.test('legacy assigned ' + name + ' keeps basic event without changes', async () => {
			const row = await event('assigned', payload);
			const result = (await request({ query: '&limit=100' })).body.items.find(
				(i) => i.id === row.id
			);
			assert.ok(result);
			assert.equal(result.type, 'assigned');
			assert.equal('changes' in result, false);
			assert.ok(!JSON.stringify(result).includes(privateId));
		});
	await t.test('system actor; inactive historical actor remains generic', async () => {
		const row = await event('created', {}, { actorType: 'system', actorUserId: null });
		assert.deepEqual((await request()).body.items.find((i) => i.id === row.id).actor, {
			type: 'system',
			label: 'Sistema'
		});
		const historical = await event('created', {}, { actorUserId: none.user.id });
		await db.update(s.users).set({ active: false }).where(eq(s.users.id, none.user.id));
		assert.deepEqual((await request()).body.items.find((i) => i.id === historical.id).actor, {
			type: 'user',
			label: 'Usuario'
		});
	});
	await t.test('unknown event excluded and defective row safely omitted by mapper', () => {
		const row = {
			id: randomUUID(),
			eventType: 'created',
			actorType: 'user',
			occurredAt: '2026-09-01T00:00:00.000000Z',
			payload: null
		};
		assert.equal(projectHistoryItem({ ...row, eventType: 'future_event' }), null);
		assert.equal(projectHistoryItem({ ...row, actorType: 'unexpected' }), null);
		assert.equal(projectHistoryItem({ ...row, occurredAt: 'invalid' }), null);
		assert.ok(projectHistoryItem(row));
	});
	await t.test('independent tenant gets only own events', async () => {
		const result = await request({
			id: other.id,
			organizationId: otherOrg.id,
			cookie: outsider.session.cookieHeader
		});
		assert.equal(result.status, 200);
		assert.equal(result.body.items.length, 1);
		assert.equal(result.body.items[0].type, 'created');
	});
	const paged = await ticket();
	// Synthetic fixed timestamps include microseconds, not representable as distinct JS Dates.
	for (let i = 0; i < 105; i++) {
		const id = randomUUID();
		await event(
			'created',
			{},
			{
				id,
				createdAt: sql.raw(
					"'2020-01-01T00:00:00.000" + String(i % 3).padStart(3, '0') + "Z'::timestamptz"
				)
			},
			paged
		);
	}
	const startRows = await db
		.select({ id: s.incidentHistory.id })
		.from(s.incidentHistory)
		.where(eq(s.incidentHistory.incidentId, paged.id))
		.orderBy(sql.raw('created_at DESC, id DESC'));
	await t.test('default 50 and max 100', async () => {
		assert.equal((await request({ id: paged.id })).body.items.length, 50);
		assert.equal((await request({ id: paged.id, query: '&limit=100' })).body.items.length, 100);
	});
	for (const query of [
		'&limit=0',
		'&limit=101',
		'&limit=-1',
		'&limit=1.5',
		'&limit=abc',
		'&limit=01',
		'&limit=',
		'&cursor=bad',
		'&cursor=',
		'&limit=1&limit=2',
		'&unknown=x'
	]) {
		await t.test('400 query ' + query, async () =>
			assert.equal((await request({ query })).status, 400)
		);
	}
	await t.test('strict cursor structure and date validation', async () => {
		for (const value of [
			[],
			['2020-02-30T00:00:00.000000Z', randomUUID()],
			['2020-01-01T00:00:00.000000Z', 'bad'],
			{ secret },
			['2020-01-01T00:00:00.000000Z', randomUUID(), secret]
		]) {
			const cursor = Buffer.from(JSON.stringify(value)).toString('base64url');
			assert.equal((await request({ query: '&cursor=' + cursor })).status, 400);
		}
	});
	async function pages() {
		const results = [];
		let cursor = null;
		do {
			const res = await request({
				id: paged.id,
				query: '&limit=7' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
			});
			assert.equal(res.status, 200);
			results.push(res.body);
			cursor = res.body.nextCursor;
		} while (cursor);
		return results;
	}
	await t.test(
		'DESC consecutive pages: same timestamps and microseconds, no duplicates or gaps',
		async () => {
			const result = await pages();
			assert.deepEqual(
				result.flatMap((p) => p.items.map((i) => i.id)),
				startRows.map((r) => r.id)
			);
			assert.equal(new Set(result.flatMap((p) => p.items.map((i) => i.id))).size, 106);
		}
	);
	await t.test(
		'hidden events do not alter visible pages or cursors; hidden-only history is empty',
		async () => {
			const before = await pages();
			for (const type of blocked) await event(type, { secret }, { createdAt: new Date() }, paged);
			// Interleave hidden events at the same microsecond timestamps as visible rows.
			for (let i = 0; i < 30; i++)
				await event(
					blocked[i % blocked.length],
					{ secret },
					{
						createdAt: sql.raw(
							"'2020-01-01T00:00:00.000" + String(i % 3).padStart(3, '0') + "Z'::timestamptz"
						)
					},
					paged
				);
			assert.deepEqual(await pages(), before);
			assert.equal((await request({ id: paged.id })).body.items.length, 50);
			const hidden = await db
				.insert(s.incidents)
				.values({
					organizationId: org.id,
					incidentNumber: 9999,
					title: 'Hidden',
					description: 'Synthetic',
					client: 'Synthetic',
					createdByUserId: manager.user.id
				})
				.returning();
			await event('internal_note_added', { secret }, {}, hidden[0]);
			assert.deepEqual((await request({ id: hidden[0].id })).body, { items: [], nextCursor: null });
		}
	);
	await t.test('empty history', async () => {
		const [empty] = await db
			.insert(s.incidents)
			.values({
				organizationId: org.id,
				incidentNumber: 9998,
				title: 'Empty',
				description: 'Synthetic',
				client: 'Synthetic',
				createdByUserId: manager.user.id
			})
			.returning();
		assert.deepEqual((await request({ id: empty.id })).body, { items: [], nextCursor: null });
	});
	await t.test('read-only history service leaves audit unchanged', async () => {
		const before = await db.select().from(s.incidentHistory);
		await listIncidentHistory(db, { organizationId: org.id, incidentId: incident.id });
		assert.deepEqual(await db.select().from(s.incidentHistory), before);
	});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

/**
 * 5.4W-B — AUTH / BOLA / IDOR / TENANT HARDENING.
 *
 * Table-driven security matrix over the HTTP handlers. Every family includes a positive control,
 * a same-tenant wrong owner, a cross-tenant id, a missing capability and a stale (revoked)
 * capability. Policy under test:
 *   401 unauthenticated · 403 missing capability / organization not accessible / visible but not
 *   mutable · 404 missing, cross-tenant or outside the caller's read scope (no existence oracle).
 */
const ORIGIN = 'http://localhost';
const KEY_HEX = randomBytes(32).toString('hex');

/** Exact customer (requester) projection: anything else is an internal field leaking. */
const REQUESTER_KEYS = [
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
	// optional subcategory of categoryId: same public classification level as categoryId
	'subcategoryId',
	'title',
	'updatedAt'
];
const REQUESTER_HISTORY = new Set([
	'created',
	'status_changed',
	'priority_changed',
	'site_changed',
	'category_changed',
	'resolved',
	'closed',
	'reopened',
	'sla_first_response_met',
	'sla_first_response_breached',
	'sla_resolution_met',
	'sla_resolution_breached'
]);

test('SoporteFlow — Etapa 5.4W-B: BOLA / IDOR / tenant hardening', async (t) => {
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
	const { createInternalNote } = await load('/src/lib/server/services/incident-messages.ts');
	const subs = await load('/src/lib/server/services/webhook-subscriptions.ts');
	const secrets = await load('/src/lib/server/webhooks/secrets.ts');
	const rules = await load('/src/lib/server/services/automation-rules.ts');
	const notificationsService = await load('/src/lib/server/services/notifications.ts');
	const r = {
		list: await load('/src/routes/api/incidents/+server.ts'),
		detail: await load('/src/routes/api/incidents/[id]/+server.ts'),
		comments: await load('/src/routes/api/incidents/[id]/comments/+server.ts'),
		notes: await load('/src/routes/api/incidents/[id]/internal-notes/+server.ts'),
		history: await load('/src/routes/api/incidents/[id]/history/+server.ts'),
		assign: await load('/src/routes/api/incidents/[id]/assign/+server.ts'),
		site: await load('/src/routes/api/incidents/[id]/site/+server.ts'),
		category: await load('/src/routes/api/incidents/[id]/category/+server.ts'),
		supportLevel: await load('/src/routes/api/incidents/[id]/support-level/+server.ts'),
		sla: await load('/src/routes/api/incidents/[id]/sla/+server.ts'),
		webhook: await load('/src/routes/api/webhooks/[id]/+server.ts'),
		automation: await load('/src/routes/api/automations/[id]/+server.ts'),
		notification: await load('/src/routes/api/notifications/[id]/+server.ts'),
		membership: await load('/src/routes/api/memberships/[id]/+server.ts'),
		role: await load('/src/routes/api/roles/[id]/+server.ts'),
		slaPolicy: await load('/src/routes/api/sla-policies/[id]/+server.ts'),
		me: await load('/src/routes/api/me/+server.ts')
	};

	// ------------------------------------------------------------------ fixtures
	let seq = 0;
	async function organization(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'wb-' + randomUUID(), status: 'active' })
			.returning();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		const byCode = (code) => roles.find((x) => x.code === code);
		const [site] = await db
			.insert(s.sites)
			.values({ organizationId: org.id, name: 'Sede ' + name })
			.returning();
		const [category] = await db
			.insert(s.categories)
			.values({ organizationId: org.id, name: 'Categoría ' + name })
			.returning();
		const [team] = await db
			.insert(s.teams)
			.values({ organizationId: org.id, name: 'Equipo ' + name })
			.returning();
		const [policy] = await db
			.insert(s.slaPolicies)
			.values({
				organizationId: org.id,
				code: 'wb_' + ++seq,
				name: 'SLA ' + name,
				firstResponseMinutes: 60,
				resolutionMinutes: 480
			})
			.returning();
		return {
			org,
			site,
			category,
			team,
			policy,
			admin: byCode('organization_admin'),
			tech: byCode('technician'),
			customer: byCode('customer')
		};
	}
	async function rawRole(org, permissionIds) {
		const [role] = await db
			.insert(s.roles)
			.values({ organizationId: org.id, name: 'Raw', code: `raw_${++seq}`, isCustom: true })
			.returning();
		for (const permissionId of permissionIds)
			await db.insert(s.rolePermissions).values({ roleId: role.id, permissionId });
		return role;
	}
	async function member(org, roles = []) {
		const user = await createCredentialUser(f, { email: `wb-${randomUUID()}@example.test` });
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
		const assignments = [];
		for (const role of roles) {
			const [assignment] = await db
				.insert(s.roleAssignments)
				.values({
					organizationId: org.id,
					membershipId: membership.id,
					roleId: role.id,
					scopeType: 'organization'
				})
				.returning();
			assignments.push(assignment);
		}
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, assignments, cookie: session.cookieHeader };
	}
	async function incident(o, creator, values = {}, patch = {}) {
		const { incident: row } = await createIncidentRecord(
			db,
			{ organizationId: o.org.id, creatorUserId: creator.user.id },
			{ title: 'WB ' + ++seq, description: 'Sintética', client: 'Etiqueta interna', ...values }
		);
		if (Object.keys(patch).length)
			await db.update(s.incidents).set(patch).where(eq(s.incidents.id, row.id));
		return { ...row, ...patch };
	}
	const row = async (id) => (await db.select().from(s.incidents).where(eq(s.incidents.id, id)))[0];

	async function call(handler, { method = 'GET', path, who, org, params = {}, body, query = '' }) {
		const url = new URL(
			`${ORIGIN}${path}?${org === null ? '' : 'organizationId=' + (org?.id ?? org)}${query}`
		);
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
		return { status: response.status, json: text ? JSON.parse(text) : null, text };
	}
	const incidentCall = (handler, method, suffix, body) => (who, org, id) =>
		call(handler, {
			method,
			path: `/api/incidents/${id}${suffix}`,
			who,
			org,
			params: { id },
			body
		});

	// Read surfaces of one incident (all must share the same visibility policy).
	const reads = {
		detail: incidentCall(r.detail.GET, 'GET', ''),
		comments: incidentCall(r.comments.GET, 'GET', '/comments'),
		history: incidentCall(r.history.GET, 'GET', '/history')
	};

	const A = await organization('A');
	const B = await organization('B');
	const adminA = await member(A.org, [A.admin]);
	const adminB = await member(B.org, [B.admin]);
	const techA = await member(A.org, [A.tech]);
	const ownA = await member(A.org, [
		await rawRole(A.org, [
			'incidents:view_own',
			'incidents:edit',
			'incidents:assign',
			'incidents:add_comment',
			'incidents:view_internal_notes',
			'incidents:add_internal_note',
			'sla:assign'
		])
	]);
	const custA1 = await member(A.org, [A.customer]);
	const custA2 = await member(A.org, [A.customer]);
	const custB = await member(B.org, [B.customer]);
	const nobodyA = await member(A.org, []);
	await db.insert(s.teamMemberships).values([
		{ organizationId: A.org.id, teamId: A.team.id, membershipId: techA.membership.id },
		{ organizationId: B.org.id, teamId: B.team.id, membershipId: adminB.membership.id }
	]);

	// custA1's incident, assigned to ownA (a view_own technician) through the real services.
	const mine = await incident(
		A,
		custA1,
		{ clientUserId: custA1.user.id, slaPolicyId: A.policy.id },
		{ assignedToUserId: ownA.user.id, teamId: A.team.id, supportLevel: 'N2' }
	);
	const unassigned = await incident(A, adminA, { clientUserId: custA2.user.id });
	const foreign = await incident(B, adminB, { clientUserId: custB.user.id });

	// =========================================================================
	// 1-5. Read matrix: positive control / wrong owner / cross-tenant / capability
	// =========================================================================
	await t.test('1-5. matriz de lectura (detalle, comentarios, historial)', async () => {
		const cases = [
			// [label, actor, org, incident, expected]
			['positive: customer own', custA1, A.org, mine, 200],
			['positive: view_own assigned', ownA, A.org, mine, 200],
			['positive: view_all', techA, A.org, unassigned, 200],
			['wrong owner: customer A2 -> A1', custA2, A.org, mine, 404],
			['wrong owner: view_own -> unassigned', ownA, A.org, unassigned, 404],
			['cross-tenant id under own org', adminA, A.org, foreign, 404],
			['cross-tenant customer', custB, B.org, mine, 404],
			['foreign org without membership', adminA, B.org, foreign, 403],
			['no capability', nobodyA, A.org, mine, 403],
			['unauthenticated', null, A.org, mine, 401]
		];
		const missingId = randomUUID();
		for (const [surface, read] of Object.entries(reads)) {
			const missing = await read(adminA, A.org, missingId);
			assert.equal(missing.status, 404, `${surface} missing`);
			for (const [label, who, org, target, expected] of cases) {
				const res = await read(who ?? undefined, org, target.id);
				assert.equal(res.status, expected, `${surface}: ${label}`);
				// 404 bodies are byte-identical to a missing id: no existence oracle
				if (expected === 404) assert.equal(res.text, missing.text, `${surface}: ${label}`);
				if (expected >= 400) assert.ok(!res.text.includes(target.title), `${surface}: ${label}`);
			}
		}
	});

	await t.test('1-5. listado coherente con el detalle (mismo alcance)', async () => {
		const ids = async (who) =>
			(await call(r.list.GET, { path: '/api/incidents', who, org: A.org })).json.incidents.map(
				(i) => i.id
			);
		assert.equal(
			(
				await call(r.list.GET, {
					path: '/api/incidents',
					who: custA1,
					org: A.org,
					query: '&queue=all'
				})
			).status,
			403,
			'queue=all exige view_all'
		);
		assert.deepEqual(await ids(custA1), [mine.id]);
		assert.ok(!(await ids(custA2)).includes(mine.id));
		assert.ok((await ids(techA)).includes(unassigned.id));
		assert.ok(!(await ids(adminA)).includes(foreign.id), 'nunca cross-tenant');
		const scoped = await call(r.list.GET, {
			path: '/api/incidents',
			who: ownA,
			org: A.org,
			query: '&queue=mine'
		});
		assert.deepEqual(
			scoped.json.incidents.map((i) => i.id),
			[mine.id]
		);
	});

	// =========================================================================
	// 6-8. Customer DTO: exact allowlist in list, detail and create
	// =========================================================================
	await t.test(
		'6-8. DTO de Customer: allowlist exacta y sin identificadores internos',
		async () => {
			const detail = await reads.detail(custA1, A.org, mine.id);
			const list = await call(r.list.GET, { path: '/api/incidents', who: custA1, org: A.org });
			const created = await call(r.list.POST, {
				method: 'POST',
				path: '/api/incidents',
				who: custA1,
				org: null,
				body: {
					organizationId: A.org.id,
					title: 'Nueva',
					description: 'Desde el portal',
					client: 'Portal',
					priority: 'medium'
				}
			});
			assert.equal(created.status, 201, created.text);
			const payloads = [
				['detail', detail, detail.json.incident],
				['list', list, list.json.incidents.find((i) => i.id === mine.id)],
				['create', created, created.json.incident]
			];
			for (const [name, res, item] of payloads) {
				assert.deepEqual(Object.keys(item).sort(), REQUESTER_KEYS, name);
				assert.equal(item.audience, 'requester', name);
				for (const secret of [
					ownA.user.id,
					A.team.id,
					A.policy.id,
					'Etiqueta interna',
					'"supportLevel"',
					'"createdByUserId"',
					'DueAt'
				])
					assert.ok(!res.text.includes(secret), `${name} filtra ${secret}`);
			}
			// Staff keeps the operational DTO (no regression for the support UI)
			const staff = await reads.detail(ownA, A.org, mine.id);
			assert.equal(staff.json.incident.assignedToUserId, ownA.user.id);
			assert.equal(staff.json.incident.teamId, A.team.id);
			assert.equal(staff.json.incident.supportLevel, 'N2');
			assert.equal(staff.json.incident.slaPolicyId, A.policy.id);
			assert.equal('audience' in staff.json.incident, false);
		}
	);

	await t.test('6-8. el Customer no usa campos internos como oráculo de filtro', async () => {
		for (const query of [`&teamId=${A.team.id}`, '&supportLevel=N2']) {
			const res = await call(r.list.GET, {
				path: '/api/incidents',
				who: custA1,
				org: A.org,
				query
			});
			assert.equal(res.status, 403, query);
		}
		// Compliance statuses are customer-facing (5.4T-C): the filter stays allowed
		const sla = await call(r.list.GET, {
			path: '/api/incidents',
			who: custA1,
			org: A.org,
			query: '&slaStatus=on_track'
		});
		assert.equal(sla.status, 200);
	});

	await t.test(
		'6-8. historial del Customer: sin asignación, equipo, nivel ni configuración SLA',
		async () => {
			const assigned = await call(r.assign.POST, {
				method: 'POST',
				path: `/api/incidents/${mine.id}/assign`,
				who: adminA,
				org: A.org,
				params: { id: mine.id },
				body: { teamId: A.team.id, assignedToUserId: techA.user.id, reason: 'Reparto' }
			});
			assert.equal(assigned.status, 200, assigned.text);
			const staff = await reads.history(adminA, A.org, mine.id);
			assert.ok(
				staff.json.items.some((i) => !REQUESTER_HISTORY.has(i.type)),
				'control positivo'
			);
			const customer = await reads.history(custA1, A.org, mine.id);
			assert.equal(customer.status, 200);
			for (const item of customer.json.items)
				assert.ok(REQUESTER_HISTORY.has(item.type), item.type);
			assert.ok(!customer.text.includes(techA.user.id) && !customer.text.includes(A.team.id));
			// restore the view_own assignment used by later cases
			await db
				.update(s.incidents)
				.set({ assignedToUserId: ownA.user.id })
				.where(eq(s.incidents.id, mine.id));
		}
	);

	// =========================================================================
	// 9-10. Internal notes: capability AND incident scope (B-1)
	// =========================================================================
	await t.test('9-10. notas internas: permiso + alcance de incidencia', async () => {
		await createInternalNote(
			db,
			{ organizationId: A.org.id, incidentId: mine.id, actorUserId: adminA.user.id },
			'NOTA-SECRETA-WB'
		);
		const notesOnly = await member(A.org, [
			await rawRole(A.org, ['incidents:view_internal_notes', 'incidents:add_internal_note'])
		]);
		const notes = (method) =>
			incidentCall(
				r.notes[method],
				method,
				'/internal-notes',
				method === 'POST' ? { body: 'x' } : undefined
			);
		const cases = [
			['positive: view_all', techA, mine, 200, 201],
			['positive: view_own assigned', ownA, mine, 200, 201],
			['wrong owner: view_own unassigned', ownA, unassigned, 404, 404],
			['notes permission without incident scope (B-1)', notesOnly, mine, 403, 403],
			['customer own incident', custA1, mine, 403, 403],
			['cross-tenant', adminA, foreign, 404, 404],
			['no capability', nobodyA, mine, 403, 403]
		];
		for (const [label, who, target, getStatus, postStatus] of cases) {
			const got = await notes('GET')(who, A.org, target.id);
			assert.equal(got.status, getStatus, `GET ${label}`);
			if (getStatus !== 200) assert.ok(!got.text.includes('NOTA-SECRETA-WB'), label);
			assert.equal(
				(await notes('POST')(who, A.org, target.id)).status,
				postStatus,
				`POST ${label}`
			);
		}
		const comments = await reads.comments(custA1, A.org, mine.id);
		assert.ok(!comments.text.includes('NOTA-SECRETA-WB'), 'la nota nunca sale por comentarios');
	});

	// =========================================================================
	// 11-15. Incident mutations: scope, cross-tenant related resources
	// =========================================================================
	const mutations = [
		['PATCH detail', r.detail.PATCH, 'PATCH', '', { priority: 'high' }],
		[
			'assign',
			r.assign.POST,
			'POST',
			'/assign',
			{ teamId: A.team.id, assignedToUserId: techA.user.id, reason: 'Reparto' }
		],
		['site', r.site.PATCH, 'PATCH', '/site', { siteId: A.site.id }],
		['category', r.category.PATCH, 'PATCH', '/category', { categoryId: A.category.id }],
		[
			'support-level',
			r.supportLevel.PATCH,
			'PATCH',
			'/support-level',
			{ supportLevel: 'N3', reason: 'Escalado' }
		],
		['sla', r.sla.PATCH, 'PATCH', '/sla', { slaPolicyId: A.policy.id }]
	];

	await t.test(
		'11. mutaciones: requester nunca muta; ajena 404; cross-tenant 404; sin permiso 403',
		async () => {
			for (const [name, handler, method, suffix, body] of mutations) {
				const run = incidentCall(handler, method, suffix, body);
				const cases = [
					['customer own (visible, not mutable)', custA1, A.org, mine, 403],
					// the capability pre-check precedes the scope check: identical 403 for any id
					['wrong owner: customer A2 (no capability)', custA2, A.org, mine, 403],
					['customer A2 missing id', custA2, A.org, { id: randomUUID() }, 403],
					['wrong owner: view_own unassigned', ownA, A.org, unassigned, 404],
					['cross-tenant id', adminA, A.org, foreign, 404],
					['foreign org without membership', adminA, B.org, foreign, 403],
					['no capability', nobodyA, A.org, mine, 403],
					['unauthenticated', null, A.org, mine, 401]
				];
				const missing = await run(adminA, A.org, randomUUID());
				assert.equal(missing.status, 404, `${name}: missing`);
				for (const [label, who, org, target, expected] of cases) {
					const before = await row(target.id);
					const res = await run(who ?? undefined, org, target.id);
					assert.equal(res.status, expected, `${name}: ${label} ${res.text}`);
					if (expected === 404) assert.equal(res.text, missing.text, `${name}: ${label} oráculo`);
					assert.deepEqual(await row(target.id), before, `${name}: ${label} sin efectos`);
				}
				// positive control: the assigned view_own technician mutates the same incident
				const positive = await run(ownA, A.org, mine.id);
				assert.equal(positive.status, 200, `${name}: control positivo ${positive.text}`);
				assert.equal(positive.json.incident.audience, undefined, 'staff DTO');
				// assign moves the incident away from ownA: restore the scope for the next family
				await db
					.update(s.incidents)
					.set({ assignedToUserId: ownA.user.id, teamId: A.team.id })
					.where(eq(s.incidents.id, mine.id));
			}
		}
	);

	await t.test(
		'12-15. recursos relacionados de otro tenant -> rechazados sin efectos ni fugas',
		async () => {
			const target = await incident(A, adminA);
			const cases = [
				['site', r.site.PATCH, 'PATCH', '/site', { siteId: B.site.id }],
				['category', r.category.PATCH, 'PATCH', '/category', { categoryId: B.category.id }],
				['team', r.assign.POST, 'POST', '/assign', { teamId: B.team.id, assignedToUserId: null }],
				[
					'assignee',
					r.assign.POST,
					'POST',
					'/assign',
					{ teamId: A.team.id, assignedToUserId: adminB.user.id }
				],
				['sla policy', r.sla.PATCH, 'PATCH', '/sla', { slaPolicyId: B.policy.id }]
			];
			for (const [name, handler, method, suffix, body] of cases) {
				const before = await row(target.id);
				const res = await incidentCall(handler, method, suffix, body)(adminA, A.org, target.id);
				assert.ok(res.status >= 400 && res.status < 500, `${name}: ${res.status} ${res.text}`);
				assert.deepEqual(await row(target.id), before, `${name} sin efectos`);
				for (const leak of [B.org.id, B.site.name, B.category.name, B.team.name, B.policy.name])
					assert.ok(!res.text.includes(leak), `${name} filtra ${leak}`);
			}
			// creation with foreign related ids
			for (const extra of [
				{ siteId: B.site.id },
				{ categoryId: B.category.id },
				{ slaPolicyId: B.policy.id }
			]) {
				const count = (await db.select().from(s.incidents)).length;
				const res = await call(r.list.POST, {
					method: 'POST',
					path: '/api/incidents',
					who: adminA,
					org: null,
					body: {
						organizationId: A.org.id,
						title: 'X',
						description: 'Y',
						client: 'Z',
						priority: 'low',
						...extra
					}
				});
				assert.ok(res.status >= 400 && res.status < 500, JSON.stringify(extra));
				assert.equal((await db.select().from(s.incidents)).length, count);
			}
			// positive control: same-tenant related resources are accepted
			const ok = await incidentCall(r.site.PATCH, 'PATCH', '/site', { siteId: A.site.id })(
				adminA,
				A.org,
				target.id
			);
			assert.equal(ok.status, 200, ok.text);
		}
	);

	// =========================================================================
	// 16. Stale capability: revoked between requests -> 403, nothing written
	// =========================================================================
	await t.test(
		'16. capability revocada: la siguiente mutación y lectura fallan cerradas',
		async () => {
			const role = await rawRole(A.org, ['incidents:view_all', 'incidents:edit']);
			const revokable = await member(A.org, [role]);
			const target = await incident(A, adminA);
			const patch = incidentCall(r.detail.PATCH, 'PATCH', '', { priority: 'urgent' });
			assert.equal((await patch(revokable, A.org, target.id)).status, 200, 'control positivo');
			await db.update(s.incidents).set({ priority: 'low' }).where(eq(s.incidents.id, target.id));
			await db.delete(s.rolePermissions).where(eq(s.rolePermissions.roleId, role.id));
			await db
				.insert(s.rolePermissions)
				.values({ roleId: role.id, permissionId: 'incidents:view_all' });
			assert.equal((await patch(revokable, A.org, target.id)).status, 403, 'edit revocado');
			assert.equal((await row(target.id)).priority, 'low');
			assert.equal(
				(await reads.detail(revokable, A.org, target.id)).status,
				200,
				'lectura intacta'
			);
			// role deactivated -> the read scope disappears too
			await db.update(s.roles).set({ active: false }).where(eq(s.roles.id, role.id));
			assert.equal((await reads.detail(revokable, A.org, target.id)).status, 403);
		}
	);

	// =========================================================================
	// 17-19. Inactive membership / user / organization
	// =========================================================================
	await t.test('17-19. membership, usuario y organización inactivos', async () => {
		const target = await incident(A, adminA);
		const patch = incidentCall(r.detail.PATCH, 'PATCH', '', { priority: 'high' });
		const probe = async (who) => [
			(await reads.detail(who, A.org, target.id)).status,
			(await patch(who, A.org, target.id)).status
		];

		const inactiveMember = await member(A.org, [A.tech]);
		assert.deepEqual(await probe(inactiveMember), [200, 200], 'control positivo');
		await db
			.update(s.memberships)
			.set({ active: false })
			.where(eq(s.memberships.id, inactiveMember.membership.id));
		assert.deepEqual(await probe(inactiveMember), [403, 403], 'membership inactiva');

		const inactiveUser = await member(A.org, [A.tech]);
		await db.update(s.users).set({ active: false }).where(eq(s.users.id, inactiveUser.user.id));
		assert.deepEqual(await probe(inactiveUser), [401, 401], 'usuario inactivo');

		const before = await row(target.id);
		await db
			.update(s.organizations)
			.set({ status: 'suspended' })
			.where(eq(s.organizations.id, A.org.id));
		try {
			assert.deepEqual(await probe(techA), [403, 403], 'organización suspendida');
			assert.deepEqual(await row(target.id), before);
		} finally {
			await db
				.update(s.organizations)
				.set({ status: 'active' })
				.where(eq(s.organizations.id, A.org.id));
		}
	});

	// =========================================================================
	// 20. Other tenant resources by id (webhooks, automations, notifications, memberships, roles,
	//     SLA policies): foreign id under the caller's org -> 404; foreign org -> 403
	// =========================================================================
	await t.test('20. ids de otro tenant en recursos administrativos', async () => {
		const KEY = secrets.parseWebhookEncryptionKey(KEY_HEX);
		const hookB = await subs.createWebhookSubscription(
			db,
			{ organizationId: B.org.id, actorUserId: adminB.user.id },
			{
				name: 'Hook B',
				targetUrl: 'https://hooks.example.com/b',
				eventTypes: ['incident.created']
			},
			{ encryptionKey: KEY }
		);
		const ruleB = await rules.createAutomationRule(db, B.org.id, adminB.user.id, {
			name: 'Regla B',
			eventType: 'incident.created',
			conditions: { all: [] },
			actions: [{ type: 'incident.add_internal_note', text: 'B' }]
		});
		const notifB = await notificationsService.createNotification(db, {
			organizationId: B.org.id,
			recipientUserId: adminB.user.id,
			type: 'synthetic.notice',
			title: 'Aviso B',
			message: 'Privado de B'
		});
		const resources = [
			['webhook', r.webhook.GET, '/api/webhooks', hookB.webhook.id],
			['automation', r.automation.GET, '/api/automations', ruleB.id],
			['notification', r.notification.GET, '/api/notifications', notifB.id],
			['membership', r.membership.GET, '/api/memberships', adminB.membership.id],
			['role', r.role.GET, '/api/roles', B.admin.id],
			['sla policy', r.slaPolicy.GET, '/api/sla-policies', B.policy.id]
		];
		for (const [name, handler, base, id] of resources) {
			assert.ok(id, `${name} id`);
			const get = (who, org) => call(handler, { path: `${base}/${id}`, who, org, params: { id } });
			const positive = await get(adminB, B.org);
			assert.equal(positive.status, 200, `${name} control positivo ${positive.text}`);
			const crossTenant = await get(adminA, A.org);
			assert.equal(crossTenant.status, 404, `${name} id ajeno bajo org propia ${crossTenant.text}`);
			assert.ok(!crossTenant.text.includes(B.org.id), name);
			assert.equal((await get(adminA, B.org)).status, 403, `${name} org sin membresía`);
			assert.equal((await get(null, B.org)).status, 401, `${name} anónimo`);
		}
		// notifications are recipient-scoped: another member of B never reads adminB's notification
		const otherB = await member(B.org, [B.admin]);
		assert.equal(
			(
				await call(r.notification.GET, {
					path: `/api/notifications/${notifB.id}`,
					who: otherB,
					org: B.org,
					params: { id: notifB.id }
				})
			).status,
			404,
			'notificación de otro destinatario'
		);
	});

	// =========================================================================
	// /api/me: tenants from active memberships only; capabilities from the DB
	// =========================================================================
	await t.test('/api/me: org ajena 403, capabilities reales del tenant', async () => {
		const me = (who, org) => call(r.me.GET, { path: '/api/me', who, org });
		const own = await me(custA1, A.org);
		assert.equal(own.status, 200);
		assert.ok(own.json.activeOrganization.capabilities.includes('incidents:view_requested'));
		assert.ok(!own.json.activeOrganization.capabilities.includes('incidents:view_all'));
		assert.ok(!own.text.includes(B.org.id));
		assert.equal((await me(custA1, B.org)).status, 403);
		assert.equal((await me(null, A.org)).status, 401);
	});

	// =========================================================================
	// Static guard: every incident mutation route re-validates inside its transaction
	// =========================================================================
	await t.test('guard: las rutas de mutación de incidencias usan withIncidentActor', () => {
		const files = [
			'[id]/+server.ts',
			'[id]/assign/+server.ts',
			'[id]/site/+server.ts',
			'[id]/category/+server.ts',
			'[id]/support-level/+server.ts',
			'[id]/sla/+server.ts',
			'[id]/comments/+server.ts',
			'[id]/internal-notes/+server.ts',
			'+server.ts'
		];
		for (const file of files) {
			const source = fs.readFileSync(`src/routes/api/incidents/${file}`, 'utf8');
			assert.ok(source.includes('withIncidentActor('), file);
			assert.ok(source.includes('isActorAuthorizationError'), `${file}: 403 mapping`);
		}
	});
});

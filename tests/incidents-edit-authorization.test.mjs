import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import {
	fixture,
	createCredentialUser,
	createSession,
	createTamperedCookie,
	grantPermission
} from './helpers/auth-fixture.mjs';

test('SoporteFlow — Etapa 5.4O-D: autorización de edición y closed inmutable', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, pg, server } = f;
	const detailRoute = await server.ssrLoadModule('/src/routes/api/incidents/[id]/+server.ts');
	const assignRoute = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/assign/+server.ts'
	);
	const levelRoute = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/support-level/+server.ts'
	);
	const siteRoute = await server.ssrLoadModule('/src/routes/api/incidents/[id]/site/+server.ts');
	const commentsRoute = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/comments/+server.ts'
	);
	const notesRoute = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/internal-notes/+server.ts'
	);
	const service = await server.ssrLoadModule('/src/lib/server/services/incidents.ts');

	const [orgA, orgB] = await db
		.insert(s.organizations)
		.values([
			{ name: 'Edit A', slug: randomUUID(), status: 'active' },
			{ name: 'Edit B', slug: randomUUID(), status: 'active' }
		])
		.returning();

	async function technicianRole(organization) {
		const [role] = await db
			.insert(s.roles)
			.values({
				organizationId: organization.id,
				name: 'Técnico ' + randomUUID().slice(0, 6),
				code: 'technician',
				active: true
			})
			.returning();
		return role;
	}
	const techRoles = new Map();
	async function techRoleFor(organization) {
		if (!techRoles.has(organization.id))
			techRoles.set(organization.id, await technicianRole(organization));
		return techRoles.get(organization.id);
	}

	const MUTATE = ['incidents:edit', 'incidents:assign'];
	async function actor(organization, permissions, options = {}) {
		const user = await createCredentialUser(f, options);
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: organization.id, userId: user.id })
			.returning();
		await db.insert(s.roleAssignments).values({
			organizationId: organization.id,
			membershipId: membership.id,
			roleId: (await techRoleFor(organization)).id,
			scopeType: 'organization'
		});
		for (const permissionId of permissions)
			await grantPermission(f, {
				organizationId: organization.id,
				membershipId: membership.id,
				permissionId
			});
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, cookie: session.cookieHeader };
	}

	const editAll = await actor(orgA, [
		...MUTATE,
		'incidents:view_all',
		'incidents:add_comment',
		'incidents:add_internal_note'
	]);
	const editOwn = await actor(orgA, [...MUTATE, 'incidents:view_own']);
	const otherTech = await actor(orgA, [...MUTATE, 'incidents:view_own']);
	const editNone = await actor(orgA, MUTATE);
	const viewAllOnly = await actor(orgA, ['incidents:view_all']);
	const viewOwnOnly = await actor(orgA, ['incidents:view_own']);
	const editAllB = await actor(orgB, [...MUTATE, 'incidents:view_all']);

	const [teamA] = await db
		.insert(s.teams)
		.values({ organizationId: orgA.id, name: 'Equipo A' })
		.returning();
	const [siteA] = await db
		.insert(s.sites)
		.values({ organizationId: orgA.id, name: 'Valencia' })
		.returning();

	let number = 500000;
	async function incident(values = {}, organization = orgA) {
		const creator = organization.id === orgA.id ? editAll : editAllB;
		const [row] = await db
			.insert(s.incidents)
			.values({
				organizationId: organization.id,
				incidentNumber: ++number,
				title: 'Edit auth',
				description: 'Desc',
				client: 'Cliente',
				createdByUserId: creator.user.id,
				...values
			})
			.returning();
		return row;
	}

	const operations = [
		{ name: 'status', route: detailRoute, method: 'PATCH', path: '', body: { status: 'pending' } },
		{ name: 'priority', route: detailRoute, method: 'PATCH', path: '', body: { priority: 'high' } },
		{
			name: 'assign',
			route: assignRoute,
			method: 'POST',
			path: '/assign',
			body: { teamId: teamA.id, reason: 'Motivo' }
		},
		{
			name: 'support-level',
			route: levelRoute,
			method: 'PATCH',
			path: '/support-level',
			body: { supportLevel: 'N2', reason: 'Motivo' }
		},
		{
			name: 'site',
			route: siteRoute,
			method: 'PATCH',
			path: '/site',
			body: { siteId: siteA.id, reason: 'Motivo' }
		}
	];

	async function call(
		op,
		target,
		{ cookie, organizationId = orgA.id, body = op.body, headers: extra } = {}
	) {
		const url = new URL(
			`http://localhost/api/incidents/${target.id}${op.path}?organizationId=${organizationId}`
		);
		const headers = new Headers(extra);
		if (cookie) headers.set('cookie', cookie);
		headers.set('content-type', 'application/json');
		const response = await op.route[op.method]({
			url,
			params: { id: target.id },
			request: new Request(url, { method: op.method, headers, body: JSON.stringify(body) })
		});
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null, text };
	}

	async function snapshot(target) {
		const [row] = await db.select().from(s.incidents).where(eq(s.incidents.id, target.id));
		const history = await db
			.select()
			.from(s.incidentHistory)
			.where(eq(s.incidentHistory.incidentId, target.id));
		return { row, historyCount: history.length };
	}
	async function assertUnchanged(target, before) {
		const after = await snapshot(target);
		assert.deepEqual(after.row, before.row);
		assert.equal(after.historyCount, before.historyCount);
	}

	// =========================================================================
	// Matriz edit + view
	// =========================================================================
	await t.test('A. edit + view_all edita cualquier incidencia del tenant', async () => {
		for (const op of operations) {
			for (const values of [{}, { assignedToUserId: otherTech.user.id }]) {
				const target = await incident(values);
				const res = await call(op, target, { cookie: editAll.cookie });
				assert.equal(res.status, 200, `${op.name} ${JSON.stringify(values)}: ${res.text}`);
				assert.ok(!('history' in res.json));
			}
		}
	});

	await t.test('B. edit + view_own: solo incidencias asignadas a sí mismo', async () => {
		for (const op of operations) {
			const own = await incident({ assignedToUserId: editOwn.user.id });
			const ownRes = await call(op, own, { cookie: editOwn.cookie });
			assert.equal(ownRes.status, 200, `${op.name}: ${ownRes.text}`);

			for (const values of [
				{ assignedToUserId: otherTech.user.id },
				{},
				{ clientUserId: editOwn.user.id }
			]) {
				const target = await incident(values);
				const before = await snapshot(target);
				const res = await call(op, target, { cookie: editOwn.cookie });
				assert.equal(res.status, 403, `${op.name} ${JSON.stringify(values)}`);
				assert.deepEqual(res.json, { error: { code: 'FORBIDDEN', message: 'Permission denied.' } });
				await assertUnchanged(target, before);
			}
		}
	});

	await t.test('C-E. edit sin view, o view sin edit -> 403 sin cambios', async () => {
		for (const op of operations) {
			for (const who of [editNone, viewAllOnly, viewOwnOnly]) {
				const target = await incident({
					assignedToUserId: who === viewOwnOnly ? viewOwnOnly.user.id : null
				});
				const before = await snapshot(target);
				const res = await call(op, target, { cookie: who.cookie });
				assert.equal(res.status, 403, `${op.name}`);
				await assertUnchanged(target, before);
			}
		}
	});

	await t.test(
		'F-G. aislamiento: permisos de otra org no sirven; cross-tenant indistinguible',
		async () => {
			for (const op of operations) {
				const target = await incident();
				const before = await snapshot(target);
				// actor de B con la org de A: sin membresía -> 403
				assert.equal((await call(op, target, { cookie: editAllB.cookie })).status, 403);
				// actor de B con su org: la incidencia de A no existe para B -> 404 como inexistente
				const foreign = await call(op, target, {
					cookie: editAllB.cookie,
					organizationId: orgB.id
				});
				const missing = await call(
					op,
					{ id: randomUUID() },
					{ cookie: editAllB.cookie, organizationId: orgB.id }
				);
				assert.equal(foreign.status, 404, op.name);
				assert.deepEqual(foreign.json, missing.json);
				assert.ok(!foreign.text.includes(orgA.id));
				await assertUnchanged(target, before);
			}
		}
	);

	await t.test('Estado del actor: sesión, usuario, membership y organización', async () => {
		const inactiveUser = await actor(orgA, [...MUTATE, 'incidents:view_all']);
		await db.update(s.users).set({ active: false }).where(eq(s.users.id, inactiveUser.user.id));
		const inactiveMember = await actor(orgA, [...MUTATE, 'incidents:view_all']);
		await db
			.update(s.memberships)
			.set({ active: false })
			.where(eq(s.memberships.id, inactiveMember.membership.id));
		const [orgS] = await db
			.insert(s.organizations)
			.values({ name: 'Susp', slug: randomUUID(), status: 'active' })
			.returning();
		const suspendedMember = await actor(orgS, [...MUTATE, 'incidents:view_all']);
		await db
			.update(s.organizations)
			.set({ status: 'suspended' })
			.where(eq(s.organizations.id, orgS.id));

		for (const op of operations) {
			const target = await incident();
			const before = await snapshot(target);
			assert.equal((await call(op, target, { cookie: '' })).status, 401);
			assert.equal((await call(op, target, { cookie: createTamperedCookie() })).status, 401);
			assert.equal((await call(op, target, { cookie: inactiveUser.cookie })).status, 401);
			assert.equal((await call(op, target, { cookie: inactiveMember.cookie })).status, 403);
			assert.equal(
				(await call(op, target, { cookie: suspendedMember.cookie, organizationId: orgS.id }))
					.status,
				403
			);
			await assertUnchanged(target, before);
		}
	});

	await t.test('Cabeceras de identidad ignoradas', async () => {
		const spoof = {
			'x-user-id': editAll.user.id,
			'x-organization-id': orgA.id,
			'x-actor-user-id': editAll.user.id
		};
		for (const op of operations) {
			const target = await incident({ assignedToUserId: otherTech.user.id });
			const before = await snapshot(target);
			assert.equal(
				(await call(op, target, { cookie: editOwn.cookie, headers: spoof })).status,
				403
			);
			assert.equal((await call(op, target, { headers: spoof })).status, 401);
			await assertUnchanged(target, before);
		}
	});

	// =========================================================================
	// Closed inmutable
	// =========================================================================
	await t.test(
		'closed: toda mutación -> 409 INCIDENT_CLOSED sin cambios (también no-op)',
		async () => {
			const noopBodies = {
				status: { status: 'closed' },
				priority: { priority: 'medium' },
				assign: { teamId: null, reason: 'x' },
				'support-level': { supportLevel: 'N1', reason: 'x' },
				site: { siteId: null }
			};
			for (const op of operations) {
				for (const body of [op.body, noopBodies[op.name]]) {
					const target = await incident({ status: 'closed' });
					const before = await snapshot(target);
					const res = await call(op, target, { cookie: editAll.cookie, body });
					assert.equal(res.status, 409, `${op.name} ${JSON.stringify(body)}: ${res.text}`);
					assert.deepEqual(res.json, {
						error: { code: 'INCIDENT_CLOSED', message: 'La incidencia está cerrada.' }
					});
					await assertUnchanged(target, before);
				}
			}
			// status distinto de open desde closed y reopen mezclado con prioridad
			for (const body of [
				{ status: 'pending' },
				{ status: 'resolved' },
				{ status: 'open', priority: 'high' }
			]) {
				const target = await incident({ status: 'closed' });
				const before = await snapshot(target);
				const res = await call(operations[0], target, { cookie: editAll.cookie, body });
				assert.equal(res.status, 409, JSON.stringify(body));
				await assertUnchanged(target, before);
			}
		}
	);

	await t.test('closed: comentarios y notas internas -> 409', async () => {
		const target = await incident({ status: 'closed' });
		const before = await snapshot(target);
		for (const route of [commentsRoute, notesRoute]) {
			const path = route === commentsRoute ? 'comments' : 'internal-notes';
			const url = new URL(
				`http://localhost/api/incidents/${target.id}/${path}?organizationId=${orgA.id}`
			);
			const response = await route.POST({
				url,
				params: { id: target.id },
				request: new Request(url, {
					method: 'POST',
					headers: { cookie: editAll.cookie, 'content-type': 'application/json' },
					body: JSON.stringify({ body: 'Texto' })
				})
			});
			assert.equal(response.status, 409, path);
			assert.equal((await response.json()).error.code, 'INCIDENT_CLOSED');
		}
		await assertUnchanged(target, before);
	});

	await t.test('closed: sin acceso da 403 antes que 409 (no se revela el estado)', async () => {
		for (const op of operations) {
			const target = await incident({ status: 'closed', assignedToUserId: otherTech.user.id });
			assert.equal((await call(op, target, { cookie: editOwn.cookie })).status, 403, op.name);
		}
	});

	await t.test('reopen: closed -> open es la única salida y registra reopened', async () => {
		const target = await incident({ status: 'closed' });
		const res = await call(operations[0], target, {
			cookie: editAll.cookie,
			body: { status: 'open' }
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.incident.status, 'open');
		const events = await db
			.select()
			.from(s.incidentHistory)
			.where(eq(s.incidentHistory.incidentId, target.id));
		assert.deepEqual(
			events.map((e) => e.eventType),
			['reopened']
		);
		// reabierta, vuelve a admitir cambios
		assert.equal((await call(operations[1], target, { cookie: editAll.cookie })).status, 200);
		// reabrir exige también acceso
		const other = await incident({ status: 'closed', assignedToUserId: otherTech.user.id });
		assert.equal(
			(await call(operations[0], other, { cookie: editOwn.cookie, body: { status: 'open' } }))
				.status,
			403
		);
	});

	// =========================================================================
	// Locks y TOCTOU (verificación estática: PGlite es de una sola conexión)
	// =========================================================================
	await t.test(
		'SQL: incidencia FOR UPDATE por id + organización antes de update/history',
		async () => {
			const targets = await Promise.all([incident(), incident(), incident(), incident()]);
			const queries = [];
			const logged = drizzle(pg, { schema: s, logger: { logQuery: (q) => queries.push(q) } });
			const original = pg.transaction.bind(pg);
			pg.transaction = async (fn) => {
				queries.push('begin');
				try {
					return await original(fn);
				} finally {
					queries.push('commit');
				}
			};
			const ctx = { organizationId: orgA.id, actorUserId: editAll.user.id, access: {} };
			try {
				await service.updateIncidentRecord(logged, ctx, targets[0].id, { priority: 'high' });
				await service.assignIncidentRecord(logged, ctx, targets[1].id, { teamId: teamA.id });
				await service.updateIncidentSupportLevel(logged, ctx, targets[2].id, {
					supportLevel: 'N3',
					reason: 'x'
				});
				await service.changeIncidentSite(logged, ctx, targets[3].id, { siteId: siteA.id });
			} finally {
				pg.transaction = original;
			}
			const blocks = [];
			let current = null;
			for (const q of queries.map((x) => x.toLowerCase())) {
				if (q === 'begin') current = [];
				else if (q === 'commit') {
					blocks.push(current);
					current = null;
				} else if (current) current.push(q);
			}
			assert.equal(blocks.length, 4);
			for (const [index, tx] of blocks.entries()) {
				const lock = tx.findIndex(
					(q) =>
						q.includes('from "incidents"') &&
						q.includes('for update') &&
						/"incidents"\."id" = \$\d+ and "incidents"\."organization_id" = \$\d+/.test(q)
				);
				const update = tx.findIndex((q) => q.startsWith('update "incidents"'));
				const history = tx.findIndex((q) => q.startsWith('insert into "incident_history"'));
				assert.ok(lock >= 0, `op ${index}: FOR UPDATE tenant-scoped`);
				assert.ok(update > lock, `op ${index}: update tras el lock`);
				assert.ok(history > lock, `op ${index}: history tras el lock`);
			}
		}
	);

	await t.test(
		'TOCTOU: el servicio re-evalúa acceso y closed dentro de la transacción',
		async () => {
			// Simula que la autorización HTTP vio la incidencia asignada al técnico, pero en la
			// transacción ya está reasignada o cerrada: el servicio lo rechaza bajo el lock.
			const ctxOwn = {
				organizationId: orgA.id,
				actorUserId: editOwn.user.id,
				access: { assignedToUserId: editOwn.user.id }
			};
			const reassigned = await incident({ assignedToUserId: otherTech.user.id });
			const closed = await incident({ status: 'closed', assignedToUserId: editOwn.user.id });
			for (const [target, code] of [
				[reassigned, 'INCIDENT_ACCESS_DENIED'],
				[closed, 'INCIDENT_CLOSED']
			]) {
				for (const run of [
					() => service.updateIncidentRecord(db, ctxOwn, target.id, { priority: 'urgent' }),
					() =>
						service.assignIncidentRecord(db, ctxOwn, target.id, { teamId: teamA.id, reason: 'x' }),
					() =>
						service.updateIncidentSupportLevel(db, ctxOwn, target.id, {
							supportLevel: 'N3',
							reason: 'x'
						}),
					() => service.changeIncidentSite(db, ctxOwn, target.id, { siteId: siteA.id })
				]) {
					await assert.rejects(run(), (error) => error.code === code);
				}
			}
		}
	);

	await t.test('razones: máximo 1000 y sin NUL en asignación y nivel de soporte', async () => {
		const ctx = { organizationId: orgA.id, actorUserId: editAll.user.id, access: {} };
		const target = await incident({ teamId: teamA.id });
		for (const reason of ['x'.repeat(1001), 'a\u0000b', 5]) {
			await assert.rejects(
				service.assignIncidentRecord(db, ctx, target.id, { teamId: null, reason }),
				(e) => e.code === 'INVALID_INPUT'
			);
			await assert.rejects(
				service.updateIncidentSupportLevel(db, ctx, target.id, { supportLevel: 'N2', reason }),
				(e) => e.code === 'INVALID_INPUT'
			);
		}
		assert.ok(
			(
				await service.updateIncidentSupportLevel(db, ctx, target.id, {
					supportLevel: 'N2',
					reason: 'y'.repeat(1000)
				})
			).history
		);
	});
});

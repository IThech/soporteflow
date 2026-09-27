import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import {
	fixture,
	directory,
	createCredentialUser,
	createSession
} from './helpers/auth-fixture.mjs';

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

const ORIGIN = 'http://localhost';

test('SoporteFlow — Etapa 5.4U-B: preferencias y reglas de destinatarios', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server, pg } = f;
	const { ensureOrganizationRoles } = await server.ssrLoadModule(
		'/src/lib/server/services/roles.ts'
	);
	const events = await server.ssrLoadModule('/src/lib/notifications/events.ts');
	const prefs = await server.ssrLoadModule('/src/lib/server/services/notification-preferences.ts');
	const recipients = await server.ssrLoadModule(
		'/src/lib/server/services/notification-recipients.ts'
	);
	const { createIncidentRecord } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);
	const collection = await server.ssrLoadModule(
		'/src/routes/api/notification-preferences/+server.ts'
	);
	const item = await server.ssrLoadModule(
		'/src/routes/api/notification-preferences/[eventType]/+server.ts'
	);
	const { NOTIFICATION_EVENT_TYPES } = events;
	const {
		listNotificationPreferences,
		setNotificationPreference,
		resetNotificationPreference,
		getNotificationPreference,
		isNotificationEnabled,
		filterUsersWithNotificationEnabled
	} = prefs;
	const { resolveCandidateRecipients, resolveNotificationRecipients } = recipients;

	async function organization(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'ub-' + randomUUID(), status: 'active' })
			.returning();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		const byCode = (c) => roles.find((r) => r.code === c);
		return {
			org,
			admin: byCode('organization_admin'),
			tech: byCode('technician'),
			customer: byCode('customer')
		};
	}
	async function member(org, roles = [], { active = true, user } = {}) {
		const u = user ?? (await createCredentialUser(f, { email: `ub-${randomUUID()}@example.test` }));
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: u.id, active })
			.returning();
		for (const role of roles)
			await db.insert(s.roleAssignments).values({
				organizationId: org.id,
				membershipId: membership.id,
				roleId: role.id,
				scopeType: 'organization'
			});
		const session = await createSession(f, u.id, { expiresAt: new Date(Date.now() + 3600000) });
		return {
			user: u,
			membership,
			cookie: session.cookieHeader,
			ctx: { organizationId: org.id, userId: u.id }
		};
	}
	async function call(
		handler,
		{ method = 'GET', eventType, who, org, query, body, rawBody, origin = ORIGIN, contentType }
	) {
		const suffix = eventType === undefined ? '' : `/${eventType}`;
		const url = new URL(
			`${ORIGIN}/api/notification-preferences${suffix}?${query ?? `organizationId=${org.id}`}`
		);
		const headers = new Headers({ origin });
		if (who) headers.set('cookie', who.cookie);
		const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
		if (payload !== undefined) headers.set('content-type', contentType ?? 'application/json');
		const response = await handler({
			url,
			params: eventType === undefined ? {} : { eventType },
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
	const get = (who, org, extra = {}) => call(collection.GET, { who, org, ...extra });
	const put = (who, org, eventType, body, extra = {}) =>
		call(item.PUT, { method: 'PUT', who, org, eventType, body, ...extra });
	const del = (who, org, eventType, extra = {}) =>
		call(item.DELETE, { method: 'DELETE', who, org, eventType, ...extra });
	async function incident(org, creator, values = {}, patch = {}) {
		const { incident: row } = await createIncidentRecord(
			db,
			{ organizationId: org.id, creatorUserId: creator.user.id },
			{ title: 'N', description: 'D', client: 'C', ...values }
		);
		if (Object.keys(patch).length)
			await db.update(s.incidents).set(patch).where(eq(s.incidents.id, row.id));
		return row;
	}

	const A = await organization('Alfa');
	const B = await organization('Beta');
	const admin = await member(A.org, [A.admin]);
	const tech = await member(A.org, [A.tech]);
	const tech2 = await member(A.org, [A.tech]);
	const customer = await member(A.org, [A.customer]);
	const adminB = await member(B.org, [B.admin]);

	// =========================================================================
	// Catálogo y migración (50)
	// =========================================================================
	await t.test('catálogo: 7 eventos, defaults todos activados, validación estricta', () => {
		assert.deepEqual(
			[...NOTIFICATION_EVENT_TYPES],
			[
				'incident.assigned',
				'incident.unassigned',
				'incident.status_changed',
				'incident.public_comment_added',
				'incident.reopened',
				'sla.first_response_breached',
				'sla.resolution_breached'
			]
		);
		for (const type of NOTIFICATION_EVENT_TYPES) {
			assert.equal(events.NOTIFICATION_EVENT_DEFAULTS[type].inAppEnabled, true);
			assert.match(type, /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/, 'compatible con notifications.type');
		}
		for (const bad of ['incident.created', 'INCIDENT.ASSIGNED', '', null, 5, 'incident.assigned '])
			assert.equal(events.isNotificationEventType(bad), false, String(bad));
	});

	await t.test(
		'50. migración 0020 -> 0021: tabla, PK, FK compuesta con cascade, check; idempotente',
		async () => {
			const up = new PGlite();
			try {
				const journal = JSON.parse(
					fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')
				);
				const index = journal.entries.findIndex((e) => e.tag === '0021_notification_preferences');
				assert.ok(index > 0);
				await applyRange(up, 0, index - 1);
				const org = randomUUID();
				const user = randomUUID();
				await up.query(
					`INSERT INTO organizations (id, name, slug, status) VALUES ($1,'U',$2,'active')`,
					[org, 'u-' + org]
				);
				await up.query(`INSERT INTO users (id, name) VALUES ($1,'U')`, [user]);
				await up.query(`INSERT INTO memberships (organization_id, user_id) VALUES ($1,$2)`, [
					org,
					user
				]);
				await applyRange(up, index, index);
				await applyRange(up, index, index);
				assert.equal(
					(await up.query(`SELECT count(*)::int AS n FROM notification_preferences`)).rows[0].n,
					0,
					'sin filas por defecto'
				);
				const insert = (o, u, type, enabled = false) =>
					up.query(
						`INSERT INTO notification_preferences (organization_id, user_id, event_type, in_app_enabled) VALUES ($1,$2,$3,$4)`,
						[o, u, type, enabled]
					);
				await insert(org, user, 'incident.assigned');
				await assert.rejects(
					insert(org, user, 'incident.assigned'),
					/notification_preferences_pkey/
				);
				await assert.rejects(
					insert(org, randomUUID(), 'incident.assigned'),
					/notification_preferences_member_org_fk/
				);
				await assert.rejects(
					insert(org, user, 'Mal Tipo'),
					/notification_preferences_event_type_check/
				);
				await assert.rejects(
					up.query(
						`INSERT INTO notification_preferences (organization_id, user_id, event_type) VALUES ($1,$2,'incident.reopened')`,
						[org, user]
					),
					/null value/
				);
				const { rows } = await up.query(
					`SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'notification_preferences' ORDER BY ordinal_position`
				);
				assert.deepEqual(
					rows.map((r) => r.column_name),
					['organization_id', 'user_id', 'event_type', 'in_app_enabled', 'created_at', 'updated_at']
				);
				await up.query(`DELETE FROM memberships WHERE organization_id = $1 AND user_id = $2`, [
					org,
					user
				]);
				assert.equal(
					(await up.query(`SELECT count(*)::int AS n FROM notification_preferences`)).rows[0].n,
					0,
					'cascade con la membresía'
				);
			} finally {
				await up.close();
			}
		}
	);

	// =========================================================================
	// Servicio de preferencias (51-55)
	// =========================================================================
	await t.test(
		'51. sin filas: todos los eventos con default activado (isDefault true)',
		async () => {
			const list = await listNotificationPreferences(db, tech.ctx);
			assert.deepEqual(
				list,
				NOTIFICATION_EVENT_TYPES.map((eventType) => ({
					eventType,
					inAppEnabled: true,
					isDefault: true
				}))
			);
			for (const eventType of NOTIFICATION_EVENT_TYPES)
				assert.equal(await isNotificationEnabled(db, { ...tech.ctx, eventType }), true);
		}
	);

	await t.test(
		'52-53. set false/true explícitos, idempotente; reset vuelve al default e idempotente',
		async () => {
			const off = await setNotificationPreference(db, tech.ctx, 'incident.assigned', false);
			assert.deepEqual(off, {
				eventType: 'incident.assigned',
				inAppEnabled: false,
				isDefault: false
			});
			assert.equal(
				await isNotificationEnabled(db, { ...tech.ctx, eventType: 'incident.assigned' }),
				false
			);
			const [row1] = await db
				.select()
				.from(s.notificationPreferences)
				.where(eq(s.notificationPreferences.userId, tech.user.id));
			await setNotificationPreference(db, tech.ctx, 'incident.assigned', false);
			const [row2] = await db
				.select()
				.from(s.notificationPreferences)
				.where(eq(s.notificationPreferences.userId, tech.user.id));
			assert.equal(
				row2.updatedAt.getTime(),
				row1.updatedAt.getTime(),
				'mismo valor no mueve updatedAt'
			);
			const on = await setNotificationPreference(db, tech.ctx, 'incident.assigned', true);
			assert.deepEqual(
				on,
				{ eventType: 'incident.assigned', inAppEnabled: true, isDefault: false },
				'true explícito'
			);
			assert.equal(
				(
					await db
						.select()
						.from(s.notificationPreferences)
						.where(eq(s.notificationPreferences.userId, tech.user.id))
				).length,
				1
			);
			await setNotificationPreference(db, tech.ctx, 'incident.assigned', false);
			const reset = await resetNotificationPreference(db, tech.ctx, 'incident.assigned');
			assert.deepEqual(reset, {
				eventType: 'incident.assigned',
				inAppEnabled: true,
				isDefault: true
			});
			assert.deepEqual(await getNotificationPreference(db, tech.ctx, 'incident.assigned'), reset);
			assert.deepEqual(
				await resetNotificationPreference(db, tech.ctx, 'incident.assigned'),
				reset,
				'reset idempotente'
			);
		}
	);

	await t.test('evento desconocido y entradas inválidas: INVALID_INPUT sin escribir', async () => {
		for (const eventType of ['incident.created', 'x', '', null])
			await assert.rejects(
				setNotificationPreference(db, tech.ctx, eventType, false),
				(e) => e.code === 'INVALID_INPUT'
			);
		await assert.rejects(
			setNotificationPreference(db, tech.ctx, 'incident.assigned', 'false'),
			(e) => e.code === 'INVALID_INPUT'
		);
		await assert.rejects(
			isNotificationEnabled(db, { ...tech.ctx, eventType: 'nope' }),
			(e) => e.code === 'INVALID_INPUT'
		);
		await assert.rejects(
			listNotificationPreferences(db, { organizationId: 'x', userId: tech.user.id }),
			(e) => e.code === 'INVALID_INPUT'
		);
	});

	await t.test(
		'54. mismo usuario en dos orgs: la preferencia de una no afecta a la otra',
		async () => {
			const shared = await member(B.org, [B.tech], { user: tech.user });
			await setNotificationPreference(db, tech.ctx, 'incident.status_changed', false);
			assert.equal(
				await isNotificationEnabled(db, { ...tech.ctx, eventType: 'incident.status_changed' }),
				false
			);
			assert.equal(
				await isNotificationEnabled(db, { ...shared.ctx, eventType: 'incident.status_changed' }),
				true
			);
			const listB = await listNotificationPreferences(db, shared.ctx);
			assert.ok(listB.every((p) => p.isDefault));
			await resetNotificationPreference(db, tech.ctx, 'incident.status_changed');
		}
	);

	await t.test('55/9. membresía, usuario u org inactivos: sin acceso a preferencias', async () => {
		const idle = await member(A.org, [A.tech], { active: false });
		await assert.rejects(listNotificationPreferences(db, idle.ctx), (e) => e.code === 'FORBIDDEN');
		await assert.rejects(
			setNotificationPreference(db, idle.ctx, 'incident.assigned', false),
			(e) => e.code === 'FORBIDDEN'
		);
		const gone = await member(A.org, [A.tech]);
		await db.update(s.users).set({ active: false }).where(eq(s.users.id, gone.user.id));
		await assert.rejects(listNotificationPreferences(db, gone.ctx), (e) => e.code === 'FORBIDDEN');
		await assert.rejects(
			listNotificationPreferences(db, { organizationId: B.org.id, userId: customer.user.id }),
			(e) => e.code === 'FORBIDDEN',
			'no miembro'
		);
		const S = await organization('Suspendida');
		const sMember = await member(S.org, [S.tech]);
		await db
			.update(s.organizations)
			.set({ status: 'suspended' })
			.where(eq(s.organizations.id, S.org.id));
		await assert.rejects(
			listNotificationPreferences(db, sMember.ctx),
			(e) => e.code === 'FORBIDDEN'
		);
	});

	// =========================================================================
	// API (12-16, 47-49)
	// =========================================================================
	await t.test('API GET: preferencias efectivas propias; no-store; 401/403', async () => {
		await setNotificationPreference(db, customer.ctx, 'incident.public_comment_added', false);
		const res = await get(customer, A.org);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('cache-control'), 'private, no-store');
		assert.deepEqual(Object.keys(res.json), ['preferences']);
		assert.equal(res.json.preferences.length, NOTIFICATION_EVENT_TYPES.length);
		const comment = res.json.preferences.find(
			(p) => p.eventType === 'incident.public_comment_added'
		);
		assert.deepEqual(comment, {
			eventType: 'incident.public_comment_added',
			inAppEnabled: false,
			isDefault: false
		});
		assert.ok(!res.text.includes(customer.user.id) && !res.text.includes(A.org.id));
		await resetNotificationPreference(db, customer.ctx, 'incident.public_comment_added');
		assert.equal((await get(null, A.org)).status, 401);
		assert.equal((await get(customer, B.org)).status, 403, 'otra org');
		for (const query of [
			`organizationId=x`,
			`organizationId=${A.org.id}&userId=${tech.user.id}`,
			''
		])
			assert.equal((await get(customer, A.org, { query })).status, 400, query);
	});

	await t.test(
		'API PUT/DELETE: body estricto, evento canónico, Origin, sin userId; reset 204 idempotente',
		async () => {
			const ok = await put(tech2, A.org, 'sla.resolution_breached', { inAppEnabled: false });
			assert.equal(ok.status, 200, ok.text);
			assert.deepEqual(ok.json, {
				preference: { eventType: 'sla.resolution_breached', inAppEnabled: false, isDefault: false }
			});
			assert.equal(
				(await put(tech2, A.org, 'sla.resolution_breached', { inAppEnabled: false })).status,
				200,
				'idempotente'
			);
			for (const [body, extra] of [
				[{}, {}],
				[{ inAppEnabled: 'false' }, {}],
				[{ inAppEnabled: false, userId: tech.user.id }, {}],
				[{ inAppEnabled: false, organizationId: B.org.id }, {}],
				[undefined, { rawBody: '{bad' }],
				[undefined, { rawBody: `{"inAppEnabled":false,"p":"${'x'.repeat(300)}"}` }],
				[
					undefined,
					{ rawBody: 'inAppEnabled=false', contentType: 'application/x-www-form-urlencoded' }
				],
				[[false], {}]
			]) {
				const r = await put(tech2, A.org, 'incident.assigned', body, extra);
				assert.equal(r.status, 400, JSON.stringify(body ?? extra));
			}
			for (const eventType of ['incident.created', 'nope', 'INCIDENT.ASSIGNED'])
				assert.equal(
					(await put(tech2, A.org, eventType, { inAppEnabled: false })).status,
					400,
					eventType
				);
			assert.equal(
				(
					await put(
						tech2,
						A.org,
						'incident.assigned',
						{ inAppEnabled: false },
						{ origin: 'https://evil.example' }
					)
				).status,
				403
			);
			assert.equal(
				(await del(tech2, A.org, 'incident.assigned', { origin: 'https://evil.example' })).status,
				403
			);
			assert.equal(
				(await put(null, A.org, 'incident.assigned', { inAppEnabled: false })).status,
				401
			);
			assert.equal(
				(await put(tech2, B.org, 'incident.assigned', { inAppEnabled: false })).status,
				403,
				'org ajena'
			);
			const reset = await del(tech2, A.org, 'sla.resolution_breached');
			assert.equal(reset.status, 204);
			assert.equal(reset.text, '');
			assert.equal((await del(tech2, A.org, 'sla.resolution_breached')).status, 204, 'idempotente');
			assert.equal((await del(tech2, A.org, 'nope')).status, 400);
			assert.equal(
				(await del(tech2, A.org, 'incident.assigned', { rawBody: '{}' })).status,
				400,
				'DELETE sin body'
			);
			const after = await get(tech2, A.org);
			assert.ok(after.json.preferences.every((p) => p.isDefault && p.inAppEnabled));
			// otro usuario no se ve afectado
			assert.ok((await get(tech, A.org)).json.preferences.every((p) => p.isDefault));
			assert.deepEqual(Object.keys(collection).sort(), ['GET']);
			assert.deepEqual(Object.keys(item).sort(), ['DELETE', 'PUT']);
		}
	);

	// =========================================================================
	// Reglas de destinatarios (56-60)
	// =========================================================================
	await t.test(
		'56. incident.assigned: asignado recibe; actor=asignado excluido; inactivo/preferencia off excluidos',
		async () => {
			const inc = await incident(A.org, admin, {}, { assignedToUserId: tech.user.id });
			const ev = (actorUserId) => ({
				eventType: 'incident.assigned',
				organizationId: A.org.id,
				incidentId: inc.id,
				actorUserId
			});
			assert.deepEqual(await resolveNotificationRecipients(db, ev(admin.user.id)), [tech.user.id]);
			assert.deepEqual(
				await resolveNotificationRecipients(db, ev(tech.user.id)),
				[],
				'autoasignación'
			);
			await setNotificationPreference(db, tech.ctx, 'incident.assigned', false);
			assert.deepEqual(await resolveNotificationRecipients(db, ev(admin.user.id)), []);
			assert.deepEqual(
				await resolveCandidateRecipients(db, ev(admin.user.id)),
				[tech.user.id],
				'candidato antes de preferencias'
			);
			await resetNotificationPreference(db, tech.ctx, 'incident.assigned');
			await db
				.update(s.memberships)
				.set({ active: false })
				.where(eq(s.memberships.id, tech.membership.id));
			assert.deepEqual(
				await resolveNotificationRecipients(db, ev(admin.user.id)),
				[],
				'membresía inactiva'
			);
			await db
				.update(s.memberships)
				.set({ active: true })
				.where(eq(s.memberships.id, tech.membership.id));
			const noAssignee = await incident(A.org, admin);
			assert.deepEqual(
				await resolveNotificationRecipients(db, {
					...ev(admin.user.id),
					incidentId: noAssignee.id
				}),
				[]
			);
		}
	);

	await t.test(
		'23. incident.unassigned: asignado previo (miembro activo); actor excluido; ajeno/inactivo fuera',
		async () => {
			const inc = await incident(A.org, admin);
			const ev = (actorUserId, previousAssigneeUserId) => ({
				eventType: 'incident.unassigned',
				organizationId: A.org.id,
				incidentId: inc.id,
				actorUserId,
				previousAssigneeUserId
			});
			assert.deepEqual(await resolveNotificationRecipients(db, ev(admin.user.id, tech.user.id)), [
				tech.user.id
			]);
			assert.deepEqual(
				await resolveNotificationRecipients(db, ev(tech.user.id, tech.user.id)),
				[],
				'se desasignó él mismo'
			);
			assert.deepEqual(
				await resolveNotificationRecipients(db, ev(admin.user.id, adminB.user.id)),
				[],
				'no miembro de la org'
			);
			await assert.rejects(
				resolveNotificationRecipients(db, ev(admin.user.id, 'x')),
				(e) => e.code === 'INVALID_INPUT'
			);
		}
	);

	await t.test(
		'57. status_changed: solicitante + asignado salvo actor; mismo usuario una vez; nulls seguros',
		async () => {
			const inc = await incident(
				A.org,
				admin,
				{ clientUserId: customer.user.id },
				{ assignedToUserId: tech.user.id }
			);
			const ev = (actorUserId, incidentId = inc.id) => ({
				eventType: 'incident.status_changed',
				organizationId: A.org.id,
				incidentId,
				actorUserId
			});
			assert.deepEqual(
				await resolveNotificationRecipients(db, ev(admin.user.id)),
				[customer.user.id, tech.user.id].sort()
			);
			assert.deepEqual(await resolveNotificationRecipients(db, ev(tech.user.id)), [
				customer.user.id
			]);
			const selfServe = await incident(
				A.org,
				admin,
				{ clientUserId: tech.user.id },
				{ assignedToUserId: tech.user.id }
			);
			assert.deepEqual(
				await resolveNotificationRecipients(db, ev(admin.user.id, selfServe.id)),
				[tech.user.id],
				'deduplicado'
			);
			const empty = await incident(A.org, admin);
			assert.deepEqual(await resolveNotificationRecipients(db, ev(admin.user.id, empty.id)), []);
		}
	);

	await t.test(
		'58. comentario público: Customer -> asignado; staff -> solicitante; autor nunca; preferencias',
		async () => {
			const inc = await incident(
				A.org,
				admin,
				{ clientUserId: customer.user.id },
				{ assignedToUserId: tech.user.id }
			);
			const ev = (actorUserId) => ({
				eventType: 'incident.public_comment_added',
				organizationId: A.org.id,
				incidentId: inc.id,
				actorUserId
			});
			assert.deepEqual(await resolveNotificationRecipients(db, ev(customer.user.id)), [
				tech.user.id
			]);
			assert.deepEqual(await resolveNotificationRecipients(db, ev(tech.user.id)), [
				customer.user.id
			]);
			assert.deepEqual(
				await resolveNotificationRecipients(db, ev(admin.user.id)),
				[customer.user.id],
				'otro staff -> solicitante'
			);
			await setNotificationPreference(db, customer.ctx, 'incident.public_comment_added', false);
			assert.deepEqual(await resolveNotificationRecipients(db, ev(tech.user.id)), []);
			await resetNotificationPreference(db, customer.ctx, 'incident.public_comment_added');
			const noRequester = await incident(A.org, admin, {}, { assignedToUserId: tech.user.id });
			assert.deepEqual(
				await resolveNotificationRecipients(db, {
					...ev(tech.user.id),
					incidentId: noRequester.id
				}),
				[]
			);
			const noAssignee = await incident(A.org, admin, { clientUserId: customer.user.id });
			assert.deepEqual(
				await resolveNotificationRecipients(db, {
					...ev(customer.user.id),
					incidentId: noAssignee.id
				}),
				[]
			);
		}
	);

	await t.test(
		'59. reopened: asignado + solicitante, dedupe, sin actor, preferencias',
		async () => {
			const inc = await incident(
				A.org,
				admin,
				{ clientUserId: customer.user.id },
				{ assignedToUserId: tech.user.id }
			);
			const ev = (actorUserId) => ({
				eventType: 'incident.reopened',
				organizationId: A.org.id,
				incidentId: inc.id,
				actorUserId
			});
			assert.deepEqual(
				await resolveNotificationRecipients(db, ev(admin.user.id)),
				[customer.user.id, tech.user.id].sort()
			);
			assert.deepEqual(await resolveNotificationRecipients(db, ev(customer.user.id)), [
				tech.user.id
			]);
			await setNotificationPreference(db, tech.ctx, 'incident.reopened', false);
			assert.deepEqual(await resolveNotificationRecipients(db, ev(admin.user.id)), [
				customer.user.id
			]);
			await resetNotificationPreference(db, tech.ctx, 'incident.reopened');
		}
	);

	await t.test('60. SLA breach: solo el asignado, sin actor, sin difusión a Admins', async () => {
		const inc = await incident(
			A.org,
			admin,
			{ clientUserId: customer.user.id },
			{ assignedToUserId: tech.user.id }
		);
		for (const eventType of ['sla.first_response_breached', 'sla.resolution_breached']) {
			const ev = { eventType, organizationId: A.org.id, incidentId: inc.id };
			assert.deepEqual(await resolveNotificationRecipients(db, ev), [tech.user.id], eventType);
			assert.ok(!(await resolveNotificationRecipients(db, ev)).includes(admin.user.id));
		}
		await setNotificationPreference(db, tech.ctx, 'sla.resolution_breached', false);
		assert.deepEqual(
			await resolveNotificationRecipients(db, {
				eventType: 'sla.resolution_breached',
				organizationId: A.org.id,
				incidentId: inc.id
			}),
			[]
		);
		assert.deepEqual(
			await resolveNotificationRecipients(db, {
				eventType: 'sla.first_response_breached',
				organizationId: A.org.id,
				incidentId: inc.id
			}),
			[tech.user.id],
			'preferencia por evento'
		);
		const unassigned = await incident(A.org, admin, { clientUserId: customer.user.id });
		assert.deepEqual(
			await resolveNotificationRecipients(db, {
				eventType: 'sla.first_response_breached',
				organizationId: A.org.id,
				incidentId: unassigned.id
			}),
			[]
		);
	});

	await t.test(
		'30. inactivos excluidos: usuario inactivo, membresía inactiva, ya no miembro, org suspendida',
		async () => {
			const T = await organization('Inactivos');
			const adminT = await member(T.org, [T.admin]);
			const techT = await member(T.org, [T.tech]);
			const custT = await member(T.org, [T.customer]);
			const inc = await incident(
				T.org,
				adminT,
				{ clientUserId: custT.user.id },
				{ assignedToUserId: techT.user.id }
			);
			const ev = {
				eventType: 'incident.status_changed',
				organizationId: T.org.id,
				incidentId: inc.id,
				actorUserId: adminT.user.id
			};
			assert.equal((await resolveNotificationRecipients(db, ev)).length, 2);
			await db.update(s.users).set({ active: false }).where(eq(s.users.id, custT.user.id));
			assert.deepEqual(await resolveNotificationRecipients(db, ev), [techT.user.id]);
			await db
				.update(s.organizations)
				.set({ status: 'suspended' })
				.where(eq(s.organizations.id, T.org.id));
			assert.deepEqual(await resolveNotificationRecipients(db, ev), [], 'org suspendida');
		}
	);

	await t.test(
		'tenant: incidencia de otra org -> INCIDENT_NOT_FOUND; ids inválidos -> INVALID_INPUT',
		async () => {
			const incB = await incident(B.org, adminB);
			await assert.rejects(
				resolveNotificationRecipients(db, {
					eventType: 'incident.status_changed',
					organizationId: A.org.id,
					incidentId: incB.id,
					actorUserId: admin.user.id
				}),
				(e) => e.code === 'INCIDENT_NOT_FOUND'
			);
			await assert.rejects(
				resolveNotificationRecipients(db, {
					eventType: 'incident.status_changed',
					organizationId: A.org.id,
					incidentId: 'x',
					actorUserId: admin.user.id
				}),
				(e) => e.code === 'INVALID_INPUT'
			);
			await assert.rejects(
				resolveNotificationRecipients(db, {
					eventType: 'incident.created',
					organizationId: A.org.id,
					incidentId: incB.id,
					actorUserId: admin.user.id
				}),
				(e) => e.code === 'INVALID_INPUT'
			);
		}
	);

	await t.test(
		'61. lote: número de consultas constante con 1 o 40 candidatos (sin N+1)',
		async () => {
			const users = [];
			for (let i = 0; i < 40; i++) users.push((await member(A.org, [A.tech])).user.id);
			await setNotificationPreference(
				db,
				{ organizationId: A.org.id, userId: users[3] },
				'incident.reopened',
				false
			);
			const count = async (ids) => {
				let n = 0;
				const original = { query: pg.query, exec: pg.exec };
				pg.query = function (...args) {
					n++;
					return original.query.apply(this, args);
				};
				pg.exec = function (...args) {
					n++;
					return original.exec.apply(this, args);
				};
				try {
					const enabled = await filterUsersWithNotificationEnabled(db, {
						organizationId: A.org.id,
						eventType: 'incident.reopened',
						userIds: ids
					});
					return { n, enabled };
				} finally {
					pg.query = original.query;
					pg.exec = original.exec;
				}
			};
			const one = await count(users.slice(0, 1));
			const many = await count(users);
			assert.equal(one.n, many.n);
			assert.equal(many.enabled.length, 39);
			assert.ok(!many.enabled.includes(users[3]));
			const src = fs.readFileSync('src/lib/server/services/notification-recipients.ts', 'utf8');
			assert.ok(
				!/for \(const .* of candidates\)[\s\S]{0,80}await/.test(src),
				'sin bucles con await por candidato'
			);
		}
	);

	// =========================================================================
	// Fronteras U-C / U-D (64-65)
	// =========================================================================
	await t.test(
		'64-65. dominio solo vía producer; resolver y createNotification solo en el producer; sin email/outbox',
		() => {
			const read = (file) => fs.readFileSync('src/lib/server/services/' + file, 'utf8');
			const producerImport = /from '\.\/notification-producer'/;
			// 5.4U-C: exactly these domain services emit notifications, through the producer only
			for (const file of ['incidents.ts', 'incident-messages.ts'])
				assert.match(read(file), producerImport, `${file} usa el producer`);
			for (const file of [
				'incident-history.ts',
				'sla-compliance.ts',
				'invitations.ts',
				'invitation-acceptance.ts',
				'notification-recipients.ts',
				'notification-preferences.ts',
				'notifications.ts'
			])
				assert.doesNotMatch(read(file), producerImport, `${file} no produce notificaciones`);
			const domain = [
				'incidents.ts',
				'incident-messages.ts',
				'incident-history.ts',
				'sla-compliance.ts',
				'invitations.ts',
				'invitation-acceptance.ts',
				'notification-recipients.ts',
				'notification-preferences.ts'
			];
			for (const file of domain)
				assert.ok(!read(file).includes('createNotification'), `${file}: createNotification`);
			for (const file of domain.slice(0, 6))
				assert.ok(!read(file).includes('notification-recipients'), `${file} no invoca el resolver`);
			// the producer is the only bridge: resolver + createNotification, nothing else
			const producer = read('notification-producer.ts');
			assert.match(producer, /from '\.\/notifications'/);
			assert.match(producer, /from '\.\/notification-recipients'/);
			assert.doesNotMatch(producer, /catch\s*[({]/, 'sin catch-and-ignore');
			for (const file of fs.readdirSync('src/routes', { recursive: true }))
				if (/\.(ts|svelte)$/.test(String(file)))
					assert.ok(
						!/notification-producer|notification-recipients/.test(
							fs.readFileSync('src/routes/' + file, 'utf8')
						),
						String(file)
					);
			for (const dir of ['src/lib/server', 'src/routes/api'])
				for (const file of fs.readdirSync(dir, { recursive: true }))
					assert.ok(!/outbox|mailer|push|webhook|delivery/i.test(String(file)), String(file));
			const schema = fs.readFileSync('src/lib/server/db/schema/notifications.ts', 'utf8');
			assert.ok(!/email_enabled|emailEnabled/.test(schema), 'sin email en U-B');
		}
	);
});

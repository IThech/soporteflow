import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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
const MIN = 60_000;

test('SoporteFlow — Etapa 5.4U-D: entrega de notificaciones por email', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server, pg } = f;
	const { ensureOrganizationRoles } = await server.ssrLoadModule(
		'/src/lib/server/services/roles.ts'
	);
	const { createIncidentRecord, assignIncidentRecord, updateIncidentRecord } =
		await server.ssrLoadModule('/src/lib/server/services/incidents.ts');
	const { createPublicComment } = await server.ssrLoadModule(
		'/src/lib/server/services/incident-messages.ts'
	);
	const prefs = await server.ssrLoadModule('/src/lib/server/services/notification-preferences.ts');
	const inbox = await server.ssrLoadModule('/src/lib/server/services/notifications.ts');
	const delivery = await server.ssrLoadModule(
		'/src/lib/server/services/notification-deliveries.ts'
	);
	const email = await server.ssrLoadModule('/src/lib/server/email/notification-email.ts');
	const item = await server.ssrLoadModule(
		'/src/routes/api/notification-preferences/[eventType]/+server.ts'
	);
	const collection = await server.ssrLoadModule(
		'/src/routes/api/notification-preferences/+server.ts'
	);
	const {
		processDueNotificationDeliveries,
		claimDueDeliveries,
		markDeliverySent,
		deleteOldNotificationDeliveries,
		nextDeliveryAttemptAt,
		classifyEmailError,
		toEmailSubject,
		NOTIFICATION_DELIVERY_MAX_ATTEMPTS,
		NOTIFICATION_DELIVERY_LEASE_MS
	} = delivery;
	const { MemoryNotificationEmailSender, NotificationEmailError } = email;

	async function organization(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'ud-' + randomUUID(), status: 'active' })
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
	async function member(o, roles = [], { user } = {}) {
		const created = user
			? { user }
			: await createCredentialUser(f, { email: `ud-${randomUUID()}@example.test` });
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: o.org.id, userId: created.user.id, active: true })
			.returning();
		for (const role of roles)
			await db.insert(s.roleAssignments).values({
				organizationId: o.org.id,
				membershipId: membership.id,
				roleId: role.id,
				scopeType: 'organization'
			});
		const session = await createSession(f, created.user.id, {
			expiresAt: new Date(Date.now() + 3600000)
		});
		return {
			user: created.user,
			email: created.email,
			membership,
			cookie: session.cookieHeader,
			ctx: { organizationId: o.org.id, userId: created.user.id }
		};
	}
	async function incident(o, creator, patch = {}) {
		const { incident: row } = await createIncidentRecord(
			db,
			{ organizationId: o.org.id, creatorUserId: creator.user.id },
			{ title: 'Título confidencial', description: 'D', client: 'C' }
		);
		if (Object.keys(patch).length)
			await db.update(s.incidents).set(patch).where(eq(s.incidents.id, row.id));
		const [fresh] = await db.select().from(s.incidents).where(eq(s.incidents.id, row.id));
		return fresh;
	}
	const assign = (o, actor, inc, input) =>
		assignIncidentRecord(
			db,
			{ organizationId: o.org.id, actorUserId: actor.user.id },
			inc.id,
			input
		);
	const update = (o, actor, inc, input) =>
		updateIncidentRecord(
			db,
			{ organizationId: o.org.id, actorUserId: actor.user.id },
			inc.id,
			input
		);
	const comment = (o, actor, inc, body) =>
		createPublicComment(
			db,
			{ organizationId: o.org.id, incidentId: inc.id, actorUserId: actor.user.id },
			body
		);
	const setPref = (who, eventType, input) =>
		prefs.setNotificationPreference(db, who.ctx, eventType, input);
	const inboxFor = async (who, inc) =>
		(
			await db
				.select()
				.from(s.notifications)
				.where(
					and(
						eq(s.notifications.organizationId, who.ctx.organizationId),
						eq(s.notifications.recipientUserId, who.user.id)
					)
				)
		).filter((n) => !inc || n.payload?.incidentId === inc.id);
	const deliveriesFor = (who) =>
		db
			.select()
			.from(s.notificationDeliveries)
			.where(
				and(
					eq(s.notificationDeliveries.organizationId, who.ctx.organizationId),
					eq(s.notificationDeliveries.recipientUserId, who.user.id)
				)
			);
	const byId = async (id) =>
		(
			await db.select().from(s.notificationDeliveries).where(eq(s.notificationDeliveries.id, id))
		)[0];
	/** Drops every pending delivery so each processor test only sees its own rows. */
	const drain = () =>
		db.delete(s.notificationDeliveries).where(eq(s.notificationDeliveries.channel, 'email'));
	async function withFailing(table, run) {
		await pg.exec(`
			CREATE OR REPLACE FUNCTION ud_fail() RETURNS trigger AS $$
			BEGIN RAISE EXCEPTION 'ud forced failure'; END $$ LANGUAGE plpgsql;
			CREATE TRIGGER ud_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ud_fail();`);
		try {
			await run();
		} finally {
			await pg.exec(`DROP TRIGGER ud_fail ON ${table}; DROP FUNCTION ud_fail();`);
		}
	}
	async function call(handler, { method = 'GET', eventType, who, org, body }) {
		const suffix = eventType === undefined ? '' : `/${eventType}`;
		const url = new URL(`${ORIGIN}/api/notification-preferences${suffix}?organizationId=${org.id}`);
		const headers = new Headers({ origin: ORIGIN, cookie: who.cookie });
		if (body !== undefined) headers.set('content-type', 'application/json');
		const response = await handler({
			url,
			params: eventType === undefined ? {} : { eventType },
			request: new Request(url, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body)
			})
		});
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null };
	}

	/** Changes the sign-in address (auth_users.email must be one of the user's user_emails). */
	async function relogin(who, address) {
		await db.insert(s.userEmails).values({ userId: who.user.id, email: address });
		await db.update(s.authUsers).set({ email: address }).where(eq(s.authUsers.id, who.user.id));
	}

	const A = await organization('Alfa');
	const B = await organization('Beta');
	const admin = await member(A, [A.admin]);
	const tech = await member(A, [A.tech]);
	const customer = await member(A, [A.customer]);
	const adminB = await member(B, [B.admin]);

	// =========================================================================
	// Migración 0022
	// =========================================================================
	await t.test(
		'migración 0021 -> 0022: columnas, defaults, constraints, FKs, índices; idempotente',
		async () => {
			const up = new PGlite();
			try {
				const journal = JSON.parse(
					fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')
				);
				const index = journal.entries.findIndex((e) => e.tag === '0022_notification_delivery');
				assert.ok(index > 0);
				assert.equal(journal.entries[index - 1].tag, '0021_notification_preferences');
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
				await up.query(
					`INSERT INTO notification_preferences (organization_id, user_id, event_type, in_app_enabled) VALUES ($1,$2,'incident.assigned',false)`,
					[org, user]
				);
				await applyRange(up, index, index);
				await applyRange(up, index, index);
				const [existing] = (
					await up.query(`SELECT in_app_enabled, email_enabled FROM notification_preferences`)
				).rows;
				assert.deepEqual(existing, { in_app_enabled: false, email_enabled: null });
				await assert.rejects(
					up.query(
						`INSERT INTO notification_preferences (organization_id, user_id, event_type) VALUES ($1,$2,'incident.reopened')`,
						[org, user]
					),
					/notification_preferences_override_check/
				);
				await up.query(
					`INSERT INTO notification_preferences (organization_id, user_id, event_type, email_enabled) VALUES ($1,$2,'incident.reopened',true)`,
					[org, user]
				);
				const cols = (
					await up.query(
						`SELECT column_name FROM information_schema.columns WHERE table_name = 'notification_deliveries' ORDER BY ordinal_position`
					)
				).rows.map((r) => r.column_name);
				assert.deepEqual(cols, [
					'id',
					'organization_id',
					'recipient_user_id',
					'notification_id',
					'channel',
					'event_type',
					'title',
					'message',
					'status',
					'attempt_count',
					'next_attempt_at',
					'lease_token',
					'last_attempt_at',
					'sent_at',
					'failed_at',
					'last_error_code',
					'provider_message_id',
					'created_at',
					'updated_at'
				]);
				assert.ok(!cols.some((c) => /email|address|url|secret|response/.test(c)));
				const insert = (over = {}) => {
					const v = {
						organization_id: org,
						recipient_user_id: user,
						channel: 'email',
						event_type: 'incident.assigned',
						title: 'T',
						message: 'M',
						...over
					};
					const keys = Object.keys(v);
					return up.query(
						`INSERT INTO notification_deliveries (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
						Object.values(v)
					);
				};
				const { rows } = await insert();
				assert.equal(rows[0].status, 'pending');
				assert.equal(rows[0].attempt_count, 0);
				assert.ok(rows[0].next_attempt_at instanceof Date, 'pending: vencida al crear');
				for (const [over, constraint] of [
					[{ channel: 'webhook' }, 'notification_deliveries_channel_check'],
					[{ channel: 'push' }, 'notification_deliveries_channel_check'],
					[{ status: 'queued', next_attempt_at: null }, 'notification_deliveries_status_check'],
					[{ event_type: 'Mal Tipo' }, 'notification_deliveries_event_type_check'],
					[{ title: '  ' }, 'notification_deliveries_title_check'],
					[{ attempt_count: -1 }, 'notification_deliveries_attempt_count_check'],
					[{ attempt_count: 11 }, 'notification_deliveries_attempt_count_check'],
					[{ last_error_code: 'raw stack' }, 'notification_deliveries_error_code_check'],
					[{ status: 'sent' }, 'notification_deliveries_state_check'],
					[
						{ status: 'failed', next_attempt_at: null, failed_at: new Date() },
						'notification_deliveries_state_check'
					],
					[{ status: 'processing' }, 'notification_deliveries_state_check'],
					[{ next_attempt_at: null }, 'notification_deliveries_state_check'],
					[{ recipient_user_id: randomUUID() }, 'notification_deliveries_recipient_org_fk'],
					[{ notification_id: randomUUID() }, 'notification_deliveries_notification_fk']
				])
					await assert.rejects(insert(over), new RegExp(constraint), JSON.stringify(over));
				const indexes = (
					await up.query(
						`SELECT indexname FROM pg_indexes WHERE tablename = 'notification_deliveries' ORDER BY indexname`
					)
				).rows.map((r) => r.indexname);
				assert.deepEqual(indexes, [
					'notification_deliveries_due_idx',
					'notification_deliveries_pkey',
					'notification_deliveries_recipient_idx',
					'notification_deliveries_terminal_idx'
				]);
				await up.query(`DELETE FROM memberships WHERE organization_id = $1`, [org]);
				assert.equal(
					(await up.query(`SELECT count(*)::int AS n FROM notification_deliveries`)).rows[0].n,
					0,
					'cascade con la membresía'
				);
			} finally {
				await up.close();
			}
		}
	);

	// =========================================================================
	// Preferencias de email
	// =========================================================================
	await t.test('preferencias: email OFF por defecto e independiente de in-app', async () => {
		const who = await member(A, [A.tech]);
		const list = await prefs.listNotificationPreferences(db, who.ctx);
		for (const p of list) {
			assert.equal(p.inAppEnabled, true);
			assert.equal(p.emailEnabled, false);
			assert.equal(p.inAppIsDefault, true);
			assert.equal(p.emailIsDefault, true);
		}
		assert.deepEqual(await setPref(who, 'incident.assigned', { emailEnabled: true }), {
			eventType: 'incident.assigned',
			inAppEnabled: true,
			emailEnabled: true,
			inAppIsDefault: true,
			emailIsDefault: false
		});
		// cambiar in-app no toca el override de email
		assert.deepEqual(await setPref(who, 'incident.assigned', { inAppEnabled: false }), {
			eventType: 'incident.assigned',
			inAppEnabled: false,
			emailEnabled: true,
			inAppIsDefault: false,
			emailIsDefault: false
		});
		assert.equal(
			await prefs.isNotificationEnabled(db, {
				...who.ctx,
				eventType: 'incident.assigned',
				channel: 'email'
			}),
			true
		);
		assert.equal(
			await prefs.isNotificationEnabled(db, { ...who.ctx, eventType: 'incident.assigned' }),
			false
		);
		// null devuelve un canal a su default; con ambos a default la fila desaparece
		const partial = await setPref(who, 'incident.assigned', { emailEnabled: null });
		assert.equal(partial.emailEnabled, false);
		assert.equal(partial.emailIsDefault, true);
		assert.equal(partial.inAppIsDefault, false);
		await setPref(who, 'incident.assigned', { inAppEnabled: null });
		const rows = await db
			.select()
			.from(s.notificationPreferences)
			.where(eq(s.notificationPreferences.userId, who.user.id));
		assert.equal(rows.length, 0, 'sin overrides no hay fila');
		// reset borra ambos canales
		await setPref(who, 'incident.status_changed', { inAppEnabled: false, emailEnabled: true });
		const reset = await prefs.resetNotificationPreference(db, who.ctx, 'incident.status_changed');
		assert.equal(reset.emailEnabled, false);
		assert.equal(reset.inAppEnabled, true);
		assert.ok(reset.inAppIsDefault && reset.emailIsDefault);
		for (const bad of [{}, { emailEnabled: 'true' }, { emailEnabled: true, x: 1 }, true, null])
			await assert.rejects(
				setPref(who, 'incident.assigned', bad),
				(e) => e.code === 'INVALID_INPUT'
			);
		await assert.rejects(
			prefs.isNotificationEnabled(db, {
				...who.ctx,
				eventType: 'incident.assigned',
				channel: 'sms'
			}),
			(e) => e.code === 'INVALID_INPUT'
		);
	});

	await t.test(
		'preferencias multi-org: el email de una organización no afecta a la otra',
		async () => {
			const shared = await member(B, [B.tech], { user: tech.user });
			await setPref(tech, 'incident.assigned', { emailEnabled: true });
			try {
				assert.equal(
					(await prefs.getNotificationPreference(db, shared.ctx, 'incident.assigned')).emailEnabled,
					false
				);
			} finally {
				await prefs.resetNotificationPreference(db, tech.ctx, 'incident.assigned');
			}
		}
	);

	await t.test('API: GET expone ambos canales; PUT parcial estricto; DELETE resetea', async () => {
		const who = await member(A, [A.tech]);
		const get = await call(collection.GET, { who, org: A.org });
		assert.equal(get.status, 200);
		assert.deepEqual(Object.keys(get.json.preferences[0]).sort(), [
			'emailEnabled',
			'emailIsDefault',
			'eventType',
			'inAppEnabled',
			'inAppIsDefault'
		]);
		const put = (body) =>
			call(item.PUT, { method: 'PUT', who, org: A.org, eventType: 'incident.reopened', body });
		const ok = await put({ emailEnabled: true });
		assert.equal(ok.status, 200);
		assert.deepEqual(ok.json.preference, {
			eventType: 'incident.reopened',
			inAppEnabled: true,
			emailEnabled: true,
			inAppIsDefault: true,
			emailIsDefault: false
		});
		assert.equal(
			(await put({ inAppEnabled: false, emailEnabled: null })).json.preference.emailIsDefault,
			true
		);
		for (const bad of [
			{},
			{ emailEnabled: 'true' },
			{ emailEnabled: 1 },
			{ emailEnabled: true, email: 'x@example.test' },
			{ emailEnabled: true, userId: who.user.id },
			{ inAppEnabled: true, channel: 'email' }
		])
			assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
		const del = await call(item.DELETE, {
			method: 'DELETE',
			who,
			org: A.org,
			eventType: 'incident.reopened'
		});
		assert.equal(del.status, 204);
		const after = await call(collection.GET, { who, org: A.org });
		assert.ok(after.json.preferences.every((p) => p.inAppIsDefault && p.emailIsDefault));
	});

	// =========================================================================
	// Independencia de canales en el producer
	// =========================================================================
	await t.test('in-app ON / email OFF (default): bandeja sí, delivery no', async () => {
		const who = await member(A, [A.tech]);
		const inc = await incident(A, admin);
		await assign(A, admin, inc, { assignedToUserId: who.user.id });
		assert.equal((await inboxFor(who, inc)).length, 1);
		assert.equal((await deliveriesFor(who)).length, 0);
	});

	await t.test(
		'ambos ON: bandeja + delivery con snapshot y referencia a la notificación',
		async () => {
			const who = await member(A, [A.tech]);
			await setPref(who, 'incident.assigned', { emailEnabled: true });
			const inc = await incident(A, admin);
			await assign(A, admin, inc, { assignedToUserId: who.user.id });
			const [n] = await inboxFor(who, inc);
			const [d] = await deliveriesFor(who);
			assert.ok(n && d);
			assert.equal(d.notificationId, n.id);
			assert.equal(d.channel, 'email');
			assert.equal(d.status, 'pending');
			assert.equal(d.attemptCount, 0);
			assert.equal(d.eventType, 'incident.assigned');
			assert.equal(d.eventType, n.type);
			assert.equal(d.title, n.title);
			assert.equal(d.message, `Se te ha asignado la incidencia #${inc.incidentNumber}.`);
			assert.ok(!JSON.stringify(d).includes('Título confidencial'));
			assert.ok(!JSON.stringify(d).includes(who.email), 'sin snapshot de dirección');
		}
	);

	await t.test(
		'in-app OFF / email ON: sin fila de bandeja, sí delivery independiente',
		async () => {
			const who = await member(A, [A.tech]);
			await setPref(who, 'incident.assigned', { inAppEnabled: false, emailEnabled: true });
			const inc = await incident(A, admin);
			await assign(A, admin, inc, { assignedToUserId: who.user.id });
			assert.equal((await inboxFor(who)).length, 0, 'sin notificación oculta');
			const [d, ...rest] = await deliveriesFor(who);
			assert.equal(rest.length, 0);
			assert.equal(d.notificationId, null);
			assert.equal(d.title, 'Incidencia asignada');
			assert.equal(
				await inbox.countUnreadNotifications(db, {
					organizationId: A.org.id,
					recipientUserId: who.user.id
				}),
				0
			);
		}
	);

	await t.test('ambos OFF: nada, y la mutación de dominio se completa', async () => {
		const who = await member(A, [A.tech]);
		await setPref(who, 'incident.assigned', { inAppEnabled: false, emailEnabled: false });
		const inc = await incident(A, admin);
		const res = await assign(A, admin, inc, { assignedToUserId: who.user.id });
		assert.equal(res.incident.assignedToUserId, who.user.id);
		assert.equal((await inboxFor(who)).length, 0);
		assert.equal((await deliveriesFor(who)).length, 0);
	});

	await t.test('actor excluido antes de canales; miembro inactivo sin delivery', async () => {
		const self = await member(A, [A.tech]);
		await setPref(self, 'incident.assigned', { emailEnabled: true });
		const inc = await incident(A, admin);
		await assign(A, self, inc, { assignedToUserId: self.user.id });
		assert.equal((await inboxFor(self)).length, 0);
		assert.equal((await deliveriesFor(self)).length, 0);

		const gone = await member(A, [A.tech]);
		await setPref(gone, 'incident.unassigned', { emailEnabled: true });
		const inc2 = await incident(A, admin, { assignedToUserId: gone.user.id });
		await db
			.update(s.memberships)
			.set({ active: false })
			.where(eq(s.memberships.id, gone.membership.id));
		await assign(A, admin, inc2, { assignedToUserId: tech.user.id, reason: 'Baja' });
		assert.equal((await deliveriesFor(gone)).length, 0);
	});

	await t.test('comentario y cambio de estado también generan intents; sin cuerpo', async () => {
		await setPref(customer, 'incident.public_comment_added', { emailEnabled: true });
		await setPref(customer, 'incident.status_changed', { emailEnabled: true });
		try {
			const inc = await incident(A, admin, {
				clientUserId: customer.user.id,
				assignedToUserId: tech.user.id
			});
			const secret = '<script>alert(1)</script> clave=hunter2';
			await comment(A, tech, inc, secret);
			await update(A, admin, inc, { status: 'pending' });
			const list = (await deliveriesFor(customer)).filter((d) =>
				d.message.includes(`#${inc.incidentNumber}`)
			);
			assert.deepEqual(list.map((d) => d.eventType).sort(), [
				'incident.public_comment_added',
				'incident.status_changed'
			]);
			assert.ok(!JSON.stringify(list).includes('hunter2'));
			assert.ok(!JSON.stringify(list).includes('<script>'));
		} finally {
			await prefs.resetNotificationPreference(db, customer.ctx, 'incident.public_comment_added');
			await prefs.resetNotificationPreference(db, customer.ctx, 'incident.status_changed');
		}
	});

	// =========================================================================
	// Atomicidad del intent
	// =========================================================================
	await t.test(
		'fallo al persistir el intent revierte asignación, estado y comentario',
		async () => {
			await setPref(customer, 'incident.public_comment_added', { emailEnabled: true });
			await setPref(customer, 'incident.status_changed', { emailEnabled: true });
			const who = await member(A, [A.tech]);
			await setPref(who, 'incident.assigned', { emailEnabled: true });
			try {
				const inc = await incident(A, admin, { clientUserId: customer.user.id });
				await withFailing('notification_deliveries', async () => {
					await assert.rejects(assign(A, admin, inc, { assignedToUserId: who.user.id }));
					await assert.rejects(update(A, admin, inc, { status: 'pending' }));
					await assert.rejects(comment(A, tech, inc, 'Hola'));
				});
				const [after] = await db.select().from(s.incidents).where(eq(s.incidents.id, inc.id));
				assert.equal(after.assignedToUserId, null);
				assert.equal(after.status, 'open');
				assert.equal(after.firstResponseAt, null);
				assert.equal((await inboxFor(who, inc)).length, 0, 'la notificación in-app también');
				assert.equal((await inboxFor(customer, inc)).length, 0);
				const messages = await db
					.select()
					.from(s.incidentMessages)
					.where(eq(s.incidentMessages.incidentId, inc.id));
				assert.equal(messages.length, 0);
				const history = await db
					.select()
					.from(s.incidentHistory)
					.where(eq(s.incidentHistory.incidentId, inc.id));
				assert.ok(!history.some((h) => ['assigned', 'status_changed'].includes(h.eventType)));
				// sin email habilitado, la misma mutación no depende de la tabla de deliveries
				await prefs.resetNotificationPreference(db, who.ctx, 'incident.assigned');
				await withFailing('notification_deliveries', () =>
					assign(A, admin, inc, { assignedToUserId: who.user.id })
				);
			} finally {
				await prefs.resetNotificationPreference(db, customer.ctx, 'incident.public_comment_added');
				await prefs.resetNotificationPreference(db, customer.ctx, 'incident.status_changed');
			}
		}
	);

	// =========================================================================
	// Processor
	// =========================================================================
	async function queued(recipient = null) {
		const who = recipient ?? (await member(A, [A.tech]));
		await setPref(who, 'incident.assigned', { emailEnabled: true });
		const inc = await incident(A, admin);
		await assign(A, admin, inc, { assignedToUserId: who.user.id });
		const [d] = await deliveriesFor(who);
		return { who, inc, d };
	}
	const future = (ms = 0) => new Date(Date.now() + 10 * MIN + ms);

	await t.test('éxito: un único email, contenido correcto, sent; no se reenvía', async () => {
		await drain();
		const { who, inc, d } = await queued();
		const sender = new MemoryNotificationEmailSender();
		const now = future();
		assert.deepEqual(await processDueNotificationDeliveries(db, { now, sender }), {
			claimed: 1,
			sent: 1,
			retried: 0,
			failed: 0,
			leaseLost: 0
		});
		assert.deepEqual(sender.sent, [
			{
				to: who.email,
				subject: 'Incidencia asignada',
				text: `Se te ha asignado la incidencia #${inc.incidentNumber}.`
			}
		]);
		const row = await byId(d.id);
		assert.equal(row.status, 'sent');
		assert.equal(row.sentAt.getTime(), now.getTime());
		assert.equal(row.attemptCount, 1);
		assert.equal(row.nextAttemptAt, null);
		assert.equal(row.leaseToken, null);
		assert.equal(row.providerMessageId, 'memory-1');
		assert.deepEqual(await processDueNotificationDeliveries(db, { now: future(MIN), sender }), {
			claimed: 0,
			sent: 0,
			retried: 0,
			failed: 0,
			leaseLost: 0
		});
		assert.equal(sender.sent.length, 1);
		assert.equal((await inboxFor(who, inc)).length, 1, 'sin notificación duplicada');
	});

	await t.test(
		'provider no configurado: fallo permanente seguro; dominio y bandeja intactos',
		async () => {
			await drain();
			const { who, inc, d } = await queued();
			const result = await processDueNotificationDeliveries(db, { now: future() });
			assert.equal(result.failed, 1);
			const row = await byId(d.id);
			assert.equal(row.status, 'failed');
			assert.equal(row.lastErrorCode, 'PROVIDER_NOT_CONFIGURED');
			assert.ok(row.failedAt);
			const [after] = await db.select().from(s.incidents).where(eq(s.incidents.id, inc.id));
			assert.equal(after.assignedToUserId, who.user.id);
			assert.equal((await inboxFor(who, inc)).length, 1);
		}
	);

	await t.test(
		'reintento transitorio: backoff, sin reenvío antes de tiempo, misma fila -> sent',
		async () => {
			await drain();
			const { d } = await queued();
			const sender = new MemoryNotificationEmailSender();
			sender.failures.push(
				new NotificationEmailError('NETWORK_ERROR', 'ECONNRESET 10.0.0.1 secret')
			);
			const t0 = future();
			assert.equal((await processDueNotificationDeliveries(db, { now: t0, sender })).retried, 1);
			let row = await byId(d.id);
			assert.equal(row.status, 'retry');
			assert.equal(row.attemptCount, 1);
			assert.equal(row.lastErrorCode, 'NETWORK_ERROR');
			assert.equal(row.nextAttemptAt.getTime(), t0.getTime() + MIN);
			assert.ok(!JSON.stringify(row).includes('ECONNRESET'), 'sin error crudo');
			assert.equal(
				(
					await processDueNotificationDeliveries(db, {
						now: new Date(t0.getTime() + 30_000),
						sender
					})
				).claimed,
				0
			);
			const t1 = new Date(t0.getTime() + MIN);
			assert.equal((await processDueNotificationDeliveries(db, { now: t1, sender })).sent, 1);
			row = await byId(d.id);
			assert.equal(row.status, 'sent');
			assert.equal(row.attemptCount, 2);
			assert.equal(row.lastErrorCode, null);
			assert.equal(sender.sent.length, 1);
			assert.equal(
				(
					await deliveriesFor({
						ctx: { organizationId: A.org.id },
						user: { id: row.recipientUserId }
					})
				).length,
				1
			);
		}
	);

	await t.test(
		'máximo de intentos: 5 fallos transitorios -> failed MAX_ATTEMPTS, sin más reintentos',
		async () => {
			await drain();
			const { d } = await queued();
			const sender = new MemoryNotificationEmailSender();
			let now = future();
			const seen = [];
			for (let attempt = 1; attempt <= NOTIFICATION_DELIVERY_MAX_ATTEMPTS; attempt++) {
				sender.failures.push(new NotificationEmailError('RATE_LIMITED'));
				const result = await processDueNotificationDeliveries(db, { now, sender });
				assert.equal(result.claimed, 1, `intento ${attempt}`);
				const row = await byId(d.id);
				seen.push([row.status, row.attemptCount]);
				if (row.nextAttemptAt) now = row.nextAttemptAt;
			}
			assert.deepEqual(seen, [
				['retry', 1],
				['retry', 2],
				['retry', 3],
				['retry', 4],
				['failed', 5]
			]);
			const row = await byId(d.id);
			assert.equal(row.lastErrorCode, 'MAX_ATTEMPTS');
			assert.equal(sender.sent.length, 0);
			assert.equal(
				(
					await processDueNotificationDeliveries(db, {
						now: new Date(now.getTime() + 24 * 60 * MIN),
						sender
					})
				).claimed,
				0
			);
		}
	);

	await t.test(
		'fallos permanentes y errores desconocidos se clasifican con códigos seguros',
		async () => {
			await drain();
			const { d } = await queued();
			const sender = new MemoryNotificationEmailSender();
			sender.failures.push(new NotificationEmailError('RECIPIENT_INVALID'));
			await processDueNotificationDeliveries(db, { now: future(), sender });
			const row = await byId(d.id);
			assert.deepEqual(
				[row.status, row.lastErrorCode, row.attemptCount],
				['failed', 'RECIPIENT_INVALID', 1]
			);

			const raw = new Error('provider said: 550 <user@x> password=abc');
			assert.deepEqual(classifyEmailError(raw), { code: 'PROVIDER_ERROR', transient: true });
			assert.deepEqual(classifyEmailError({ name: 'NotificationEmailError', code: 'DROP TABLE' }), {
				code: 'PROVIDER_ERROR',
				transient: true
			});
			assert.deepEqual(classifyEmailError(new NotificationEmailError('PROVIDER_NOT_CONFIGURED')), {
				code: 'PROVIDER_NOT_CONFIGURED',
				transient: false
			});
			await drain();
			const second = await queued();
			sender.failures.push(raw);
			await processDueNotificationDeliveries(db, { now: future(), sender });
			const after = await byId(second.d.id);
			assert.equal(after.status, 'retry');
			assert.equal(after.lastErrorCode, 'PROVIDER_ERROR');
			assert.ok(!JSON.stringify(after).includes('password'));
		}
	);

	await t.test(
		'destinatario sin email válido o inactivo: fallo permanente, sin envío ni rollback',
		async () => {
			await drain();
			const sender = new MemoryNotificationEmailSender();
			const bad = await queued();
			await relogin(bad.who, `bad address ${randomUUID()}`);
			const inactive = await queued();
			await db
				.update(s.memberships)
				.set({ active: false })
				.where(eq(s.memberships.id, inactive.who.membership.id));
			const result = await processDueNotificationDeliveries(db, { now: future(), sender });
			assert.equal(result.failed, 2);
			assert.equal(sender.sent.length, 0);
			assert.equal((await byId(bad.d.id)).lastErrorCode, 'RECIPIENT_INVALID');
			assert.equal((await byId(inactive.d.id)).lastErrorCode, 'RECIPIENT_INACTIVE');
			const [kept] = await db.select().from(s.incidents).where(eq(s.incidents.id, bad.inc.id));
			assert.equal(kept.assignedToUserId, bad.who.user.id);
		}
	);

	await t.test(
		'la dirección se lee al enviar (sin snapshot) y la bandeja borrada no rompe el envío',
		async () => {
			await drain();
			const { who, inc, d } = await queued();
			const changed = `nuevo-${randomUUID()}@example.test`;
			await relogin(who, changed);
			const [n] = await inboxFor(who, inc);
			await inbox.deleteNotification(
				db,
				{ organizationId: A.org.id, recipientUserId: who.user.id },
				n.id
			);
			assert.equal((await byId(d.id)).notificationId, null, 'SET NULL al borrar de la bandeja');
			const sender = new MemoryNotificationEmailSender();
			await processDueNotificationDeliveries(db, { now: future(), sender });
			assert.deepEqual(
				sender.sent.map((m) => m.to),
				[changed]
			);
		}
	);

	await t.test(
		'claim/lease: sin doble claim, recuperación tras expirar, token antiguo no escribe',
		async () => {
			await drain();
			const { d } = await queued();
			const now = future();
			const [first] = await claimDueDeliveries(db, { now });
			assert.equal(first.id, d.id);
			assert.equal(first.attemptCount, 1);
			assert.equal((await claimDueDeliveries(db, { now })).length, 0, 'ya reclamada');
			assert.equal(
				(
					await claimDueDeliveries(db, {
						now: new Date(now.getTime() + NOTIFICATION_DELIVERY_LEASE_MS - 1)
					})
				).length,
				0
			);
			const later = new Date(now.getTime() + NOTIFICATION_DELIVERY_LEASE_MS);
			const [second] = await claimDueDeliveries(db, { now: later });
			assert.equal(second.id, d.id);
			assert.notEqual(second.leaseToken, first.leaseToken);
			assert.equal(second.attemptCount, 2);
			assert.equal(
				await markDeliverySent(db, { id: d.id, leaseToken: first.leaseToken, now: later }),
				false
			);
			assert.equal(
				await markDeliverySent(db, { id: d.id, leaseToken: second.leaseToken, now: later }),
				true
			);
			assert.equal(
				await markDeliverySent(db, { id: d.id, leaseToken: second.leaseToken, now: later }),
				false,
				'sin replay'
			);
			assert.equal((await byId(d.id)).status, 'sent');
		}
	);

	await t.test('lease expirado en el último intento -> failed MAX_ATTEMPTS', async () => {
		await drain();
		const { d } = await queued();
		const now = future();
		await db
			.update(s.notificationDeliveries)
			.set({
				status: 'processing',
				leaseToken: randomUUID(),
				attemptCount: NOTIFICATION_DELIVERY_MAX_ATTEMPTS,
				nextAttemptAt: now
			})
			.where(eq(s.notificationDeliveries.id, d.id));
		assert.equal((await claimDueDeliveries(db, { now })).length, 0);
		const row = await byId(d.id);
		assert.deepEqual([row.status, row.lastErrorCode], ['failed', 'MAX_ATTEMPTS']);
	});

	await t.test('límites del processor: default 25, máximo 100, lote acotado', async () => {
		await drain();
		for (let i = 0; i < 3; i++) await queued();
		assert.equal((await claimDueDeliveries(db, { now: future(), limit: 2 })).length, 2);
		for (const limit of [0, 101, 1.5, -1, '5'])
			await assert.rejects(
				claimDueDeliveries(db, { now: future(), limit }),
				(e) => e.code === 'INVALID_INPUT'
			);
		await assert.rejects(
			claimDueDeliveries(db, { now: new Date('x') }),
			(e) => e.code === 'INVALID_INPUT'
		);
		assert.equal(delivery.NOTIFICATION_DELIVERY_DEFAULT_LIMIT, 25);
		assert.equal(delivery.NOTIFICATION_DELIVERY_MAX_LIMIT, 100);
	});

	await t.test('política de reintentos determinista', () => {
		const now = new Date('2026-01-01T00:00:00Z');
		assert.deepEqual(
			[1, 2, 3, 4, 5, 6].map(
				(n) => nextDeliveryAttemptAt(n, now)?.getTime() - now.getTime() || null
			),
			[MIN, 5 * MIN, 30 * MIN, 120 * MIN, null, null]
		);
	});

	await t.test('contenido: asunto de una línea (sin inyección de cabeceras), texto plano', () => {
		assert.equal(toEmailSubject('Hola\r\nBcc: x@evil.test'), 'Hola Bcc: x@evil.test');
		assert.equal(toEmailSubject('a\u0000b\tc'), 'a b c');
		for (const bad of ['a@b', 'x y@b.c', 'a@b.c\r\nBcc: z@z.z', '<a@b.c>', 'a,b@c.d', ''])
			assert.equal(delivery.isDeliverableEmailAddress(bad), false, bad);
		assert.equal(delivery.isDeliverableEmailAddress('user.name+tag@example.test'), true);
	});

	await t.test('retención: solo sent/failed antiguos; pendientes y bandeja intactos', async () => {
		await drain();
		const sender = new MemoryNotificationEmailSender();
		const sent = await queued();
		await processDueNotificationDeliveries(db, { now: future(), sender });
		const pending = await queued();
		const cutoff = future(MIN);
		assert.equal(await deleteOldNotificationDeliveries(db, { before: future(-MIN) }), 0);
		assert.equal(await deleteOldNotificationDeliveries(db, { before: cutoff }), 1);
		assert.equal(await byId(sent.d.id), undefined);
		assert.ok(await byId(pending.d.id));
		assert.equal((await inboxFor(sent.who, sent.inc)).length, 1);
		await assert.rejects(
			deleteOldNotificationDeliveries(db, { before: 'ayer' }),
			(e) => e.code === 'INVALID_INPUT'
		);
	});

	await t.test('multi-tenant: deliveries por organización; destinatario multi-org', async () => {
		await drain();
		const local = await member(A, [A.tech]);
		const shared = await member(B, [B.tech], { user: local.user });
		await setPref(shared, 'incident.assigned', { emailEnabled: true });
		const incB = await incident(B, adminB);
		await assign(B, adminB, incB, { assignedToUserId: local.user.id });
		assert.equal((await deliveriesFor(shared)).length, 1);
		assert.equal((await deliveriesFor(local)).length, 0, 'org A sin email habilitado');
	});

	await t.test('5.4W-A H2: un email del lote recuperado por otro worker no se envía', async () => {
		await drain();
		await queued();
		await queued();
		let startedA;
		const started = new Promise((r) => (startedA = r));
		let openGate;
		const gate = new Promise((r) => (openGate = r));
		const sentA = [];
		const senderA = {
			sendNotification: async (message) => {
				sentA.push(message.to);
				if (sentA.length === 1) {
					startedA();
					await gate;
				}
				return { providerMessageId: 'a' };
			}
		};
		const now = future();
		const runA = processDueNotificationDeliveries(db, { now, sender: senderA, limit: 2 });
		await started;
		const senderB = new MemoryNotificationEmailSender();
		const resultB = await processDueNotificationDeliveries(db, {
			now: new Date(now.getTime() + NOTIFICATION_DELIVERY_LEASE_MS + 1000),
			sender: senderB
		});
		openGate();
		const resultA = await runA;
		assert.deepEqual([resultB.claimed, resultB.sent], [2, 2]);
		assert.equal(resultA.leaseLost, 2);
		assert.equal(sentA.length, 1, 'A no envía el email que B ya había reclamado');
	});

	await t.test(
		'5.4W-A H2: un proveedor colgado agota el timeout y queda en reintento',
		async () => {
			await drain();
			const { d } = await queued();
			const hung = { sendNotification: () => new Promise(() => {}) };
			const result = await processDueNotificationDeliveries(db, {
				now: future(),
				sender: hung,
				sendTimeoutMs: 50
			});
			assert.equal(result.retried, 1);
			const row = await byId(d.id);
			assert.deepEqual([row.status, row.lastErrorCode], ['retry', 'NETWORK_ERROR']);
			assert.equal(delivery.NOTIFICATION_EMAIL_SEND_TIMEOUT_MS, 30_000);
		}
	);

	await t.test('fronteras: sin webhooks, n8n, cron, logs de contenido ni API pública', () => {
		const files = [
			'src/lib/server/services/notification-deliveries.ts',
			'src/lib/server/email/notification-email.ts',
			'src/lib/server/services/notification-producer.ts'
		];
		for (const file of files) {
			const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
			assert.doesNotMatch(code, /setInterval|cron|webhook|n8n|hmac|console\./i, file);
			assert.doesNotMatch(code, /fetch\(/, file);
			// 5.4W-A: the only timer allowed is the bounded provider-call timeout (no scheduling)
			const timers = code.match(/setTimeout\(/g) ?? [];
			if (file.endsWith('notification-deliveries.ts')) {
				assert.equal(timers.length, 1, 'single send-timeout timer');
				assert.match(code, /clearTimeout\(timer\)/);
			} else assert.equal(timers.length, 0, file);
		}
		for (const file of fs.readdirSync('src/routes', { recursive: true }))
			if (/\.(ts|svelte)$/.test(String(file)))
				assert.doesNotMatch(
					fs.readFileSync('src/routes/' + file, 'utf8'),
					/notification-deliveries|notification-email|processDueNotificationDeliveries/,
					String(file)
				);
		assert.ok(!fs.existsSync('src/routes/api/notification-deliveries'));
		const dto = fs.readFileSync('src/lib/api/notifications.ts', 'utf8');
		assert.doesNotMatch(dto, /email/i, 'sin email en el DTO de la bandeja');
	});
});

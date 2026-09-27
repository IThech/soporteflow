import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { fixture, directory, createCredentialUser } from './helpers/auth-fixture.mjs';

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

const DAY = 24 * 60 * 60_000;

test('SoporteFlow — Etapa 5.4V-A: eventos canónicos de automatización', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server, pg } = f;
	const { ensureOrganizationRoles } = await server.ssrLoadModule(
		'/src/lib/server/services/roles.ts'
	);
	const { createSlaPolicy } = await server.ssrLoadModule(
		'/src/lib/server/services/sla-policies.ts'
	);
	const incidentsService = await server.ssrLoadModule('/src/lib/server/services/incidents.ts');
	const {
		createIncidentRecord,
		assignIncidentRecord,
		updateIncidentRecord,
		updateIncidentSupportLevel,
		changeIncidentSite,
		changeIncidentCategory
	} = incidentsService;
	const { createPublicComment, createInternalNote } = await server.ssrLoadModule(
		'/src/lib/server/services/incident-messages.ts'
	);
	const prefs = await server.ssrLoadModule('/src/lib/server/services/notification-preferences.ts');
	const store = await server.ssrLoadModule('/src/lib/server/services/automation-events.ts');
	const producer = await server.ssrLoadModule(
		'/src/lib/server/services/automation-event-producer.ts'
	);
	const catalog = await server.ssrLoadModule('/src/lib/automation/events.ts');
	const { listAutomationEventsInternal, getAutomationEventInternal } = store;

	async function organization(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'va-' + randomUUID(), status: 'active' })
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
		const u =
			user ?? (await createCredentialUser(f, { email: `va-${randomUUID()}@example.test` })).user;
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: o.org.id, userId: u.id, active: true })
			.returning();
		for (const role of roles)
			await db.insert(s.roleAssignments).values({
				organizationId: o.org.id,
				membershipId: membership.id,
				roleId: role.id,
				scopeType: 'organization'
			});
		return { user: u, membership, ctx: { organizationId: o.org.id, userId: u.id } };
	}
	const secretTitle = 'Título privado ' + randomUUID();
	const secretDescription = 'Descripción con datos sensibles ' + randomUUID();
	async function create(o, creator, input = {}) {
		return (
			await createIncidentRecord(
				db,
				{ organizationId: o.org.id, creatorUserId: creator.user.id },
				{
					title: secretTitle,
					description: secretDescription,
					client: 'Cliente Privado SL',
					...input
				}
			)
		).incident;
	}
	async function incident(o, creator, patch = {}, input = {}) {
		const row = await create(o, creator, input);
		if (Object.keys(patch).length)
			await db.update(s.incidents).set(patch).where(eq(s.incidents.id, row.id));
		const [fresh] = await db.select().from(s.incidents).where(eq(s.incidents.id, row.id));
		return fresh;
	}
	const ctx = (o, actor) => ({ organizationId: o.org.id, actorUserId: actor.user.id });
	const assign = (o, actor, inc, input) => assignIncidentRecord(db, ctx(o, actor), inc.id, input);
	const update = (o, actor, inc, input) => updateIncidentRecord(db, ctx(o, actor), inc.id, input);
	const comment = (o, actor, inc, body, supportResponse = false) =>
		createPublicComment(
			db,
			{ organizationId: o.org.id, incidentId: inc.id, actorUserId: actor.user.id, supportResponse },
			body
		);
	const note = (o, actor, inc, body) =>
		createInternalNote(
			db,
			{ organizationId: o.org.id, incidentId: inc.id, actorUserId: actor.user.id },
			body
		);
	/** Events of one incident, in position order. */
	const eventsOf = async (o, inc) =>
		(
			await listAutomationEventsInternal(db, {
				organizationId: o.org.id,
				aggregateId: inc.id,
				limit: 200
			})
		).events;
	const typesOf = async (o, inc) => (await eventsOf(o, inc)).map((e) => e.eventType);
	const since = async (o, inc, before) => (await eventsOf(o, inc)).slice(before.length);
	async function withFailing(table, run, when = 'true') {
		await pg.exec(`
			CREATE OR REPLACE FUNCTION va_fail() RETURNS trigger AS $$
			BEGIN RAISE EXCEPTION 'va forced failure'; END $$ LANGUAGE plpgsql;
			CREATE TRIGGER va_fail BEFORE INSERT ON ${table} FOR EACH ROW WHEN (${when})
				EXECUTE FUNCTION va_fail();`);
		try {
			await run();
		} finally {
			await pg.exec(`DROP TRIGGER va_fail ON ${table}; DROP FUNCTION va_fail();`);
		}
	}
	const historyOf = (inc) =>
		db.select().from(s.incidentHistory).where(eq(s.incidentHistory.incidentId, inc.id));
	const notificationsOf = async (inc) =>
		(await db.select().from(s.notifications)).filter((n) => n.payload?.incidentId === inc.id);
	const reload = async (inc) =>
		(await db.select().from(s.incidents).where(eq(s.incidents.id, inc.id)))[0];

	const A = await organization('Alfa');
	const B = await organization('Beta');
	const admin = await member(A, [A.admin]);
	const techA = await member(A, [A.tech]);
	const techB = await member(A, [A.tech]);
	const customer = await member(A, [A.customer]);
	const adminB = await member(B, [B.admin]);
	const policy = await createSlaPolicy(db, A.org.id, {
		code: 'std',
		name: 'Std',
		firstResponseMinutes: 60,
		resolutionMinutes: 120,
		isDefault: true
	});
	const [siteMadrid] = await db
		.insert(s.sites)
		.values({ organizationId: A.org.id, name: 'Madrid' })
		.returning();
	const [siteValencia] = await db
		.insert(s.sites)
		.values({ organizationId: A.org.id, name: 'Valencia' })
		.returning();
	const [hardware] = await db
		.insert(s.categories)
		.values({ organizationId: A.org.id, name: 'Hardware' })
		.returning();

	// =========================================================================
	// Esquema / migración 0023
	// =========================================================================
	await t.test(
		'migración 0022 -> 0023: tabla, checks, FKs, índices, trigger; idempotente',
		async () => {
			const up = new PGlite();
			try {
				const journal = JSON.parse(
					fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')
				);
				const index = journal.entries.findIndex((e) => e.tag === '0023_automation_events');
				assert.equal(journal.entries[index - 1].tag, '0022_notification_delivery');
				await applyRange(up, 0, index);
				await applyRange(up, index, index);
				const org = randomUUID();
				const user = randomUUID();
				await up.query(
					`INSERT INTO organizations (id, name, slug, status) VALUES ($1,'U',$2,'active')`,
					[org, 'u-' + org]
				);
				await up.query(`INSERT INTO users (id, name) VALUES ($1,'U')`, [user]);
				const cols = (
					await up.query(
						`SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'automation_events' ORDER BY ordinal_position`
					)
				).rows;
				assert.deepEqual(
					cols.map((c) => c.column_name),
					[
						'id',
						'position',
						'organization_id',
						'event_type',
						'schema_version',
						'aggregate_type',
						'aggregate_id',
						'actor_user_id',
						'payload',
						'occurred_at',
						'created_at'
					]
				);
				assert.equal(cols.find((c) => c.column_name === 'schema_version').column_default, '1');
				assert.equal(cols.find((c) => c.column_name === 'actor_user_id').is_nullable, 'YES');
				assert.equal(cols.find((c) => c.column_name === 'payload').is_nullable, 'NO');
				const insert = (over = {}) => {
					const v = {
						organization_id: org,
						event_type: 'incident.created',
						aggregate_type: 'incident',
						aggregate_id: randomUUID(),
						actor_user_id: user,
						payload: JSON.stringify({ incidentId: 'x' }),
						occurred_at: new Date(),
						...over
					};
					const keys = Object.keys(v);
					return up.query(
						`INSERT INTO automation_events (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
						Object.values(v)
					);
				};
				const first = (await insert()).rows[0];
				const second = (await insert()).rows[0];
				assert.equal(first.schema_version, 1);
				assert.ok(Number(second.position) > Number(first.position), 'posición creciente');
				for (const [over, constraint] of [
					[{ event_type: 'Incident Created' }, 'automation_events_event_type_check'],
					[{ event_type: 'incident' }, 'automation_events_event_type_check'],
					[{ aggregate_type: 'Incident!' }, 'automation_events_aggregate_type_check'],
					[{ schema_version: 0 }, 'automation_events_schema_version_check'],
					[{ payload: JSON.stringify([1]) }, 'automation_events_payload_check'],
					[{ payload: JSON.stringify('x') }, 'automation_events_payload_check'],
					[
						{ payload: JSON.stringify({ big: 'x'.repeat(9000) }) },
						'automation_events_payload_check'
					],
					[{ organization_id: randomUUID() }, 'automation_events_organization_fk'],
					[{ actor_user_id: randomUUID() }, 'automation_events_actor_fk']
				])
					await assert.rejects(
						insert(over),
						new RegExp(constraint),
						JSON.stringify(over).slice(0, 80)
					);
				await assert.rejects(insert({ position: 999 }), /GENERATED ALWAYS|cannot insert/i);
				// append-only: UPDATE rejected; only the FK SET NULL of the actor is allowed
				await assert.rejects(
					up.query(`UPDATE automation_events SET payload = '{}'::jsonb WHERE id = $1`, [first.id]),
					/append-only/
				);
				await assert.rejects(
					up.query(`UPDATE automation_events SET event_type = 'incident.deleted' WHERE id = $1`, [
						first.id
					]),
					/append-only/
				);
				await up.query(`DELETE FROM users WHERE id = $1`, [user]);
				const after = (await up.query(`SELECT actor_user_id FROM automation_events`)).rows;
				assert.ok(
					after.every((r) => r.actor_user_id === null),
					'actor SET NULL, hecho conservado'
				);
				const indexes = (
					await up.query(
						`SELECT indexname FROM pg_indexes WHERE tablename = 'automation_events' ORDER BY indexname`
					)
				).rows.map((r) => r.indexname);
				assert.deepEqual(indexes, [
					'automation_events_aggregate_idx',
					'automation_events_org_position_idx',
					'automation_events_pkey',
					'automation_events_position_unique'
				]);
				await up.query(`DELETE FROM organizations WHERE id = $1`, [org]);
				assert.equal(
					(await up.query(`SELECT count(*)::int AS n FROM automation_events`)).rows[0].n,
					0,
					'cascade con la organización'
				);
			} finally {
				await up.close();
			}
		}
	);

	await t.test('catálogo propio, distinto del de notificaciones; schemaVersion 1', async () => {
		const notifications = await server.ssrLoadModule('/src/lib/notifications/events.ts');
		assert.equal(catalog.AUTOMATION_EVENT_SCHEMA_VERSION, 1);
		for (const type of [
			'incident.created',
			'incident.internal_note_added',
			'incident.priority_changed',
			'incident.category_changed',
			'incident.site_changed',
			'incident.support_level_changed',
			'incident.team_changed',
			'sla.first_response_met',
			'sla.resolution_met'
		]) {
			assert.ok(catalog.isAutomationEventType(type), type);
			assert.ok(!notifications.isNotificationEventType(type), `${type} no es notificación`);
		}
		for (const type of catalog.AUTOMATION_EVENT_TYPES)
			assert.match(type, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
		assert.equal(catalog.isAutomationEventType('incident.deleted'), false);
		const source = fs.readFileSync('src/lib/automation/events.ts', 'utf8');
		assert.doesNotMatch(source, /^import /m, 'sin dependencias');
	});

	// =========================================================================
	// Creación
	// =========================================================================
	await t.test(
		'incident.created: exactamente uno, envelope y payload mínimos sin PII',
		async () => {
			const inc = await create(A, admin, {
				clientUserId: customer.user.id,
				priority: 'high',
				siteId: siteMadrid.id,
				categoryId: hardware.id
			});
			const events = await eventsOf(A, inc);
			assert.equal(events.length, 1);
			const [e] = events;
			assert.match(e.id, /^[0-9a-f-]{36}$/);
			assert.deepEqual(
				{ ...e, id: undefined, position: undefined },
				{
					id: undefined,
					position: undefined,
					organizationId: A.org.id,
					eventType: 'incident.created',
					schemaVersion: 1,
					aggregateType: 'incident',
					aggregateId: inc.id,
					actorUserId: admin.user.id,
					occurredAt: inc.createdAt.toISOString(),
					payload: {
						incidentId: inc.id,
						incidentNumber: inc.incidentNumber,
						status: 'open',
						priority: 'high',
						supportLevel: 'N1',
						requesterUserId: customer.user.id,
						categoryId: hardware.id,
						siteId: siteMadrid.id,
						slaPolicyId: policy.id
					}
				}
			);
			const raw = JSON.stringify(e);
			for (const leak of [secretTitle, secretDescription, 'Cliente Privado', '@example.test'])
				assert.ok(!raw.includes(leak), leak);
			assert.deepEqual(
				await getAutomationEventInternal(db, { organizationId: A.org.id, id: e.id }),
				e
			);
		}
	);

	// =========================================================================
	// Asignación
	// =========================================================================
	await t.test('asignación: null->A, A->B ordenado, A->null, A->A sin evento', async () => {
		const inc = await incident(A, admin);
		let before = await eventsOf(A, inc);
		await assign(A, admin, inc, { assignedToUserId: techA.user.id });
		let added = await since(A, inc, before);
		assert.deepEqual(
			added.map((e) => [e.eventType, e.payload]),
			[
				[
					'incident.assigned',
					{
						incidentId: inc.id,
						incidentNumber: inc.incidentNumber,
						previousAssigneeUserId: null,
						assignedToUserId: techA.user.id
					}
				]
			]
		);

		before = await eventsOf(A, inc);
		await assign(A, admin, inc, { assignedToUserId: techA.user.id, reason: 'igual' });
		assert.equal((await since(A, inc, before)).length, 0, 'A->A: no-op');

		await assign(A, admin, inc, { assignedToUserId: techB.user.id, reason: 'Relevo' });
		added = await since(A, inc, before);
		assert.deepEqual(
			added.map((e) => [e.eventType, e.payload.previousAssigneeUserId, e.payload.assignedToUserId]),
			[
				['incident.unassigned', techA.user.id, undefined],
				['incident.assigned', techA.user.id, techB.user.id]
			]
		);
		assert.ok(added[0].position < added[1].position);
		assert.equal(added[0].occurredAt, added[1].occurredAt, 'mismo instante de la mutación');

		before = await eventsOf(A, inc);
		await assign(A, admin, inc, { assignedToUserId: null, reason: 'Sin técnico' });
		assert.deepEqual(
			(await since(A, inc, before)).map((e) => [e.eventType, e.payload.previousAssigneeUserId]),
			[['incident.unassigned', techB.user.id]]
		);
	});

	await t.test(
		'cambio solo de equipo: incident.team_changed, sin eventos de asignado',
		async () => {
			const inc = await incident(A, admin, { assignedToUserId: techA.user.id });
			const [team] = await db
				.insert(s.teams)
				.values({ organizationId: A.org.id, name: 'Equipo ' + randomUUID(), active: true })
				.returning();
			await db
				.insert(s.teamMemberships)
				.values({ organizationId: A.org.id, teamId: team.id, membershipId: techA.membership.id });
			const before = await eventsOf(A, inc);
			await assign(A, admin, inc, { teamId: team.id, reason: 'Equipo' });
			assert.deepEqual(
				(await since(A, inc, before)).map((e) => [
					e.eventType,
					e.payload.previousTeamId,
					e.payload.newTeamId
				]),
				[['incident.team_changed', null, team.id]]
			);
		}
	);

	// =========================================================================
	// Estado / reapertura / prioridad
	// =========================================================================
	await t.test('estado: un evento; reopen solo reopened; mismo estado sin evento', async () => {
		const inc = await incident(A, admin);
		let before = await eventsOf(A, inc);
		await update(A, admin, inc, { status: 'pending' });
		assert.deepEqual(
			(await since(A, inc, before)).map((e) => [
				e.eventType,
				e.payload.previousStatus,
				e.payload.newStatus
			]),
			[['incident.status_changed', 'open', 'pending']]
		);
		before = await eventsOf(A, inc);
		await update(A, admin, inc, { status: 'pending' });
		assert.equal((await since(A, inc, before)).length, 0);
		await update(A, admin, inc, { status: 'resolved' });
		await update(A, admin, inc, { status: 'closed' });
		before = await eventsOf(A, inc);
		await update(A, admin, inc, { status: 'open' });
		const reopened = await since(A, inc, before);
		assert.deepEqual(
			reopened.map((e) => [e.eventType, e.payload]),
			[
				[
					'incident.reopened',
					{
						incidentId: inc.id,
						incidentNumber: inc.incidentNumber,
						previousStatus: 'closed',
						newStatus: 'open'
					}
				]
			],
			'sin status_changed duplicado'
		);
	});

	await t.test('prioridad: solo cambio real; estado + prioridad en orden', async () => {
		const inc = await incident(A, admin, {}, { priority: 'low' });
		let before = await eventsOf(A, inc);
		await update(A, admin, inc, { priority: 'low' });
		assert.equal((await since(A, inc, before)).length, 0);
		await update(A, admin, inc, { status: 'pending', priority: 'urgent' });
		assert.deepEqual(
			(await since(A, inc, before)).map((e) => e.eventType),
			['incident.status_changed', 'incident.priority_changed']
		);
		const [, priority] = await since(A, inc, before);
		assert.equal(priority.payload.previousPriority, 'low');
		assert.equal(priority.payload.newPriority, 'urgent');
	});

	// =========================================================================
	// Atributos
	// =========================================================================
	await t.test(
		'categoría, sede y nivel de soporte: previo/nuevo reales, no-op sin evento',
		async () => {
			const inc = await incident(A, admin);
			const before = await eventsOf(A, inc);
			await changeIncidentCategory(db, ctx(A, admin), inc.id, { categoryId: hardware.id });
			await changeIncidentCategory(db, ctx(A, admin), inc.id, {
				categoryId: hardware.id,
				reason: 'x'
			});
			await changeIncidentSite(db, ctx(A, admin), inc.id, { siteId: siteMadrid.id });
			await changeIncidentSite(db, ctx(A, admin), inc.id, {
				siteId: siteValencia.id,
				reason: 'Traslado'
			});
			await changeIncidentSite(db, ctx(A, admin), inc.id, { siteId: siteValencia.id, reason: 'x' });
			await updateIncidentSupportLevel(db, ctx(A, admin), inc.id, {
				supportLevel: 'N2',
				reason: 'Escalado'
			});
			await updateIncidentSupportLevel(db, ctx(A, admin), inc.id, {
				supportLevel: 'N2',
				reason: 'x'
			});
			assert.deepEqual(
				(await since(A, inc, before)).map((e) => {
					const { incidentId, incidentNumber, ...rest } = e.payload;
					assert.equal(incidentId, inc.id);
					assert.equal(incidentNumber, inc.incidentNumber);
					return [e.eventType, rest];
				}),
				[
					['incident.category_changed', { previousCategoryId: null, newCategoryId: hardware.id }],
					['incident.site_changed', { previousSiteId: null, newSiteId: siteMadrid.id }],
					['incident.site_changed', { previousSiteId: siteMadrid.id, newSiteId: siteValencia.id }],
					['incident.support_level_changed', { previousSupportLevel: 'N1', newSupportLevel: 'N2' }]
				]
			);
		}
	);

	// =========================================================================
	// Mensajes y SLA observado
	// =========================================================================
	await t.test(
		'comentario público y nota interna: id del mensaje, nunca el contenido',
		async () => {
			const inc = await incident(A, admin, { clientUserId: customer.user.id });
			const before = await eventsOf(A, inc);
			const secret = 'contraseña del router hunter2 ' + randomUUID();
			const pub = await comment(A, customer, inc, secret);
			const internal = await note(A, techA, inc, 'nota interna ' + secret);
			const added = await since(A, inc, before);
			assert.deepEqual(
				added.map((e) => [e.eventType, e.actorUserId, e.payload]),
				[
					[
						'incident.public_comment_added',
						customer.user.id,
						{ incidentId: inc.id, incidentNumber: inc.incidentNumber, messageId: pub.id }
					],
					[
						'incident.internal_note_added',
						techA.user.id,
						{ incidentId: inc.id, incidentNumber: inc.incidentNumber, messageId: internal.id }
					]
				]
			);
			assert.ok(!JSON.stringify(added).includes('hunter2'));
			// cada mensaje es un hecho nuevo
			await comment(A, customer, inc, secret);
			assert.equal((await since(A, inc, before)).length, 3);
		}
	);

	await t.test(
		'SLA observado al actuar: first_response met/breached una sola vez; resolución',
		async () => {
			const onTime = await incident(A, admin, {
				clientUserId: customer.user.id,
				assignedToUserId: techA.user.id
			});
			let before = await eventsOf(A, onTime);
			await comment(A, techA, onTime, 'Primera respuesta', true);
			await comment(A, techA, onTime, 'Segunda respuesta', true);
			const added = await since(A, onTime, before);
			assert.deepEqual(
				added.map((e) => e.eventType),
				[
					'incident.public_comment_added',
					'sla.first_response_met',
					'incident.public_comment_added'
				],
				'first-write-wins: un único resultado SLA'
			);
			const sla = added[1];
			const row = await reload(onTime);
			assert.deepEqual(sla.payload, {
				incidentId: onTime.id,
				incidentNumber: onTime.incidentNumber,
				slaPolicyId: policy.id,
				dueAt: row.firstResponseDueAt.toISOString(),
				achievedAt: row.firstResponseAt.toISOString(),
				observedBy: 'action'
			});

			// incidente con SLA vencido hace un día: el retraso se observa al responder / resolver
			const past = new Date(Date.now() - DAY);
			const late = await incident(A, admin, {
				clientUserId: customer.user.id,
				slaAppliedAt: past,
				firstResponseDueAt: new Date(past.getTime() + 60 * 60_000),
				resolutionDueAt: new Date(past.getTime() + 120 * 60_000)
			});
			before = await eventsOf(A, late);
			assert.equal(before.filter((e) => e.eventType.startsWith('sla.')).length, 0, 'sin scheduler');
			await comment(A, techA, late, 'Tarde', true);
			await update(A, techA, late, { status: 'resolved' });
			await update(A, techA, late, { status: 'open' });
			await update(A, techA, late, { status: 'resolved' });
			assert.deepEqual(
				(await since(A, late, before)).map((e) => e.eventType),
				[
					'incident.public_comment_added',
					'sla.first_response_breached',
					'incident.status_changed',
					'sla.resolution_breached',
					'incident.reopened',
					'incident.status_changed'
				]
			);
			// historial SLA y evento de automatización coinciden
			const history = (await historyOf(late)).map((h) => h.eventType);
			assert.ok(history.includes('sla_first_response_breached'));
			assert.ok(history.includes('sla_resolution_breached'));
		}
	);

	// =========================================================================
	// Independencia de notificaciones / preferencias
	// =========================================================================
	await t.test(
		'preferencias in-app y email OFF no suprimen eventos de automatización',
		async () => {
			const who = await member(A, [A.tech]);
			for (const eventType of ['incident.assigned', 'incident.status_changed'])
				await prefs.setNotificationPreference(db, who.ctx, eventType, {
					inAppEnabled: false,
					emailEnabled: false
				});
			const inc = await incident(A, admin);
			const before = await eventsOf(A, inc);
			await assign(A, admin, inc, { assignedToUserId: who.user.id });
			await update(A, admin, inc, { status: 'pending' });
			assert.deepEqual(
				(await since(A, inc, before)).map((e) => e.eventType),
				['incident.assigned', 'incident.status_changed']
			);
			assert.equal((await notificationsOf(inc)).length, 0);
		}
	);

	await t.test(
		'flujo representativo: dominio + historial + evento + notificación + intent email',
		async () => {
			const who = await member(A, [A.tech]);
			await prefs.setNotificationPreference(db, who.ctx, 'incident.assigned', {
				emailEnabled: true
			});
			const inc = await incident(A, admin);
			await assign(A, admin, inc, { assignedToUserId: who.user.id });
			assert.equal((await reload(inc)).assignedToUserId, who.user.id);
			assert.ok((await historyOf(inc)).some((h) => h.eventType === 'assigned'));
			assert.ok((await typesOf(A, inc)).includes('incident.assigned'));
			assert.equal((await notificationsOf(inc)).length, 1);
			const deliveries = await db
				.select()
				.from(s.notificationDeliveries)
				.where(eq(s.notificationDeliveries.recipientUserId, who.user.id));
			assert.equal(deliveries.length, 1);
		}
	);

	// =========================================================================
	// Atomicidad
	// =========================================================================
	await t.test('fallo del evento revierte creación, asignación, estado y mensajes', async () => {
		const countIncidents = async () => (await db.select().from(s.incidents)).length;
		const n = await countIncidents();
		await withFailing('automation_events', () => assert.rejects(create(A, admin)));
		assert.equal(await countIncidents(), n, 'creación revertida (incidente + historial)');

		const inc = await incident(A, admin, { clientUserId: customer.user.id });
		const history = (await historyOf(inc)).length;
		const events = (await eventsOf(A, inc)).length;
		await withFailing('automation_events', async () => {
			await assert.rejects(assign(A, admin, inc, { assignedToUserId: techA.user.id }));
			await assert.rejects(update(A, admin, inc, { status: 'pending' }));
			await assert.rejects(comment(A, techA, inc, 'Hola', true));
			await assert.rejects(note(A, techA, inc, 'Interna'));
		});
		const after = await reload(inc);
		assert.equal(after.assignedToUserId, null);
		assert.equal(after.status, 'open');
		assert.equal(after.firstResponseAt, null);
		assert.equal((await historyOf(inc)).length, history);
		assert.equal((await eventsOf(A, inc)).length, events);
		assert.equal((await notificationsOf(inc)).length, 0);
		const messages = await db
			.select()
			.from(s.incidentMessages)
			.where(eq(s.incidentMessages.incidentId, inc.id));
		assert.equal(messages.length, 0);
	});

	await t.test(
		'reasignación A->B: si falla el 2º evento se revierte todo (1er evento incluido)',
		async () => {
			const inc = await incident(A, admin, { assignedToUserId: techA.user.id });
			const events = (await eventsOf(A, inc)).length;
			await withFailing(
				'automation_events',
				() =>
					assert.rejects(assign(A, admin, inc, { assignedToUserId: techB.user.id, reason: 'R' })),
				`NEW.event_type = 'incident.assigned'`
			);
			assert.equal((await reload(inc)).assignedToUserId, techA.user.id);
			assert.equal((await eventsOf(A, inc)).length, events, 'unassigned revertido');
			assert.equal((await notificationsOf(inc)).length, 0);
			assert.ok(!(await historyOf(inc)).some((h) => h.eventType === 'reassigned'));
		}
	);

	await t.test('fallo de la notificación revierte también el evento (y viceversa)', async () => {
		const who = await member(A, [A.tech]);
		await prefs.setNotificationPreference(db, who.ctx, 'incident.assigned', { emailEnabled: true });
		const inc = await incident(A, admin);
		const events = (await eventsOf(A, inc)).length;
		await withFailing('notifications', () =>
			assert.rejects(assign(A, admin, inc, { assignedToUserId: who.user.id }))
		);
		assert.equal((await eventsOf(A, inc)).length, events);
		await withFailing('notification_deliveries', () =>
			assert.rejects(assign(A, admin, inc, { assignedToUserId: who.user.id }))
		);
		assert.equal((await eventsOf(A, inc)).length, events);
		await withFailing('automation_events', () =>
			assert.rejects(assign(A, admin, inc, { assignedToUserId: who.user.id }))
		);
		assert.equal((await notificationsOf(inc)).length, 0);
		const deliveries = await db
			.select()
			.from(s.notificationDeliveries)
			.where(eq(s.notificationDeliveries.recipientUserId, who.user.id));
		assert.equal(deliveries.length, 0);
		assert.equal((await reload(inc)).assignedToUserId, null);
	});

	// =========================================================================
	// Tenant / producer / store
	// =========================================================================
	await t.test(
		'multi-tenant: listados y lecturas por organización; producer rechaza otra org',
		async () => {
			const shared = await member(B, [B.tech], { user: techA.user });
			const incB = await incident(B, adminB);
			await assign(B, adminB, incB, { assignedToUserId: shared.user.id });
			const eventsB = await eventsOf(B, incB);
			assert.ok(eventsB.every((e) => e.organizationId === B.org.id));
			const pageA = await listAutomationEventsInternal(db, {
				organizationId: A.org.id,
				limit: 200
			});
			assert.ok(pageA.events.every((e) => e.organizationId === A.org.id));
			assert.ok(!pageA.events.some((e) => e.aggregateId === incB.id));
			await assert.rejects(
				getAutomationEventInternal(db, { organizationId: A.org.id, id: eventsB[0].id }),
				(e) => e.code === 'AUTOMATION_EVENT_NOT_FOUND'
			);
			await assert.rejects(
				producer.recordIncidentAutomationEvents(db, {
					organizationId: A.org.id,
					incidentId: incB.id,
					actorUserId: admin.user.id,
					occurredAt: new Date(),
					facts: [{ eventType: 'incident.created' }]
				}),
				(e) => e.code === 'INCIDENT_NOT_FOUND'
			);
		}
	);

	await t.test('producer: hechos inválidos o no-op rechazados antes de escribir', async () => {
		const inc = await incident(A, admin);
		const base = {
			organizationId: A.org.id,
			incidentId: inc.id,
			actorUserId: admin.user.id,
			occurredAt: new Date()
		};
		const before = (await eventsOf(A, inc)).length;
		for (const facts of [
			[],
			[{ eventType: 'incident.deleted' }],
			[{ eventType: 'incident.status_changed', previousStatus: 'open', newStatus: 'open' }],
			[{ eventType: 'incident.priority_changed', previousPriority: 'low', newPriority: 'extreme' }],
			[
				{
					eventType: 'incident.assigned',
					previousAssigneeUserId: techA.user.id,
					assignedToUserId: techA.user.id
				}
			],
			[{ eventType: 'incident.reopened', previousStatus: 'pending' }],
			[{ eventType: 'incident.public_comment_added', messageId: 'x' }],
			[
				{ eventType: 'incident.status_changed', previousStatus: 'open', newStatus: 'pending' },
				{ eventType: 'incident.site_changed', previousSiteId: null, newSiteId: null }
			]
		])
			await assert.rejects(
				producer.recordIncidentAutomationEvents(db, { ...base, facts }),
				(e) => e.code === 'INVALID_INPUT',
				JSON.stringify(facts)
			);
		await assert.rejects(
			producer.recordIncidentAutomationEvents(db, {
				...base,
				occurredAt: 'hoy',
				facts: [{ eventType: 'incident.created' }]
			}),
			(e) => e.code === 'INVALID_INPUT'
		);
		assert.equal((await eventsOf(A, inc)).length, before, 'nada escrito');
		await assert.rejects(
			store.appendAutomationEvent(db, {
				...base,
				eventType: 'incident.created',
				aggregateType: 'incident',
				aggregateId: inc.id,
				payload: { incidentId: inc.id, body: { nested: true } }
			}),
			(e) => e.code === 'INVALID_INPUT',
			'payload plano'
		);
	});

	await t.test('listado interno: cursor por posición, límites acotados', async () => {
		const inc = await incident(A, admin);
		await update(A, admin, inc, { status: 'pending' });
		await update(A, admin, inc, { status: 'open' });
		const first = await listAutomationEventsInternal(db, {
			organizationId: A.org.id,
			aggregateId: inc.id,
			limit: 2
		});
		assert.equal(first.events.length, 2);
		assert.equal(first.nextPosition, first.events[1].position);
		const rest = await listAutomationEventsInternal(db, {
			organizationId: A.org.id,
			aggregateId: inc.id,
			afterPosition: first.nextPosition
		});
		assert.deepEqual(
			[...first.events, ...rest.events].map((e) => e.eventType),
			['incident.created', 'incident.status_changed', 'incident.status_changed']
		);
		assert.equal(rest.nextPosition, null);
		for (const bad of [{ limit: 0 }, { limit: 201 }, { afterPosition: -1 }, { aggregateId: 'x' }])
			await assert.rejects(
				listAutomationEventsInternal(db, { organizationId: A.org.id, ...bad }),
				(e) => e.code === 'INVALID_INPUT'
			);
	});

	await t.test('inmutabilidad: sin API de update/delete; UPDATE directo rechazado', async () => {
		const exported = Object.keys(store);
		assert.ok(!exported.some((k) => /update|delete|remove|purge/i.test(k)), exported.join());
		const inc = await incident(A, admin);
		const [e] = await eventsOf(A, inc);
		await assert.rejects(
			db
				.update(s.automationEvents)
				.set({ payload: { incidentId: 'x' } })
				.where(eq(s.automationEvents.id, e.id)),
			(err) => /append-only/.test(String(err?.cause ?? err))
		);
		assert.deepEqual((await eventsOf(A, inc))[0], e);
	});

	// =========================================================================
	// Fronteras V-A / V-B / V-C / V-D
	// =========================================================================
	await t.test(
		'fronteras: dominio solo vía producers; sin ejecución inline, n8n ni scheduler',
		() => {
			const read = (file) => fs.readFileSync('src/lib/server/services/' + file, 'utf8');
			const strip = (code) => code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
			for (const file of ['incidents.ts', 'incident-messages.ts']) {
				const source = read(file);
				assert.match(source, /from '\.\/automation-event-producer'/, file);
				assert.doesNotMatch(
					source,
					/from '\.\/automation-events'/,
					`${file}: no usa el store directo`
				);
				assert.doesNotMatch(source, /webhook|n8n|automation-rule/i, file);
			}
			// hermanos: ninguno importa al otro
			assert.doesNotMatch(read('notification-producer.ts'), /from '\.\/automation/);
			assert.doesNotMatch(read('automation-event-producer.ts'), /from '\.\/notification/);
			for (const file of ['automation-events.ts', 'automation-event-producer.ts']) {
				const code = strip(read(file));
				// 5.4V-B: the producer may only reach webhooks through the DB-only fanout (no HTTP here)
				assert.doesNotMatch(
					code.replace(/fanoutWebhookDeliveries|'\.\/webhook-fanout'/g, ''),
					/fetch\(|webhook|hmac|n8n|setInterval|setTimeout|cron|console\./i,
					file
				);
				assert.doesNotMatch(code, /\.transaction\(/, `${file}: sin transacciones anidadas propias`);
			}
			for (const file of fs.readdirSync('src/routes', { recursive: true }))
				if (/\.(ts|svelte)$/.test(String(file)))
					assert.doesNotMatch(
						fs.readFileSync('src/routes/' + file, 'utf8'),
						/automation-event|automation\/events|appendAutomationEvent/,
						String(file)
					);
			for (const dir of ['src/lib', 'src/routes'])
				for (const file of fs.readdirSync(dir, { recursive: true }))
					assert.doesNotMatch(
						String(file),
						// 5.4V-B: outbound webhook files are expected now; rules, n8n, schedulers are not
						/n8n|scheduler|cron/i,
						String(file)
					);
			const schema = strip(fs.readFileSync('src/lib/server/db/schema/automation.ts', 'utf8'));
			assert.doesNotMatch(schema, /url|secret|hmac|subscription|rule|workflow/i);
		}
	);
});

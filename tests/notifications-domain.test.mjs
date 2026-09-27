import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { fixture, createCredentialUser } from './helpers/auth-fixture.mjs';

test('SoporteFlow — Etapa 5.4U-C: generación de notificaciones desde el dominio', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server, pg } = f;
	const { ensureOrganizationRoles } = await server.ssrLoadModule(
		'/src/lib/server/services/roles.ts'
	);
	const { createSlaPolicy } = await server.ssrLoadModule(
		'/src/lib/server/services/sla-policies.ts'
	);
	const { createIncidentRecord, assignIncidentRecord, updateIncidentRecord } =
		await server.ssrLoadModule('/src/lib/server/services/incidents.ts');
	const { createPublicComment, createInternalNote } = await server.ssrLoadModule(
		'/src/lib/server/services/incident-messages.ts'
	);
	const { setNotificationPreference, resetNotificationPreference } = await server.ssrLoadModule(
		'/src/lib/server/services/notification-preferences.ts'
	);
	const { countUnreadNotifications, listNotifications } = await server.ssrLoadModule(
		'/src/lib/server/services/notifications.ts'
	);
	const producer = await server.ssrLoadModule('/src/lib/server/services/notification-producer.ts');

	async function organization(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'uc-' + randomUUID(), status: 'active' })
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
		const u = user ?? (await createCredentialUser(f, { email: `uc-${randomUUID()}@example.test` }));
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
		return { user: u, membership };
	}
	async function incident(o, creator, patch = {}) {
		const { incident: row } = await createIncidentRecord(
			db,
			{ organizationId: o.org.id, creatorUserId: creator.user.id },
			{ title: 'Título secreto', description: 'D', client: 'C' }
		);
		if (Object.keys(patch).length)
			await db.update(s.incidents).set(patch).where(eq(s.incidents.id, row.id));
		const [fresh] = await db.select().from(s.incidents).where(eq(s.incidents.id, row.id));
		return fresh;
	}
	/** Raw rows (payload included) for one recipient in one org, oldest first. */
	const rows = (o, who, incidentId) =>
		db
			.select()
			.from(s.notifications)
			.where(
				and(
					eq(s.notifications.organizationId, o.org.id),
					eq(s.notifications.recipientUserId, who.user.id)
				)
			)
			.orderBy(asc(s.notifications.createdAt), asc(s.notifications.id))
			.then((list) =>
				incidentId ? list.filter((n) => n.payload?.incidentId === incidentId) : list
			);
	const allFor = (incidentId) =>
		db
			.select()
			.from(s.notifications)
			.then((list) => list.filter((n) => n.payload?.incidentId === incidentId));
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
	const comment = (o, actor, inc, body, supportResponse = false) =>
		createPublicComment(
			db,
			{
				organizationId: o.org.id,
				incidentId: inc.id,
				actorUserId: actor.user.id,
				supportResponse
			},
			body
		);
	async function withFailingNotifications(run) {
		await pg.exec(`
			CREATE OR REPLACE FUNCTION uc_fail_notification() RETURNS trigger AS $$
			BEGIN RAISE EXCEPTION 'uc forced notification failure'; END $$ LANGUAGE plpgsql;
			CREATE TRIGGER uc_fail_notification BEFORE INSERT ON notifications
				FOR EACH ROW EXECUTE FUNCTION uc_fail_notification();`);
		try {
			await run();
		} finally {
			await pg.exec(`DROP TRIGGER uc_fail_notification ON notifications;
				DROP FUNCTION uc_fail_notification();`);
		}
	}

	const A = await organization('Alfa');
	const B = await organization('Beta');
	const admin = await member(A, [A.admin]);
	const techA = await member(A, [A.tech]);
	const techB = await member(A, [A.tech]);
	const customer = await member(A, [A.customer]);
	const adminB = await member(B, [B.admin]);
	await createSlaPolicy(db, A.org.id, {
		code: 'std',
		name: 'Std',
		firstResponseMinutes: 60,
		resolutionMinutes: 120,
		isDefault: true
	});

	// =========================================================================
	// Asignación
	// =========================================================================
	await t.test('asignar null -> A: A recibe incident.assigned con payload mínimo', async () => {
		const inc = await incident(A, admin, { clientUserId: customer.user.id });
		await assign(A, admin, inc, { assignedToUserId: techA.user.id });
		const [n, ...rest] = await rows(A, techA, inc.id);
		assert.equal(rest.length, 0);
		assert.equal(n.type, 'incident.assigned');
		assert.equal(n.title, 'Incidencia asignada');
		assert.equal(n.message, `Se te ha asignado la incidencia #${inc.incidentNumber}.`);
		assert.deepEqual(n.payload, { incidentId: inc.id });
		assert.equal(n.readAt, null);
		// nadie más: ni el actor, ni el solicitante
		assert.equal((await allFor(inc.id)).length, 1);
	});

	await t.test(
		'reasignar A -> B: unassigned(A) + assigned(B); previousAssignee desde la fila bloqueada',
		async () => {
			const inc = await incident(A, admin, { assignedToUserId: techA.user.id });
			await assign(A, admin, inc, {
				assignedToUserId: techB.user.id,
				reason: 'Cambio de turno',
				// campo ajeno al contrato: nunca se usa como destinatario
				previousAssigneeUserId: customer.user.id
			});
			const a = await rows(A, techA, inc.id);
			const b = await rows(A, techB, inc.id);
			assert.deepEqual(
				a.map((n) => n.type),
				['incident.unassigned']
			);
			assert.equal(a[0].message, `Ya no tienes asignada la incidencia #${inc.incidentNumber}.`);
			assert.deepEqual(a[0].payload, { incidentId: inc.id });
			assert.deepEqual(
				b.map((n) => n.type),
				['incident.assigned']
			);
			assert.equal((await rows(A, customer, inc.id)).length, 0);
			assert.equal((await allFor(inc.id)).length, 2);
		}
	);

	await t.test('desasignar A -> null: solo unassigned(A)', async () => {
		const inc = await incident(A, admin, { assignedToUserId: techA.user.id });
		await assign(A, admin, inc, { assignedToUserId: null, reason: 'Sin técnico' });
		const list = await allFor(inc.id);
		assert.deepEqual(
			list.map((n) => [n.recipientUserId, n.type]),
			[[techA.user.id, 'incident.unassigned']]
		);
	});

	await t.test('auto-asignación: el actor nunca se notifica a sí mismo', async () => {
		const inc = await incident(A, admin);
		await assign(A, techA, inc, { assignedToUserId: techA.user.id });
		assert.equal((await allFor(inc.id)).length, 0);
		// el técnico se quita a sí mismo y asigna a otro: solo el nuevo recibe
		await assign(A, techA, inc, { assignedToUserId: techB.user.id, reason: 'Relevo' });
		assert.deepEqual(
			(await allFor(inc.id)).map((n) => [n.recipientUserId, n.type]),
			[[techB.user.id, 'incident.assigned']]
		);
	});

	await t.test('no-op de asignación y cambios solo de equipo: sin notificaciones', async () => {
		const inc = await incident(A, admin, { assignedToUserId: techA.user.id });
		const same = await assign(A, admin, inc, { assignedToUserId: techA.user.id });
		assert.equal(same.history, undefined, 'no-op');
		assert.equal((await allFor(inc.id)).length, 0);
		const [team] = await db
			.insert(s.teams)
			.values({ organizationId: A.org.id, name: 'Equipo ' + randomUUID(), active: true })
			.returning();
		await db
			.insert(s.teamMemberships)
			.values({ organizationId: A.org.id, teamId: team.id, membershipId: techA.membership.id });
		await assign(A, admin, inc, { teamId: team.id, reason: 'Equipo' });
		const [after] = await db.select().from(s.incidents).where(eq(s.incidents.id, inc.id));
		assert.equal(after.teamId, team.id);
		assert.equal(after.assignedToUserId, techA.user.id);
		assert.equal((await allFor(inc.id)).length, 0);
	});

	await t.test(
		'preferencia desactivada o miembro inactivo: la mutación sigue, 0 creadas',
		async () => {
			await setNotificationPreference(
				db,
				{ organizationId: A.org.id, userId: techB.user.id },
				'incident.assigned',
				false
			);
			try {
				const inc = await incident(A, admin);
				const res = await assign(A, admin, inc, { assignedToUserId: techB.user.id });
				assert.equal(res.incident.assignedToUserId, techB.user.id);
				assert.equal((await allFor(inc.id)).length, 0);
			} finally {
				await resetNotificationPreference(
					db,
					{ organizationId: A.org.id, userId: techB.user.id },
					'incident.assigned'
				);
			}
			const gone = await member(A, [A.tech]);
			const inc = await incident(A, admin, { assignedToUserId: gone.user.id });
			await db
				.update(s.memberships)
				.set({ active: false })
				.where(eq(s.memberships.id, gone.membership.id));
			await assign(A, admin, inc, { assignedToUserId: techA.user.id, reason: 'Baja' });
			assert.deepEqual(
				(await allFor(inc.id)).map((n) => [n.recipientUserId, n.type]),
				[[techA.user.id, 'incident.assigned']]
			);
		}
	);

	// =========================================================================
	// Estado y reapertura
	// =========================================================================
	await t.test('cambio de estado: solicitante + asignado, excluido el actor', async () => {
		const inc = await incident(A, admin, {
			clientUserId: customer.user.id,
			assignedToUserId: techA.user.id
		});
		await update(A, admin, inc, { status: 'pending' });
		const list = await allFor(inc.id);
		assert.deepEqual(
			list.map((n) => n.recipientUserId).sort(),
			[customer.user.id, techA.user.id].sort()
		);
		for (const n of list) {
			assert.equal(n.type, 'incident.status_changed');
			assert.equal(n.title, 'Estado de incidencia actualizado');
			assert.equal(
				n.message,
				`La incidencia #${inc.incidentNumber} ha pasado de Abierta a Pendiente.`
			);
			assert.deepEqual(n.payload, {
				incidentId: inc.id,
				previousStatus: 'open',
				newStatus: 'pending'
			});
		}
		// el asignado cambia el estado: solo el solicitante
		await update(A, techA, inc, { status: 'resolved' });
		const resolved = (await allFor(inc.id)).filter((n) => n.payload.newStatus === 'resolved');
		assert.deepEqual(
			resolved.map((n) => n.recipientUserId),
			[customer.user.id]
		);
		assert.equal(resolved[0].type, 'incident.status_changed');
	});

	await t.test('reapertura: solo incident.reopened (desde resolved y desde closed)', async () => {
		const inc = await incident(A, admin, {
			clientUserId: customer.user.id,
			assignedToUserId: techA.user.id
		});
		await update(A, techA, inc, { status: 'resolved' });
		await db.delete(s.notifications);
		await update(A, admin, inc, { status: 'open' });
		let list = await allFor(inc.id);
		assert.equal(list.length, 2);
		for (const n of list) {
			assert.equal(n.type, 'incident.reopened');
			assert.equal(n.title, 'Incidencia reabierta');
			assert.equal(n.message, `La incidencia #${inc.incidentNumber} se ha reabierto.`);
			assert.deepEqual(n.payload, {
				incidentId: inc.id,
				previousStatus: 'resolved',
				newStatus: 'open'
			});
		}
		await update(A, admin, inc, { status: 'resolved' });
		await update(A, admin, inc, { status: 'closed' });
		await db.delete(s.notifications);
		await update(A, customer, inc, { status: 'open' });
		list = await allFor(inc.id);
		assert.deepEqual(
			list.map((n) => [n.recipientUserId, n.type, n.payload.previousStatus]),
			[[techA.user.id, 'incident.reopened', 'closed']],
			'el solicitante-actor queda excluido'
		);
	});

	await t.test('no-op de estado y cambio solo de prioridad: sin notificaciones', async () => {
		const inc = await incident(A, admin, {
			clientUserId: customer.user.id,
			assignedToUserId: techA.user.id
		});
		await update(A, admin, inc, { status: 'open' });
		await update(A, admin, inc, { priority: inc.priority === 'high' ? 'low' : 'high' });
		assert.equal((await allFor(inc.id)).length, 0);
	});

	// =========================================================================
	// Comentarios
	// =========================================================================
	await t.test(
		'comentario del solicitante -> asignado; sin cuerpo en la notificación',
		async () => {
			const inc = await incident(A, admin, {
				clientUserId: customer.user.id,
				assignedToUserId: techA.user.id
			});
			const secret = 'Mi contraseña del router es hunter2 ' + randomUUID();
			const msg = await comment(A, customer, inc, secret);
			const list = await allFor(inc.id);
			assert.deepEqual(
				list.map((n) => [n.recipientUserId, n.type]),
				[[techA.user.id, 'incident.public_comment_added']]
			);
			assert.equal(list[0].title, 'Nuevo comentario');
			assert.equal(
				list[0].message,
				`Hay un nuevo comentario en la incidencia #${inc.incidentNumber}.`
			);
			assert.deepEqual(list[0].payload, { incidentId: inc.id, commentId: msg.id });
			const serialized = JSON.stringify(list);
			for (const leak of [secret, 'hunter2', 'Título secreto', customer.user.email])
				assert.ok(!serialized.includes(leak), leak);
		}
	);

	await t.test(
		'comentario de staff -> solicitante; primera respuesta y SLA en la misma transacción',
		async () => {
			const inc = await incident(A, admin, {
				clientUserId: customer.user.id,
				assignedToUserId: techA.user.id
			});
			assert.ok(inc.slaPolicyId, 'política por defecto aplicada');
			await comment(A, techA, inc, 'Respuesta', true);
			assert.deepEqual(
				(await allFor(inc.id)).map((n) => [n.recipientUserId, n.type]),
				[[customer.user.id, 'incident.public_comment_added']]
			);
			const [after] = await db.select().from(s.incidents).where(eq(s.incidents.id, inc.id));
			assert.ok(after.firstResponseAt);
			const history = await db
				.select()
				.from(s.incidentHistory)
				.where(eq(s.incidentHistory.incidentId, inc.id));
			assert.ok(history.some((h) => h.eventType === 'sla_first_response_met'));
			assert.ok(!history.some((h) => /notif/i.test(h.eventType)), 'sin notification_sent');
			// un tercero (admin) comenta: solo el solicitante
			await db.delete(s.notifications);
			await comment(A, admin, inc, 'Nota pública', true);
			assert.deepEqual(
				(await allFor(inc.id)).map((n) => n.recipientUserId),
				[customer.user.id]
			);
		}
	);

	await t.test('nota interna: 0 notificaciones', async () => {
		const inc = await incident(A, admin, {
			clientUserId: customer.user.id,
			assignedToUserId: techA.user.id
		});
		await createInternalNote(
			db,
			{ organizationId: A.org.id, incidentId: inc.id, actorUserId: admin.user.id },
			'Interno'
		);
		assert.equal((await allFor(inc.id)).length, 0);
	});

	// =========================================================================
	// Atomicidad: un fallo del producer revierte la mutación de dominio
	// =========================================================================
	await t.test('fallo al notificar revierte la asignación (incidente e historial)', async () => {
		const inc = await incident(A, admin, { assignedToUserId: techA.user.id });
		const before = await db
			.select()
			.from(s.incidentHistory)
			.where(eq(s.incidentHistory.incidentId, inc.id));
		await withFailingNotifications(() =>
			assert.rejects(assign(A, admin, inc, { assignedToUserId: techB.user.id, reason: 'X' }))
		);
		const [after] = await db.select().from(s.incidents).where(eq(s.incidents.id, inc.id));
		assert.equal(after.assignedToUserId, techA.user.id);
		assert.equal(after.updatedAt.getTime(), inc.updatedAt.getTime());
		const history = await db
			.select()
			.from(s.incidentHistory)
			.where(eq(s.incidentHistory.incidentId, inc.id));
		assert.equal(history.length, before.length);
		assert.equal((await allFor(inc.id)).length, 0);
	});

	await t.test('fallo al notificar revierte el cambio de estado y firstResolvedAt', async () => {
		const inc = await incident(A, admin, {
			clientUserId: customer.user.id,
			assignedToUserId: techA.user.id
		});
		await withFailingNotifications(() =>
			assert.rejects(update(A, admin, inc, { status: 'resolved' }))
		);
		const [after] = await db.select().from(s.incidents).where(eq(s.incidents.id, inc.id));
		assert.equal(after.status, 'open');
		assert.equal(after.firstResolvedAt, null);
		const history = await db
			.select()
			.from(s.incidentHistory)
			.where(eq(s.incidentHistory.incidentId, inc.id));
		assert.ok(!history.some((h) => /resolved|sla_resolution/.test(h.eventType)));
	});

	await t.test(
		'fallo al notificar revierte comentario, primera respuesta e historial SLA',
		async () => {
			const inc = await incident(A, admin, {
				clientUserId: customer.user.id,
				assignedToUserId: techA.user.id
			});
			await withFailingNotifications(() => assert.rejects(comment(A, techA, inc, 'Hola', true)));
			const [after] = await db.select().from(s.incidents).where(eq(s.incidents.id, inc.id));
			assert.equal(after.firstResponseAt, null);
			const messages = await db
				.select()
				.from(s.incidentMessages)
				.where(eq(s.incidentMessages.incidentId, inc.id));
			assert.equal(messages.length, 0);
			const history = await db
				.select()
				.from(s.incidentHistory)
				.where(eq(s.incidentHistory.incidentId, inc.id));
			assert.ok(!history.some((h) => h.eventType.startsWith('sla_first_response')));
			// sin fallo, el mismo comentario funciona
			await comment(A, techA, inc, 'Hola', true);
			assert.equal((await allFor(inc.id)).length, 1);
		}
	);

	await t.test(
		'una nota interna no depende de notificaciones (no falla con el trigger)',
		async () => {
			const inc = await incident(A, admin, { clientUserId: customer.user.id });
			await withFailingNotifications(() =>
				createInternalNote(
					db,
					{ organizationId: A.org.id, incidentId: inc.id, actorUserId: admin.user.id },
					'Interno'
				)
			);
		}
	);

	// =========================================================================
	// Multi-organización, contadores y DTOs
	// =========================================================================
	await t.test(
		'multi-org: la notificación vive solo en la organización del incidente',
		async () => {
			const shared = await member(B, [B.tech], { user: techA.user });
			const inc = await incident(A, admin);
			await assign(A, admin, inc, { assignedToUserId: techA.user.id });
			const incB = await incident(B, adminB);
			await assign(B, adminB, incB, { assignedToUserId: shared.user.id });
			const inA = await rows(A, techA, inc.id);
			const inB = await rows(B, shared, incB.id);
			assert.equal(inA.length, 1);
			assert.equal(inB.length, 1);
			assert.equal(inA[0].organizationId, A.org.id);
			assert.equal(inB[0].organizationId, B.org.id);
			assert.equal((await rows(B, shared, inc.id)).length, 0);
			assert.equal((await rows(A, techA, incB.id)).length, 0);
		}
	);

	await t.test('contador de no leídas y DTO de bandeja sin payload', async () => {
		const fresh = await member(A, [A.tech]);
		const ctx = { organizationId: A.org.id, recipientUserId: fresh.user.id };
		assert.equal(await countUnreadNotifications(db, ctx), 0);
		const inc = await incident(A, admin);
		await assign(A, admin, inc, { assignedToUserId: fresh.user.id });
		await update(A, admin, inc, { status: 'pending' });
		assert.equal(await countUnreadNotifications(db, ctx), 2);
		const page = await listNotifications(db, ctx);
		assert.deepEqual(page.items.map((n) => n.type).sort(), [
			'incident.assigned',
			'incident.status_changed'
		]);
		for (const n of page.items) assert.ok(!('payload' in n));
	});

	await t.test('DTOs de incidente sin datos de notificación', async () => {
		const inc = await incident(A, admin);
		const res = await assign(A, admin, inc, { assignedToUserId: techA.user.id });
		assert.deepEqual(Object.keys(res).sort(), ['history', 'incident']);
		assert.ok(!Object.keys(res.incident).some((k) => /notif/i.test(k)));
		const upd = await update(A, admin, inc, { status: 'pending' });
		assert.deepEqual(Object.keys(upd).sort(), ['history', 'incident']);
	});

	// =========================================================================
	// Producer
	// =========================================================================
	await t.test('producer: SLA y eventos desconocidos rechazados; created exacto', async () => {
		const inc = await incident(A, admin, {
			clientUserId: customer.user.id,
			assignedToUserId: techA.user.id
		});
		const base = { organizationId: A.org.id, incidentId: inc.id, actorUserId: admin.user.id };
		for (const eventType of [
			'sla.first_response_breached',
			'sla.resolution_breached',
			'incident.created',
			'notification_sent'
		])
			await assert.rejects(
				producer.produceDomainNotification(db, { ...base, eventType }),
				(e) => e.code === 'INVALID_INPUT'
			);
		await assert.rejects(
			producer.produceDomainNotification(db, {
				...base,
				eventType: 'incident.status_changed',
				previousStatus: 'open',
				newStatus: 'open'
			}),
			(e) => e.code === 'INVALID_INPUT'
		);
		await assert.rejects(
			producer.produceDomainNotification(db, {
				...base,
				incidentId: randomUUID(),
				eventType: 'incident.assigned'
			}),
			(e) => e.code === 'INCIDENT_NOT_FOUND'
		);
		await assert.rejects(
			producer.produceDomainNotification(db, {
				...base,
				organizationId: B.org.id,
				eventType: 'incident.assigned'
			}),
			(e) => e.code === 'INCIDENT_NOT_FOUND',
			'incidente de otro tenant'
		);
		assert.equal((await allFor(inc.id)).length, 0);
		assert.deepEqual(
			await producer.produceDomainNotification(db, {
				...base,
				eventType: 'incident.status_changed',
				previousStatus: 'pending',
				newStatus: 'open'
			}),
			{ created: 2 }
		);
		assert.deepEqual(
			await producer.produceDomainNotification(db, { ...base, eventType: 'incident.assigned' }),
			{ created: 1 }
		);
	});

	await t.test('sin worker, cron, email ni outbox en el producer', () => {
		const source = fs
			.readFileSync('src/lib/server/services/notification-producer.ts', 'utf8')
			.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
		for (const forbidden of [
			/setInterval|setTimeout|cron/i,
			/mail|outbox|webhook|push/i,
			/catch\s*[({]/,
			/incidentHistory|incident_history/
		])
			assert.doesNotMatch(source, forbidden);
	});
});

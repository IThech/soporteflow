import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { fixture } from './helpers/auth-fixture.mjs';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

test('SoporteFlow — Etapa 5.4N-B: servicio de notas internas', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, pg, server } = f;
	const {
		createInternalNote,
		listInternalNotes,
		INTERNAL_NOTE_MAX_LENGTH,
		UNAVAILABLE_AUTHOR_NAME
	} = await server.ssrLoadModule('/src/lib/server/services/incident-messages.ts');
	const { IncidentServiceError } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);

	async function rejectsWith(operation, code) {
		await assert.rejects(operation, (error) => {
			assert.ok(error instanceof IncidentServiceError, `esperado IncidentServiceError: ${error}`);
			assert.equal(error.code, code);
			return true;
		});
	}

	async function createOrg(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'org-' + randomUUID(), status: 'active' })
			.returning();
		return org;
	}

	async function createMember(org, values = { name: 'Técnico' }) {
		const [user] = await db.insert(s.users).values(values).returning();
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
		return { user, membership };
	}

	let incidentNumber = 0;
	async function createIncident(org, creator, status = 'open') {
		const [incident] = await db
			.insert(s.incidents)
			.values({
				organizationId: org.id,
				incidentNumber: ++incidentNumber,
				title: 'Incidencia notas',
				description: 'Synthetic',
				client: 'Synthetic',
				createdByUserId: creator.user.id,
				status
			})
			.returning();
		return incident;
	}

	async function messagesOf(incident) {
		return db
			.select()
			.from(s.incidentMessages)
			.where(eq(s.incidentMessages.incidentId, incident.id));
	}

	async function notesHistoryOf(incident) {
		return db
			.select()
			.from(s.incidentHistory)
			.where(
				and(
					eq(s.incidentHistory.incidentId, incident.id),
					eq(s.incidentHistory.eventType, 'internal_note_added')
				)
			);
	}

	function create(incident, actor, body, organization = orgA) {
		return createInternalNote(
			db,
			{ organizationId: organization.id, incidentId: incident.id, actorUserId: actor.user.id },
			body
		);
	}

	function list(incident, query = {}, organization = orgA) {
		return listInternalNotes(
			db,
			{ organizationId: organization.id, incidentId: incident.id },
			new URLSearchParams(query)
		);
	}

	const orgA = await createOrg('Org Notas A');
	const orgB = await createOrg('Org Notas B');
	const techA = await createMember(orgA, { name: 'Ana Técnica', displayName: 'Ana T.' });
	const techA2 = await createMember(orgA, { name: 'Bruno Técnico' });
	const techB = await createMember(orgB, { name: 'Técnico B' });
	const [noMembership] = await db.insert(s.users).values({ name: 'Sin membresía' }).returning();

	// =========================================================================
	// Creación
	// =========================================================================
	await t.test('1-3. crea nota válida en open, pending y resolved', async () => {
		for (const status of ['open', 'pending', 'resolved']) {
			const incident = await createIncident(orgA, techA, status);
			const note = await create(incident, techA, `Nota en ${status}`);
			assert.match(note.id, UUID_REGEX);
			assert.equal(note.body, `Nota en ${status}`);
			assert.match(note.createdAt, ISO_MICROS);
			assert.deepEqual(note.author, { name: 'Ana T.' });
			assert.equal((await messagesOf(incident)).length, 1);
		}
	});

	await t.test('4. rechaza closed con INCIDENT_CLOSED sin persistir nada', async () => {
		const incident = await createIncident(orgA, techA, 'closed');
		await rejectsWith(create(incident, techA, 'No debe entrar'), 'INCIDENT_CLOSED');
		assert.equal((await messagesOf(incident)).length, 0);
		assert.equal((await notesHistoryOf(incident)).length, 0);
	});

	const incidentA = await createIncident(orgA, techA);

	await t.test('5-6. body vacío o solo espacios -> INVALID_INPUT', async () => {
		for (const body of ['', '   ', '\n\t ']) {
			await rejectsWith(create(incidentA, techA, body), 'INVALID_INPUT');
		}
		for (const body of [undefined, null, 42, { text: 'x' }]) {
			await rejectsWith(create(incidentA, techA, body), 'INVALID_INPUT');
		}
	});

	await t.test('7. body se recorta', async () => {
		const note = await create(incidentA, techA, '   Texto con espacios  \n');
		assert.equal(note.body, 'Texto con espacios');
		const [row] = await db
			.select()
			.from(s.incidentMessages)
			.where(eq(s.incidentMessages.id, note.id));
		assert.equal(row.body, 'Texto con espacios');
	});

	await t.test('8. 4000 caracteres OK (también con espacios alrededor)', async () => {
		assert.equal(INTERNAL_NOTE_MAX_LENGTH, 4000);
		const note = await create(incidentA, techA, '  ' + 'x'.repeat(4000) + '  ');
		assert.equal(note.body.length, 4000);
	});

	await t.test('9. 4001 caracteres falla', async () => {
		await rejectsWith(create(incidentA, techA, 'x'.repeat(4001)), 'INVALID_INPUT');
	});

	await t.test('10. HTML/script se guarda literal', async () => {
		const body = '<script>alert("x")</script><img src=x onerror=alert(1)>';
		const note = await create(incidentA, techA, body);
		assert.equal(note.body, body);
		const [row] = await db
			.select()
			.from(s.incidentMessages)
			.where(eq(s.incidentMessages.id, note.id));
		assert.equal(row.body, body);
	});

	await t.test('11-12. visibility siempre internal y autor = actorUserId confiable', async () => {
		const note = await createInternalNote(
			db,
			{ organizationId: orgA.id, incidentId: incidentA.id, actorUserId: techA2.user.id },
			'Nota de Bruno'
		);
		const [row] = await db
			.select()
			.from(s.incidentMessages)
			.where(eq(s.incidentMessages.id, note.id));
		assert.equal(row.visibility, 'internal');
		assert.equal(row.authorUserId, techA2.user.id);
		assert.equal(row.organizationId, orgA.id);
		assert.equal(row.incidentId, incidentA.id);
		// La firma no acepta visibility, authorUserId ni eventType: solo body como tercer argumento
		assert.equal(createInternalNote.length, 3);
	});

	await t.test('13-17. exactamente un internal_note_added con payload seguro', async () => {
		const incident = await createIncident(orgA, techA);
		const secret = 'Contraseña del router: hunter2 <b>secreta</b>';
		const note = await create(incident, techA, secret);
		const events = await notesHistoryOf(incident);
		assert.equal(events.length, 1);
		const [event] = events;
		assert.equal(event.eventType, 'internal_note_added');
		assert.equal(event.actorType, 'user');
		assert.equal(event.actorUserId, techA.user.id);
		assert.equal(event.organizationId, orgA.id);
		assert.equal(event.incidentId, incident.id);
		assert.deepEqual(event.payload, { messageId: note.id });
		assert.equal(event.comment, null);
		assert.equal(event.reason, null);
		const serialized = JSON.stringify(event);
		assert.ok(!serialized.includes('hunter2'));
		assert.ok(!serialized.includes(secret));
		assert.ok(!serialized.includes('Ana'));
	});

	await t.test('18. rollback si falla el insert del history', async () => {
		const incident = await createIncident(orgA, techA);
		await pg.exec(`
			CREATE FUNCTION test_fail_history() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'forced history failure'; END $$;
			CREATE TRIGGER test_fail_history BEFORE INSERT ON incident_history
			FOR EACH ROW WHEN (NEW.event_type = 'internal_note_added')
			EXECUTE FUNCTION test_fail_history();`);
		try {
			await assert.rejects(create(incident, techA, 'No debe persistir'));
		} finally {
			await pg.exec(`DROP TRIGGER test_fail_history ON incident_history;
				DROP FUNCTION test_fail_history();`);
		}
		assert.equal((await messagesOf(incident)).length, 0);
		assert.equal((await notesHistoryOf(incident)).length, 0);
	});

	await t.test('19. rollback si falla el insert del message', async () => {
		const incident = await createIncident(orgA, techA);
		await pg.exec(`
			CREATE FUNCTION test_fail_message() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'forced message failure'; END $$;
			CREATE TRIGGER test_fail_message BEFORE INSERT ON incident_messages
			FOR EACH ROW EXECUTE FUNCTION test_fail_message();`);
		try {
			await assert.rejects(create(incident, techA, 'No debe persistir'));
		} finally {
			await pg.exec(`DROP TRIGGER test_fail_message ON incident_messages;
				DROP FUNCTION test_fail_message();`);
		}
		assert.equal((await messagesOf(incident)).length, 0);
		assert.equal((await notesHistoryOf(incident)).length, 0);
	});

	await t.test('20. incidencia inexistente -> INCIDENT_NOT_FOUND', async () => {
		await rejectsWith(create({ id: randomUUID() }, techA, 'Nota'), 'INCIDENT_NOT_FOUND');
	});

	await t.test('21. incidencia cross-tenant -> INCIDENT_NOT_FOUND', async () => {
		const incidentB = await createIncident(orgB, techB);
		// Actor válido en B intentando escribir en incidencia de A declarando org B
		await rejectsWith(create(incidentA, techB, 'Nota', orgB), 'INCIDENT_NOT_FOUND');
		// Actor de A declarando org A sobre incidencia de B
		await rejectsWith(create(incidentB, techA, 'Nota', orgA), 'INCIDENT_NOT_FOUND');
		assert.equal((await messagesOf(incidentB)).length, 0);
	});

	await t.test('22-23. autor sin membership o de otro tenant -> rechazado', async () => {
		await rejectsWith(
			createInternalNote(
				db,
				{ organizationId: orgA.id, incidentId: incidentA.id, actorUserId: noMembership.id },
				'Nota'
			),
			'CREATOR_MEMBERSHIP_NOT_FOUND'
		);
		await rejectsWith(create(incidentA, techB, 'Nota', orgA), 'CREATOR_MEMBERSHIP_NOT_FOUND');
	});

	await t.test('24. actor inactivo no crea; su nota previa sigue legible', async () => {
		const incident = await createIncident(orgA, techA);
		const former = await createMember(orgA, { name: 'Técnico Saliente' });
		const note = await create(incident, former, 'Nota antes de desactivar');

		await db.update(s.users).set({ active: false }).where(eq(s.users.id, former.user.id));
		await rejectsWith(create(incident, former, 'Nota tras desactivar'), 'CREATOR_USER_INACTIVE');
		await db.update(s.users).set({ active: true }).where(eq(s.users.id, former.user.id));

		await db
			.update(s.memberships)
			.set({ active: false })
			.where(eq(s.memberships.id, former.membership.id));
		await rejectsWith(
			create(incident, former, 'Nota con membresía inactiva'),
			'CREATOR_MEMBERSHIP_INACTIVE'
		);
		await db.update(s.users).set({ active: false }).where(eq(s.users.id, former.user.id));

		const page = await list(incident);
		assert.deepEqual(
			page.items.map((i) => [i.id, i.author.name]),
			[[note.id, 'Técnico Saliente']]
		);
	});

	await t.test('invalid context -> INVALID_INPUT', async () => {
		await rejectsWith(
			createInternalNote(
				db,
				{ organizationId: 'x', incidentId: incidentA.id, actorUserId: techA.user.id },
				'Nota'
			),
			'INVALID_INPUT'
		);
		await rejectsWith(
			createInternalNote(
				db,
				{ organizationId: orgA.id, incidentId: incidentA.id, actorUserId: 'x' },
				'Nota'
			),
			'INVALID_INPUT'
		);
	});

	// =========================================================================
	// Lectura
	// =========================================================================
	await t.test('25-27. lectura devuelve solo internal con DTO seguro', async () => {
		const incident = await createIncident(orgA, techA);
		const note = await create(incident, techA, 'Interna');
		const [publicRow] = await db
			.insert(s.incidentMessages)
			.values({
				organizationId: orgA.id,
				incidentId: incident.id,
				authorUserId: techA.user.id,
				visibility: 'public',
				body: 'Comentario público'
			})
			.returning();
		const page = await list(incident);
		assert.deepEqual(
			page.items.map((i) => i.id),
			[note.id]
		);
		assert.ok(!page.items.some((i) => i.id === publicRow.id));
		assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor']);
		for (const item of page.items) {
			assert.deepEqual(Object.keys(item).sort(), ['author', 'body', 'createdAt', 'id']);
			assert.deepEqual(Object.keys(item.author), ['name']);
		}
		const serialized = JSON.stringify(page);
		for (const hidden of [orgA.id, incident.id, techA.user.id, 'visibility', 'internal']) {
			assert.ok(!serialized.includes(hidden), `no debe exponer ${hidden}`);
		}
	});

	await t.test('28-29. nombre legible y fallback "Usuario no disponible"', async () => {
		const incident = await createIncident(orgA, techA);
		const plain = await createMember(orgA, { name: 'Solo Nombre', displayName: '   ' });
		const blank = await createMember(orgA, { name: '   ' });
		await create(incident, techA, 'De Ana');
		await create(incident, plain, 'De Solo Nombre');
		await create(incident, blank, 'De anónimo');
		const names = (await list(incident)).items.map((i) => [i.body, i.author.name]);
		assert.deepEqual(
			new Map(names),
			new Map([
				['De Ana', 'Ana T.'],
				['De Solo Nombre', 'Solo Nombre'],
				['De anónimo', 'Usuario no disponible']
			])
		);
		assert.equal(UNAVAILABLE_AUTHOR_NAME, 'Usuario no disponible');
		assert.ok(!JSON.stringify(names).match(UUID_REGEX));
	});

	// Incidencia con notas controladas para orden y paginación
	const paged = await createIncident(orgA, techA);
	const sameInstant = new Date('2026-01-01T10:00:00.000Z');
	const tiedIds = [randomUUID(), randomUUID(), randomUUID()].sort();
	const seeded = [];
	for (let i = 0; i < 120; i++) {
		seeded.push({
			id: i < 3 ? tiedIds[i] : randomUUID(),
			organizationId: orgA.id,
			incidentId: paged.id,
			authorUserId: techA.user.id,
			visibility: 'internal',
			body: `Nota ${i}`,
			createdAt: i < 3 ? sameInstant : new Date(Date.UTC(2026, 0, 2, 0, 0, i))
		});
	}
	await db.insert(s.incidentMessages).values(seeded);
	const expectedOrder = [...seeded]
		.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
		.map((row) => row.id);

	await t.test('30-31. orden DESC y desempate por id DESC con timestamp igual', async () => {
		const { items } = await list(paged, { limit: '100' });
		const ids = items.map((i) => i.id);
		assert.deepEqual(ids, expectedOrder.slice(0, 100));
		for (let i = 1; i < items.length; i++) {
			assert.ok(items[i - 1].createdAt >= items[i].createdAt);
		}
		const all = await collect(paged, '100');
		assert.deepEqual(all.slice(-3), [...tiedIds].reverse());
	});

	async function collect(incident, limit) {
		const ids = [];
		let cursor = null;
		let pages = 0;
		do {
			const query = { limit };
			if (cursor) query.cursor = cursor;
			const page = await list(incident, query);
			ids.push(...page.items.map((i) => i.id));
			cursor = page.nextCursor;
			pages++;
		} while (cursor && pages < 1000);
		return ids;
	}

	await t.test('32. limit por defecto 50', async () => {
		const page = await list(paged);
		assert.equal(page.items.length, 50);
		assert.equal(typeof page.nextCursor, 'string');
	});

	await t.test('33. limit máximo 100', async () => {
		const page = await list(paged, { limit: '100' });
		assert.equal(page.items.length, 100);
		await rejectsWith(list(paged, { limit: '101' }), 'INVALID_INPUT');
	});

	await t.test('34. limit inválido -> INVALID_INPUT', async () => {
		for (const limit of ['0', '-1', 'abc', '1.5', '', ' 5', '05', '1e2']) {
			await rejectsWith(list(paged, { limit }), 'INVALID_INPUT');
		}
		await rejectsWith(
			listInternalNotes(
				db,
				{ organizationId: orgA.id, incidentId: paged.id },
				new URLSearchParams('limit=5&limit=6')
			),
			'INVALID_INPUT'
		);
		await rejectsWith(list(paged, { visibility: 'public' }), 'INVALID_INPUT');
	});

	await t.test('35. cursor inválido -> INVALID_INPUT', async () => {
		const bad = [
			'not-base64!',
			Buffer.from('{}').toString('base64url'),
			Buffer.from(JSON.stringify(['2026-01-01', randomUUID()])).toString('base64url'),
			Buffer.from(JSON.stringify(['2026-01-01T10:00:00.000000Z', 'nope'])).toString('base64url'),
			'a'.repeat(300)
		];
		for (const cursor of bad) await rejectsWith(list(paged, { cursor }), 'INVALID_INPUT');
	});

	await t.test('36. páginas consecutivas sin duplicados ni saltos', async () => {
		for (const limit of ['1', '7', '50']) {
			const ids = await collect(paged, limit);
			assert.equal(ids.length, 120);
			assert.equal(new Set(ids).size, 120);
			assert.deepEqual(ids, expectedOrder);
		}
		const last = await list(paged, { limit: '100' });
		const tail = await list(paged, { limit: '100', cursor: last.nextCursor });
		assert.equal(tail.items.length, 20);
		assert.equal(tail.nextCursor, null);
	});

	await t.test('37. lista vacía', async () => {
		const empty = await createIncident(orgA, techA);
		assert.deepEqual(await list(empty), { items: [], nextCursor: null });
	});

	await t.test('38. la lectura no modifica datos', async () => {
		const count = async () => {
			const [{ n: messages }] = (await pg.query('SELECT count(*)::int AS n FROM incident_messages'))
				.rows;
			const [{ n: history }] = (await pg.query('SELECT count(*)::int AS n FROM incident_history'))
				.rows;
			return { messages, history };
		};
		const before = await count();
		await collect(paged, '10');
		await list(incidentA);
		assert.deepEqual(await count(), before);
	});

	await t.test('39. aislamiento multi-tenant total en lectura', async () => {
		const incidentB = await createIncident(orgB, techB);
		const noteB = await create(incidentB, techB, 'Secreto de B', orgB);
		// Incidencia de A consultada desde B y viceversa -> no encontrada
		await rejectsWith(list(incidentA, {}, orgB), 'INCIDENT_NOT_FOUND');
		await rejectsWith(list(incidentB, {}, orgA), 'INCIDENT_NOT_FOUND');
		await rejectsWith(list({ id: randomUUID() }), 'INCIDENT_NOT_FOUND');
		// Las notas de B nunca aparecen en ninguna incidencia de A
		const idsA = await collect(paged, '100');
		const pageA = await list(incidentA, { limit: '100' });
		assert.ok(![...idsA, ...pageA.items.map((i) => i.id)].includes(noteB.id));
		const pageB = await list(incidentB, {}, orgB);
		assert.deepEqual(
			pageB.items.map((i) => i.id),
			[noteB.id]
		);
	});
});

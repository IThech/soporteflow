import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fixture } from './helpers/auth-fixture.mjs';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

test('SoporteFlow — Etapa 5.4N-D: servicio de comentarios públicos', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, pg, server } = f;
	const { createPublicComment, listPublicComments, createInternalNote, UNAVAILABLE_AUTHOR_NAME } =
		await server.ssrLoadModule('/src/lib/server/services/incident-messages.ts');
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
	async function createIncident(org, creator, status = 'open', values = {}) {
		const [incident] = await db
			.insert(s.incidents)
			.values({
				organizationId: org.id,
				incidentNumber: ++incidentNumber,
				title: 'Incidencia comentarios',
				description: 'Synthetic',
				client: 'Synthetic',
				createdByUserId: creator.user.id,
				status,
				...values
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

	async function historyOf(incident) {
		return db.select().from(s.incidentHistory).where(eq(s.incidentHistory.incidentId, incident.id));
	}

	function create(incident, actor, body, organization = orgA, extra = {}) {
		return createPublicComment(
			db,
			{
				organizationId: organization.id,
				incidentId: incident.id,
				actorUserId: actor.user.id,
				...extra
			},
			body
		);
	}

	function list(incident, query = {}, organization = orgA, extra = {}) {
		return listPublicComments(
			db,
			{ organizationId: organization.id, incidentId: incident.id, ...extra },
			new URLSearchParams(query)
		);
	}

	const orgA = await createOrg('Org Comentarios A');
	const orgB = await createOrg('Org Comentarios B');
	const techA = await createMember(orgA, { name: 'Ana Técnica', displayName: 'Ana T.' });
	const techA2 = await createMember(orgA, { name: 'Bruno Técnico' });
	const techB = await createMember(orgB, { name: 'Técnico B' });
	const [noMembership] = await db.insert(s.users).values({ name: 'Sin membresía' }).returning();

	// =========================================================================
	// Creación
	// =========================================================================
	await t.test('1-3. crea comentario en open, pending y resolved', async () => {
		for (const status of ['open', 'pending', 'resolved']) {
			const incident = await createIncident(orgA, techA, status);
			const comment = await create(incident, techA, `Comentario en ${status}`);
			assert.match(comment.id, UUID_REGEX);
			assert.equal(comment.body, `Comentario en ${status}`);
			assert.match(comment.createdAt, ISO_MICROS);
			assert.deepEqual(comment.author, { name: 'Ana T.' });
			assert.deepEqual(Object.keys(comment).sort(), ['author', 'body', 'createdAt', 'id']);
			assert.equal((await messagesOf(incident)).length, 1);
		}
	});

	await t.test('4. rechaza closed con INCIDENT_CLOSED sin persistir', async () => {
		const incident = await createIncident(orgA, techA, 'closed');
		await rejectsWith(create(incident, techA, 'No debe entrar'), 'INCIDENT_CLOSED');
		assert.equal((await messagesOf(incident)).length, 0);
		assert.equal((await historyOf(incident)).length, 0);
	});

	const incidentA = await createIncident(orgA, techA);

	await t.test('5-6. body vacío, solo espacios o no string -> INVALID_INPUT', async () => {
		for (const body of ['', '   ', '\n\t ', undefined, null, 42, { text: 'x' }]) {
			await rejectsWith(create(incidentA, techA, body), 'INVALID_INPUT');
		}
	});

	await t.test('7. body se recorta', async () => {
		const comment = await create(incidentA, techA, '  Texto recortado \n');
		assert.equal(comment.body, 'Texto recortado');
		const [row] = await db
			.select()
			.from(s.incidentMessages)
			.where(eq(s.incidentMessages.id, comment.id));
		assert.equal(row.body, 'Texto recortado');
	});

	await t.test('8-9. 4000 caracteres OK y 4001 falla', async () => {
		const comment = await create(incidentA, techA, ' ' + 'x'.repeat(4000) + ' ');
		assert.equal(comment.body.length, 4000);
		await rejectsWith(create(incidentA, techA, 'x'.repeat(4001)), 'INVALID_INPUT');
	});

	await t.test('10. HTML/script se guarda literal', async () => {
		const body = '<script>alert("x")</script><img src=x onerror=alert(1)>';
		const comment = await create(incidentA, techA, body);
		assert.equal(comment.body, body);
	});

	await t.test('11-13. visibility public, sin history y actor real', async () => {
		const incident = await createIncident(orgA, techA);
		const historyBefore = (await historyOf(incident)).length;
		const comment = await create(incident, techA2, 'Comentario de Bruno');
		const [row] = await db
			.select()
			.from(s.incidentMessages)
			.where(eq(s.incidentMessages.id, comment.id));
		assert.equal(row.visibility, 'public');
		assert.equal(row.authorUserId, techA2.user.id);
		assert.equal(row.organizationId, orgA.id);
		assert.equal(row.incidentId, incident.id);
		assert.equal((await historyOf(incident)).length, historyBefore);
		assert.equal(createPublicComment.length, 3);
	});

	await t.test('14-15. incidencia inexistente o cross-tenant -> INCIDENT_NOT_FOUND', async () => {
		const incidentB = await createIncident(orgB, techB);
		await rejectsWith(create({ id: randomUUID() }, techA, 'x'), 'INCIDENT_NOT_FOUND');
		await rejectsWith(create(incidentA, techB, 'x', orgB), 'INCIDENT_NOT_FOUND');
		await rejectsWith(create(incidentB, techA, 'x', orgA), 'INCIDENT_NOT_FOUND');
		assert.equal((await messagesOf(incidentB)).length, 0);
	});

	await t.test('16. actor sin membership o de otro tenant -> rechazado', async () => {
		await rejectsWith(
			createPublicComment(
				db,
				{ organizationId: orgA.id, incidentId: incidentA.id, actorUserId: noMembership.id },
				'x'
			),
			'CREATOR_MEMBERSHIP_NOT_FOUND'
		);
		await rejectsWith(create(incidentA, techB, 'x', orgA), 'CREATOR_MEMBERSHIP_NOT_FOUND');
	});

	await t.test('17. actor inactivo no crea; su comentario previo sigue legible', async () => {
		const incident = await createIncident(orgA, techA);
		const former = await createMember(orgA, { name: 'Técnico Saliente' });
		const comment = await create(incident, former, 'Antes de desactivar');
		await db.update(s.users).set({ active: false }).where(eq(s.users.id, former.user.id));
		await rejectsWith(create(incident, former, 'Después'), 'CREATOR_USER_INACTIVE');
		await db.update(s.users).set({ active: true }).where(eq(s.users.id, former.user.id));
		await db
			.update(s.memberships)
			.set({ active: false })
			.where(eq(s.memberships.id, former.membership.id));
		await rejectsWith(create(incident, former, 'Después'), 'CREATOR_MEMBERSHIP_INACTIVE');
		const page = await list(incident);
		assert.deepEqual(
			page.items.map((i) => [i.id, i.author.name]),
			[[comment.id, 'Técnico Saliente']]
		);
	});

	await t.test('restricción assignedToUserId (view_own) en creación y lectura', async () => {
		const assigned = await createIncident(orgA, techA, 'open', {
			assignedToUserId: techA2.user.id
		});
		const other = await createIncident(orgA, techA, 'open', { assignedToUserId: techA.user.id });
		const unassigned = await createIncident(orgA, techA);
		const own = { assignedToUserId: techA2.user.id };

		const comment = await create(assigned, techA2, 'Asignada a mí', orgA, own);
		assert.equal((await list(assigned, {}, orgA, own)).items[0].id, comment.id);

		for (const target of [other, unassigned]) {
			await rejectsWith(create(target, techA2, 'x', orgA, own), 'INCIDENT_ACCESS_DENIED');
			await rejectsWith(list(target, {}, orgA, own), 'INCIDENT_ACCESS_DENIED');
			assert.equal((await messagesOf(target)).length, 0);
		}
		// Incidencia inexistente sigue siendo 404 aun con restricción
		await rejectsWith(list({ id: randomUUID() }, {}, orgA, own), 'INCIDENT_NOT_FOUND');
		// closed asignada: lectura permitida, creación rechazada
		const closed = await createIncident(orgA, techA, 'closed', {
			assignedToUserId: techA2.user.id
		});
		await rejectsWith(create(closed, techA2, 'x', orgA, own), 'INCIDENT_CLOSED');
		assert.deepEqual(await list(closed, {}, orgA, own), { items: [], nextCursor: null });
	});

	await t.test(
		'31-32. rollback si falla el insert del message y sin history residual',
		async () => {
			const incident = await createIncident(orgA, techA);
			const historyBefore = (await historyOf(incident)).length;
			await pg.exec(`
			CREATE FUNCTION test_fail_comment() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'forced message failure'; END $$;
			CREATE TRIGGER test_fail_comment BEFORE INSERT ON incident_messages
			FOR EACH ROW EXECUTE FUNCTION test_fail_comment();`);
			try {
				await assert.rejects(create(incident, techA, 'No debe persistir'));
			} finally {
				await pg.exec(`DROP TRIGGER test_fail_comment ON incident_messages;
				DROP FUNCTION test_fail_comment();`);
			}
			assert.equal((await messagesOf(incident)).length, 0);
			assert.equal((await historyOf(incident)).length, historyBefore);
			const [{ n }] = (
				await pg.query(
					`SELECT count(*)::int AS n FROM incident_history WHERE event_type NOT IN
				 ('created','status_changed','priority_changed','assigned','reassigned','escalated',
				  'site_changed','resolved','resolution_accepted','resolution_rejected','closed','reopened',
				  'reclassified','priority_override_applied','priority_override_modified',
				  'priority_override_removed','internal_note_added','support_level_changed')`
				)
			).rows;
			assert.equal(n, 0);
			const [{ notes }] = (
				await pg.query(
					`SELECT count(*)::int AS notes FROM incident_history WHERE event_type = 'internal_note_added'`
				)
			).rows;
			assert.equal(notes, 0, 'los comentarios públicos nunca generan internal_note_added');
		}
	);

	// =========================================================================
	// Lectura
	// =========================================================================
	await t.test('18-19. lectura devuelve solo public; internal nunca aparece', async () => {
		const incident = await createIncident(orgA, techA);
		const comment = await create(incident, techA, 'Público');
		const note = await createInternalNote(
			db,
			{ organizationId: orgA.id, incidentId: incident.id, actorUserId: techA.user.id },
			'NOTA-INTERNA-SECRETA'
		);
		const page = await list(incident);
		assert.deepEqual(
			page.items.map((i) => i.id),
			[comment.id]
		);
		const serialized = JSON.stringify(page);
		assert.ok(!serialized.includes(note.id));
		assert.ok(!serialized.includes('NOTA-INTERNA-SECRETA'));
		for (const hidden of [orgA.id, incident.id, techA.user.id, 'visibility', 'public']) {
			assert.ok(!serialized.includes(hidden), `no debe exponer ${hidden}`);
		}
	});

	await t.test('20-21. nombre legible y fallback seguro', async () => {
		const incident = await createIncident(orgA, techA);
		const plain = await createMember(orgA, { name: 'Solo Nombre', displayName: '  ' });
		const blank = await createMember(orgA, { name: '   ' });
		await create(incident, techA, 'De Ana');
		await create(incident, plain, 'De Solo Nombre');
		await create(incident, blank, 'De anónimo');
		const names = new Map((await list(incident)).items.map((i) => [i.body, i.author.name]));
		assert.deepEqual(
			names,
			new Map([
				['De Ana', 'Ana T.'],
				['De Solo Nombre', 'Solo Nombre'],
				['De anónimo', 'Usuario no disponible']
			])
		);
		assert.equal(UNAVAILABLE_AUTHOR_NAME, 'Usuario no disponible');
	});

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
			visibility: 'public',
			body: `Comentario ${i}`,
			createdAt: i < 3 ? sameInstant : new Date(Date.UTC(2026, 0, 2, 0, 0, i))
		});
	}
	// Notas internas intercaladas que nunca deben aparecer ni alterar la paginación
	for (let i = 0; i < 10; i++) {
		seeded.push({
			id: randomUUID(),
			organizationId: orgA.id,
			incidentId: paged.id,
			authorUserId: techA.user.id,
			visibility: 'internal',
			body: `Interna ${i}`,
			createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, i * 7))
		});
	}
	await db.insert(s.incidentMessages).values(seeded);
	const expectedOrder = seeded
		.filter((row) => row.visibility === 'public')
		.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
		.map((row) => row.id);

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

	await t.test('22-23. orden DESC y empate por id DESC', async () => {
		const { items } = await list(paged, { limit: '100' });
		assert.deepEqual(
			items.map((i) => i.id),
			expectedOrder.slice(0, 100)
		);
		const all = await collect(paged, '100');
		assert.deepEqual(all.slice(-3), [...tiedIds].reverse());
	});

	await t.test('24-25. limit por defecto 50 y máximo 100', async () => {
		assert.equal((await list(paged)).items.length, 50);
		assert.equal((await list(paged, { limit: '100' })).items.length, 100);
		for (const limit of ['0', '101', 'abc', '1.5', '']) {
			await rejectsWith(list(paged, { limit }), 'INVALID_INPUT');
		}
		await rejectsWith(list(paged, { visibility: 'internal' }), 'INVALID_INPUT');
	});

	await t.test('26. cursor inválido -> INVALID_INPUT', async () => {
		for (const cursor of [
			'not-base64!',
			Buffer.from('{}').toString('base64url'),
			Buffer.from(JSON.stringify(['2026-01-01', randomUUID()])).toString('base64url'),
			'a'.repeat(300)
		])
			await rejectsWith(list(paged, { cursor }), 'INVALID_INPUT');
	});

	await t.test('27. páginas consecutivas sin duplicados ni saltos', async () => {
		for (const limit of ['1', '7', '50']) {
			const ids = await collect(paged, limit);
			assert.equal(ids.length, 120);
			assert.equal(new Set(ids).size, 120);
			assert.deepEqual(ids, expectedOrder);
		}
	});

	await t.test('28. lista vacía', async () => {
		const empty = await createIncident(orgA, techA);
		assert.deepEqual(await list(empty), { items: [], nextCursor: null });
	});

	await t.test('29. la lectura no modifica datos', async () => {
		const count = async () =>
			(
				await pg.query(
					`SELECT (SELECT count(*) FROM incident_messages)::int AS m,
					        (SELECT count(*) FROM incident_history)::int AS h`
				)
			).rows[0];
		const before = await count();
		await collect(paged, '10');
		await list(incidentA);
		assert.deepEqual(await count(), before);
	});

	await t.test('30. aislamiento multi-tenant total', async () => {
		const incidentB = await createIncident(orgB, techB);
		const commentB = await create(incidentB, techB, 'Secreto de B', orgB);
		await rejectsWith(list(incidentA, {}, orgB), 'INCIDENT_NOT_FOUND');
		await rejectsWith(list(incidentB, {}, orgA), 'INCIDENT_NOT_FOUND');
		const idsA = await collect(paged, '100');
		assert.ok(!idsA.includes(commentB.id));
		assert.deepEqual(
			(await list(incidentB, {}, orgB)).items.map((i) => i.id),
			[commentB.id]
		);
	});
});

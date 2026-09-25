import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fixture, directory, expectedMigrations } from './helpers/auth-fixture.mjs';
import { applyMigrations } from './helpers/persistence-migrations.mjs';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorCode(error) {
	return error?.code ?? error?.cause?.code;
}

async function rejected(operation, code) {
	await assert.rejects(operation, (error) => {
		const expectedCodes = Array.isArray(code) ? code : [code];
		return expectedCodes.includes(errorCode(error));
	});
}

test('SoporteFlow — Etapa 5.4N-A: esquema relacional de incident_messages en PGlite', async (t) => {
	await t.test('1. Migraciones 0000..0006 se aplican limpiamente', async () => {
		const clean = await fixture(t, false);
		const applied = await applyMigrations(clean.pg, directory);
		assert.deepEqual(applied, expectedMigrations);
		assert.ok(applied.includes('0006_gifted_princess_powerful.sql'));
	});

	const f = await fixture(t, true);
	const { db, schema: s, pg } = f;

	async function createOrg(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'org-' + randomUUID() })
			.returning();
		return org;
	}

	async function createUser(name) {
		const [user] = await db.insert(s.users).values({ name }).returning();
		return user;
	}

	async function createMember(org, name) {
		const user = await createUser(name);
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
		return { user, membership };
	}

	let incidentNumber = 0;
	async function createIncident(org, creator) {
		const [incident] = await db
			.insert(s.incidents)
			.values({
				organizationId: org.id,
				incidentNumber: ++incidentNumber,
				title: 'Incidencia mensajes',
				description: 'Synthetic',
				client: 'Synthetic',
				createdByUserId: creator.user.id
			})
			.returning();
		return incident;
	}

	function message(values = {}) {
		return {
			organizationId: orgA.id,
			incidentId: incidentA.id,
			authorUserId: authorA.user.id,
			visibility: 'public',
			body: 'Mensaje de prueba',
			...values
		};
	}

	const orgA = await createOrg('Org Mensajes A');
	const orgB = await createOrg('Org Mensajes B');
	const authorA = await createMember(orgA, 'Autor A');
	const authorB = await createMember(orgB, 'Autor B');
	const noMembership = await createUser('Sin membresía');
	const incidentA = await createIncident(orgA, authorA);
	const incidentB = await createIncident(orgB, authorB);

	await t.test('2. La tabla incident_messages existe con las columnas exactas de v1', async () => {
		const res = await pg.query(
			`SELECT column_name, data_type, is_nullable, character_maximum_length
			 FROM information_schema.columns
			 WHERE table_schema = 'public' AND table_name = 'incident_messages'
			 ORDER BY ordinal_position;`
		);
		assert.deepEqual(
			res.rows.map((r) => [r.column_name, r.data_type, r.is_nullable]),
			[
				['id', 'uuid', 'NO'],
				['organization_id', 'uuid', 'NO'],
				['incident_id', 'uuid', 'NO'],
				['author_user_id', 'uuid', 'NO'],
				['visibility', 'character varying', 'NO'],
				['body', 'text', 'NO'],
				['created_at', 'timestamp with time zone', 'NO']
			]
		);
		assert.equal(res.rows.find((r) => r.column_name === 'visibility').character_maximum_length, 20);
	});

	await t.test('3. Inserción válida public', async () => {
		const [row] = await db
			.insert(s.incidentMessages)
			.values(message({ visibility: 'public' }))
			.returning();
		assert.equal(row.visibility, 'public');
		assert.equal(row.organizationId, orgA.id);
		assert.equal(row.incidentId, incidentA.id);
		assert.equal(row.authorUserId, authorA.user.id);
	});

	await t.test('4. Inserción válida internal', async () => {
		const [row] = await db
			.insert(s.incidentMessages)
			.values(message({ visibility: 'internal', body: 'Nota interna' }))
			.returning();
		assert.equal(row.visibility, 'internal');
	});

	await t.test('5. body vacío falla', async () => {
		await rejected(db.insert(s.incidentMessages).values(message({ body: '' })), '23514');
	});

	await t.test('6. body solo espacios falla', async () => {
		await rejected(db.insert(s.incidentMessages).values(message({ body: '   ' })), '23514');
	});

	await t.test('7. body de 4000 caracteres funciona', async () => {
		const body = 'x'.repeat(4000);
		const [row] = await db.insert(s.incidentMessages).values(message({ body })).returning();
		assert.equal(row.body.length, 4000);
	});

	await t.test('8. body de 4001 caracteres falla', async () => {
		await rejected(
			db.insert(s.incidentMessages).values(message({ body: 'x'.repeat(4001) })),
			'23514'
		);
	});

	await t.test('8.b body HTML/script se almacena como texto literal', async () => {
		const body = '<script>alert("x")</script><b>negrita</b>';
		const [row] = await db.insert(s.incidentMessages).values(message({ body })).returning();
		assert.equal(row.body, body);
	});

	await t.test('9. visibility inválida falla', async () => {
		for (const visibility of ['private', 'PUBLIC', '']) {
			await rejected(db.insert(s.incidentMessages).values(message({ visibility })), '23514');
		}
	});

	await t.test('10. incident de otra organización falla', async () => {
		await rejected(
			db.insert(s.incidentMessages).values(message({ incidentId: incidentB.id })),
			'23503'
		);
	});

	await t.test('11. author de otra organización falla', async () => {
		await rejected(
			db.insert(s.incidentMessages).values(message({ authorUserId: authorB.user.id })),
			'23503'
		);
	});

	await t.test('12. author sin membership falla', async () => {
		await rejected(
			db.insert(s.incidentMessages).values(message({ authorUserId: noMembership.id })),
			'23503'
		);
	});

	await t.test('13. incident inexistente falla', async () => {
		await rejected(
			db.insert(s.incidentMessages).values(message({ incidentId: randomUUID() })),
			'23503'
		);
	});

	await t.test('14. author inexistente falla', async () => {
		await rejected(
			db.insert(s.incidentMessages).values(message({ authorUserId: randomUUID() })),
			'23503'
		);
	});

	await t.test('15. ON DELETE RESTRICT del incident', async () => {
		await rejected(db.delete(s.incidents).where(eq(s.incidents.id, incidentA.id)), [
			'23001',
			'23503'
		]);
		const [still] = await db.select().from(s.incidents).where(eq(s.incidents.id, incidentA.id));
		assert.ok(still);
	});

	await t.test('16. ON DELETE RESTRICT de membership y del user (cascada bloqueada)', async () => {
		const orgC = await createOrg('Org Mensajes C');
		const authorC = await createMember(orgC, 'Autor C');
		const incidentC = await createIncident(orgC, authorC);
		// Autor distinto del creador para que solo el mensaje bloquee el borrado
		const writerC = await createMember(orgC, 'Redactor C');
		await db.insert(s.incidentMessages).values(
			message({
				organizationId: orgC.id,
				incidentId: incidentC.id,
				authorUserId: writerC.user.id
			})
		);

		await rejected(db.delete(s.memberships).where(eq(s.memberships.id, writerC.membership.id)), [
			'23001',
			'23503'
		]);
		// users -> memberships es CASCADE; la cascada queda bloqueada por el mensaje
		await rejected(db.delete(s.users).where(eq(s.users.id, writerC.user.id)), ['23001', '23503']);
		const [still] = await db
			.select()
			.from(s.memberships)
			.where(eq(s.memberships.id, writerC.membership.id));
		assert.ok(still);
	});

	await t.test('17. Aislamiento por organización', async () => {
		const [rowB] = await db
			.insert(s.incidentMessages)
			.values({
				organizationId: orgB.id,
				incidentId: incidentB.id,
				authorUserId: authorB.user.id,
				visibility: 'public',
				body: 'Mensaje B'
			})
			.returning();

		const rowsA = await db
			.select()
			.from(s.incidentMessages)
			.where(eq(s.incidentMessages.organizationId, orgA.id));
		assert.ok(rowsA.length > 0);
		assert.ok(rowsA.every((r) => r.organizationId === orgA.id && r.incidentId === incidentA.id));
		assert.ok(!rowsA.some((r) => r.id === rowB.id));

		// Incidencia y autor válidos en B, pero declarados bajo la organización A
		await rejected(
			db.insert(s.incidentMessages).values(
				message({
					organizationId: orgA.id,
					incidentId: incidentB.id,
					authorUserId: authorB.user.id
				})
			),
			'23503'
		);
		// organization_id inexistente
		await rejected(
			db.insert(s.incidentMessages).values(message({ organizationId: randomUUID() })),
			'23503'
		);
	});

	await t.test('18. Índice esperado existe con el orden correcto', async () => {
		const res = await pg.query(
			`SELECT indexname, indexdef FROM pg_indexes
			 WHERE tablename = 'incident_messages'
			 AND indexname = 'incident_messages_org_incident_visibility_created_idx';`
		);
		assert.equal(res.rows.length, 1);
		assert.match(
			res.rows[0].indexdef,
			/\(organization_id, incident_id, visibility, created_at DESC NULLS LAST, id DESC NULLS LAST\)/
		);
	});

	await t.test('19. created_at usa default now()', async () => {
		const before = Date.now();
		const [row] = await db.insert(s.incidentMessages).values(message()).returning();
		assert.ok(row.createdAt instanceof Date);
		assert.ok(Math.abs(row.createdAt.getTime() - before) < 60_000);
	});

	await t.test('20. id por defecto genera un UUID válido', async () => {
		const res = await pg.query(
			`INSERT INTO incident_messages (organization_id, incident_id, author_user_id, visibility, body)
			 VALUES ($1, $2, $3, 'internal', 'SQL directo') RETURNING id;`,
			[orgA.id, incidentA.id, authorA.user.id]
		);
		assert.match(res.rows[0].id, UUID_REGEX);
	});
});

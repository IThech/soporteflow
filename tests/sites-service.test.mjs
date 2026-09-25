import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fixture } from './helpers/auth-fixture.mjs';

function errorCode(error) {
	return error?.code ?? error?.cause?.code;
}

test('SoporteFlow — Etapa 5.4O-A: servicio Core de sedes', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, pg, server } = f;
	const sitesService = await server.ssrLoadModule('/src/lib/server/services/sites.ts');
	const { listSites, createSite, updateSite, setSiteActive, normalizeSiteName } = sitesService;
	const { IncidentServiceError, createIncidentRecord, getIncidentById } =
		await server.ssrLoadModule('/src/lib/server/services/incidents.ts');

	async function rejectsWith(operation, code) {
		await assert.rejects(operation, (error) => {
			assert.ok(error instanceof IncidentServiceError, `esperado IncidentServiceError: ${error}`);
			assert.equal(error.code, code);
			return true;
		});
	}

	async function createOrg(name, status = 'active') {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'org-' + randomUUID(), status })
			.returning();
		return org;
	}

	const orgA = await createOrg('Sedes A');
	const orgB = await createOrg('Sedes B');
	const [creatorA] = await db.insert(s.users).values({ name: 'Creador A' }).returning();
	await db.insert(s.memberships).values({ organizationId: orgA.id, userId: creatorA.id });

	const DTO_KEYS = ['active', 'createdAt', 'id', 'name', 'updatedAt'];

	await t.test('1. lista vacía', async () => {
		assert.deepEqual(await listSites(db, orgA.id), []);
	});

	let valencia;
	await t.test('2-4. crea sede válida, activa por defecto y con nombre recortado', async () => {
		valencia = await createSite(db, orgA.id, { name: '   Valencia   ' });
		assert.deepEqual(Object.keys(valencia).sort(), DTO_KEYS);
		assert.equal(valencia.name, 'Valencia');
		assert.equal(valencia.active, true);
		assert.ok(valencia.createdAt instanceof Date);
		const [row] = await db.select().from(s.sites).where(eq(s.sites.id, valencia.id));
		assert.equal(row.organizationId, orgA.id);
		assert.equal(row.name, 'Valencia');
		// espacios internos redundantes se colapsan en la forma almacenada
		const norte = await createSite(db, orgA.id, { name: 'Madrid \t  Norte' });
		assert.equal(norte.name, 'Madrid Norte');
	});

	await t.test('5-6. nombre vacío, solo espacios o inválido -> INVALID_INPUT', async () => {
		for (const name of [
			'',
			'   ',
			'\n\t',
			'x',
			' y ',
			'x'.repeat(256),
			undefined,
			null,
			42,
			'a\u0000b'
		])
			await rejectsWith(createSite(db, orgA.id, { name }), 'INVALID_INPUT');
		await rejectsWith(createSite(db, orgA.id, undefined), 'INVALID_INPUT');
		const max = await createSite(db, orgA.id, { name: 'z'.repeat(255) });
		assert.equal(max.name.length, 255);
	});

	await t.test(
		'7-9. duplicados exactos, por mayúsculas o por espacios -> SITE_NAME_DUPLICATE',
		async () => {
			for (const name of ['Valencia', 'valencia', 'VALENCIA', ' valencia ', 'VaLeNcIa'])
				await rejectsWith(createSite(db, orgA.id, { name }), 'SITE_NAME_DUPLICATE');
			for (const name of ['madrid norte', 'Madrid  Norte', ' MADRID\tNORTE '])
				await rejectsWith(createSite(db, orgA.id, { name }), 'SITE_NAME_DUPLICATE');
			assert.equal(normalizeSiteName('  Madrid \t Norte '), 'madrid norte');
			const names = (await listSites(db, orgA.id)).map((site) => site.name);
			assert.equal(names.filter((n) => n.toLowerCase() === 'valencia').length, 1);
		}
	);

	await t.test('10. el mismo nombre se permite en otra organización', async () => {
		const other = await createSite(db, orgB.id, { name: 'Valencia' });
		assert.equal(other.name, 'Valencia');
		assert.notEqual(other.id, valencia.id);
	});

	await t.test('11-12. editar nombre y rechazar duplicado', async () => {
		const barcelona = await createSite(db, orgA.id, { name: 'Barcelona' });
		const renamed = await updateSite(db, orgA.id, barcelona.id, { name: '  Barcelona   Port ' });
		assert.equal(renamed.name, 'Barcelona Port');
		assert.equal(renamed.active, true);
		assert.ok(renamed.updatedAt.getTime() >= barcelona.updatedAt.getTime());
		// cambiar solo mayúsculas del propio nombre está permitido
		const recased = await updateSite(db, orgA.id, barcelona.id, { name: 'BARCELONA PORT' });
		assert.equal(recased.name, 'BARCELONA PORT');
		await rejectsWith(
			updateSite(db, orgA.id, barcelona.id, { name: 'valencia' }),
			'SITE_NAME_DUPLICATE'
		);
		await rejectsWith(updateSite(db, orgA.id, barcelona.id, { name: '  ' }), 'INVALID_INPUT');
		const [row] = await db.select().from(s.sites).where(eq(s.sites.id, barcelona.id));
		assert.equal(row.name, 'BARCELONA PORT');
	});

	await t.test(
		'13-15, 21, 27. desactivar conserva la fila, reactivar y sin borrado físico',
		async () => {
			const elvas = await createSite(db, orgA.id, { name: 'Elvas' });
			const off = await setSiteActive(db, orgA.id, elvas.id, false);
			assert.equal(off.active, false);
			assert.equal(off.name, 'Elvas');
			const [row] = await db.select().from(s.sites).where(eq(s.sites.id, elvas.id));
			assert.ok(row, 'la fila se conserva');
			assert.equal(row.active, false);
			// 21. la sede inactiva sigue listándose para gestión
			assert.ok(
				(await listSites(db, orgA.id)).some((site) => site.id === elvas.id && !site.active)
			);
			// renombrar no cambia active
			assert.equal((await updateSite(db, orgA.id, elvas.id, { name: 'Elvas Sur' })).active, false);
			// el nombre de una sede inactiva sigue ocupado
			await rejectsWith(createSite(db, orgA.id, { name: 'elvas sur' }), 'SITE_NAME_DUPLICATE');
			const on = await setSiteActive(db, orgA.id, elvas.id, true);
			assert.equal(on.active, true);
			// idempotente
			assert.equal((await setSiteActive(db, orgA.id, elvas.id, true)).active, true);
			for (const value of ['false', 0, null, undefined])
				await rejectsWith(setSiteActive(db, orgA.id, elvas.id, value), 'INVALID_INPUT');
			// 27. no existe borrado
			assert.equal(sitesService.deleteSite, undefined);
			assert.deepEqual(
				Object.keys(sitesService)
					.filter((key) => typeof sitesService[key] === 'function')
					.sort(),
				[
					'canonicalSiteName',
					'createSite',
					'listSites',
					'normalizeSiteName',
					'setSiteActive',
					'updateSite'
				]
			);
		}
	);

	await t.test('22. filtro activeOnly', async () => {
		const sevilla = await createSite(db, orgA.id, { name: 'Sevilla' });
		await setSiteActive(db, orgA.id, sevilla.id, false);
		const active = await listSites(db, orgA.id, { activeOnly: true });
		assert.ok(active.length > 0);
		assert.ok(active.every((site) => site.active));
		assert.ok(!active.some((site) => site.id === sevilla.id));
		const all = await listSites(db, orgA.id);
		assert.ok(all.some((site) => site.id === sevilla.id));
		// orden determinista name ASC, id ASC
		const names = all.map((site) => site.name);
		assert.deepEqual(
			names,
			[...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		);
	});

	await t.test('16-19, 30. aislamiento multi-tenant e IDs inexistentes', async () => {
		const siteB = (await listSites(db, orgB.id))[0];
		// 16. listas aisladas
		const listA = await listSites(db, orgA.id);
		assert.ok(!listA.some((site) => site.id === siteB.id));
		assert.deepEqual(
			(await listSites(db, orgB.id)).map((site) => site.id),
			[siteB.id]
		);
		for (const site of listA) assert.ok(!('organizationId' in site));
		// 17-18. update/toggle cross-tenant -> no encontrado, sin cambios
		await rejectsWith(updateSite(db, orgA.id, siteB.id, { name: 'Hackeada' }), 'SITE_NOT_FOUND');
		await rejectsWith(setSiteActive(db, orgA.id, siteB.id, false), 'SITE_NOT_FOUND');
		const [row] = await db.select().from(s.sites).where(eq(s.sites.id, siteB.id));
		assert.equal(row.name, 'Valencia');
		assert.equal(row.active, true);
		// 19. inexistente, mismo error que cross-tenant
		for (const operation of [
			updateSite(db, orgA.id, randomUUID(), { name: 'Nueva' }),
			setSiteActive(db, orgA.id, randomUUID(), true)
		]) {
			await assert.rejects(operation, (error) => {
				assert.equal(error.code, 'SITE_NOT_FOUND');
				assert.equal(error.message, 'Site not found');
				assert.ok(!error.message.includes(orgB.id));
				return true;
			});
		}
		// ids inválidos
		await rejectsWith(listSites(db, 'x'), 'INVALID_INPUT');
		await rejectsWith(updateSite(db, orgA.id, 'x', { name: 'Nueva' }), 'INVALID_INPUT');
		await rejectsWith(setSiteActive(db, 'x', siteB.id, true), 'INVALID_INPUT');
	});

	await t.test('20. organización inexistente o no operativa', async () => {
		const suspended = await createOrg('Suspendida', 'suspended');
		const trial = await createOrg('Trial', 'trial');
		await rejectsWith(createSite(db, randomUUID(), { name: 'Fantasma' }), 'ORGANIZATION_NOT_FOUND');
		for (const org of [suspended, trial])
			await rejectsWith(createSite(db, org.id, { name: 'Sede' }), 'ORGANIZATION_NOT_OPERATIONAL');
		// una sede existente de una org suspendida no se puede modificar
		const [legacy] = await db
			.insert(s.sites)
			.values({ organizationId: suspended.id, name: 'Legacy' })
			.returning();
		await rejectsWith(
			setSiteActive(db, suspended.id, legacy.id, false),
			'ORGANIZATION_NOT_OPERATIONAL'
		);
		// la lectura no depende del estado (la autorización la hará la API)
		assert.equal((await listSites(db, suspended.id)).length, 1);
		assert.deepEqual(await listSites(db, randomUUID()), []);
	});

	await t.test('23-26. relación con incidencias', async () => {
		const madrid = await createSite(db, orgA.id, { name: 'Madrid Centro' });
		const siteB = (await listSites(db, orgB.id))[0];
		const input = { title: 'Con sede', description: 'Desc', client: 'Cliente' };
		const ctx = { organizationId: orgA.id, creatorUserId: creatorA.id };

		// 23. siteId válido
		const { incident } = await createIncidentRecord(db, ctx, { ...input, siteId: madrid.id });
		assert.equal(incident.siteId, madrid.id);
		// sin sede también es válido
		const { incident: noSite } = await createIncidentRecord(db, ctx, input);
		assert.equal(noSite.siteId, null);

		// 24. sede de otra organización
		await rejectsWith(
			createIncidentRecord(db, ctx, { ...input, siteId: siteB.id }),
			'SITE_NOT_FOUND'
		);
		await rejectsWith(
			createIncidentRecord(db, ctx, { ...input, siteId: randomUUID() }),
			'SITE_NOT_FOUND'
		);
		// y la FK compuesta lo impide también a nivel de base de datos
		await assert.rejects(
			db.update(s.incidents).set({ siteId: siteB.id }).where(eq(s.incidents.id, incident.id)),
			(error) => errorCode(error) === '23503'
		);

		// 25. sede inactiva no válida para nuevas asociaciones
		await setSiteActive(db, orgA.id, madrid.id, false);
		await rejectsWith(
			createIncidentRecord(db, ctx, { ...input, siteId: madrid.id }),
			'SITE_INACTIVE'
		);

		// 26. la incidencia histórica sigue apuntando y es legible
		const detail = await getIncidentById(db, { organizationId: orgA.id }, incident.id);
		assert.equal(detail.incident.siteId, madrid.id);
		// y la sede con incidencias no se puede borrar físicamente (RESTRICT)
		await assert.rejects(db.delete(s.sites).where(eq(s.sites.id, madrid.id)), (error) =>
			['23001', '23503'].includes(errorCode(error))
		);
	});

	await t.test('28. transacción: un fallo no deja escritura parcial', async () => {
		const toledo = await createSite(db, orgA.id, { name: 'Toledo' });
		await pg.exec(`
			CREATE FUNCTION test_fail_site() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'forced site failure'; END $$;
			CREATE TRIGGER test_fail_site AFTER UPDATE ON sites
			FOR EACH ROW EXECUTE FUNCTION test_fail_site();`);
		try {
			await assert.rejects(updateSite(db, orgA.id, toledo.id, { name: 'Toledo Norte' }));
			await assert.rejects(setSiteActive(db, orgA.id, toledo.id, false));
		} finally {
			await pg.exec('DROP TRIGGER test_fail_site ON sites; DROP FUNCTION test_fail_site();');
		}
		const [row] = await db.select().from(s.sites).where(eq(s.sites.id, toledo.id));
		assert.equal(row.name, 'Toledo');
		assert.equal(row.active, true);
		// el proxy db de la aplicación abre transacción real ('transaction' in db)
		const appDb = (await server.ssrLoadModule('$lib/server/db')).db;
		assert.equal('transaction' in appDb, true);
		const viaApp = await createSite(appDb, orgA.id, { name: 'Vía proxy' });
		assert.equal(viaApp.name, 'Vía proxy');
	});

	await t.test(
		'29. el índice normalizado bloquea duplicados aunque se salte el servicio',
		async () => {
			// PGlite es de una sola conexión: no hay carrera real. Se prueba la garantía de la base de
			// datos, que es la que serializa dos creaciones concurrentes (la segunda falla con 23505).
			for (const name of ['valencia', ' VALENCIA ', 'Valencia']) {
				await assert.rejects(
					db.insert(s.sites).values({ organizationId: orgA.id, name }),
					(error) => errorCode(error) === '23505'
				);
			}
			await assert.rejects(
				db.insert(s.sites).values({ organizationId: orgA.id, name: 'Madrid   norte' }),
				(error) => errorCode(error) === '23505'
			);
			// mismo nombre en otra organización, directo en base de datos, permitido
			const orgC = await createOrg('Sedes C');
			await db.insert(s.sites).values({ organizationId: orgC.id, name: 'valencia' });
			const index = await pg.query(
				`SELECT indexdef FROM pg_indexes WHERE tablename = 'sites'
			 AND indexname = 'sites_org_normalized_name_unique_idx'`
			);
			assert.equal(index.rows.length, 1);
			assert.match(index.rows[0].indexdef, /CREATE UNIQUE INDEX/);
			assert.match(index.rows[0].indexdef, /lower\(regexp_replace\(btrim/);
			// dos creaciones "simultáneas" del mismo nombre: solo una prospera
			const results = await Promise.allSettled([
				createSite(db, orgC.id, { name: 'Lisboa' }),
				createSite(db, orgC.id, { name: ' lisboa ' })
			]);
			assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
			const rejected = results.find((r) => r.status === 'rejected');
			assert.equal(rejected.reason.code, 'SITE_NAME_DUPLICATE');
		}
	);
});

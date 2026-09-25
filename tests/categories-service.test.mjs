import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { fixture, directory, expectedMigrations } from './helpers/auth-fixture.mjs';
import { applyMigrations } from './helpers/persistence-migrations.mjs';

function errorCode(error) {
	return error?.code ?? error?.cause?.code;
}

test('SoporteFlow — Etapa 5.4P-A: catálogo Core de categorías', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, pg, server } = f;
	const service = await server.ssrLoadModule('/src/lib/server/services/categories.ts');
	const { listCategories, createCategory, updateCategory, setCategoryActive } = service;
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

	async function createOrg(name, status = 'active') {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'org-' + randomUUID(), status })
			.returning();
		return org;
	}
	async function rowOf(id) {
		const [row] = await db.select().from(s.categories).where(eq(s.categories.id, id));
		return row;
	}

	const orgA = await createOrg('Categorías A');
	const orgB = await createOrg('Categorías B');
	const DTO_KEYS = ['active', 'createdAt', 'description', 'id', 'name', 'updatedAt'];

	// =========================================================================
	// Schema / migración
	// =========================================================================
	await t.test('schema: migración 0009 aplicada limpiamente', async () => {
		// PGlite independiente: otro fixture reemplazaría la base activa del proxy $lib/server/db.
		const clean = new PGlite();
		try {
			const applied = await applyMigrations(clean, directory);
			assert.deepEqual(applied, expectedMigrations);
			assert.ok(applied.includes('0009_lumpy_hellion.sql'));
		} finally {
			await clean.close();
		}
	});

	await t.test('schema: columnas, nulabilidad y defaults', async () => {
		const { rows } = await pg.query(
			`SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
			 FROM information_schema.columns WHERE table_name = 'categories' ORDER BY ordinal_position`
		);
		assert.deepEqual(
			rows.map((r) => [r.column_name, r.data_type, r.is_nullable]),
			[
				['id', 'uuid', 'NO'],
				['organization_id', 'uuid', 'NO'],
				['name', 'character varying', 'NO'],
				['description', 'text', 'YES'],
				['active', 'boolean', 'NO'],
				['created_at', 'timestamp with time zone', 'NO'],
				['updated_at', 'timestamp with time zone', 'NO']
			]
		);
		assert.equal(rows.find((r) => r.column_name === 'name').character_maximum_length, 100);
		assert.equal(rows.find((r) => r.column_name === 'active').column_default, 'true');
		for (const forbidden of ['parent_id', 'color', 'icon', 'code', 'default_team_id', 'priority'])
			assert.ok(!rows.some((r) => r.column_name === forbidden), forbidden);
	});

	await t.test(
		'schema: constraints, índice normalizado, FK; incidents.category_id integrado en 5.4P-C',
		async () => {
			const constraints = await pg.query(
				`SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint
			 WHERE conrelid = 'categories'::regclass ORDER BY conname`
			);
			const byName = Object.fromEntries(constraints.rows.map((r) => [r.conname, r]));
			assert.match(byName.categories_id_org_unique.def, /UNIQUE \(id, organization_id\)/);
			assert.match(byName.categories_org_name_unique.def, /UNIQUE \(organization_id, name\)/);
			assert.match(
				byName.categories_organization_id_organizations_id_fk.def,
				/FOREIGN KEY \(organization_id\) REFERENCES organizations\(id\) ON DELETE RESTRICT/
			);
			const index = await pg.query(
				`SELECT indexdef FROM pg_indexes WHERE tablename = 'categories'
			 AND indexname = 'categories_org_normalized_name_unique_idx'`
			);
			assert.equal(index.rows.length, 1);
			assert.match(index.rows[0].indexdef, /CREATE UNIQUE INDEX/);
			assert.match(index.rows[0].indexdef, /lower\(regexp_replace\(btrim/);
			const incidentColumns = await pg.query(
				`SELECT column_name FROM information_schema.columns WHERE table_name = 'incidents'`
			);
			assert.ok(incidentColumns.rows.some((r) => r.column_name === 'category_id'));
		}
	);

	// =========================================================================
	// Creación
	// =========================================================================
	await t.test('1. lista vacía', async () => {
		assert.deepEqual(await listCategories(db, orgA.id), []);
	});

	let hardware;
	await t.test('2-7, 38. crear válida, activa, description y nombre canónico', async () => {
		hardware = await createCategory(db, orgA.id, { name: '  Hardware  ' });
		assert.deepEqual(Object.keys(hardware).sort(), DTO_KEYS);
		assert.equal(hardware.name, 'Hardware');
		assert.equal(hardware.active, true);
		assert.equal(hardware.description, null);
		assert.ok(hardware.createdAt instanceof Date && hardware.updatedAt instanceof Date);
		assert.ok(hardware.updatedAt.getTime() >= hardware.createdAt.getTime());
		const red = await createCategory(db, orgA.id, {
			name: 'Red \t  y   Comunicaciones',
			description: '  Switches, wifi y VPN  '
		});
		assert.equal(red.name, 'Red y Comunicaciones');
		assert.equal(red.description, 'Switches, wifi y VPN');
		const blank = await createCategory(db, orgA.id, { name: 'Software', description: '   ' });
		assert.equal(blank.description, null);
		const row = await rowOf(hardware.id);
		assert.equal(row.organizationId, orgA.id);
	});

	await t.test('8-14. validación de name y description', async () => {
		for (const name of [
			'',
			'   ',
			'\n\t',
			'x',
			' y ',
			'a\u0000b',
			'x'.repeat(101),
			undefined,
			null,
			42
		])
			await rejectsWith(createCategory(db, orgA.id, { name }), 'INVALID_INPUT');
		for (const description of ['a\u0000b', 'd'.repeat(1001), 42, {}])
			await rejectsWith(
				createCategory(db, orgA.id, { name: 'Válida', description }),
				'INVALID_INPUT'
			);
		await rejectsWith(createCategory(db, orgA.id, undefined), 'INVALID_INPUT');
		const max = await createCategory(db, orgA.id, {
			name: 'n'.repeat(100),
			description: 'd'.repeat(1000)
		});
		assert.equal(max.name.length, 100);
		assert.equal(max.description.length, 1000);
	});

	await t.test('15-17. duplicados exacto, por mayúsculas y por espacios', async () => {
		for (const name of ['Hardware', 'hardware', 'HARDWARE', ' hardware ', 'Hardware   '])
			await rejectsWith(createCategory(db, orgA.id, { name }), 'CATEGORY_NAME_DUPLICATE');
		for (const name of ['red y comunicaciones', 'RED  Y  COMUNICACIONES'])
			await rejectsWith(createCategory(db, orgA.id, { name }), 'CATEGORY_NAME_DUPLICATE');
		assert.equal(
			(await listCategories(db, orgA.id)).filter((c) => c.name.toLowerCase() === 'hardware').length,
			1
		);
	});

	await t.test('19-20. mismo nombre en otro tenant; listas aisladas', async () => {
		const other = await createCategory(db, orgB.id, { name: 'Hardware' });
		assert.notEqual(other.id, hardware.id);
		const listA = await listCategories(db, orgA.id);
		assert.ok(!listA.some((c) => c.id === other.id));
		assert.deepEqual(
			(await listCategories(db, orgB.id)).map((c) => c.id),
			[other.id]
		);
		for (const category of listA) assert.ok(!('organizationId' in category));
	});

	// =========================================================================
	// Actualización
	// =========================================================================
	await t.test(
		'21-24. actualizar name/description, limpiar a null, no-op y duplicado',
		async () => {
			const printers = await createCategory(db, orgA.id, {
				name: 'Impresoras',
				description: 'Inicial'
			});
			const renamed = await updateCategory(db, orgA.id, printers.id, {
				name: '  Impresión   y escáneres '
			});
			assert.equal(renamed.name, 'Impresión y escáneres');
			assert.equal(renamed.description, 'Inicial', 'description se conserva si se omite');
			assert.equal(renamed.active, true);
			const described = await updateCategory(db, orgA.id, printers.id, { description: ' Nueva ' });
			assert.equal(described.description, 'Nueva');
			assert.equal(described.name, 'Impresión y escáneres');
			const cleared = await updateCategory(db, orgA.id, printers.id, { description: null });
			assert.equal(cleared.description, null);
			assert.equal(
				(await updateCategory(db, orgA.id, printers.id, { description: '  ' })).description,
				null
			);
			// no-op: mismos valores canónicos, sin escritura
			const noop = await updateCategory(db, orgA.id, printers.id, {
				name: 'Impresión  y escáneres',
				description: null
			});
			assert.equal(noop.updatedAt.getTime(), cleared.updatedAt.getTime());
			// cambiar solo mayúsculas del propio nombre está permitido
			assert.equal(
				(await updateCategory(db, orgA.id, printers.id, { name: 'IMPRESIÓN Y ESCÁNERES' })).name,
				'IMPRESIÓN Y ESCÁNERES'
			);
			await rejectsWith(
				updateCategory(db, orgA.id, printers.id, { name: 'hardware' }),
				'CATEGORY_NAME_DUPLICATE'
			);
			for (const input of [{}, undefined, { name: ' ' }, { description: 5 }, { name: 'a\u0000b' }])
				await rejectsWith(updateCategory(db, orgA.id, printers.id, input), 'INVALID_INPUT');
			assert.equal((await rowOf(printers.id)).name, 'IMPRESIÓN Y ESCÁNERES');
		}
	);

	await t.test('25-26. update cross-tenant o inexistente -> mismo CATEGORY_NOT_FOUND', async () => {
		const [categoryB] = await listCategories(db, orgB.id);
		for (const id of [categoryB.id, randomUUID()]) {
			await assert.rejects(updateCategory(db, orgA.id, id, { name: 'Tomada' }), (error) => {
				assert.equal(error.code, 'CATEGORY_NOT_FOUND');
				assert.equal(error.message, 'Category not found');
				assert.ok(!error.message.includes(orgB.id));
				return true;
			});
		}
		assert.equal((await rowOf(categoryB.id)).name, 'Hardware');
		await rejectsWith(updateCategory(db, orgA.id, 'x', { name: 'Ok' }), 'INVALID_INPUT');
	});

	// =========================================================================
	// Activo / inactivo
	// =========================================================================
	await t.test(
		'18, 27-34. desactivar, reactivar, idempotencia, listados y sin delete',
		async () => {
			const legacy = await createCategory(db, orgA.id, { name: 'Legacy' });
			const off = await setCategoryActive(db, orgA.id, legacy.id, false);
			assert.equal(off.active, false);
			assert.ok(await rowOf(legacy.id), 'la fila se conserva');
			// idempotente: mismo estado, sin escritura
			const again = await setCategoryActive(db, orgA.id, legacy.id, false);
			assert.equal(again.updatedAt.getTime(), off.updatedAt.getTime());
			// 18. el nombre de una inactiva sigue ocupado
			await rejectsWith(
				createCategory(db, orgA.id, { name: ' legacy ' }),
				'CATEGORY_NAME_DUPLICATE'
			);
			// editar no reactiva
			assert.equal(
				(await updateCategory(db, orgA.id, legacy.id, { description: 'Histórica' })).active,
				false
			);
			// 31-33. listados
			const all = await listCategories(db, orgA.id);
			assert.ok(all.some((c) => c.id === legacy.id && !c.active));
			assert.deepEqual(await listCategories(db, orgA.id, { activeOnly: false }), all);
			const active = await listCategories(db, orgA.id, { activeOnly: true });
			assert.ok(active.length > 0 && active.every((c) => c.active));
			assert.ok(!active.some((c) => c.id === legacy.id));
			const names = all.map((c) => c.name);
			assert.deepEqual(
				names,
				[...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
			);
			// reactivar
			assert.equal((await setCategoryActive(db, orgA.id, legacy.id, true)).active, true);
			for (const value of ['false', 0, null, undefined])
				await rejectsWith(setCategoryActive(db, orgA.id, legacy.id, value), 'INVALID_INPUT');
			// cross-tenant / inexistente
			const [categoryB] = await listCategories(db, orgB.id);
			for (const id of [categoryB.id, randomUUID()])
				await rejectsWith(setCategoryActive(db, orgA.id, id, false), 'CATEGORY_NOT_FOUND');
			assert.equal((await rowOf(categoryB.id)).active, true);
			// 34. no existe delete
			assert.equal(service.deleteCategory, undefined);
			assert.deepEqual(
				Object.keys(service)
					.filter((k) => typeof service[k] === 'function')
					.sort(),
				[
					'canonicalCategoryName',
					'createCategory',
					'listCategories',
					'normalizeCategoryName',
					'setCategoryActive',
					'updateCategory'
				]
			);
		}
	);

	await t.test('37. organización inexistente o no operativa', async () => {
		const suspended = await createOrg('Suspendida', 'suspended');
		const trial = await createOrg('Trial', 'trial');
		await rejectsWith(
			createCategory(db, randomUUID(), { name: 'Fantasma' }),
			'ORGANIZATION_NOT_FOUND'
		);
		for (const org of [suspended, trial])
			await rejectsWith(
				createCategory(db, org.id, { name: 'Nueva' }),
				'ORGANIZATION_NOT_OPERATIONAL'
			);
		const [legacy] = await db
			.insert(s.categories)
			.values({ organizationId: suspended.id, name: 'Antigua' })
			.returning();
		await rejectsWith(
			updateCategory(db, suspended.id, legacy.id, { name: 'Cambio' }),
			'ORGANIZATION_NOT_OPERATIONAL'
		);
		await rejectsWith(
			setCategoryActive(db, suspended.id, legacy.id, false),
			'ORGANIZATION_NOT_OPERATIONAL'
		);
		// la lectura no depende del estado (igual que listSites)
		assert.equal((await listCategories(db, suspended.id)).length, 1);
		assert.deepEqual(await listCategories(db, randomUUID()), []);
		await rejectsWith(listCategories(db, 'x'), 'INVALID_INPUT');
	});

	// =========================================================================
	// Integridad DB, transacciones y concurrencia
	// =========================================================================
	await t.test('35-36. la base de datos rechaza duplicados y referencias inválidas', async () => {
		for (const name of ['hardware', ' HARDWARE ', 'Hardware'])
			await assert.rejects(
				db.insert(s.categories).values({ organizationId: orgA.id, name }),
				(e) => errorCode(e) === '23505'
			);
		await assert.rejects(
			db.insert(s.categories).values({ organizationId: randomUUID(), name: 'Huérfana' }),
			(e) => errorCode(e) === '23503'
		);
		// RESTRICT: una organización con categorías no se borra
		await assert.rejects(db.delete(s.organizations).where(eq(s.organizations.id, orgB.id)), (e) =>
			['23001', '23503'].includes(errorCode(e))
		);
		// (id, organization_id) es la clave para FKs compuestas futuras: el par cruzado no existe
		const [categoryB] = await listCategories(db, orgB.id);
		const { rows } = await pg.query(
			'SELECT 1 FROM categories WHERE id = $1 AND organization_id = $2',
			[categoryB.id, orgA.id]
		);
		assert.equal(rows.length, 0);
	});

	await t.test('39. rollback: un fallo en la escritura no deja cambios', async () => {
		const target = await createCategory(db, orgA.id, { name: 'Rollback' });
		await pg.exec(`
			CREATE FUNCTION test_fail_category() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'forced category failure'; END $$;
			CREATE TRIGGER test_fail_category AFTER INSERT OR UPDATE ON categories
			FOR EACH ROW EXECUTE FUNCTION test_fail_category();`);
		try {
			await assert.rejects(createCategory(db, orgA.id, { name: 'No persiste' }));
			await assert.rejects(updateCategory(db, orgA.id, target.id, { name: 'Rollback 2' }));
			await assert.rejects(setCategoryActive(db, orgA.id, target.id, false));
		} finally {
			await pg.exec(
				'DROP TRIGGER test_fail_category ON categories; DROP FUNCTION test_fail_category();'
			);
		}
		const row = await rowOf(target.id);
		assert.equal(row.name, 'Rollback');
		assert.equal(row.active, true);
		assert.ok(!(await listCategories(db, orgA.id)).some((c) => c.name === 'No persiste'));
		// el proxy db de la aplicación abre transacción real
		const appDb = (await server.ssrLoadModule('$lib/server/db')).db;
		assert.equal('transaction' in appDb, true);
		assert.equal((await createCategory(appDb, orgA.id, { name: 'Vía proxy' })).name, 'Vía proxy');
	});

	await t.test(
		'40. dos creaciones "simultáneas": una prospera y otra CATEGORY_NAME_DUPLICATE',
		async () => {
			// PGlite es de una sola conexión: la garantía real la da el índice único normalizado.
			const orgC = await createOrg('Categorías C');
			const results = await Promise.allSettled([
				createCategory(db, orgC.id, { name: 'Hardware' }),
				createCategory(db, orgC.id, { name: ' hardware ' })
			]);
			assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
			const rejected = results.find((r) => r.status === 'rejected');
			assert.equal(rejected.reason.code, 'CATEGORY_NAME_DUPLICATE');
			assert.equal((await listCategories(db, orgC.id)).length, 1);
		}
	);

	await t.test(
		'seguridad: sin relación con permissions.category, demo ni catálogos fijos',
		async () => {
			const source = fs.readFileSync('src/lib/server/services/categories.ts', 'utf8');
			for (const forbidden of [
				'permissions',
				'localStorage',
				'$lib/categories',
				'$lib/data',
				'classification'
			])
				assert.ok(!source.includes(forbidden), forbidden);
			const perms = await pg.query(
				`SELECT column_name FROM information_schema.columns WHERE table_name = 'permissions' AND column_name = 'category'`
			);
			assert.equal(perms.rows.length, 1, 'permissions.category sigue intacta');
		}
	);
});

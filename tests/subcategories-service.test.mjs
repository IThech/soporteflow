import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fixture } from './helpers/auth-fixture.mjs';

test('SoporteFlow — Subcategories Service Core & Integrity', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;

	const subcatService = await server.ssrLoadModule('/src/lib/server/services/subcategories.ts');
	const catService = await server.ssrLoadModule('/src/lib/server/services/categories.ts');
	const { IncidentServiceError } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);

	const {
		canonicalSubcategoryName,
		normalizeSubcategoryName,
		listSubcategories,
		getCategoryTree,
		createSubcategory,
		updateSubcategory,
		setSubcategoryActive
	} = subcatService;

	const { createCategory, setCategoryActive } = catService;

	const [orgA, orgB] = await db
		.insert(s.organizations)
		.values([
			{ name: 'Subcategories Core Org A', slug: 'subcat-a-' + randomUUID(), status: 'active' },
			{ name: 'Subcategories Core Org B', slug: 'subcat-b-' + randomUUID(), status: 'active' }
		])
		.returning();

	// Canonicalization & Normalization unit checks
	await t.test('Canonical and normalized name formatting', () => {
		assert.equal(canonicalSubcategoryName('   Portátiles   Pro  '), 'Portátiles Pro');
		assert.equal(normalizeSubcategoryName('   Portátiles   PRO  '), 'portátiles pro');
	});

	// Setup parent categories
	const cat1 = await createCategory(db, orgA.id, {
		name: 'Hardware',
		description: 'Equipos físicos'
	});
	const cat2 = await createCategory(db, orgA.id, { name: 'Software', description: 'Programas' });
	const catB = await createCategory(db, orgB.id, { name: 'Hardware B' });

	let sub1;
	await t.test('createSubcategory: creates valid subcategory with trimmed name', async () => {
		sub1 = await createSubcategory(db, orgA.id, cat1.id, {
			name: '  Portátiles  ',
			description: '  Laptops y notebooks  '
		});
		assert.equal(sub1.name, 'Portátiles');
		assert.equal(sub1.description, 'Laptops y notebooks');
		assert.equal(sub1.categoryId, cat1.id);
		assert.equal(sub1.organizationId, orgA.id);
		assert.equal(sub1.active, true);
	});

	await t.test('createSubcategory: duplicate name within same category throws error', async () => {
		await assert.rejects(
			() => createSubcategory(db, orgA.id, cat1.id, { name: 'portátiles' }),
			(err) => err instanceof IncidentServiceError && err.code === 'SUBCATEGORY_NAME_DUPLICATE'
		);
	});

	await t.test('createSubcategory: same name allowed in DIFFERENT category', async () => {
		const subCat2 = await createSubcategory(db, orgA.id, cat2.id, {
			name: 'Portátiles'
		});
		assert.equal(subCat2.name, 'Portátiles');
		assert.equal(subCat2.categoryId, cat2.id);
	});

	await t.test('createSubcategory: same name allowed in DIFFERENT organization', async () => {
		const subOrgB = await createSubcategory(db, orgB.id, catB.id, {
			name: 'Portátiles'
		});
		assert.equal(subOrgB.name, 'Portátiles');
		assert.equal(subOrgB.organizationId, orgB.id);
	});

	await t.test('createSubcategory: parent category inactive throws CATEGORY_INACTIVE', async () => {
		const inactiveCat = await createCategory(db, orgA.id, { name: 'Cat Inactiva' });
		await setCategoryActive(db, orgA.id, inactiveCat.id, false);

		await assert.rejects(
			() => createSubcategory(db, orgA.id, inactiveCat.id, { name: 'Cualquiera' }),
			(err) => err instanceof IncidentServiceError && err.code === 'CATEGORY_INACTIVE'
		);
	});

	await t.test('createSubcategory: cross-tenant category throws CATEGORY_NOT_FOUND', async () => {
		await assert.rejects(
			() => createSubcategory(db, orgA.id, catB.id, { name: 'Intruso' }),
			(err) => err instanceof IncidentServiceError && err.code === 'CATEGORY_NOT_FOUND'
		);
	});

	await t.test('listSubcategories: filtering and sorting', async () => {
		const allA = await listSubcategories(db, orgA.id);
		assert.ok(allA.length >= 2);

		const onlyCat1 = await listSubcategories(db, orgA.id, { categoryId: cat1.id });
		assert.equal(onlyCat1.length, 1);
		assert.equal(onlyCat1[0].id, sub1.id);

		const orgBList = await listSubcategories(db, orgB.id);
		assert.equal(orgBList.length, 1);
		assert.equal(orgBList[0].organizationId, orgB.id);
	});

	await t.test('updateSubcategory: updates name and description, clears to null', async () => {
		const updated = await updateSubcategory(db, orgA.id, sub1.id, {
			name: 'Portátiles y Convertibles',
			description: null
		});
		assert.equal(updated.name, 'Portátiles y Convertibles');
		assert.equal(updated.description, null);

		// Duplicate within category is rejected
		const subA2 = await createSubcategory(db, orgA.id, cat1.id, { name: 'Monitores' });
		await assert.rejects(
			() => updateSubcategory(db, orgA.id, subA2.id, { name: 'portátiles y convertibles' }),
			(err) => err instanceof IncidentServiceError && err.code === 'SUBCATEGORY_NAME_DUPLICATE'
		);
	});

	await t.test(
		'setSubcategoryActive: toggle active, reject activation if category is inactive',
		async () => {
			// Deactivate
			const deact = await setSubcategoryActive(db, orgA.id, sub1.id, false);
			assert.equal(deact.active, false);

			// Reactivate
			const react = await setSubcategoryActive(db, orgA.id, sub1.id, true);
			assert.equal(react.active, true);

			// Deactivate parent category
			await setCategoryActive(db, orgA.id, cat1.id, false);

			// Verify cascade: sub1 is now inactive
			const [inDb] = await db.select().from(s.subcategories).where(eq(s.subcategories.id, sub1.id));
			assert.equal(inDb.active, false);

			// Cannot activate sub1 while cat1 is inactive
			await assert.rejects(
				() => setSubcategoryActive(db, orgA.id, sub1.id, true),
				(err) => err instanceof IncidentServiceError && err.code === 'CATEGORY_INACTIVE'
			);

			// Reactivate cat1
			await setCategoryActive(db, orgA.id, cat1.id, true);
			const react2 = await setSubcategoryActive(db, orgA.id, sub1.id, true);
			assert.equal(react2.active, true);
		}
	);

	await t.test(
		'getCategoryTree: returns structured category and subcategory hierarchy',
		async () => {
			const tree = await getCategoryTree(db, orgA.id);
			assert.ok(Array.isArray(tree));
			const node1 = tree.find((c) => c.id === cat1.id);
			assert.ok(node1);
			assert.ok(Array.isArray(node1.subcategories));
			assert.ok(node1.subcategories.some((s) => s.id === sub1.id));
		}
	);
});

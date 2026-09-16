import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('Fase 2D.2A — Subcategorías demo de Nodhouses e inicialización segura', async (suite) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const {
			demoSubcategories,
			initializeSubcategoriesCatalog,
			loadSubcategoriesResult,
			isSubcategoryList,
			getOrganizationSubcategories,
			getAvailableSubcategories,
			SUBCATEGORIES_STORAGE_KEY
		} = await server.ssrLoadModule('/src/lib/classification/subcategories-catalog.ts');

		const { initialCategories } = await server.ssrLoadModule('/src/lib/data/categories.ts');
		const { demoOrganization } = await server.ssrLoadModule('/src/lib/data/organizations.ts');
		const { classifyIncident, createStandardPriorityMatrix } = await server.ssrLoadModule(
			'/src/lib/classification/engine.ts'
		);

		const orgId = demoOrganization.id; // 'org-nodhouses'

		function createMockStorage(initial = {}) {
			const store = new Map(Object.entries(initial));
			return {
				store,
				getItem(key) {
					return this.store.get(key) ?? null;
				},
				setItem(key, value) {
					this.store.set(key, String(value));
				},
				removeItem(key) {
					this.store.delete(key);
				}
			};
		}

		// -------------------------------------------------------------------------
		// 1. Identificadores únicos y esquema de demoSubcategories
		// -------------------------------------------------------------------------
		await suite.test('1. Identificadores únicos y esquema de demoSubcategories', async (t) => {
			await t.test(
				'Contiene entre 2 y 4 subcategorías por cada categoría activa de Nodhouses',
				() => {
					const activeCategoryIds = initialCategories.filter((c) => c.active).map((c) => c.id);
					assert.equal(activeCategoryIds.length, 6);

					for (const catId of activeCategoryIds) {
						const count = demoSubcategories.filter((s) => s.categoryId === catId).length;
						assert.ok(
							count >= 2 && count <= 4,
							`La categoría ${catId} debe tener entre 2 y 4 subcategorías, pero tiene ${count}`
						);
					}
					assert.equal(demoSubcategories.length, 18);
				}
			);

			await t.test('Todos los identificadores id son únicos y no vacíos', () => {
				const ids = new Set();
				for (const sub of demoSubcategories) {
					assert.ok(typeof sub.id === 'string' && sub.id.trim().length > 0);
					assert.ok(!ids.has(sub.id), `ID duplicado detectado: ${sub.id}`);
					ids.add(sub.id);
				}
				assert.equal(ids.size, demoSubcategories.length);
			});

			await t.test('Cumple estrictamente con el type guard isSubcategoryList', () => {
				assert.equal(isSubcategoryList(demoSubcategories), true);
			});

			await t.test('Todas las subcategorías demo están activas y con minPriority en null', () => {
				for (const sub of demoSubcategories) {
					assert.equal(sub.active, true);
					assert.equal(sub.minPriority, null);
					assert.ok(['low', 'medium', 'high'].includes(sub.baseCriticality));
				}
			});
		});

		// -------------------------------------------------------------------------
		// 2. Pertenencia correcta a Nodhouses
		// -------------------------------------------------------------------------
		await suite.test('2. Pertenencia correcta a Nodhouses (org-nodhouses)', async (t) => {
			await t.test('Todas las subcategorías demo pertenecen a org-nodhouses', () => {
				assert.ok(demoSubcategories.every((s) => s.organizationId === orgId));
			});

			await t.test('getOrganizationSubcategories aísla registros para Nodhouses', () => {
				const nodhouseSubs = getOrganizationSubcategories(demoSubcategories, orgId);
				assert.equal(nodhouseSubs.length, 18);

				const otherSubs = getOrganizationSubcategories(demoSubcategories, 'other-org');
				assert.equal(otherSubs.length, 0);
			});
		});

		// -------------------------------------------------------------------------
		// 3. Categorías padre existentes y activas
		// -------------------------------------------------------------------------
		await suite.test('3. Categorías padre existentes y activas', async (t) => {
			await t.test(
				'Todas las subcategorías apuntan a categorías válidas y activas de initialCategories',
				() => {
					for (const sub of demoSubcategories) {
						const parent = initialCategories.find((c) => c.id === sub.categoryId);
						assert.ok(parent, `Categoría padre inexistente para subcategoría ${sub.id}`);
						assert.equal(
							parent.active,
							true,
							`Categoría padre inactiva para subcategoría ${sub.id}`
						);
					}
				}
			);

			await t.test(
				'getAvailableSubcategories entrega todas las subcategorías demo para Nodhouses',
				() => {
					const available = getAvailableSubcategories(demoSubcategories, initialCategories, orgId);
					assert.equal(available.length, 18);
				}
			);

			await t.test('Excluye subcategorías si su categoría padre se desactiva', () => {
				const categoriesWithInactive = initialCategories.map((c) =>
					c.id === 'software' ? { ...c, active: false } : c
				);
				const available = getAvailableSubcategories(
					demoSubcategories,
					categoriesWithInactive,
					orgId
				);
				// De 18, 3 pertenecen a 'software' -> deben quedar 15
				assert.equal(available.length, 15);
				assert.ok(!available.some((s) => s.categoryId === 'software'));
			});
		});

		// -------------------------------------------------------------------------
		// 4. Catálogo ausente (missing)
		// -------------------------------------------------------------------------
		await suite.test('4. Catálogo ausente (raw === null)', async (t) => {
			await t.test(
				'initializeSubcategoriesCatalog siembra las semillas demo en almacenamiento vacío',
				() => {
					const storage = createMockStorage();
					assert.equal(storage.getItem(SUBCATEGORIES_STORAGE_KEY), null);

					const initResult = initializeSubcategoriesCatalog(storage);
					assert.equal(initResult.status, 'seeded');
					assert.equal(initResult.subcategories.length, 18);

					// Verifica que storage ahora contiene los datos
					const storedRaw = storage.getItem(SUBCATEGORIES_STORAGE_KEY);
					assert.ok(storedRaw !== null);
					const loaded = loadSubcategoriesResult(storedRaw);
					assert.equal(loaded.status, 'valid');
					assert.equal(loaded.subcategories.length, 18);
				}
			);
		});

		// -------------------------------------------------------------------------
		// 5. Catálogo válido vacío ("[]")
		// -------------------------------------------------------------------------
		await suite.test('5. Catálogo válido pero vacío ("[]")', async (t) => {
			await t.test('initializeSubcategoriesCatalog NO sobrescribe una lista vacía válida', () => {
				const storage = createMockStorage({ [SUBCATEGORIES_STORAGE_KEY]: '[]' });

				const initResult = initializeSubcategoriesCatalog(storage);
				assert.equal(initResult.status, 'already_exists');
				assert.deepEqual(initResult.subcategories, []);

				// El storage debe seguir conteniendo '[]' sin sobrescritura
				assert.equal(storage.getItem(SUBCATEGORIES_STORAGE_KEY), '[]');
			});
		});

		// -------------------------------------------------------------------------
		// 6. Catálogo válido con datos existentes
		// -------------------------------------------------------------------------
		await suite.test('6. Catálogo válido con datos existentes', async (t) => {
			await t.test('initializeSubcategoriesCatalog NO sobrescribe datos existentes', () => {
				const existing = [
					{
						id: 'custom-sub-1',
						organizationId: orgId,
						categoryId: 'equipment',
						name: 'Dispositivo personalizado',
						baseCriticality: 'high',
						minPriority: null,
						active: true
					}
				];
				const rawExisting = JSON.stringify(existing);
				const storage = createMockStorage({ [SUBCATEGORIES_STORAGE_KEY]: rawExisting });

				const initResult = initializeSubcategoriesCatalog(storage);
				assert.equal(initResult.status, 'already_exists');
				assert.equal(initResult.subcategories.length, 1);
				assert.equal(initResult.subcategories[0].id, 'custom-sub-1');

				// Storage permanece intacto
				assert.equal(storage.getItem(SUBCATEGORIES_STORAGE_KEY), rawExisting);
			});
		});

		// -------------------------------------------------------------------------
		// 7. Catálogo corrupto
		// -------------------------------------------------------------------------
		await suite.test('7. Catálogo corrupto sin sobrescritura ni auto-reparación', async (t) => {
			await t.test('JSON roto devuelve corrupt y no es sobrescrito', () => {
				const corruptRaw = '{"broken": json[';
				const storage = createMockStorage({ [SUBCATEGORIES_STORAGE_KEY]: corruptRaw });

				const initResult = initializeSubcategoriesCatalog(storage);
				assert.equal(initResult.status, 'corrupt');
				assert.ok(initResult.error.length > 0);

				// Storage NO debe ser sobrescrito
				assert.equal(storage.getItem(SUBCATEGORIES_STORAGE_KEY), corruptRaw);
			});

			await t.test('Array con esquema inválido devuelve corrupt y no es sobrescrito', () => {
				const corruptRaw = JSON.stringify([{ invalid: 'object' }]);
				const storage = createMockStorage({ [SUBCATEGORIES_STORAGE_KEY]: corruptRaw });

				const initResult = initializeSubcategoriesCatalog(storage);
				assert.equal(initResult.status, 'corrupt');
				assert.ok(initResult.error.length > 0);

				// Storage NO debe ser sobrescrito
				assert.equal(storage.getItem(SUBCATEGORIES_STORAGE_KEY), corruptRaw);
			});
		});

		// -------------------------------------------------------------------------
		// 8. Inicialización repetida (idempotencia)
		// -------------------------------------------------------------------------
		await suite.test('8. Inicialización repetida (idempotencia y prevención de duplicados)', () => {
			const storage = createMockStorage();

			// Primera invocación: debe sembrar
			const first = initializeSubcategoriesCatalog(storage);
			assert.equal(first.status, 'seeded');
			assert.equal(first.subcategories.length, 18);

			// Segunda invocación: debe detectar existencia previa y no duplicar
			const second = initializeSubcategoriesCatalog(storage);
			assert.equal(second.status, 'already_exists');
			assert.equal(second.subcategories.length, 18);

			// Tercera invocación: idéntico resultado
			const third = initializeSubcategoriesCatalog(storage);
			assert.equal(third.status, 'already_exists');
			assert.equal(third.subcategories.length, 18);

			// Lectura directa desde storage
			const loaded = loadSubcategoriesResult(storage.getItem(SUBCATEGORIES_STORAGE_KEY));
			assert.equal(loaded.status, 'valid');
			assert.equal(loaded.subcategories.length, 18);
		});

		// -------------------------------------------------------------------------
		// 9. Compatibilidad con el motor de Clasificación V2
		// -------------------------------------------------------------------------
		await suite.test('9. Compatibilidad con el motor de Clasificación V2', () => {
			const standardMatrix = createStandardPriorityMatrix(orgId);

			// Evaluamos ERP (criticidad alta) con impacto I1 según la matriz estándar del motor
			const erpSub = demoSubcategories.find((s) => s.id === 'sub-soft-erp');
			assert.ok(erpSub);

			const resultI1 = classifyIncident({
				subcategory: erpSub,
				impact: 'I1',
				matrix: standardMatrix
			});
			assert.equal(resultI1.snapshot.baseCriticality, 'high');
			assert.equal(resultI1.snapshot.impactLevel, 'I1');
			assert.equal(resultI1.calculatedPriority, 'low');
			assert.equal(resultI1.effectivePriority, 'low');

			// Evaluamos ERP con impacto I4 según la matriz estándar del motor
			const resultI4 = classifyIncident({
				subcategory: erpSub,
				impact: 'I4',
				matrix: standardMatrix
			});
			assert.equal(resultI4.calculatedPriority, 'critical');
			assert.equal(resultI4.effectivePriority, 'critical');
		});

		// -------------------------------------------------------------------------
		// 10. Conservación de incidencias y SLA
		// -------------------------------------------------------------------------
		await suite.test(
			'10. Conservación de incidencias y SLA ante inicialización de subcategorías',
			() => {
				const existingIncident = {
					id: 'inc-nod-1',
					organizationId: orgId,
					title: 'Incidencia existente V1',
					description: 'Detalle de prueba',
					status: 'open',
					priority: 'urgent',
					categoryId: 'software',
					createdAt: '2026-09-16T10:00:00.000Z',
					sla: {
						policyId: 'sla-urgent-default',
						responseTimeTargetMinutes: 15,
						resolutionTimeTargetMinutes: 120,
						responseDeadline: '2026-09-16T10:15:00.000Z',
						resolutionDeadline: '2026-09-16T12:00:00.000Z',
						firstRespondedAt: null,
						resolvedAt: null
					}
				};

				const storage = createMockStorage({
					'soporteflow-incidents': JSON.stringify([existingIncident])
				});

				const beforeIncidents = storage.getItem('soporteflow-incidents');

				// Inicializamos el catálogo de subcategorías
				initializeSubcategoriesCatalog(storage);

				// Comprobamos que las incidencias y sus SLA no han cambiado en lo absoluto
				const afterIncidents = storage.getItem('soporteflow-incidents');
				assert.equal(afterIncidents, beforeIncidents);
			}
		);
	} finally {
		await server.close();
	}
});

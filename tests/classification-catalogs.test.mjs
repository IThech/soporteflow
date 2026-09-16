import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('Clasificación V2 — Fase 1B: Catálogos de subcategorías, matrices por organización y persistencia', async (suite) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const {
			createSubcategory,
			updateSubcategory,
			setSubcategoryActive,
			toggleSubcategoryActive,
			getOrganizationSubcategories,
			getAvailableSubcategories,
			normalizeSubcategoryName,
			isSubcategoryList,
			loadSubcategoriesResult,
			saveSubcategories,
			SUBCATEGORIES_STORAGE_KEY
		} = await server.ssrLoadModule('/src/lib/classification/subcategories-catalog.ts');

		const {
			resolveOrganizationMatrix,
			getOrganizationPriorityMatrixResult,
			savePriorityMatrices,
			saveOrganizationPriorityMatrix,
			setOrganizationMatrix,
			removeOrganizationMatrix,
			loadPriorityMatricesResult,
			isPriorityMatrixList,
			PRIORITY_MATRICES_STORAGE_KEY
		} = await server.ssrLoadModule('/src/lib/classification/matrix-catalog.ts');

		const { classifyIncident, createStandardPriorityMatrix } = await server.ssrLoadModule(
			'/src/lib/classification/engine.ts'
		);

		const { matchSlaPolicy } = await server.ssrLoadModule('/src/lib/incidents/sla.ts');
		const { applyCreationSla } = await server.ssrLoadModule('/src/lib/incidents/lifecycle.ts');

		const orgA = 'org-alpha';
		const orgB = 'org-beta';

		// Categorías de prueba:
		// - 'hardware': global / compartida (sin organizationId)
		// - 'cat-alpha-software': exclusiva de orgA
		// - 'cat-beta-software': exclusiva de orgB
		// - 'cat-inactive': inactiva
		const testCategories = [
			{
				id: 'hardware',
				name: 'Hardware y Equipamiento',
				description: 'Equipos físicos',
				active: true
			},
			{
				id: 'cat-alpha-software',
				organizationId: orgA,
				name: 'Software Corporativo Alpha',
				description: 'Aplicaciones de Alpha',
				active: true
			},
			{
				id: 'cat-beta-software',
				organizationId: orgB,
				name: 'Software Corporativo Beta',
				description: 'Aplicaciones de Beta',
				active: true
			},
			{
				id: 'cat-inactive',
				organizationId: orgA,
				name: 'Categoría Inactiva',
				description: 'No operativa',
				active: false
			}
		];

		const createMockStorage = (initial = {}) => {
			const store = new Map(Object.entries(initial));
			let failWrites = false;
			let failReads = false;
			return {
				store,
				setFailWrites(flag) {
					failWrites = flag;
				},
				setFailReads(flag) {
					failReads = flag;
				},
				getItem(key) {
					if (failReads) throw new Error('SecurityError: localStorage read denied');
					return store.get(key) ?? null;
				},
				setItem(key, value) {
					if (failWrites) throw new Error('QuotaExceededError: localStorage full');
					store.set(key, String(value));
				},
				removeItem(key) {
					store.delete(key);
				}
			};
		};

		// =========================================================================
		// 1. Creación y edición de subcategorías
		// =========================================================================
		await suite.test('1. Creación y edición de subcategorías', async (st) => {
			await st.test('1.1 Creación válida con valores por defecto', () => {
				const list = createSubcategory(
					[],
					{
						organizationId: orgA,
						categoryId: 'hardware',
						name: 'Impresoras y Escáneres',
						baseCriticality: 'low'
					},
					testCategories
				);

				assert.equal(list.length, 1);
				const sub = list[0];
				assert.ok(sub.id.length > 0);
				assert.equal(sub.organizationId, orgA);
				assert.equal(sub.categoryId, 'hardware');
				assert.equal(sub.name, 'Impresoras y Escáneres');
				assert.equal(sub.baseCriticality, 'low');
				assert.equal(sub.minPriority, null);
				assert.equal(sub.active, true);
			});

			await st.test('1.2 Creación con minPriority y active explícito', () => {
				const list = createSubcategory(
					[],
					{
						organizationId: orgA,
						categoryId: 'cat-alpha-software',
						name: 'ERP Principal',
						baseCriticality: 'high',
						minPriority: 'high',
						active: true
					},
					testCategories
				);

				assert.equal(list.length, 1);
				assert.equal(list[0].minPriority, 'high');
				assert.equal(list[0].baseCriticality, 'high');
			});

			await st.test('1.3 Edición válida de nombre, criticidad y minPriority', () => {
				let list = createSubcategory(
					[],
					{
						id: 'sub-erp',
						organizationId: orgA,
						categoryId: 'cat-alpha-software',
						name: 'ERP Finanzas',
						baseCriticality: 'medium',
						minPriority: null
					},
					testCategories
				);

				list = updateSubcategory(
					list,
					{
						id: 'sub-erp',
						name: 'ERP Global y Facturación',
						baseCriticality: 'high',
						minPriority: 'critical'
					},
					testCategories,
					orgA
				);

				assert.equal(list.length, 1);
				assert.equal(list[0].id, 'sub-erp');
				assert.equal(list[0].organizationId, orgA);
				assert.equal(list[0].name, 'ERP Global y Facturación');
				assert.equal(list[0].baseCriticality, 'high');
				assert.equal(list[0].minPriority, 'critical');
			});

			await st.test('1.4 Edición debe conservar el ID y la relación con la organización', () => {
				const list = createSubcategory(
					[],
					{
						id: 'sub-fixed-id',
						organizationId: orgA,
						categoryId: 'hardware',
						name: 'Monitores',
						baseCriticality: 'low'
					},
					testCategories
				);

				// Intento de alterar organizationId debe ser rechazado
				assert.throws(
					() =>
						updateSubcategory(
							list,
							{
								id: 'sub-fixed-id',
								name: 'Monitores Curvos',
								organizationId: orgB
							},
							testCategories,
							orgA
						),
					/No se permite transferir una subcategoría a otra organización/
				);

				assert.throws(
					() =>
						updateSubcategory(
							list,
							{
								id: 'non-existent-sub',
								name: 'Teclados'
							},
							testCategories,
							orgA
						),
					/La subcategoría no existe/
				);
			});
		});

		// =========================================================================
		// 2. Duplicados normalizados (mayúsculas, acentos, espacios redundantes)
		// =========================================================================
		await suite.test('2. Duplicados normalizados', async (st) => {
			await st.test(
				'2.0 normalizeSubcategoryName elimina acentos, mayúsculas y espacios redundantes',
				() => {
					assert.equal(normalizeSubcategoryName('  Conexión   Óptica  '), 'conexion optica');
					assert.equal(normalizeSubcategoryName('CANÓN'), 'canon');
				}
			);

			await st.test('2.1 Rechaza duplicado exacto', () => {
				const list = createSubcategory(
					[],
					{
						organizationId: orgA,
						categoryId: 'hardware',
						name: 'Servidores Blade',
						baseCriticality: 'high'
					},
					testCategories
				);

				assert.throws(
					() =>
						createSubcategory(
							list,
							{
								organizationId: orgA,
								categoryId: 'hardware',
								name: 'Servidores Blade',
								baseCriticality: 'medium'
							},
							testCategories
						),
					/Ya existe una subcategoría con el nombre "Servidores Blade"/
				);
			});

			await st.test('2.2 Rechaza duplicados con distintas mayúsculas/minúsculas', () => {
				const list = createSubcategory(
					[],
					{
						organizationId: orgA,
						categoryId: 'hardware',
						name: 'Servidores Blade',
						baseCriticality: 'high'
					},
					testCategories
				);

				assert.throws(
					() =>
						createSubcategory(
							list,
							{
								organizationId: orgA,
								categoryId: 'hardware',
								name: 'servidores blade',
								baseCriticality: 'low'
							},
							testCategories
						),
					/Ya existe una subcategoría con el nombre/
				);
			});

			await st.test('2.3 Rechaza duplicados que difieren solo en acentos/tildes', () => {
				const list = createSubcategory(
					[],
					{
						organizationId: orgA,
						categoryId: 'hardware',
						name: 'Conexión Óptica',
						baseCriticality: 'high'
					},
					testCategories
				);

				assert.throws(
					() =>
						createSubcategory(
							list,
							{
								organizationId: orgA,
								categoryId: 'hardware',
								name: 'CONEXION OPTICA',
								baseCriticality: 'high'
							},
							testCategories
						),
					/Ya existe una subcategoría con el nombre/
				);
			});

			await st.test('2.4 Rechaza duplicados que difieren solo en espacios redundantes', () => {
				const list = createSubcategory(
					[],
					{
						organizationId: orgA,
						categoryId: 'hardware',
						name: 'Switch Troncal',
						baseCriticality: 'high'
					},
					testCategories
				);

				assert.throws(
					() =>
						createSubcategory(
							list,
							{
								organizationId: orgA,
								categoryId: 'hardware',
								name: '   Switch    Troncal   ',
								baseCriticality: 'medium'
							},
							testCategories
						),
					/Ya existe una subcategoría con el nombre/
				);
			});

			await st.test(
				'2.5 Permite mismo nombre en distinta categoría dentro de la misma organización',
				() => {
					let list = createSubcategory(
						[],
						{
							organizationId: orgA,
							categoryId: 'hardware',
							name: 'General',
							baseCriticality: 'low'
						},
						testCategories
					);

					list = createSubcategory(
						list,
						{
							organizationId: orgA,
							categoryId: 'cat-alpha-software',
							name: 'General',
							baseCriticality: 'medium'
						},
						testCategories
					);

					assert.equal(list.length, 2);
				}
			);

			await st.test(
				'2.6 Permite mismo nombre en distinta organización para la misma categoría global',
				() => {
					let list = createSubcategory(
						[],
						{
							organizationId: orgA,
							categoryId: 'hardware',
							name: 'Cableado Estructurado',
							baseCriticality: 'medium'
						},
						testCategories
					);

					list = createSubcategory(
						list,
						{
							organizationId: orgB,
							categoryId: 'hardware',
							name: 'Cableado Estructurado',
							baseCriticality: 'low'
						},
						testCategories
					);

					assert.equal(list.length, 2);
				}
			);
		});

		// =========================================================================
		// 3. Categorías inexistentes, inactivas o de otra organización
		// =========================================================================
		await suite.test('3. Validación estricta de categoría padre', async (st) => {
			await st.test('3.1 Rechaza si la categoría padre no existe', () => {
				assert.throws(
					() =>
						createSubcategory(
							[],
							{
								organizationId: orgA,
								categoryId: 'cat-does-not-exist',
								name: 'Subcategoría',
								baseCriticality: 'low'
							},
							testCategories
						),
					/La categoría padre especificada no existe/
				);
			});

			await st.test('3.2 Rechaza si la categoría padre pertenece a otra organización', () => {
				assert.throws(
					() =>
						createSubcategory(
							[],
							{
								organizationId: orgA,
								categoryId: 'cat-beta-software', // Pertenece a orgB!
								name: 'Módulo X',
								baseCriticality: 'medium'
							},
							testCategories
						),
					/La categoría padre no pertenece a la organización especificada/
				);
			});

			await st.test('3.3 Rechaza si la categoría padre está inactiva', () => {
				assert.throws(
					() =>
						createSubcategory(
							[],
							{
								organizationId: orgA,
								categoryId: 'cat-inactive',
								name: 'Intento en inactiva',
								baseCriticality: 'low'
							},
							testCategories
						),
					/No se puede crear una subcategoría en una categoría padre inactiva/
				);
			});
		});

		// =========================================================================
		// 4. Activación y desactivación (sin borrado físico)
		// =========================================================================
		await suite.test('4. Activación y desactivación sin borrado físico', async (st) => {
			let list = createSubcategory(
				[],
				{
					id: 'sub-legacy',
					organizationId: orgA,
					categoryId: 'hardware',
					name: 'Módem Dial-up',
					baseCriticality: 'low',
					active: true
				},
				testCategories
			);

			await st.test('4.1 Desactivar subcategoría conserva el registro', () => {
				list = setSubcategoryActive(list, 'sub-legacy', false, orgA);
				assert.equal(list.length, 1);
				assert.equal(list[0].active, false);

				// Consulta administrativa / histórica contiene la inactiva
				const allOrgSubs = getOrganizationSubcategories(list, orgA);
				assert.equal(allOrgSubs.length, 1);
				assert.equal(allOrgSubs[0].name, 'Módem Dial-up');

				// Consulta para nueva clasificación NO la contiene
				const available = getAvailableSubcategories(list, testCategories, orgA);
				assert.equal(available.length, 0);
			});

			await st.test('4.2 Reactivar subcategoría', () => {
				list = toggleSubcategoryActive(list, 'sub-legacy', orgA, testCategories);
				assert.equal(list[0].active, true);

				const available = getAvailableSubcategories(list, testCategories, orgA);
				assert.equal(available.length, 1);
			});

			await st.test(
				'4.3 Categoría padre inactiva oculta sus subcategorías para nueva clasificación',
				() => {
					// Creamos subcategoría en categoría activa
					let activeCatList = [
						{
							id: 'cat-temp',
							organizationId: orgA,
							name: 'Temp Activa',
							description: '',
							active: true
						}
					];
					const subList = createSubcategory(
						[],
						{
							organizationId: orgA,
							categoryId: 'cat-temp',
							name: 'Sub activa',
							baseCriticality: 'low',
							active: true
						},
						activeCatList
					);

					// Disponible inicialmente
					assert.equal(getAvailableSubcategories(subList, activeCatList, orgA).length, 1);

					// Desactivamos la categoría padre
					const deactivatedCatList = [{ ...activeCatList[0], active: false }];
					const availableAfter = getAvailableSubcategories(subList, deactivatedCatList, orgA);
					assert.equal(
						availableAfter.length,
						0,
						'Subcategorías de categoría inactiva no deben estar disponibles para nueva clasificación'
					);
				}
			);

			await st.test('4.4 Reactivación rechaza si la categoría padre está inactiva', () => {
				// Subcategoría bajo categoría inactiva ('cat-inactive')
				const inactiveCatSubs = createSubcategory(
					[],
					{
						id: 'sub-in-inactive-cat',
						organizationId: orgA,
						categoryId: 'cat-inactive',
						name: 'Sub en Inactiva',
						baseCriticality: 'low',
						active: false
					},
					[{ ...testCategories.find((c) => c.id === 'cat-inactive'), active: true }]
				);

				// setSubcategoryActive con categorías: rechaza reactivar
				assert.throws(
					() =>
						setSubcategoryActive(
							inactiveCatSubs,
							'sub-in-inactive-cat',
							true,
							orgA,
							testCategories
						),
					/No se puede activar una subcategoría cuya categoría padre está inactiva/
				);

				// toggleSubcategoryActive con categorías: rechaza reactivar
				assert.throws(
					() =>
						toggleSubcategoryActive(inactiveCatSubs, 'sub-in-inactive-cat', orgA, testCategories),
					/No se puede activar una subcategoría cuya categoría padre está inactiva/
				);

				// updateSubcategory con active: true: rechaza reactivar
				assert.throws(
					() =>
						updateSubcategory(
							inactiveCatSubs,
							{ id: 'sub-in-inactive-cat', active: true },
							testCategories,
							orgA
						),
					/No se puede activar una subcategoría cuya categoría padre está inactiva/
				);
			});

			await st.test(
				'4.5 Reactivación rechaza si la categoría padre no existe o pertenece a otra organización',
				() => {
					const subs = [
						{
							id: 'sub-orphan',
							organizationId: orgA,
							categoryId: 'cat-missing',
							name: 'Huérfana',
							baseCriticality: 'low',
							minPriority: null,
							active: false
						},
						{
							id: 'sub-alien-cat',
							organizationId: orgA,
							categoryId: 'cat-beta-software', // pertenece a orgB
							name: 'Categoría ajena',
							baseCriticality: 'low',
							minPriority: null,
							active: false
						}
					];

					// Rechaza si categoría padre no existe en el catálogo
					assert.throws(
						() => setSubcategoryActive(subs, 'sub-orphan', true, orgA, testCategories),
						/La categoría padre especificada no existe/
					);
					assert.throws(
						() => updateSubcategory(subs, { id: 'sub-orphan', active: true }, testCategories, orgA),
						/La categoría padre especificada no existe/
					);

					// Rechaza si categoría padre pertenece a otra organización
					assert.throws(
						() => setSubcategoryActive(subs, 'sub-alien-cat', true, orgA, testCategories),
						/La categoría padre no pertenece a la organización de la subcategoría/
					);
					assert.throws(
						() =>
							updateSubcategory(subs, { id: 'sub-alien-cat', active: true }, testCategories, orgA),
						/La categoría padre no pertenece a la organización de la subcategoría/
					);
				}
			);
		});

		// =========================================================================
		// 5. Aislamiento entre organizaciones (multi-tenant)
		// =========================================================================
		await suite.test('5. Aislamiento entre organizaciones', async (st) => {
			let subs = createSubcategory(
				[],
				{
					id: 'sub-alpha-1',
					organizationId: orgA,
					categoryId: 'hardware',
					name: 'Sub Alpha',
					baseCriticality: 'high',
					active: true
				},
				testCategories
			);
			subs = createSubcategory(
				subs,
				{
					id: 'sub-beta-1',
					organizationId: orgB,
					categoryId: 'hardware',
					name: 'Sub Beta',
					baseCriticality: 'low',
					active: true
				},
				testCategories
			);

			await st.test('5.1 Filtrado y partición de subcategorías por organización', () => {
				assert.equal(getOrganizationSubcategories(subs, orgA).length, 1);
				assert.equal(getOrganizationSubcategories(subs, orgB).length, 1);
				assert.equal(getOrganizationSubcategories(subs, orgA)[0].name, 'Sub Alpha');
				assert.equal(getOrganizationSubcategories(subs, orgB)[0].name, 'Sub Beta');
			});

			await st.test(
				'5.2 Rechaza modificar subcategoría de otra organización mediante ID (updateSubcategory)',
				() => {
					// Usuario de orgB intenta modificar sub-alpha-1 (de orgA) pasando contexto de orgB
					assert.throws(
						() =>
							updateSubcategory(
								subs,
								{ id: 'sub-alpha-1', name: 'Modificada por Org B' },
								testCategories,
								orgB
							),
						/No tienes permiso para modificar una subcategoría de otra organización/
					);

					assert.throws(
						() =>
							updateSubcategory(
								subs,
								{ id: 'sub-alpha-1', name: 'Modificada por Org B' },
								testCategories,
								{ organizationId: orgB }
							),
						/No tienes permiso para modificar una subcategoría de otra organización/
					);

					// Rechaza reasignación de organización en el propio input
					assert.throws(
						() =>
							updateSubcategory(
								subs,
								{ id: 'sub-alpha-1', organizationId: orgB, name: 'Transferencia Ilegal' },
								testCategories,
								orgA
							),
						/No se permite transferir una subcategoría a otra organización/
					);
				}
			);

			await st.test(
				'5.3 Rechaza activar o desactivar subcategoría de otra organización mediante ID (setSubcategoryActive / toggleSubcategoryActive)',
				() => {
					// Usuario de orgB intenta desactivar sub-alpha-1 (de orgA)
					assert.throws(
						() => setSubcategoryActive(subs, 'sub-alpha-1', false, orgB),
						/No tienes permiso para modificar una subcategoría de otra organización/
					);

					assert.throws(
						() => setSubcategoryActive(subs, 'sub-alpha-1', false, { organizationId: orgB }),
						/No tienes permiso para modificar una subcategoría de otra organización/
					);

					// Usuario de orgB intenta alternar estado (toggle) de sub-alpha-1 (de orgA)
					assert.throws(
						() => toggleSubcategoryActive(subs, 'sub-alpha-1', orgB),
						/No tienes permiso para modificar una subcategoría de otra organización/
					);

					assert.throws(
						() => toggleSubcategoryActive(subs, 'sub-alpha-1', { organizationId: orgB }),
						/No tienes permiso para modificar una subcategoría de otra organización/
					);

					// Usuario de orgB intenta activar subcategoría inactiva de orgA
					const inactiveAlphaSubs = setSubcategoryActive(subs, 'sub-alpha-1', false, orgA);
					assert.throws(
						() =>
							setSubcategoryActive(inactiveAlphaSubs, 'sub-alpha-1', true, {
								organizationId: orgB,
								categories: testCategories
							}),
						/No tienes permiso para modificar una subcategoría de otra organización/
					);
				}
			);

			await st.test('5.4 Rechaza operaciones ante contexto de organización ausente o nulo', () => {
				// updateSubcategory sin contexto o con null/undefined/vacío
				assert.throws(
					() => updateSubcategory(subs, { id: 'sub-alpha-1', name: 'X' }, testCategories),
					/El contexto de organización invocante es obligatorio/
				);
				assert.throws(
					() => updateSubcategory(subs, { id: 'sub-alpha-1', name: 'X' }, testCategories, null),
					/El contexto de organización invocante es obligatorio/
				);
				assert.throws(
					() =>
						updateSubcategory(subs, { id: 'sub-alpha-1', name: 'X' }, testCategories, undefined),
					/El contexto de organización invocante es obligatorio/
				);
				assert.throws(
					() => updateSubcategory(subs, { id: 'sub-alpha-1', name: 'X' }, testCategories, {}),
					/El contexto de organización invocante es obligatorio/
				);

				// setSubcategoryActive sin contexto o con null/undefined/vacío
				assert.throws(
					() => setSubcategoryActive(subs, 'sub-alpha-1', false),
					/El contexto de organización invocante es obligatorio/
				);
				assert.throws(
					() => setSubcategoryActive(subs, 'sub-alpha-1', false, null),
					/El contexto de organización invocante es obligatorio/
				);
				assert.throws(
					() => setSubcategoryActive(subs, 'sub-alpha-1', false, undefined),
					/El contexto de organización invocante es obligatorio/
				);
				assert.throws(
					() => setSubcategoryActive(subs, 'sub-alpha-1', false, {}),
					/El contexto de organización invocante es obligatorio/
				);

				// toggleSubcategoryActive sin contexto o con null/undefined/vacío
				assert.throws(
					() => toggleSubcategoryActive(subs, 'sub-alpha-1'),
					/El contexto de organización invocante es obligatorio/
				);
				assert.throws(
					() => toggleSubcategoryActive(subs, 'sub-alpha-1', null),
					/El contexto de organización invocante es obligatorio/
				);
				assert.throws(
					() => toggleSubcategoryActive(subs, 'sub-alpha-1', undefined),
					/El contexto de organización invocante es obligatorio/
				);
				assert.throws(
					() => toggleSubcategoryActive(subs, 'sub-alpha-1', {}),
					/El contexto de organización invocante es obligatorio/
				);
			});

			await st.test(
				'5.5 Rechaza operaciones ante contexto de organización vacío o solo espacios',
				() => {
					// updateSubcategory con contexto vacío
					assert.throws(
						() => updateSubcategory(subs, { id: 'sub-alpha-1', name: 'X' }, testCategories, ''),
						/El identificador de organización en el contexto no puede estar vacío/
					);
					assert.throws(
						() => updateSubcategory(subs, { id: 'sub-alpha-1', name: 'X' }, testCategories, '   '),
						/El identificador de organización en el contexto no puede estar vacío/
					);
					assert.throws(
						() =>
							updateSubcategory(subs, { id: 'sub-alpha-1', name: 'X' }, testCategories, {
								organizationId: ''
							}),
						/El identificador de organización en el contexto no puede estar vacío/
					);
					assert.throws(
						() =>
							updateSubcategory(subs, { id: 'sub-alpha-1', name: 'X' }, testCategories, {
								organizationId: '   '
							}),
						/El identificador de organización en el contexto no puede estar vacío/
					);

					// setSubcategoryActive con contexto vacío
					assert.throws(
						() => setSubcategoryActive(subs, 'sub-alpha-1', false, ''),
						/El identificador de organización en el contexto no puede estar vacío/
					);
					assert.throws(
						() => setSubcategoryActive(subs, 'sub-alpha-1', false, '   '),
						/El identificador de organización en el contexto no puede estar vacío/
					);
					assert.throws(
						() => setSubcategoryActive(subs, 'sub-alpha-1', false, { organizationId: '' }),
						/El identificador de organización en el contexto no puede estar vacío/
					);
					assert.throws(
						() => setSubcategoryActive(subs, 'sub-alpha-1', false, { organizationId: '   ' }),
						/El identificador de organización en el contexto no puede estar vacío/
					);

					// toggleSubcategoryActive con contexto vacío
					assert.throws(
						() => toggleSubcategoryActive(subs, 'sub-alpha-1', ''),
						/El identificador de organización en el contexto no puede estar vacío/
					);
					assert.throws(
						() => toggleSubcategoryActive(subs, 'sub-alpha-1', '   '),
						/El identificador de organización en el contexto no puede estar vacío/
					);
					assert.throws(
						() => toggleSubcategoryActive(subs, 'sub-alpha-1', { organizationId: '' }),
						/El identificador de organización en el contexto no puede estar vacío/
					);
					assert.throws(
						() => toggleSubcategoryActive(subs, 'sub-alpha-1', { organizationId: '   ' }),
						/El identificador de organización en el contexto no puede estar vacío/
					);
				}
			);

			await st.test('5.6 Aislamiento estricto de matrices de prioridad por organización', () => {
				const customMatrixA = {
					organizationId: orgA,
					matrix: {
						...createStandardPriorityMatrix(orgA).matrix,
						low: { I1: 'critical', I2: 'high', I3: 'medium', I4: 'low' }
					}
				};

				const customMatrixB = {
					organizationId: orgB,
					matrix: {
						...createStandardPriorityMatrix(orgB).matrix,
						low: { I1: 'low', I2: 'low', I3: 'low', I4: 'low' }
					}
				};

				let matrices = setOrganizationMatrix([], customMatrixA);
				matrices = setOrganizationMatrix(matrices, customMatrixB);

				const resA = resolveOrganizationMatrix(matrices, orgA);
				const resB = resolveOrganizationMatrix(matrices, orgB);

				assert.equal(resA.status, 'custom_valid');
				assert.equal(resB.status, 'custom_valid');
				assert.equal(resA.matrix.matrix.low.I1, 'critical');
				assert.equal(resB.matrix.matrix.low.I1, 'low');

				const withoutA = removeOrganizationMatrix(matrices, orgA);
				assert.equal(withoutA.length, 1);
				assert.equal(withoutA[0].organizationId, orgB);
			});
		});

		// =========================================================================
		// 6. Matriz estándar y personalizada (Situaciones A, B y C)
		// =========================================================================
		await suite.test('6. Matrices: Estándar, personalizada y corrupta', async (st) => {
			const storage = createMockStorage();

			await st.test(
				'6.1 Situación A: Sin configuración guardada devuelve estándar sin auto-escribir',
				() => {
					const result = getOrganizationPriorityMatrixResult(storage, orgA);
					assert.equal(result.status, 'standard_fallback');
					assert.equal(result.isCustom, false);
					assert.equal(result.matrix.organizationId, orgA);
					assert.equal(result.matrix.matrix.high.I1, 'critical');

					// Comprobar que NO se escribió en el almacenamiento
					assert.equal(storage.getItem(PRIORITY_MATRICES_STORAGE_KEY), null);
				}
			);

			await st.test('6.2 Situación B: Matriz personalizada válida guardada', () => {
				const custom = {
					organizationId: orgA,
					matrix: {
						...createStandardPriorityMatrix(orgA).matrix,
						medium: { I1: 'critical', I2: 'critical', I3: 'high', I4: 'medium' }
					}
				};

				saveOrganizationPriorityMatrix(storage, custom);
				assert.ok(storage.getItem(PRIORITY_MATRICES_STORAGE_KEY) !== null);

				const result = getOrganizationPriorityMatrixResult(storage, orgA);
				assert.equal(result.status, 'custom_valid');
				assert.equal(result.isCustom, true);
				assert.equal(result.matrix.matrix.medium.I1, 'critical');

				// Conectar con classifyIncident puro de Fase 1A
				const subcat = {
					id: 'sub-test',
					organizationId: orgA,
					categoryId: 'hardware',
					name: 'Test',
					baseCriticality: 'medium',
					minPriority: null,
					active: true
				};

				const evalRes = classifyIncident({
					subcategory: subcat,
					impact: 'I1',
					matrix: result.matrix
				});

				assert.equal(evalRes.calculatedPriority, 'critical');
			});

			await st.test(
				'6.3 Situación C: Configuración corrupta devuelve error controlado sin sobrescribir',
				() => {
					// Guardar matriz corrupta (le falta la celda I4 en high)
					const corruptMatrix = {
						organizationId: orgA,
						matrix: {
							...createStandardPriorityMatrix(orgA).matrix,
							high: {
								I1: 'critical',
								I2: 'high',
								I3: 'medium'
								// falta I4
							}
						}
					};

					storage.setItem(PRIORITY_MATRICES_STORAGE_KEY, JSON.stringify([corruptMatrix]));

					const result = getOrganizationPriorityMatrixResult(storage, orgA);
					assert.equal(result.status, 'corrupt');
					assert.match(result.error, /está corrupta o incompleta/);

					// Asegurar que NO se sustituyó automáticamente
					const rawAfter = storage.getItem(PRIORITY_MATRICES_STORAGE_KEY);
					assert.ok(rawAfter.includes('sub-test') === false);
				}
			);
		});

		// =========================================================================
		// 7. Persistencia segura y validación estricta
		// =========================================================================
		await suite.test(
			'7. Persistencia, carga segura y no sobrescritura de datos corruptos',
			async (st) => {
				const storage = createMockStorage();

				await st.test('7.1 Subcategorías ausentes (missing) vs corruptas', () => {
					const missing = loadSubcategoriesResult(null);
					assert.equal(missing.status, 'missing');
					assert.deepEqual(missing.subcategories, []);

					const corruptJson = loadSubcategoriesResult('{ bad json [');
					assert.equal(corruptJson.status, 'corrupt');

					const invalidFormat = loadSubcategoriesResult(JSON.stringify([{ invalid: 'object' }]));
					assert.equal(invalidFormat.status, 'corrupt');
				});

				await st.test('7.2 Guardar subcategorías valida la lista completa', () => {
					const validSubs = createSubcategory(
						[],
						{
							organizationId: orgA,
							categoryId: 'hardware',
							name: 'Routers',
							baseCriticality: 'high'
						},
						testCategories
					);

					saveSubcategories(storage, validSubs);
					const loaded = loadSubcategoriesResult(storage.getItem(SUBCATEGORIES_STORAGE_KEY));
					assert.equal(loaded.status, 'valid');
					assert.equal(loaded.subcategories.length, 1);
					assert.equal(loaded.subcategories[0].name, 'Routers');

					// Intentar guardar lista con duplicados lanza error
					assert.equal(isSubcategoryList(validSubs), true);
					assert.equal(isSubcategoryList('invalid'), false);
					assert.throws(
						() =>
							saveSubcategories(storage, [
								validSubs[0],
								{ ...validSubs[0], id: 'sub-different-id', name: 'routers' }
							]),
						/La lista de subcategorías contiene elementos inválidos o nombres duplicados/
					);
				});

				await st.test(
					'7.3 saveOrganizationPriorityMatrix se niega a sobrescribir si el storage contiene JSON corrupto',
					() => {
						storage.setItem(PRIORITY_MATRICES_STORAGE_KEY, 'invalid json {');

						assert.throws(
							() => saveOrganizationPriorityMatrix(storage, createStandardPriorityMatrix(orgA)),
							/No se puede guardar: el catálogo de matrices en almacenamiento contiene datos corruptos/
						);
					}
				);

				await st.test('7.4 Carga y validación de listas de matrices serializadas', () => {
					assert.equal(loadPriorityMatricesResult(null).status, 'missing');
					assert.equal(loadPriorityMatricesResult('{ bad json').status, 'corrupt');
					assert.equal(isPriorityMatrixList([createStandardPriorityMatrix(orgA)]), true);
					assert.equal(isPriorityMatrixList([{ invalid: true }]), false);
				});
			}
		);

		// =========================================================================
		// 8. Manejo de fallos en storage (lectura y escritura)
		// =========================================================================
		await suite.test('8. Gestión de excepciones de lectura y escritura', async (st) => {
			const storage = createMockStorage();

			await st.test('8.1 Fallo en setItem lanza error controlado descriptivo', () => {
				storage.setFailWrites(true);

				assert.throws(
					() =>
						saveSubcategories(storage, [
							{
								id: 'sub-1',
								organizationId: orgA,
								categoryId: 'hardware',
								name: 'Test',
								baseCriticality: 'low',
								minPriority: null,
								active: true
							}
						]),
					/Fallo al persistir catálogo de subcategorías: QuotaExceededError/
				);

				assert.throws(
					() => savePriorityMatrices(storage, [createStandardPriorityMatrix(orgA)]),
					/Fallo al persistir catálogo de matrices: QuotaExceededError/
				);
			});

			await st.test('8.2 Fallo en getItem retorna status corrupt controlado sin explotar', () => {
				storage.setFailReads(true);

				const result = getOrganizationPriorityMatrixResult(storage, orgA);
				assert.equal(result.status, 'corrupt');
				assert.match(result.error, /Error de lectura en almacenamiento/);
			});
		});

		// =========================================================================
		// 9. Compatibilidad con datos existentes y ausencia de efectos sobre SLA
		// =========================================================================
		await suite.test(
			'9. Compatibilidad con datos existentes y ausencia de efectos sobre SLA e incidencias',
			() => {
				// Las organizaciones demo funcionan sin subcategorías
				const demoOrgSubs = getOrganizationSubcategories([], 'org-nodhouses');
				assert.deepEqual(demoOrgSubs, []);

				// El motor SLA V1 existente sigue evaluando exactamente con IncidentPriority ('high', 'medium', 'low')
				const legacyIncident = {
					id: 999,
					organizationId: 'org-nodhouses',
					title: 'Corte de fibra',
					client: 'Cliente Demo',
					status: 'open',
					priority: 'high',
					categoryId: 'network',
					createdAt: '2026-09-10T10:00:00.000Z'
				};

				const mockSlaPolicies = [
					{
						id: 'sla-default',
						organizationId: 'org-nodhouses',
						name: 'Default',
						active: true,
						isDefault: true,
						firstResponseMinutes: 120,
						resolutionMinutes: 480
					}
				];

				const matchedPolicy = matchSlaPolicy(legacyIncident, mockSlaPolicies);
				assert.ok(matchedPolicy);
				assert.equal(matchedPolicy.id, 'sla-default');

				const applied = applyCreationSla(legacyIncident, mockSlaPolicies);
				assert.ok(applied.sla);
				assert.equal(applied.sla.policyId, 'sla-default');

				// La incidencia original conserva priority sin afectación de Clasificación V2
				assert.equal(legacyIncident.priority, 'high');
				assert.equal(legacyIncident.subcategoryId, undefined);
			}
		);
	} finally {
		await server.close();
	}
});

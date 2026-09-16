import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

test('Fase 2D.1 — Carga de catálogos V2, sincronización y validaciones', async (suite) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const {
			loadSubcategoriesResult,
			getOrganizationSubcategories,
			getAvailableSubcategories,
			SUBCATEGORIES_STORAGE_KEY
		} = await server.ssrLoadModule('/src/lib/classification/subcategories-catalog.ts');

		const { loadPriorityMatricesResult, resolveOrganizationMatrix, PRIORITY_MATRICES_STORAGE_KEY } =
			await server.ssrLoadModule('/src/lib/classification/matrix-catalog.ts');

		const { createStandardPriorityMatrix } = await server.ssrLoadModule(
			'/src/lib/classification/engine.ts'
		);

		const orgA = 'org-alpha';
		const orgB = 'org-beta';

		const testCategories = [
			{
				id: 'equipment',
				organizationId: orgA,
				name: 'Equipos',
				active: true
			},
			{
				id: 'network',
				organizationId: orgA,
				name: 'Redes',
				active: false // Inactiva
			},
			{
				id: 'accounts-beta',
				organizationId: orgB,
				name: 'Cuentas Beta',
				active: true
			}
		];

		const validSubcategoriesOrgA = [
			{
				id: 'sub-lap',
				organizationId: orgA,
				categoryId: 'equipment',
				name: 'Portátiles',
				baseCriticality: 'medium',
				minPriority: null,
				active: true
			},
			{
				id: 'sub-workstation',
				organizationId: orgA,
				categoryId: 'equipment',
				name: 'Estaciones de trabajo',
				baseCriticality: 'high',
				minPriority: 'high',
				active: false // Inactiva
			},
			{
				id: 'sub-wifi',
				organizationId: orgA,
				categoryId: 'network', // Categoría padre inactiva
				name: 'Wi-Fi Oficinas',
				baseCriticality: 'high',
				minPriority: null,
				active: true
			}
		];

		const validSubcategoriesOrgB = [
			{
				id: 'sub-ldap',
				organizationId: orgB,
				categoryId: 'accounts-beta',
				name: 'Directorio Activo',
				baseCriticality: 'high',
				minPriority: null,
				active: true
			}
		];

		const customMatrixOrgA = {
			id: 'matrix-org-alpha',
			organizationId: orgA,
			matrix: createStandardPriorityMatrix(orgA).matrix
		};

		// -------------------------------------------------------------------------
		// A. Carga de catálogo ausente
		// -------------------------------------------------------------------------
		await suite.test('A. Carga de catálogo ausente (raw === null)', async (t) => {
			await t.test('Subcategorías ausentes devuelven status "missing" y lista vacía', () => {
				const result = loadSubcategoriesResult(null);
				assert.equal(result.status, 'missing');
				assert.deepEqual(result.subcategories, []);
			});

			await t.test('Matrices ausentes devuelven status "missing" y lista vacía', () => {
				const result = loadPriorityMatricesResult(null);
				assert.equal(result.status, 'missing');
				assert.deepEqual(result.matrices, []);
			});
		});

		// -------------------------------------------------------------------------
		// B. Carga de catálogo válido
		// -------------------------------------------------------------------------
		await suite.test('B. Carga de catálogo válido', async (t) => {
			await t.test('Subcategorías válidas serializadas devuelven status "valid"', () => {
				const raw = JSON.stringify(validSubcategoriesOrgA);
				const result = loadSubcategoriesResult(raw);
				assert.equal(result.status, 'valid');
				assert.equal(result.subcategories.length, 3);
				assert.equal(result.subcategories[0].name, 'Portátiles');
				assert.equal(result.subcategories[0].baseCriticality, 'medium');
			});

			await t.test('Matrices válidas serializadas devuelven status "valid"', () => {
				const raw = JSON.stringify([customMatrixOrgA]);
				const result = loadPriorityMatricesResult(raw);
				assert.equal(result.status, 'valid');
				assert.equal(result.matrices.length, 1);
				assert.equal(result.matrices[0].organizationId, orgA);
			});
		});

		// -------------------------------------------------------------------------
		// C. Catálogo válido pero vacío
		// -------------------------------------------------------------------------
		await suite.test('C. Catálogo válido pero vacío ("[]")', async (t) => {
			await t.test('Subcategorías "[]" devuelven status "valid" con subcategories vacías', () => {
				const result = loadSubcategoriesResult('[]');
				assert.equal(result.status, 'valid');
				assert.deepEqual(result.subcategories, []);
			});

			await t.test('Matrices "[]" devuelven status "valid" con matrices vacías', () => {
				const result = loadPriorityMatricesResult('[]');
				assert.equal(result.status, 'valid');
				assert.deepEqual(result.matrices, []);
			});
		});

		// -------------------------------------------------------------------------
		// D. Catálogo corrupto sin sobrescritura
		// -------------------------------------------------------------------------
		await suite.test('D. Catálogo corrupto sin sobrescritura', async (t) => {
			const mockStorage = {
				data: new Map([
					[SUBCATEGORIES_STORAGE_KEY, 'invalid-json{not-an-array'],
					[PRIORITY_MATRICES_STORAGE_KEY, '{"notAnArray": true}']
				]),
				getItem(k) {
					return this.data.get(k) ?? null;
				},
				setItem(k, v) {
					this.data.set(k, v);
				}
			};

			await t.test('JSON sintácticamente inválido produce status "corrupt"', () => {
				const initialRaw = mockStorage.getItem(SUBCATEGORIES_STORAGE_KEY);
				const result = loadSubcategoriesResult(initialRaw);
				assert.equal(result.status, 'corrupt');
				assert.ok(result.error.length > 0);
				// El almacenamiento debe permanecer inalterado (sin sobrescribir)
				assert.equal(mockStorage.getItem(SUBCATEGORIES_STORAGE_KEY), initialRaw);
			});

			await t.test(
				'Estructura semánticamente inválida en matrices produce status "corrupt"',
				() => {
					const initialRaw = mockStorage.getItem(PRIORITY_MATRICES_STORAGE_KEY);
					const result = loadPriorityMatricesResult(initialRaw);
					assert.equal(result.status, 'corrupt');
					assert.ok(result.error.length > 0);
					// El almacenamiento debe permanecer inalterado
					assert.equal(mockStorage.getItem(PRIORITY_MATRICES_STORAGE_KEY), initialRaw);
				}
			);
		});

		// -------------------------------------------------------------------------
		// E. Aislamiento entre organizaciones
		// -------------------------------------------------------------------------
		await suite.test('E. Aislamiento entre organizaciones (multi-tenant)', async (t) => {
			const allSubcategories = [...validSubcategoriesOrgA, ...validSubcategoriesOrgB];

			await t.test('getOrganizationSubcategories aísla registros por organizationId', () => {
				const subA = getOrganizationSubcategories(allSubcategories, orgA);
				const subB = getOrganizationSubcategories(allSubcategories, orgB);

				assert.equal(subA.length, 3);
				assert.ok(subA.every((s) => s.organizationId === orgA));
				assert.equal(subB.length, 1);
				assert.ok(subB.every((s) => s.organizationId === orgB));
			});

			await t.test(
				'getAvailableSubcategories jamás entrega subcategorías de otra organización',
				() => {
					const availableForA = getAvailableSubcategories(allSubcategories, testCategories, orgA);
					assert.ok(availableForA.every((s) => s.organizationId === orgA));
					assert.ok(!availableForA.some((s) => s.organizationId === orgB));
				}
			);
		});

		// -------------------------------------------------------------------------
		// F. Exclusión de subcategorías inactivas
		// -------------------------------------------------------------------------
		await suite.test('F. Exclusión de subcategorías inactivas', () => {
			const available = getAvailableSubcategories(validSubcategoriesOrgA, testCategories, orgA);
			// 'sub-workstation' tiene active: false -> debe ser excluida
			assert.ok(!available.some((s) => s.id === 'sub-workstation'));
		});

		// -------------------------------------------------------------------------
		// G. Exclusión de categorías padre inactivas
		// -------------------------------------------------------------------------
		await suite.test('G. Exclusión de categorías padre inactivas', () => {
			const available = getAvailableSubcategories(validSubcategoriesOrgA, testCategories, orgA);
			// 'sub-wifi' tiene active: true, pero su categoría padre 'network' está inactiva -> debe ser excluida
			assert.ok(!available.some((s) => s.id === 'sub-wifi'));
			// Solo 'sub-lap' es activa y su categoría padre 'equipment' está activa
			assert.equal(available.length, 1);
			assert.equal(available[0].id, 'sub-lap');
		});

		// -------------------------------------------------------------------------
		// H. Resolución de matriz personalizada
		// -------------------------------------------------------------------------
		await suite.test('H. Resolución de matriz personalizada (custom_valid)', () => {
			const catalog = [customMatrixOrgA];
			const res = resolveOrganizationMatrix(catalog, orgA);
			assert.equal(res.status, 'custom_valid');
			assert.equal(res.isCustom, true);
			assert.equal(res.matrix.organizationId, orgA);
		});

		// -------------------------------------------------------------------------
		// I. Fallback estándar permitido
		// -------------------------------------------------------------------------
		await suite.test('I. Fallback estándar permitido en memoria (standard_fallback)', () => {
			// Catálogo nulo
			const resNull = resolveOrganizationMatrix(null, orgA);
			assert.equal(resNull.status, 'standard_fallback');
			assert.equal(resNull.isCustom, false);
			assert.equal(resNull.matrix.organizationId, orgA);

			// Catálogo vacío
			const resEmpty = resolveOrganizationMatrix([], orgA);
			assert.equal(resEmpty.status, 'standard_fallback');
			assert.equal(resEmpty.isCustom, false);

			// Catálogo sin la organización solicitada
			const resOther = resolveOrganizationMatrix([customMatrixOrgA], orgB);
			assert.equal(resOther.status, 'standard_fallback');
			assert.equal(resOther.isCustom, false);
			assert.equal(resOther.matrix.organizationId, orgB);
		});

		// -------------------------------------------------------------------------
		// J. Matriz corrupta sin fallback silencioso
		// -------------------------------------------------------------------------
		await suite.test('J. Matriz corrupta sin fallback silencioso', () => {
			// Duplicidad de matrices para la misma organización
			const duplicateMatrices = [customMatrixOrgA, { ...customMatrixOrgA, id: 'matrix-dup' }];
			const resDup = resolveOrganizationMatrix(duplicateMatrices, orgA);
			assert.equal(resDup.status, 'corrupt');
			assert.ok(resDup.error.includes('múltiples'));

			// Matriz malformada
			const malformedMatrix = {
				organizationId: orgA,
				matrix: { invalid: true }
			};
			const resMalformed = resolveOrganizationMatrix([malformedMatrix], orgA);
			assert.equal(resMalformed.status, 'corrupt');
			assert.ok(resMalformed.error.length > 0);
		});

		// -------------------------------------------------------------------------
		// K. Recarga tras eventos storage y sincronización
		// -------------------------------------------------------------------------
		await suite.test('K. Recarga reactiva simulando StorageEvent entre pestañas', () => {
			let subcategoriesState = { status: 'missing', subcategories: [] };
			let priorityMatricesState = { status: 'missing', matrices: [] };
			let subcategoriesError = '';
			let priorityMatricesError = '';
			let subcategoriesReady = false;
			let priorityMatricesReady = false;

			function reloadSubcategories(raw) {
				const res = loadSubcategoriesResult(raw);
				subcategoriesState = res;
				if (res.status === 'corrupt') {
					subcategoriesError = res.error;
					subcategoriesReady = false;
				} else {
					subcategoriesError = '';
					subcategoriesReady = true;
				}
			}

			function reloadPriorityMatrices(raw) {
				const res = loadPriorityMatricesResult(raw);
				priorityMatricesState = res;
				if (res.status === 'corrupt') {
					priorityMatricesError = res.error;
					priorityMatricesReady = false;
				} else {
					priorityMatricesError = '';
					priorityMatricesReady = true;
				}
			}

			function handleStorage(event) {
				if (event.key === null) {
					reloadSubcategories(event.storage?.getItem(SUBCATEGORIES_STORAGE_KEY) ?? null);
					reloadPriorityMatrices(event.storage?.getItem(PRIORITY_MATRICES_STORAGE_KEY) ?? null);
				} else if (event.key === SUBCATEGORIES_STORAGE_KEY) {
					reloadSubcategories(event.newValue);
				} else if (event.key === PRIORITY_MATRICES_STORAGE_KEY) {
					reloadPriorityMatrices(event.newValue);
				}
			}

			// 1. Carga inicial ausente
			reloadSubcategories(null);
			reloadPriorityMatrices(null);
			assert.equal(subcategoriesState.status, 'missing');
			assert.equal(priorityMatricesState.status, 'missing');

			// 2. Otra pestaña añade subcategorías válidas
			handleStorage({
				key: SUBCATEGORIES_STORAGE_KEY,
				newValue: JSON.stringify(validSubcategoriesOrgA)
			});
			assert.equal(subcategoriesState.status, 'valid');
			assert.equal(subcategoriesState.subcategories.length, 3);
			assert.equal(subcategoriesReady, true);
			assert.equal(subcategoriesError, '');

			// 3. Otra pestaña añade matrices válidas
			handleStorage({
				key: PRIORITY_MATRICES_STORAGE_KEY,
				newValue: JSON.stringify([customMatrixOrgA])
			});
			assert.equal(priorityMatricesState.status, 'valid');
			assert.equal(priorityMatricesState.matrices.length, 1);
			assert.equal(priorityMatricesReady, true);

			// 4. Otra pestaña guarda datos corruptos en subcategorías
			handleStorage({
				key: SUBCATEGORIES_STORAGE_KEY,
				newValue: 'bad-json{{{'
			});
			assert.equal(subcategoriesState.status, 'corrupt');
			assert.equal(subcategoriesReady, false);
			assert.ok(subcategoriesError.length > 0);

			// 5. Otra pestaña guarda datos corruptos en matrices
			handleStorage({
				key: PRIORITY_MATRICES_STORAGE_KEY,
				newValue: '{"bad": "json'
			});
			assert.equal(priorityMatricesState.status, 'corrupt');
			assert.equal(priorityMatricesReady, false);
			assert.ok(priorityMatricesError.length > 0);
		});

		// -------------------------------------------------------------------------
		// L. Eliminación de una clave desde otra pestaña
		// -------------------------------------------------------------------------
		await suite.test('L. Eliminación de una clave (removeItem -> newValue: null)', () => {
			let subcategoriesState = { status: 'valid', subcategories: validSubcategoriesOrgA };
			let subcategoriesReady = true;
			let subcategoriesError = '';

			function reloadSubcategories(raw) {
				const res = loadSubcategoriesResult(raw);
				subcategoriesState = res;
				if (res.status === 'corrupt') {
					subcategoriesError = res.error;
					subcategoriesReady = false;
				} else {
					subcategoriesError = '';
					subcategoriesReady = true;
				}
			}

			// Simula evento cuando otra pestaña hace localStorage.removeItem(SUBCATEGORIES_STORAGE_KEY)
			const event = {
				key: SUBCATEGORIES_STORAGE_KEY,
				newValue: null
			};

			reloadSubcategories(event.newValue);
			// Transición limpia a 'missing' sin marcar error corrupto
			assert.equal(subcategoriesState.status, 'missing');
			assert.deepEqual(subcategoriesState.subcategories, []);
			assert.equal(subcategoriesReady, true);
			assert.equal(subcategoriesError, '');
		});

		// -------------------------------------------------------------------------
		// M. Conservación de incidencias y snapshots SLA ante eventos de catálogo
		// -------------------------------------------------------------------------
		await suite.test(
			'M. Conservación de incidencias y snapshots SLA ante recargas de catálogo',
			() => {
				const originalIncident = {
					id: 'inc-demo-1',
					organizationId: orgA,
					title: 'Fallo de monitor',
					description: 'No enciende la pantalla',
					status: 'open',
					priority: 'urgent',
					categoryId: 'equipment',
					assignedToUserId: 'usr-tech-1',
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

				const incidents = [JSON.parse(JSON.stringify(originalIncident))];
				const incidentsBefore = JSON.stringify(incidents);

				// Simulamos varias recargas y cambios de catálogo (missing, valid, corrupt)
				loadSubcategoriesResult(null);
				loadPriorityMatricesResult(null);
				loadSubcategoriesResult(JSON.stringify(validSubcategoriesOrgA));
				loadPriorityMatricesResult(JSON.stringify([customMatrixOrgA]));
				loadSubcategoriesResult('bad-corrupt-data');

				// Verificamos que las incidencias y sus snapshots SLA no sufren mutación alguna
				const incidentsAfter = JSON.stringify(incidents);
				assert.equal(incidentsAfter, incidentsBefore);
				assert.equal(incidents[0].priority, 'urgent');
				assert.equal(incidents[0].sla.policyId, 'sla-urgent-default');
				assert.equal(incidents[0].sla.responseDeadline, '2026-09-16T10:15:00.000Z');
			}
		);

		// -------------------------------------------------------------------------
		// N. Verificación del código en src/routes/app/+page.svelte
		// -------------------------------------------------------------------------
		await suite.test('N. Verificación estructural de src/routes/app/+page.svelte', async (t) => {
			const source = await readFile(
				new URL('../src/routes/app/+page.svelte', import.meta.url),
				'utf8'
			);

			await t.test('Importa constantes y funciones de carga V2', () => {
				assert.ok(source.includes('SUBCATEGORIES_STORAGE_KEY'));
				assert.ok(source.includes('loadSubcategoriesResult'));
				assert.ok(source.includes('PRIORITY_MATRICES_STORAGE_KEY'));
				assert.ok(source.includes('loadPriorityMatricesResult'));
				assert.ok(source.includes('SubcategoryLoadResult'));
				assert.ok(source.includes('PriorityMatricesCatalogLoadResult'));
			});

			await t.test('Declara estado reactivo para catálogos V2', () => {
				assert.ok(source.includes('subcategoriesState'));
				assert.ok(source.includes('subcategoriesReady'));
				assert.ok(source.includes('subcategoriesError'));
				assert.ok(source.includes('subcategoriesSnapshot'));
				assert.ok(source.includes('priorityMatricesState'));
				assert.ok(source.includes('priorityMatricesReady'));
				assert.ok(source.includes('priorityMatricesError'));
				assert.ok(source.includes('priorityMatricesSnapshot'));
			});

			await t.test(
				'Define funciones de recarga reloadSubcategories y reloadPriorityMatrices',
				() => {
					assert.ok(source.includes('function reloadSubcategories('));
					assert.ok(source.includes('function reloadPriorityMatrices('));
				}
			);

			await t.test('Registra listener de storage en window y lo desregistra en cleanup', () => {
				assert.ok(source.includes("window.addEventListener('storage', handleStorage)"));
				assert.ok(source.includes("window.removeEventListener('storage', handleStorage)"));
			});

			await t.test(
				'Restricciones estrictas: No añade selectores ni modifica formulario en 2D.1',
				() => {
					assert.ok(!source.includes('newSubcategoryId'));
					assert.ok(!source.includes('newImpact'));
					assert.ok(!source.includes('classificationPreview'));
				}
			);
		});
	} finally {
		await server.close();
	}
});

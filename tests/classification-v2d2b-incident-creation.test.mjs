import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

test('Fase 2D.2B — Integración de Clasificación V2 en la creación de incidencias', async (suite) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const { validateAndBuildV2Incident } = await server.ssrLoadModule(
			'/src/lib/incidents/lifecycle.ts'
		);
		const { isIncidentList, isCoherentClassificationPriority } = await server.ssrLoadModule(
			'/src/lib/incidents/validation.ts'
		);
		const { getAvailableSubcategories, loadSubcategoriesResult } = await server.ssrLoadModule(
			'/src/lib/classification/subcategories-catalog.ts'
		);
		const { loadPriorityMatricesResult, resolveOrganizationMatrix } = await server.ssrLoadModule(
			'/src/lib/classification/matrix-catalog.ts'
		);
		const { createStandardPriorityMatrix, toIncidentPriority, classifyIncident } =
			await server.ssrLoadModule('/src/lib/classification/engine.ts');

		const orgNod = 'org-nodhouses';
		const orgOther = 'org-other';

		const demoUserNod = {
			id: 'usr-admin-nod',
			name: 'Admin Nodhouses',
			email: 'admin@nodhouses.com',
			role: 'organization_admin',
			organizationId: orgNod,
			active: true
		};

		const demoClientNod = {
			id: 'usr-client-nod',
			name: 'Cliente Nodhouses',
			email: 'client@nodhouses.com',
			role: 'client',
			organizationId: orgNod,
			active: true
		};

		const testCategories = [
			{
				id: 'software',
				organizationId: orgNod,
				name: 'Software y Aplicaciones',
				active: true
			},
			{
				id: 'hardware',
				organizationId: orgNod,
				name: 'Equipos y Hardware',
				active: true
			},
			{
				id: 'inactive-cat',
				organizationId: orgNod,
				name: 'Categoría Inactiva',
				active: false
			},
			{
				id: 'other-cat',
				organizationId: orgOther,
				name: 'Categoría Otra Empresa',
				active: true
			}
		];

		const testSubcategories = [
			{
				id: 'sub-erp',
				organizationId: orgNod,
				categoryId: 'software',
				name: 'ERP / Facturación',
				baseCriticality: 'high',
				minPriority: null,
				active: true
			},
			{
				id: 'sub-office',
				organizationId: orgNod,
				categoryId: 'software',
				name: 'Ofimática',
				baseCriticality: 'low',
				minPriority: null,
				active: true
			},
			{
				id: 'sub-inactive',
				organizationId: orgNod,
				categoryId: 'software',
				name: 'Subcategoría Inactiva',
				baseCriticality: 'medium',
				minPriority: null,
				active: false
			},
			{
				id: 'sub-on-inactive-cat',
				organizationId: orgNod,
				categoryId: 'inactive-cat',
				name: 'Sub en Cat Inactiva',
				baseCriticality: 'high',
				minPriority: null,
				active: true
			},
			{
				id: 'sub-with-min',
				organizationId: orgNod,
				categoryId: 'hardware',
				name: 'Servidor Local con MinPriority',
				baseCriticality: 'low',
				minPriority: 'critical',
				active: true
			},
			{
				id: 'sub-other-org',
				organizationId: orgOther,
				categoryId: 'other-cat',
				name: 'Subcategoría Otra Empresa',
				baseCriticality: 'high',
				minPriority: null,
				active: true
			}
		];

		const testSlaPolicies = [
			{
				id: 'sla-urgent-nod',
				organizationId: orgNod,
				name: 'SLA Urgente Nodhouses',
				priority: 'urgent',
				categoryId: null,
				firstResponseMinutes: 15,
				resolutionMinutes: 120,
				active: true,
				isDefault: false,
				createdAt: '2026-09-01T00:00:00.000Z'
			},
			{
				id: 'sla-default-nod',
				organizationId: orgNod,
				name: 'SLA Default Nodhouses',
				priority: null,
				categoryId: null,
				firstResponseMinutes: 60,
				resolutionMinutes: 480,
				active: true,
				isDefault: true,
				createdAt: '2026-09-01T00:00:00.000Z'
			}
		];

		// =========================================================================
		// 1. Creación válida V2
		// =========================================================================
		await suite.test(
			'1. Creación válida V2 con subcategoría, impacto y cálculo determinista',
			() => {
				const res = validateAndBuildV2Incident({
					id: 101,
					title: 'Error crítico en ERP',
					client: '',
					description: 'El ERP no permite emitir facturas en toda la sede.',
					activeUser: demoClientNod,
					categoryId: 'software',
					subcategoryId: 'sub-erp',
					impact: 'I4', // high + I4 -> critical -> urgent
					categoryList: testCategories,
					subcategories: testSubcategories,
					priorityMatrices: [],
					slaPolicies: testSlaPolicies
				});

				assert.equal(res.ok, true);
				if (!res.ok) return;

				const inc = res.incident;
				assert.equal(inc.id, 101);
				assert.equal(inc.organizationId, orgNod);
				assert.equal(inc.client, 'Cliente Nodhouses');
				assert.equal(inc.clientUserId, 'usr-client-nod');
				assert.equal(inc.categoryId, 'software');
				assert.equal(inc.subcategoryId, 'sub-erp');
				assert.equal(inc.priority, 'urgent'); // critical -> urgent
				assert.ok(inc.classification);
				assert.equal(inc.classification.baseCriticality, 'high');
				assert.equal(inc.classification.impactLevel, 'I4');
				assert.equal(inc.classification.calculatedPriority, 'critical');
				assert.equal(inc.classification.effectivePriority, 'critical');
				assert.equal(inc.classification.minPriorityApplied, false);
				assert.equal(inc.classification.hasOverride, false);

				// SLA
				assert.ok(inc.sla);
				assert.equal(inc.sla.policyId, 'sla-urgent-nod');
				assert.equal(inc.sla.firstResponseMinutes, 15);
				assert.equal(inc.sla.resolutionMinutes, 120);

				// Strict schema validity
				assert.ok(isIncidentList([inc]));
				assert.ok(isCoherentClassificationPriority(inc.priority, inc.classification));
			}
		);

		// =========================================================================
		// 2. Subcategoría obligatoria
		// =========================================================================
		await suite.test('2. Subcategoría obligatoria (rechazo si falta o está vacía)', () => {
			const resEmpty = validateAndBuildV2Incident({
				id: 102,
				title: 'Problema',
				client: 'Cliente',
				description: 'Detalle',
				activeUser: demoUserNod,
				categoryId: 'software',
				subcategoryId: '',
				impact: 'I2',
				categoryList: testCategories,
				subcategories: testSubcategories,
				priorityMatrices: []
			});
			assert.equal(resEmpty.ok, false);
			assert.match(resEmpty.error, /subcategoría obligatoria/i);
		});

		// =========================================================================
		// 3. Impacto obligatorio
		// =========================================================================
		await suite.test('3. Impacto obligatorio (rechazo si falta o tiene valor inválido)', () => {
			const resEmpty = validateAndBuildV2Incident({
				id: 103,
				title: 'Problema',
				client: 'Cliente',
				description: 'Detalle',
				activeUser: demoUserNod,
				categoryId: 'software',
				subcategoryId: 'sub-erp',
				impact: '',
				categoryList: testCategories,
				subcategories: testSubcategories,
				priorityMatrices: []
			});
			assert.equal(resEmpty.ok, false);
			assert.match(resEmpty.error, /impacto válido/i);

			const resInvalid = validateAndBuildV2Incident({
				id: 103,
				title: 'Problema',
				client: 'Cliente',
				description: 'Detalle',
				activeUser: demoUserNod,
				categoryId: 'software',
				subcategoryId: 'sub-erp',
				impact: 'I5',
				categoryList: testCategories,
				subcategories: testSubcategories,
				priorityMatrices: []
			});
			assert.equal(resInvalid.ok, false);
			assert.match(resInvalid.error, /impacto válido/i);
		});

		// =========================================================================
		// 4. Categoría inactiva
		// =========================================================================
		await suite.test('4. Categoría inactiva bloquea la creación', () => {
			const res = validateAndBuildV2Incident({
				id: 104,
				title: 'Problema',
				client: 'Cliente',
				description: 'Detalle',
				activeUser: demoUserNod,
				categoryId: 'inactive-cat',
				subcategoryId: 'sub-on-inactive-cat',
				impact: 'I2',
				categoryList: testCategories,
				subcategories: testSubcategories,
				priorityMatrices: []
			});
			assert.equal(res.ok, false);
			assert.match(res.error, /categoría.*inactiva/i);
		});

		// =========================================================================
		// 5. Subcategoría inactiva
		// =========================================================================
		await suite.test('5. Subcategoría inactiva bloquea la creación', () => {
			const res = validateAndBuildV2Incident({
				id: 105,
				title: 'Problema',
				client: 'Cliente',
				description: 'Detalle',
				activeUser: demoUserNod,
				categoryId: 'software',
				subcategoryId: 'sub-inactive',
				impact: 'I2',
				categoryList: testCategories,
				subcategories: testSubcategories,
				priorityMatrices: []
			});
			assert.equal(res.ok, false);
			assert.match(res.error, /subcategoría.*inactiva/i);
		});

		// =========================================================================
		// 6. Categoría padre inactiva
		// =========================================================================
		await suite.test(
			'6. Categoría padre inactiva bloquea subcategorías en getAvailableSubcategories',
			() => {
				const available = getAvailableSubcategories(
					testSubcategories,
					testCategories,
					orgNod,
					'inactive-cat'
				);
				assert.equal(available.length, 0);
			}
		);

		// =========================================================================
		// 7. Subcategoría de otra organización (aislamiento multi-tenant)
		// =========================================================================
		await suite.test('7. Subcategoría de otra organización es rechazada', () => {
			const res = validateAndBuildV2Incident({
				id: 107,
				title: 'Problema',
				client: 'Cliente',
				description: 'Detalle',
				activeUser: demoUserNod,
				categoryId: 'software',
				subcategoryId: 'sub-other-org',
				impact: 'I2',
				categoryList: testCategories,
				subcategories: testSubcategories,
				priorityMatrices: []
			});
			assert.equal(res.ok, false);
			assert.match(res.error, /no pertenece a tu organización/i);
		});

		// =========================================================================
		// 8. Subcategoría que no pertenece a la categoría seleccionada
		// =========================================================================
		await suite.test(
			'8. Subcategoría no vinculada a la categoría seleccionada es rechazada',
			() => {
				const res = validateAndBuildV2Incident({
					id: 108,
					title: 'Problema',
					client: 'Cliente',
					description: 'Detalle',
					activeUser: demoUserNod,
					categoryId: 'hardware', // sub-erp pertenece a 'software'
					subcategoryId: 'sub-erp',
					impact: 'I2',
					categoryList: testCategories,
					subcategories: testSubcategories,
					priorityMatrices: []
				});
				assert.equal(res.ok, false);
				assert.match(res.error, /no pertenece a la categoría seleccionada/i);
			}
		);

		// =========================================================================
		// 9. Catálogo de subcategorías corrupto
		// =========================================================================
		await suite.test(
			'9. Catálogo de subcategorías corrupto no se sobrescribe ni se repara silenciosamente',
			() => {
				const loaded = loadSubcategoriesResult('{"invalidJson": [}');
				assert.equal(loaded.status, 'corrupt');
				assert.ok(loaded.error);
			}
		);

		// =========================================================================
		// 10. Catálogo de matrices corrupto
		// =========================================================================
		await suite.test(
			'10. Catálogo de matrices corrupto devuelve error controlado y bloquea la creación',
			() => {
				const loaded = loadPriorityMatricesResult('{"notValid": true');
				assert.equal(loaded.status, 'corrupt');

				// Matriz con datos no conformes
				const invalidMatrix = {
					organizationId: orgNod,
					matrix: { high: { I1: 'invalid-priority' } }
				};
				const res = validateAndBuildV2Incident({
					id: 110,
					title: 'Problema',
					client: 'Cliente',
					description: 'Detalle',
					activeUser: demoUserNod,
					categoryId: 'software',
					subcategoryId: 'sub-erp',
					impact: 'I2',
					categoryList: testCategories,
					subcategories: testSubcategories,
					priorityMatrices: [invalidMatrix]
				});
				assert.equal(res.ok, false);
				assert.match(res.error, /matriz de prioridad/i);
			}
		);

		// =========================================================================
		// 11. Matriz estándar (fallback en memoria)
		// =========================================================================
		await suite.test('11. Sin matriz personalizada utiliza standard_fallback en memoria', () => {
			const resolved = resolveOrganizationMatrix([], orgNod);
			assert.equal(resolved.status, 'standard_fallback');
			assert.equal(resolved.isCustom, false);
			assert.equal(resolved.matrix.matrix.high.I4, 'critical');
			assert.equal(resolved.matrix.matrix.high.I1, 'low');
		});

		// =========================================================================
		// 12. Matriz personalizada
		// =========================================================================
		await suite.test('12. Matriz personalizada válida aplica sus reglas específicas', () => {
			const customMatrix = {
				organizationId: orgNod,
				matrix: {
					...createStandardPriorityMatrix(orgNod).matrix,
					low: {
						I1: 'critical',
						I2: 'critical',
						I3: 'critical',
						I4: 'critical'
					}
				}
			};

			const res = validateAndBuildV2Incident({
				id: 112,
				title: 'Problema ofimática',
				client: 'Cliente',
				description: 'Detalle',
				activeUser: demoUserNod,
				categoryId: 'software',
				subcategoryId: 'sub-office', // baseCriticality: low
				impact: 'I1', // Bajo la estándar sería 'low', pero la personalizada indica 'critical'
				categoryList: testCategories,
				subcategories: testSubcategories,
				priorityMatrices: [customMatrix]
			});

			assert.equal(res.ok, true);
			if (!res.ok) return;
			assert.equal(res.incident.priority, 'urgent'); // critical -> urgent
			assert.equal(res.incident.classification.calculatedPriority, 'critical');
		});

		// =========================================================================
		// 13. Aplicación de minPriority
		// =========================================================================
		await suite.test(
			'13. Subcategoría con minPriority eleva la prioridad deterministamente',
			() => {
				// sub-with-min tiene baseCriticality: 'low' y minPriority: 'critical'
				// Matriz estándar para low + I1 da 'low'. Debe elevarse a 'critical' ('urgent').
				const res = validateAndBuildV2Incident({
					id: 113,
					title: 'Servidor',
					client: 'Cliente',
					description: 'Detalle',
					activeUser: demoUserNod,
					categoryId: 'hardware',
					subcategoryId: 'sub-with-min',
					impact: 'I1',
					categoryList: testCategories,
					subcategories: testSubcategories,
					priorityMatrices: []
				});

				assert.equal(res.ok, true);
				if (!res.ok) return;
				assert.equal(res.incident.priority, 'urgent');
				assert.equal(res.incident.classification.matrixPriority, 'low');
				assert.equal(res.incident.classification.minPriority, 'critical');
				assert.equal(res.incident.classification.minPriorityApplied, true);
				assert.equal(res.incident.classification.effectivePriority, 'critical');
			}
		);

		// =========================================================================
		// 14. critical -> urgent
		// =========================================================================
		await suite.test(
			'14. Prioridad calculada critical mapea estrictamente a urgent operativa',
			() => {
				assert.equal(toIncidentPriority('critical'), 'urgent');
				assert.equal(toIncidentPriority('high'), 'high');
				assert.equal(toIncidentPriority('medium'), 'medium');
				assert.equal(toIncidentPriority('low'), 'low');
			}
		);

		// =========================================================================
		// 15. SLA urgente existente
		// =========================================================================
		await suite.test(
			'15. Política SLA urgente existente es seleccionada por prioridad urgent',
			() => {
				const res = validateAndBuildV2Incident({
					id: 115,
					title: 'Error urgente ERP',
					client: 'Cliente',
					description: 'Detalle',
					activeUser: demoUserNod,
					categoryId: 'software',
					subcategoryId: 'sub-erp',
					impact: 'I4', // urgent
					categoryList: testCategories,
					subcategories: testSubcategories,
					priorityMatrices: [],
					slaPolicies: testSlaPolicies
				});

				assert.equal(res.ok, true);
				if (!res.ok) return;
				assert.ok(res.incident.sla);
				assert.equal(res.incident.sla.policyId, 'sla-urgent-nod');
				assert.equal(res.incident.sla.policyName, 'SLA Urgente Nodhouses');
			}
		);

		// =========================================================================
		// 16. Ausencia de SLA urgente sin fallback inventado
		// =========================================================================
		await suite.test(
			'16. Ausencia de política SLA aplicable respeta sla: null (sin inventar duraciones ni recurrir a high)',
			() => {
				const res = validateAndBuildV2Incident({
					id: 116,
					title: 'Error urgente sin SLA',
					client: 'Cliente',
					description: 'Detalle',
					activeUser: demoUserNod,
					categoryId: 'software',
					subcategoryId: 'sub-erp',
					impact: 'I4',
					categoryList: testCategories,
					subcategories: testSubcategories,
					priorityMatrices: [],
					slaPolicies: [] // Sin políticas
				});

				assert.equal(res.ok, true);
				if (!res.ok) return;
				assert.equal(res.incident.sla, undefined);
			}
		);

		// =========================================================================
		// 17. Cambio de categoría
		// =========================================================================
		await suite.test(
			'17. getAvailableSubcategories filtra estrictamente por la categoría seleccionada',
			() => {
				const softSubs = getAvailableSubcategories(
					testSubcategories,
					testCategories,
					orgNod,
					'software'
				);
				assert.ok(softSubs.every((s) => s.categoryId === 'software'));
				assert.ok(!softSubs.some((s) => s.id === 'sub-with-min')); // pertenece a hardware

				const hardSubs = getAvailableSubcategories(
					testSubcategories,
					testCategories,
					orgNod,
					'hardware'
				);
				assert.ok(hardSubs.every((s) => s.categoryId === 'hardware'));
				assert.ok(hardSubs.some((s) => s.id === 'sub-with-min'));
			}
		);

		// =========================================================================
		// 18. Cambio de organización
		// =========================================================================
		await suite.test('18. getAvailableSubcategories aísla estrictamente por organización', () => {
			const nodSubs = getAvailableSubcategories(testSubcategories, testCategories, orgNod);
			assert.ok(nodSubs.every((s) => s.organizationId === orgNod));
			assert.ok(!nodSubs.some((s) => s.organizationId === orgOther));

			const otherSubs = getAvailableSubcategories(testSubcategories, testCategories, orgOther);
			assert.ok(otherSubs.every((s) => s.organizationId === orgOther));
		});

		// =========================================================================
		// 19. Cambio de matriz
		// =========================================================================
		await suite.test(
			'19. Actualización de matriz recalcula la clasificación de la incidencia',
			() => {
				const stdMatrix = createStandardPriorityMatrix(orgNod);
				const resStd = classifyIncident({
					subcategory: testSubcategories[1], // sub-office, baseCriticality: 'low'
					impact: 'I4', // low + I4 -> medium
					matrix: stdMatrix
				});
				assert.equal(resStd.effectivePriority, 'medium');

				const customMatrix = {
					organizationId: orgNod,
					matrix: {
						...stdMatrix.matrix,
						low: {
							...stdMatrix.matrix.low,
							I4: 'high'
						}
					}
				};
				const resCustom = classifyIncident({
					subcategory: testSubcategories[1],
					impact: 'I4',
					matrix: customMatrix
				});
				assert.equal(resCustom.effectivePriority, 'high');
			}
		);

		// =========================================================================
		// 20. Cambio de catálogo entre pestañas
		// =========================================================================
		await suite.test(
			'20. loadSubcategoriesResult deserializa catálogos válidos entre pestañas',
			() => {
				const serialized = JSON.stringify([testSubcategories[0]]);
				const result = loadSubcategoriesResult(serialized);
				assert.equal(result.status, 'valid');
				assert.equal(result.subcategories.length, 1);
				assert.equal(result.subcategories[0].id, 'sub-erp');
			}
		);

		// =========================================================================
		// 21. Preservación de incidencias V1
		// =========================================================================
		await suite.test(
			'21. Incidencias históricas V1 sin clasificación siguen siendo válidas',
			() => {
				const v1Incident = {
					id: 1,
					organizationId: orgNod,
					title: 'Incidencia V1 histórica',
					client: 'Cliente Antiguo',
					status: 'open',
					priority: 'medium',
					createdAt: '2026-08-01T10:00:00.000Z',
					categoryId: 'software'
				};
				assert.ok(isIncidentList([v1Incident]));
				assert.equal(v1Incident.classification, undefined);
				assert.equal(v1Incident.subcategoryId, undefined);
			}
		);

		// =========================================================================
		// 22. Preservación de snapshots SLA
		// =========================================================================
		await suite.test('22. Incidencias con snapshot SLA histórico permanecen inalteradas', () => {
			const v1WithSla = {
				id: 2,
				organizationId: orgNod,
				title: 'Incidencia con SLA original',
				client: 'Cliente',
				status: 'open',
				priority: 'urgent',
				createdAt: '2026-08-01T10:00:00.000Z',
				sla: {
					policyId: 'sla-urgent-nod',
					policyName: 'SLA Urgente Nodhouses',
					firstResponseMinutes: 15,
					resolutionMinutes: 120,
					firstResponseDueAt: '2026-08-01T10:15:00.000Z',
					resolutionDueAt: '2026-08-01T12:00:00.000Z',
					firstRespondedAt: null,
					resolvedAt: null
				}
			};
			assert.ok(isIncidentList([v1WithSla]));
		});

		// =========================================================================
		// 23. Validación de la incidencia V2 persistida
		// =========================================================================
		await suite.test('23. Incidencia V2 creada supera isIncidentList estrictamente', () => {
			const res = validateAndBuildV2Incident({
				id: 123,
				title: 'Título V2',
				client: 'Cliente V2',
				description: 'Descripción V2',
				activeUser: demoUserNod,
				categoryId: 'software',
				subcategoryId: 'sub-erp',
				impact: 'I1', // high + I1 -> low
				categoryList: testCategories,
				subcategories: testSubcategories,
				priorityMatrices: [],
				slaPolicies: testSlaPolicies
			});

			assert.equal(res.ok, true);
			if (!res.ok) return;
			assert.equal(res.incident.priority, 'low');
			assert.equal(res.incident.classification.calculatedPriority, 'low');
			assert.ok(isIncidentList([res.incident]));
		});

		// =========================================================================
		// 24. Ausencia de persistencia cuando falla la validación
		// =========================================================================
		await suite.test(
			'24. Cuando falla la validación, devuelve error sin generar borrador válido',
			() => {
				const invalidRes = validateAndBuildV2Incident({
					id: 999,
					title: '', // Título vacío
					client: 'Cliente',
					description: 'Descripción',
					activeUser: demoUserNod,
					categoryId: 'software',
					subcategoryId: 'sub-erp',
					impact: 'I2',
					categoryList: testCategories,
					subcategories: testSubcategories,
					priorityMatrices: []
				});
				assert.equal(invalidRes.ok, false);
				assert.ok(invalidRes.error);
			}
		);

		// =========================================================================
		// 25. Verificación estructural del componente src/routes/app/+page.svelte
		// =========================================================================
		await suite.test(
			'25. Verificación estructural de +page.svelte para Clasificación V2',
			async () => {
				const content = await readFile('src/routes/app/+page.svelte', 'utf-8');

				// Importaciones requeridas
				assert.ok(
					content.includes('getAvailableSubcategories'),
					'Importa getAvailableSubcategories'
				);
				assert.ok(
					content.includes('resolveOrganizationMatrix'),
					'Importa resolveOrganizationMatrix'
				);
				assert.ok(content.includes('classifyIncident'), 'Importa classifyIncident');
				assert.ok(content.includes('isImpactLevel'), 'Importa isImpactLevel');
				assert.ok(content.includes('toIncidentPriority'), 'Importa toIncidentPriority');

				// Variables reactivas V2
				assert.ok(content.includes('let newSubcategoryId = $state'), 'Declara newSubcategoryId');
				assert.ok(content.includes('let newImpact = $state'), 'Declara newImpact');
				assert.ok(
					content.includes('const availableSubcategories = $derived'),
					'Deriva availableSubcategories'
				);
				assert.ok(
					content.includes('const classificationPreview = $derived'),
					'Deriva classificationPreview'
				);
				assert.ok(
					content.includes('const calculatedOperationalPriority = $derived'),
					'Deriva calculatedOperationalPriority'
				);
				assert.ok(
					content.includes('const isCreationV2Valid = $derived'),
					'Deriva isCreationV2Valid'
				);

				// Marcador de subcategoría e impacto en modal
				assert.ok(content.includes('id="new-subcategory"'), 'Contiene select de subcategoría');
				assert.ok(content.includes('id="new-impact"'), 'Contiene select de impacto');
				assert.ok(content.includes('I1 — Una persona.'), 'Contiene escala I1');
				assert.ok(content.includes('I2 — Varias personas.'), 'Contiene escala I2');
				assert.ok(content.includes('I3 — Equipo o departamento.'), 'Contiene escala I3');
				assert.ok(content.includes('I4 — Sede u organización completa.'), 'Contiene escala I4');

				// Prioridad calculada de solo lectura
				assert.ok(
					content.includes('Prioridad calculada (automática)'),
					'Muestra prioridad calculada'
				);
				assert.ok(
					!content.includes('bind:value={priority}'),
					'Ya no permite selección manual de prioridad'
				);

				// Botón de creación deshabilitado cuando no es válido
				assert.ok(
					content.includes('disabled={!isCreationV2Valid}'),
					'Botón submit deshabilitado si no es válido'
				);
			}
		);
	} finally {
		await server.close();
	}
});

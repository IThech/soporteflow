import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('SLA v1 Bloque 4: Configuración administrativa de políticas por organización', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });
	try {
		const {
			SLA_POLICIES_KEY,
			loadSlaPoliciesResult,
			saveSlaPolicies,
			validatePolicyConflicts,
			changeSlaPolicy,
			minutesToTimeInput,
			timeInputToMinutes,
			activeSlaPolicies,
			formatSlaPolicyScope,
			checkIncidentCreationSla
		} = await server.ssrLoadModule('/src/lib/incidents/sla-catalog.ts');

		const { isSlaPolicyList } = await server.ssrLoadModule('/src/lib/incidents/sla.ts');
		const { applyCreationSla } = await server.ssrLoadModule('/src/lib/incidents/lifecycle.ts');
		const { hasPermission } = await server.ssrLoadModule('/src/lib/auth/permissions.ts');
		const { demoSlaPolicies } = await server.ssrLoadModule('/src/lib/data/sla.ts');

		const orgA = 'org-nodhouses';
		const orgB = 'org-other';

		const adminUser = {
			id: 'user-admin',
			organizationId: orgA,
			name: 'Alicia Ramos',
			email: 'alicia@nodhouses.com',
			role: 'organization_admin',
			active: true
		};

		const platformAdminUser = {
			id: 'user-platform',
			organizationId: orgA,
			name: 'Admin Plataforma',
			email: 'super@soporteflow.com',
			role: 'platform_admin',
			active: true
		};

		const techUser = {
			id: 'user-tech',
			organizationId: orgA,
			name: 'Elena Gómez',
			email: 'elena@nodhouses.com',
			role: 'technician',
			active: true
		};

		const clientUser = {
			id: 'user-client',
			organizationId: orgA,
			name: 'Carlos Mendoza',
			email: 'carlos@nodhouses.com',
			role: 'client',
			active: true
		};

		const sampleCategories = [
			{ id: 'network', organizationId: orgA, name: 'Redes', description: '', active: true },
			{ id: 'equipment', organizationId: orgA, name: 'Equipos', description: '', active: true },
			{
				id: 'legacy-cat',
				organizationId: orgA,
				name: 'Sistemas Antiguos',
				description: '',
				active: false
			}
		];

		// ==========================================
		// 1. PERSISTENCIA Y ESTADOS (missing, valid, corrupt)
		// ==========================================
		await t.test('1. Persistencia y estados de carga (missing, valid, corrupt)', async (st) => {
			await st.test('missing: storage null siembra copia de demoSlaPolicies', () => {
				const result = loadSlaPoliciesResult(null);
				assert.equal(result.status, 'missing');
				assert.equal(result.seededPolicies.length, demoSlaPolicies.length);
				assert.deepEqual(result.seededPolicies, demoSlaPolicies);
				// Garantizar que es una copia y no muta el array original
				assert.notEqual(result.seededPolicies, demoSlaPolicies);
			});

			await st.test('valid: almacenamiento válido sustituye demo', () => {
				const customPolicies = [
					{
						id: 'sla-custom-1',
						organizationId: orgA,
						name: 'SLA Custom',
						active: true,
						isDefault: true,
						categoryId: null,
						priority: null,
						firstResponseMinutes: 120,
						resolutionMinutes: 480,
						createdAt: '2026-09-10T10:00:00.000Z'
					}
				];
				const raw = JSON.stringify(customPolicies);
				const result = loadSlaPoliciesResult(raw);
				assert.equal(result.status, 'valid');
				assert.deepEqual(result.policies, customPolicies);
			});

			await st.test('valid vacío: lista vacía guardada se respeta y NUNCA re-siembra demo', () => {
				const raw = JSON.stringify([]);
				const result = loadSlaPoliciesResult(raw);
				assert.equal(result.status, 'valid');
				assert.deepEqual(result.policies, []);
			});

			await st.test(
				'corrupt: JSON malformado es detectado como corrupt y no se sustituye por demo',
				() => {
					const result = loadSlaPoliciesResult('{ invalid json');
					assert.equal(result.status, 'corrupt');
					assert.ok(result.error.includes('JSON'));
				}
			);

			await st.test('corrupt: datos que no cumplen el esquema se detectan como corrupt', () => {
				const invalidData = [{ id: 'missing-fields' }];
				const result = loadSlaPoliciesResult(JSON.stringify(invalidData));
				assert.equal(result.status, 'corrupt');
				assert.ok(result.error.includes('corrupto') || result.error.includes('esquema'));
			});

			await st.test('guardado seguro y detección de conflicto concurrente entre pestañas', () => {
				const mockStorage = {
					data: { [SLA_POLICIES_KEY]: JSON.stringify(demoSlaPolicies) },
					getItem(key) {
						return this.data[key] ?? null;
					},
					setItem(key, val) {
						this.data[key] = val;
					}
				};

				const expectedSnapshot = mockStorage.getItem(SLA_POLICIES_KEY);

				// Guardado exitoso con expected coincidente
				const nextPolicies = [...demoSlaPolicies];
				const newSnapshot = saveSlaPolicies(mockStorage, nextPolicies, expectedSnapshot);
				assert.equal(typeof newSnapshot, 'string');
				assert.equal(mockStorage.getItem(SLA_POLICIES_KEY), newSnapshot);

				// Intento de guardado con snapshot desincronizado (conflicto)
				assert.throws(() => {
					saveSlaPolicies(mockStorage, nextPolicies, 'old-desynced-snapshot');
				}, /otra pestaña/);
			});
		});

		// ==========================================
		// 2. REGLAS DE NEGOCIO Y CONFLICTOS
		// ==========================================
		await t.test('2. Validación de reglas de negocio y conflictos de ámbito', async (st) => {
			const basePolicy = {
				id: 'pol-1',
				organizationId: orgA,
				name: 'Política Base',
				active: true,
				isDefault: false,
				categoryId: 'network',
				priority: 'high',
				firstResponseMinutes: 30,
				resolutionMinutes: 120,
				createdAt: '2026-09-10T10:00:00.000Z'
			};

			await st.test('default no puede tener categoría ni prioridad', () => {
				const invalidDefaultCat = {
					...basePolicy,
					isDefault: true,
					categoryId: 'network',
					priority: null
				};
				assert.ok(validatePolicyConflicts(invalidDefaultCat, []));

				const invalidDefaultPrio = {
					...basePolicy,
					isDefault: true,
					categoryId: null,
					priority: 'high'
				};
				assert.ok(validatePolicyConflicts(invalidDefaultPrio, []));
			});

			await st.test('política específica debe definir al menos categoría o prioridad', () => {
				const invalidSpecific = {
					...basePolicy,
					isDefault: false,
					categoryId: null,
					priority: null
				};
				const err = validatePolicyConflicts(invalidSpecific, []);
				assert.ok(err && err.includes('categoría o una prioridad'));
			});

			await st.test('tiempos deben ser enteros positivos', () => {
				assert.ok(validatePolicyConflicts({ ...basePolicy, firstResponseMinutes: 0 }, []));
				assert.ok(validatePolicyConflicts({ ...basePolicy, firstResponseMinutes: -10 }, []));
				assert.ok(validatePolicyConflicts({ ...basePolicy, firstResponseMinutes: 12.5 }, []));
				assert.ok(validatePolicyConflicts({ ...basePolicy, resolutionMinutes: 0 }, []));
				assert.ok(validatePolicyConflicts({ ...basePolicy, resolutionMinutes: -5 }, []));
				assert.ok(validatePolicyConflicts({ ...basePolicy, resolutionMinutes: 20.3 }, []));
			});

			await st.test(
				'primera respuesta y resolución son objetivos independientes: 480/240 es válido',
				() => {
					const policyInverted = {
						...basePolicy,
						firstResponseMinutes: 480, // 8 horas
						resolutionMinutes: 240 // 4 horas
					};
					assert.equal(validatePolicyConflicts(policyInverted, []), null);
				}
			);

			await st.test('dos defaults activas en la misma organización son rechazadas', () => {
				const default1 = {
					id: 'def-1',
					organizationId: orgA,
					name: 'Default 1',
					active: true,
					isDefault: true,
					categoryId: null,
					priority: null,
					firstResponseMinutes: 60,
					resolutionMinutes: 240,
					createdAt: '2026-09-10T10:00:00.000Z'
				};
				const default2 = {
					...default1,
					id: 'def-2',
					name: 'Default 2'
				};
				const conflict = validatePolicyConflicts(default2, [default1]);
				assert.ok(conflict && conflict.includes('predeterminada activa'));
			});

			await st.test('duplicados activos en el mismo ámbito exacto son rechazados', () => {
				// Mismo category + priority
				const pol2 = { ...basePolicy, id: 'pol-2', name: 'Pol 2' };
				const conflictCatPrio = validatePolicyConflicts(pol2, [basePolicy]);
				assert.ok(conflictCatPrio && conflictCatPrio.includes('mismo ámbito'));

				// Mismo solo category
				const catOnly1 = { ...basePolicy, id: 'cat-1', priority: null };
				const catOnly2 = { ...basePolicy, id: 'cat-2', name: 'Cat 2', priority: null };
				const conflictCat = validatePolicyConflicts(catOnly2, [catOnly1]);
				assert.ok(conflictCat && conflictCat.includes('mismo ámbito'));

				// Mismo solo priority
				const prioOnly1 = { ...basePolicy, id: 'prio-1', categoryId: null };
				const prioOnly2 = { ...basePolicy, id: 'prio-2', name: 'Prio 2', categoryId: null };
				const conflictPrio = validatePolicyConflicts(prioOnly2, [prioOnly1]);
				assert.ok(conflictPrio && conflictPrio.includes('mismo ámbito'));
			});

			await st.test('políticas inactivas equivalentes sí pueden coexistir sin conflicto', () => {
				const inactivePolicy = { ...basePolicy, id: 'pol-inactive', active: false };
				// Una nueva política activa con la misma regla no choca con la inactiva
				const newActivePolicy = {
					...basePolicy,
					id: 'pol-new-active',
					name: 'Nueva Activa',
					active: true
				};
				const conflict = validatePolicyConflicts(newActivePolicy, [inactivePolicy]);
				assert.equal(conflict, null);
			});

			await st.test('organizaciones diferentes nunca entran en conflicto entre sí', () => {
				const orgBPolicy = { ...basePolicy, id: 'pol-org-b', organizationId: orgB };
				const conflict = validatePolicyConflicts(orgBPolicy, [basePolicy]);
				assert.equal(conflict, null);
			});
		});

		// ==========================================
		// 3. CRUD Y PERMISOS
		// ==========================================
		await t.test('3. Permisos (sla:manage) y operaciones CRUD', async (st) => {
			await st.test(
				'permiso sla:manage asignado solo a organization_admin y platform_admin',
				() => {
					assert.equal(hasPermission(adminUser, 'sla:manage'), true);
					assert.equal(hasPermission(platformAdminUser, 'sla:manage'), true);
					assert.equal(hasPermission(techUser, 'sla:manage'), false);
					assert.equal(hasPermission(clientUser, 'sla:manage'), false);
				}
			);

			await st.test(
				'organization_admin crea, edita y desactiva políticas en su organización',
				() => {
					let list = [];
					// Crear
					list = changeSlaPolicy(adminUser, list, {
						type: 'save',
						name: 'Nueva Redes',
						isDefault: false,
						categoryId: 'network',
						priority: 'high',
						firstResponseMinutes: 30,
						resolutionMinutes: 180
					});
					assert.equal(list.length, 1);
					assert.equal(list[0].name, 'Nueva Redes');
					assert.equal(list[0].active, true);

					// Editar
					list = changeSlaPolicy(adminUser, list, {
						type: 'save',
						id: list[0].id,
						name: 'Redes Modificada',
						isDefault: false,
						categoryId: 'network',
						priority: 'high',
						firstResponseMinutes: 45,
						resolutionMinutes: 240
					});
					assert.equal(list[0].name, 'Redes Modificada');
					assert.equal(list[0].firstResponseMinutes, 45);

					// Desactivar (toggle)
					list = changeSlaPolicy(adminUser, list, {
						type: 'toggle',
						id: list[0].id
					});
					assert.equal(list[0].active, false);

					// Reactivar (toggle)
					list = changeSlaPolicy(adminUser, list, {
						type: 'toggle',
						id: list[0].id
					});
					assert.equal(list[0].active, true);
				}
			);

			await st.test('reactivación conflictiva es rechazada con mensaje explicativo', () => {
				let list = [
					{
						id: 'p-active',
						organizationId: orgA,
						name: 'Activa Actual',
						active: true,
						isDefault: true,
						categoryId: null,
						priority: null,
						firstResponseMinutes: 60,
						resolutionMinutes: 240,
						createdAt: '2026-09-10T10:00:00.000Z'
					},
					{
						id: 'p-inactive',
						organizationId: orgA,
						name: 'Histórica Inactiva',
						active: false,
						isDefault: true,
						categoryId: null,
						priority: null,
						firstResponseMinutes: 120,
						resolutionMinutes: 480,
						createdAt: '2026-09-01T10:00:00.000Z'
					}
				];

				assert.throws(() => {
					changeSlaPolicy(adminUser, list, { type: 'toggle', id: 'p-inactive' });
				}, /predeterminada activa/);
			});

			await st.test('technician y client son rechazados en lógica de negocio', () => {
				assert.throws(() => {
					changeSlaPolicy(techUser, [], {
						type: 'save',
						name: 'Intento Técnico',
						isDefault: true,
						firstResponseMinutes: 60,
						resolutionMinutes: 120
					});
				}, /No tienes permiso/);

				assert.throws(() => {
					changeSlaPolicy(clientUser, [], {
						type: 'save',
						name: 'Intento Cliente',
						isDefault: true,
						firstResponseMinutes: 60,
						resolutionMinutes: 120
					});
				}, /No tienes permiso/);
			});

			await st.test('organization_admin no puede gestionar políticas de otra organización', () => {
				const otherOrgPolicy = {
					id: 'foreign-pol',
					organizationId: orgB,
					name: 'Pol Org B',
					active: true,
					isDefault: true,
					categoryId: null,
					priority: null,
					firstResponseMinutes: 60,
					resolutionMinutes: 120,
					createdAt: '2026-09-10T10:00:00.000Z'
				};

				assert.throws(() => {
					changeSlaPolicy(adminUser, [otherOrgPolicy], {
						type: 'toggle',
						id: 'foreign-pol'
					});
				}, /No puedes gestionar políticas de esta organización/);
			});
		});

		// ==========================================
		// 4. INTEGRACIÓN CON CREACIÓN DE INCIDENCIAS E INMUTABILIDAD
		// ==========================================
		await t.test('4. Integración con ciclo de vida e inmutabilidad de snapshots', async (st) => {
			await st.test(
				'validador isSlaPolicyList exige al menos categoryId o priority en específicas',
				() => {
					const validSpecific = [
						{
							id: 'spec-1',
							organizationId: orgA,
							name: 'Válida',
							active: true,
							isDefault: false,
							categoryId: 'network',
							priority: null,
							firstResponseMinutes: 30,
							resolutionMinutes: 120,
							createdAt: '2026-09-10T10:00:00.000Z'
						}
					];
					assert.equal(isSlaPolicyList(validSpecific), true);

					const invalidSpecific = [
						{
							id: 'spec-2',
							organizationId: orgA,
							name: 'Inválida',
							active: true,
							isDefault: false,
							categoryId: null,
							priority: null,
							firstResponseMinutes: 30,
							resolutionMinutes: 120,
							createdAt: '2026-09-10T10:00:00.000Z'
						}
					];
					assert.equal(isSlaPolicyList(invalidSpecific), false);
				}
			);

			await st.test('catálogo válido vacío crea incidencia sin SLA', () => {
				const draft = {
					id: 990,
					organizationId: orgA,
					title: 'Caso con catálogo vacío',
					client: 'Cliente A',
					description: 'Sin políticas',
					status: 'open',
					priority: 'high',
					createdAt: '2026-09-10T10:00:00.000Z'
				};
				const incident = applyCreationSla(draft, []);
				assert.equal(incident.sla, undefined);
			});

			await st.test('catálogo válido sin coincidencia crea incidencia sin SLA', () => {
				const draft = {
					id: 991,
					organizationId: orgA,
					title: 'Caso sin coincidencia',
					client: 'Cliente A',
					description: 'Sin coincidencia',
					status: 'open',
					priority: 'low',
					categoryId: 'hardware',
					createdAt: '2026-09-10T10:00:00.000Z'
				};
				const specificPoliciesOnly = [
					{
						id: 'pol-only-net',
						organizationId: orgA,
						name: 'Solo Redes Alta',
						active: true,
						isDefault: false,
						categoryId: 'network',
						priority: 'high',
						firstResponseMinutes: 15,
						resolutionMinutes: 60,
						createdAt: '2026-09-10T10:00:00.000Z'
					}
				];
				const incident = applyCreationSla(draft, specificPoliciesOnly);
				assert.equal(incident.sla, undefined);
			});

			await st.test(
				'inmutabilidad: editar o desactivar política no altera snapshots previos',
				() => {
					const customPolicies = [
						{
							id: 'pol-custom-fast',
							organizationId: orgA,
							name: 'SLA Rápido',
							active: true,
							isDefault: false,
							categoryId: 'network',
							priority: 'high',
							firstResponseMinutes: 15,
							resolutionMinutes: 60,
							createdAt: '2026-09-10T10:00:00.000Z'
						}
					];

					const draft = {
						id: 992,
						organizationId: orgA,
						title: 'Fallo de switch de fibra',
						client: 'Cliente A',
						description: 'Caída de red',
						status: 'open',
						priority: 'high',
						categoryId: 'network',
						createdAt: '2026-09-10T10:00:00.000Z'
					};

					// Nueva incidencia usa el catálogo persistido
					const incident1 = applyCreationSla(draft, customPolicies);
					assert.ok(incident1.sla);
					assert.equal(incident1.sla.policyId, 'pol-custom-fast');
					assert.equal(incident1.sla.firstResponseMinutes, 15);
					assert.equal(incident1.sla.resolutionMinutes, 60);

					// Mutación posterior del catálogo (editar la política a 30m / 120m)
					const updatedPolicies = changeSlaPolicy(adminUser, customPolicies, {
						type: 'save',
						id: 'pol-custom-fast',
						name: 'SLA Rápido Modificado',
						isDefault: false,
						categoryId: 'network',
						priority: 'high',
						firstResponseMinutes: 30,
						resolutionMinutes: 120
					});

					// Garantía: el snapshot de la incidencia ya creada NO cambia
					assert.equal(incident1.sla.firstResponseMinutes, 15);
					assert.equal(incident1.sla.resolutionMinutes, 60);
					assert.equal(incident1.sla.firstResponseDueAt, '2026-09-10T10:15:00.000Z');

					// Nueva incidencia creada tras el cambio recibe la nueva configuración
					const draft2 = { ...draft, id: 993 };
					const incident2 = applyCreationSla(draft2, updatedPolicies);
					assert.equal(incident2.sla.firstResponseMinutes, 30);
					assert.equal(incident2.sla.resolutionMinutes, 120);

					// Desactivar la política
					const deactivatedPolicies = changeSlaPolicy(adminUser, updatedPolicies, {
						type: 'toggle',
						id: 'pol-custom-fast'
					});

					// Las incidencias previas siguen conservando sus snapshots intactos
					assert.equal(incident1.sla.firstResponseMinutes, 15);
					assert.equal(incident2.sla.firstResponseMinutes, 30);

					// Una nueva incidencia ahora queda sin SLA porque la política está inactiva y no hay default
					const draft3 = { ...draft, id: 994 };
					const incident3 = applyCreationSla(draft3, activeSlaPolicies(deactivatedPolicies, orgA));
					assert.equal(incident3.sla, undefined);
				}
			);

			await st.test('A. catalog state valid con policies [] permite creación sin SLA', () => {
				const draft = {
					id: 995,
					organizationId: orgA,
					title: 'Caso con catálogo vacío',
					client: 'Cliente A',
					description: 'Sin políticas',
					status: 'open',
					priority: 'high',
					createdAt: '2026-09-10T10:00:00.000Z'
				};
				const check = checkIncidentCreationSla({ status: 'valid', policies: [] }, orgA);
				assert.equal(check.allowed, true);
				assert.deepEqual(check.policies, []);
				const incident = applyCreationSla(draft, check.policies);
				assert.equal(incident.sla, undefined);
			});

			await st.test('B. catalog state valid sin coincidencia permite creación sin SLA', () => {
				const draft = {
					id: 996,
					organizationId: orgA,
					title: 'Caso sin coincidencia',
					client: 'Cliente A',
					description: 'Sin coincidencia',
					status: 'open',
					priority: 'low',
					categoryId: 'hardware',
					createdAt: '2026-09-10T10:00:00.000Z'
				};
				const specificOnly = [
					{
						id: 'pol-only-net',
						organizationId: orgA,
						name: 'Solo Redes Alta',
						active: true,
						isDefault: false,
						categoryId: 'network',
						priority: 'high',
						firstResponseMinutes: 15,
						resolutionMinutes: 60,
						createdAt: '2026-09-10T10:00:00.000Z'
					}
				];
				const check = checkIncidentCreationSla({ status: 'valid', policies: specificOnly }, orgA);
				assert.equal(check.allowed, true);
				const incident = applyCreationSla(draft, check.policies);
				assert.equal(incident.sla, undefined);
			});

			await st.test('C. catalog state corrupt bloquea creación', () => {
				const corruptState = {
					status: 'corrupt',
					error: 'JSON inválido',
					raw: '{ corrupt'
				};
				const check = checkIncidentCreationSla(corruptState, orgA);
				assert.equal(check.allowed, false);
				assert.ok(check.error.includes('corrupto'));
			});

			await st.test('D. corrupt nunca devuelve ni usa demoSlaPolicies como fallback', () => {
				const corruptState = {
					status: 'corrupt',
					error: 'Esquema roto',
					raw: '[]'
				};
				const check = checkIncidentCreationSla(corruptState, orgA);
				assert.equal(check.allowed, false);
				assert.equal('policies' in check, false);
			});
		});

		// ==========================================
		// 5. HELPERS DE TIEMPO Y PRESENTACIÓN DE ÁMBITO
		// ==========================================
		await t.test('5. Helpers de conversión de tiempo y presentación de ámbito', async (st) => {
			await st.test('conversión de minutos a entrada de tiempo amigable sin pérdidas', () => {
				assert.deepEqual(minutesToTimeInput(1440), { value: 1, unit: 'days' });
				assert.deepEqual(minutesToTimeInput(2880), { value: 2, unit: 'days' });
				assert.deepEqual(minutesToTimeInput(240), { value: 4, unit: 'hours' });
				assert.deepEqual(minutesToTimeInput(60), { value: 1, unit: 'hours' });
				// 90 no es divisible por 1440 ni por 60 -> se muestra en minutos sin redondear ni truncar
				assert.deepEqual(minutesToTimeInput(90), { value: 90, unit: 'minutes' });
				assert.deepEqual(minutesToTimeInput(45), { value: 45, unit: 'minutes' });
			});

			await st.test('conversión de entrada de tiempo a minutos', () => {
				assert.equal(timeInputToMinutes(1, 'days'), 1440);
				assert.equal(timeInputToMinutes(2, 'days'), 2880);
				assert.equal(timeInputToMinutes(4, 'hours'), 240);
				assert.equal(timeInputToMinutes(30, 'minutes'), 30);
				assert.throws(() => timeInputToMinutes(-5, 'hours'), /entero positivo/);
				assert.throws(() => timeInputToMinutes(1.5, 'days'), /entero positivo/);
			});

			await st.test('formato legible de ámbito (formatSlaPolicyScope)', () => {
				const defaultPolicy = { isDefault: true };
				assert.equal(formatSlaPolicyScope(defaultPolicy, sampleCategories), 'Predeterminada');

				const catAndPrioPolicy = { isDefault: false, categoryId: 'network', priority: 'high' };
				assert.equal(formatSlaPolicyScope(catAndPrioPolicy, sampleCategories), 'Redes + Alta');

				const catOnlyPolicy = { isDefault: false, categoryId: 'equipment', priority: null };
				assert.equal(formatSlaPolicyScope(catOnlyPolicy, sampleCategories), 'Equipos');

				const prioOnlyPolicy = { isDefault: false, categoryId: null, priority: 'medium' };
				assert.equal(formatSlaPolicyScope(prioOnlyPolicy, sampleCategories), 'Prioridad Media');
			});
		});
	} finally {
		await server.close();
	}
});

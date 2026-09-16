import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('Clasificación V2 — Fase 1A: Motor puro determinista y modelos', async (suite) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const {
			classifyIncident,
			createStandardPriorityMatrix,
			validatePriorityMatrix,
			toIncidentPriority,
			toCalculatedPriority,
			compareCalculatedPriorities,
			maxCalculatedPriority,
			isImpactLevel,
			isBaseCriticality,
			isCalculatedPriority,
			isSubcategory,
			VALID_IMPACT_LEVELS,
			VALID_BASE_CRITICALITIES,
			VALID_CALCULATED_PRIORITIES,
			CALCULATED_PRIORITY_RANK,
			COMPATIBLE_INCIDENT_PRIORITY_RANK
		} = await server.ssrLoadModule('/src/lib/classification/engine.ts');

		const orgId = 'org-nodhouses';
		const standardMatrix = createStandardPriorityMatrix(orgId);

		const baseSubcategory = {
			id: 'subcat-network-fiber',
			organizationId: orgId,
			categoryId: 'network',
			name: 'Corte de fibra troncal',
			baseCriticality: 'high',
			minPriority: null,
			active: true
		};

		// =========================================================================
		// 1. Todas las 12 combinaciones de criticidad base e impacto
		// =========================================================================
		await suite.test(
			'1. Evaluación exhaustiva de las 12 combinaciones (criticidad x impacto)',
			() => {
				const expectedStandardResults = {
					high: {
						I1: 'critical',
						I2: 'high',
						I3: 'medium',
						I4: 'low'
					},
					medium: {
						I1: 'high',
						I2: 'medium',
						I3: 'low',
						I4: 'low'
					},
					low: {
						I1: 'medium',
						I2: 'low',
						I3: 'low',
						I4: 'low'
					}
				};

				for (const crit of VALID_BASE_CRITICALITIES) {
					for (const impact of VALID_IMPACT_LEVELS) {
						const expectedPriority = expectedStandardResults[crit][impact];
						const subcat = {
							...baseSubcategory,
							baseCriticality: crit,
							minPriority: null
						};

						const result = classifyIncident({
							subcategory: subcat,
							impact,
							matrix: standardMatrix
						});

						assert.equal(
							result.calculatedPriority,
							expectedPriority,
							`Combinación (${crit}, ${impact}) debe calcular ${expectedPriority}`
						);
						assert.equal(
							result.effectivePriority,
							expectedPriority,
							`Sin override, effectivePriority debe coincidir con calculatedPriority`
						);
						assert.equal(result.snapshot.baseCriticality, crit);
						assert.equal(result.snapshot.impactLevel, impact);
						assert.equal(result.snapshot.matrixPriority, expectedPriority);
						assert.equal(result.snapshot.minPriority, null);
						assert.equal(result.snapshot.minPriorityApplied, false);
						assert.equal(result.snapshot.calculatedPriority, expectedPriority);
						assert.equal(result.snapshot.effectivePriority, expectedPriority);
						assert.equal(result.snapshot.hasOverride, false);
						assert.equal(result.override, null);
					}
				}
			}
		);

		// =========================================================================
		// 2. Prioridad mínima (minPriority)
		// =========================================================================
		await suite.test('2. Aplicación determinista de prioridad mínima (minPriority)', async (st) => {
			await st.test('2.1 Eleva la prioridad si el resultado de la matriz es inferior', () => {
				// Base low + I4 -> matrix da 'low', pero minPriority es 'high'
				const subcat = {
					...baseSubcategory,
					baseCriticality: 'low',
					minPriority: 'high'
				};

				const result = classifyIncident({
					subcategory: subcat,
					impact: 'I4',
					matrix: standardMatrix
				});

				assert.equal(result.snapshot.matrixPriority, 'low');
				assert.equal(result.snapshot.minPriority, 'high');
				assert.equal(result.snapshot.minPriorityApplied, true);
				assert.equal(result.calculatedPriority, 'high');
				assert.equal(result.effectivePriority, 'high');
			});

			await st.test(
				'2.2 No degrada la prioridad si el resultado de la matriz ya es superior',
				() => {
					// Base high + I1 -> matrix da 'critical', minPriority es 'medium'
					const subcat = {
						...baseSubcategory,
						baseCriticality: 'high',
						minPriority: 'medium'
					};

					const result = classifyIncident({
						subcategory: subcat,
						impact: 'I1',
						matrix: standardMatrix
					});

					assert.equal(result.snapshot.matrixPriority, 'critical');
					assert.equal(result.snapshot.minPriority, 'medium');
					assert.equal(result.snapshot.minPriorityApplied, false);
					assert.equal(result.calculatedPriority, 'critical');
					assert.equal(result.effectivePriority, 'critical');
				}
			);

			await st.test('2.3 minPriority null no afecta el cálculo', () => {
				const subcat = {
					...baseSubcategory,
					baseCriticality: 'medium',
					minPriority: null
				};

				const result = classifyIncident({
					subcategory: subcat,
					impact: 'I2',
					matrix: standardMatrix
				});

				assert.equal(result.snapshot.matrixPriority, 'medium');
				assert.equal(result.snapshot.minPriority, null);
				assert.equal(result.snapshot.minPriorityApplied, false);
				assert.equal(result.calculatedPriority, 'medium');
			});
		});

		// =========================================================================
		// 3. Override válido con motivo y autorización
		// =========================================================================
		await suite.test('3. Override manual autorizado con motivo justificado', async (st) => {
			await st.test(
				'3.1 Aplica override superior conservando snapshot del cálculo original',
				() => {
					// Cálculo: medium + I3 -> 'low'
					const subcat = {
						...baseSubcategory,
						baseCriticality: 'medium',
						minPriority: null
					};

					const result = classifyIncident({
						subcategory: subcat,
						impact: 'I3',
						matrix: standardMatrix,
						override: {
							targetPriority: 'critical',
							reason: 'Impacto en servidor crítico de facturación a fin de mes',
							isAuthorized: true,
							authorizedByUserId: 'usr-admin-01'
						}
					});

					assert.equal(
						result.calculatedPriority,
						'low',
						'La prioridad calculada debe mantenerse inmutable'
					);
					assert.equal(
						result.effectivePriority,
						'critical',
						'La prioridad efectiva debe ser el override'
					);
					assert.equal(result.snapshot.matrixPriority, 'low');
					assert.equal(result.snapshot.calculatedPriority, 'low');
					assert.equal(result.snapshot.effectivePriority, 'critical');
					assert.equal(result.snapshot.hasOverride, true);
					assert.equal(
						result.snapshot.overrideReason,
						'Impacto en servidor crítico de facturación a fin de mes'
					);
					assert.equal(result.snapshot.overrideAuthorizedBy, 'usr-admin-01');
					assert.deepEqual(result.override, {
						targetPriority: 'critical',
						reason: 'Impacto en servidor crítico de facturación a fin de mes',
						authorizedByUserId: 'usr-admin-01'
					});
				}
			);

			await st.test('3.2 Aplica override inferior (desescalado) cuando esté autorizado', () => {
				// Cálculo: high + I1 -> 'critical'
				const subcat = {
					...baseSubcategory,
					baseCriticality: 'high',
					minPriority: null
				};

				const result = classifyIncident({
					subcategory: subcat,
					impact: 'I1',
					matrix: standardMatrix,
					override: {
						targetPriority: 'low',
						reason: 'Entorno de pruebas no productivo, sin afectación real',
						isAuthorized: true
					}
				});

				assert.equal(result.calculatedPriority, 'critical');
				assert.equal(result.effectivePriority, 'low');
				assert.equal(result.snapshot.hasOverride, true);
				assert.equal(result.override?.targetPriority, 'low');
				assert.equal(result.override?.authorizedByUserId, undefined);
			});
		});

		// =========================================================================
		// 4. Validaciones de Override (motivo y autorización / frontera de seguridad)
		// =========================================================================
		await suite.test('4. Validaciones y frontera de seguridad en override', async (st) => {
			const validSubcat = { ...baseSubcategory, baseCriticality: 'medium' };

			await st.test('4.1 Rechaza override con motivo vacío o solo espacios', () => {
				for (const badReason of ['', '   ', '\t\n', null, undefined]) {
					assert.throws(
						() =>
							classifyIncident({
								subcategory: validSubcat,
								impact: 'I2',
								matrix: standardMatrix,
								override: {
									targetPriority: 'high',
									reason: badReason,
									isAuthorized: true
								}
							}),
						/El override de prioridad requiere un motivo justificado no vacío/
					);
				}
			});

			await st.test('4.2 Rechaza override no autorizado (isAuthorized !== true)', () => {
				for (const unauthorizedVal of [false, undefined, null, 0, 'true']) {
					assert.throws(
						() =>
							classifyIncident({
								subcategory: validSubcat,
								impact: 'I2',
								matrix: standardMatrix,
								override: {
									targetPriority: 'high',
									reason: 'Urgencia operativa',
									isAuthorized: unauthorizedVal
								}
							}),
						/Override no autorizado: se requiere una precondición explícita de autorización por la capa de aplicación/
					);
				}
			});

			await st.test('4.3 Rechaza override con prioridad inválida', () => {
				assert.throws(
					() =>
						classifyIncident({
							subcategory: validSubcat,
							impact: 'I2',
							matrix: standardMatrix,
							override: {
								targetPriority: 'super-urgent',
								reason: 'Caso extremo',
								isAuthorized: true
							}
						}),
					/Prioridad de override inválida/
				);
			});
		});

		// =========================================================================
		// 5. Entradas inválidas
		// =========================================================================
		await suite.test('5. Rechazo de entradas inválidas', async (st) => {
			await st.test('5.1 Rechaza parámetros de entrada ausentes o nulos', () => {
				assert.throws(() => classifyIncident(null), /Parámetros de clasificación inválidos/);
				assert.throws(() => classifyIncident(undefined), /Parámetros de clasificación inválidos/);
				assert.throws(() => classifyIncident(''), /Parámetros de clasificación inválidos/);
			});

			await st.test('5.2 Rechaza impacto inválido', () => {
				for (const badImpact of ['I0', 'I5', 'high', 'critical', '', null, undefined, 1]) {
					assert.throws(
						() =>
							classifyIncident({
								subcategory: baseSubcategory,
								impact: badImpact,
								matrix: standardMatrix
							}),
						/Impacto inválido/
					);
				}
			});

			await st.test('5.3 Rechaza subcategoría con criticidad base inválida', () => {
				for (const badCrit of ['critical', 'urgent', 'extreme', '', null, undefined]) {
					assert.throws(
						() =>
							classifyIncident({
								subcategory: { ...baseSubcategory, baseCriticality: badCrit },
								impact: 'I1',
								matrix: standardMatrix
							}),
						/Criticidad base inválida/
					);
				}
			});

			await st.test('5.4 Rechaza subcategoría con minPriority inválida', () => {
				for (const badMin of ['urgent', 'extreme', 'I1', 4]) {
					assert.throws(
						() =>
							classifyIncident({
								subcategory: { ...baseSubcategory, minPriority: badMin },
								impact: 'I1',
								matrix: standardMatrix
							}),
						/Prioridad mínima inválida/
					);
				}
			});

			await st.test('5.5 Rechaza subcategoría inactiva', () => {
				assert.throws(
					() =>
						classifyIncident({
							subcategory: { ...baseSubcategory, active: false },
							impact: 'I1',
							matrix: standardMatrix
						}),
					/No se puede clasificar con una subcategoría inactiva/
				);
			});

			await st.test('5.6 Rechaza subcategoría incompleta', () => {
				assert.throws(
					() =>
						classifyIncident({
							subcategory: { ...baseSubcategory, id: '' },
							impact: 'I1',
							matrix: standardMatrix
						}),
					/Subcategoría inválida: falta el identificador/
				);
				assert.throws(
					() =>
						classifyIncident({
							subcategory: { ...baseSubcategory, organizationId: '   ' },
							impact: 'I1',
							matrix: standardMatrix
						}),
					/Subcategoría inválida: falta el identificador de organización/
				);
				assert.throws(
					() =>
						classifyIncident({
							subcategory: { ...baseSubcategory, categoryId: '' },
							impact: 'I1',
							matrix: standardMatrix
						}),
					/Subcategoría inválida: falta el identificador de categoría/
				);
				assert.throws(
					() =>
						classifyIncident({
							subcategory: { ...baseSubcategory, name: '' },
							impact: 'I1',
							matrix: standardMatrix
						}),
					/Subcategoría inválida: falta el nombre/
				);
			});
		});

		// =========================================================================
		// 6. Validación de matriz incompleta o incoherente
		// =========================================================================
		await suite.test('6. Rechazo de matrices incompletas o malformadas', async (st) => {
			await st.test('6.1 Rechaza matriz sin identificador de organización', () => {
				assert.throws(
					() =>
						classifyIncident({
							subcategory: baseSubcategory,
							impact: 'I1',
							matrix: { organizationId: '', matrix: standardMatrix.matrix }
						}),
					/Matriz de prioridades inválida: falta el identificador de organización/
				);
			});

			await st.test('6.2 Rechaza matriz con fila de criticidad faltante', () => {
				const incomplete = {
					organizationId: orgId,
					matrix: {
						high: standardMatrix.matrix.high,
						low: standardMatrix.matrix.low
						// falta 'medium'
					}
				};

				assert.throws(
					() =>
						classifyIncident({
							subcategory: baseSubcategory,
							impact: 'I1',
							matrix: incomplete
						}),
					/Matriz de prioridades incompleta: falta la fila para criticidad "medium"/
				);
			});

			await st.test('6.3 Rechaza matriz con celda de impacto faltante o inválida', () => {
				const brokenCellMatrix = {
					organizationId: orgId,
					matrix: {
						...standardMatrix.matrix,
						high: {
							I1: 'critical',
							I2: 'high',
							I3: 'medium'
							// falta I4
						}
					}
				};

				assert.throws(
					() =>
						classifyIncident({
							subcategory: baseSubcategory,
							impact: 'I1',
							matrix: brokenCellMatrix
						}),
					/Matriz de prioridades incompleta o inválida/
				);
			});

			await st.test('6.4 Valida con éxito una matriz completa y bien formada', () => {
				assert.doesNotThrow(() => validatePriorityMatrix(standardMatrix));
			});
		});

		// =========================================================================
		// 7. Aislamiento y congruencia organizacional (multi-tenant)
		// =========================================================================
		await suite.test('7. Aislamiento de configuración multi-tenant', async (st) => {
			await st.test(
				'7.1 Rechaza mezclar subcategoría de una organización con matriz de otra',
				() => {
					const foreignMatrix = createStandardPriorityMatrix('org-foreign-corp');

					assert.throws(
						() =>
							classifyIncident({
								subcategory: baseSubcategory, // organizationId: 'org-nodhouses'
								impact: 'I1',
								matrix: foreignMatrix // organizationId: 'org-foreign-corp'
							}),
						/Incoherencia organizacional: la subcategoría pertenece a la organización "org-nodhouses", pero la matriz pertenece a "org-foreign-corp"/
					);
				}
			);
		});

		// =========================================================================
		// 8. Determinismo estricto (misma entrada -> idéntica salida)
		// =========================================================================
		await suite.test(
			'8. Determinismo puro: 100 ejecuciones idénticas sin efectos secundarios',
			() => {
				const input = {
					subcategory: {
						...baseSubcategory,
						baseCriticality: 'high',
						minPriority: 'medium'
					},
					impact: 'I2',
					matrix: standardMatrix,
					override: {
						targetPriority: 'critical',
						reason: 'Ajuste determinista comprobado',
						isAuthorized: true,
						authorizedByUserId: 'usr-eval-99'
					}
				};

				const referenceResult = classifyIncident(input);

				for (let i = 0; i < 100; i++) {
					const current = classifyIncident(input);
					assert.deepEqual(
						current,
						referenceResult,
						`La iteración ${i} debe ser estrictamente idéntica a la referencia`
					);
				}
			}
		);

		// =========================================================================
		// 9. Inmutabilidad de los objetos de entrada
		// =========================================================================
		await suite.test('9. Inmutabilidad: los objetos de entrada no son mutados', () => {
			const deepFreeze = (obj) => {
				if (!obj || typeof obj !== 'object') return obj;
				Object.freeze(obj);
				for (const key of Object.keys(obj)) {
					deepFreeze(obj[key]);
				}
				return obj;
			};

			const frozenSubcategory = deepFreeze({
				id: 'subcat-immutable',
				organizationId: orgId,
				categoryId: 'hardware',
				name: 'Servidor blade dañado',
				baseCriticality: 'high',
				minPriority: 'low',
				active: true
			});

			const frozenMatrix = deepFreeze(createStandardPriorityMatrix(orgId));

			const frozenOverride = deepFreeze({
				targetPriority: 'critical',
				reason: 'Sin efectos secundarios',
				isAuthorized: true,
				authorizedByUserId: 'usr-freeze'
			});

			const input = deepFreeze({
				subcategory: frozenSubcategory,
				impact: 'I1',
				matrix: frozenMatrix,
				override: frozenOverride
			});

			// No debe lanzar TypeError por intento de mutar objetos congelados
			const result = classifyIncident(input);
			assert.equal(result.effectivePriority, 'critical');
			assert.equal(result.calculatedPriority, 'critical');
		});

		// =========================================================================
		// 10. Compatibilidad explícita y bidireccional urgent <-> critical
		// =========================================================================
		await suite.test(
			'10. Estrategia de compatibilidad explícita y bidireccional urgent / critical',
			async (st) => {
				await st.test('10.1 Mapeo de CalculatedPriority (V2) a IncidentPriority compatible', () => {
					assert.equal(toIncidentPriority('critical'), 'urgent');
					assert.equal(toIncidentPriority('high'), 'high');
					assert.equal(toIncidentPriority('medium'), 'medium');
					assert.equal(toIncidentPriority('low'), 'low');
				});

				await st.test('10.2 Mapeo de IncidentPriority (o urgent) a CalculatedPriority (V2)', () => {
					assert.equal(toCalculatedPriority('urgent'), 'critical');
					assert.equal(toCalculatedPriority('high'), 'high');
					assert.equal(toCalculatedPriority('medium'), 'medium');
					assert.equal(toCalculatedPriority('low'), 'low');
				});

				await st.test(
					'10.3 critical nunca se convierte silenciosamente en high; equivalencia estricta critical <-> urgent',
					() => {
						assert.equal(toIncidentPriority('critical'), 'urgent');
						assert.notEqual(
							toIncidentPriority('critical'),
							'high',
							'critical NO debe convertirse silenciosamente en high'
						);
						assert.equal(toCalculatedPriority('urgent'), 'critical');
						assert.notEqual(
							toCalculatedPriority('urgent'),
							'high',
							'urgent NO debe degradarse a high'
						);
					}
				);

				await st.test('10.4 Biyección estricta (idempotencia y reversibilidad)', () => {
					for (const cp of VALID_CALCULATED_PRIORITIES) {
						const mapped = toIncidentPriority(cp);
						const reversed = toCalculatedPriority(mapped);
						assert.equal(reversed, cp, `Reversibilidad fallida para ${cp}`);
					}

					const legacyPriorities = ['low', 'medium', 'high', 'urgent'];
					for (const lp of legacyPriorities) {
						const mapped = toCalculatedPriority(lp);
						const reversed = toIncidentPriority(mapped);
						assert.equal(reversed, lp, `Reversibilidad fallida para ${lp}`);
					}
				});

				await st.test('10.5 Correspondencia de rangos y orden de severidad', () => {
					assert.equal(
						CALCULATED_PRIORITY_RANK['critical'],
						COMPATIBLE_INCIDENT_PRIORITY_RANK['urgent']
					);
					assert.equal(CALCULATED_PRIORITY_RANK['high'], COMPATIBLE_INCIDENT_PRIORITY_RANK['high']);
					assert.equal(
						CALCULATED_PRIORITY_RANK['medium'],
						COMPATIBLE_INCIDENT_PRIORITY_RANK['medium']
					);
					assert.equal(CALCULATED_PRIORITY_RANK['low'], COMPATIBLE_INCIDENT_PRIORITY_RANK['low']);

					assert.ok(compareCalculatedPriorities('critical', 'high') > 0);
					assert.ok(compareCalculatedPriorities('high', 'medium') > 0);
					assert.ok(compareCalculatedPriorities('medium', 'low') > 0);
					assert.equal(compareCalculatedPriorities('high', 'high'), 0);

					assert.equal(maxCalculatedPriority('critical', 'low'), 'critical');
					assert.equal(maxCalculatedPriority('low', 'high'), 'high');
					assert.equal(maxCalculatedPriority('medium', 'medium'), 'medium');
				});
			}
		);

		// =========================================================================
		// 11. Type guards auxiliares
		// =========================================================================
		await suite.test('11. Type guards de dominio', () => {
			assert.equal(isImpactLevel('I1'), true);
			assert.equal(isImpactLevel('I4'), true);
			assert.equal(isImpactLevel('I5'), false);

			assert.equal(isBaseCriticality('low'), true);
			assert.equal(isBaseCriticality('high'), true);
			assert.equal(isBaseCriticality('critical'), false);

			assert.equal(isCalculatedPriority('critical'), true);
			assert.equal(isCalculatedPriority('urgent'), false);

			assert.equal(isSubcategory(baseSubcategory), true);
			assert.equal(isSubcategory({ ...baseSubcategory, id: '' }), false);
			assert.equal(isSubcategory(null), false);
		});
	} finally {
		await server.close();
	}
});

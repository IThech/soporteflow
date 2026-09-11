import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createServer } from 'vite';

test('Evolución de Routing: Categorías, Capacidad, Asignación y Clasificación (A1-F32)', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });
	try {
		const {
			isCategory,
			isCategoryList,
			validateCategoryRouting,
			loadCategoriesResult,
			resolveCategoryRouting
		} = await server.ssrLoadModule('/src/lib/categories/catalog.ts');
		const {
			prepareAssignment,
			isCandidateLevelCompatible,
			canAssignTo,
			shouldInheritInitialRouting,
			getAssigneeLevelIncompatibility
		} = await server.ssrLoadModule('/src/lib/incidents/assignment.ts');
		const { prepareClassificationChange } = await server.ssrLoadModule(
			'/src/lib/incidents/escalation.ts'
		);
		const { demoOrganization } = await server.ssrLoadModule('/src/lib/data/organizations.ts');
		const { demoSupportLevels } = await server.ssrLoadModule('/src/lib/data/support-levels.ts');
		const { demoSupportTeams } = await server.ssrLoadModule('/src/lib/data/teams.ts');
		const { demoUsers } = await server.ssrLoadModule('/src/lib/data/users.ts');
		const { initialCategories } = await server.ssrLoadModule('/src/lib/data/categories.ts');

		const orgId = demoOrganization.id;
		const levels = demoSupportLevels;
		const teams = demoSupportTeams;
		const admin = demoUsers.find((u) => u.role === 'organization_admin');

		const levelsWithN4 = [
			...levels,
			{
				id: 'lvl-nodhouses-n4',
				organizationId: orgId,
				code: 'N4',
				name: 'Cuarta línea',
				order: 4,
				active: true,
				createdAt: '2026-09-01'
			}
		];

		const techN1 = {
			id: 'tech-n1',
			organizationId: orgId,
			name: 'Técnico N1',
			email: 'n1@nodhouses.test',
			role: 'technician',
			supportLevel: 'N1',
			teamId: teams[0].id,
			active: true,
			createdAt: '2026-09-01'
		};

		const techN2 = {
			id: 'tech-n2',
			organizationId: orgId,
			name: 'Técnico N2',
			email: 'n2@nodhouses.test',
			role: 'technician',
			supportLevel: 'N2',
			teamId: teams[0].id,
			active: true,
			createdAt: '2026-09-01'
		};

		const techN3 = {
			id: 'tech-n3',
			organizationId: orgId,
			name: 'Técnico N3',
			email: 'n3@nodhouses.test',
			role: 'technician',
			supportLevel: 'N3',
			teamId: teams[1].id,
			active: true,
			createdAt: '2026-09-01'
		};

		const techN4 = {
			id: 'tech-n4',
			organizationId: orgId,
			name: 'Técnico N4 (Thor)',
			email: 'thor@nodhouses.test',
			role: 'technician',
			supportLevel: 'N4',
			teamId: teams[1].id,
			active: true,
			createdAt: '2026-09-01'
		};

		const bareTech = {
			id: 'tech-bare',
			organizationId: orgId,
			name: 'Técnico Sin Nivel',
			email: 'bare@nodhouses.test',
			role: 'technician',
			active: true,
			createdAt: '2026-09-01'
		};

		const adminOperativeN1 = {
			id: 'admin-op-n1',
			organizationId: orgId,
			name: 'Admin Operativo N1',
			email: 'admin-n1@nodhouses.test',
			role: 'organization_admin',
			supportLevel: 'N1',
			teamId: teams[0].id,
			active: true,
			createdAt: '2026-09-01'
		};

		const adminOperativeN2 = {
			id: 'admin-op-n2',
			organizationId: orgId,
			name: 'Admin Operativo N2',
			email: 'admin-n2@nodhouses.test',
			role: 'organization_admin',
			supportLevel: 'N2',
			teamId: teams[0].id,
			active: true,
			createdAt: '2026-09-01'
		};

		const foreignTech = {
			id: 'tech-foreign',
			organizationId: 'other-org',
			name: 'Técnico Externo',
			email: 'foreign@other.test',
			role: 'technician',
			supportLevel: 'N2',
			teamId: 'other-team',
			active: true,
			createdAt: '2026-09-01'
		};

		const allUsers = [
			admin,
			techN1,
			techN2,
			techN3,
			techN4,
			bareTech,
			adminOperativeN1,
			adminOperativeN2,
			foreignTech
		];

		const n2Ticket = {
			id: 100,
			organizationId: orgId,
			title: 'Problema en switches',
			client: 'Acme Corp',
			status: 'open',
			priority: 'high',
			createdAt: '2026-09-10T10:00:00.000Z',
			categoryId: 'network',
			supportLevel: 'N2',
			teamId: teams[1].id
		};

		// ==========================================
		// A. Categorías (1 - 8)
		// ==========================================
		await t.test('A. Categorías con routing predeterminado y validación', async (st) => {
			await st.test('1. categoría sin routing predeterminado', () => {
				const res = validateCategoryRouting({}, levels, teams, orgId);
				assert.equal(res.valid, true);
				assert.equal(
					isCategory({ id: 'cat-none', name: 'General', description: 'Sin routing', active: true }),
					true
				);
			});

			await st.test('2. categoría con nivel predeterminado', () => {
				const res = validateCategoryRouting({ defaultSupportLevel: 'N1' }, levels, teams, orgId);
				assert.equal(res.valid, true);
				assert.equal(
					isCategory({
						id: 'cat-lvl',
						name: 'Hardware',
						description: 'Equipos',
						active: true,
						defaultSupportLevel: 'N1'
					}),
					true
				);
			});

			await st.test('3. categoría con equipo predeterminado', () => {
				const res = validateCategoryRouting({ defaultTeamId: teams[0].id }, levels, teams, orgId);
				assert.equal(res.valid, true);
				assert.equal(
					isCategory({
						id: 'cat-team',
						name: 'Soporte General',
						description: 'Desc',
						active: true,
						defaultTeamId: teams[0].id
					}),
					true
				);
			});

			await st.test('4. categoría con nivel + equipo', () => {
				const res = validateCategoryRouting(
					{ defaultSupportLevel: 'N2', defaultTeamId: teams[1].id },
					levels,
					teams,
					orgId
				);
				assert.equal(res.valid, true);
				assert.equal(
					isCategory({
						id: 'cat-both',
						name: 'Redes',
						description: 'Desc',
						active: true,
						defaultSupportLevel: 'N2',
						defaultTeamId: teams[1].id
					}),
					true
				);
			});

			await st.test('5. rechazo de nivel de otra organización', () => {
				const otherOrgLevels = [
					{
						id: 'lvl-other',
						organizationId: 'other-org',
						code: 'N1',
						name: 'Nivel Externo',
						order: 1,
						active: true,
						createdAt: '2026-09-01'
					}
				];
				const res = validateCategoryRouting(
					{ defaultSupportLevel: 'N1' },
					otherOrgLevels,
					teams,
					orgId
				);
				assert.equal(res.valid, false);
				assert.match(res.error, /pertenece a la organización/);
			});

			await st.test('6. rechazo de equipo de otra organización', () => {
				const otherOrgTeams = [
					{
						id: 'team-other',
						organizationId: 'other-org',
						name: 'Equipo Externo',
						active: true,
						createdAt: '2026-09-01'
					}
				];
				const res = validateCategoryRouting(
					{ defaultTeamId: 'team-other' },
					levels,
					otherOrgTeams,
					orgId
				);
				assert.equal(res.valid, false);
				assert.match(res.error, /pertenece a la organización/);
			});

			await st.test('7. rechazo de nuevas referencias inactivas', () => {
				const inactiveLevel = {
					id: 'lvl-inact',
					organizationId: orgId,
					code: 'N-INACT',
					name: 'Inactivo',
					order: 9,
					active: false,
					createdAt: '2026-09-01'
				};
				const inactiveTeam = {
					id: 'team-inact',
					organizationId: orgId,
					name: 'Equipo Inactivo',
					active: false,
					createdAt: '2026-09-01'
				};
				const resLevel = validateCategoryRouting(
					{ defaultSupportLevel: 'N-INACT' },
					[...levels, inactiveLevel],
					teams,
					orgId
				);
				assert.equal(resLevel.valid, false);
				assert.match(resLevel.error, /inactivo/);

				const resTeam = validateCategoryRouting(
					{ defaultTeamId: 'team-inact' },
					levels,
					[...teams, inactiveTeam],
					orgId
				);
				assert.equal(resTeam.valid, false);
				assert.match(resTeam.error, /inactivo/);

				// Preserva referencia si ya la tenía originalmente
				const originalCat = {
					id: 'cat-orig',
					organizationId: orgId,
					name: 'Cat Original',
					description: '',
					active: true,
					defaultSupportLevel: 'N-INACT',
					defaultTeamId: 'team-inact'
				};
				const resPreserved = validateCategoryRouting(
					{ defaultSupportLevel: 'N-INACT', defaultTeamId: 'team-inact' },
					[...levels, inactiveLevel],
					[...teams, inactiveTeam],
					orgId,
					originalCat
				);
				assert.equal(resPreserved.valid, true);
			});

			await st.test('8. compatibilidad legacy y migración de defaults', () => {
				const legacyList = [
					{ id: 'leg-1', name: 'Legacy 1', description: 'Sin campos routing', active: true },
					{
						id: 'network',
						name: 'Redes',
						description: 'Categoría seed guardada antes de Phase C',
						active: true
					}
				];
				assert.equal(isCategoryList(legacyList), true);

				// Carga y migración desde JSON legacy sin defaultSupportLevel ni defaultTeamId
				const rawLegacy = JSON.stringify(legacyList);
				const loadResult = loadCategoriesResult(rawLegacy, initialCategories);
				assert.equal(loadResult.status, 'valid');

				const netMigrated = loadResult.categories.find((c) => c.id === 'network');
				assert.ok(netMigrated);
				assert.equal(netMigrated.defaultSupportLevel, 'N2');
				assert.equal(netMigrated.defaultTeamId, teams[1]?.id);

				const customMigrated = loadResult.categories.find((c) => c.id === 'leg-1');
				assert.ok(customMigrated);
				assert.equal(customMigrated.defaultSupportLevel, null);
				assert.equal(customMigrated.defaultTeamId, null);
			});
		});

		// ==========================================
		// B. Creación (9 - 12)
		// ==========================================
		await t.test('B. Creación e inicialización de routing desde categorías', async (st) => {
			await st.test('9. nueva incidencia hereda routing de categoría', () => {
				const networkCat = initialCategories.find((c) => c.id === 'network');
				assert.ok(networkCat);
				assert.equal(networkCat.defaultSupportLevel, 'N2');
				assert.equal(networkCat.defaultTeamId, teams[1]?.id);

				// Flujo real de creación: resolveCategoryRouting
				const routing = resolveCategoryRouting(networkCat);
				assert.deepEqual(routing, {
					categoryId: 'network',
					supportLevel: 'N2',
					teamId: teams[1]?.id
				});

				const createdIncident = {
					id: 101,
					organizationId: orgId,
					title: 'Fallo Wi-Fi',
					client: 'Cliente',
					status: 'open',
					priority: 'medium',
					createdAt: '2026-09-12T10:00:00.000Z',
					...routing
				};
				assert.equal(createdIncident.supportLevel, 'N2');
				assert.equal(createdIncident.teamId, teams[1]?.id);
				assert.equal(shouldInheritInitialRouting(createdIncident), false);

				// Verificar también con categorías migradas desde storage legacy
				const rawStoredLegacy = JSON.stringify([
					{ id: 'network', name: 'Redes', description: 'Red', active: true }
				]);
				const loadedResult = loadCategoriesResult(rawStoredLegacy, initialCategories);
				assert.equal(loadedResult.status, 'valid');
				const loadedNetCat = loadedResult.categories.find((c) => c.id === 'network');
				const loadedRouting = resolveCategoryRouting(loadedNetCat);
				const incidentFromLegacyLoaded = {
					id: 103,
					organizationId: orgId,
					title: 'Fallo Wi-Fi desde storage legacy',
					client: 'Cliente',
					status: 'open',
					priority: 'medium',
					createdAt: '2026-09-12T10:00:00.000Z',
					...loadedRouting
				};
				assert.equal(incidentFromLegacyLoaded.supportLevel, 'N2');
				assert.equal(incidentFromLegacyLoaded.teamId, teams[1]?.id);

				// Inmutabilidad: Modificar los defaults de una categoría no altera incidencias preexistentes
				const modifiedCategory = {
					...networkCat,
					defaultSupportLevel: 'N3',
					defaultTeamId: teams[0]?.id
				};
				assert.equal(createdIncident.supportLevel, 'N2');
				assert.equal(createdIncident.teamId, teams[1]?.id);
				assert.notEqual(createdIncident.supportLevel, modifiedCategory.defaultSupportLevel);
			});

			await st.test('10. técnico N4 asignado a incidencia N2 NO cambia N2', () => {
				const res = prepareAssignment(admin, n2Ticket, allUsers, techN4.id, 'Asignación', '', {
					levels: levelsWithN4,
					teams
				});
				assert.ok(res);
				assert.equal(res.incident.assignedToUserId, techN4.id);
				assert.equal(res.incident.supportLevel, 'N2'); // Remains N2, does not become N4!
			});

			await st.test('11. técnico de otro equipo NO cambia automáticamente teamId', () => {
				const n2TicketTeam0 = { ...n2Ticket, teamId: teams[0].id };
				// techN4 is in teams[1].id
				assert.equal(techN4.teamId, teams[1].id);
				const res = prepareAssignment(
					admin,
					n2TicketTeam0,
					allUsers,
					techN4.id,
					'Asignación experta',
					'',
					{
						levels: levelsWithN4,
						teams
					}
				);
				assert.ok(res);
				assert.equal(res.incident.teamId, teams[0].id); // Remains teams[0], does not adopt tech's team!
			});

			await st.test('12. categoría sin routing mantiene comportamiento compatible', () => {
				const otherCat = initialCategories.find((c) => c.id === 'other');
				const otherRouting = resolveCategoryRouting(otherCat);
				assert.deepEqual(otherRouting, {
					categoryId: 'other'
				});
				assert.equal(otherRouting.supportLevel, undefined);
				assert.equal(otherRouting.teamId, undefined);

				const unroutedTicket = {
					id: 102,
					organizationId: orgId,
					title: 'Consulta libre',
					client: 'Cliente',
					status: 'open',
					priority: 'low',
					createdAt: '2026-09-12T10:00:00.000Z',
					...otherRouting
				};
				assert.equal(unroutedTicket.supportLevel, undefined);
				assert.equal(unroutedTicket.teamId, undefined);
				assert.equal(shouldInheritInitialRouting(unroutedTicket), true);
				const res = prepareAssignment(admin, unroutedTicket, allUsers, techN1.id, '', '', {
					levels: levelsWithN4,
					teams
				});
				assert.ok(res);
				assert.equal(res.incident.supportLevel, 'N1');
				assert.equal(res.incident.teamId, teams[0].id);
			});
		});

		// ==========================================
		// C. Capacidad (13 - 19)
		// ==========================================
		await t.test('C. Capacidad y compatibilidad del técnico según jerarquía', async (st) => {
			await st.test('13. incidencia N2 + técnico N1 -> rechazado', () => {
				assert.equal(isCandidateLevelCompatible(techN1, n2Ticket, levelsWithN4), false);
				assert.throws(
					() =>
						prepareAssignment(admin, n2Ticket, allUsers, techN1.id, '', '', {
							levels: levelsWithN4,
							teams
						}),
					/nivel requerido/
				);
			});

			await st.test('14. incidencia N2 + técnico N2 -> permitido', () => {
				assert.equal(isCandidateLevelCompatible(techN2, n2Ticket, levelsWithN4), true);
				const res = prepareAssignment(admin, n2Ticket, allUsers, techN2.id, '', '', {
					levels: levelsWithN4,
					teams
				});
				assert.ok(res);
				assert.equal(res.incident.assignedToUserId, techN2.id);
			});

			await st.test('15. incidencia N2 + técnico N3/N4 -> permitido', () => {
				assert.equal(isCandidateLevelCompatible(techN3, n2Ticket, levelsWithN4), true);
				assert.equal(isCandidateLevelCompatible(techN4, n2Ticket, levelsWithN4), true);
				const res3 = prepareAssignment(admin, n2Ticket, allUsers, techN3.id, '', '', {
					levels: levelsWithN4,
					teams
				});
				assert.ok(res3);
				const res4 = prepareAssignment(admin, n2Ticket, allUsers, techN4.id, '', '', {
					levels: levelsWithN4,
					teams
				});
				assert.ok(res4);
				assert.equal(res4.incident.supportLevel, 'N2');
			});

			await st.test('16. usuario operativo sin nivel + incidencia con nivel -> rechazado', () => {
				assert.equal(isCandidateLevelCompatible(bareTech, n2Ticket, levelsWithN4), false);
				assert.throws(
					() =>
						prepareAssignment(admin, n2Ticket, allUsers, bareTech.id, '', '', {
							levels: levelsWithN4,
							teams
						}),
					/técnico activo|nivel requerido/
				);
			});

			await st.test('17. organization_admin operativo cumple misma jerarquía', () => {
				assert.equal(isCandidateLevelCompatible(adminOperativeN1, n2Ticket, levelsWithN4), false);
				assert.throws(
					() =>
						prepareAssignment(admin, n2Ticket, allUsers, adminOperativeN1.id, '', '', {
							levels: levelsWithN4,
							teams
						}),
					/nivel requerido/
				);

				assert.equal(isCandidateLevelCompatible(adminOperativeN2, n2Ticket, levelsWithN4), true);
				const res = prepareAssignment(admin, n2Ticket, allUsers, adminOperativeN2.id, '', '', {
					levels: levelsWithN4,
					teams
				});
				assert.ok(res);
				assert.equal(res.incident.assignedToUserId, adminOperativeN2.id);
			});

			await st.test('18. usuario de otra organización -> rechazado', () => {
				assert.equal(isCandidateLevelCompatible(foreignTech, n2Ticket, levelsWithN4), false);
				assert.throws(
					() =>
						prepareAssignment(admin, n2Ticket, allUsers, foreignTech.id, '', '', {
							levels: levelsWithN4,
							teams
						}),
					/técnico activo/
				);
			});

			await st.test('19. autoasignación respeta capacidad', () => {
				assert.equal(canAssignTo(techN1, n2Ticket, techN1.id, levelsWithN4), false);
				assert.equal(canAssignTo(techN2, n2Ticket, techN2.id, levelsWithN4), true);
				assert.equal(canAssignTo(techN4, n2Ticket, techN4.id, levelsWithN4), true);
			});
		});

		// ==========================================
		// D. Reasignación (20 - 22)
		// ==========================================
		await t.test('D. Reasignación pura', async (st) => {
			const assignedTicket = {
				...n2Ticket,
				assignedToUserId: techN2.id
			};

			await st.test('20. N2 + responsable N2 -> responsable N4 conserva N2', () => {
				const res = prepareAssignment(
					admin,
					assignedTicket,
					allUsers,
					techN4.id,
					'Escalado de capacidad humana',
					'',
					{ levels: levelsWithN4, teams }
				);
				assert.ok(res);
				assert.equal(res.incident.assignedToUserId, techN4.id);
				assert.equal(res.incident.supportLevel, 'N2');
			});

			await st.test('21. conserva equipo de incidencia', () => {
				const res = prepareAssignment(
					admin,
					assignedTicket,
					allUsers,
					techN4.id,
					'Reasignación',
					'',
					{ levels: levelsWithN4, teams }
				);
				assert.ok(res);
				assert.equal(res.incident.teamId, assignedTicket.teamId);
			});

			await st.test('22. genera reassigned y NO escalated', () => {
				const res = prepareAssignment(
					admin,
					assignedTicket,
					allUsers,
					techN4.id,
					'Reasignación',
					'',
					{ levels: levelsWithN4, teams }
				);
				assert.ok(res);
				assert.equal(res.event.eventType, 'reassigned');
				assert.notEqual(res.event.eventType, 'escalated');
				assert.equal(res.event.previousValue, techN2.id);
				assert.equal(res.event.newValue, techN4.id);
			});
		});

		// ==========================================
		// E. Clasificación (23 - 28)
		// ==========================================
		await t.test('E. Clasificación y Reclasificación (Cambiar clasificación)', async (st) => {
			await st.test('23. N2 -> N3 genera escalated', () => {
				const res = prepareClassificationChange(
					admin,
					n2Ticket,
					{ supportLevel: 'N3', reason: 'Mayor complejidad observada' },
					{ levels: levelsWithN4, teams, categories: initialCategories }
				);
				assert.ok(res);
				assert.equal(res.event.eventType, 'escalated');
				assert.equal(res.incident.supportLevel, 'N3');
				assert.equal(res.event.previousValue.supportLevel, 'N2');
				assert.equal(res.event.newValue.supportLevel, 'N3');
			});

			await st.test('24. N3 -> N1 permitido y registrado (desescalado)', () => {
				const n3Ticket = { ...n2Ticket, supportLevel: 'N3' };
				const res = prepareClassificationChange(
					admin,
					n3Ticket,
					{ supportLevel: 'N1', reason: 'Incidencia sobredimensionada' },
					{ levels: levelsWithN4, teams, categories: initialCategories }
				);
				assert.ok(res);
				assert.equal(res.event.eventType, 'escalated');
				assert.equal(res.incident.supportLevel, 'N1');
				assert.equal(res.event.previousValue.supportLevel, 'N3');
				assert.equal(res.event.newValue.supportLevel, 'N1');
			});

			await st.test('25. cambio de equipo genera escalated', () => {
				const res = prepareClassificationChange(
					admin,
					n2Ticket,
					{ teamId: teams[0].id, reason: 'Derivación departamental' },
					{ levels: levelsWithN4, teams, categories: initialCategories }
				);
				assert.ok(res);
				assert.equal(res.event.eventType, 'escalated');
				assert.equal(res.incident.teamId, teams[0].id);
				assert.equal(res.event.previousValue.teamId, teams[1].id);
				assert.equal(res.event.newValue.teamId, teams[0].id);
			});

			await st.test('26. cambio categoría no altera silenciosamente routing existente', () => {
				const res = prepareClassificationChange(
					admin,
					n2Ticket,
					{ categoryId: 'equipment', reason: 'Error de catalogación' },
					{ levels: levelsWithN4, teams, categories: initialCategories }
				);
				assert.ok(res);
				assert.equal(res.incident.categoryId, 'equipment');
				assert.equal(res.incident.supportLevel, 'N2'); // Preserves existing N2, does not silently change to N1!
				assert.equal(res.incident.teamId, teams[1].id); // Preserves existing team!
			});

			await st.test('27. snapshots correctos', () => {
				const res = prepareClassificationChange(
					admin,
					n2Ticket,
					{ categoryId: 'equipment', reason: 'Ajuste de categoría' },
					{ levels: levelsWithN4, teams, categories: initialCategories }
				);
				assert.ok(res);
				assert.equal(res.event.eventType, 'category_changed');
				assert.equal(res.event.previousValue, 'network');
				assert.equal(res.event.newValue, 'equipment');
			});

			await st.test('28. no eventos duplicados', () => {
				const res = prepareClassificationChange(
					admin,
					n2Ticket,
					{
						categoryId: 'equipment',
						supportLevel: 'N3',
						teamId: teams[0].id,
						reason: 'Reclasificación completa'
					},
					{ levels: levelsWithN4, teams, categories: initialCategories }
				);
				assert.ok(res);
				// A single consolidated event is returned
				assert.equal(res.event.eventType, 'escalated');
				assert.equal(res.incident.categoryId, 'equipment');
				assert.equal(res.incident.supportLevel, 'N3');
				assert.equal(res.incident.teamId, teams[0].id);
			});
		});

		// ==========================================
		// F. UI / compatibilidad (29 - 32)
		// ==========================================
		await t.test('F. UI y compatibilidad', async (st) => {
			await st.test(
				'29. AssignmentDialog ya no permite cambiar routing accidentalmente',
				async () => {
					const dialogContent = fs.readFileSync(
						'src/lib/components/AssignmentDialog.svelte',
						'utf8'
					);
					assert.equal(dialogContent.includes('id="assignment-level"'), false);
					assert.equal(dialogContent.includes('id="assignment-team"'), false);
					assert.equal(dialogContent.includes('id="assignment-assignee"'), true);
					assert.equal(dialogContent.includes('Clasificación actual:'), true);
				}
			);

			await st.test('30. responsables incompatibles no pueden confirmarse', () => {
				assert.equal(isCandidateLevelCompatible(techN1, n2Ticket, levelsWithN4), false);
				assert.throws(
					() =>
						prepareAssignment(admin, n2Ticket, allUsers, techN1.id, '', '', {
							levels: levelsWithN4,
							teams
						}),
					/nivel requerido/
				);
			});

			await st.test('31. columnas Categoría y Nivel están integradas', () => {
				const pageContent = fs.readFileSync('src/routes/app/+page.svelte', 'utf8');
				assert.ok(
					pageContent.includes('<th scope="col" class="px-6 py-4 font-medium">Categoría</th>')
				);
				assert.ok(pageContent.includes('<th scope="col" class="px-6 py-4 font-medium">Nivel</th>'));
				assert.ok(pageContent.includes('td class="incident-category'));
				assert.ok(pageContent.includes('td class="incident-level'));
			});

			await st.test('32. datos legacy siguen cargando', () => {
				const legacyIncident = {
					id: 999,
					title: 'Incidencia Antigua',
					client: 'Cliente Antiguo',
					status: 'open',
					priority: 'low',
					createdAt: '2026-08-01'
				};
				// No supportLevel, no teamId, no categoryId
				assert.equal(shouldInheritInitialRouting(legacyIncident), true);
				assert.equal(isCandidateLevelCompatible(techN1, legacyIncident, levels), true);
			});
		});

		// ==========================================
		// G. Advertencia de incompatibilidad operativa (33 - 42)
		// ==========================================
		await t.test('G. Advertencia de incompatibilidad operativa', async (st) => {
			const ticketN3WithTechN1 = {
				id: 201,
				organizationId: orgId,
				title: 'Incidencia N3',
				client: 'Cliente',
				status: 'open',
				priority: 'high',
				createdAt: '2026-09-12T10:00:00.000Z',
				supportLevel: 'N3',
				teamId: teams[0].id,
				assignedToUserId: techN1.id
			};

			await st.test('33. responsable N1 + incidencia N3 -> incompatible', () => {
				const incomp = getAssigneeLevelIncompatibility(ticketN3WithTechN1, techN1, levelsWithN4);
				assert.ok(incomp);
				assert.equal(incomp.incompatible, true);
				assert.equal(incomp.assigneeName, techN1.name);
				assert.equal(incomp.assigneeLevel, 'N1');
				assert.equal(incomp.requiredLevel, 'N3');
				assert.match(incomp.message, /tiene nivel N1 y esta incidencia requiere N3/);
				assert.match(incomp.message, /Reasigna la incidencia a un responsable compatible/);
			});

			await st.test('34. responsable N3 + incidencia N3 -> compatible', () => {
				const incomp = getAssigneeLevelIncompatibility(ticketN3WithTechN1, techN3, levelsWithN4);
				assert.equal(incomp, null);
			});

			await st.test('35. responsable N4 + incidencia N3 -> compatible', () => {
				const incomp = getAssigneeLevelIncompatibility(ticketN3WithTechN1, techN4, levelsWithN4);
				assert.equal(incomp, null);
			});

			await st.test('36. responsable sin nivel + incidencia N3 -> incompatible', () => {
				const techNoLevel = {
					...techN1,
					id: 'usr-no-lvl',
					name: 'Técnico Sin Nivel',
					supportLevel: undefined
				};
				const incomp = getAssigneeLevelIncompatibility(
					ticketN3WithTechN1,
					techNoLevel,
					levelsWithN4
				);
				assert.ok(incomp);
				assert.equal(incomp.incompatible, true);
				assert.equal(incomp.assigneeLevel, undefined);
				assert.match(
					incomp.message,
					/no tiene nivel de soporte configurado y esta incidencia requiere N3/
				);
				assert.match(incomp.message, /Reasigna la incidencia a un responsable compatible/);
			});

			await st.test('37. incidencia sin nivel -> compatible / sin advertencia', () => {
				const ticketNoLevel = {
					...ticketN3WithTechN1,
					supportLevel: undefined
				};
				const incomp = getAssigneeLevelIncompatibility(ticketNoLevel, techN1, levelsWithN4);
				assert.equal(incomp, null);
			});

			await st.test('38. sin responsable -> sin advertencia', () => {
				const ticketUnassigned = {
					...ticketN3WithTechN1,
					assignedToUserId: undefined
				};
				const incomp = getAssigneeLevelIncompatibility(ticketUnassigned, null, levelsWithN4);
				assert.equal(incomp, null);
			});

			await st.test(
				'39. reclasificación N1->N3 mantiene responsable N1 y activa incompatibilidad',
				() => {
					const ticketN1Assigned = {
						id: 202,
						organizationId: orgId,
						title: 'Ticket en N1',
						client: 'Cliente',
						status: 'open',
						priority: 'low',
						createdAt: '2026-09-12T10:00:00.000Z',
						supportLevel: 'N1',
						teamId: teams[0].id,
						assignedToUserId: techN1.id
					};

					// Inicialmente compatible
					assert.equal(
						getAssigneeLevelIncompatibility(ticketN1Assigned, techN1, levelsWithN4),
						null
					);

					// Reclasificar a N3
					const res = prepareClassificationChange(
						admin,
						ticketN1Assigned,
						{
							supportLevel: 'N3',
							reason: 'Complejidad elevada que requiere escalado operativo'
						},
						{ levels: levelsWithN4, teams }
					);
					assert.ok(res);
					assert.equal(res.incident.assignedToUserId, techN1.id); // Responsable se mantiene!
					assert.equal(res.incident.supportLevel, 'N3');
					assert.equal(res.event.eventType, 'escalated');

					// Ahora la condición de incompatibilidad pasa a true
					const incomp = getAssigneeLevelIncompatibility(res.incident, techN1, levelsWithN4);
					assert.ok(incomp);
					assert.equal(incomp.incompatible, true);
					assert.match(incomp.message, /tiene nivel N1 y esta incidencia requiere N3/);
				}
			);

			await st.test('40. desescalado N3->N1 con responsable N1 elimina la incompatibilidad', () => {
				// Partiendo del ticket N3 asignado a Andrés N1
				const res = prepareClassificationChange(
					admin,
					ticketN3WithTechN1,
					{
						supportLevel: 'N1',
						reason: 'Falsa alarma, puede resolverlo N1'
					},
					{ levels: levelsWithN4, teams }
				);
				assert.ok(res);
				assert.equal(res.incident.supportLevel, 'N1');
				assert.equal(res.incident.assignedToUserId, techN1.id);

				// Incompatibilidad eliminada
				const incomp = getAssigneeLevelIncompatibility(res.incident, techN1, levelsWithN4);
				assert.equal(incomp, null);
			});

			await st.test('41. reasignación posterior a N3/N4 elimina la incompatibilidad', () => {
				// Partiendo del ticket N3 asignado a Andrés N1, reasignamos a techN4
				const res = prepareAssignment(
					admin,
					ticketN3WithTechN1,
					allUsers,
					techN4.id,
					'Traspaso a especialista',
					'Nivel adecuado',
					{ levels: levelsWithN4, teams }
				);
				assert.ok(res);
				assert.equal(res.incident.assignedToUserId, techN4.id);
				assert.equal(res.incident.supportLevel, 'N3');

				// Incompatibilidad eliminada
				const incomp = getAssigneeLevelIncompatibility(res.incident, techN4, levelsWithN4);
				assert.equal(incomp, null);
			});

			await st.test('42. UI de advertencia integrada en +page.svelte y theme.css', () => {
				const pageSrc = fs.readFileSync('src/routes/app/+page.svelte', 'utf8');
				assert.ok(pageSrc.includes('incompatibility-warning'));
				assert.ok(pageSrc.includes('Responsable por debajo del nivel requerido'));
				assert.ok(pageSrc.includes('btn-reassign-emphasis'));

				const themeSrc = fs.readFileSync('src/routes/app/theme.css', 'utf8');
				assert.ok(themeSrc.includes('.incompatibility-warning'));
				assert.ok(themeSrc.includes('.btn-reassign-emphasis'));
			});
		});
	} finally {
		await server.close();
	}
});

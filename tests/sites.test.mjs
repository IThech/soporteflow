import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createServer } from 'vite';

test('SoporteFlow — Fase D.1: Sedes y ubicaciones V1', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const { demoSites } = await server.ssrLoadModule('/src/lib/data/sites.ts');
		const { demoOrganization } = await server.ssrLoadModule('/src/lib/data/organizations.ts');
		const { demoUsers } = await server.ssrLoadModule('/src/lib/data/users.ts');
		const {
			isSite,
			isSiteList,
			loadSitesResult,
			saveSites,
			getOrganizationSites,
			countSiteReferences,
			createSite,
			updateSite,
			toggleSiteActive,
			SITES_STORAGE_KEY
		} = await server.ssrLoadModule('/src/lib/sites/catalog.ts');
		const { createUser, updateUser } = await server.ssrLoadModule('/src/lib/users/catalog.ts');
		const { changeIncidentSite, validateIncidentSite } = await server.ssrLoadModule(
			'/src/lib/sites/incident-site.ts'
		);
		const { validateAndBuildV2Incident } = await server.ssrLoadModule(
			'/src/lib/incidents/lifecycle.ts'
		);
		const { isIncidentHistory } = await server.ssrLoadModule('/src/lib/incidents/history.ts');
		const { describeHistoryEvent } = await server.ssrLoadModule('/src/lib/incidents/timeline.ts');
		const { isIncidentList } = await server.ssrLoadModule('/src/lib/incidents/validation.ts');

		const orgAdmin = demoUsers.find((u) => u.role === 'organization_admin' && u.active);
		const technician = demoUsers.find((u) => u.role === 'technician' && u.active);
		const client = demoUsers.find((u) => u.role === 'client' && u.active);

		assert.ok(orgAdmin, 'Debe existir un organization_admin activo');
		assert.ok(technician, 'Debe existir un technician activo');
		assert.ok(client, 'Debe existir un client activo');

		await t.test('1. Modelo Site y semillas iniciales (demoSites)', () => {
			assert.ok(Array.isArray(demoSites), 'demoSites debe ser un array');
			assert.ok(demoSites.length >= 3, 'demoSites debe contener al menos 3 sedes');

			for (const site of demoSites) {
				assert.ok(isSite(site), `El objeto sede ${site.id} debe ser válido según isSite`);
				assert.equal(
					site.organizationId,
					demoOrganization.id,
					'Las semillas deben pertenecer a Nodhouses'
				);
				assert.equal(site.active, true, 'Las semillas deben estar activas inicialmente');
				assert.ok(site.name.trim().length > 0, 'La sede debe tener un nombre no vacío');
				assert.ok(site.createdAt, 'La sede debe tener fecha de creación');
			}

			const central = demoSites.find((s) => s.id === 'site-nodhouses-central');
			const valencia = demoSites.find((s) => s.id === 'site-nodhouses-valencia');
			const barcelona = demoSites.find((s) => s.id === 'site-nodhouses-barcelona');

			assert.ok(central, 'Debe existir la sede Central');
			assert.ok(valencia, 'Debe existir la sede Valencia');
			assert.ok(barcelona, 'Debe existir la sede Barcelona');

			assert.equal(
				getOrganizationSites(demoSites, demoOrganization.id).length,
				demoSites.length,
				'getOrganizationSites debe filtrar las sedes de la organización'
			);
			assert.equal(
				getOrganizationSites(demoSites, 'org-non-existent').length,
				0,
				'getOrganizationSites no debe devolver sedes de otra organización'
			);
		});

		await t.test('2. Validación y persistencia de Sedes (catalog.ts)', () => {
			// Validación de listas
			assert.equal(isSiteList(demoSites), true, 'demoSites debe ser una lista válida');
			assert.equal(isSiteList(null), false, 'null no es una lista válida');
			assert.equal(isSiteList([{ id: 123 }]), false, 'Lista con objetos corruptos no es válida');

			// Carga con almacenamiento vacío -> missing (con semillas)
			const missingResult = loadSitesResult(null);
			assert.equal(missingResult.status, 'missing');
			assert.equal(missingResult.seededSites.length, demoSites.length);

			// Carga con datos válidos
			const validJson = JSON.stringify(demoSites);
			const validResult = loadSitesResult(validJson);
			assert.equal(validResult.status, 'valid');
			assert.equal(validResult.sites.length, demoSites.length);

			// Carga con datos corruptos
			const corruptResult = loadSitesResult('{ invalid json');
			assert.equal(corruptResult.status, 'corrupt');
			assert.ok(corruptResult.error.length > 0);

			// Guardado
			const mockStorage = {
				store: {},
				setItem(k, v) {
					this.store[k] = v;
				},
				getItem(k) {
					return this.store[k] ?? null;
				}
			};
			saveSites(mockStorage, demoSites);
			assert.equal(mockStorage.getItem(SITES_STORAGE_KEY), validJson);
		});

		await t.test('3. Operaciones CRUD y reglas de negocio de Sedes', () => {
			let currentSites = [...demoSites];

			// Solo usuarios con organization:manage pueden crear
			assert.throws(
				() =>
					createSite(technician, currentSites, {
						organizationId: demoOrganization.id,
						name: 'Sede Sevilla',
						active: true
					}),
				/permisos/
			);

			// Crear sede con nombre válido
			currentSites = createSite(orgAdmin, currentSites, {
				organizationId: demoOrganization.id,
				name: 'Sede Sevilla',
				description: 'Nueva delegación sur',
				active: true
			});

			const created = currentSites.find((s) => s.name === 'Sede Sevilla');
			assert.ok(created, 'La nueva sede debe existir en la lista');
			assert.equal(created.description, 'Nueva delegación sur');
			assert.equal(created.active, true);

			// Intento de duplicar nombre en la misma organización (case-insensitive / trimmed)
			assert.throws(
				() =>
					createSite(orgAdmin, currentSites, {
						organizationId: demoOrganization.id,
						name: '  sede sevilla  ',
						active: true
					}),
				/Ya existe una sede con el nombre/
			);

			// Nombre duplicado en otra organización está permitido
			const platformAdmin = {
				id: 'user-platform-admin',
				organizationId: 'org-acme',
				name: 'Super Admin',
				role: 'platform_admin',
				active: true
			};
			const otherOrgSites = createSite(platformAdmin, currentSites, {
				organizationId: 'org-other-corp',
				name: 'Sede Sevilla',
				active: true
			});
			assert.ok(
				otherOrgSites.some(
					(s) => s.organizationId === 'org-other-corp' && s.name === 'Sede Sevilla'
				)
			);

			// Actualizar sede
			currentSites = updateSite(orgAdmin, currentSites, {
				id: created.id,
				name: 'Sede Sevilla Centro',
				description: 'Actualizada',
				active: true
			});
			const updated = currentSites.find((s) => s.id === created.id);
			assert.equal(updated?.name, 'Sede Sevilla Centro');
			assert.equal(updated?.description, 'Actualizada');

			// Desactivar sede
			currentSites = toggleSiteActive(orgAdmin, currentSites, created.id);
			const deactivated = currentSites.find((s) => s.id === created.id);
			assert.equal(deactivated?.active, false, 'La sede debe quedar inactiva');

			// Reactivar sede
			currentSites = toggleSiteActive(orgAdmin, currentSites, created.id);
			const reactivated = currentSites.find((s) => s.id === created.id);
			assert.equal(reactivated?.active, true, 'La sede debe quedar activa nuevamente');
		});

		await t.test('4. Conteo de referencias y advertencia de desactivación', () => {
			const mockUsers = [
				{
					id: 'user-tech-1',
					organizationId: demoOrganization.id,
					name: 'Tech Uno',
					email: 'tech1@nodhouses.com',
					role: 'technician',
					active: true,
					siteIds: ['site-nodhouses-central']
				},
				{
					id: 'user-tech-2',
					organizationId: demoOrganization.id,
					name: 'Tech Dos',
					email: 'tech2@nodhouses.com',
					role: 'technician',
					active: true,
					siteIds: ['site-nodhouses-valencia']
				}
			];

			const mockIncidents = [
				{
					id: 101,
					organizationId: demoOrganization.id,
					title: 'Incidencia 1',
					client: 'Cliente A',
					status: 'open',
					priority: 'medium',
					createdAt: '2026-09-10T10:00:00Z',
					siteId: 'site-nodhouses-central'
				},
				{
					id: 102,
					organizationId: demoOrganization.id,
					title: 'Incidencia 2 (cerrada)',
					client: 'Cliente B',
					status: 'closed',
					priority: 'low',
					createdAt: '2026-09-10T10:00:00Z',
					siteId: 'site-nodhouses-central'
				},
				{
					id: 103,
					organizationId: demoOrganization.id,
					title: 'Incidencia 3',
					client: 'Cliente C',
					status: 'pending',
					priority: 'high',
					createdAt: '2026-09-10T10:00:00Z',
					siteId: 'site-nodhouses-valencia'
				}
			];

			const refsCentral = countSiteReferences(
				demoOrganization.id,
				'site-nodhouses-central',
				mockUsers,
				mockIncidents
			);
			assert.equal(refsCentral.userCount, 1, 'Tech Uno tiene asignada la sede central');
			assert.equal(
				refsCentral.activeIncidentCount,
				1,
				'Solo la incidencia abierta cuenta como activa'
			);

			const refsBarcelona = countSiteReferences(
				demoOrganization.id,
				'site-nodhouses-barcelona',
				mockUsers,
				mockIncidents
			);
			assert.equal(refsBarcelona.userCount, 0);
			assert.equal(refsBarcelona.activeIncidentCount, 0);
		});

		await t.test('5. Usuarios operativos y asignación de múltiples sedes', () => {
			const supportContext = {
				availableLevels: [],
				availableTeams: [],
				availableSites: demoSites
			};

			let users = [...demoUsers];

			// Crear técnico con múltiples sedes
			users = createUser(
				orgAdmin,
				users,
				{
					organizationId: demoOrganization.id,
					name: 'Técnico Multisede',
					email: 'multisede@nodhouses.com',
					role: 'technician',
					siteIds: ['site-nodhouses-central', 'site-nodhouses-valencia'],
					active: true
				},
				supportContext
			);

			const createdTech = users.find((u) => u.email === 'multisede@nodhouses.com');
			assert.ok(createdTech);
			assert.deepEqual(createdTech.siteIds, ['site-nodhouses-central', 'site-nodhouses-valencia']);

			// Asignar sede de otra organización debe fallar
			assert.throws(
				() =>
					createUser(
						orgAdmin,
						users,
						{
							organizationId: demoOrganization.id,
							name: 'Técnico Invalido',
							email: 'invalid@nodhouses.com',
							role: 'technician',
							siteIds: ['site-other-org'],
							active: true
						},
						{
							...supportContext,
							availableSites: [
								...demoSites,
								{
									id: 'site-other-org',
									organizationId: 'org-other',
									name: 'Otra',
									active: true,
									createdAt: '2026-09-01'
								}
							]
						}
					),
				/no son válidas|esta organización/
			);

			// Actualizar sedes del técnico
			users = updateUser(
				orgAdmin,
				users,
				{
					id: createdTech.id,
					name: createdTech.name,
					email: createdTech.email,
					role: 'technician',
					siteIds: ['site-nodhouses-barcelona'],
					active: true
				},
				supportContext
			);

			const updatedTech = users.find((u) => u.id === createdTech.id);
			assert.deepEqual(updatedTech.siteIds, ['site-nodhouses-barcelona']);

			// Los clientes no pueden tener sedes
			users = createUser(
				orgAdmin,
				users,
				{
					organizationId: demoOrganization.id,
					name: 'Cliente Sin Sedes',
					email: 'cliente@nodhouses.com',
					role: 'client',
					siteIds: ['site-nodhouses-central'],
					active: true
				},
				supportContext
			);
			const createdClient = users.find((u) => u.email === 'cliente@nodhouses.com');
			assert.equal(createdClient.siteIds, undefined, 'Cliente no debe tener siteIds');
		});

		await t.test('6. Incidencias: campo siteId y cambio explícito (changeIncidentSite)', () => {
			const baseIncident = {
				id: 50,
				organizationId: demoOrganization.id,
				title: 'Problema en puesto de trabajo',
				client: 'Cliente Demo',
				status: 'open',
				priority: 'medium',
				createdAt: '2026-09-15T09:00:00Z',
				supportLevel: 'N1',
				teamId: 'team-nodhouses-helpdesk',
				assignedToUserId: technician.id,
				siteId: 'site-nodhouses-central'
			};

			assert.equal(
				isIncidentList([baseIncident]),
				true,
				'La incidencia con siteId es válida en isIncidentList'
			);

			// Cambio de sede válido
			const result = changeIncidentSite(
				orgAdmin,
				baseIncident,
				{
					targetSiteId: 'site-nodhouses-valencia',
					reason: 'Traslado a Valencia',
					comment: 'El equipo se ha movido hoy.'
				},
				demoSites
			);

			assert.ok(result, 'El cambio de sede debe generar un resultado');
			assert.equal(result.incident.siteId, 'site-nodhouses-valencia');

			// PRINCIPIO FUNDAMENTAL: Sede no modifica nivel, equipo, responsable, estado ni SLA
			assert.equal(result.incident.supportLevel, 'N1', 'El supportLevel no debe cambiar');
			assert.equal(result.incident.teamId, 'team-nodhouses-helpdesk', 'El teamId no debe cambiar');
			assert.equal(
				result.incident.assignedToUserId,
				technician.id,
				'El assignedToUserId no debe cambiar'
			);
			assert.equal(result.incident.status, 'open', 'El status no debe cambiar');

			// Evento de historial generado
			assert.equal(result.event.eventType, 'site_changed');
			assert.equal(result.event.previousValue, 'site-nodhouses-central');
			assert.equal(result.event.newValue, 'site-nodhouses-valencia');
			assert.equal(result.event.reason, 'Traslado a Valencia');
			assert.equal(result.event.comment, 'El equipo se ha movido hoy.');
			assert.ok(
				isIncidentHistory([result.event]),
				'El evento debe ser válido en isIncidentHistory'
			);

			// Formateo del timeline
			const description = describeHistoryEvent(result.event, demoUsers, [], [], demoSites);
			assert.ok(
				description.includes('cambió la sede de Sede Central a Delegación Valencia'),
				`Descripción esperada en timeline: ${description}`
			);

			// Desasignar sede (pasar a null)
			const unassignResult = changeIncidentSite(
				technician,
				result.incident,
				{
					targetSiteId: null
				},
				demoSites
			);

			assert.ok(unassignResult);
			assert.equal(unassignResult.incident.siteId, null);
			assert.equal(unassignResult.event.previousValue, 'site-nodhouses-valencia');
			assert.equal(unassignResult.event.newValue, null);

			const unassignDesc = describeHistoryEvent(unassignResult.event, demoUsers, [], [], demoSites);
			assert.ok(
				unassignDesc.includes('cambió la sede de Delegación Valencia a Sin sede'),
				`Descripción esperada: ${unassignDesc}`
			);

			// No-op si se pasa la misma sede
			const noopResult = changeIncidentSite(
				technician,
				baseIncident,
				{
					targetSiteId: 'site-nodhouses-central'
				},
				demoSites
			);
			assert.equal(noopResult, null, 'Si la sede no cambia debe devolver null');

			// Intentar asignar sede inactiva debe fallar
			const inactiveSite = {
				id: 'site-inactive',
				organizationId: demoOrganization.id,
				name: 'Sede Cerrada',
				active: false,
				createdAt: '2026-09-01'
			};
			assert.throws(
				() =>
					changeIncidentSite(
						orgAdmin,
						baseIncident,
						{
							targetSiteId: 'site-inactive'
						},
						[...demoSites, inactiveSite]
					),
				/inactiva/
			);
		});

		await t.test('7. Integración UI y código de componentes de Sedes', () => {
			const siteManagementCode = readFileSync(
				'src/lib/components/settings/SiteManagement.svelte',
				'utf-8'
			);
			const changeSiteDialogCode = readFileSync(
				'src/lib/components/ChangeSiteDialog.svelte',
				'utf-8'
			);
			const settingsViewCode = readFileSync(
				'src/lib/components/settings/SettingsView.svelte',
				'utf-8'
			);
			const pageCode = readFileSync('src/routes/app/+page.svelte', 'utf-8');

			// SiteManagement
			assert.ok(
				siteManagementCode.includes('countSiteReferences'),
				'SiteManagement debe usar countSiteReferences'
			);
			assert.ok(siteManagementCode.includes('createSite'), 'SiteManagement debe usar createSite');
			assert.ok(
				siteManagementCode.includes('toggleSiteActive'),
				'SiteManagement debe usar toggleSiteActive'
			);

			// ChangeSiteDialog
			assert.ok(
				changeSiteDialogCode.includes('targetSiteId'),
				'ChangeSiteDialog debe gestionar targetSiteId'
			);
			assert.ok(
				changeSiteDialogCode.includes('Sin sede asignada'),
				'ChangeSiteDialog debe permitir desasignar sede'
			);

			// SettingsView
			assert.ok(
				settingsViewCode.includes("selectedSection === 'locations'"),
				'SettingsView debe montar SiteManagement en locations'
			);
			assert.ok(
				settingsViewCode.includes('<SiteManagement'),
				'SettingsView debe renderizar el componente SiteManagement'
			);

			// +page.svelte
			assert.ok(
				pageCode.includes('ChangeSiteDialog'),
				'+page.svelte debe incluir ChangeSiteDialog'
			);
			assert.ok(
				pageCode.includes('siteNameForIncident'),
				'+page.svelte debe formatear la sede de la incidencia'
			);
			assert.ok(
				pageCode.includes('Cambiar sede'),
				'+page.svelte debe incluir el botón de acción Cambiar sede'
			);
			assert.ok(
				pageCode.includes('newSiteId'),
				'+page.svelte debe permitir elegir sede al crear una incidencia'
			);
		});

		await t.test(
			'8. Validación de sedes al crear incidencias (dominio, lifecycle y orquestador Svelte)',
			async (st) => {
				const orgId = demoOrganization.id;
				const validSite = demoSites[0];
				const inactiveSite = {
					id: 'site-inactive-test',
					organizationId: orgId,
					name: 'Sede Inactiva',
					active: false,
					createdAt: '2026-09-01'
				};
				const foreignSite = {
					id: 'site-foreign-test',
					organizationId: 'other-org-uuid',
					name: 'Sede Otra Org',
					active: true,
					createdAt: '2026-09-01'
				};
				const testSiteCatalog = [...demoSites, inactiveSite, foreignSite];

				// 8.1 Validación pura de dominio: validateIncidentSite
				await st.test('8.1 validateIncidentSite: comprobaciones estrictas', () => {
					// Sede válida
					const resValid = validateIncidentSite(validSite.id, orgId, testSiteCatalog);
					assert.equal(resValid?.id, validSite.id);

					// Sin sede (null, undefined, whitespace, cadena vacía)
					assert.equal(validateIncidentSite(null, orgId, testSiteCatalog), null);
					assert.equal(validateIncidentSite(undefined, orgId, testSiteCatalog), null);
					assert.equal(validateIncidentSite('', orgId, testSiteCatalog), null);
					assert.equal(validateIncidentSite('   ', orgId, testSiteCatalog), null);

					// Sede inexistente
					assert.throws(
						() => validateIncidentSite('site-inexistente', orgId, testSiteCatalog),
						/La sede seleccionada no existe/
					);

					// Sede inactiva
					assert.throws(
						() => validateIncidentSite(inactiveSite.id, orgId, testSiteCatalog),
						/No se puede asignar una sede inactiva a una incidencia/
					);

					// Sede de otra organización
					assert.throws(
						() => validateIncidentSite(foreignSite.id, orgId, testSiteCatalog),
						/La sede debe pertenecer a la misma organización que la incidencia/
					);
				});

				// 8.2 Integración en validateAndBuildV2Incident
				await st.test(
					'8.2 validateAndBuildV2Incident valida sedes cuando se provee availableSites',
					async () => {
						const { createStandardPriorityMatrix } = await server.ssrLoadModule(
							'/src/lib/classification/engine.ts'
						);
						const baseV2Input = {
							id: 501,
							title: 'Problema de red',
							client: 'Cliente Test',
							description: 'Detalle de la incidencia',
							activeUser: orgAdmin,
							categoryId: 'cat-1',
							subcategoryId: 'sub-1',
							impact: 'I2',
							categoryList: [
								{ id: 'cat-1', organizationId: orgId, name: 'Sistemas', active: true }
							],
							subcategories: [
								{
									id: 'sub-1',
									organizationId: orgId,
									categoryId: 'cat-1',
									name: 'Red',
									baseCriticality: 'medium',
									minPriority: null,
									active: true
								}
							],
							priorityMatrices: [createStandardPriorityMatrix(orgId)],
							availableSites: testSiteCatalog
						};

						// Con sede válida
						const resValid = validateAndBuildV2Incident({
							...baseV2Input,
							siteId: validSite.id
						});
						assert.equal(resValid.ok, true);
						if (resValid.ok) {
							assert.equal(resValid.incident.siteId, validSite.id);
						}

						// Sin sede (siteId: null)
						const resNoSite = validateAndBuildV2Incident({
							...baseV2Input,
							siteId: null
						});
						assert.equal(resNoSite.ok, true);
						if (resNoSite.ok) {
							assert.equal(resNoSite.incident.siteId, null);
						}

						// Rechazo sede inexistente
						const resMissing = validateAndBuildV2Incident({
							...baseV2Input,
							siteId: 'site-inexistente'
						});
						assert.equal(resMissing.ok, false);
						if (!resMissing.ok) {
							assert.match(resMissing.error, /La sede seleccionada no existe/);
						}

						// Rechazo sede inactiva
						const resInactive = validateAndBuildV2Incident({
							...baseV2Input,
							siteId: inactiveSite.id
						});
						assert.equal(resInactive.ok, false);
						if (!resInactive.ok) {
							assert.match(
								resInactive.error,
								/No se puede asignar una sede inactiva a una incidencia/
							);
						}

						// Rechazo sede otra org
						const resForeign = validateAndBuildV2Incident({
							...baseV2Input,
							siteId: foreignSite.id
						});
						assert.equal(resForeign.ok, false);
						if (!resForeign.ok) {
							assert.match(
								resForeign.error,
								/La sede debe pertenecer a la misma organización que la incidencia/
							);
						}
					}
				);

				// 8.3 Orquestador Svelte (+page.svelte createIncident)
				await st.test(
					'8.3 createIncident en +page.svelte: flujo de validación, preservación de borrador y resiliencia',
					async () => {
						const pageSource = readFileSync('src/routes/app/+page.svelte', 'utf8');
						const scriptContent = pageSource.split('<script lang="ts">')[1].split('</script>')[0];
						const ast = ts.createSourceFile(
							'page.ts',
							scriptContent,
							ts.ScriptTarget.Latest,
							true,
							ts.ScriptKind.TS
						);

						const fnNode = ast.statements.find(
							(n) => ts.isFunctionDeclaration(n) && n.name?.text === 'createIncident'
						);
						assert.ok(fnNode, 'createIncident debe existir en +page.svelte');

						const harnessCode = ts.transpileModule(
							`
					const {
						checkIncidentCreationSla,
						canAccessRecord,
						isImpactLevel,
						resolveOrganizationMatrix,
						classifyIncident,
						toIncidentPriority,
						loadMessages,
						MESSAGES_KEY,
						resolveCategoryRouting,
						applyCreationSla,
						isIncidentList,
						buildCreatedHistoryEntry,
						commitAssignment,
						validateIncidentSite,
						FIRST_RESPONSE_RECOVERY_KEY,
						canAccessOrganization,
						hasPermission,
						demoOrganization
					} = deps;

					let incidentLoadError = '';
					let assignmentReady = true;
					const activeUser = seed.actor;
					let title = seed.title ?? '';
					let client = seed.client ?? '';
					let description = seed.description ?? '';
					let newCategoryId = seed.categoryId ?? '';
					let newSubcategoryId = seed.subcategoryId ?? '';
					let newImpact = seed.impact ?? '';
					let newSiteId = seed.siteId ?? '';
					let isFormOpen = true;

					const categoryList = seed.categories;
					const subcategoriesReady = true;
					const subcategoriesState = { status: 'valid', subcategories: seed.subcategories };
					const subcategoriesError = '';
					const priorityMatricesReady = true;
					const priorityMatricesState = { status: 'valid', matrices: seed.matrices };
					const priorityMatricesError = '';
					const slaCatalogState = seed.slaCatalogState;

					let siteList = seed.siteList;
					let sitesLoaded = seed.sitesLoaded ?? true;
					let siteLoadError = seed.siteLoadError ?? '';

					let incidentList = seed.incidents;
					let history = seed.history;
					let storedIncidentSnapshot = seed.incidentRaw;
					let storedHistorySnapshot = seed.historyRaw;

					const localStorage = seed.storage;
					const alerts = [];
					const window = {
						alert: (msg) => alerts.push(msg)
					};

					${fnNode.getText(ast)}

					return {
						submit: () => createIncident({ preventDefault: () => {} }),
						getState: () => ({
							incidentList,
							history,
							storedIncidentSnapshot,
							title,
							client,
							description,
							newCategoryId,
							newSubcategoryId,
							newImpact,
							newSiteId,
							isFormOpen,
							alerts
						})
					};
					`,
							{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
						).outputText;

						const factory = new Function('deps', 'seed', harnessCode);

						const { checkIncidentCreationSla } = await server.ssrLoadModule(
							'/src/lib/incidents/sla-catalog.ts'
						);
						const { canAccessRecord } = await server.ssrLoadModule(
							'/src/lib/auth/record-access.ts'
						);
						const { canAccessOrganization, hasPermission } = await server.ssrLoadModule(
							'/src/lib/auth/permissions.ts'
						);
						const {
							isImpactLevel,
							toIncidentPriority,
							classifyIncident,
							createStandardPriorityMatrix
						} = await server.ssrLoadModule('/src/lib/classification/engine.ts');
						const { resolveOrganizationMatrix } = await server.ssrLoadModule(
							'/src/lib/classification/matrix-catalog.ts'
						);
						const { loadMessages, MESSAGES_KEY } = await server.ssrLoadModule(
							'/src/lib/storage/messages.ts'
						);
						const { resolveCategoryRouting } = await server.ssrLoadModule(
							'/src/lib/categories/catalog.ts'
						);
						const { applyCreationSla, buildCreatedHistoryEntry } = await server.ssrLoadModule(
							'/src/lib/incidents/lifecycle.ts'
						);
						const { commitAssignment, INCIDENTS_KEY, HISTORY_KEY } = await server.ssrLoadModule(
							'/src/lib/storage/assignment.ts'
						);
						const { FIRST_RESPONSE_RECOVERY_KEY } = await server.ssrLoadModule(
							'/src/lib/storage/first-response.ts'
						);

						const deps = {
							checkIncidentCreationSla,
							canAccessRecord,
							isImpactLevel,
							resolveOrganizationMatrix,
							classifyIncident,
							toIncidentPriority,
							loadMessages,
							MESSAGES_KEY,
							resolveCategoryRouting,
							applyCreationSla,
							isIncidentList,
							buildCreatedHistoryEntry,
							commitAssignment,
							validateIncidentSite,
							FIRST_RESPONSE_RECOVERY_KEY,
							canAccessOrganization,
							hasPermission,
							demoOrganization
						};

						const defaultCategories = [
							{ id: 'cat-1', organizationId: orgId, name: 'Sistemas', active: true }
						];
						const defaultSubcategories = [
							{
								id: 'sub-1',
								organizationId: orgId,
								categoryId: 'cat-1',
								name: 'Red',
								baseCriticality: 'medium',
								minPriority: null,
								active: true
							}
						];
						const defaultMatrices = [createStandardPriorityMatrix(orgId)];
						const defaultSlaState = { status: 'valid', policies: [] };

						const makeStore = (initial = {}) => {
							const m = new Map(Object.entries(initial));
							return {
								getItem: (k) => m.get(k) ?? null,
								setItem: (k, v) => m.set(k, String(v)),
								removeItem: (k) => m.delete(k)
							};
						};

						// Caso 1: Creación con sede válida
						{
							const store = makeStore({
								[INCIDENTS_KEY]: '[]',
								[HISTORY_KEY]: '[]',
								[MESSAGES_KEY]: '[]'
							});
							const h = factory(deps, {
								actor: orgAdmin,
								title: 'Fallo fibra óptica',
								client: 'Nodhouses Corp',
								description: 'Corte de cable en CPD',
								categoryId: 'cat-1',
								subcategoryId: 'sub-1',
								impact: 'I3',
								siteId: validSite.id,
								categories: defaultCategories,
								subcategories: defaultSubcategories,
								matrices: defaultMatrices,
								slaCatalogState: defaultSlaState,
								siteList: testSiteCatalog,
								sitesLoaded: true,
								incidents: [],
								history: [],
								incidentRaw: '[]',
								historyRaw: '[]',
								storage: store
							});

							h.submit();
							const s = h.getState();
							assert.equal(s.alerts.length, 0);
							assert.equal(s.incidentList.length, 1);
							assert.equal(s.incidentList[0].siteId, validSite.id);
							assert.equal(s.title, ''); // reset
							assert.equal(s.newSiteId, ''); // reset
							assert.equal(s.isFormOpen, false);
						}

						// Caso 2: Creación sin sede ("Sin sede asignada")
						{
							const store = makeStore({
								[INCIDENTS_KEY]: '[]',
								[HISTORY_KEY]: '[]',
								[MESSAGES_KEY]: '[]'
							});
							const h = factory(deps, {
								actor: orgAdmin,
								title: 'Consulta licencia software',
								client: 'Nodhouses Corp',
								description: 'Duda teletrabajo',
								categoryId: 'cat-1',
								subcategoryId: 'sub-1',
								impact: 'I1',
								siteId: '',
								categories: defaultCategories,
								subcategories: defaultSubcategories,
								matrices: defaultMatrices,
								slaCatalogState: defaultSlaState,
								siteList: testSiteCatalog,
								sitesLoaded: true,
								incidents: [],
								history: [],
								incidentRaw: '[]',
								historyRaw: '[]',
								storage: store
							});

							h.submit();
							const s = h.getState();
							assert.equal(s.alerts.length, 0);
							assert.equal(s.incidentList.length, 1);
							assert.equal(s.incidentList[0].siteId, null);
							assert.equal(s.title, '');
						}

						// Caso 3: Rechazo de sede inexistente y conservación de borrador
						{
							const store = makeStore({
								[INCIDENTS_KEY]: '[]',
								[HISTORY_KEY]: '[]',
								[MESSAGES_KEY]: '[]'
							});
							const h = factory(deps, {
								actor: orgAdmin,
								title: 'Borrador importante',
								client: 'Nodhouses Corp',
								description: 'Descripción no debe perderse',
								categoryId: 'cat-1',
								subcategoryId: 'sub-1',
								impact: 'I2',
								siteId: 'site-inexistente',
								categories: defaultCategories,
								subcategories: defaultSubcategories,
								matrices: defaultMatrices,
								slaCatalogState: defaultSlaState,
								siteList: testSiteCatalog,
								sitesLoaded: true,
								incidents: [],
								history: [],
								incidentRaw: '[]',
								historyRaw: '[]',
								storage: store
							});

							h.submit();
							const s = h.getState();
							assert.equal(s.alerts.length, 1);
							assert.match(s.alerts[0], /La sede seleccionada no existe/);
							assert.equal(s.incidentList.length, 0, 'No debe crear la incidencia');
							assert.equal(s.title, 'Borrador importante', 'Borrador de título conservado');
							assert.equal(s.description, 'Descripción no debe perderse', 'Borrador conservado');
							assert.equal(s.newSiteId, 'site-inexistente', 'Sede conservada');
						}

						// Caso 4: Rechazo de sede inactiva
						{
							const store = makeStore({
								[INCIDENTS_KEY]: '[]',
								[HISTORY_KEY]: '[]',
								[MESSAGES_KEY]: '[]'
							});
							const h = factory(deps, {
								actor: orgAdmin,
								title: 'Ticket en sede cerrada',
								client: 'Nodhouses Corp',
								description: 'Intento en sede inactiva',
								categoryId: 'cat-1',
								subcategoryId: 'sub-1',
								impact: 'I2',
								siteId: inactiveSite.id,
								categories: defaultCategories,
								subcategories: defaultSubcategories,
								matrices: defaultMatrices,
								slaCatalogState: defaultSlaState,
								siteList: testSiteCatalog,
								sitesLoaded: true,
								incidents: [],
								history: [],
								incidentRaw: '[]',
								historyRaw: '[]',
								storage: store
							});

							h.submit();
							const s = h.getState();
							assert.equal(s.alerts.length, 1);
							assert.match(s.alerts[0], /No se puede asignar una sede inactiva/);
							assert.equal(s.incidentList.length, 0);
							assert.equal(s.title, 'Ticket en sede cerrada');
						}

						// Caso 5: Rechazo de sede de otra organización
						{
							const store = makeStore({
								[INCIDENTS_KEY]: '[]',
								[HISTORY_KEY]: '[]',
								[MESSAGES_KEY]: '[]'
							});
							const h = factory(deps, {
								actor: orgAdmin,
								title: 'Ticket cross tenant',
								client: 'Nodhouses Corp',
								description: 'Intento de infiltración',
								categoryId: 'cat-1',
								subcategoryId: 'sub-1',
								impact: 'I2',
								siteId: foreignSite.id,
								categories: defaultCategories,
								subcategories: defaultSubcategories,
								matrices: defaultMatrices,
								slaCatalogState: defaultSlaState,
								siteList: testSiteCatalog,
								sitesLoaded: true,
								incidents: [],
								history: [],
								incidentRaw: '[]',
								historyRaw: '[]',
								storage: store
							});

							h.submit();
							const s = h.getState();
							assert.equal(s.alerts.length, 1);
							assert.match(s.alerts[0], /La sede debe pertenecer a la misma organización/);
							assert.equal(s.incidentList.length, 0);
						}

						// Caso 6: Catálogo corrupto bloquea cuando se selecciona sede, pero permite si es sin sede
						{
							const store = makeStore({
								[INCIDENTS_KEY]: '[]',
								[HISTORY_KEY]: '[]',
								[MESSAGES_KEY]: '[]'
							});
							// 6A: con sede y catálogo corrupto -> bloquea
							const hCorruptWithSite = factory(deps, {
								actor: orgAdmin,
								title: 'Ticket sede con catálogo roto',
								client: 'Nodhouses Corp',
								description: 'Detalle',
								categoryId: 'cat-1',
								subcategoryId: 'sub-1',
								impact: 'I2',
								siteId: validSite.id,
								categories: defaultCategories,
								subcategories: defaultSubcategories,
								matrices: defaultMatrices,
								slaCatalogState: defaultSlaState,
								siteList: testSiteCatalog,
								sitesLoaded: true,
								siteLoadError: 'Catálogo de sedes corrupto en storage',
								incidents: [],
								history: [],
								incidentRaw: '[]',
								historyRaw: '[]',
								storage: store
							});

							hCorruptWithSite.submit();
							const s1 = hCorruptWithSite.getState();
							assert.equal(s1.alerts.length, 1);
							assert.match(s1.alerts[0], /Catálogo de sedes corrupto en storage/);
							assert.equal(s1.incidentList.length, 0);
							assert.equal(s1.title, 'Ticket sede con catálogo roto');

							// 6B: sin sede y catálogo corrupto -> permite crear
							const hCorruptNoSite = factory(deps, {
								actor: orgAdmin,
								title: 'Ticket sin sede con catálogo roto',
								client: 'Nodhouses Corp',
								description: 'Detalle',
								categoryId: 'cat-1',
								subcategoryId: 'sub-1',
								impact: 'I2',
								siteId: '',
								categories: defaultCategories,
								subcategories: defaultSubcategories,
								matrices: defaultMatrices,
								slaCatalogState: defaultSlaState,
								siteList: testSiteCatalog,
								sitesLoaded: true,
								siteLoadError: 'Catálogo de sedes corrupto en storage',
								incidents: [],
								history: [],
								incidentRaw: '[]',
								historyRaw: '[]',
								storage: store
							});

							hCorruptNoSite.submit();
							const s2 = hCorruptNoSite.getState();
							assert.equal(s2.alerts.length, 0);
							assert.equal(s2.incidentList.length, 1);
							assert.equal(s2.incidentList[0].siteId, null);
						}

						// Caso 7: Bloqueo ante diario de primera respuesta pendiente
						{
							const store = makeStore({
								[INCIDENTS_KEY]: '[]',
								[HISTORY_KEY]: '[]',
								[MESSAGES_KEY]: '[]',
								[FIRST_RESPONSE_RECOVERY_KEY]: '{"version":1}'
							});
							const h = factory(deps, {
								actor: orgAdmin,
								title: 'Ticket con primera respuesta pendiente',
								client: 'Nodhouses Corp',
								description: 'Detalle',
								categoryId: 'cat-1',
								subcategoryId: 'sub-1',
								impact: 'I2',
								siteId: validSite.id,
								categories: defaultCategories,
								subcategories: defaultSubcategories,
								matrices: defaultMatrices,
								slaCatalogState: defaultSlaState,
								siteList: testSiteCatalog,
								sitesLoaded: true,
								incidents: [],
								history: [],
								incidentRaw: '[]',
								historyRaw: '[]',
								storage: store
							});

							h.submit();
							const s = h.getState();
							assert.equal(s.alerts.length, 1);
							assert.match(s.alerts[0], /Hay una primera respuesta pendiente de recuperación/);
							assert.equal(s.incidentList.length, 0);
							assert.equal(s.title, 'Ticket con primera respuesta pendiente');
						}
					}
				);
			}
		);
	} finally {
		await server.close();
	}
});

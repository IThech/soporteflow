import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations } from './helpers/persistence-migrations.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function matchesError(err, expectedSubstring) {
	const fullMsg = `${err.message} ${err.cause?.message || ''} ${String(err.cause || '')}`;
	return fullMsg.includes(expectedSubstring);
}

test('SoporteFlow Core v1 — Infraestructura Relacional e Integridad Multiempresa', async (t) => {
	const server = await createServer({
		configFile: false,
		envDir: false,
		server: { middlewareMode: true },
		appType: 'custom'
	});
	t.after(() => server.close());
	const schema = await server.ssrLoadModule('/src/lib/server/db/schema/index.ts');
	const pglite = new PGlite();
	t.after(() => pglite.close());
	await applyMigrations(pglite, path.join(rootDir, 'drizzle/migrations'));
	const db = drizzle(pglite, { schema });

	// Helper data fixtures
	const org1Id = '11111111-1111-4111-8111-111111111111';
	const org2Id = '22222222-2222-4222-8222-222222222222';
	const user1Id = '33333333-3333-4333-8333-333333333333';
	const user2Id = '44444444-4444-4444-8444-444444444444';

	await t.test(
		'1. Desacoplamiento de identidad en users y gestión de correos en user_emails',
		async () => {
			// Insert user without email column
			const [user] = await db
				.insert(schema.users)
				.values({
					id: user1Id,
					name: 'Andrés Fontenla',
					displayName: 'Andrés'
				})
				.returning();

			assert.equal(user.id, user1Id);
			assert.equal(user.name, 'Andrés Fontenla');
			assert.equal(user.active, true);
			assert.equal(user.displayName, 'Andrés');

			// Insert primary email
			const [email1] = await db
				.insert(schema.userEmails)
				.values({
					userId: user1Id,
					email: 'andres@nodhouses.test',
					isPrimary: true
				})
				.returning();
			assert.equal(email1.email, 'andres@nodhouses.test');
			assert.equal(email1.isPrimary, true);

			// Insert secondary email for same user -> succeeds
			const [email2] = await db
				.insert(schema.userEmails)
				.values({
					userId: user1Id,
					email: 'andres.backup@nodhouses.test',
					isPrimary: false
				})
				.returning();
			assert.equal(email2.isPrimary, false);

			// Attempt to insert second primary email for same user -> must fail partial unique index
			await assert.rejects(
				async () => {
					await db.insert(schema.userEmails).values({
						userId: user1Id,
						email: 'andres.secondary@nodhouses.test',
						isPrimary: true
					});
				},
				(err) => matchesError(err, 'user_emails_user_primary_unique_idx')
			);

			// Attempt to register same email under another user -> must fail global case-insensitive email unique index
			await db.insert(schema.users).values({ id: user2Id, name: 'Clara Soto' });
			await assert.rejects(
				async () => {
					await db.insert(schema.userEmails).values({
						userId: user2Id,
						email: 'andres@nodhouses.test',
						isPrimary: true
					});
				},
				(err) => matchesError(err, 'user_emails_email_lower_unique_idx')
			);

			// Unicidad insensible a mayúsculas y minúsculas: andres@empresa.com y Andres@empresa.com no pueden coexistir
			const user3Id = '33333333-3333-4333-8333-333333333334';
			await db.insert(schema.users).values({ id: user3Id, name: 'Tercer Usuario' });
			await db.insert(schema.userEmails).values({
				userId: user3Id,
				email: 'andres@empresa.com',
				isPrimary: true
			});

			const user4Id = '44444444-4444-4444-8444-444444444445';
			await db.insert(schema.users).values({ id: user4Id, name: 'Cuarto Usuario' });
			await assert.rejects(
				async () => {
					await db.insert(schema.userEmails).values({
						userId: user4Id,
						email: 'Andres@empresa.com',
						isPrimary: true
					});
				},
				(err) => matchesError(err, 'user_emails_email_lower_unique_idx')
			);
		}
	);

	await t.test('2. Unicidad de pertenencias (memberships) por organización', async () => {
		await db.insert(schema.organizations).values([
			{ id: org1Id, name: 'Nodhouses Corp', slug: 'nodhouses', status: 'active' },
			{ id: org2Id, name: 'IV Pediatría', slug: 'iv-pediatria', status: 'trial' }
		]);

		// User 1 joins Org 1 -> succeeds
		const [m1] = await db
			.insert(schema.memberships)
			.values({
				organizationId: org1Id,
				userId: user1Id
			})
			.returning();
		assert.equal(m1.organizationId, org1Id);
		assert.equal(m1.userId, user1Id);

		// User 1 joins Org 2 -> succeeds (global identity with multi-org membership)
		const [m1Org2] = await db
			.insert(schema.memberships)
			.values({
				organizationId: org2Id,
				userId: user1Id
			})
			.returning();
		assert.equal(m1Org2.organizationId, org2Id);

		// Attempt duplicate membership for User 1 in Org 1 -> must fail unique constraint
		await assert.rejects(
			async () => {
				await db.insert(schema.memberships).values({
					organizationId: org1Id,
					userId: user1Id
				});
			},
			(err) => matchesError(err, 'memberships_org_user_unique')
		);
	});

	await t.test(
		'3. Jerarquía y restricciones organizativas (departments, sites, teams)',
		async () => {
			// Valid inserts for Org 1
			const dept1Id = '55555555-5555-4555-8555-555555555555';
			const site1Id = '66666666-6666-4666-8666-666666666666';
			const team1Id = '77777777-7777-4777-8777-777777777777';

			const [dept] = await db
				.insert(schema.departments)
				.values({
					id: dept1Id,
					organizationId: org1Id,
					name: 'Sistemas e Infraestructura',
					code: 'SYS'
				})
				.returning();
			assert.equal(dept.name, 'Sistemas e Infraestructura');

			const [site] = await db
				.insert(schema.sites)
				.values({
					id: site1Id,
					organizationId: org1Id,
					name: 'Sede Central'
				})
				.returning();
			assert.equal(site.name, 'Sede Central');

			const [team] = await db
				.insert(schema.teams)
				.values({
					id: team1Id,
					organizationId: org1Id,
					name: 'Soporte Nivel 1',
					visibility: 'shared'
				})
				.returning();
			assert.equal(team.visibility, 'shared');

			// Duplicate department name in same organization -> fails
			await assert.rejects(
				async () => {
					await db.insert(schema.departments).values({
						organizationId: org1Id,
						name: 'Sistemas e Infraestructura'
					});
				},
				(err) => matchesError(err, 'departments_org_name_unique')
			);

			// Same department name in different organization -> succeeds
			const deptOrg2Id = '55555555-5555-4555-8555-555555555556';
			const [dept2] = await db
				.insert(schema.departments)
				.values({
					id: deptOrg2Id,
					organizationId: org2Id,
					name: 'Sistemas e Infraestructura'
				})
				.returning();
			assert.equal(dept2.organizationId, org2Id);
		}
	);

	await t.test('4. Políticas de visibilidad de equipos (shared vs restricted)', async () => {
		const teamSharedId = '88888888-8888-4888-8888-888888888888';
		const teamRestrictedId = '99999999-9999-4999-8999-999999999999';

		await db.insert(schema.teams).values([
			{
				id: teamSharedId,
				organizationId: org1Id,
				name: 'Equipo Público',
				visibility: 'shared'
			},
			{
				id: teamRestrictedId,
				organizationId: org1Id,
				name: 'Equipo Confidencial / Dirección',
				visibility: 'restricted'
			}
		]);

		// Invalid visibility value -> rejected by CHECK constraint
		await assert.rejects(
			async () => {
				await db.insert(schema.teams).values({
					organizationId: org1Id,
					name: 'Equipo Inválido',
					visibility: 'confidential' // not in ('shared', 'restricted')
				});
			},
			(err) => matchesError(err, 'teams_visibility_check')
		);
	});

	await t.test(
		'5. team_memberships: is_lead es no autorizante y FKs compuestas impiden cruce de organizaciones',
		async () => {
			// Query membership for user 1 in org 1
			const [m1] = await db
				.select()
				.from(schema.memberships)
				.where(eq(schema.memberships.organizationId, org1Id));

			// Query team in org 1
			const [t1] = await db
				.select()
				.from(schema.teams)
				.where(eq(schema.teams.organizationId, org1Id));

			// Create team in org 2
			const t2Org2Id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
			await db.insert(schema.teams).values({
				id: t2Org2Id,
				organizationId: org2Id,
				name: 'Equipo Pediatría Guardia',
				visibility: 'restricted'
			});

			// 5.1 Valid membership in same org team with is_lead = true
			const [tm] = await db
				.insert(schema.teamMemberships)
				.values({
					organizationId: org1Id,
					teamId: t1.id,
					membershipId: m1.id,
					isLead: true
				})
				.returning();
			assert.equal(tm.isLead, true);

			// Rule check: is_lead is purely descriptive metadata; no permissions or role assignments are generated
			const assignmentsForLead = await db
				.select()
				.from(schema.roleAssignments)
				.where(eq(schema.roleAssignments.membershipId, m1.id));
			assert.equal(assignmentsForLead.length, 0);

			// 5.2 Attempt cross-organization membership: User 1 from Org 1 added to Team in Org 2
			// If organization_id = Org 1: fails team_memberships_team_org_fk because team belongs to Org 2
			await assert.rejects(
				async () => {
					await db.insert(schema.teamMemberships).values({
						organizationId: org1Id,
						teamId: t2Org2Id,
						membershipId: m1.id
					});
				},
				(err) => matchesError(err, 'team_memberships_team_org_fk')
			);

			// If organization_id = Org 2: fails team_memberships_membership_org_fk because m1 belongs to Org 1
			await assert.rejects(
				async () => {
					await db.insert(schema.teamMemberships).values({
						organizationId: org2Id,
						teamId: t2Org2Id,
						membershipId: m1.id
					});
				},
				(err) => matchesError(err, 'team_memberships_membership_org_fk')
			);
		}
	);

	await t.test(
		'6. team_service_departments: equipos transversales con integridad referencial multiempresa',
		async () => {
			const [t1] = await db
				.select()
				.from(schema.teams)
				.where(eq(schema.teams.organizationId, org1Id));
			const [d1] = await db
				.select()
				.from(schema.departments)
				.where(eq(schema.departments.organizationId, org1Id));

			// Ensure department in Org 2 exists
			const deptOrg2Id = '55555555-5555-4555-8555-555555555556';
			let [d2] = await db
				.select()
				.from(schema.departments)
				.where(eq(schema.departments.id, deptOrg2Id));

			if (!d2) {
				[d2] = await db
					.insert(schema.departments)
					.values({
						id: deptOrg2Id,
						organizationId: org2Id,
						name: 'Pediatría Especializada'
					})
					.returning();
			}

			// Valid link: Team 1 (Org 1) services Dept 1 (Org 1)
			const [tsd] = await db
				.insert(schema.teamServiceDepartments)
				.values({
					organizationId: org1Id,
					teamId: t1.id,
					departmentId: d1.id
				})
				.returning();
			assert.equal(tsd.teamId, t1.id);
			assert.equal(tsd.departmentId, d1.id);

			// Attempt cross-organization service: Team 1 (Org 1) with Dept 2 (Org 2)
			// With org1Id: fails department FK
			await assert.rejects(
				async () => {
					await db.insert(schema.teamServiceDepartments).values({
						organizationId: org1Id,
						teamId: t1.id,
						departmentId: d2.id
					});
				},
				(err) => matchesError(err, 'team_service_dept_department_org_fk')
			);

			// With org2Id: fails team FK
			await assert.rejects(
				async () => {
					await db.insert(schema.teamServiceDepartments).values({
						organizationId: org2Id,
						teamId: t1.id,
						departmentId: d2.id
					});
				},
				(err) => matchesError(err, 'team_service_dept_team_org_fk')
			);
		}
	);

	await t.test(
		'7. Plantillas de roles (role_templates) vs Roles organizativos y permisos',
		async () => {
			// 7.1 Create permission
			await db.insert(schema.permissions).values([
				{
					id: 'incidents:view_all',
					name: 'Ver todas las incidencias',
					category: 'incidents',
					allowedScopeTypes: ['organization', 'team', 'department']
				},
				{
					id: 'incidents:edit',
					name: 'Editar incidencia',
					category: 'incidents',
					allowedScopeTypes: ['organization', 'team', 'personal']
				}
			]);

			// 7.2 Create role template (blueprint without organization_id)
			const [tpl] = await db
				.insert(schema.roleTemplates)
				.values({
					id: 'tpl_technician',
					code: 'technician',
					name: 'Técnico de Soporte',
					description: 'Plantilla base para técnicos de soporte'
				})
				.returning();
			assert.equal(tpl.id, 'tpl_technician');

			// Associate permissions to template
			await db.insert(schema.roleTemplatePermissions).values([
				{ roleTemplateId: 'tpl_technician', permissionId: 'incidents:view_all' },
				{ roleTemplateId: 'tpl_technician', permissionId: 'incidents:edit' }
			]);

			// 7.3 Instantiate role in Org 1 from template
			const roleOrg1Id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
			const [roleOrg1] = await db
				.insert(schema.roles)
				.values({
					id: roleOrg1Id,
					organizationId: org1Id,
					name: 'Técnico Nodhouses',
					code: 'technician',
					templateId: 'tpl_technician',
					isCustom: false
				})
				.returning();
			assert.equal(roleOrg1.organizationId, org1Id);
			assert.equal(roleOrg1.templateId, 'tpl_technician');

			// Grant permissions to organizational role
			await db.insert(schema.rolePermissions).values([
				{ roleId: roleOrg1Id, permissionId: 'incidents:view_all' },
				{ roleId: roleOrg1Id, permissionId: 'incidents:edit' }
			]);

			// 7.4 Verify templates cannot be directly assigned in role_assignments (foreign key references roles)
			const [m1] = await db
				.select()
				.from(schema.memberships)
				.where(eq(schema.memberships.organizationId, org1Id));

			await assert.rejects(
				async () => {
					await pglite.exec(`
					INSERT INTO role_assignments (organization_id, membership_id, role_id, scope_type)
					VALUES ('${org1Id}', '${m1.id}', '00000000-0000-0000-0000-000000000000', 'organization');
				`);
				},
				(err) => matchesError(err, 'role_assignments_role_org_fk')
			);
		}
	);

	await t.test(
		'8. Integridad de asignación de roles (role_assignments) y sus 5 ámbitos tipados',
		async () => {
			const [m1] = await db
				.select()
				.from(schema.memberships)
				.where(eq(schema.memberships.organizationId, org1Id));
			const [r1] = await db
				.select()
				.from(schema.roles)
				.where(eq(schema.roles.organizationId, org1Id));
			const [dept1] = await db
				.select()
				.from(schema.departments)
				.where(eq(schema.departments.organizationId, org1Id));
			const [team1] = await db
				.select()
				.from(schema.teams)
				.where(eq(schema.teams.organizationId, org1Id));
			const [site1] = await db
				.select()
				.from(schema.sites)
				.where(eq(schema.sites.organizationId, org1Id));

			// 8.1 Scope 'organization' -> valid with NULLs
			const [aOrg] = await db
				.insert(schema.roleAssignments)
				.values({
					organizationId: org1Id,
					membershipId: m1.id,
					roleId: r1.id,
					scopeType: 'organization'
				})
				.returning();
			assert.equal(aOrg.scopeType, 'organization');

			// 8.2 Scope 'department' -> valid with departmentId
			const [aDept] = await db
				.insert(schema.roleAssignments)
				.values({
					organizationId: org1Id,
					membershipId: m1.id,
					roleId: r1.id,
					scopeType: 'department',
					departmentId: dept1.id
				})
				.returning();
			assert.equal(aDept.departmentId, dept1.id);

			// 8.3 Scope 'team' -> valid with teamId
			const [aTeam] = await db
				.insert(schema.roleAssignments)
				.values({
					organizationId: org1Id,
					membershipId: m1.id,
					roleId: r1.id,
					scopeType: 'team',
					teamId: team1.id
				})
				.returning();
			assert.equal(aTeam.teamId, team1.id);

			// 8.4 Scope 'site' (justified for physical/clinic locations) -> valid with siteId
			const [aSite] = await db
				.insert(schema.roleAssignments)
				.values({
					organizationId: org1Id,
					membershipId: m1.id,
					roleId: r1.id,
					scopeType: 'site',
					siteId: site1.id
				})
				.returning();
			assert.equal(aSite.siteId, site1.id);

			// 8.5 Scope 'personal' -> valid with NULLs
			const [aPersonal] = await db
				.insert(schema.roleAssignments)
				.values({
					organizationId: org1Id,
					membershipId: m1.id,
					roleId: r1.id,
					scopeType: 'personal'
				})
				.returning();
			assert.equal(aPersonal.scopeType, 'personal');

			// 8.6 Inconsistent scope check: scope 'department' with NULL department_id -> fails CHECK
			await assert.rejects(
				async () => {
					await db.insert(schema.roleAssignments).values({
						organizationId: org1Id,
						membershipId: m1.id,
						roleId: r1.id,
						scopeType: 'department',
						departmentId: null
					});
				},
				(err) => matchesError(err, 'role_assignments_scope_fk_check')
			);

			// 8.7 Inconsistent scope check: scope 'organization' with team_id provided -> fails CHECK
			await assert.rejects(
				async () => {
					await db.insert(schema.roleAssignments).values({
						organizationId: org1Id,
						membershipId: m1.id,
						roleId: r1.id,
						scopeType: 'organization',
						teamId: team1.id
					});
				},
				(err) => matchesError(err, 'role_assignments_scope_fk_check')
			);

			// 8.8 Cross-organization role assignment: Org 2 role assigned to Org 1 membership -> fails composite FK
			const roleOrg2Id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
			await db.insert(schema.roles).values({
				id: roleOrg2Id,
				organizationId: org2Id,
				name: 'Rol en Otra Empresa',
				code: 'other_role'
			});

			await assert.rejects(
				async () => {
					await db.insert(schema.roleAssignments).values({
						organizationId: org1Id,
						membershipId: m1.id,
						roleId: roleOrg2Id,
						scopeType: 'organization'
					});
				},
				(err) => matchesError(err, 'role_assignments_role_org_fk')
			);
		}
	);

	await t.test(
		'9. Módulos y configuración por organización (modules, organization_modules)',
		async () => {
			// Register module
			await db.insert(schema.modules).values({
				id: 'incidents',
				name: 'Gestión de Incidencias',
				description: 'Módulo de incidencias operativas y soporte',
				version: '1.0.0',
				isCore: true
			});

			// Enable module for Org 1
			const [om] = await db
				.insert(schema.organizationModules)
				.values({
					organizationId: org1Id,
					moduleId: 'incidents',
					enabled: true,
					config: { priorityMatrixV2: true, maxAutoCloseHours: 24 }
				})
				.returning();
			assert.equal(om.moduleId, 'incidents');
			assert.equal(om.config.priorityMatrixV2, true);

			// Prevent duplicate module configuration per organization
			await assert.rejects(
				async () => {
					await db.insert(schema.organizationModules).values({
						organizationId: org1Id,
						moduleId: 'incidents',
						enabled: true
					});
				},
				(err) => matchesError(err, 'organization_modules_org_module_unique')
			);
		}
	);

	await t.test('10. Transacciones atómicas básicas (commit y rollback)', async () => {
		const orgTxId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
		const deptTxId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

		// 10.1 Successful transaction
		await db.transaction(async (tx) => {
			await tx.insert(schema.organizations).values({
				id: orgTxId,
				name: 'Transaccional S.L.',
				slug: 'transaccional',
				status: 'active'
			});
			await tx.insert(schema.departments).values({
				id: deptTxId,
				organizationId: orgTxId,
				name: 'Finanzas'
			});
		});

		const [persistedOrg] = await db
			.select()
			.from(schema.organizations)
			.where(eq(schema.organizations.id, orgTxId));
		assert.ok(persistedOrg, 'Organización debe estar guardada tras commit');

		// 10.2 Failing transaction with automatic rollback
		const rollbackOrgId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
		try {
			await db.transaction(async (tx) => {
				await tx.insert(schema.organizations).values({
					id: rollbackOrgId,
					name: 'Organización Rollback',
					slug: 'rollback-org',
					status: 'active'
				});
				// Force a constraint violation (slug uniqueness duplicate)
				await tx.insert(schema.organizations).values({
					name: 'Organización Duplicada',
					slug: 'rollback-org',
					status: 'active'
				});
			});
		} catch {
			// Expected failure
		}

		const rolledBackOrg = await db
			.select()
			.from(schema.organizations)
			.where(eq(schema.organizations.id, rollbackOrgId));
		assert.equal(
			rolledBackOrg.length,
			0,
			'La organización no debe existir tras rollback de transacción'
		);
	});

	await t.test('11. Reproducibilidad de migraciones sobre base de datos vacía', async (t) => {
		const freshPglite = new PGlite();
		t.after(() => freshPglite.close());
		await applyMigrations(freshPglite, path.join(rootDir, 'drizzle/migrations'));

		const tables = await freshPglite.query(`
			SELECT table_name
			FROM information_schema.tables
			WHERE table_schema = 'public'
			ORDER BY table_name;
		`);

		const tableNames = tables.rows.map((r) => r.table_name);
		const expectedTables = [
			'departments',
			'memberships',
			'modules',
			'organization_modules',
			'organizations',
			'permissions',
			'role_assignments',
			'role_permissions',
			'role_template_permissions',
			'role_templates',
			'roles',
			'sites',
			'team_memberships',
			'team_service_departments',
			'teams',
			'user_emails',
			'users'
		];

		for (const expected of expectedTables) {
			assert.ok(tableNames.includes(expected), `Tabla esperada ${expected} debe existir`);
		}
	});
});

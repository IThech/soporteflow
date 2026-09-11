import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

function createMockStorage(initial = {}) {
	const data = new Map(Object.entries(initial));
	return {
		getItem: (k) => (data.has(k) ? data.get(k) : null),
		setItem: (k, v) => data.set(k, String(v)),
		removeItem: (k) => data.delete(k),
		clear: () => data.clear()
	};
}

test('Administración v1 — Fase B: Gestión de Usuarios (Dominio, Persistencia y Reglas de Negocio)', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const {
			USERS_STORAGE_KEY,
			ADMINISTRABLE_ROLES,
			isUser,
			isUserList,
			loadUsersResult,
			saveUsers,
			createUser,
			updateUser,
			toggleUserActive,
			getOrganizationUsers
		} = await server.ssrLoadModule('/src/lib/users/catalog.ts');
		const { demoUsers } = await server.ssrLoadModule('/src/lib/data/users.ts');
		const { demoOrganization } = await server.ssrLoadModule('/src/lib/data/organizations.ts');
		const { demoSupportTeams } = await server.ssrLoadModule('/src/lib/data/teams.ts');

		const orgId = demoOrganization.id;
		const otherOrgId = 'org-other-corp';

		const orgAdmin = demoUsers.find((u) => u.role === 'organization_admin' && u.active);
		const technician = demoUsers.find((u) => u.role === 'technician' && u.active);
		const client = demoUsers.find((u) => u.role === 'client' && u.active);
		const platformAdmin = demoUsers.find((u) => u.role === 'platform_admin' && u.active);

		assert.ok(orgAdmin, 'Debe existir un organization_admin en demoUsers');
		assert.ok(technician, 'Debe existir un technician en demoUsers');
		assert.ok(client, 'Debe existir un client en demoUsers');
		assert.ok(platformAdmin, 'Debe existir un platform_admin en demoUsers');

		const defaultContext = {
			availableLevels: ['N1', 'N2', 'N3'],
			availableTeams: demoSupportTeams
		};

		await t.test('1. Validación de esquema y tipos de usuario (isUser e isUserList)', () => {
			assert.deepEqual(ADMINISTRABLE_ROLES, ['organization_admin', 'technician', 'client']);
			assert.equal(isUserList(demoUsers), true, 'demoUsers debe ser una lista válida');

			// Usuario con rol inválido
			assert.equal(isUser({ ...client, role: 'super_user' }), false);

			// Usuario con email inválido
			assert.equal(isUser({ ...client, email: 'no-email' }), false);

			// organization_admin sí puede tener supportLevel y teamId opcionales
			assert.equal(isUser({ ...orgAdmin, supportLevel: 'N1' }), true);
			assert.equal(isUser({ ...orgAdmin, teamId: 'team-1' }), true);
			assert.equal(isUser({ ...orgAdmin, supportLevel: 'N1', teamId: 'team-1' }), true);

			// client con supportLevel o teamId es rechazado
			assert.equal(isUser({ ...client, supportLevel: 'N1' }), false);
			assert.equal(isUser({ ...client, teamId: 'team-1' }), false);

			// platform_admin con supportLevel o teamId es rechazado
			assert.equal(isUser({ ...platformAdmin, supportLevel: 'N1' }), false);
			assert.equal(isUser({ ...platformAdmin, teamId: 'team-1' }), false);

			// technician sí puede tener supportLevel y teamId
			assert.equal(isUser(technician), true);

			// Lista con IDs duplicados es rechazada
			const duplicateIdList = [client, { ...client, email: 'other@nodhouses.test' }];
			assert.equal(isUserList(duplicateIdList), false);

			// Lista con emails duplicados (incluso case-insensitive) es rechazada
			const duplicateEmailList = [
				client,
				{ ...technician, id: 'user-new-id', email: client.email.toUpperCase() }
			];
			assert.equal(isUserList(duplicateEmailList), false);
		});

		await t.test('2. Carga y persistencia segura (missing, valid, corrupt)', () => {
			// Estado missing: siembra demoUsers
			const missingResult = loadUsersResult(null);
			assert.equal(missingResult.status, 'missing');
			assert.equal(missingResult.seededUsers.length, demoUsers.length);
			// Verificamos que sea una copia independiente
			missingResult.seededUsers[0].name = 'Mutated Name';
			assert.notEqual(demoUsers[0].name, 'Mutated Name');

			// Estado valid: parsea y valida
			const validJson = JSON.stringify(demoUsers);
			const validResult = loadUsersResult(validJson);
			assert.equal(validResult.status, 'valid');
			assert.equal(validResult.users.length, demoUsers.length);

			// Estado corrupt: JSON malformado
			const malformedResult = loadUsersResult('{ invalid json');
			assert.equal(malformedResult.status, 'corrupt');
			assert.ok(malformedResult.error);

			// Estado corrupt: esquema no conforme (no array o usuario inválido)
			const invalidSchemaResult = loadUsersResult(JSON.stringify([{ invalid: 'user' }]));
			assert.equal(invalidSchemaResult.status, 'corrupt');

			// saveUsers guarda en storage
			const storage = createMockStorage();
			saveUsers(storage, demoUsers);
			assert.ok(storage.getItem(USERS_STORAGE_KEY));
			const loadedBack = loadUsersResult(storage.getItem(USERS_STORAGE_KEY));
			assert.equal(loadedBack.status, 'valid');
		});

		await t.test('3. Creación de usuarios (createUser)', () => {
			let currentUsers = [...demoUsers];

			// Crear técnico con nivel y equipo
			const nextWithTech = createUser(
				orgAdmin,
				currentUsers,
				{
					organizationId: orgId,
					name: 'Marta Técnico',
					email: 'marta.tech@nodhouses.test',
					role: 'technician',
					supportLevel: 'N2',
					teamId: demoSupportTeams[0].id
				},
				defaultContext
			);

			assert.equal(nextWithTech.length, currentUsers.length + 1);
			const createdTech = nextWithTech.find((u) => u.email === 'marta.tech@nodhouses.test');
			assert.ok(createdTech);
			assert.equal(createdTech.name, 'Marta Técnico');
			assert.equal(createdTech.role, 'technician');
			assert.equal(createdTech.supportLevel, 'N2');
			assert.equal(createdTech.teamId, demoSupportTeams[0].id);
			assert.equal(createdTech.active, true);

			// Crear cliente ordinario (no debe tener nivel ni equipo aunque se envíen)
			const nextWithClient = createUser(
				orgAdmin,
				nextWithTech,
				{
					organizationId: orgId,
					name: 'Juan Cliente',
					email: 'juan.cliente@nodhouses.test',
					role: 'client',
					// @ts-expect-error probando que se ignoren si vienen en payload sucio
					supportLevel: 'N1',
					// @ts-expect-error probando que se ignoren si vienen en payload sucio
					teamId: demoSupportTeams[0].id
				},
				defaultContext
			);

			const createdClient = nextWithClient.find((u) => u.email === 'juan.cliente@nodhouses.test');
			assert.ok(createdClient);
			assert.equal(createdClient.role, 'client');
			assert.equal(createdClient.supportLevel, undefined);
			assert.equal(createdClient.teamId, undefined);

			// Crear organization_admin con nivel y equipo opcionales
			const nextWithAdmin = createUser(
				orgAdmin,
				nextWithClient,
				{
					organizationId: orgId,
					name: 'Carlos Admin Tech',
					email: 'carlos.admin@nodhouses.test',
					role: 'organization_admin',
					supportLevel: 'N3',
					teamId: demoSupportTeams[0].id
				},
				defaultContext
			);

			const createdAdmin = nextWithAdmin.find((u) => u.email === 'carlos.admin@nodhouses.test');
			assert.ok(createdAdmin);
			assert.equal(createdAdmin.role, 'organization_admin');
			assert.equal(createdAdmin.supportLevel, 'N3');
			assert.equal(createdAdmin.teamId, demoSupportTeams[0].id);
		});

		await t.test('4. Validaciones obligatorias al crear usuarios', () => {
			// Nombre vacío o corto
			assert.throws(
				() =>
					createUser(
						orgAdmin,
						demoUsers,
						{
							organizationId: orgId,
							name: ' ',
							email: 'test@nodhouses.test',
							role: 'client'
						},
						defaultContext
					),
				/nombre/i
			);

			// Email inválido
			assert.throws(
				() =>
					createUser(
						orgAdmin,
						demoUsers,
						{
							organizationId: orgId,
							name: 'Nombre Válido',
							email: 'email_invalido',
							role: 'client'
						},
						defaultContext
					),
				/correo electrónico/i
			);

			// Email duplicado (exacto)
			assert.throws(
				() =>
					createUser(
						orgAdmin,
						demoUsers,
						{
							organizationId: orgId,
							name: 'Otro Usuario',
							email: client.email,
							role: 'client'
						},
						defaultContext
					),
				/ya existe un usuario con este correo/i
			);

			// Email duplicado (case-insensitive)
			assert.throws(
				() =>
					createUser(
						orgAdmin,
						demoUsers,
						{
							organizationId: orgId,
							name: 'Otro Usuario',
							email: client.email.toUpperCase(),
							role: 'client'
						},
						defaultContext
					),
				/ya existe un usuario con este correo/i
			);

			// Prohibición estricta de platform_admin
			assert.throws(
				() =>
					createUser(
						orgAdmin,
						demoUsers,
						{
							organizationId: orgId,
							name: 'Intento Super Admin',
							email: 'super@nodhouses.test',
							// @ts-expect-error probando rechazo
							role: 'platform_admin'
						},
						defaultContext
					),
				/administrador de plataforma/i
			);

			// Técnico con nivel no válido
			assert.throws(
				() =>
					createUser(
						orgAdmin,
						demoUsers,
						{
							organizationId: orgId,
							name: 'Técnico Inválido',
							email: 'tech.inv@nodhouses.test',
							role: 'technician',
							// @ts-expect-error nivel no válido
							supportLevel: 'N99'
						},
						defaultContext
					),
				/nivel de soporte/i
			);

			// Técnico con equipo de otra organización
			assert.throws(
				() =>
					createUser(
						orgAdmin,
						demoUsers,
						{
							organizationId: orgId,
							name: 'Técnico Otro Equipo',
							email: 'tech.otro@nodhouses.test',
							role: 'technician',
							teamId: 'team-foreign'
						},
						{
							...defaultContext,
							availableTeams: [
								{
									id: 'team-foreign',
									organizationId: otherOrgId,
									name: 'Ext',
									active: true
								}
							]
						}
					),
				/equipo seleccionado no es válido/i
			);

			// Técnico con equipo inactivo
			assert.throws(
				() =>
					createUser(
						orgAdmin,
						demoUsers,
						{
							organizationId: orgId,
							name: 'Técnico Inactivo Equipo',
							email: 'tech.inactivo@nodhouses.test',
							role: 'technician',
							teamId: 'team-inactive'
						},
						{
							...defaultContext,
							availableTeams: [
								{
									id: 'team-inactive',
									organizationId: orgId,
									name: 'Inactivo',
									active: false
								}
							]
						}
					),
				/equipo seleccionado no es válido/i
			);
		});

		await t.test('5. Edición de usuarios y limpieza de campos técnicos (updateUser)', () => {
			let currentUsers = [...demoUsers];

			// Cambiar nombre y email de un técnico
			const updatedUsers = updateUser(
				orgAdmin,
				currentUsers,
				{
					id: technician.id,
					name: 'Técnico Renombrado',
					email: 'tecnico.nuevo@nodhouses.test',
					role: 'technician',
					supportLevel: 'N3',
					teamId: demoSupportTeams[0].id
				},
				defaultContext
			);

			const updatedTech = updatedUsers.find((u) => u.id === technician.id);
			assert.equal(updatedTech.name, 'Técnico Renombrado');
			assert.equal(updatedTech.email, 'tecnico.nuevo@nodhouses.test');
			assert.equal(updatedTech.supportLevel, 'N3');

			// technician → organization_admin DEBE CONSERVAR supportLevel y teamId
			const techBecameAdmin = updateUser(
				orgAdmin,
				updatedUsers,
				{
					id: technician.id,
					name: 'Técnico Promovido a Admin',
					email: 'tech.admin@nodhouses.test',
					role: 'organization_admin'
				},
				defaultContext
			);

			const promotedUser = techBecameAdmin.find((u) => u.id === technician.id);
			assert.equal(promotedUser.role, 'organization_admin');
			assert.equal(promotedUser.supportLevel, 'N3', 'Debe conservar el nivel N3');
			assert.equal(promotedUser.teamId, demoSupportTeams[0].id, 'Debe conservar el equipo');

			// organization_admin → technician DEBE CONSERVAR supportLevel y teamId
			const adminBecameTech = updateUser(
				orgAdmin,
				techBecameAdmin,
				{
					id: technician.id,
					name: 'Admin Vuelta a Técnico',
					email: 'tech.admin@nodhouses.test',
					role: 'technician'
				},
				defaultContext
			);

			const demotedUser = adminBecameTech.find((u) => u.id === technician.id);
			assert.equal(demotedUser.role, 'technician');
			assert.equal(demotedUser.supportLevel, 'N3', 'Debe conservar el nivel N3');
			assert.equal(demotedUser.teamId, demoSupportTeams[0].id, 'Debe conservar el equipo');

			// organization_admin → client DEBE LIMPIAR supportLevel y teamId
			const adminBecameClient = updateUser(
				orgAdmin,
				techBecameAdmin,
				{
					id: technician.id,
					name: 'Admin a Cliente',
					email: 'admin.client@nodhouses.test',
					role: 'client'
				},
				defaultContext
			);

			const adminClientUser = adminBecameClient.find((u) => u.id === technician.id);
			assert.equal(adminClientUser.role, 'client');
			assert.equal(adminClientUser.supportLevel, undefined);
			assert.equal(adminClientUser.teamId, undefined);

			// technician → client DEBE LIMPIAR supportLevel y teamId
			const techBecameClient = updateUser(
				orgAdmin,
				updatedUsers,
				{
					id: technician.id,
					name: 'Ex Técnico Ahora Cliente',
					email: 'extecnico@nodhouses.test',
					role: 'client'
				},
				defaultContext
			);

			const convertedUser = techBecameClient.find((u) => u.id === technician.id);
			assert.equal(convertedUser.role, 'client');
			assert.equal(convertedUser.supportLevel, undefined);
			assert.equal(convertedUser.teamId, undefined);

			// Intentar actualizar con el email de OTRO usuario debe fallar
			assert.throws(
				() =>
					updateUser(
						orgAdmin,
						currentUsers,
						{
							id: technician.id,
							name: 'Técnico Inválido',
							email: client.email,
							role: 'technician'
						},
						defaultContext
					),
				/ya existe otro usuario/i
			);

			// Actualizar manteniendo el MISMO email no debe fallar
			assert.doesNotThrow(() =>
				updateUser(
					orgAdmin,
					currentUsers,
					{
						id: technician.id,
						name: 'Técnico Mismo Email',
						email: technician.email,
						role: 'technician'
					},
					defaultContext
				)
			);
		});

		await t.test('6. Protección contra degradación o desactivación del último admin', () => {
			// Intentar cambiar el rol del único admin a client
			assert.throws(
				() =>
					updateUser(
						orgAdmin,
						demoUsers,
						{
							id: orgAdmin.id,
							name: orgAdmin.name,
							email: orgAdmin.email,
							role: 'client'
						},
						defaultContext
					),
				/sin ningún administrador activo/i
			);

			// Intentar desactivar al admin siendo el actor
			assert.throws(
				() =>
					updateUser(
						orgAdmin,
						demoUsers,
						{
							id: orgAdmin.id,
							name: orgAdmin.name,
							email: orgAdmin.email,
							role: 'organization_admin',
							active: false
						},
						defaultContext
					),
				/desactivar tu propia cuenta activa/i
			);

			// toggleUserActive sobre uno mismo debe fallar
			assert.throws(
				() => toggleUserActive(orgAdmin, demoUsers, orgAdmin.id),
				/propia cuenta activa/i
			);
		});

		await t.test('7. Activación y desactivación de usuarios (toggleUserActive)', () => {
			// Desactivar un técnico
			const afterDeactivate = toggleUserActive(orgAdmin, demoUsers, technician.id);
			const deactivatedTech = afterDeactivate.find((u) => u.id === technician.id);
			assert.equal(deactivatedTech.active, false);

			// Reactivar el técnico
			const afterReactivate = toggleUserActive(orgAdmin, afterDeactivate, technician.id);
			const reactivatedTech = afterReactivate.find((u) => u.id === technician.id);
			assert.equal(reactivatedTech.active, true);
		});

		await t.test('8. Matriz de permisos y aislamiento multi-tenant', () => {
			// Technician no tiene users:manage y no puede crear usuarios
			assert.throws(
				() =>
					createUser(
						technician,
						demoUsers,
						{
							organizationId: orgId,
							name: 'Nuevo',
							email: 'nuevo@nodhouses.test',
							role: 'client'
						},
						defaultContext
					),
				/permisos/i
			);

			// Client no tiene users:manage y no puede editar usuarios
			assert.throws(
				() =>
					updateUser(
						client,
						demoUsers,
						{
							id: technician.id,
							name: 'Hack',
							email: 'hack@nodhouses.test',
							role: 'technician'
						},
						defaultContext
					),
				/permisos/i
			);

			// Client no puede alternar estado
			assert.throws(() => toggleUserActive(client, demoUsers, technician.id), /permisos/i);

			// organization_admin no puede gestionar usuarios en otra organización
			assert.throws(
				() =>
					createUser(
						orgAdmin,
						demoUsers,
						{
							organizationId: otherOrgId,
							name: 'Usuario Extranjero',
							email: 'foreign@other.test',
							role: 'client'
						},
						defaultContext
					),
				/otra organización/i
			);

			// organization_admin no puede modificar platform_admin
			assert.throws(
				() =>
					updateUser(
						orgAdmin,
						demoUsers,
						{
							id: platformAdmin.id,
							name: 'Modificado',
							email: platformAdmin.email,
							role: 'organization_admin'
						},
						defaultContext
					),
				/administrador de plataforma/i
			);

			assert.throws(
				() => toggleUserActive(orgAdmin, demoUsers, platformAdmin.id),
				/administrador de plataforma/i
			);

			// getOrganizationUsers excluye platform_admin y usuarios de otra org
			const orgUsers = getOrganizationUsers(demoUsers, orgId);
			assert.ok(!orgUsers.some((u) => u.role === 'platform_admin'));
			assert.equal(orgUsers.length, 4); // orgAdmin, tech1, tech2, client
		});
	} finally {
		await server.close();
	}
});

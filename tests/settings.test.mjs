import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('Administración v1 — Fase A: shell de Configuración y permisos', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const {
			SETTINGS_GROUPS,
			getPermittedSettingsSections,
			canAccessSettings,
			canManageSettingsSection
		} = await server.ssrLoadModule('/src/lib/settings/sections.ts');
		const { demoUsers } = await server.ssrLoadModule('/src/lib/data/users.ts');

		const orgAdmin = demoUsers.find((u) => u.role === 'organization_admin' && u.active);
		const technician = demoUsers.find((u) => u.role === 'technician' && u.active);
		const client = demoUsers.find((u) => u.role === 'client' && u.active);
		const platformAdmin = {
			id: 'user-platform-admin',
			organizationId: 'org-acme',
			name: 'Super Admin',
			role: 'platform_admin',
			active: true
		};

		assert.ok(orgAdmin, 'Debe existir un usuario organization_admin en demoUsers');
		assert.ok(technician, 'Debe existir un usuario technician en demoUsers');
		assert.ok(client, 'Debe existir un usuario client en demoUsers');

		await t.test('Estructura declarativa de grupos y secciones de configuración', () => {
			assert.ok(Array.isArray(SETTINGS_GROUPS), 'SETTINGS_GROUPS debe ser un array');
			assert.equal(SETTINGS_GROUPS.length, 3, 'Debe tener 3 grupos definidos');

			const groupIds = SETTINGS_GROUPS.map((g) => g.id);
			assert.deepEqual(groupIds, ['organization', 'support', 'incidents']);

			const allSections = SETTINGS_GROUPS.flatMap((g) => g.sections);
			assert.equal(allSections.length, 7, 'Debe tener 7 secciones en total');

			// Verificar secciones activas
			const activeSections = allSections.filter((s) => s.status === 'active');
			assert.equal(activeSections.length, 3, 'Debe haber 3 secciones activas en Fase A');
			const activeIds = activeSections.map((s) => s.id).sort();
			assert.deepEqual(activeIds, ['categories', 'reassignment_reasons', 'sla_policies']);

			// Verificar secciones de próxima fase (coming_soon)
			const comingSoonSections = allSections.filter((s) => s.status === 'coming_soon');
			assert.equal(comingSoonSections.length, 4, 'Debe haber 4 secciones de próxima fase');
			const comingSoonIds = comingSoonSections.map((s) => s.id).sort();
			assert.deepEqual(comingSoonIds, ['locations', 'support_levels', 'teams', 'users']);

			// Todas las secciones deben tener campos requeridos
			for (const section of allSections) {
				assert.ok(section.id, 'Debe tener id');
				assert.ok(section.label, 'Debe tener label');
				assert.ok(section.description, 'Debe tener description');
				assert.ok(section.requiredPermission, 'Debe tener requiredPermission');
			}
		});

		await t.test('Acceso al shell de configuración (canAccessSettings)', () => {
			// Administrador de organización tiene acceso
			assert.equal(
				canAccessSettings(orgAdmin),
				true,
				'organization_admin debe tener acceso a Configuración'
			);

			// Administrador de plataforma tiene acceso
			assert.equal(
				canAccessSettings(platformAdmin),
				true,
				'platform_admin debe tener acceso a Configuración'
			);

			// Técnico ordinario no tiene acceso a Configuración
			assert.equal(
				canAccessSettings(technician),
				false,
				'technician no debe tener acceso a Configuración'
			);

			// Cliente ordinario no tiene acceso a Configuración
			assert.equal(canAccessSettings(client), false, 'client no debe tener acceso a Configuración');

			// Usuario inactivo no tiene acceso aunque sea admin
			const inactiveAdmin = { ...orgAdmin, active: false };
			assert.equal(
				canAccessSettings(inactiveAdmin),
				false,
				'Usuario inactivo no debe tener acceso a Configuración'
			);

			// Null o undefined no tienen acceso
			assert.equal(canAccessSettings(null), false);
			assert.equal(canAccessSettings(undefined), false);
		});

		await t.test(
			'Principio dinámico: acceso basado en permisos sobre secciones disponibles',
			() => {
				const userWithCategoryManage = {
					id: 'cat-admin',
					organizationId: 'org-acme',
					name: 'Admin Categorias',
					role: 'organization_admin',
					active: true
				};
				assert.equal(canAccessSettings(userWithCategoryManage), true);

				// getPermittedSettingsSections excluye coming_soon por defecto
				const activePermitted = getPermittedSettingsSections(orgAdmin);
				assert.equal(activePermitted.length, 3);
				assert.deepEqual(activePermitted.map((s) => s.id).sort(), [
					'categories',
					'reassignment_reasons',
					'sla_policies'
				]);

				// getPermittedSettingsSections incluye coming_soon si se solicita explícitamente
				const allPermitted = getPermittedSettingsSections(orgAdmin, { includeComingSoon: true });
				assert.equal(allPermitted.length, 7);

				// Técnico no tiene ninguna sección permitida
				assert.deepEqual(getPermittedSettingsSections(technician), []);
				assert.deepEqual(getPermittedSettingsSections(technician, { includeComingSoon: true }), []);

				// Cliente no tiene ninguna sección permitida
				assert.deepEqual(getPermittedSettingsSections(client), []);
			}
		);

		await t.test('Permiso granular por sección dentro del shell (canManageSettingsSection)', () => {
			// organization_admin puede gestionar todas las secciones
			assert.equal(canManageSettingsSection(orgAdmin, 'categories'), true);
			assert.equal(canManageSettingsSection(orgAdmin, 'reassignment_reasons'), true);
			assert.equal(canManageSettingsSection(orgAdmin, 'sla_policies'), true);
			assert.equal(canManageSettingsSection(orgAdmin, 'users'), true);
			assert.equal(canManageSettingsSection(orgAdmin, 'locations'), true);
			assert.equal(canManageSettingsSection(orgAdmin, 'support_levels'), true);
			assert.equal(canManageSettingsSection(orgAdmin, 'teams'), true);

			// technician no puede gestionar ninguna sección
			assert.equal(canManageSettingsSection(technician, 'categories'), false);
			assert.equal(canManageSettingsSection(technician, 'reassignment_reasons'), false);
			assert.equal(canManageSettingsSection(technician, 'sla_policies'), false);
			assert.equal(canManageSettingsSection(technician, 'users'), false);

			// cliente no puede gestionar ninguna sección
			assert.equal(canManageSettingsSection(client, 'categories'), false);
			assert.equal(canManageSettingsSection(client, 'sla_policies'), false);

			// Sección inexistente devuelve false
			// @ts-expect-error probando id no válido
			assert.equal(canManageSettingsSection(orgAdmin, 'non_existent_section'), false);

			// Usuario inactivo devuelve false
			const inactiveAdmin = { ...orgAdmin, active: false };
			assert.equal(canManageSettingsSection(inactiveAdmin, 'categories'), false);
		});
	} finally {
		await server.close();
	}
});

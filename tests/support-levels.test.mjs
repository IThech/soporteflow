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

test('Administración v1 — Fase C: Catálogo y Persistencia de Niveles de Soporte', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const {
			SUPPORT_LEVELS_STORAGE_KEY,
			normalizeLevelCode,
			isValidLevelCode,
			isSupportLevel,
			isSupportLevelList,
			loadSupportLevelsResult,
			saveSupportLevels,
			getOrganizationLevels,
			countSupportLevelReferences,
			createSupportLevel,
			updateSupportLevel,
			toggleSupportLevelActive,
			reorderSupportLevel
		} = await server.ssrLoadModule('/src/lib/support/levels-catalog.ts');
		const { demoSupportLevels } = await server.ssrLoadModule('/src/lib/data/support-levels.ts');
		const { demoOrganization } = await server.ssrLoadModule('/src/lib/data/organizations.ts');

		const orgId = demoOrganization.id;
		const otherOrgId = 'org-other-corp';

		const adminUser = {
			id: 'user-admin',
			organizationId: orgId,
			name: 'Admin',
			email: 'admin@nodhouses.test',
			role: 'organization_admin',
			active: true,
			createdAt: '2026-09-01'
		};

		const techUser = {
			id: 'user-tech',
			organizationId: orgId,
			name: 'Técnico',
			email: 'tech@nodhouses.test',
			role: 'technician',
			active: true,
			createdAt: '2026-09-01'
		};

		await t.test('1. Normalización y validación de código', () => {
			assert.equal(normalizeLevelCode('  n1  '), 'N1');
			assert.equal(isValidLevelCode('N1'), true);
			assert.equal(isValidLevelCode('TIER-1'), true);
			assert.equal(isValidLevelCode('L1'), true);
			assert.equal(isValidLevelCode(''), false);
			assert.equal(isValidLevelCode('MUYLARGOCODIGOSINLIMITES'), false);
		});

		await t.test('2. Validación de esquema e integridad de lista', () => {
			assert.equal(isSupportLevelList(demoSupportLevels), true);

			// Inválido si falta code o name
			assert.equal(isSupportLevel({ ...demoSupportLevels[0], code: '' }), false);
			assert.equal(isSupportLevel({ ...demoSupportLevels[0], name: 'x' }), false);
			assert.equal(isSupportLevel({ ...demoSupportLevels[0], order: 0 }), false);

			// Lista con IDs duplicados es rechazada
			const duplicateId = [demoSupportLevels[0], { ...demoSupportLevels[0], code: 'N4' }];
			assert.equal(isSupportLevelList(duplicateId), false);

			// Lista con códigos duplicados en la misma organización es rechazada
			const duplicateCode = [
				demoSupportLevels[0],
				{ ...demoSupportLevels[1], id: 'lvl-other', code: 'n1' }
			];
			assert.equal(isSupportLevelList(duplicateCode), false);

			// Mismo código en organizaciones distintas es perfectamente VÁLIDO
			const diffOrgSameCode = [
				demoSupportLevels[0],
				{
					...demoSupportLevels[0],
					id: 'lvl-foreign-n1',
					organizationId: otherOrgId
				}
			];
			assert.equal(isSupportLevelList(diffOrgSameCode), true);
		});

		await t.test('3. Carga y persistencia segura (missing, valid, corrupt)', () => {
			// missing
			const missingRes = loadSupportLevelsResult(null);
			assert.equal(missingRes.status, 'missing');
			assert.equal(missingRes.seededLevels.length, demoSupportLevels.length);

			// valid
			const storage = createMockStorage();
			saveSupportLevels(storage, demoSupportLevels);
			const validRes = loadSupportLevelsResult(storage.getItem(SUPPORT_LEVELS_STORAGE_KEY));
			assert.equal(validRes.status, 'valid');
			assert.equal(validRes.levels.length, demoSupportLevels.length);

			// corrupt: json malformado
			const corruptJson = loadSupportLevelsResult('{{{invalid-json');
			assert.equal(corruptJson.status, 'corrupt');

			// corrupt: esquema no cumple
			const corruptSchema = loadSupportLevelsResult(JSON.stringify([{ id: 'bad' }]));
			assert.equal(corruptSchema.status, 'corrupt');
		});

		await t.test('4. Creación de niveles y reglas de negocio', () => {
			let list = [...demoSupportLevels];

			// Creación exitosa
			list = createSupportLevel(adminUser, list, {
				organizationId: orgId,
				code: 'N4',
				name: 'Nivel Especializado',
				description: 'Área ultra especializada.'
			});

			const created = list.find((l) => l.code === 'N4');
			assert.ok(created);
			assert.equal(created.name, 'Nivel Especializado');
			assert.equal(created.order, 4);
			assert.equal(created.active, true);

			// Rechazo de código duplicado en la misma org (case insensitive)
			assert.throws(
				() =>
					createSupportLevel(adminUser, list, {
						organizationId: orgId,
						code: 'n4',
						name: 'Otro N4'
					}),
				/Ya existe un nivel con el código "N4"/
			);

			// Mismo código permitido en otra organización
			const foreignAdmin = { ...adminUser, organizationId: otherOrgId };
			const withForeign = createSupportLevel(foreignAdmin, list, {
				organizationId: otherOrgId,
				code: 'N4',
				name: 'Nivel Externo'
			});
			assert.equal(withForeign.filter((l) => l.code === 'N4').length, 2);

			// Aislamiento: admin no puede crear para otra organización
			assert.throws(
				() =>
					createSupportLevel(adminUser, list, {
						organizationId: otherOrgId,
						code: 'N5',
						name: 'Intento Ilegal'
					}),
				/No tienes permiso/
			);

			// Permiso: técnico no puede crear niveles
			assert.throws(
				() =>
					createSupportLevel(techUser, list, {
						organizationId: orgId,
						code: 'N5',
						name: 'Intento Técnico'
					}),
				/No tienes permisos/
			);
		});

		await t.test('5. Edición e inmutabilidad del código', () => {
			let list = [...demoSupportLevels];
			const target = list[0]; // N1

			// Modificar nombre y descripción
			list = updateSupportLevel(adminUser, list, {
				id: target.id,
				name: 'Atención inicial',
				description: 'Nuevo alcance descriptivo'
			});

			const updated = list.find((l) => l.id === target.id);
			assert.equal(updated.name, 'Atención inicial');
			assert.equal(updated.description, 'Nuevo alcance descriptivo');
			// El código debe ser inmutable y permanecer intacto
			assert.equal(updated.code, 'N1');

			// Rechazar edición si actor es de otra organización
			const foreignAdmin = { ...adminUser, organizationId: otherOrgId };
			assert.throws(
				() =>
					updateSupportLevel(foreignAdmin, list, {
						id: target.id,
						name: 'Hack'
					}),
				/No tienes permiso/
			);
		});

		await t.test('6. Reordenación ascendente y descendente determinista (↑ / ↓)', () => {
			let list = [...demoSupportLevels];
			// demo: N1 (order 1), N2 (order 2), N3 (order 3)

			// Subir N2 -> debe quedar en orden 1, y N1 en orden 2
			list = reorderSupportLevel(adminUser, list, 'lvl-nodhouses-n2', 'up');
			let orgLevels = getOrganizationLevels(list, orgId);
			assert.equal(orgLevels[0].code, 'N2');
			assert.equal(orgLevels[0].order, 1);
			assert.equal(orgLevels[1].code, 'N1');
			assert.equal(orgLevels[1].order, 2);
			assert.equal(orgLevels[2].code, 'N3');
			assert.equal(orgLevels[2].order, 3);

			// Bajar N2 -> vuelve a orden 2
			list = reorderSupportLevel(adminUser, list, 'lvl-nodhouses-n2', 'down');
			orgLevels = getOrganizationLevels(list, orgId);
			assert.equal(orgLevels[0].code, 'N1');
			assert.equal(orgLevels[1].code, 'N2');
			assert.equal(orgLevels[2].code, 'N3');

			// Subir el primero no cambia nada
			list = reorderSupportLevel(adminUser, list, 'lvl-nodhouses-n1', 'up');
			orgLevels = getOrganizationLevels(list, orgId);
			assert.equal(orgLevels[0].code, 'N1');

			// Bajar el último no cambia nada
			list = reorderSupportLevel(adminUser, list, 'lvl-nodhouses-n3', 'down');
			orgLevels = getOrganizationLevels(list, orgId);
			assert.equal(orgLevels[2].code, 'N3');
		});

		await t.test('7. Activación, desactivación y detección de referencias', () => {
			let list = [...demoSupportLevels];
			const targetId = 'lvl-nodhouses-n2';

			// Desactivar
			list = toggleSupportLevelActive(adminUser, list, targetId);
			assert.equal(list.find((l) => l.id === targetId).active, false);

			// Reactivar
			list = toggleSupportLevelActive(adminUser, list, targetId);
			assert.equal(list.find((l) => l.id === targetId).active, true);

			// Conteo de referencias
			const users = [
				{ ...techUser, id: 'u1', supportLevel: 'N2', organizationId: orgId },
				{ ...techUser, id: 'u2', supportLevel: 'N2', organizationId: orgId },
				{ ...techUser, id: 'u3', supportLevel: 'N1', organizationId: orgId },
				{ ...techUser, id: 'u4', supportLevel: 'N2', organizationId: otherOrgId } // Otra org no cuenta
			];

			const incidents = [
				{ id: 1, organizationId: orgId, supportLevel: 'N2', status: 'open' },
				{ id: 2, organizationId: orgId, supportLevel: 'N2', status: 'pending' },
				{ id: 3, organizationId: orgId, supportLevel: 'N2', status: 'resolved' },
				{ id: 4, organizationId: orgId, supportLevel: 'N2', status: 'closed' }, // Closed no cuenta
				{ id: 5, organizationId: orgId, supportLevel: 'N1', status: 'open' },
				{ id: 6, organizationId: otherOrgId, supportLevel: 'N2', status: 'open' } // Otra org no cuenta
			];

			const refsN2 = countSupportLevelReferences(orgId, 'N2', users, incidents);
			assert.equal(refsN2.userCount, 2);
			assert.equal(refsN2.activeIncidentCount, 3); // open, pending, resolved (closed excluido)

			const refsN3 = countSupportLevelReferences(orgId, 'N3', users, incidents);
			assert.equal(refsN3.userCount, 0);
			assert.equal(refsN3.activeIncidentCount, 0);
		});
	} finally {
		await server.close();
	}
});

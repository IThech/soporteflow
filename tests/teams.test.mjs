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

test('Administración v1 — Fase C: Catálogo y Persistencia de Equipos de Soporte', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const {
			SUPPORT_TEAMS_STORAGE_KEY,
			normalizeTeamName,
			isSupportTeam,
			isSupportTeamList,
			loadSupportTeamsResult,
			saveSupportTeams,
			countSupportTeamReferences,
			createSupportTeam,
			updateSupportTeam,
			toggleSupportTeamActive
		} = await server.ssrLoadModule('/src/lib/support/teams-catalog.ts');
		const { demoSupportTeams } = await server.ssrLoadModule('/src/lib/data/teams.ts');
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

		await t.test('1. Normalización de nombre y validación de esquema', () => {
			assert.equal(normalizeTeamName('  Soporte General  '), 'soporte general');
			assert.equal(isSupportTeamList(demoSupportTeams), true);

			// Rechaza sin nombre o con nombre menor a 2 caracteres
			assert.equal(isSupportTeam({ ...demoSupportTeams[0], name: '' }), false);
			assert.equal(isSupportTeam({ ...demoSupportTeams[0], name: 'A' }), false);

			// Rechaza IDs duplicados en lista
			const duplicateId = [demoSupportTeams[0], { ...demoSupportTeams[0], name: 'Otro' }];
			assert.equal(isSupportTeamList(duplicateId), false);

			// Rechaza nombres duplicados en la misma organización
			const duplicateName = [
				demoSupportTeams[0],
				{ ...demoSupportTeams[1], id: 'team-new', name: demoSupportTeams[0].name.toUpperCase() }
			];
			assert.equal(isSupportTeamList(duplicateName), false);

			// Mismo nombre en organizaciones distintas es permitido
			const diffOrgSameName = [
				demoSupportTeams[0],
				{
					...demoSupportTeams[0],
					id: 'team-foreign',
					organizationId: otherOrgId
				}
			];
			assert.equal(isSupportTeamList(diffOrgSameName), true);
		});

		await t.test('2. Carga y persistencia segura (missing, valid, corrupt)', () => {
			// missing
			const missingRes = loadSupportTeamsResult(null);
			assert.equal(missingRes.status, 'missing');
			assert.equal(missingRes.seededTeams.length, demoSupportTeams.length);

			// valid
			const storage = createMockStorage();
			saveSupportTeams(storage, demoSupportTeams);
			const validRes = loadSupportTeamsResult(storage.getItem(SUPPORT_TEAMS_STORAGE_KEY));
			assert.equal(validRes.status, 'valid');
			assert.equal(validRes.teams.length, demoSupportTeams.length);

			// corrupt
			const corruptRes = loadSupportTeamsResult('[[invalid-json');
			assert.equal(corruptRes.status, 'corrupt');

			const corruptSchema = loadSupportTeamsResult(JSON.stringify([{ bad: true }]));
			assert.equal(corruptSchema.status, 'corrupt');
		});

		await t.test('3. Creación de equipos y reglas de negocio', () => {
			let list = [...demoSupportTeams];

			// Creación exitosa
			list = createSupportTeam(adminUser, list, {
				organizationId: orgId,
				name: 'Infraestructura',
				description: 'Redes y servidores.'
			});

			const created = list.find((t) => t.name === 'Infraestructura');
			assert.ok(created);
			assert.equal(created.description, 'Redes y servidores.');
			assert.equal(created.active, true);

			// Rechazo de nombre duplicado en la misma org (case-insensitive)
			assert.throws(
				() =>
					createSupportTeam(adminUser, list, {
						organizationId: orgId,
						name: 'infraestructura'
					}),
				/Ya existe un equipo con el nombre/
			);

			// Mismo nombre permitido en otra organización
			const foreignAdmin = { ...adminUser, organizationId: otherOrgId };
			const withForeign = createSupportTeam(foreignAdmin, list, {
				organizationId: otherOrgId,
				name: 'Infraestructura'
			});
			assert.equal(withForeign.filter((t) => t.name === 'Infraestructura').length, 2);

			// Aislamiento: admin no puede crear para otra organización
			assert.throws(
				() =>
					createSupportTeam(adminUser, list, {
						organizationId: otherOrgId,
						name: 'Intento Ilegal'
					}),
				/No tienes permiso/
			);

			// Permiso: técnico no puede crear equipos
			assert.throws(
				() =>
					createSupportTeam(techUser, list, {
						organizationId: orgId,
						name: 'Intento Técnico'
					}),
				/No tienes permisos/
			);
		});

		await t.test('4. Edición de equipos', () => {
			let list = [...demoSupportTeams];
			const target = list[0];

			list = updateSupportTeam(adminUser, list, {
				id: target.id,
				name: 'Soporte Central',
				description: 'Atención técnica Nivel 1 y 2.'
			});

			const updated = list.find((t) => t.id === target.id);
			assert.equal(updated.name, 'Soporte Central');
			assert.equal(updated.description, 'Atención técnica Nivel 1 y 2.');

			// Rechazar si duplica nombre de otro equipo en la misma org
			assert.throws(
				() =>
					updateSupportTeam(adminUser, list, {
						id: target.id,
						name: demoSupportTeams[1].name
					}),
				/Ya existe otro equipo con el nombre/
			);

			// Rechazar si el actor es de otra organización
			const foreignAdmin = { ...adminUser, organizationId: otherOrgId };
			assert.throws(
				() =>
					updateSupportTeam(foreignAdmin, list, {
						id: target.id,
						name: 'Hack'
					}),
				/No tienes permiso/
			);
		});

		await t.test('5. Activación, desactivación y referencias', () => {
			let list = [...demoSupportTeams];
			const targetId = demoSupportTeams[0].id;

			// Desactivar
			list = toggleSupportTeamActive(adminUser, list, targetId);
			assert.equal(list.find((t) => t.id === targetId).active, false);

			// Reactivar
			list = toggleSupportTeamActive(adminUser, list, targetId);
			assert.equal(list.find((t) => t.id === targetId).active, true);

			// Conteo de referencias
			const users = [
				{ ...techUser, id: 'u1', teamId: targetId, organizationId: orgId },
				{ ...techUser, id: 'u2', teamId: targetId, organizationId: orgId },
				{ ...techUser, id: 'u3', teamId: 'team-other', organizationId: orgId },
				{ ...techUser, id: 'u4', teamId: targetId, organizationId: otherOrgId } // Otra org
			];

			const incidents = [
				{ id: 1, organizationId: orgId, teamId: targetId, status: 'open' },
				{ id: 2, organizationId: orgId, teamId: targetId, status: 'pending' },
				{ id: 3, organizationId: orgId, teamId: targetId, status: 'resolved' },
				{ id: 4, organizationId: orgId, teamId: targetId, status: 'closed' }, // Closed no cuenta
				{ id: 5, organizationId: orgId, teamId: 'team-other', status: 'open' },
				{ id: 6, organizationId: otherOrgId, teamId: targetId, status: 'open' } // Otra org
			];

			const refs = countSupportTeamReferences(orgId, targetId, users, incidents);
			assert.equal(refs.userCount, 2);
			assert.equal(refs.activeIncidentCount, 3); // open, pending, resolved (closed excluido)
		});
	} finally {
		await server.close();
	}
});

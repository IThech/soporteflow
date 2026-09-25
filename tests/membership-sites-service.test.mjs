import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
	fixture,
	createCredentialUser,
	createSession,
	grantPermission
} from './helpers/auth-fixture.mjs';

function errorCode(error) {
	return error?.code ?? error?.cause?.code;
}

test('SoporteFlow — Etapa 5.4O-D: membership_sites (pertenencia operativa)', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, pg, server } = f;
	const service = await server.ssrLoadModule('/src/lib/server/services/membership-sites.ts');
	const { listMembershipSites, assignMembershipSite, setMembershipSiteActive } = service;
	const { IncidentServiceError } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);
	const { setSiteActive } = await server.ssrLoadModule('/src/lib/server/services/sites.ts');

	async function rejectsWith(operation, code) {
		await assert.rejects(operation, (error) => {
			assert.ok(error instanceof IncidentServiceError, `esperado IncidentServiceError: ${error}`);
			assert.equal(error.code, code);
			return true;
		});
	}

	const [orgA, orgB] = await db
		.insert(s.organizations)
		.values([
			{ name: 'MS A', slug: randomUUID(), status: 'active' },
			{ name: 'MS B', slug: randomUUID(), status: 'active' }
		])
		.returning();

	async function member(organization) {
		const [user] = await db.insert(s.users).values({ name: 'Técnico' }).returning();
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: organization.id, userId: user.id })
			.returning();
		return { user, membership };
	}
	async function site(organization, name, active = true) {
		const [row] = await db
			.insert(s.sites)
			.values({ organizationId: organization.id, name, active })
			.returning();
		return row;
	}

	const andres = await member(orgA);
	const beatriz = await member(orgA);
	const memberB = await member(orgB);
	const valencia = await site(orgA, 'Valencia');
	const madrid = await site(orgA, 'Madrid');
	const cerrada = await site(orgA, 'Cerrada', false);
	const siteB = await site(orgB, 'Valencia');

	const KEYS = ['active', 'createdAt', 'siteActive', 'siteId', 'siteName', 'updatedAt'];

	await t.test('1. lista vacía', async () => {
		assert.deepEqual(await listMembershipSites(db, orgA.id, andres.membership.id), []);
	});

	await t.test('2-5, 21. asignar, active=true, varias sedes y varios miembros', async () => {
		const first = await assignMembershipSite(db, orgA.id, andres.membership.id, valencia.id);
		assert.deepEqual(Object.keys(first).sort(), KEYS);
		assert.equal(first.siteId, valencia.id);
		assert.equal(first.siteName, 'Valencia');
		assert.equal(first.active, true);
		assert.equal(first.siteActive, true);
		assert.ok(first.createdAt instanceof Date && first.updatedAt instanceof Date);
		await assignMembershipSite(db, orgA.id, andres.membership.id, madrid.id);
		await assignMembershipSite(db, orgA.id, beatriz.membership.id, valencia.id);
		assert.deepEqual(
			(await listMembershipSites(db, orgA.id, andres.membership.id)).map((r) => r.siteName),
			['Madrid', 'Valencia']
		);
		const valenciaMembers = await db
			.select()
			.from(s.membershipSites)
			.where(eq(s.membershipSites.siteId, valencia.id));
		assert.equal(valenciaMembers.length, 2);
		const [row] = await db
			.select()
			.from(s.membershipSites)
			.where(eq(s.membershipSites.membershipId, beatriz.membership.id));
		assert.equal(row.organizationId, orgA.id);
		assert.equal(row.active, true);
	});

	await t.test(
		'6. duplicado activo: idempotente, sin nueva fila ni cambio de updatedAt',
		async () => {
			const [before] = await db
				.select()
				.from(s.membershipSites)
				.where(
					and(
						eq(s.membershipSites.membershipId, andres.membership.id),
						eq(s.membershipSites.siteId, valencia.id)
					)
				);
			const again = await assignMembershipSite(db, orgA.id, andres.membership.id, valencia.id);
			assert.equal(again.active, true);
			assert.equal(again.updatedAt.getTime(), before.updatedAt.getTime());
			const rows = await db
				.select()
				.from(s.membershipSites)
				.where(eq(s.membershipSites.membershipId, andres.membership.id));
			assert.equal(rows.length, 2);
			// dos asignaciones simultáneas del mismo par tampoco duplican
			await Promise.all([
				assignMembershipSite(db, orgA.id, beatriz.membership.id, madrid.id),
				assignMembershipSite(db, orgA.id, beatriz.membership.id, madrid.id)
			]);
			assert.equal(
				(await listMembershipSites(db, orgA.id, beatriz.membership.id)).filter(
					(r) => r.siteId === madrid.id
				).length,
				1
			);
		}
	);

	await t.test(
		'7-9. desactivar conserva la fila, reactivar reutiliza la misma, sin delete',
		async () => {
			const [original] = await db
				.select()
				.from(s.membershipSites)
				.where(
					and(
						eq(s.membershipSites.membershipId, andres.membership.id),
						eq(s.membershipSites.siteId, madrid.id)
					)
				);
			const off = await setMembershipSiteActive(
				db,
				orgA.id,
				andres.membership.id,
				madrid.id,
				false
			);
			assert.equal(off.active, false);
			const list = await listMembershipSites(db, orgA.id, andres.membership.id);
			assert.ok(list.some((r) => r.siteId === madrid.id && !r.active));
			assert.deepEqual(
				(await listMembershipSites(db, orgA.id, andres.membership.id, { activeOnly: true })).map(
					(r) => r.siteId
				),
				[valencia.id]
			);
			// reactivar vía assign reutiliza la fila
			const on = await assignMembershipSite(db, orgA.id, andres.membership.id, madrid.id);
			assert.equal(on.active, true);
			const [row] = await db
				.select()
				.from(s.membershipSites)
				.where(
					and(
						eq(s.membershipSites.membershipId, andres.membership.id),
						eq(s.membershipSites.siteId, madrid.id)
					)
				);
			assert.equal(row.id, original.id);
			assert.ok(row.updatedAt.getTime() >= original.updatedAt.getTime());
			// y vía setMembershipSiteActive(true)
			await setMembershipSiteActive(db, orgA.id, andres.membership.id, madrid.id, false);
			assert.equal(
				(await setMembershipSiteActive(db, orgA.id, andres.membership.id, madrid.id, true)).active,
				true
			);
			// sin borrado
			const exported = Object.keys(service)
				.filter((k) => typeof service[k] === 'function')
				.sort();
			assert.deepEqual(exported, [
				'assignMembershipSite',
				'listMembershipSites',
				'setMembershipSiteActive'
			]);
			await rejectsWith(
				setMembershipSiteActive(db, orgA.id, andres.membership.id, madrid.id, 'false'),
				'INVALID_INPUT'
			);
		}
	);

	await t.test('10-13, 16. cross-tenant e inexistentes', async () => {
		// membership de B en org A
		await rejectsWith(
			assignMembershipSite(db, orgA.id, memberB.membership.id, valencia.id),
			'MEMBERSHIP_NOT_FOUND'
		);
		await rejectsWith(
			listMembershipSites(db, orgA.id, memberB.membership.id),
			'MEMBERSHIP_NOT_FOUND'
		);
		// sede de B para membership de A
		await rejectsWith(
			assignMembershipSite(db, orgA.id, andres.membership.id, siteB.id),
			'SITE_NOT_FOUND'
		);
		// inexistentes
		await rejectsWith(
			assignMembershipSite(db, orgA.id, randomUUID(), valencia.id),
			'MEMBERSHIP_NOT_FOUND'
		);
		await rejectsWith(
			assignMembershipSite(db, orgA.id, andres.membership.id, randomUUID()),
			'SITE_NOT_FOUND'
		);
		// asociación de A manipulada desde B
		await rejectsWith(
			setMembershipSiteActive(db, orgB.id, andres.membership.id, valencia.id, false),
			'MEMBERSHIP_NOT_FOUND'
		);
		await rejectsWith(
			setMembershipSiteActive(db, orgA.id, beatriz.membership.id, cerrada.id, false),
			'MEMBERSHIP_SITE_NOT_FOUND'
		);
		// aislamiento
		await assignMembershipSite(db, orgB.id, memberB.membership.id, siteB.id);
		const listB = await listMembershipSites(db, orgB.id, memberB.membership.id);
		assert.deepEqual(
			listB.map((r) => r.siteId),
			[siteB.id]
		);
		const listA = await listMembershipSites(db, orgA.id, andres.membership.id);
		assert.ok(!listA.some((r) => r.siteId === siteB.id));
		for (const bad of [
			['x', andres.membership.id, valencia.id],
			[orgA.id, 'x', valencia.id],
			[orgA.id, andres.membership.id, 'x']
		])
			await rejectsWith(assignMembershipSite(db, ...bad), 'INVALID_INPUT');
	});

	await t.test(
		'14-15. sede inactiva: no admite nuevas asociaciones; las existentes se conservan',
		async () => {
			await rejectsWith(
				assignMembershipSite(db, orgA.id, beatriz.membership.id, cerrada.id),
				'SITE_INACTIVE'
			);
			await setSiteActive(db, orgA.id, valencia.id, false);
			const list = await listMembershipSites(db, orgA.id, andres.membership.id);
			const valenciaRow = list.find((r) => r.siteId === valencia.id);
			assert.equal(valenciaRow.active, true, 'la asociación no se toca');
			assert.equal(valenciaRow.siteActive, false);
			assert.ok(
				!(await listMembershipSites(db, orgA.id, andres.membership.id, { activeOnly: true })).some(
					(r) => r.siteId === valencia.id
				)
			);
			// desactivar sigue permitido; reactivar no mientras la sede esté inactiva
			await setMembershipSiteActive(db, orgA.id, andres.membership.id, valencia.id, false);
			await rejectsWith(
				setMembershipSiteActive(db, orgA.id, andres.membership.id, valencia.id, true),
				'SITE_INACTIVE'
			);
			await rejectsWith(
				assignMembershipSite(db, orgA.id, andres.membership.id, valencia.id),
				'SITE_INACTIVE'
			);
			await setSiteActive(db, orgA.id, valencia.id, true);
			await assignMembershipSite(db, orgA.id, andres.membership.id, valencia.id);
		}
	);

	await t.test('membership inactiva y organización no operativa', async () => {
		const inactive = await member(orgA);
		await db
			.update(s.memberships)
			.set({ active: false })
			.where(eq(s.memberships.id, inactive.membership.id));
		await rejectsWith(
			assignMembershipSite(db, orgA.id, inactive.membership.id, madrid.id),
			'MEMBERSHIP_INACTIVE'
		);
		assert.deepEqual(await listMembershipSites(db, orgA.id, inactive.membership.id), []);
		const [orgS] = await db
			.insert(s.organizations)
			.values({ name: 'Susp', slug: randomUUID(), status: 'suspended' })
			.returning();
		await rejectsWith(
			assignMembershipSite(db, orgS.id, andres.membership.id, madrid.id),
			'ORGANIZATION_NOT_OPERATIONAL'
		);
		await rejectsWith(
			assignMembershipSite(db, randomUUID(), andres.membership.id, madrid.id),
			'ORGANIZATION_NOT_FOUND'
		);
	});

	await t.test('17-20. constraints de base de datos', async () => {
		const insert = (values) => db.insert(s.membershipSites).values(values);
		// UNIQUE (membership_id, site_id)
		await assert.rejects(
			insert({ organizationId: orgA.id, membershipId: andres.membership.id, siteId: valencia.id }),
			(e) => errorCode(e) === '23505'
		);
		// FK membership (cross-tenant / inexistente)
		for (const membershipId of [memberB.membership.id, randomUUID()])
			await assert.rejects(
				insert({ organizationId: orgA.id, membershipId, siteId: madrid.id }),
				(e) => errorCode(e) === '23503'
			);
		// FK site (cross-tenant / inexistente)
		for (const siteId of [siteB.id, randomUUID()])
			await assert.rejects(
				insert({ organizationId: orgA.id, membershipId: beatriz.membership.id, siteId }),
				(e) => errorCode(e) === '23503'
			);
		// organización declarada distinta de la del membership y la sede
		await assert.rejects(
			insert({ organizationId: orgB.id, membershipId: beatriz.membership.id, siteId: cerrada.id }),
			(e) => errorCode(e) === '23503'
		);
		// RESTRICT: ni la membership ni la sede asociadas se pueden borrar
		await assert.rejects(
			db.delete(s.memberships).where(eq(s.memberships.id, andres.membership.id)),
			(e) => ['23001', '23503'].includes(errorCode(e))
		);
		await assert.rejects(db.delete(s.sites).where(eq(s.sites.id, madrid.id)), (e) =>
			['23001', '23503'].includes(errorCode(e))
		);
		// defaults
		const [fresh] = await insert({
			organizationId: orgA.id,
			membershipId: beatriz.membership.id,
			siteId: cerrada.id
		}).returning();
		assert.equal(fresh.active, true);
		assert.ok(fresh.createdAt instanceof Date);
	});

	await t.test('22. rollback: un fallo no deja asociación', async () => {
		const carla = await member(orgA);
		await pg.exec(`
			CREATE FUNCTION test_fail_ms() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'forced failure'; END $$;
			CREATE TRIGGER test_fail_ms AFTER INSERT ON membership_sites
			FOR EACH ROW EXECUTE FUNCTION test_fail_ms();`);
		try {
			await assert.rejects(assignMembershipSite(db, orgA.id, carla.membership.id, madrid.id));
		} finally {
			await pg.exec('DROP TRIGGER test_fail_ms ON membership_sites; DROP FUNCTION test_fail_ms();');
		}
		assert.deepEqual(await listMembershipSites(db, orgA.id, carla.membership.id), []);
	});

	await t.test(
		'NO concede permisos: pertenencia a la sede no da acceso a incidencias',
		async () => {
			const { GET } = await server.ssrLoadModule('/src/routes/api/incidents/[id]/+server.ts');
			const { GET: listGET } = await server.ssrLoadModule('/src/routes/api/incidents/+server.ts');
			const user = await createCredentialUser(f);
			const [membership] = await db
				.insert(s.memberships)
				.values({ organizationId: orgA.id, userId: user.id })
				.returning();
			await grantPermission(f, {
				organizationId: orgA.id,
				membershipId: membership.id,
				permissionId: 'incidents:view_own'
			});
			await assignMembershipSite(db, orgA.id, membership.id, madrid.id);
			const session = await createSession(f, user.id, {
				expiresAt: new Date(Date.now() + 3600000)
			});
			const [incident] = await db
				.insert(s.incidents)
				.values({
					organizationId: orgA.id,
					incidentNumber: 900001,
					title: 'En Madrid',
					description: 'd',
					client: 'c',
					createdByUserId: andres.user.id,
					siteId: madrid.id
				})
				.returning();
			const url = new URL(
				`http://localhost/api/incidents/${incident.id}?organizationId=${orgA.id}`
			);
			const detail = await GET({
				url,
				params: { id: incident.id },
				request: new Request(url, { headers: { cookie: session.cookieHeader } })
			});
			assert.equal(detail.status, 403);
			const listUrl = new URL(
				`http://localhost/api/incidents?organizationId=${orgA.id}&queue=mine`
			);
			const mine = await (
				await listGET({
					url: listUrl,
					request: new Request(listUrl, { headers: { cookie: session.cookieHeader } })
				})
			).json();
			assert.ok(!mine.incidents.some((i) => i.id === incident.id));
			// y la tabla no participa en autorización ni en servicios de incidencias
			for (const file of [
				'src/lib/server/auth/authorization.ts',
				'src/lib/server/auth/incident-access.ts',
				'src/lib/server/services/incidents.ts'
			])
				assert.ok(!fs.readFileSync(file, 'utf8').includes('membershipSites'), file);
		}
	);
});

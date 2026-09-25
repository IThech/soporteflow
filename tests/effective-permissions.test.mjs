import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
	fixture,
	createCredentialUser,
	createSession,
	createTamperedCookie
} from './helpers/auth-fixture.mjs';

test('SoporteFlow — Etapa 5.4Q-D: permisos efectivos, /api/me y history view_own', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;
	const { resolveEffectivePermissions } = await server.ssrLoadModule(
		'/src/lib/server/auth/effective-permissions.ts'
	);
	const { PERMISSION_IDS } = await server.ssrLoadModule('/src/lib/server/auth/permissions.ts');
	const { ROLE_TEMPLATES } = await server.ssrLoadModule('/src/lib/server/auth/role-templates.ts');
	const { ensureOrganizationRoles } = await server.ssrLoadModule(
		'/src/lib/server/services/roles.ts'
	);
	const { createIncidentRecord, changeIncidentSite } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);
	const { GET: meGET } = await server.ssrLoadModule('/src/routes/api/me/+server.ts');
	const { GET: historyGET } = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/history/+server.ts'
	);
	const { GET: notesGET } = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/internal-notes/+server.ts'
	);
	const { GET: commentsGET } = await server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/comments/+server.ts'
	);
	// auth.ts uses TS parameter properties (not strippable by Node): load it through Vite
	const { getMe, AuthApiError } = await server.ssrLoadModule('/src/lib/api/auth.ts');

	const catalogOrder = (ids) => PERMISSION_IDS.filter((id) => ids.includes(id));
	const ADMIN = catalogOrder([...ROLE_TEMPLATES[0].permissionIds]);
	const TECHNICIAN = catalogOrder([...ROLE_TEMPLATES[1].permissionIds]);

	async function organization(status = 'active', name = 'Org ' + randomUUID().slice(0, 6)) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'eff-' + randomUUID(), status: 'active' })
			.returning();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		if (status !== 'active')
			await db.update(s.organizations).set({ status }).where(eq(s.organizations.id, org.id));
		return {
			org,
			admin: roles.find((r) => r.code === 'organization_admin'),
			tech: roles.find((r) => r.code === 'technician')
		};
	}
	async function customRole(org, permissionIds, values = {}) {
		const [role] = await db
			.insert(s.roles)
			.values({
				organizationId: org.id,
				name: 'Custom',
				code: 'c' + randomUUID(),
				isCustom: true,
				...values
			})
			.returning();
		for (const permissionId of permissionIds)
			await db.insert(s.rolePermissions).values({ roleId: role.id, permissionId });
		return role;
	}
	async function member(org, roles = [], options = {}) {
		const user = await createCredentialUser(f, options);
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: org.id, userId: user.id })
			.returning();
		for (const role of roles)
			await db.insert(s.roleAssignments).values({
				organizationId: org.id,
				membershipId: membership.id,
				roleId: role.id,
				scopeType: 'organization'
			});
		const session = await createSession(f, user.id, { expiresAt: new Date(Date.now() + 3600000) });
		return { user, membership, headers: session.headers, cookie: session.cookieHeader };
	}
	async function me(cookie, query = '', extraHeaders = {}) {
		const url = new URL(`http://localhost/api/me${query}`);
		const headers = new Headers(extraHeaders);
		if (cookie) headers.set('cookie', cookie);
		const response = await meGET({ url, request: new Request(url, { headers }) });
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null, text };
	}
	const caps = async (who, org) =>
		(await me(who.cookie, `?organizationId=${org.id}`)).json.activeOrganization.capabilities;

	const A = await organization('active', 'Alfa');
	const B = await organization('active', 'Beta');

	// =========================================================================
	// Resolver de permisos efectivos
	// =========================================================================
	await t.test('resolver: unión multi-rol, sin duplicados y en orden de catálogo', async () => {
		const roleSites = await customRole(A.org, ['sites:view', 'categories:view']);
		const roleCategories = await customRole(A.org, ['categories:view']);
		const who = await member(A.org, [roleCategories, roleSites]);
		assert.deepEqual(await resolveEffectivePermissions(who.headers, A.org.id), [
			'sites:view',
			'categories:view'
		]);
		const both = await member(A.org, [A.tech, roleSites]);
		const effective = await resolveEffectivePermissions(both.headers, A.org.id);
		assert.deepEqual(effective, TECHNICIAN, 'tech ∪ {sites:view, categories:view} = tech');
		assert.equal(new Set(effective).size, effective.length);
		assert.deepEqual(effective, catalogOrder(effective));
	});

	await t.test(
		'resolver: rol inactivo desaparece al instante; sin roles -> []; inaccesible -> null',
		async () => {
			const role = await customRole(A.org, ['sites:view']);
			const who = await member(A.org, [role]);
			assert.deepEqual(await resolveEffectivePermissions(who.headers, A.org.id), ['sites:view']);
			await db.update(s.roles).set({ active: false }).where(eq(s.roles.id, role.id));
			assert.deepEqual(await resolveEffectivePermissions(who.headers, A.org.id), []);
			assert.deepEqual(
				await resolveEffectivePermissions((await member(A.org)).headers, A.org.id),
				[]
			);
			assert.equal(await resolveEffectivePermissions(who.headers, B.org.id), null, 'otra org');
			assert.equal(
				await resolveEffectivePermissions(who.headers, randomUUID()),
				null,
				'inexistente'
			);
			assert.equal(await resolveEffectivePermissions(who.headers, 'x'), null, 'malformada');
			assert.equal(await resolveEffectivePermissions(new Headers(), A.org.id), null, 'sin sesión');
		}
	);

	await t.test(
		'resolver: divergencia real rol/plantilla (runtime = role_permissions)',
		async () => {
			const [org] = await db
				.insert(s.organizations)
				.values({ name: 'Div', slug: 'div-' + randomUUID(), status: 'active' })
				.returning();
			const { roles } = await ensureOrganizationRoles(db, org.id);
			const tech = roles.find((r) => r.code === 'technician');
			await db.insert(s.rolePermissions).values({ roleId: tech.id, permissionId: 'sites:manage' });
			await db
				.delete(s.rolePermissions)
				.where(
					and(
						eq(s.rolePermissions.roleId, tech.id),
						eq(s.rolePermissions.permissionId, 'teams:view')
					)
				);
			const who = await member(org, [tech]);
			const expected = catalogOrder([
				...TECHNICIAN.filter((p) => p !== 'teams:view'),
				'sites:manage'
			]);
			assert.deepEqual(await resolveEffectivePermissions(who.headers, org.id), expected);
			// la plantilla no cambió
			const templatePerms = await db
				.select()
				.from(s.roleTemplatePermissions)
				.where(eq(s.roleTemplatePermissions.roleTemplateId, 'tpl_technician'));
			assert.ok(templatePerms.some((p) => p.permissionId === 'teams:view'));
		}
	);

	await t.test(
		'resolver: desconocidos, platform:* y ámbitos granulares nunca se exponen',
		async () => {
			await db
				.insert(s.permissions)
				.values([
					{
						id: 'custom:thing',
						name: 'Custom',
						category: 'custom',
						allowedScopeTypes: ['organization']
					},
					{
						id: 'platform:manage',
						name: 'Platform',
						category: 'platform',
						allowedScopeTypes: ['organization']
					}
				])
				.onConflictDoNothing();
			const weird = await customRole(A.org, ['custom:thing', 'platform:manage', 'teams:view']);
			const who = await member(A.org, [weird]);
			assert.deepEqual(await resolveEffectivePermissions(who.headers, A.org.id), ['teams:view']);
			// grants de sede/equipo: se amplían los scopes permitidos solo en esta DB para que existan
			await db
				.update(s.permissions)
				.set({ allowedScopeTypes: ['organization', 'site', 'team'] })
				.where(eq(s.permissions.id, 'categories:view'));
			const [site] = await db
				.insert(s.sites)
				.values({ organizationId: A.org.id, name: 'Sede ' + randomUUID().slice(0, 5) })
				.returning();
			const [team] = await db
				.insert(s.teams)
				.values({ organizationId: A.org.id, name: 'Equipo ' + randomUUID().slice(0, 5) })
				.returning();
			const scoped = await customRole(A.org, ['categories:view']);
			const scopedMember = await member(A.org);
			await db.insert(s.roleAssignments).values([
				{
					organizationId: A.org.id,
					membershipId: scopedMember.membership.id,
					roleId: scoped.id,
					scopeType: 'site',
					siteId: site.id
				},
				{
					organizationId: A.org.id,
					membershipId: scopedMember.membership.id,
					roleId: scoped.id,
					scopeType: 'team',
					teamId: team.id
				}
			]);
			try {
				assert.deepEqual(await resolveEffectivePermissions(scopedMember.headers, A.org.id), []);
				assert.deepEqual(await caps(scopedMember, A.org), []);
			} finally {
				await db
					.update(s.permissions)
					.set({ allowedScopeTypes: ['organization'] })
					.where(eq(s.permissions.id, 'categories:view'));
			}
		}
	);

	// =========================================================================
	// /api/me (1-20)
	// =========================================================================
	await t.test(
		'/api/me 1-3: sin sesión 401; sin organizationId contrato intacto; UUID inválido 400',
		async () => {
			for (const cookie of ['', createTamperedCookie()])
				assert.equal((await me(cookie)).status, 401);
			assert.equal((await me('', `?organizationId=${A.org.id}`)).status, 401);
			const who = await member(A.org, [A.admin]);
			const res = await me(who.cookie);
			assert.equal(res.status, 200);
			assert.deepEqual(Object.keys(res.json).sort(), ['organizations', 'user']);
			assert.deepEqual(
				res.json.organizations.map((o) => o.id),
				[A.org.id]
			);
			for (const query of [
				'?organizationId=x',
				'?organizationId=',
				`?organizationId=${A.org.id}&organizationId=${A.org.id}`
			]) {
				const bad = await me(who.cookie, query);
				assert.equal(bad.status, 400, query);
				assert.equal(bad.json.error.code, 'INVALID_INPUT');
			}
			// parámetros desconocidos se siguen ignorando (contrato 5.4A)
			assert.equal((await me(who.cookie, `?userId=${randomUUID()}`)).status, 200);
		}
	);

	await t.test(
		'/api/me 4, 9, 20: Admin con capabilities exactas de sus role_permissions y orden determinista',
		async () => {
			const who = await member(A.org, [A.admin]);
			const res = await me(who.cookie, `?organizationId=${A.org.id}`);
			assert.equal(res.status, 200);
			assert.deepEqual(Object.keys(res.json).sort(), [
				'activeOrganization',
				'organizations',
				'user'
			]);
			assert.deepEqual(Object.keys(res.json.activeOrganization).sort(), [
				'capabilities',
				'id',
				'name',
				'slug'
			]);
			assert.equal(res.json.activeOrganization.id, A.org.id);
			const rolePerms = (
				await db.select().from(s.rolePermissions).where(eq(s.rolePermissions.roleId, A.admin.id))
			).map((r) => r.permissionId);
			assert.deepEqual(res.json.activeOrganization.capabilities, catalogOrder(rolePerms));
			assert.deepEqual(res.json.activeOrganization.capabilities, ADMIN);
			for (const leak of [
				A.admin.id,
				who.membership.id,
				'organization_admin',
				'Administrador',
				'roleId',
				'assignment',
				'membershipId'
			])
				assert.ok(!res.text.includes(leak), leak);
			assert.deepEqual(
				(await me(who.cookie, `?organizationId=${A.org.id}`)).json,
				res.json,
				'estable'
			);
		}
	);

	await t.test(
		'/api/me 10-16: Technician, multi-rol, rol inactivo, divergencia y desconocidos',
		async () => {
			const tech = await member(A.org, [A.tech]);
			const techCaps = await caps(tech, A.org);
			assert.deepEqual(techCaps, TECHNICIAN);
			for (const denied of [
				'sites:manage',
				'categories:manage',
				'roles:assign',
				'memberships:create',
				'identities:create'
			])
				assert.ok(!techCaps.includes(denied), denied);
			const multi = await member(A.org, [
				await customRole(A.org, ['sites:view']),
				await customRole(A.org, ['categories:view', 'sites:view'])
			]);
			assert.deepEqual(await caps(multi, A.org), ['sites:view', 'categories:view']);
			const role = await customRole(A.org, ['teams:view', 'custom:thing', 'platform:manage']);
			const withRole = await member(A.org, [role]);
			assert.deepEqual(await caps(withRole, A.org), ['teams:view']);
			await db.update(s.roles).set({ active: false }).where(eq(s.roles.id, role.id));
			assert.deepEqual(await caps(withRole, A.org), []);
		}
	);

	await t.test(
		'/api/me 5-8: org ajena, membership inactiva, org suspendida -> mismo 403; sin roles -> []',
		async () => {
			const who = await member(A.org, [A.admin]);
			const expected = { error: { code: 'FORBIDDEN', message: 'Organization not accessible.' } };
			const suspended = await organization('suspended');
			const suspendedMember = await member(suspended.org, [suspended.admin]);
			const inactive = await member(A.org, [A.admin]);
			await db
				.update(s.memberships)
				.set({ active: false })
				.where(eq(s.memberships.id, inactive.membership.id));
			for (const [cookie, orgId] of [
				[who.cookie, B.org.id],
				[who.cookie, randomUUID()],
				[suspendedMember.cookie, suspended.org.id],
				[inactive.cookie, A.org.id]
			]) {
				const res = await me(cookie, `?organizationId=${orgId}`);
				assert.equal(res.status, 403);
				assert.deepEqual(res.json, expected);
			}
			assert.deepEqual(await caps(await member(A.org), A.org), []);
			// usuario inactivo -> 401
			const inactiveUser = await member(A.org, [A.admin]);
			await db.update(s.users).set({ active: false }).where(eq(s.users.id, inactiveUser.user.id));
			assert.equal((await me(inactiveUser.cookie, `?organizationId=${A.org.id}`)).status, 401);
			// cabeceras de identidad/tenant ignoradas
			const spoofed = await me(who.cookie, `?organizationId=${A.org.id}`, {
				'x-user-id': randomUUID(),
				'x-organization-id': B.org.id
			});
			assert.equal(spoofed.json.activeOrganization.id, A.org.id);
			assert.deepEqual(spoofed.json.activeOrganization.capabilities, ADMIN);
		}
	);

	await t.test(
		'fail-closed: sin rol, rol sin permisos, permiso inexistente -> endpoints protegidos 403',
		async () => {
			const { GET: sitesGET } = await server.ssrLoadModule('/src/routes/api/sites/+server.ts');
			const url = new URL(`http://localhost/api/sites?organizationId=${A.org.id}`);
			const status = async (who) =>
				(await sitesGET({ url, request: new Request(url, { headers: who.headers }) })).status;
			assert.equal(await status(await member(A.org)), 403, 'sin rol');
			assert.equal(
				await status(await member(A.org, [await customRole(A.org, [])])),
				403,
				'rol sin permisos'
			);
			assert.equal(
				await status(await member(A.org, [await customRole(A.org, ['custom:thing'])])),
				403,
				'permiso no canónico'
			);
			assert.equal(await status(await member(A.org, [A.tech])), 200, 'control positivo');
		}
	);

	// =========================================================================
	// History (21-28) con roles reales
	// =========================================================================
	const [site] = await db
		.insert(s.sites)
		.values({ organizationId: A.org.id, name: 'Sede historia' })
		.returning();
	const creator = await member(A.org, [A.admin]);
	const techOwnRole = await customRole(A.org, ['incidents:view_own']);
	const ownTech = await member(A.org, [techOwnRole]);
	const otherTech = await member(A.org, [techOwnRole]);
	async function incident(values = {}, org = A.org, by = creator) {
		const { incident: created } = await createIncidentRecord(
			db,
			{ organizationId: org.id, creatorUserId: by.user.id },
			{ title: 'H', description: 'H', client: 'H' }
		);
		if (Object.keys(values).length)
			await db.update(s.incidents).set(values).where(eq(s.incidents.id, created.id));
		return created;
	}
	async function history(who, target, org = A.org) {
		const url = new URL(
			`http://localhost/api/incidents/${target.id}/history?organizationId=${org.id}`
		);
		const response = await historyGET({
			url,
			params: { id: target.id },
			request: new Request(url, { headers: who.headers })
		});
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null, text };
	}

	await t.test(
		'history 21-22, 27-28: view_all (Technician real) y view_own asignada; safe DTO; closed legible',
		async () => {
			const mine = await incident({ assignedToUserId: ownTech.user.id });
			await changeIncidentSite(
				db,
				{ organizationId: A.org.id, actorUserId: creator.user.id, access: {} },
				mine.id,
				{ siteId: site.id }
			);
			const techReal = await member(A.org, [A.tech]);
			for (const who of [techReal, creator, ownTech]) {
				const res = await history(who, mine);
				assert.equal(res.status, 200);
				assert.ok(res.json.items.some((i) => i.type === 'created'));
				assert.ok(res.json.items.some((i) => i.type === 'site_changed'));
				for (const leak of [site.id, 'payload', 'reason', 'fromSiteId', A.org.id, creator.user.id])
					assert.ok(!res.text.includes(leak), leak);
			}
			await db.update(s.incidents).set({ status: 'closed' }).where(eq(s.incidents.id, mine.id));
			assert.equal((await history(ownTech, mine)).status, 200, 'closed sigue legible');
		}
	);

	await t.test(
		'history 23-26: view_own ajena/sin asignar -> 404 como inexistente; sin view -> 403; cross-tenant -> 404',
		async () => {
			const others = await incident({ assignedToUserId: otherTech.user.id });
			const unassigned = await incident();
			const missing = await history(ownTech, { id: randomUUID() });
			for (const target of [others, unassigned]) {
				const res = await history(ownTech, target);
				assert.equal(res.status, 404);
				assert.deepEqual(res.json, missing.json, 'indistinguible de inexistente');
			}
			const noView = await member(A.org, [await customRole(A.org, ['sites:view'])]);
			assert.equal((await history(noView, others)).status, 403);
			const foreign = await incident({}, B.org, await member(B.org, [B.admin]));
			assert.equal((await history(creator, foreign)).status, 404);
			assert.equal((await history(creator, foreign, B.org)).status, 403);
		}
	);

	await t.test('regresión: notas internas y comentarios sin cambios de semántica', async () => {
		const target = await incident({ assignedToUserId: ownTech.user.id });
		const call = async (handler, path, who) => {
			const url = new URL(
				`http://localhost/api/incidents/${target.id}/${path}?organizationId=${A.org.id}`
			);
			return (
				await handler({
					url,
					params: { id: target.id },
					request: new Request(url, { headers: who.headers })
				})
			).status;
		};
		// notas: permiso propio e independiente; view_own/view_all no bastan
		assert.equal(await call(notesGET, 'internal-notes', ownTech), 403);
		assert.equal(await call(notesGET, 'internal-notes', await member(A.org, [A.tech])), 200);
		assert.equal(
			await call(
				notesGET,
				'internal-notes',
				await member(A.org, [await customRole(A.org, ['incidents:view_internal_notes'])])
			),
			200
		);
		// comentarios: acceso a la incidencia (view_own asignada sí)
		assert.equal(await call(commentsGET, 'comments', ownTech), 200);
		assert.equal(await call(commentsGET, 'comments', otherTech), 403);
	});

	// =========================================================================
	// Cliente getMe
	// =========================================================================
	await t.test(
		'cliente getMe: sin org intacto; con org valida y reconstruye activeOrganization',
		async () => {
			const ORG = randomUUID();
			const calls = [];
			const payload = (active) => ({
				user: { id: 'u', name: 'n', email: 'e' },
				organizations: [],
				...(active ? { activeOrganization: active } : {})
			});
			const fetchWith = (body) => async (url) => {
				calls.push(url);
				return new Response(JSON.stringify(body), { status: 200 });
			};
			const plain = await getMe(fetchWith(payload()));
			assert.equal(calls.at(-1), '/api/me');
			assert.equal(plain.activeOrganization, undefined);
			const ok = await getMe(
				fetchWith(
					payload({
						id: ORG,
						name: 'A',
						slug: 'a',
						capabilities: ['sites:view', 'teams:view'],
						roles: ['admin']
					})
				),
				{ organizationId: ORG }
			);
			assert.equal(calls.at(-1), `/api/me?organizationId=${ORG}`);
			assert.deepEqual(ok.activeOrganization, {
				id: ORG,
				name: 'A',
				slug: 'a',
				capabilities: ['sites:view', 'teams:view']
			});
			for (const bad of [
				undefined,
				{ id: randomUUID(), name: 'A', slug: 'a', capabilities: [] },
				{ id: ORG, name: 'A', slug: 'a', capabilities: 'sites:view' },
				{ id: ORG, name: 'A', slug: 'a', capabilities: [5] },
				{ id: ORG, name: 'A', slug: 'a', capabilities: ['Sites View'] },
				{ id: ORG, name: 'A', slug: 'a', capabilities: ['sites:view', 'sites:view'] }
			])
				await assert.rejects(
					getMe(fetchWith(payload(bad)), { organizationId: ORG }),
					(e) => e instanceof AuthApiError && e.code === 'INVALID_PAYLOAD'
				);
			const before = calls.length;
			await assert.rejects(
				getMe(fetchWith(payload()), { organizationId: 'x' }),
				(e) => e.code === 'INVALID_INPUT' && e.status === 0
			);
			assert.equal(calls.length, before);
		}
	);
});

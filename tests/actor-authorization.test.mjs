import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

/**
 * 5.4W-A H1 (confirmed on real PostgreSQL, tests/concurrency #2): administrative mutations must be
 * authorized INSIDE their transaction, after the organization lock, with the actor's current
 * capabilities. PGlite cannot interleave two sessions, so the race itself is proven only by the
 * real PostgreSQL suite; these tests pin the primitive's semantics and every route's wiring.
 */
test('SoporteFlow — 5.4W-A: autorización revalidada dentro de la transacción (H1)', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;
	const { ensureOrganizationRoles, createCustomRole, countTenantAdministrators } =
		await server.ssrLoadModule('/src/lib/server/services/roles.ts');
	const { revokeRoleFromMembership } = await server.ssrLoadModule(
		'/src/lib/server/services/memberships.ts'
	);
	const tx = await server.ssrLoadModule('/src/lib/server/auth/transactional-authorization.ts');
	const { PERMISSION_IDS } = await server.ssrLoadModule('/src/lib/server/auth/permissions.ts');
	const revokeRoute = await server.ssrLoadModule(
		'/src/routes/api/memberships/[id]/roles/[roleId]/+server.ts'
	);
	const assignRoute = await server.ssrLoadModule(
		'/src/routes/api/memberships/[id]/roles/+server.ts'
	);
	const { withActorAuthorization, authorizeActionInTransaction, isActorAuthorizationError } = tx;

	async function organization() {
		const [org] = await db
			.insert(s.organizations)
			.values({ name: 'H1', slug: 'h1-' + randomUUID(), status: 'active' })
			.returning();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		const byCode = (c) => roles.find((r) => r.code === c);
		return { org, id: org.id, admin: byCode('organization_admin'), tech: byCode('technician') };
	}
	async function member(o, roles) {
		const { user } = await createCredentialUser(f, { email: `h1-${randomUUID()}@example.test` });
		const [membership] = await db
			.insert(s.memberships)
			.values({ organizationId: o.id, userId: user.id, active: true })
			.returning();
		for (const role of roles)
			await db.insert(s.roleAssignments).values({
				organizationId: o.id,
				membershipId: membership.id,
				roleId: role.id,
				scopeType: 'organization'
			});
		const session = await createSession(f, user.id, {
			expiresAt: new Date(Date.now() + 3_600_000)
		});
		return { userId: user.id, membershipId: membership.id, cookie: session.cookieHeader };
	}
	const assignments = async (m, roleId) =>
		(
			await db
				.select()
				.from(s.roleAssignments)
				.where(
					and(
						eq(s.roleAssignments.membershipId, m.membershipId),
						eq(s.roleAssignments.roleId, roleId)
					)
				)
		).length;
	const demote = (m, o) =>
		db
			.delete(s.roleAssignments)
			.where(
				and(
					eq(s.roleAssignments.membershipId, m.membershipId),
					eq(s.roleAssignments.roleId, o.admin.id)
				)
			);
	const revokeCall = (actor, o, target, roleId) => {
		const url = new URL(
			`http://localhost/api/memberships/${target.membershipId}/roles/${roleId}?organizationId=${o.id}`
		);
		return revokeRoute.DELETE({
			url,
			params: { id: target.membershipId, roleId },
			request: new Request(url, { method: 'DELETE', headers: { cookie: actor.cookie } })
		});
	};

	await t.test(
		'primitiva: permiso perdido -> falla cerrado; el callback nunca se ejecuta',
		async () => {
			const o = await organization();
			const x = await member(o, [o.admin]);
			await member(o, [o.admin]);
			await demote(x, o);
			let ran = false;
			await assert.rejects(
				withActorAuthorization(
					db,
					{
						userId: x.userId,
						organizationId: o.id,
						permissionIds: ['roles:assign'],
						lock: 'update'
					},
					async () => {
						ran = true;
					}
				),
				(e) => isActorAuthorizationError(e) && e.code === 'ACTOR_NOT_AUTHORIZED'
			);
			assert.equal(ran, false);
		}
	);

	await t.test(
		'primitiva: permiso vigente -> capacidades ACTUALES (no el snapshot previo)',
		async () => {
			const o = await organization();
			const x = await member(o, [o.tech]);
			const current = await withActorAuthorization(
				db,
				{
					userId: x.userId,
					organizationId: o.id,
					permissionIds: ['incidents:edit'],
					lock: 'share'
				},
				async (_tx, actorPermissions) => actorPermissions
			);
			assert.ok(current.includes('incidents:edit'));
			assert.ok(!current.includes('roles:assign'), 'técnico: sin permisos de administración');
			assert.deepEqual(
				current,
				PERMISSION_IDS.filter((p) => current.includes(p)),
				'orden canónico'
			);
		}
	);

	await t.test(
		'primitiva: todos los permisos requeridos, membresía/usuario/org activos',
		async () => {
			const o = await organization();
			const x = await member(o, [o.tech]);
			const check = (permissionIds) =>
				db.transaction((t2) =>
					authorizeActionInTransaction(t2, {
						userId: x.userId,
						organizationId: o.id,
						permissionIds
					})
				);
			assert.ok(await check(['incidents:edit']));
			assert.equal(await check(['incidents:edit', 'roles:assign']), null, 'todos requeridos');
			assert.equal(await check([]), null, 'sin permisos pedidos: cerrado');
			await db
				.update(s.memberships)
				.set({ active: false })
				.where(eq(s.memberships.id, x.membershipId));
			assert.equal(await check(['incidents:edit']), null, 'membresía inactiva');
			await db
				.update(s.memberships)
				.set({ active: true })
				.where(eq(s.memberships.id, x.membershipId));
			await db.update(s.users).set({ active: false }).where(eq(s.users.id, x.userId));
			assert.equal(await check(['incidents:edit']), null, 'usuario inactivo');
			await db.update(s.users).set({ active: true }).where(eq(s.users.id, x.userId));
			await db
				.update(s.organizations)
				.set({ status: 'suspended' })
				.where(eq(s.organizations.id, o.id));
			assert.equal(await check(['incidents:edit']), null, 'organización suspendida');
			const other = await organization();
			assert.equal(
				await db.transaction((t2) =>
					authorizeActionInTransaction(t2, {
						userId: x.userId,
						organizationId: other.id,
						permissionIds: ['incidents:edit']
					})
				),
				null,
				'otra organización'
			);
		}
	);

	await t.test('delegación monótona con capacidades releídas en la transacción', async () => {
		const o = await organization();
		const x = await member(o, [o.admin]);
		const target = await member(o, [o.admin]);
		// custom role that can assign roles but does not hold every admin permission
		const limited = await createCustomRole(db, o.id, PERMISSION_IDS, {
			code: 'limited_' + randomUUID().slice(0, 6),
			name: 'Limited',
			permissions: ['roles:assign', 'incidents:create']
		});
		await db.insert(s.roleAssignments).values({
			organizationId: o.id,
			membershipId: x.membershipId,
			roleId: limited.id,
			scopeType: 'organization'
		});
		await demote(x, o); // x keeps roles:assign (custom role) but lost the full admin role
		// even with a stale "ALL" snapshot, the route path delegates with in-tx capabilities
		await assert.rejects(
			withActorAuthorization(
				db,
				{ userId: x.userId, organizationId: o.id, permissionIds: ['roles:assign'], lock: 'update' },
				(t2, actorPermissions) =>
					revokeRoleFromMembership(t2, o.id, target.membershipId, o.admin.id, actorPermissions)
			),
			(e) => e.code === 'PERMISSION_NOT_DELEGABLE'
		);
		assert.equal(await assignments(target, o.admin.id), 1);
	});

	await t.test('rollback: un fallo dentro de la mutación no deja efectos parciales', async () => {
		const o = await organization();
		const x = await member(o, [o.admin]);
		const target = await member(o, [o.admin]);
		await assert.rejects(
			withActorAuthorization(
				db,
				{ userId: x.userId, organizationId: o.id, permissionIds: ['roles:assign'], lock: 'update' },
				async (t2, actorPermissions) => {
					await revokeRoleFromMembership(
						t2,
						o.id,
						target.membershipId,
						o.admin.id,
						actorPermissions
					);
					throw new Error('forced after the write');
				}
			),
			/forced after the write/
		);
		assert.equal(await assignments(target, o.admin.id), 1, 'revocación revertida');
	});

	await t.test('ruta: actor degradado -> 403, objetivo intacto (secuencial)', async () => {
		const o = await organization();
		const x = await member(o, [o.admin]);
		const target = await member(o, [o.admin]);
		await member(o, [o.admin]);
		await demote(x, o);
		const res = await revokeCall(x, o, target, o.admin.id);
		assert.equal(res.status, 403);
		assert.equal(await assignments(target, o.admin.id), 1);
	});

	await t.test('ruta: actor con permiso -> la operación sigue funcionando', async () => {
		const o = await organization();
		const x = await member(o, [o.admin]);
		const target = await member(o, [o.admin]);
		assert.equal((await revokeCall(x, o, target, o.admin.id)).status, 204);
		assert.equal(await assignments(target, o.admin.id), 0);
		const url = new URL(
			`http://localhost/api/memberships/${target.membershipId}/roles?organizationId=${o.id}`
		);
		const res = await assignRoute.POST({
			url,
			params: { id: target.membershipId },
			request: new Request(url, {
				method: 'POST',
				headers: { cookie: x.cookie, 'content-type': 'application/json' },
				body: JSON.stringify({ roleId: o.admin.id })
			})
		});
		assert.equal(res.status, 201);
		assert.equal(await assignments(target, o.admin.id), 1);
	});

	await t.test('ruta: el último administrador sigue protegido (409)', async () => {
		const o = await organization();
		const x = await member(o, [o.admin]);
		const res = await revokeCall(x, o, x, o.admin.id);
		assert.equal(res.status, 409);
		assert.equal((await res.json()).error.code, 'LAST_ADMIN_REQUIRED');
		assert.equal(await countTenantAdministrators(db, o.id), 1);
	});

	await t.test(
		'frontera: toda mutación administrativa pasa por la revalidación transaccional',
		() => {
			const routes = {
				'src/routes/api/memberships/[id]/roles/+server.ts': ['POST'],
				'src/routes/api/memberships/[id]/roles/[roleId]/+server.ts': ['DELETE'],
				'src/routes/api/roles/+server.ts': ['POST'],
				'src/routes/api/roles/[id]/+server.ts': ['PATCH'],
				'src/routes/api/invitations/+server.ts': ['POST'],
				'src/routes/api/invitations/[id]/+server.ts': ['DELETE'],
				'src/routes/api/invitations/[id]/resend/+server.ts': ['POST'],
				'src/routes/api/sla-policies/+server.ts': ['POST'],
				'src/routes/api/sla-policies/[id]/+server.ts': ['PATCH'],
				'src/routes/api/categories/+server.ts': ['POST'],
				'src/routes/api/categories/[id]/+server.ts': ['PATCH'],
				'src/routes/api/sites/+server.ts': ['POST'],
				'src/routes/api/sites/[id]/+server.ts': ['PATCH'],
				'src/routes/api/webhooks/+server.ts': ['POST'],
				'src/routes/api/webhooks/[id]/+server.ts': ['PATCH', 'DELETE'],
				'src/routes/api/webhooks/[id]/rotate-secret/+server.ts': ['POST'],
				'src/routes/api/automations/http.ts': ['create', 'patch', 'disable']
			};
			const mutating =
				/\b(assignRoleToMembership|revokeRoleFromMembership|createCustomRole|updateCustomRole|createInvitation|resendInvitation|revokeInvitation|createSlaPolicy|updateSlaPolicy|createCategory|updateCategory|setCategoryActive|createSite|updateSite|setSiteActive|createWebhookSubscription|updateWebhookSubscription|deactivateWebhookSubscription|rotateWebhookSecret|createAutomationRule|updateAutomationRule)\(\s*db\b/;
			for (const file of Object.keys(routes)) {
				const source = fs.readFileSync(file, 'utf8');
				assert.match(source, /withActorAuthorization|asWebhookManager/, file);
				assert.doesNotMatch(
					source,
					mutating,
					`${file}: mutating service called with db (outside tx)`
				);
				assert.doesNotMatch(
					source,
					/auth\.actorPermissions/,
					`${file}: pre-transaction snapshot passed to a mutation`
				);
			}
		}
	);
});

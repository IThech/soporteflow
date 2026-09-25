import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { fixture, createCredentialUser, createSession } from './helpers/auth-fixture.mjs';

test('SoporteFlow — Etapa 5.4R-B: roles personalizados y mutaciones', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;
	const {
		ensureOrganizationRoles,
		getOrganizationRole,
		listOrganizationRoles,
		createCustomRole,
		updateCustomRole
	} = await server.ssrLoadModule('/src/lib/server/services/roles.ts');
	const { PERMISSION_IDS } = await server.ssrLoadModule('/src/lib/server/auth/permissions.ts');
	const { ROLE_TEMPLATES } = await server.ssrLoadModule('/src/lib/server/auth/role-templates.ts');
	const { resolveEffectivePermissions } = await server.ssrLoadModule(
		'/src/lib/server/auth/effective-permissions.ts'
	);
	const { IncidentServiceError } = await server.ssrLoadModule(
		'/src/lib/server/services/incidents.ts'
	);
	const rolesRoute = await server.ssrLoadModule('/src/routes/api/roles/+server.ts');
	const roleRoute = await server.ssrLoadModule('/src/routes/api/roles/[id]/+server.ts');

	const catalogOrder = (ids) => PERMISSION_IDS.filter((id) => ids.includes(id));
	const ADMIN = catalogOrder([...ROLE_TEMPLATES[0].permissionIds]);
	const TECHNICIAN = catalogOrder([...ROLE_TEMPLATES[1].permissionIds]);
	const ROLE_KEYS = [
		'active',
		'code',
		'description',
		'id',
		'isCustom',
		'name',
		'permissions',
		'templateId'
	];
	let seq = 0;
	const code = () => `custom_${++seq}_${randomUUID().slice(0, 6).replace(/-/g, '')}`;

	async function rejectsWith(operation, expected) {
		await assert.rejects(operation, (error) => {
			assert.ok(error instanceof IncidentServiceError, `esperado IncidentServiceError: ${error}`);
			assert.equal(error.code, expected);
			return true;
		});
	}
	async function organization(name, status = 'active') {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'rb-' + randomUUID(), status: 'active' })
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
	async function rawRole(org, permissionIds, values = {}) {
		const [role] = await db
			.insert(s.roles)
			.values({ organizationId: org.id, name: 'Raw', code: code(), isCustom: true, ...values })
			.returning();
		for (const permissionId of permissionIds)
			await db.insert(s.rolePermissions).values({ roleId: role.id, permissionId });
		return role;
	}
	async function member(org, roles = []) {
		const user = await createCredentialUser(f);
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
	async function storedPermissions(roleId) {
		return (
			await db
				.select({ id: s.rolePermissions.permissionId })
				.from(s.rolePermissions)
				.where(eq(s.rolePermissions.roleId, roleId))
		)
			.map((r) => r.id)
			.sort();
	}
	async function assignmentsSnapshot(roleId) {
		return (
			await db.select().from(s.roleAssignments).where(eq(s.roleAssignments.roleId, roleId))
		).map((a) => ({ ...a }));
	}
	async function call(handler, path, options = {}) {
		const { cookie, organizationId, query = '', id, body, rawBody, contentType } = options;
		const qs = organizationId === null ? '' : `organizationId=${organizationId}`;
		const url = new URL(`http://localhost${path}?${qs}${query}`);
		const headers = new Headers();
		if (cookie) headers.set('cookie', cookie);
		const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
		if (payload !== undefined) headers.set('content-type', contentType ?? 'application/json');
		const method = handler === rolesRoute.POST ? 'POST' : 'PATCH';
		const response = await handler({
			url,
			params: id === undefined ? {} : { id },
			request: new Request(url, { method, headers, body: payload })
		});
		const text = await response.text();
		return {
			status: response.status,
			json: text ? JSON.parse(text) : null,
			text,
			headers: response.headers
		};
	}
	const post = (who, organizationId, body, extra = {}) =>
		call(rolesRoute.POST, '/api/roles', { cookie: who?.cookie, organizationId, body, ...extra });
	const patch = (who, organizationId, id, body, extra = {}) =>
		call(roleRoute.PATCH, `/api/roles/${id}`, {
			cookie: who?.cookie,
			organizationId,
			id,
			body,
			...extra
		});

	const A = await organization('Alfa');
	const B = await organization('Beta');
	const adminA = await member(A.org, [A.admin]);
	const techA = await member(A.org, [A.tech]);
	const adminB = await member(B.org, [B.admin]);

	// =========================================================================
	// Servicio: creación (1-12)
	// =========================================================================
	await t.test(
		'1. crea rol custom activo, isCustom=true, templateId=null, permisos reales',
		async () => {
			const c = code();
			const role = await createCustomRole(db, A.org.id, ADMIN, {
				name: '  Supervisor  ',
				code: c,
				description: '  Supervisa  ',
				permissions: ['sites:view', 'incidents:view_all']
			});
			assert.deepEqual(Object.keys(role).sort(), ROLE_KEYS);
			assert.equal(role.code, c);
			assert.equal(role.name, 'Supervisor');
			assert.equal(role.description, 'Supervisa');
			assert.equal(role.isCustom, true);
			assert.equal(role.templateId, null);
			assert.equal(role.active, true);
			assert.deepEqual(role.permissions, catalogOrder(['sites:view', 'incidents:view_all']));
			assert.deepEqual(await getOrganizationRole(db, A.org.id, role.id), role);
			assert.deepEqual(await storedPermissions(role.id), ['incidents:view_all', 'sites:view']);
		}
	);

	await t.test('2. rol sin permisos permitido; descripción vacía o ausente -> null', async () => {
		const a = await createCustomRole(db, A.org.id, ADMIN, {
			name: 'Vacío',
			code: code(),
			permissions: []
		});
		assert.deepEqual(a.permissions, []);
		assert.equal(a.description, null);
		const b = await createCustomRole(db, A.org.id, ADMIN, {
			name: 'Vacío 2',
			code: code(),
			description: '   ',
			permissions: []
		});
		assert.equal(b.description, null);
	});

	await t.test('3. code inválido se rechaza sin normalizar (INVALID_INPUT)', async () => {
		for (const bad of [
			'Custom',
			'custom role',
			'custom-role',
			'_custom',
			'custom_',
			'custom__role',
			'1custom',
			'ab',
			'a'.repeat(51),
			'  custom',
			'custóm',
			'',
			null,
			42
		])
			await rejectsWith(
				createCustomRole(db, A.org.id, ADMIN, { name: 'X', code: bad, permissions: [] }),
				'INVALID_INPUT'
			);
		const ok = await createCustomRole(db, A.org.id, ADMIN, {
			name: 'X',
			code: 'a'.repeat(50),
			permissions: []
		});
		assert.equal(ok.code, 'a'.repeat(50));
	});

	await t.test('4. códigos canónicos reservados -> ROLE_CODE_CONFLICT', async () => {
		for (const reserved of ['organization_admin', 'technician'])
			await rejectsWith(
				createCustomRole(db, A.org.id, ADMIN, { name: 'X', code: reserved, permissions: [] }),
				'ROLE_CODE_CONFLICT'
			);
	});

	await t.test(
		'5. code duplicado en la misma org -> ROLE_CODE_CONFLICT; otra org permitido',
		async () => {
			const c = code();
			await createCustomRole(db, A.org.id, ADMIN, { name: 'X', code: c, permissions: [] });
			await rejectsWith(
				createCustomRole(db, A.org.id, ADMIN, { name: 'Y', code: c, permissions: [] }),
				'ROLE_CODE_CONFLICT'
			);
			const other = await createCustomRole(db, B.org.id, ADMIN, {
				name: 'Y',
				code: c,
				permissions: []
			});
			assert.equal(other.code, c);
		}
	);

	await t.test('6. name inválido (vacío, >100, no string) -> INVALID_INPUT', async () => {
		for (const bad of ['', '   ', 'x'.repeat(101), null, 1, undefined])
			await rejectsWith(
				createCustomRole(db, A.org.id, ADMIN, { name: bad, code: code(), permissions: [] }),
				'INVALID_INPUT'
			);
	});

	await t.test('7. description inválida (>1000, no string) -> INVALID_INPUT', async () => {
		for (const bad of ['x'.repeat(1001), 5, ['a']])
			await rejectsWith(
				createCustomRole(db, A.org.id, ADMIN, {
					name: 'X',
					code: code(),
					description: bad,
					permissions: []
				}),
				'INVALID_INPUT'
			);
	});

	await t.test(
		'8. permissions: no array, duplicados, desconocidos, platform:* -> INVALID_INPUT',
		async () => {
			for (const bad of [
				undefined,
				null,
				'sites:view',
				{ 0: 'sites:view' },
				['sites:view', 'sites:view'],
				['sites:unknown'],
				['platform:manage'],
				['SITES:VIEW'],
				[1]
			])
				await rejectsWith(
					createCustomRole(db, A.org.id, ADMIN, { name: 'X', code: code(), permissions: bad }),
					'INVALID_INPUT'
				);
		}
	);

	await t.test('9. delegación monotónica: no puede conceder lo que no tiene', async () => {
		await rejectsWith(
			createCustomRole(db, A.org.id, TECHNICIAN, {
				name: 'X',
				code: code(),
				permissions: ['roles:manage']
			}),
			'PERMISSION_NOT_DELEGABLE'
		);
		await rejectsWith(
			createCustomRole(db, A.org.id, [], { name: 'X', code: code(), permissions: ['sites:view'] }),
			'PERMISSION_NOT_DELEGABLE'
		);
		const ok = await createCustomRole(db, A.org.id, TECHNICIAN, {
			name: 'X',
			code: code(),
			permissions: TECHNICIAN
		});
		assert.deepEqual(ok.permissions, TECHNICIAN);
	});

	await t.test(
		'10. Admin tampoco se asume omnipotente: delega sólo sus permisos reales',
		async () => {
			const notInAdmin = PERMISSION_IDS.filter((id) => !ADMIN.includes(id));
			for (const id of notInAdmin)
				await rejectsWith(
					createCustomRole(db, A.org.id, ADMIN, { name: 'X', code: code(), permissions: [id] }),
					'PERMISSION_NOT_DELEGABLE'
				);
		}
	);

	await t.test('11. org inexistente / no operativa / ids inválidos', async () => {
		await rejectsWith(
			createCustomRole(db, randomUUID(), ADMIN, { name: 'X', code: code(), permissions: [] }),
			'ORGANIZATION_NOT_FOUND'
		);
		const S = await organization('Suspendida', 'suspended');
		await rejectsWith(
			createCustomRole(db, S.org.id, ADMIN, { name: 'X', code: code(), permissions: [] }),
			'ORGANIZATION_NOT_OPERATIONAL'
		);
		await rejectsWith(
			createCustomRole(db, 'nope', ADMIN, { name: 'X', code: code(), permissions: [] }),
			'INVALID_INPUT'
		);
	});

	await t.test('12. atomicidad: fallo en permisos no deja rol huérfano', async () => {
		const c = code();
		const before = (await listOrganizationRoles(db, A.org.id)).length;
		await rejectsWith(
			createCustomRole(db, A.org.id, ADMIN, { name: 'X', code: c, permissions: ['x:y'] }),
			'INVALID_INPUT'
		);
		// una transacción externa que aborta después de crear revierte rol y permisos
		await assert.rejects(
			db.transaction(async (tx) => {
				await createCustomRole(tx, A.org.id, ADMIN, {
					name: 'X',
					code: c,
					permissions: ['sites:view']
				});
				throw new Error('rollback');
			}),
			/rollback/
		);
		assert.equal((await listOrganizationRoles(db, A.org.id)).length, before);
		const rows = await db
			.select()
			.from(s.roles)
			.where(and(eq(s.roles.organizationId, A.org.id), eq(s.roles.code, c)));
		assert.equal(rows.length, 0);
	});

	// =========================================================================
	// Servicio: actualización (13-28)
	// =========================================================================
	await t.test(
		'13. PATCH parcial de name y description; code/templateId/isCustom intactos',
		async () => {
			const role = await createCustomRole(db, A.org.id, ADMIN, {
				name: 'Antes',
				code: code(),
				description: 'd',
				permissions: ['sites:view']
			});
			const [{ updatedAt: before }] = await db
				.select({ updatedAt: s.roles.updatedAt })
				.from(s.roles)
				.where(eq(s.roles.id, role.id));
			const updated = await updateCustomRole(db, A.org.id, role.id, ADMIN, { name: ' Después ' });
			assert.equal(updated.name, 'Después');
			assert.equal(updated.description, 'd');
			assert.equal(updated.code, role.code);
			assert.deepEqual(updated.permissions, ['sites:view']);
			const cleared = await updateCustomRole(db, A.org.id, role.id, ADMIN, { description: null });
			assert.equal(cleared.description, null);
			assert.equal(cleared.isCustom, true);
			assert.equal(cleared.templateId, null);
			const [{ updatedAt: after }] = await db
				.select({ updatedAt: s.roles.updatedAt })
				.from(s.roles)
				.where(eq(s.roles.id, role.id));
			assert.ok(after >= before);
		}
	);

	await t.test('14. permissions reemplaza el conjunto completo (añade y quita)', async () => {
		const role = await createCustomRole(db, A.org.id, ADMIN, {
			name: 'P',
			code: code(),
			permissions: ['sites:view', 'categories:view']
		});
		const updated = await updateCustomRole(db, A.org.id, role.id, ADMIN, {
			permissions: ['categories:view', 'incidents:view_all']
		});
		assert.deepEqual(updated.permissions, catalogOrder(['categories:view', 'incidents:view_all']));
		assert.deepEqual(await storedPermissions(role.id), ['categories:view', 'incidents:view_all']);
		const empty = await updateCustomRole(db, A.org.id, role.id, ADMIN, { permissions: [] });
		assert.deepEqual(empty.permissions, []);
		assert.deepEqual(await storedPermissions(role.id), []);
	});

	await t.test('15. patch vacío, campos desconocidos o code -> INVALID_INPUT', async () => {
		const role = await rawRole(A.org, []);
		await rejectsWith(updateCustomRole(db, A.org.id, role.id, ADMIN, {}), 'INVALID_INPUT');
		await rejectsWith(updateCustomRole(db, A.org.id, role.id, ADMIN, null), 'INVALID_INPUT');
		await rejectsWith(
			updateCustomRole(db, A.org.id, role.id, ADMIN, { code: 'otro_codigo' }),
			'INVALID_INPUT'
		);
	});

	await t.test('16. valores inválidos en PATCH -> INVALID_INPUT', async () => {
		const role = await rawRole(A.org, []);
		for (const bad of [
			{ name: '' },
			{ name: 'x'.repeat(101) },
			{ description: 'x'.repeat(1001) },
			{ description: 3 },
			{ permissions: ['platform:manage'] },
			{ permissions: ['sites:view', 'sites:view'] },
			{ permissions: 'sites:view' },
			{ active: 'false' },
			{ active: null }
		])
			await rejectsWith(updateCustomRole(db, A.org.id, role.id, ADMIN, bad), 'INVALID_INPUT');
	});

	await t.test('17. roles de sistema totalmente inmutables (SYSTEM_ROLE_IMMUTABLE)', async () => {
		for (const system of [A.admin, A.tech])
			for (const change of [
				{ name: 'X' },
				{ description: 'x' },
				{ permissions: [] },
				{ active: false },
				{ active: true }
			])
				await rejectsWith(
					updateCustomRole(db, A.org.id, system.id, ADMIN, change),
					'SYSTEM_ROLE_IMMUTABLE'
				);
		assert.deepEqual((await getOrganizationRole(db, A.org.id, A.admin.id)).permissions, ADMIN);
		assert.equal((await getOrganizationRole(db, A.org.id, A.tech.id)).active, true);
	});

	await t.test(
		'18. is_custom=false sin plantilla o isCustom con templateId también son sistema',
		async () => {
			const legacy = await rawRole(A.org, ['sites:view'], { isCustom: false });
			const hybrid = await rawRole(A.org, ['sites:view'], { templateId: 'tpl_technician' });
			for (const role of [legacy, hybrid])
				await rejectsWith(
					updateCustomRole(db, A.org.id, role.id, ADMIN, { name: 'X' }),
					'SYSTEM_ROLE_IMMUTABLE'
				);
		}
	);

	await t.test('19. rol inexistente u otro tenant -> ROLE_NOT_FOUND (sin enumerar)', async () => {
		const foreign = await createCustomRole(db, B.org.id, ADMIN, {
			name: 'B',
			code: code(),
			permissions: []
		});
		await rejectsWith(
			updateCustomRole(db, A.org.id, foreign.id, ADMIN, { name: 'X' }),
			'ROLE_NOT_FOUND'
		);
		await rejectsWith(
			updateCustomRole(db, A.org.id, B.admin.id, ADMIN, { name: 'X' }),
			'ROLE_NOT_FOUND'
		);
		await rejectsWith(
			updateCustomRole(db, A.org.id, randomUUID(), ADMIN, { name: 'X' }),
			'ROLE_NOT_FOUND'
		);
		await rejectsWith(
			updateCustomRole(db, A.org.id, 'nope', ADMIN, { name: 'X' }),
			'INVALID_INPUT'
		);
		assert.equal((await getOrganizationRole(db, B.org.id, foreign.id)).name, 'B');
	});

	await t.test(
		'20. permisos legacy: cambiar permissions -> 409; otros campos permitidos',
		async () => {
			await db
				.insert(s.permissions)
				.values({
					id: 'legacy:thing',
					name: 'Legacy',
					description: 'Legacy',
					category: 'legacy',
					allowedScopeTypes: ['organization']
				})
				.onConflictDoNothing();
			const role = await rawRole(A.org, ['sites:view', 'legacy:thing']);
			await rejectsWith(
				updateCustomRole(db, A.org.id, role.id, ADMIN, { permissions: ['sites:view'] }),
				'ROLE_HAS_UNKNOWN_PERMISSIONS'
			);
			const renamed = await updateCustomRole(db, A.org.id, role.id, ADMIN, {
				name: 'Renombrado',
				active: false
			});
			assert.equal(renamed.name, 'Renombrado');
			assert.equal(renamed.active, false);
			assert.deepEqual(renamed.permissions, ['sites:view']);
			assert.deepEqual(await storedPermissions(role.id), ['legacy:thing', 'sites:view']);
		}
	);

	await t.test('21. delegación en PATCH: nuevos permisos deben ser delegables', async () => {
		const role = await createCustomRole(db, A.org.id, TECHNICIAN, {
			name: 'T',
			code: code(),
			permissions: ['sites:view']
		});
		await rejectsWith(
			updateCustomRole(db, A.org.id, role.id, TECHNICIAN, { permissions: ['roles:manage'] }),
			'PERMISSION_NOT_DELEGABLE'
		);
		assert.deepEqual(await storedPermissions(role.id), ['sites:view']);
	});

	await t.test(
		'22. no puede gestionar un rol por encima de su nivel (permisos actuales)',
		async () => {
			const high = await createCustomRole(db, A.org.id, ADMIN, {
				name: 'Alto',
				code: code(),
				permissions: ['roles:manage', 'sites:view']
			});
			const limited = ['sites:view'];
			for (const change of [
				{ name: 'X' },
				{ active: false },
				{ permissions: ['sites:view'] },
				{ description: 'x' }
			])
				await rejectsWith(
					updateCustomRole(db, A.org.id, high.id, limited, change),
					'PERMISSION_NOT_DELEGABLE'
				);
			assert.deepEqual(await storedPermissions(high.id), ['roles:manage', 'sites:view']);
			assert.equal((await getOrganizationRole(db, A.org.id, high.id)).active, true);
		}
	);

	await t.test('23. active=false/true efectivo al instante; asignaciones intactas', async () => {
		const role = await createCustomRole(db, A.org.id, ADMIN, {
			name: 'Act',
			code: code(),
			permissions: ['categories:view']
		});
		const who = await member(A.org, [role]);
		const snapshot = await assignmentsSnapshot(role.id);
		assert.deepEqual(await resolveEffectivePermissions(who.headers, A.org.id), ['categories:view']);
		const off = await updateCustomRole(db, A.org.id, role.id, ADMIN, { active: false });
		assert.equal(off.active, false);
		assert.deepEqual(await resolveEffectivePermissions(who.headers, A.org.id), []);
		assert.deepEqual(await assignmentsSnapshot(role.id), snapshot);
		const on = await updateCustomRole(db, A.org.id, role.id, ADMIN, { active: true });
		assert.equal(on.active, true);
		assert.deepEqual(await resolveEffectivePermissions(who.headers, A.org.id), ['categories:view']);
		assert.deepEqual(await assignmentsSnapshot(role.id), snapshot);
	});

	await t.test('24. rol inactivo sigue siendo editable', async () => {
		const role = await rawRole(A.org, [], { active: false });
		const updated = await updateCustomRole(db, A.org.id, role.id, ADMIN, {
			permissions: ['sites:view']
		});
		assert.equal(updated.active, false);
		assert.deepEqual(updated.permissions, ['sites:view']);
	});

	await t.test('25. cambio de permisos se refleja al instante en miembros asignados', async () => {
		const role = await createCustomRole(db, A.org.id, ADMIN, {
			name: 'Live',
			code: code(),
			permissions: ['sites:view']
		});
		const who = await member(A.org, [role]);
		await updateCustomRole(db, A.org.id, role.id, ADMIN, {
			permissions: ['categories:view', 'teams:view']
		});
		assert.deepEqual(
			await resolveEffectivePermissions(who.headers, A.org.id),
			catalogOrder(['categories:view', 'teams:view'])
		);
	});

	await t.test('26. auto-escalada imposible: el actor edita su propio rol', async () => {
		const own = await createCustomRole(db, A.org.id, ADMIN, {
			name: 'Gestor',
			code: code(),
			permissions: ['roles:view', 'roles:manage', 'sites:view']
		});
		const who = await member(A.org, [own]);
		const actor = await resolveEffectivePermissions(who.headers, A.org.id);
		await rejectsWith(
			updateCustomRole(db, A.org.id, own.id, actor, {
				permissions: [...actor, 'incidents:view_all']
			}),
			'PERMISSION_NOT_DELEGABLE'
		);
		await rejectsWith(
			createCustomRole(db, A.org.id, actor, {
				name: 'Escala',
				code: code(),
				permissions: ['memberships:create']
			}),
			'PERMISSION_NOT_DELEGABLE'
		);
		assert.deepEqual(
			await resolveEffectivePermissions(who.headers, A.org.id),
			catalogOrder(['roles:view', 'roles:manage', 'sites:view'])
		);
		// reducir el propio rol sí es posible (monotónico descendente)
		const reduced = await updateCustomRole(db, A.org.id, own.id, actor, {
			permissions: ['roles:view', 'roles:manage']
		});
		assert.deepEqual(reduced.permissions, ['roles:view', 'roles:manage']);
	});

	await t.test('27. org no operativa -> ORGANIZATION_NOT_OPERATIONAL en PATCH', async () => {
		const S = await organization('Suspendida 2');
		const role = await createCustomRole(db, S.org.id, ADMIN, {
			name: 'S',
			code: code(),
			permissions: []
		});
		await db
			.update(s.organizations)
			.set({ status: 'suspended' })
			.where(eq(s.organizations.id, S.org.id));
		await rejectsWith(
			updateCustomRole(db, S.org.id, role.id, ADMIN, { name: 'X' }),
			'ORGANIZATION_NOT_OPERATIONAL'
		);
	});

	await t.test('28. PATCH atómico: rollback externo revierte rol y permisos', async () => {
		const role = await createCustomRole(db, A.org.id, ADMIN, {
			name: 'Atom',
			code: code(),
			permissions: ['sites:view']
		});
		await assert.rejects(
			db.transaction(async (tx) => {
				await updateCustomRole(tx, A.org.id, role.id, ADMIN, {
					name: 'Cambiado',
					permissions: ['categories:view']
				});
				throw new Error('rollback');
			}),
			/rollback/
		);
		const after = await getOrganizationRole(db, A.org.id, role.id);
		assert.equal(after.name, 'Atom');
		assert.deepEqual(after.permissions, ['sites:view']);
	});

	// =========================================================================
	// HTTP (29-41)
	// =========================================================================
	await t.test('29. POST 201 con DTO del read model y no-store', async () => {
		const c = code();
		const res = await post(adminA, A.org.id, {
			name: 'HTTP',
			code: c,
			description: 'desc',
			permissions: ['sites:view']
		});
		assert.equal(res.status, 201);
		assert.equal(res.headers.get('cache-control'), 'private, no-store');
		assert.deepEqual(Object.keys(res.json), ['role']);
		assert.deepEqual(Object.keys(res.json.role).sort(), ROLE_KEYS);
		assert.equal(res.json.role.code, c);
		assert.equal(res.json.role.isCustom, true);
		assert.equal(res.json.role.templateId, null);
		assert.equal(res.json.role.active, true);
		assert.ok(!res.text.includes(A.org.id));
		const detail = await getOrganizationRole(db, A.org.id, res.json.role.id);
		assert.deepEqual(res.json.role, detail);
	});

	await t.test('30. POST: 401 sin sesión; 403 sin roles:manage; 403 org ajena', async () => {
		const body = { name: 'X', code: code(), permissions: [] };
		assert.equal((await post(null, A.org.id, body)).status, 401);
		const r = await post(techA, A.org.id, body);
		assert.equal(r.status, 403);
		assert.equal(r.json.error.code, 'FORBIDDEN');
		const viewer = await member(A.org, [await rawRole(A.org, ['roles:view'])]);
		assert.equal((await post(viewer, A.org.id, body)).status, 403);
		const foreign = await post(adminA, B.org.id, body);
		assert.equal(foreign.status, 403);
		assert.equal(
			(await listOrganizationRoles(db, B.org.id)).some((x) => x.code === body.code),
			false
		);
	});

	await t.test(
		'31. POST: organizationId inválido/ausente/duplicado o query extra -> 400',
		async () => {
			const body = { name: 'X', code: code(), permissions: [] };
			assert.equal((await post(adminA, null, body)).status, 400);
			assert.equal((await post(adminA, 'nope', body)).status, 400);
			assert.equal((await post(adminA, A.org.id, body, { query: '&x=1' })).status, 400);
			assert.equal(
				(await post(adminA, A.org.id, body, { query: `&organizationId=${A.org.id}` })).status,
				400
			);
		}
	);

	await t.test(
		'32. POST: body no JSON, no objeto, campos desconocidos o servidor-only -> 400',
		async () => {
			const base = { name: 'X', code: code(), permissions: [] };
			for (const extra of [
				{ rawBody: '{not json' },
				{ rawBody: '[]' },
				{ rawBody: 'null' },
				{ rawBody: '"x"' },
				{ rawBody: JSON.stringify(base), contentType: 'text/plain' }
			]) {
				const r = await post(adminA, A.org.id, undefined, extra);
				assert.equal(r.status, 400, JSON.stringify(extra));
				assert.equal(r.json.error.code, 'INVALID_INPUT');
			}
			for (const field of ['isCustom', 'templateId', 'active', 'id', 'organizationId', 'extra'])
				assert.equal(
					(await post(adminA, A.org.id, { ...base, [field]: field === 'active' ? true : null }))
						.status,
					400,
					field
				);
		}
	);

	await t.test('33. POST: validación de code/permissions -> 400 sin eco del payload', async () => {
		const r = await post(adminA, A.org.id, {
			name: 'X',
			code: 'Bad<script>',
			permissions: []
		});
		assert.equal(r.status, 400);
		assert.deepEqual(r.json, { error: { code: 'INVALID_INPUT', message: 'Invalid request.' } });
		const p = await post(adminA, A.org.id, {
			name: 'X',
			code: code(),
			permissions: ['platform:manage']
		});
		assert.equal(p.status, 400);
	});

	await t.test('34. POST: 409 ROLE_CODE_CONFLICT (duplicado y reservado)', async () => {
		const c = code();
		assert.equal(
			(await post(adminA, A.org.id, { name: 'X', code: c, permissions: [] })).status,
			201
		);
		const dup = await post(adminA, A.org.id, { name: 'Y', code: c, permissions: [] });
		assert.equal(dup.status, 409);
		assert.equal(dup.json.error.code, 'ROLE_CODE_CONFLICT');
		const reserved = await post(adminA, A.org.id, {
			name: 'Y',
			code: 'technician',
			permissions: []
		});
		assert.equal(reserved.status, 409);
		assert.equal(reserved.json.error.code, 'ROLE_CODE_CONFLICT');
	});

	await t.test('35. POST: 403 PERMISSION_NOT_DELEGABLE con permisos efectivos reales', async () => {
		const manager = await member(A.org, [
			await rawRole(A.org, ['roles:view', 'roles:manage', 'sites:view'])
		]);
		const ok = await post(manager, A.org.id, {
			name: 'X',
			code: code(),
			permissions: ['sites:view']
		});
		assert.equal(ok.status, 201);
		const denied = await post(manager, A.org.id, {
			name: 'X',
			code: code(),
			permissions: ['incidents:view_all']
		});
		assert.equal(denied.status, 403);
		assert.equal(denied.json.error.code, 'PERMISSION_NOT_DELEGABLE');
	});

	await t.test('36. PATCH 200 parcial, permisos reemplazados y DTO consistente', async () => {
		const created = (
			await post(adminA, A.org.id, { name: 'H', code: code(), permissions: ['sites:view'] })
		).json.role;
		const r = await patch(adminA, A.org.id, created.id, {
			name: 'H2',
			permissions: ['categories:view'],
			active: false
		});
		assert.equal(r.status, 200);
		assert.equal(r.headers.get('cache-control'), 'private, no-store');
		assert.deepEqual(Object.keys(r.json.role).sort(), ROLE_KEYS);
		assert.equal(r.json.role.name, 'H2');
		assert.equal(r.json.role.code, created.code);
		assert.equal(r.json.role.active, false);
		assert.deepEqual(r.json.role.permissions, ['categories:view']);
	});

	await t.test('37. PATCH: body vacío, desconocidos o code -> 400', async () => {
		const role = await rawRole(A.org, []);
		for (const body of [
			{},
			{ code: 'nuevo_codigo' },
			{ templateId: null },
			{ isCustom: false },
			{ x: 1 }
		]) {
			const r = await patch(adminA, A.org.id, role.id, body);
			assert.equal(r.status, 400, JSON.stringify(body));
			assert.equal(r.json.error.code, 'INVALID_INPUT');
		}
		assert.equal((await patch(adminA, A.org.id, role.id, undefined, { rawBody: '' })).status, 400);
		assert.equal((await patch(adminA, A.org.id, 'nope', { name: 'X' })).status, 400);
		assert.equal((await getOrganizationRole(db, A.org.id, role.id)).code, role.code);
	});

	await t.test('38. PATCH: 401/403 y 404 cross-tenant (anti-enumeración)', async () => {
		const role = await rawRole(A.org, []);
		assert.equal((await patch(null, A.org.id, role.id, { name: 'X' })).status, 401);
		assert.equal((await patch(techA, A.org.id, role.id, { name: 'X' })).status, 403);
		assert.equal((await patch(adminB, A.org.id, role.id, { name: 'X' })).status, 403);
		const foreignRole = await rawRole(B.org, []);
		const cross = await patch(adminA, A.org.id, foreignRole.id, { name: 'X' });
		const missing = await patch(adminA, A.org.id, randomUUID(), { name: 'X' });
		assert.equal(cross.status, 404);
		assert.deepEqual(cross.json, missing.json);
		assert.equal(cross.json.error.code, 'ROLE_NOT_FOUND');
	});

	await t.test('39. PATCH: 409 SYSTEM_ROLE_IMMUTABLE y ROLE_HAS_UNKNOWN_PERMISSIONS', async () => {
		const sys = await patch(adminA, A.org.id, A.admin.id, { active: false });
		assert.equal(sys.status, 409);
		assert.equal(sys.json.error.code, 'SYSTEM_ROLE_IMMUTABLE');
		const legacy = await rawRole(A.org, ['legacy:thing']);
		const r = await patch(adminA, A.org.id, legacy.id, { permissions: [] });
		assert.equal(r.status, 409);
		assert.equal(r.json.error.code, 'ROLE_HAS_UNKNOWN_PERMISSIONS');
		assert.ok(!r.text.includes('legacy:thing'));
		assert.equal((await patch(adminA, A.org.id, legacy.id, { name: 'OK' })).status, 200);
	});

	await t.test('40. PATCH: 403 PERMISSION_NOT_DELEGABLE (auto-escalada por HTTP)', async () => {
		const own = await rawRole(A.org, ['roles:view', 'roles:manage']);
		const who = await member(A.org, [own]);
		const r = await patch(who, A.org.id, own.id, {
			permissions: ['roles:view', 'roles:manage', 'memberships:create']
		});
		assert.equal(r.status, 403);
		assert.equal(r.json.error.code, 'PERMISSION_NOT_DELEGABLE');
		assert.deepEqual(await storedPermissions(own.id), ['roles:manage', 'roles:view']);
	});

	await t.test(
		'41. errores seguros: nunca SQL, stack ni mensajes internos; sin DELETE',
		async () => {
			const role = await rawRole(A.org, []);
			const responses = [
				await post(adminA, A.org.id, { name: 'X', code: 'technician', permissions: [] }),
				await patch(adminA, A.org.id, A.tech.id, { name: 'X' }),
				await patch(adminA, A.org.id, role.id, { permissions: ['x:y'] })
			];
			for (const r of responses) {
				assert.deepEqual(Object.keys(r.json), ['error']);
				assert.deepEqual(Object.keys(r.json.error).sort(), ['code', 'message']);
				for (const leak of [
					'select',
					'insert',
					'constraint',
					'roles_org_code_unique',
					'stack',
					'Error:'
				])
					assert.ok(!r.text.toLowerCase().includes(leak.toLowerCase()), leak);
			}
			assert.equal(rolesRoute.DELETE, undefined);
			assert.equal(roleRoute.DELETE, undefined);
			assert.equal(roleRoute.PUT, undefined);
			assert.equal(roleRoute.POST, undefined);
			assert.equal(rolesRoute.PATCH, undefined);
			assert.ok(!fs.existsSync('src/routes/api/roles/[id]/assignments'));
		}
	);

	// =========================================================================
	// E2E
	// =========================================================================
	await t.test(
		'E2E: Admin crea rol, GET, PATCH permisos y cambia permisos efectivos del miembro',
		async () => {
			const created = await post(adminA, A.org.id, {
				name: 'Consultor',
				code: code(),
				permissions: ['sites:view']
			});
			assert.equal(created.status, 201);
			const roleId = created.json.role.id;
			const detail = await roleRoute.GET({
				url: new URL(`http://localhost/api/roles/${roleId}?organizationId=${A.org.id}`),
				params: { id: roleId },
				request: new Request('http://localhost/', { headers: { cookie: adminA.cookie } })
			});
			assert.equal(detail.status, 200);
			assert.deepEqual((await detail.json()).role, created.json.role);
			const assignee = await member(A.org, [{ id: roleId }]);
			assert.deepEqual(await resolveEffectivePermissions(assignee.headers, A.org.id), [
				'sites:view'
			]);
			const updated = await patch(adminA, A.org.id, roleId, {
				permissions: ['sites:view', 'categories:view', 'incidents:view_all']
			});
			assert.equal(updated.status, 200);
			assert.deepEqual(
				await resolveEffectivePermissions(assignee.headers, A.org.id),
				catalogOrder(['sites:view', 'categories:view', 'incidents:view_all'])
			);
			assert.equal((await patch(adminA, A.org.id, roleId, { active: false })).status, 200);
			assert.deepEqual(await resolveEffectivePermissions(assignee.headers, A.org.id), []);
			// los roles de sistema siguen intactos
			assert.deepEqual((await getOrganizationRole(db, A.org.id, A.admin.id)).permissions, ADMIN);
			assert.deepEqual(
				(await getOrganizationRole(db, A.org.id, A.tech.id)).permissions,
				TECHNICIAN
			);
		}
	);
});

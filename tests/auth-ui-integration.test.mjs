import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isRedirect } from '@sveltejs/kit';
import { fixture, createCredentialUser, TEST_ORIGIN } from './helpers/auth-fixture.mjs';

function makeAuthEvent(
	request,
	url = new URL(request.url),
	params = {},
	route = { id: '/api/auth/[...all]' }
) {
	return {
		request,
		url,
		params,
		locals: {},
		cookies: {
			get: (name) => {
				const cookie = request.headers.get('cookie');
				if (!cookie) return undefined;
				const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
				return match ? decodeURIComponent(match[1]) : undefined;
			},
			getAll: () => [],
			set: () => {},
			delete: () => {},
			serialize: () => ''
		},
		fetch: globalThis.fetch,
		getClientAddress: () => '127.0.0.1',
		isDataRequest: false,
		isSubRequest: false,
		platform: {},
		route,
		setHeaders: () => {}
	};
}

let ipCounter = 100;
function nextTestIp() {
	return `10.20.30.${ipCounter++}`;
}

/**
 * Creates an in-test HTTP dispatcher that simulates a browser environment:
 * - Automatically tracks Set-Cookie into a session cookieJar
 * - Injects the session cookie into subsequent requests
 * - Routes to authRoutes and meRoutes handlers
 */
function createSimulatedBrowser(authRoutes, meRoutes) {
	let cookieJar = '';

	const simulatedFetch = async (input, init = {}) => {
		const urlStr = typeof input === 'string' ? input : input.url;
		const url = new URL(urlStr, TEST_ORIGIN);
		const method =
			init.method ?? (typeof input === 'object' && input.method ? input.method : 'GET');
		const reqHeaders = new Headers(init.headers || {});

		if (cookieJar && !reqHeaders.has('cookie')) {
			reqHeaders.set('cookie', cookieJar);
		}
		if (!reqHeaders.has('origin')) {
			reqHeaders.set('origin', TEST_ORIGIN);
		}
		if (!reqHeaders.has('x-forwarded-for')) {
			reqHeaders.set('x-forwarded-for', nextTestIp());
		}

		let response;
		if (url.pathname.startsWith('/api/auth/')) {
			const subpath = url.pathname.replace(/^\/api\/auth\/?/, '');
			const req = new Request(url.toString(), {
				method,
				headers: reqHeaders,
				body: init.body
			});
			const event = makeAuthEvent(req, url, { all: subpath });
			response = await authRoutes.POST(event);
		} else if (url.pathname === '/api/me') {
			const req = new Request(url.toString(), {
				method,
				headers: reqHeaders
			});
			const event = makeAuthEvent(req, url, {}, { id: '/api/me' });
			response = await meRoutes.GET(event);
		} else {
			throw new Error(`Unhandled route in simulated fetch: ${url.pathname}`);
		}

		// Intercept Set-Cookie to mirror browser cookie jar
		const setCookie = response.headers.get('set-cookie');
		if (setCookie) {
			if (setCookie.includes('Max-Age=0') || setCookie.includes('Expires=Thu, 01 Jan 1970')) {
				cookieJar = '';
			} else {
				const match = setCookie.match(/soporteflow-auth\.session_token=[^;]+/);
				if (match) {
					cookieJar = match[0];
				}
			}
		}

		return response;
	};

	return {
		fetch: simulatedFetch,
		getCookie: () => cookieJar,
		setCookie: (c) => {
			cookieJar = c;
		},
		clearCookies: () => {
			cookieJar = '';
		}
	};
}

test('SoporteFlow — Etapa 5.4C.1: Integración UI de Autenticación, Guard SSR, Manejo de Organizaciones y Logout', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;

	const authRoutes = await server.ssrLoadModule('/src/routes/api/auth/[...all]/+server.ts');
	const meRoutes = await server.ssrLoadModule('/src/routes/api/me/+server.ts');
	const { signIn, signOut, getMe, AuthApiError } =
		await server.ssrLoadModule('/src/lib/api/auth.ts');
	const { session } = await server.ssrLoadModule('/src/lib/stores/session.ts');
	const { load: layoutLoad } = await server.ssrLoadModule('/src/routes/app/+layout.server.ts');
	const { defaultDemoUser } = await server.ssrLoadModule('/src/lib/auth/demo-session.ts');

	// Create user with known credentials
	const testPassword = 'Password12345!Secure';
	const testUser = await createCredentialUser(f, {
		name: 'Usuario Real 5.4C',
		email: 'usuario.real@soporteflow.test',
		password: testPassword
	});

	// Create test organization and active membership
	const [testOrg] = await db
		.insert(s.organizations)
		.values({ name: 'Organización Alpha', slug: 'alpha-' + randomUUID(), status: 'active' })
		.returning();
	await db
		.insert(s.memberships)
		.values({ organizationId: testOrg.id, userId: testUser.id, active: true });

	// ==========================================
	// 1. signIn() EXITOSO
	// ==========================================
	await t.test('1. signIn() exitoso: devuelve user con datos reales y token ausente', async () => {
		const browser = createSimulatedBrowser(authRoutes, meRoutes);
		const result = await signIn({ email: testUser.email, password: testPassword }, browser.fetch);

		assert.ok(result, 'signIn debe resolver exitosamente');
		assert.ok(result.user, 'signIn debe incluir objeto user');
		assert.equal(result.user.id, testUser.id, 'User ID debe coincidir');
		assert.equal(result.user.email, testUser.email, 'User email debe coincidir');
		assert.equal(result.user.name, 'Usuario Real 5.4C', 'User name debe coincidir');

		// Invariante de seguridad: token de sesión ausente en body
		assert.equal('token' in result, false, 'El token de sesión NO debe existir en el retorno');
		assert.equal(result.token, undefined, 'result.token debe ser undefined');

		// Cookie HttpOnly fue capturada por el navegador simulado
		const cookie = browser.getCookie();
		assert.ok(
			cookie.startsWith('soporteflow-auth.session_token='),
			'Debe haberse emitido la cookie de sesión'
		);
	});

	// ==========================================
	// 2. signIn() CREDENCIALES INCORRECTAS
	// ==========================================
	await t.test(
		'2. signIn() credenciales incorrectas: lanza AuthApiError con status 401',
		async () => {
			const browser = createSimulatedBrowser(authRoutes, meRoutes);

			await assert.rejects(
				async () => {
					await signIn({ email: testUser.email, password: 'WrongPassword999!' }, browser.fetch);
				},
				(err) => {
					assert.ok(err instanceof AuthApiError, 'Debe ser instancia de AuthApiError');
					assert.equal(err.status, 401, 'Status HTTP debe ser 401');
					assert.equal(
						err.code,
						'INVALID_CREDENTIALS',
						'Código de error debe ser INVALID_CREDENTIALS'
					);
					assert.equal(
						err.message,
						'Correo o contraseña incorrectos.',
						'Mensaje debe ser amigable y en español'
					);
					return true;
				}
			);
		}
	);

	// ==========================================
	// 3. getMe() AUTENTICADO
	// ==========================================
	await t.test('3. getMe() autenticado: devuelve user y organizations activas', async () => {
		const browser = createSimulatedBrowser(authRoutes, meRoutes);

		// Primero hacemos login para obtener la cookie de sesión
		await signIn({ email: testUser.email, password: testPassword }, browser.fetch);

		const context = await getMe(browser.fetch);

		assert.ok(context, 'getMe debe devolver el contexto');
		assert.ok(context.user, 'Contexto debe incluir user');
		assert.equal(context.user.id, testUser.id);
		assert.equal(context.user.email, testUser.email);
		assert.equal(Array.isArray(context.organizations), true);
		assert.equal(context.organizations.length, 1);
		assert.equal(context.organizations[0].id, testOrg.id);
		assert.equal(context.organizations[0].name, 'Organización Alpha');
	});

	// ==========================================
	// 4. getMe() SIN SESIÓN
	// ==========================================
	await t.test('4. getMe() sin sesión: lanza AuthApiError con status 401', async () => {
		const browser = createSimulatedBrowser(authRoutes, meRoutes);
		// Sin login previo -> sin cookie

		await assert.rejects(
			async () => {
				await getMe(browser.fetch);
			},
			(err) => {
				assert.ok(err instanceof AuthApiError, 'Debe ser instancia de AuthApiError');
				assert.equal(err.status, 401, 'Status HTTP debe ser 401');
				assert.equal(err.code, 'UNAUTHORIZED');
				assert.equal(err.message, 'Sesión no válida o expirada.');
				return true;
			}
		);
	});

	await t.test(
		'4b. getMe() con fallo técnico (red, 500, 503) lanza error técnico y NO se confunde con sesión expirada',
		async () => {
			// 1. Fallo de red
			const networkFailFetch = async () => {
				throw new TypeError('Failed to fetch');
			};

			await assert.rejects(
				async () => {
					await getMe(networkFailFetch);
				},
				(err) => {
					assert.ok(err instanceof AuthApiError);
					assert.equal(err.status, 0);
					assert.equal(err.code, 'NETWORK_ERROR');
					assert.notEqual(err.message, 'Sesión no válida o expirada.');
					assert.equal(err.message, 'No se pudo conectar con el servidor.');
					return true;
				}
			);

			// 2. Error 500 de servidor
			const server500Fetch = async () => {
				return new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }), {
					status: 500,
					headers: { 'content-type': 'application/json' }
				});
			};

			await assert.rejects(
				async () => {
					await getMe(server500Fetch);
				},
				(err) => {
					assert.ok(err instanceof AuthApiError);
					assert.equal(err.status, 500);
					assert.notEqual(err.status, 401, 'No debe ser 401');
					assert.equal(err.code, 'INTERNAL_ERROR');
					assert.notEqual(err.message, 'Sesión no válida o expirada.');
					assert.equal(err.message, 'Error al obtener usuario.');
					return true;
				}
			);
		}
	);

	// ==========================================
	// 5. signOut() Y REVOCACIÓN DE SESIÓN
	// ==========================================
	await t.test('5. signOut(): revoca sesión y posterior getMe() falla 401', async () => {
		const browser = createSimulatedBrowser(authRoutes, meRoutes);

		// Login inicial
		await signIn({ email: testUser.email, password: testPassword }, browser.fetch);
		const initialContext = await getMe(browser.fetch);
		assert.equal(initialContext.user.id, testUser.id);

		// Logout
		await signOut(browser.fetch);

		// Cookie borrada por expiración
		assert.equal(browser.getCookie(), '', 'Cookie jar debe quedar vacía tras sign-out');

		// Siguiente getMe() debe fallar 401
		await assert.rejects(
			async () => {
				await getMe(browser.fetch);
			},
			(err) => {
				assert.ok(err instanceof AuthApiError);
				assert.equal(err.status, 401);
				return true;
			}
		);
	});

	// ==========================================
	// 6. +layout.server.ts GUARD (Etapa 5.4C.1)
	// ==========================================
	await t.test('6a. +layout.server.ts sin sesión: redirige a /login con 303', async () => {
		const event = {
			request: {
				headers: new Headers()
			}
		};

		let redirected = false;
		try {
			await layoutLoad(event);
		} catch (err) {
			assert.ok(isRedirect(err), 'Debe lanzar redirect de SvelteKit');
			assert.equal(err.status, 303, 'Código de redirección debe ser 303');
			assert.equal(err.location, '/login', 'Debe redirigir a /login');
			redirected = true;
		}
		assert.equal(redirected, true, 'Guard debió interceptar y redirigir');
	});

	await t.test(
		'6b. +layout.server.ts sesión válida con 0 organizaciones: redirige a /login?no_org=true con 303',
		async () => {
			// Usuario sin organizaciones
			const noOrgUser = await createCredentialUser(f, {
				name: 'Usuario Sin Organizacion',
				email: 'no.org@soporteflow.test',
				password: 'NoOrgPassword123!'
			});

			const browser = createSimulatedBrowser(authRoutes, meRoutes);
			await signIn({ email: noOrgUser.email, password: 'NoOrgPassword123!' }, browser.fetch);
			const cookie = browser.getCookie();

			const event = {
				request: {
					headers: new Headers({ cookie })
				}
			};

			let redirected = false;
			try {
				await layoutLoad(event);
			} catch (err) {
				assert.ok(isRedirect(err), 'Debe lanzar redirect');
				assert.equal(err.status, 303);
				assert.equal(err.location, '/login?no_org=true');
				redirected = true;
			}
			assert.equal(
				redirected,
				true,
				'Usuario sin organizaciones debe ser redirigido a /login?no_org=true'
			);
		}
	);

	await t.test(
		'6c. +layout.server.ts sesión válida con 1 organización: permite acceso y devuelve userId',
		async () => {
			const browser = createSimulatedBrowser(authRoutes, meRoutes);
			await signIn({ email: testUser.email, password: testPassword }, browser.fetch);
			const cookie = browser.getCookie();

			const event = {
				request: {
					headers: new Headers({ cookie })
				}
			};

			const data = await layoutLoad(event);
			assert.ok(data, 'Load debe resolver datos');
			assert.equal(data.userId, testUser.id, 'Debe devolver el userId autenticado');
		}
	);

	await t.test(
		'6d. +layout.server.ts sesión válida con múltiples organizaciones: permite acceso y devuelve userId sin selección en servidor',
		async () => {
			const multiOrgUser = await createCredentialUser(f, {
				name: 'Usuario Multi Org',
				email: 'multiorg@soporteflow.test',
				password: 'MultiOrgPassword123!'
			});

			const [orgBeta] = await db
				.insert(s.organizations)
				.values({ name: 'Organización Beta', slug: 'beta-' + randomUUID(), status: 'active' })
				.returning();

			// Asociar a 2 organizaciones activas
			await db
				.insert(s.memberships)
				.values({ organizationId: testOrg.id, userId: multiOrgUser.id, active: true });
			await db
				.insert(s.memberships)
				.values({ organizationId: orgBeta.id, userId: multiOrgUser.id, active: true });

			const browser = createSimulatedBrowser(authRoutes, meRoutes);
			await signIn({ email: multiOrgUser.email, password: 'MultiOrgPassword123!' }, browser.fetch);
			const cookie = browser.getCookie();

			const event = {
				request: {
					headers: new Headers({ cookie })
				}
			};

			const data = await layoutLoad(event);
			assert.ok(data, 'Load debe resolver datos');
			assert.equal(
				data.userId,
				multiOrgUser.id,
				'Debe permitir entrar a /app con múltiples organizaciones'
			);
		}
	);

	await t.test(
		'6e. +layout.server.ts con usuario inactivo: redirige a /login con 303',
		async () => {
			// Crear usuario inactivo en core
			const inactivePassword = 'InactivePassword123!';
			const inactiveUser = await createCredentialUser(f, {
				name: 'Usuario Inactivo',
				email: 'inactivo@soporteflow.test',
				password: inactivePassword,
				active: false // Usuario inactivo en core.users
			});

			// Login emite cookie pero usuario está inactivo en core
			const browser = createSimulatedBrowser(authRoutes, meRoutes);
			await signIn({ email: inactiveUser.email, password: inactivePassword }, browser.fetch);
			const cookie = browser.getCookie();

			const event = {
				request: {
					headers: new Headers({ cookie })
				}
			};

			let redirected = false;
			try {
				await layoutLoad(event);
			} catch (err) {
				assert.ok(isRedirect(err), 'Debe lanzar redirect');
				assert.equal(err.status, 303);
				assert.equal(err.location, '/login');
				redirected = true;
			}
			assert.equal(redirected, true, 'Usuario inactivo debe ser redirigido a /login');
		}
	);

	// ==========================================
	// 7. LOGIN SIN ORGANIZACIÓN (REVOCACIÓN INMEDIATA)
	// ==========================================
	await t.test(
		'7. signIn válido con 0 organizaciones: revoca sesión inmediatamente y posterior getMe da 401',
		async () => {
			const zeroOrgUser = await createCredentialUser(f, {
				name: 'Usuario Sin Tenant',
				email: 'sin-tenant@soporteflow.test',
				password: 'PasswordZero123!'
			});

			const browser = createSimulatedBrowser(authRoutes, meRoutes);
			// 1. signIn
			await signIn({ email: zeroOrgUser.email, password: 'PasswordZero123!' }, browser.fetch);
			assert.ok(browser.getCookie().length > 0, 'Debe haber emitido cookie de sesión inicialmente');

			// 2. getMe devuelve 0 organizaciones
			const context = await getMe(browser.fetch);
			assert.equal(context.organizations.length, 0);

			// 3. Flujo en login/+page.svelte: si organizations.length === 0, ejecutar signOut y clearSession
			await signOut(browser.fetch);
			session.clearSession();

			// 4. Sesión revocada: cookie eliminada
			assert.equal(browser.getCookie(), '', 'Cookie jar debe quedar vacía');

			// 5. Posterior getMe falla con 401
			await assert.rejects(
				async () => {
					await getMe(browser.fetch);
				},
				(err) => {
					assert.ok(err instanceof AuthApiError);
					assert.equal(err.status, 401);
					return true;
				}
			);

			// 6. Store de sesión limpio
			let state;
			const unsub = session.subscribe((s) => (state = s));
			unsub();
			assert.equal(state.isAuthenticated, false);
			assert.equal(state.user, null);
		}
	);

	// ==========================================
	// 8. LOGOUT: ÉXITO vs ERROR
	// ==========================================
	await t.test(
		'8a. Logout exitoso: revoca sesión, limpia store y posterior getMe falla 401',
		async () => {
			const browser = createSimulatedBrowser(authRoutes, meRoutes);
			await signIn({ email: testUser.email, password: testPassword }, browser.fetch);
			const context = await getMe(browser.fetch);
			session.setSession(context);

			// Logout exitoso
			await signOut(browser.fetch);
			session.clearSession();

			let state;
			const unsub = session.subscribe((s) => (state = s));
			unsub();
			assert.equal(state.isAuthenticated, false);
			assert.equal(state.user, null);

			// getMe falla 401
			await assert.rejects(
				async () => {
					await getMe(browser.fetch);
				},
				(err) => {
					assert.ok(err instanceof AuthApiError);
					assert.equal(err.status, 401);
					return true;
				}
			);
		}
	);

	await t.test(
		'8b. Error de signOut: NO trata como logout exitoso, NO limpia store ni aparenta que cerró sesión',
		async () => {
			const browser = createSimulatedBrowser(authRoutes, meRoutes);
			await signIn({ email: testUser.email, password: testPassword }, browser.fetch);
			const context = await getMe(browser.fetch);
			session.setSession(context);

			// Simulamos una falla de red o error de servidor al intentar signOut
			const failingFetch = async () => {
				return new Response(JSON.stringify({ error: { code: 'FAIL' } }), {
					status: 500,
					headers: { 'content-type': 'application/json' }
				});
			};

			let signOutError = '';
			try {
				await signOut(failingFetch);
				session.clearSession();
			} catch {
				signOutError = 'No se pudo cerrar la sesión. Inténtalo de nuevo.';
			}

			// Invariantes críticos:
			assert.equal(
				signOutError,
				'No se pudo cerrar la sesión. Inténtalo de nuevo.',
				'Debe registrarse el error en el estado local'
			);

			let state;
			const unsub = session.subscribe((s) => (state = s));
			unsub();
			// NO se debe haber limpiado la sesión
			assert.equal(state.isAuthenticated, true, 'La sesión en el store DEBE permanecer activa');
			assert.equal(state.user?.id, testUser.id, 'El usuario en el store no debe haberse eliminado');
		}
	);

	// ==========================================
	// 9. REGLAS DE NEGOCIO: SELECCIÓN DE ORGANIZACIÓN
	// ==========================================
	await t.test('9a. Store de sesión con 0 organizaciones: activeOrganization es null', () => {
		session.reset();
		session.setSession({
			user: { id: testUser.id, name: testUser.name, email: testUser.email },
			organizations: []
		});

		let currentState;
		const unsub = session.subscribe((s) => (currentState = s));
		unsub();

		assert.equal(currentState.isAuthenticated, true);
		assert.equal(currentState.organizations.length, 0);
		assert.equal(
			currentState.activeOrganization,
			null,
			'Con 0 orgs activeOrganization debe ser null'
		);
	});

	await t.test(
		'9b. Store de sesión con 1 organización: activeOrganization es automáticamente esa única org',
		() => {
			session.reset();
			const singleOrg = { id: randomUUID(), name: 'Única Org', slug: 'unica-org' };
			session.setSession({
				user: { id: testUser.id, name: testUser.name, email: testUser.email },
				organizations: [singleOrg]
			});

			let currentState;
			const unsub = session.subscribe((s) => (currentState = s));
			unsub();

			assert.equal(currentState.isAuthenticated, true);
			assert.equal(currentState.organizations.length, 1);
			assert.notEqual(currentState.activeOrganization, null);
			assert.equal(currentState.activeOrganization.id, singleOrg.id);
			assert.equal(currentState.activeOrganization.name, 'Única Org');
		}
	);

	await t.test(
		'9c. Store de sesión con 2 organizaciones: activeOrganization es estrictamente null',
		() => {
			session.reset();
			const org1 = { id: randomUUID(), name: 'Org Uno', slug: 'org-uno' };
			const org2 = { id: randomUUID(), name: 'Org Dos', slug: 'org-dos' };
			session.setSession({
				user: { id: testUser.id, name: testUser.name, email: testUser.email },
				organizations: [org1, org2]
			});

			let currentState;
			const unsub = session.subscribe((s) => (currentState = s));
			unsub();

			assert.equal(currentState.isAuthenticated, true);
			assert.equal(currentState.organizations.length, 2);
			assert.equal(
				currentState.activeOrganization,
				null,
				'Con 2 o más organizaciones NUNCA debe seleccionarse la primera arbitrariamente'
			);
		}
	);

	await t.test('9d. Store de sesión clearSession: limpia estado completamente', () => {
		session.clearSession();
		let currentState;
		const unsub = session.subscribe((s) => (currentState = s));
		unsub();

		assert.equal(currentState.isAuthenticated, false);
		assert.equal(currentState.user, null);
		assert.equal(currentState.organizations.length, 0);
		assert.equal(currentState.activeOrganization, null);
	});

	// ==========================================
	// 10. AISLAMIENTO ESTRICTO Y NO CONTAMINACIÓN DE STORAGE
	// ==========================================
	await t.test(
		'10a. Verificación de no-escritura en localStorage/sessionStorage para auth',
		async () => {
			// Mock de storage en globalThis para auditar llamadas
			const storageCalls = { local: [], session: [] };
			globalThis.localStorage = {
				setItem: (k, v) => storageCalls.local.push({ op: 'set', k, v }),
				getItem: () => null,
				removeItem: (k) => storageCalls.local.push({ op: 'remove', k })
			};
			globalThis.sessionStorage = {
				setItem: (k, v) => storageCalls.session.push({ op: 'set', k, v }),
				getItem: () => null,
				removeItem: (k) => storageCalls.session.push({ op: 'remove', k })
			};

			const browser = createSimulatedBrowser(authRoutes, meRoutes);
			await signIn({ email: testUser.email, password: testPassword }, browser.fetch);
			await getMe(browser.fetch);
			session.setSession({
				user: { id: testUser.id, name: testUser.name, email: testUser.email },
				organizations: [{ id: testOrg.id, name: testOrg.name, slug: testOrg.slug }]
			});
			await signOut(browser.fetch);
			session.clearSession();

			// Verificar que NO se escribió ningún token o credencial
			const allWrites = [...storageCalls.local, ...storageCalls.session];
			const authWrites = allWrites.filter(
				(call) =>
					call.k.includes('token') ||
					call.k.includes('auth') ||
					call.k.includes('session') ||
					call.k.includes('password')
			);
			assert.equal(authWrites.length, 0, 'No debe haber escrituras de auth en Web Storage');

			delete globalThis.localStorage;
			delete globalThis.sessionStorage;
		}
	);

	await t.test('10b. Aislamiento estricto de activeUser demo frente a identidad real', () => {
		// defaultDemoUser permanece con rol demo 'organization_admin' para soportar incidencias locales
		assert.equal(defaultDemoUser.role, 'organization_admin');
		assert.equal(defaultDemoUser.id, 'user-nodhouses-admin');

		// Mientras que la identidad real en session.user solo tiene id, name, email sin roles demo ficticios
		let state;
		const unsub = session.subscribe((s) => (state = s));
		unsub();

		assert.equal(
			'role' in (state.user || {}),
			false,
			'session.user no debe tener rol asignado ficticiamente'
		);
	});
});

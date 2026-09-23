import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
	fixture,
	createCredentialUser,
	createTamperedCookie,
	TEST_ORIGIN
} from './helpers/auth-fixture.mjs';

function makeEvent(
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

let ipCounter = 1;
function nextTestIp() {
	return `10.10.10.${ipCounter++}`;
}

async function callAuth(handler, { method = 'POST', subpath = '', body, headers = {}, url } = {}) {
	const requestUrl = url ?? `${TEST_ORIGIN}/api/auth/${subpath}`;
	const reqHeaders = new Headers(headers);
	if (!reqHeaders.has('origin')) {
		reqHeaders.set('origin', TEST_ORIGIN);
	}
	if (!reqHeaders.has('x-forwarded-for')) {
		reqHeaders.set('x-forwarded-for', nextTestIp());
	}
	if (body !== undefined && !reqHeaders.has('content-type')) {
		reqHeaders.set('content-type', 'application/json');
	}
	const request = new Request(requestUrl, {
		method,
		headers: reqHeaders,
		body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
	});
	const event = makeEvent(request, new URL(requestUrl), { all: subpath });
	const response = await handler(event);
	let json = null;
	const text = await response.text();
	try {
		json = JSON.parse(text);
	} catch {
		// Not JSON response
	}
	return { status: response.status, json, text, response, headers: response.headers };
}

async function callMe(getMe, { headers = {} } = {}) {
	const url = `${TEST_ORIGIN}/api/me`;
	const reqHeaders = new Headers(headers);
	const request = new Request(url, {
		method: 'GET',
		headers: reqHeaders
	});
	const event = {
		request,
		url: new URL(url),
		params: {},
		locals: {},
		cookies: {
			get: () => undefined,
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
		route: { id: '/api/me' },
		setHeaders: () => {}
	};
	const response = await getMe(event);
	const status = response.status;
	const json = await response.json();
	return { status, json, response };
}

test('SoporteFlow — Etapa 5.4B: Endpoints HTTP de Autenticación (Sign-In, Sign-Out, Sesión y Firewall)', async (t) => {
	const f = await fixture(t);
	const { db, schema: s, server } = f;

	const authRoutes = await server.ssrLoadModule('/src/routes/api/auth/[...all]/+server.ts');
	const meRoutes = await server.ssrLoadModule('/src/routes/api/me/+server.ts');
	const { resolvePrincipal } = await server.ssrLoadModule('/src/lib/server/auth/principal.ts');

	// Create user with known credentials
	const testPassword = 'Password12345!Secure';
	const testUser = await createCredentialUser(f, {
		name: 'Operador Principal',
		email: 'operador@soporteflow.test',
		password: testPassword
	});

	// Attach an active organization so /api/me can be fully checked
	const [testOrg] = await db
		.insert(s.organizations)
		.values({ name: 'SoporteFlow Operations', slug: 'ops-' + randomUUID(), status: 'active' })
		.returning();
	await db
		.insert(s.memberships)
		.values({ organizationId: testOrg.id, userId: testUser.id, active: true });

	// ==========================================
	// 1. SIGN-IN EXITOSO Y SANITIZACIÓN
	// ==========================================
	let sessionCookieHeader = '';

	await t.test(
		'1-6. Sign-in exitoso devuelve 200, Set-Cookie HttpOnly y body sanitizado sin token',
		async () => {
			const res = await callAuth(authRoutes.POST, {
				subpath: 'sign-in/email',
				body: { email: testUser.email, password: testPassword }
			});

			assert.equal(res.status, 200, 'Debe devolver 200 OK');

			// 2. Set-Cookie presente
			const setCookie = res.headers.get('set-cookie');
			assert.ok(setCookie, 'Debe emitir header set-cookie');
			assert.ok(
				setCookie.includes('soporteflow-auth.session_token='),
				'Cookie debe tener prefijo soporteflow-auth'
			);

			// 3. HttpOnly
			assert.ok(setCookie.toLowerCase().includes('httponly'), 'Cookie debe ser HttpOnly');

			// 4. SameSite=Lax
			assert.ok(setCookie.toLowerCase().includes('samesite=lax'), 'Cookie debe tener SameSite=Lax');
			assert.ok(setCookie.toLowerCase().includes('path=/'), 'Cookie debe tener Path=/');

			// 5. Body NO contiene token
			assert.ok(res.json, 'Body debe ser JSON');
			assert.equal(res.json.token, undefined, 'Body NO debe contener token');
			assert.equal('token' in res.json, false, 'Propiedad token no debe existir en body');

			// 6. Body NO contiene password ni hash
			assert.equal(res.json.password, undefined);
			assert.equal(res.json.passwordHash, undefined);
			assert.equal(
				res.text.includes(testPassword),
				false,
				'La contraseña no debe aparecer en el texto'
			);

			// User profile en la respuesta
			assert.ok(res.json.user, 'Debe incluir objeto user');
			assert.equal(res.json.user.id, testUser.id);
			assert.equal(res.json.user.email, testUser.email);

			// Guardar cookie para pruebas de sesión posteriores
			const cookieVal = setCookie.split(';')[0];
			sessionCookieHeader = cookieVal;
		}
	);

	// ==========================================
	// 2. FALLOS DE SIGN-IN Y SEGURIDAD
	// ==========================================
	await t.test('7. Password incorrecta devuelve 401 seguro', async () => {
		const res = await callAuth(authRoutes.POST, {
			subpath: 'sign-in/email',
			body: { email: testUser.email, password: 'WrongPassword999!' }
		});
		assert.equal(res.status, 401);
		assert.equal(res.headers.get('set-cookie'), null);
	});

	await t.test('8. Email inexistente devuelve error genérico sin revelar existencia', async () => {
		const res = await callAuth(authRoutes.POST, {
			subpath: 'sign-in/email',
			body: { email: 'nonexistent-user@example.test', password: 'SomePassword123!' }
		});
		assert.equal(res.status, 401);
		assert.equal(res.headers.get('set-cookie'), null);
	});

	await t.test('9. POST sign-up/email permanece bloqueado (404/403)', async () => {
		const res = await callAuth(authRoutes.POST, {
			subpath: 'sign-up/email',
			body: { email: 'public-signup@example.test', password: 'Password12345!', name: 'Public' }
		});
		assert.ok(
			res.status === 404 || res.status === 403,
			`Esperado 404 o 403, recibido ${res.status}`
		);
		assert.equal(res.headers.get('set-cookie'), null);
	});

	await t.test('10. Otras rutas Better Auth no permitidas están bloqueadas', async () => {
		const blockedRoutes = [
			'request-password-reset',
			'reset-password',
			'change-email',
			'change-password',
			'delete-user',
			'list-sessions',
			'revoke-session'
		];
		for (const route of blockedRoutes) {
			const res = await callAuth(authRoutes.POST, {
				subpath: route,
				body: { email: testUser.email }
			});
			assert.ok(
				res.status >= 400 && res.status < 500,
				`Ruta ${route} debe responder 4xx, recibido ${res.status}`
			);
			assert.equal(res.headers.get('set-cookie'), null);
		}
	});

	// ==========================================
	// 3. BOOTSTRAP CON GET /api/me
	// ==========================================
	await t.test('11-12. Cookie de login permite bootstrap exitoso con GET /api/me', async () => {
		assert.ok(sessionCookieHeader, 'Debe existir cookie obtenida en login');
		const res = await callMe(meRoutes.GET, {
			headers: { cookie: sessionCookieHeader }
		});

		assert.equal(res.status, 200);
		assert.equal(res.json.user.id, testUser.id);
		assert.equal(res.json.user.email, testUser.email);
		assert.equal(res.json.organizations.length, 1);
		assert.equal(res.json.organizations[0].id, testOrg.id);
	});

	await t.test('13. Cookie manipulada es rechazada en GET /api/me con 401', async () => {
		const tampered = createTamperedCookie();
		const res = await callMe(meRoutes.GET, {
			headers: { cookie: tampered }
		});
		assert.equal(res.status, 401);
	});

	// ==========================================
	// 4. GET /api/auth/get-session (HTTP bloqueado vs uso interno)
	// ==========================================
	await t.test('14. GET /api/auth/get-session HTTP está bloqueado (404/403)', async () => {
		const res = await callAuth(authRoutes.GET, {
			subpath: 'get-session',
			headers: { cookie: sessionCookieHeader }
		});
		assert.ok(
			res.status === 404 || res.status === 403,
			`GET /api/auth/get-session HTTP debe estar bloqueado, recibido: ${res.status}`
		);
	});

	await t.test('15. resolvePrincipal con cookie válida funciona internamente', async () => {
		const principal = await resolvePrincipal(new Headers({ cookie: sessionCookieHeader }));
		assert.ok(principal, 'resolvePrincipal debe resolver la identidad');
		assert.equal(principal.userId, testUser.id);
	});

	// ==========================================
	// 5. SIGN-OUT Y REVOCACIÓN DE SESIÓN
	// ==========================================
	await t.test(
		'16-19. POST sign-out revoca sesión en DB, emite cookie expirada y GET /api/me da 401',
		async () => {
			// Contar sesiones antes de sign-out
			const sessionsBefore = await db
				.select()
				.from(s.authSessions)
				.where(eq(s.authSessions.userId, testUser.id));
			assert.ok(sessionsBefore.length >= 1, 'Debe haber al menos una sesión en DB');

			// 16. Invocar sign-out
			const res = await callAuth(authRoutes.POST, {
				subpath: 'sign-out',
				headers: { cookie: sessionCookieHeader },
				body: {}
			});
			assert.equal(res.status, 200);
			assert.equal(res.json.success, true);

			// 17. Cookie de expiración presente
			const setCookie = res.headers.get('set-cookie');
			assert.ok(setCookie, 'Debe devolver Set-Cookie de revocación');
			assert.ok(
				setCookie.includes('Max-Age=0') || setCookie.includes('1970'),
				'Cookie debe tener expiración inmediata'
			);

			// 18. Sesión desaparece de auth_sessions en DB
			const sessionsAfter = await db
				.select()
				.from(s.authSessions)
				.where(eq(s.authSessions.userId, testUser.id));
			assert.equal(
				sessionsAfter.length,
				0,
				'La sesión debe ser eliminada de la tabla auth_sessions'
			);

			// 19. Usar cookie antigua en GET /api/me responde 401
			const meRes = await callMe(meRoutes.GET, {
				headers: { cookie: sessionCookieHeader }
			});
			assert.equal(meRes.status, 401, 'Cookie revocada debe dar 401 en /api/me');
		}
	);

	// ==========================================
	// 6. USUARIO CORE INACTIVO
	// ==========================================
	await t.test(
		'20. Usuario Core inactive (users.active=false) autentica en Better Auth pero /api/me da 401',
		async () => {
			const inactivePassword = 'InactivePassword123!';
			const inactiveUser = await createCredentialUser(f, {
				name: 'Usuario Inactivo',
				email: 'inactivo@soporteflow.test',
				password: inactivePassword,
				active: false
			});

			// Better Auth puede autenticar las credenciales a nivel de auth_accounts/auth_users
			const loginRes = await callAuth(authRoutes.POST, {
				subpath: 'sign-in/email',
				body: { email: inactiveUser.email, password: inactivePassword }
			});
			assert.equal(loginRes.status, 200, 'Better Auth autentica credencial');

			const setCookie = loginRes.headers.get('set-cookie');
			assert.ok(setCookie);
			const inactiveCookie = setCookie.split(';')[0];

			// Sin embargo, GET /api/me consulta resolvePrincipal que valida users.active = true
			const meRes = await callMe(meRoutes.GET, {
				headers: { cookie: inactiveCookie }
			});
			assert.equal(
				meRes.status,
				401,
				'Usuario Core inactivo debe ser rechazado con 401 en resolvePrincipal /api/me'
			);
		}
	);

	// ==========================================
	// 7. FIREWALL Y VERBOS NO PERMITIDOS
	// ==========================================
	await t.test('21. Métodos PUT/PATCH/DELETE sobre endpoint auth no están definidos', async () => {
		assert.equal(typeof authRoutes.PUT, 'undefined');
		assert.equal(typeof authRoutes.PATCH, 'undefined');
		assert.equal(typeof authRoutes.DELETE, 'undefined');
	});

	await t.test('22. Rutas administrativas o sociales quedan cerradas', async () => {
		for (const route of [
			'sign-in/social',
			'account-info',
			'unlink-account',
			'list-user-accounts'
		]) {
			const res = await callAuth(authRoutes.POST, { subpath: route });
			assert.ok(res.status >= 400 && res.status < 500, `Ruta ${route} debe fallar con 4xx`);
		}
	});

	await t.test(
		'23. Rate limit protege contra fuerza bruta: 4 intentos rápidos desde la misma IP devuelven 429',
		async () => {
			const fixedIp = '192.168.77.88';
			let lastStatus = 0;
			for (let i = 1; i <= 4; i++) {
				const res = await callAuth(authRoutes.POST, {
					subpath: 'sign-in/email',
					headers: { 'x-forwarded-for': fixedIp },
					body: { email: testUser.email, password: 'WrongPasswordForBruteForce!' }
				});
				lastStatus = res.status;
			}
			assert.equal(
				lastStatus,
				429,
				'El 4º intento consecutivo debe responder 429 Too Many Requests'
			);
		}
	);
});

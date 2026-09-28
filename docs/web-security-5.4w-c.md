# 5.4W-C — Web Security / OWASP Application Hardening

Revisión local de development sobre 70438ef. Implementación y revisión estática; pruebas con PGlite en memoria y servidor SvelteKit compilado sin conexiones externas. No certifica un despliegue ni un navegador real.

## 1. Executive summary

La política HTTP central protege las mutaciones API con Origin exacto, limita y valida JSON, elimina CORS, normaliza errores 500 y aplica cabeceras y caché privada. CSP usa nonces de SvelteKit. Se conserva la autorización transaccional W-A/W-B. Suite completa final: 2478/2478 PASS, sin fallos ni omisiones.

## 2. Attack surface inventory

45 archivos de endpoints. Autenticación por cookie y permisos/tenant en las rutas privadas; invitaciones verify/accept por token. Auth solo admite sign-in/email y sign-out por POST; el resto de su superficie pública está bloqueado. GET internos resuelven sesión sin refrescar ni eliminar sesiones caducadas. Páginas públicas / y /login; /app requiere sesión. Sin form actions, uploads ni webhook entrante. Los webhooks son salientes; su API de administración requiere las mismas defensas que cualquier API privada.

| Ruta                                        | Métodos exportados |
| ------------------------------------------- | ------------------ |
| `/api/auth/[...all]`                        | GET, POST          |
| `/api/automations`                          | GET, POST          |
| `/api/automations/[id]`                     | GET, PATCH, DELETE |
| `/api/automations/[id]/executions`          | GET                |
| `/api/categories`                           | GET, POST          |
| `/api/categories/[id]`                      | PATCH              |
| `/api/incidents`                            | POST, GET          |
| `/api/incidents/[id]`                       | GET, PATCH         |
| `/api/incidents/[id]/assign`                | POST               |
| `/api/incidents/[id]/category`              | PATCH              |
| `/api/incidents/[id]/comments`              | GET, POST          |
| `/api/incidents/[id]/history`               | GET                |
| `/api/incidents/[id]/internal-notes`        | GET, POST          |
| `/api/incidents/[id]/site`                  | PATCH              |
| `/api/incidents/[id]/sla`                   | PATCH              |
| `/api/incidents/[id]/support-level`         | PATCH              |
| `/api/incidents/assignees`                  | GET                |
| `/api/invitations`                          | GET, POST          |
| `/api/invitations/[id]`                     | GET, DELETE        |
| `/api/invitations/[id]/resend`              | POST               |
| `/api/invitations/accept`                   | POST               |
| `/api/invitations/verify`                   | POST               |
| `/api/me`                                   | GET                |
| `/api/memberships`                          | GET                |
| `/api/memberships/[id]`                     | GET                |
| `/api/memberships/[id]/roles`               | POST               |
| `/api/memberships/[id]/roles/[roleId]`      | DELETE             |
| `/api/notification-preferences`             | GET                |
| `/api/notification-preferences/[eventType]` | PUT, DELETE        |
| `/api/notifications`                        | GET, DELETE        |
| `/api/notifications/[id]`                   | GET, PATCH, DELETE |
| `/api/notifications/read-all`               | POST               |
| `/api/notifications/unread-count`           | GET                |
| `/api/permissions`                          | GET                |
| `/api/roles`                                | GET, POST          |
| `/api/roles/[id]`                           | GET, PATCH         |
| `/api/sites`                                | GET, POST          |
| `/api/sites/[id]`                           | PATCH              |
| `/api/sla-policies`                         | GET, POST          |
| `/api/sla-policies/[id]`                    | GET, PATCH         |
| `/api/teams`                                | GET                |
| `/api/webhooks`                             | GET, POST          |
| `/api/webhooks/[id]`                        | GET, PATCH, DELETE |
| `/api/webhooks/[id]/deliveries`             | GET                |
| `/api/webhooks/[id]/rotate-secret`          | POST               |

## 3. CSRF / Origin

Antes había defensas de Origin parciales en determinadas familias. Ahora hooks.server.ts aplica security/web.ts a todas las mutaciones API, también login e invitaciones. BETTER_AUTH_URL define el origen HTTPS de producción; no se deduce de Host ni X-Forwarded-*. Origin ausente, null, ajeno, Fetch Metadata cross-site/same-site y configuración ausente se rechazan. Desarrollo sin configuración solo admite loopback. Pruebas recorren las 38 combinaciones de ruta/método mutante actuales y comprueban que no se ejecuta el resolver ante origen ajeno.

Compatibilidad: clientes de scripts deben enviar Origin con el origen configurado. No existe hoy integración HTTP entrante que necesite excepción. Una futura integración requerirá política explícita y autenticación independiente; no eximir /api/webhooks por prefijo. El proxy debe conservar el origen público correcto para las comprobaciones existentes; probar esto al desplegar.

## 4. CORS

Se eliminan cabeceras Access-Control-* de las respuestas. No se concede lectura cross-origin ni credentials. OPTIONS no abre CORS; CORS no sustituye la validación de Origin.

## 5. Cookies / session browser security

Configuración existente conservada: HttpOnly, SameSite=Lax, Path=/, sin Domain, Secure en HTTPS y prefijo __Secure-. Prueba con getCookies real de Better Auth. cookieCache permanece desactivado. deferSessionRefresh evita que getSession elimine sesiones vencidas durante GET; disableRefresh por sí solo no lo evitaba. El cierre de sesión sigue siendo POST. Las pruebas existentes comprueban revocación persistida, cookie expirada y 401 posterior. La cookie dura 604800 segundos; Better Auth crea una sesión nueva tras verificar credenciales, sin aceptar un identificador de sesión elegido por el cliente (revisión de sign-in).

## 6. Security headers

nosniff, Referrer-Policy=no-referrer, Permissions-Policy que deshabilita camera/microphone/geolocation/payment/usb. HSTS max-age=31536000 únicamente en producción HTTPS configurada y petición HTTPS, sin preload ni includeSubDomains. frame-ancestors none, object-src none y base-uri none en CSP.

## 7. CSP

vite.config.ts configura CSP nonce nativo de SvelteKit; app.html añade %sveltekit.nonce% al arranque del tema. Scripts self y nonce, sin unsafe-inline ni unsafe-eval. Estilos self unsafe-inline por transiciones y barras de porcentaje existentes; imágenes self/data, conexiones y fuentes self. La prueba compilada verifica todos los scripts inline y nonces distintos por respuesta. No hay prerender actual; si se añade, reevaluar nonce frente a hash. Referencia: [configuración oficial de SvelteKit](https://svelte.dev/docs/kit/configuration).

## 8. XSS / output encoding

No se encontraron sinks de HTML sin escapar en la aplicación. Svelte interpola texto con escape; pruebas compilan y renderizan payloads de HTML/script. No se añade sanitizador innecesario ni se afirma cobertura de un futuro renderizador Markdown/HTML. No se realizó navegación E2E autenticada.

## 9. URL / redirect safety

Callbacks auth limitados a rutas internas; se rechazan esquemas, //, barras inversas, controles y variantes codificadas. Redirección protegida a /login es constante. No se identificó un open redirect previo explotable; es defensa adicional a trustedOrigins de Better Auth.

## 10. SQL injection review

Consultas mediante Drizzle y parámetros; no se encontró sql.raw ni SQL de producción concatenado con input. Prueba de consulta compilada confirma valores enlazados. Filtros y orden se seleccionan mediante código/valores permitidos, no fragmentos enviados por el cliente.

## 11. Command/code/template injection

Sin shell, eval, Function ni plantillas ejecutables procedentes de entradas del usuario en la aplicación revisada. Scripts de desarrollo/pruebas no son endpoints públicos.

## 12. SSRF

Se conserva webhooks/url-safety.ts y http-client.ts: HTTPS, comprobación de direcciones DNS IPv4/IPv6, rechazo de redes no públicas, fijación de IP y ausencia de seguimiento de redirects. HMAC y payload saliente no se modifican. No hay handler entrante de firmas raw que pueda romperse por el lector JSON.

## 13. Request validation

JSON máximo 65536 bytes reales, lectura acotada incluso sin Content-Length, UTF-8 válido y objeto JSON. Query máximo 8192 caracteres; claves duplicadas rechazadas. onlyKeys completa rutas antiguas de incidencias, equipos y /me. Enum vacío de status/priority ahora se rechaza. Los lectores de dominio conservan UUID, paginación, enums y campos permitidos. Se mantienen pruebas positivas junto al rechazo de campos desconocidos.

## 14. Content-Type / HTTP methods

Mutaciones con cuerpo: application/json, opcional charset=utf-8. Formularios, multipart, texto y Content-Encoding se rechazan. Operaciones sin cuerpo siguen permitidas según su contrato. Sin method override. Métodos concretos los restringe cada endpoint/SvelteKit; auth PUT/PATCH/DELETE devuelve 405.

## 15. Error disclosure

Excepciones y API 500 devuelven mensaje genérico; handleError no expone stack ni configuración. Se conservan códigos de dominio y 503 UNAVAILABLE. No se ha añadido un rediseño de logging.

## 16. Upload/file surface

No existe upload público identificado. No se incorpora almacenamiento, extracción de ZIP ni procesamiento de archivos. Multipart no es un contrato admitido.

## 17. Cache/privacy

private, no-store para API, /app, /login, invitaciones y respuestas con Set-Cookie, también errores/redirects. Se conserva Set-Cookie. No se deshabilita globalmente la caché de recursos públicos. Las rutas codificadas se clasifican mediante la identidad de ruta del framework.

## 18. SvelteKit-specific findings

Hook servidor único, nonce integrado en el HTML y CSP emitida por el framework, secretos en módulos server, sin acciones de formulario actuales. Se comprueba /%61pi para impedir que un alias codificado eluda la política. La compilación usa adapter-auto: la selección y configuración del adaptador del despliegue queda fuera de esta validación local.

## 19. Dependencies / npm audit

8 paquetes reportados: 4 low, 4 moderate; cero high/critical. No se modifica package.json ni lockfile. No aplicar audit fix --force: las soluciones propuestas incluyen saltos incompatibles/downgrades. Reachable distingue presencia en el proceso de una explotación demostrada.

| Package                 | Severity | Prod/Dev                        | Reachable                                                                                           | Action                          |
| ----------------------- | -------- | ------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------- |
| cookie                  | LOW      | Runtime transitivo              | Serialización posible; nombres/path/domain fijos en configuración, sin control externo identificado | Actualización compatible en W-F |
| @sveltejs/kit           | LOW      | Declarado dev; servidor runtime | Hereda aviso cookie; no vector demostrado                                                           | Revisar cadena en W-F           |
| @sveltejs/adapter-auto  | LOW      | Build                           | Hereda aviso cookie                                                                                 | W-F                             |
| better-auth             | LOW      | Runtime                         | Hereda cookie; atributos fijos                                                                      | W-F                             |
| esbuild                 | MEDIUM   | Tooling dev                     | Aviso de servidor dev; sin superficie esbuild serve desplegada identificada                         | W-F; no exponer servidor dev    |
| @esbuild-kit/core-utils | MEDIUM   | Tooling dev                     | Dependencia de esbuild                                                                              | W-F                             |
| @esbuild-kit/esm-loader | MEDIUM   | Tooling dev                     | Dependencia de esbuild                                                                              | W-F                             |
| drizzle-kit             | MEDIUM   | Tooling dev                     | Cadena esbuild; CLI, no endpoint                                                                    | W-F                             |

Avisos originales: [cookie GHSA-pxg6-pf52-xh8x](https://github.com/advisories/GHSA-pxg6-pf52-xh8x) y [esbuild GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99). No se declara riesgo cero ni se confunde un nodo transitivo con una vulnerabilidad independiente.

## 20. Findings

| ID    | Severity | Area        | Problem                                            | Fix                                | Test                                                   |
| ----- | -------- | ----------- | -------------------------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| WC-01 | HIGH     | CSRF        | Defensa Origin no uniforme                         | Política central exacta            | 38 mutaciones inventariadas y casos de origen          |
| WC-02 | MEDIUM   | Body        | Lectura sin límite uniforme y MIME variable        | 64 KiB, JSON/UTF-8 estricto        | Cuerpo declarado y streaming, tipos y formas inválidas |
| WC-03 | MEDIUM   | Browser     | Sin CSP/cabeceras centrales                        | Nonce y cabeceras                  | Servidor compilado, 14 comprobaciones                  |
| WC-04 | MEDIUM   | Cache       | Caché privada no uniforme                          | private/no-store central           | API, errores, login, redirección y cookies             |
| WC-05 | LOW      | GET/session | Sesión vencida podía borrarse durante lectura      | deferSessionRefresh                | Sesión caducada permanece en DB de prueba              |
| WC-06 | LOW      | Query       | Campos desconocidos ignorados y enum vacío omitido | onlyKeys y validación de undefined | Rechazo y consultas válidas de control                 |

Las severidades priorizan hardening; no se ha demostrado explotación de cada carencia. No se detectó un blocker residual en la superficie revisada.

## 21. Files modified

- `src/app.html`
- `src/lib/server/auth/instance.ts`
- `src/lib/server/services/incidents.ts`
- `src/routes/api/incidents/+server.ts`
- `src/routes/api/incidents/[id]/+server.ts`
- `src/routes/api/incidents/[id]/assign/+server.ts`
- `src/routes/api/incidents/[id]/support-level/+server.ts`
- `src/routes/api/incidents/assignees/+server.ts`
- `src/routes/api/me/+server.ts`
- `src/routes/api/teams/+server.ts`
- `tests/effective-permissions.test.mjs`
- `tests/incidents-api.test.mjs`
- `tests/incidents-category-change.test.mjs`
- `tests/incidents-customer-access.test.mjs`
- `tests/incidents-history-api.test.mjs`
- `tests/me-api.test.mjs`
- `tests/theme.test.mjs`
- `vite.config.ts`
- Nuevos: src/hooks.server.ts, src/lib/server/security/web.ts, src/lib/server/security/query.ts.
- Nuevos: tests/web-security.test.mjs, tests/web-security-render.mjs, docs/web-security-5.4w-c.md.

## 22. Migrations

None. Migraciones 0000..0025 sin modificar ni ejecutar contra una base real.

## 23. Tests added/modified

web-security.test.mjs: 62 pruebas incluyendo subtests; web-security-render.mjs: 14 comprobaciones compiladas. Actualizadas pruebas de incidencias, categorías, historial, acceso Customer, /me y permisos por rechazo explícito de query desconocida; conservan controles positivos. Prueba de tema reconoce nonce y continúa ejecutando el bootstrap.

## 24. Test results

Validación final local completada el 28-09-2026:

| Comprobación                                      | Resultado                                                    |
| ------------------------------------------------- | ------------------------------------------------------------ |
| npm run check                                     | PASS, 0 errores y 0 warnings                                 |
| npm run lint                                      | PASS (Prettier y ESLint)                                     |
| git diff --check                                  | PASS                                                         |
| Targeted W-C                                      | 62/62 PASS                                                   |
| Targeted auth/W-A/W-B/webhooks                    | 192/192 PASS en la ejecución inicial de hardening            |
| Regresión categorías/historial/Customer           | 109/109 PASS tras ajustar fixtures                           |
| node --test --test-concurrency=1 tests/*.test.mjs | 2478/2478 PASS; 0 fail, cancelled, skipped o todo; 355598 ms |
| npm run build                                     | PASS                                                         |
| node tests/web-security-render.mjs                | 14/14 comprobaciones PASS                                    |
| npm audit                                         | 8 avisos analizados: 4 low, 4 moderate; 0 high/critical      |

Las ejecuciones intermedias detectaron expectativas antiguas de query, fixtures POST que enviaban organizationId en query y el selector del script del tema. Se ajustaron al contrato nuevo, preservando casos positivos y comprobaciones de aislamiento; la ejecución completa final terminó en verde. No se ejecutó E2E autenticado en navegador ni se validó un proxy de producción.

## 25. PostgreSQL real required?

NO. No se modifican locks, aislamiento, esquema ni algoritmos transaccionales. Suite usa PGlite en memoria; smoke compilado con autenticación desactivada y sin red/DB. No se vuelve a afirmar ni ejecutar el 50/50 histórico como validación de este cambio.

## 26. Deferred scope

- W-D: rate limiting general, brute force y cuotas; se conserva lo existente de Better Auth.
- W-E: secretos, runbooks, observabilidad y auditoría administrativa.
- W-F: actualización compatible y validación de dependencias señaladas por audit.
- X: health/readiness, índices/rendimiento, invitation outbox y refactor arquitectónico.

## 27. Git status

development sobre 70438ef. Cambios locales sin stage/commit/push. ZIP soporteflow-lab-concurrency.zip preexistente, untracked y sin tocar. Ningún cambio a package.json/package-lock.json o migraciones.

ESTADO 5.4W-C:
IMPLEMENTACIÓN COMPLETA

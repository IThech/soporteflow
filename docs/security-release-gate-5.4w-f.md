# Security release gate — 5.4W-F

Cierre transversal de 5.4W (W-A → W-E) sobre `development` @ `333b680` más las correcciones
W-F. Sin secretos. Evidencia reproducible con los comandos de §C.

## A. Alcance W-A → W-F

| Fase | Contenido                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W-A  | Concurrencia real en PostgreSQL 17 (CT 105), `withActorAuthorization` (lock de organización → actor → recurso), leases H2 en workers, Proxy `db` con trampa `has`.                   |
| W-B  | BOLA/IDOR/tenant: modelo de acceso a incidencias (view_all/own/requested), 404 sin oráculo, DTO de solicitante, historial filtrado, notas internas con alcance, `withIncidentActor`. |
| W-C  | Origin exacto (CSRF), sin CORS, CSP con nonce, cabeceras, validación JSON (64 KiB, UTF-8, tipos), 500 genérico, `no-store`.                                                          |
| W-D  | Limitador por IP/identidad/usuario/tenant, login e invitaciones, lecturas acotadas (422 > 500 filas), `Retry-After`, fail-closed en mutaciones.                                      |
| W-E  | Validación de entorno en arranque, logger JSON, redacción, `X-Request-ID`, eventos de seguridad con throttling, aislamiento por elemento en workers, timeout de invitación.          |
| W-F  | Auditoría final; correcciones: ReDoS en la redacción (F-1), cabeceras base en el 500 de último recurso (F-2); smoke del build de producción.                                         |

## B. Release gates

| Gate | Área                            | Resultado                                                           |
| ---- | ------------------------------- | ------------------------------------------------------------------- |
| G1   | Auth/sesión                     | PASS                                                                |
| G2   | Aislamiento de tenant           | PASS                                                                |
| G3   | Autorización transaccional      | PASS                                                                |
| G4   | Endpoints públicos              | PASS                                                                |
| G5   | CSRF/CORS/CSP                   | PASS WITH ACCEPTED LIMITATION (CORS `*` solo en `vite dev/preview`) |
| G6   | Validación de entrada acotada   | PASS                                                                |
| G7   | SSRF/webhooks                   | PASS                                                                |
| G8   | Rate limiting                   | PASS WITH ACCEPTED LIMITATION (memoria, una instancia)              |
| G9   | Secretos/configuración          | PASS                                                                |
| G10  | Logging sin fugas               | PASS (tras F-1)                                                     |
| G11  | Workers resilientes             | PASS                                                                |
| G12  | Dependencias                    | PASS WITH ACCEPTED LIMITATION (4 LOW + 4 MODERATE no alcanzables)   |
| G13  | Tests                           | PASS                                                                |
| G14  | Concurrencia en PostgreSQL real | PASS (W-A/W-B en CT 105; W-C…W-F sin cambios de concurrencia)       |
| G15  | Sin BLOCKER/HIGH conocidos      | PASS                                                                |

## C. Evidencia de tests

```
npm run check                                   # 0 errores / 0 warnings
npm run lint                                    # prettier + eslint limpios
git diff --check
npm run build                                   # OK (adapter-auto: ver §F)
node --test --test-concurrency=1 tests/*.test.mjs
node tests/smoke/production-build-smoke.mjs     # tras npm run build
npm run test:concurrency                        # solo en el laboratorio PostgreSQL (CT 105)
```

Suites de seguridad dedicadas: `security-bola-tenant`, `incidents-customer-access`,
`web-security`, `rate-limit-security`, `operational-security`, `actor-authorization`,
`auth-*`, `invitations-*`, `notification-delivery`, `webhooks`, `automation-*`, y el laboratorio
`tests/concurrency/*` (PostgreSQL real). Resultado W-F: ver informe final (0 fail, 0 skipped).

El smoke del build ejecuta el servidor **compilado** (`vite preview`, `dev === false`) con
configuración sintética y verifica: el servidor **no arranca** sin secreto, con secreto débil o
de laboratorio, o con `BETTER_AUTH_URL` HTTP (el error nombra la variable, nunca el valor); con
configuración válida sirve con CSP con nonce por respuesta (sin `unsafe-inline` en scripts),
`nosniff`, `Referrer-Policy`, `Permissions-Policy`, `no-store`, `X-Request-ID`, sin HSTS sobre
HTTP, rechazo de Origin ajeno (403) y ningún secreto en respuestas ni en la salida del servidor.

## D. Auditoría de dependencias (`npm audit`, W-F)

Total 8: 4 LOW + 4 MODERATE, 0 HIGH, 0 CRITICAL (idéntico a W-C).

| Paquete                                                             | Sev.     | Runtime/Dev              | Alcance                                                                                                            | Fix                                    | Decisión |
| ------------------------------------------------------------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | -------- |
| `cookie` <0.7.0 (vía `@sveltejs/kit` 2.70.3)                        | LOW      | runtime (kit)            | Nombres/path/domain fuera de rango al **serializar**; la app no usa `event.cookies`; Better Auth usa nombres fijos | Solo "downgrade" mayor (falso)         | Aceptar  |
| `@sveltejs/kit`, `@sveltejs/adapter-auto`, `better-auth`            | LOW      | runtime/dev              | Solo por la cadena `cookie` anterior                                                                               | Downgrade mayor (falso)                | Aceptar  |
| `esbuild` ≤0.24.2 (vía `@esbuild-kit/*` ← `drizzle-kit`)            | MODERATE | dev (CLI de migraciones) | Servidor de desarrollo de esbuild; `drizzle-kit` no se ejecuta en runtime ni expone servidor                       | Downgrade mayor de drizzle-kit (falso) | Aceptar  |
| `@esbuild-kit/core-utils`, `@esbuild-kit/esm-loader`, `drizzle-kit` | MODERATE | dev                      | Misma cadena                                                                                                       | Idem                                   | Aceptar  |

No se ejecutó `npm audit fix --force`. Ninguna actualización aporta mejora de seguridad sin
cambio mayor. Versiones: SvelteKit 2.70.3, Better Auth 1.7.5, drizzle-orm 0.45.2, postgres 3.4.9,
Vite 8.2.2, adapter-auto 7.0.1, drizzle-kit 0.31.10.

## E. Riesgos aceptados

| Riesgo                                                        | Impacto                                                                      | Por qué se acepta                                                          | Fase futura                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------- |
| Limitador y throttling de logs en memoria por proceso         | Con N instancias los límites se multiplican por N; se reinician al reiniciar | Staging inicial de una instancia; interfaz `AbuseStore` preparada          | X / despliegue                |
| Invitación por email síncrona post-commit (sin outbox)        | Un fallo deja la invitación pendiente (reenvío manual); timeout de 15 s      | Fallo explícito y seguro; sin pérdida de datos                             | X-C                           |
| Sin proveedor de email real                                   | No se envían emails (fallo explícito `PROVIDER_NOT_CONFIGURED`)              | Nunca simula éxito; outbox reintenta y agota de forma detectable           | X-C                           |
| Sin audit trail administrativo inmutable                      | Solo log operacional (no append-only)                                        | Fuera de alcance de W                                                      | X-A                           |
| Sin métricas/health/readiness                                 | Detección de incidentes solo por logs                                        | Logs estructurados con eventos alertables                                  | X-B                           |
| Listas legadas acotadas (> 500 filas → 422)                   | Tenants grandes reciben 422 en listados no paginados                         | Evita lecturas ilimitadas; paginación futura                               | X-D                           |
| Advisories LOW/MODERATE de tooling (§D)                       | No alcanzables en producción                                                 | Sin fix no-breaking                                                        | Revisión periódica            |
| Entrega at-least-once de email/webhook                        | Duplicado posible si el proceso muere tras enviar                            | Documentado; receptores deduplican por id de evento                        | —                             |
| `Access-Control-Allow-Origin: *` en `vite dev`/`vite preview` | Solo herramientas; `*` nunca autoriza lecturas con credenciales              | Impuesto por el plugin de SvelteKit; la salida del adaptador no lo incluye | —                             |
| Adaptador `adapter-auto` sin plataforma detectada             | `npm run build` no produce artefacto desplegable                             | Elección del adaptador es parte del despliegue                             | Despliegue (antes de staging) |

## F. Supuestos de despliegue

- Seleccionar un adaptador concreto (p. ej. `@sveltejs/adapter-node`) antes de staging;
  `adapter-auto` no detecta plataforma local. Repetir el smoke (§C) con ese artefacto.
- Una única instancia de aplicación (limitador en memoria) hasta implementar un `AbuseStore`
  distribuido.
- HTTPS terminado en el proxy; `BETTER_AUTH_URL` = origen HTTPS público exacto.
- Workers (`processDue*`) invocados por un planificador externo (no incluido); una invocación a la
  vez por tipo es suficiente, varias concurrentes son seguras (SKIP LOCKED + leases).

## G. Entorno de producción requerido

`BETTER_AUTH_ENABLED=true`, `BETTER_AUTH_SECRET` (aleatorio ≥ 32), `BETTER_AUTH_URL` (HTTPS),
`DATABASE_URL`, `NODE_ENV=production`, opcional `WEBHOOK_SECRET_ENCRYPTION_KEY` (32 bytes) y
`LOG_LEVEL`. Detalle y rotación: `docs/operational-security-5.4w-e.md`.

## H. Supuestos de proxy

- La IP de cliente es la del **par TCP del adaptador** (`getClientAddress`); nunca se leen
  `X-Forwarded-For`/`Forwarded`. Detrás de un proxy, configurar el adaptador para que derive la IP
  del proxy de confianza (p. ej. `ADDRESS_HEADER` + `XFF_DEPTH` en adapter-node) o todos los
  clientes compartirán el bucket del proxy (fail-safe: más restrictivo, no más permisivo).
- El proxy debe preservar `Origin`/`Host` y no añadir cabeceras CORS.
- Cloudflare u otro CDN: sin cachear `/api`, `/app`, `/login`, `/invitations` (ya `no-store`).

## I. Limitaciones de instancia única

Limitador W-D, limitadores de invitación y throttling de logs viven en memoria del proceso: no
hay protección distribuida. La mitigación de DDoS volumétrico es responsabilidad de red/infra.

## J. Deuda de seguridad movida a X

- **X-A**: audit trail administrativo append-only.
- **X-B**: métricas, OpenTelemetry, `/healthz`/`/readyz`, alertas.
- **X-C**: outbox de invitaciones, proveedor de email real (TLS, credenciales validadas), key-ring
  de la clave de cifrado de webhooks, contratos API.
- **X-D**: jobs de retención (entregas, eventos, logs), paginación de listas legadas, índices.

## K. Criterios GO / NO-GO

GO para 5.4X si todo se cumple:

1. `check`, `lint`, `diff --check`, `build` limpios.
2. Suite completa: 0 fail, 0 cancelled, 0 skipped.
3. Smoke del build: 5/5 PASS.
4. `npm audit`: 0 HIGH/CRITICAL alcanzables.
5. Sin hallazgos BLOCKER/HIGH abiertos.
6. Ningún cambio de esquema/transacción/locks sin validar en PostgreSQL real.

NO-GO ante cualquier fuga cross-tenant, bypass de auth, fuga de secretos, suite de seguridad en
rojo o cambio de concurrencia sin validar en CT 105.

Antes de **staging** (no bloquea 5.4X): adaptador concreto, smoke sobre su artefacto, planificador
de workers, recolector de logs y supuestos de proxy de §H.

# Seguridad operacional — 5.4W-E

Secretos, validación de entorno, logging estructurado, correlación y seguridad operativa de los
procesadores de email y webhooks. **No incluye** valores reales de secretos.

> Log operacional ≠ audit trail administrativo. Este log es técnico, no append-only, no
> tamper-evident y puede muestrearse (throttling). El registro administrativo inmutable es 5.4X-A.

## 1. Inventario de variables

| Variable                        | Uso                                                       | Requerida                                           | Entorno    | Clase                    |
| ------------------------------- | --------------------------------------------------------- | --------------------------------------------------- | ---------- | ------------------------ |
| `BETTER_AUTH_SECRET`            | Firma de cookies de sesión (Better Auth)                  | Sí si `BETTER_AUTH_ENABLED=true`                    | todos      | **secreto**              |
| `BETTER_AUTH_ENABLED`           | Activa `/api/auth/*`                                      | No (`false` por defecto)                            | todos      | config                   |
| `BETTER_AUTH_URL`               | Origen público: baseURL de auth y política Origin (W-C)   | Sí en producción; sí si auth activa                 | todos      | config                   |
| `DATABASE_URL`                  | Conexión PostgreSQL (postgres-js)                         | Sí si auth activa (y para toda API real)            | todos      | **secreto** (contraseña) |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | AES-256-GCM de los secretos de firma de webhooks          | No (sin ella: webhooks 503 / `CONFIGURATION_ERROR`) | todos      | **secreto**              |
| `LOG_LEVEL`                     | Umbral del log estructurado                               | No (`info`)                                         | todos      | config                   |
| `NODE_ENV`                      | Solo validado: no puede ser `development`/`test` en build | No                                                  | producción | config                   |

Secretos derivados en proceso (nunca persistidos): la sal HMAC de las claves del limitador W-D
(`randomBytes(32)` por proceso). Secretos de dominio: tokens de invitación (32 bytes aleatorios;
en BD solo SHA-256), secretos de firma de webhook `whsec_…` (32 bytes; en BD solo cifrados, AAD
ligado a `(subscriptionId, version)`, IV aleatorio de 12 bytes por cifrado).

**No existe proveedor de email real** (ni SMTP ni API key): los senders por defecto fallan
explícitamente (`PROVIDER_NOT_CONFIGURED` / `EmailDeliveryError`). Cuando se integre uno, sus
credenciales irán en variables nuevas validadas en `src/lib/server/config/env.ts`.

## 2. Validación de arranque

`hooks.server.ts` exporta `init` → `validateServerEnvironment` (`src/lib/server/config/env.ts`).
Si falla, el servidor **no arranca**; el error lista `VARIABLE problema`, nunca un valor:

```
Invalid server configuration: BETTER_AUTH_SECRET is a trivial or default value; BETTER_AUTH_URL must use HTTPS in production
```

- **Producción** (build, `dev === false`): `BETTER_AUTH_URL` obligatoria y HTTPS, sin ruta,
  credenciales, query ni fragmento; secreto ≥ 32 caracteres, no trivial (`isTrivialSecret`: menos
  de 10 caracteres distintos, placeholders, patrones repetidos) y sin marcadores de laboratorio
  (`test`, `example`, `synthetic`, `changeme`, …); `DATABASE_URL` PostgreSQL válida; clave de
  webhooks de 32 bytes y no trivial si está definida; `NODE_ENV` no `development`/`test`.
- **Desarrollo/test**: nada es obligatorio salvo que la función esté activa; HTTP solo en loopback.
  Los tests usan secretos sintéticos; producción nunca hereda el modo práctico.
- `readAuthConfig` (arranque perezoso de Better Auth) también rechaza secretos triviales.
- Resumen registrado (`config.validated`): modo, auth, origen público, destino de BD **sin
  credenciales**, estado de firma de webhooks, nivel de log y nº de advertencias.

## 3. Frontera cliente/servidor

- `$env/dynamic/private` y `process.env` solo en `src/lib/server/**` y `hooks.server.ts`.
- Ningún `$env/*/public`. La única `load` de servidor (`app/+layout.server.ts`) devuelve `userId`.
- Guard estático (test 30) y escaneo del bundle cliente tras `npm run build`: sin nombres de
  variables secretas ni valores.

## 4. Logging estructurado

`src/lib/server/logging/logger.ts`: una línea JSON por evento, sin dependencias.

```json
{
	"ts": "…",
	"level": "warn",
	"event": "email.delivery_retry",
	"jobId": "…",
	"worker": "notification_email",
	"deliveryId": "…",
	"attempt": 2,
	"code": "NETWORK_ERROR"
}
```

- Niveles `debug|info|warn|error` (`LOG_LEVEL`, `silent` en tests). warn/error → stderr.
- Contexto por `AsyncLocalStorage`: `requestId` (HTTP), `jobId`/`worker` (procesadores).
- Campos reservados (`ts`, `level`, `event`, `requestId`, …) no sobrescribibles (`field_x`).
- Nombres de evento validados; un nombre inválido se registra como `log.invalid_event_name`.
- El logger nunca lanza: un fallo de logging no rompe la petición ni el worker.

### Eventos

| Evento                                                   | Nivel             | Campos                                                           |
| -------------------------------------------------------- | ----------------- | ---------------------------------------------------------------- |
| `config.validated` / `config.warning` / `config.invalid` | info/warn/error   | resumen sin valores / variable+problema                          |
| `http.request`                                           | info (5xx: error) | method, route (plantilla), status, durationMs                    |
| `http.unhandled_error` / `http.internal_error`           | error             | error {name, code, message y stack redactados}                   |
| `security.request_rejected`                              | warn/info         | reason (constante), status, method, route — _throttled_          |
| `security.rate_limited`                                  | warn              | policy, retryAfterSeconds — _throttled_                          |
| `security.limiter_unavailable`                           | error             | failClosed, error — _throttled_                                  |
| `security.login_failed`                                  | info              | status — _throttled_                                             |
| `email.delivery_retry/_failed/_exhausted/_error`         | warn/error        | deliveryId, attempt, code, lastCode                              |
| `email.lease_lost`, `email.batch_completed`              | warn/info         | ids / contadores                                                 |
| `email.invitation_delivery_failed`                       | warn              | invitationId, errorName                                          |
| `webhook.delivery_retry/_failed/_exhausted/_error`       | warn/error        | deliveryId, subscriptionId, eventType, attempt, code, statusCode |
| `automation.execution_failed/_error/_exhausted`          | warn/error        | executionId, code                                                |
| `log.suppressed`                                         | = original        | suppressedEvent, bucket, count                                   |

## 5. Redacción (`src/lib/server/logging/redact.ts`)

- **Por clave** (normalizada): password, secret, token, authorization, cookie, api key, access/
  private key, credential, signature, encryption key, database url, dsn, smtp pass/auth/user,
  salt, ciphertext, auth tag, session, otp, `key`, `iv` → `[REDACTED]`, sea cual sea el valor.
- **Cabeceras** (`Headers`): Authorization, Cookie, Set-Cookie, X-Api-Key…
- **Texto libre** (mensajes de error, stacks): userinfo de URLs (`postgresql://[REDACTED]@host`),
  `Bearer/Basic …`, `whsec_…`, pares `password=`/`token=`/`session_token=`, pares JSON
  `"password":"…"`, claves hex de 64, base64 de 32 bytes, y cualquier racha base64url ≥ 40
  (tokens de invitación de 43).
- **Límites**: string 512 (stack 4096), profundidad 4, 32 claves, 20 elementos; línea ≤ 8 KiB.
  `Request`/`Response`/streams/buffers nunca se serializan.
- Es una red de seguridad: el código registra ids y códigos, **nunca cuerpos**.

**No registrar nunca**: contraseñas, email+contraseña, tokens (invitación, sesión, lease), cookies,
cabeceras de autorización, secretos de webhook o su firma, URLs destino de webhook (pueden llevar
credenciales del receptor), cuerpos de petición/webhook, notas internas, descripciones de
incidencias, direcciones de email de destinatarios, respuestas de proveedores, `DATABASE_URL`.

Las rutas públicas de invitación (`/api/invitations/verify|accept`, `public.ts`) no registran
nada propio (guard W-S): solo la línea de acceso con la plantilla de ruta y el requestId.

## 6. Request ID / correlación

- UUID v4 generado **siempre** en el servidor (`observeRequest`); `X-Request-ID` del cliente se
  ignora (ni se confía ni se refleja).
- `event.locals.requestId`, contexto de log de toda la petición y cabecera `X-Request-ID` en todas
  las respuestas (2xx, 4xx, 5xx, 429, 503 y rechazos tempranos de W-C).
- El cuerpo de error público no cambia (`INTERNAL_ERROR`, sin stack); el soporte correlaciona con
  la cabecera.

## 7. Errores

- Respuesta pública genérica (`INTERNAL_ERROR` / `Internal server error.`), sin SQL, rutas, env,
  stack ni respuestas de proveedores (W-C, intacto).
- Stack redactado solo en el log: `handleWebRequest` (excepciones), `handleError` (5xx de
  SvelteKit) y `logUnexpectedError` en cada rama 500 de las rutas API (guard en el test 17-18).

## 8. Email

**Notificaciones (outbox existente, 5.4U-D/W-A)** — sin cambios de SQL, locks ni transacciones:

- Intención en la transacción de dominio; claim corto `FOR UPDATE SKIP LOCKED` + lease token;
  envío fuera de transacción con timeout (30 s); resultado guardado por lease; renovación H2 antes
  de enviar; 5 intentos con backoff 1 min/5 min/30 min/2 h; errores clasificados a códigos
  seguros (el mensaje del proveedor nunca se persiste ni se registra).
- 5.4W-E: aislamiento por elemento (una excepción inesperada — p. ej. BD — ya no aborta el lote:
  `errors`, el elemento conserva su lease y se reclama al expirar, sumando intento hasta
  `MAX_ATTEMPTS`), logs de retry/fallo/agotamiento y del cierre `MAX_ATTEMPTS` en el claim
  (worker muerto con el último intento).
- Semántica at-least-once documentada; un fallo de email nunca revierte el dominio ya confirmado.

**Contenido**: text/plain; asunto de una línea (controles/CRLF colapsados); textos fijos del
servidor; dirección leída en el envío (identidad de login, validación conservadora sin CR/LF).

**Invitaciones**: envío síncrono post-commit (sin outbox, deuda **X-C**). 5.4W-E añade timeout de
15 s (`INVITATION_EMAIL_SEND_TIMEOUT_MS`) y log `email.invitation_delivery_failed` sin token ni
dirección; la invitación queda pendiente y se reenvía con token nuevo. Un futuro adaptador debe:
TLS obligatorio, credenciales por env validadas, escapar HTML si genera HTML, quitar CR/LF de
cabeceras y construir el enlace con el origen configurado (nunca `Host`).

## 9. Webhooks

Sin cambios en cripto, SSRF, IP fijada, redirecciones (desactivadas), leases ni SQL. 5.4W-E:
aislamiento por elemento (`errors`), logs de retry/fallo/agotamiento con ids, código y estado HTTP
— nunca URL destino, cabeceras, firma, secreto ni cuerpo. Timeout total 10 s por POST.

## 10. Automatizaciones

Ya aislaban cada ejecución (transacción propia + registro del fallo). 5.4W-E añade `jobId` y logs
de `INTERNAL_ERROR` (stack redactado), `ACTION_INVALID` y agotamiento por conflicto.

## 11. Parada y reinicio

No hay scheduler ni worker residente (entradas acotadas por invocación). Un proceso que muere a
mitad: los claims quedan `processing` con lease y se reclaman al expirar (5 min); el cierre por
`MAX_ATTEMPTS` es detectable (`*.delivery_exhausted`). No se requiere parada ordenada.

## 12. Timeouts de llamadas externas

| Llamada               | Timeout                                           |
| --------------------- | ------------------------------------------------- |
| Email de notificación | 30 s (`NOTIFICATION_EMAIL_SEND_TIMEOUT_MS`)       |
| Email de invitación   | 15 s (`INVITATION_EMAIL_SEND_TIMEOUT_MS`) — nuevo |
| POST de webhook       | 10 s total, `req.destroy()`                       |
| Conexión PostgreSQL   | `connect_timeout` 10 s                            |

## 13. Inyección en logs / DoS

- JSON por línea: CR/LF/ESC escapados por JSON; C1 (incl. CSI 0x9B) y U+2028/U+2029 escapados.
- Valores acotados (§5) y línea ≤ 8 KiB.
- Eventos provocables por un atacante (rechazos W-C, 429, login fallido, limitador caído):
  máximo 20 por evento+bucket por minuto, después un `log.suppressed` con el recuento. El bucket
  es siempre una constante del servidor (razón/política), nunca texto de la petición.
- La línea de acceso usa la plantilla de ruta, nunca la ruta cruda ni la query.

## 14. Rotación de secretos

| Secreto                         | Impacto de rotar                                                                                     | Procedimiento                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`            | **Invalida todas las sesiones** (firma de cookie)                                                    | Despliegue coordinado; comunicar re-login.                                                                                                            |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | **Requiere re-cifrado**: con otra clave los secretos no descifran (`CONFIGURATION_ERROR`, reintento) | Sin key-ring: rotar el secreto de firma de cada webhook (`rotate-secret`) tras cambiar la clave, o re-cifrar offline antes; coordinar con receptores. |
| Secreto de firma `whsec_…`      | Seguro por suscripción; el receptor debe actualizarlo                                                | `POST /api/webhooks/{id}/rotate-secret` (se muestra una vez; las entregas firman con la versión registrada en la intención).                          |
| Credenciales SMTP/API (futuras) | Seguro; entregas en curso reintentan                                                                 | Cambiar env + reinicio; fallos transitorios reintentan.                                                                                               |
| Credenciales de BD              | Requiere despliegue coordinado (pool reconecta con la nueva URL)                                     | Crear credencial nueva, desplegar, revocar la antigua.                                                                                                |
| Sal del limitador               | Automática por proceso (reinicio = ventanas nuevas)                                                  | —                                                                                                                                                     |

## 15. Flujo de diagnóstico

1. El usuario reporta un error: pedir la cabecera `X-Request-ID` (DevTools → Red).
2. Filtrar el log por `requestId`: `http.request` (ruta/estado/duración) y, si hubo 500,
   `http.internal_error` / `http.unhandled_error` con stack redactado.
3. Entregas: filtrar por `deliveryId`/`subscriptionId` o `jobId`; estado autoritativo en
   `notification_deliveries` / `webhook_deliveries` (`last_error_code`, `attempt_count`).
4. Nunca pedir ni pegar cookies, tokens o secretos en tickets.

## 16. Checklist de producción W-E

- [ ] `BETTER_AUTH_URL` = origen HTTPS público exacto.
- [ ] `BETTER_AUTH_SECRET` aleatorio ≥ 32 (p. ej. `openssl rand -base64 32`), fuera del repo.
- [ ] `DATABASE_URL` con usuario de mínimo privilegio; no aparece en logs (solo host/BD).
- [ ] `WEBHOOK_SECRET_ENCRYPTION_KEY` de 32 bytes aleatorios si se usan webhooks.
- [ ] `NODE_ENV=production`, `LOG_LEVEL=info`.
- [ ] Arranque sin `config.invalid`; revisar `config.warning`.
- [ ] Recolector de logs que conserve stderr/stdout JSON y restrinja el acceso (contienen ids).
- [ ] Alertas sobre `*.delivery_exhausted`, `security.limiter_unavailable`, `http.internal_error`.

## 17. Límites conocidos

- Throttling y limitador en memoria por proceso (varios procesos multiplican los límites).
- Sin métricas/health/readiness (X-B) ni audit trail (X-A).
- Invitaciones sin outbox duradero (X-C).
- La redacción por patrones puede tener falsos positivos (rachas largas en rutas de stack) y no
  sustituye la disciplina de no registrar datos sensibles.

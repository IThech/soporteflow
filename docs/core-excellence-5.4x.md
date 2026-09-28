# Core Excellence — 5.4X

Estado: **X-A, X-B, X-C (contratos + outbox de invitaciones) y X-D cerradas · X-E evaluada (no necesaria ahora)**. Pendiente: validación del outbox en PostgreSQL real (CT 105).

## 1. X-A — Audit trail administrativo

### Arquitectura

- **Distinto del log operacional (W-E)**: el log es técnico, rotable, no autoritativo; el audit
  trail es persistente, consultable, tenant-scoped y append-only.
- **Distinto de `incident_history`**: los hechos de incidencias (incluido el SLA asignado a una
  incidencia) siguen en su historial; el audit trail no los duplica.
- **Transaccional**: el evento se escribe con la **misma transacción** que la mutación, dentro de
  `withActorAuthorization` (W-A): organización bloqueada → actor revalidado → mutación → evento.
  Un rollback (error de dominio, 403 por autoridad perdida, fallo posterior) no deja evento.
  Helper `withAudit(tx, org, actor, mutate, describe)`; `describe` puede devolver `null` para
  no auditar no-ops (re-concesión idempotente de rol).
- **Actores**: `user` (con `actor_user_id`), `system`, `automation`, `platform` (sin usuario);
  CHECK en BD.
- **Correlación**: `request_id` = requestId server-side de W-E (AsyncLocalStorage); nunca input.

### Esquema (`audit_events`, migración 0026)

| Columna                                             | Notas                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `id` uuid PK                                        |                                                                    |
| `organization_id` uuid NOT NULL                     | FK `organizations` ON DELETE CASCADE (solo baja de tenant)         |
| `actor_type` varchar(20)                            | `user` \| `system` \| `automation` \| `platform` (CHECK con actor) |
| `actor_user_id`, `entity_id`, `target_user_id` uuid | referencias históricas **sin FK**                                  |
| `action` varchar(80)                                | `entidad.verbo` snake_case (CHECK regex)                           |
| `entity_type` varchar(40)                           | snake_case (CHECK)                                                 |
| `metadata` jsonb                                    | objeto ≤ 4 KiB (CHECK); saneado por el servicio                    |
| `request_id` uuid, `created_at` timestamptz         |                                                                    |

Índices: `(organization_id, created_at, id)` (listado), `(organization_id, entity_type,
entity_id, created_at)` (investigación por entidad), `(organization_id, actor_user_id,
created_at)` (por actor). Trigger `audit_events_append_only` rechaza todo `UPDATE`. No hay ruta
ni función de servicio que actualice o borre; `DELETE` solo ocurre por la cascada de baja de
tenant. Retención: decisión de X-D (no se borra nada ahora).

### Acciones auditadas

| Dominio          | Acciones                                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Categorías       | `category.created`, `category.updated` (`fields`), `category.activated/deactivated`                                                                                                                 |
| Sedes            | `site.created`, `site.renamed`, `site.activated/deactivated`                                                                                                                                        |
| Roles            | `role.created` (`code`, `permissionIds`), `role.updated` (`fields`, `active`, `permissionIds`)                                                                                                      |
| Membresías       | `membership.role_granted` / `membership.role_revoked` (`roleId`)                                                                                                                                    |
| Invitaciones     | `invitation.created` / `invitation.resent` (`roleId`), `invitation.revoked`, `invitation.accepted` (actor = identidad que acepta; `roleId`, `membershipId`, `membershipCreated`, `identityCreated`) |
| SLA              | `sla_policy.created`, `sla_policy.updated` (`fields`, `active`, `isDefault`, minutos)                                                                                                               |
| Webhooks         | `webhook.created` (`eventTypes`), `webhook.updated`, `webhook.deactivated`, `webhook.secret_rotated`                                                                                                |
| Automatizaciones | `automation_rule.created`, `automation_rule.updated`, `automation_rule.deactivated`                                                                                                                 |

No existen hoy endpoints de actualización de organización, alta/baja directa de membresía ni
gestión de equipos: no hay nada que auditar ahí (el alta de membresía ocurre al aceptar una
invitación y queda en `invitation.accepted`).

**Metadata**: solo ids/flags/listas cortas. Claves con nombre de credencial se descartan; los
strings se redactan (W-E/W-F) y se truncan; objetos anidados rechazados. Nunca: token de
invitación, email del invitado, contraseña, secreto de webhook, URL destino, cookies, cuerpos.

### API y RBAC

`GET /api/audit-events?organizationId=…` — permiso nuevo **`audit:view`** (solo
`organization_admin`, plantilla y roles de sistema existentes; técnicos y clientes no).
Filtros: `actorUserId`, `action`, `entityType`, `entityId`, `from`/`to` (ISO-8601, `from ≤
createdAt < to`), `limit` 1..100 (50), `cursor` opaco. Respuesta `{ items, nextCursor }`, más
reciente primero. Sin POST/PATCH/DELETE.

## 2. X-B — Health / readiness

| Endpoint            | Contenido                                                                     | Código    |
| ------------------- | ----------------------------------------------------------------------------- | --------- |
| `GET/HEAD /healthz` | proceso vivo; sin BD, sin red, sin configuración                              | 200       |
| `GET/HEAD /readyz`  | configuración válida (`validateServerEnvironment`) + `SELECT 1` (timeout 2 s) | 200 / 503 |

Respuesta: `{ status: 'ok'|'unavailable', service, version (build id de SvelteKit), checks:
{ config|database|process: 'ok'|'fail'|'unconfigured' }, timestamp }`. Públicos y mínimos: sin
URLs, hosts, mensajes de error ni stacks; el detalle va al log (`health.readiness_failed`,
throttled, redactado). `Cache-Control: no-store`, cabeceras W-C y `X-Request-ID`. Fuera de
`/api`: no los limita W-D (las sondas no se autobloquean). Las sondas correctas no generan línea
de acceso; los fallos sí.

**Métricas**: no se añade base de métricas (sería artificial sin backend elegido): los eventos
estructurados de W-E (`*.batch_completed`, `*.delivery_exhausted`, `automation.execution_*`,
`security.*`, `http.request` con `durationMs`) son la fuente para un futuro exportador (X-B.4
diferido a la elección de Prometheus/OTel).

## 3. X-C — Contratos API

Auditoría de las respuestas actuales; **sin cambios incompatibles**. Contratos vigentes:

1. **Error**: `{ error: { code, message } }` en todos los endpoints propios (400/401/403/404/
   409/413/415/422/429/500/503), códigos `UPPER_SNAKE`, sin stack/SQL. Excepción documentada:
   `/api/auth/*` (Better Auth) conserva su formato nativo en errores de login.
2. **Página por cursor**: `{ items, nextCursor }` (`nextCursor: string | null`), orden
   descendente, `limit ≤ 100` — comentarios, notas internas, historial, notificaciones,
   automatizaciones y ejecuciones, auditoría. Excepción documentada:
   `GET /api/webhooks/[id]/deliveries` usa `{ deliveries, nextCursor }` (contrato publicado en
   `docs/webhooks.md`; renombrarlo rompería consumidores externos → candidato a v2).
3. **Colección acotada**: `{ <plural>: [...] }` (incidents, memberships, invitations, roles,
   sites, categories, slaPolicies, webhooks, teams, permissions, preferences), máx. 500 filas →
   `422 RESULT_LIMIT_EXCEEDED` (W-D). Migración a cursor: X-D.3.
4. **Recurso**: `{ <singular>: {...} }`; creación de webhook `{ webhook, secret }` (secreto solo
   ahí).
5. **Timestamps**: ISO-8601 UTC (`Z`); las páginas por cursor usan microsegundos.
6. **DTO de solicitante** (W-B): allowlist con `audience: 'requester'`.

No se introduce `pagination.total` (COUNT caro sin consumidor). Cobertura:
`tests/api-contracts.test.mjs` fija las claves exactas de los DTO clave y el sobre de error.

## 4. X-C — Outbox de invitaciones (opción 1: token cifrado de un solo uso)

Decisión aprobada: token cifrado con clave independiente `INVITATION_TOKEN_ENCRYPTION_KEY`.

### Esquema (`invitation_deliveries`, migración 0027)

| Columna                                                                                                                                | Notas                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `id` uuid PK (generado en la aplicación: forma parte del AAD)                                                                          |                                                                                              |
| `organization_id`, `invitation_id`                                                                                                     | FK compuesta → `invitations(id, organization_id)` (UNIQUE añadido en 0027) ON DELETE CASCADE |
| `status`                                                                                                                               | `pending` \| `processing` \| `retry` \| `sent` \| `failed` \| `cancelled`                    |
| `attempt_count`, `next_attempt_at`, `lease_token`, `last_attempt_at`, `sent_at`, `failed_at`, `last_error_code`, `provider_message_id` | mismo modelo que `notification_deliveries`                                                   |
| `token_ciphertext`, `token_iv`, `token_auth_tag`                                                                                       | AES-256-GCM; **solo** en estados activos                                                     |

Invariantes en BD: `invitation_deliveries_token_state_check` (activo ⇔ material presente y
`next_attempt_at`; terminal ⇔ material, lease y fecha nulos), `lease_check` (processing ⇔
lease), **una entrega activa por invitación** (índice único parcial), índice de cola
`(status, next_attempt_at)`.

### Confidencialidad

- Clave: 32 bytes exactos (hex/base64), sin fallback, validada en arranque, **distinta** de
  `WEBHOOK_SECRET_ENCRYPTION_KEY` (rechazo si coinciden), obligatoria en producción con auth.
- IV aleatorio de 12 bytes por cifrado; tag de 16 bytes; AAD
  `soporteflow-invitation-token:v1:<invitationId>:<deliveryId>`.
- El token en claro solo existe en memoria: al emitir (misma transacción que el hash y la fila del
  outbox) y en el worker justo antes de llamar al proveedor. Nunca en logs, DTO ni errores.
- Neutralización: `sent`, `failed` (permanente o `MAX_ATTEMPTS`, incluido el cierre de un lease
  caducado en el último intento) y `cancelled` (reenvío `SUPERSEDED`, `INVITATION_REVOKED`,
  `INVITATION_ACCEPTED`, `INVITATION_EXPIRED`, `ORGANIZATION_INACTIVE`, `TOKEN_MISMATCH`) ponen el
  material a NULL; la BD rechaza cualquier estado terminal que lo conserve.

### Semántica

- **Creación**: invitación + `token_hash` + delivery cifrada en **una** transacción (dentro de
  `withActorAuthorization` y con el evento de auditoría). Sin clave: 503
  `INVITATION_DELIVERY_NOT_CONFIGURED` y nada escrito. La petición ya no envía emails: responde
  201 con `delivery: { status: 'pending', lastErrorCode: null, attemptCount: 0 }`.
- **Reintentos** de una misma entrega: mismo ciphertext → **mismo enlace**; backoff 1/5/30/120 min,
  5 intentos; timeout de proveedor 15 s.
- **Reenvío explícito**: token nuevo, `token_hash` actualizado (el anterior deja de valer), la
  entrega activa se cancela (`SUPERSEDED`) y se crea otra con el nuevo token — todo atómico.
- **Revocación / aceptación**: cancelan y neutralizan las entregas activas en su propia
  transacción. El worker vuelve a comprobar estado, expiración, organización y que el token
  descifrado coincida con el hash actual antes de enviar.
- **Proveedor ausente**: `PROVIDER_NOT_CONFIGURED` es terminal (nunca éxito simulado); la
  invitación sigue `pending` y se puede reenviar.
- **Visibilidad**: el DTO administrativo de invitación incluye `delivery` (estado, último código,
  intentos) — campo aditivo; el cliente (allowlist estricta) lo ignora.
- **At-least-once**: si el proceso cae tras aceptar el proveedor y antes de marcar `sent`, el mismo
  enlace se reenvía tras expirar el lease (5 min).

### Worker (`processDueInvitationDeliveries`)

Mismo patrón que notificaciones/webhooks: claim en transacción corta con `FOR UPDATE SKIP LOCKED`
y lease; renovación del lease antes del envío (H2); resultado protegido por el lease;
aislamiento por elemento (`errors`); logs `invitation_email.*` con ids y códigos (nunca token,
ciphertext ni destinatario); `jobId` de W-E.

Primitivas compartidas (`services/delivery-primitives.ts`): `nextRetryAt`, `withTimeout`,
`DEFAULT_RETRY_DELAYS_MS` — pequeñas y puras. Los outboxes de notificación y webhook conservan
su código validado en CT 105 (sin churn); cada outbox mantiene su SQL de claim/estado propio
porque sus estados terminales difieren.

## 5. X-D — Rendimiento, retención y cuotas

### Índices (migración 0028, solo `CREATE INDEX`)

| Índice                               | Consulta real que lo usa                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `incidents_org_assignee_created_idx` | alcance `view_own` y `queue=mine` (`assigned_to_user_id = actor`), orden `created_at DESC`                                |
| `incidents_org_client_created_idx`   | alcance `view_requested` (`client_user_id = actor`), orden `created_at DESC`                                              |
| `memberships_user_idx`               | organizaciones del usuario (user-context, `/api/me`); el UNIQUE `(organization_id, user_id)` no sirve para `user_id` solo |

Revisados sin cambios (ya cubiertos): notificaciones (`recipient_*`), entregas (`*_due_idx`,
`*_terminal_idx`), webhooks, automatizaciones, auditoría (0026), invitaciones y outbox (0027).
Evidencia en PGlite: presencia y columnas; los planes reales (EXPLAIN con volumen) requieren
PostgreSQL real. En tablas grandes de producción, crear estos índices con `CREATE INDEX
CONCURRENTLY` antes del despliegue (el migrador de Drizzle los crea dentro de su transacción).

### Paginación

`GET /api/incidents` acepta `limit` (1..100) y `cursor` opacos (keyset `(created_at,
incident_number)`): respuesta `{ incidents, nextCursor }`, mismo alcance, filtros, orden y DTO
(staff/solicitante). Sin `limit`/`cursor` el contrato legado `{ incidents }` (≤ 500, 422) no
cambia. Las demás colecciones acotadas son catálogos administrativos pequeños (sedes,
categorías, roles, políticas, webhooks, invitaciones): se mantienen con 422 hasta que haya
evidencia de crecimiento.

### Retención (`services/retention.ts`, job `runRetention`)

- Opt-in por tabla: `RETENTION_NOTIFICATION_DELIVERIES_DAYS`, `RETENTION_WEBHOOK_DELIVERIES_DAYS`,
  `RETENTION_INVITATION_DELIVERIES_DAYS`, `RETENTION_AUTOMATION_EXECUTIONS_DAYS` (1..3650,
  validadas en arranque). Sin valor ⇒ no se purga.
- Solo filas **terminales** más antiguas que el corte; nunca en vuelo.
- Lotes cortos (`batchSize`, `FOR UPDATE SKIP LOCKED`), presupuesto `maxBatches` por tabla
  (`truncated` si queda trabajo), idempotente, log `retention.purged`.
- `audit_events` **nunca** se purga (requiere política explícita).
- Sin planificador: el operador invoca el job.

### Cuotas técnicas (`services/quotas.ts`)

| Límite                           | Techo técnico           | Variable (solo puede bajar)         |
| -------------------------------- | ----------------------- | ----------------------------------- |
| Webhooks activos por org         | 100                     | `QUOTA_MAX_ACTIVE_WEBHOOKS`         |
| Reglas de automatización activas | 100 (precedente 5.4V-C) | `QUOTA_MAX_ACTIVE_AUTOMATION_RULES` |

409 `WEBHOOK_LIMIT_REACHED` / `RULE_LIMIT_REACHED` al crear o reactivar. Son límites de abuso y
coste (fan-out por evento), no comerciales; sedes/categorías/equipos no se limitan (sin
evidencia de coste). Bajo creaciones simultáneas el recuento es blando (puede excederse por el
número de peticiones concurrentes).

## 6. X-E — Arquitectura

**No necesaria ahora** (evaluada):

- **Module gating**: `modules` / `organization_modules` existen sin datos ni consumidores. Activar
  gating exige decidir catálogo de módulos, valores por defecto para tenants existentes y qué es
  "core" → decisión de producto (regla de parada). Propuesta cuando se decida:
  `isModuleEnabled(orgId, module)` / `requireModule` en el pre-check de rutas, con Support/Core
  siempre habilitado.
- **`incidents.ts` (≈2 460 líneas)**: grande pero cohesivo y protegido por las suites W-A/W-B
  validadas en PostgreSQL real; dividirlo ahora no mejora seguridad ni comportamiento. Único
  cambio: extracción de `incidentListConditions` compartida por lista y página (X-D).
- **Primitivas de worker**: extracción mínima hecha en X-C (§4).

## 7. Pendiente / diferido

- Validación en PostgreSQL real (CT 105) del outbox de invitaciones: `tests/concurrency/70-invitation-outbox.test.mjs`.
- EXPLAIN con volumen real de los índices de 0028.
- Política de retención del audit trail; module gating; paginación de catálogos si crecen;
  cuotas comerciales; proveedor de email real.

# Fase C — autorización interna por organización

El módulo src/lib/server/auth/authorization.ts no monta endpoints ni hooks y no activa login. Importarlo no inicia Better Auth ni PostgreSQL. La fase B, la demo, sus permisos y el esquema permanecen intactos.

## Contrato de servidor

- verifyOrganizationMembership(headers, organizationId): devuelve userId, organizationId y membershipId o null. Confirma pertenencia habilitada, no un permiso de negocio.
- resolveOrganizationPermissions(headers, organizationId): devuelve concesiones explícitas por rol, permiso y ámbito o una lista vacía. Es información, no una credencial ni una decisión reutilizable.
- authorizeAction(headers, { organizationId, permissionId, resource? }): devuelve boolean. Revalida la identidad mediante resolvePrincipal; no acepta un principal, userId ni rol suministrado por el consumidor. El servidor debe fijar permissionId según la operación real; no delegar su elección en un formulario. organizationId y resource.id son selecciones no confiables que se verifican en PostgreSQL.

Cada entrada resuelve de nuevo la identidad de la fase B. La consulta de pertenencia vuelve a exigir users.active y memberships.active, y organizations.status = active. Política conservadora explícita: trial y suspended están denegados; permitir operaciones en trial requerirá una política aprobada posterior, sin inventar estados o columnas.

Los permisos proceden de role_assignments → roles activos → role_permissions → permissions. Se filtran en SQL por organización y pertenencia, y se respeta permissions.allowed_scope_types. Varios roles pueden contribuir concesiones; pertenecer a varias empresas no transfiere sus permisos. Las plantillas no son roles asignados ni conceden permisos en tiempo de ejecución.

## Ámbitos realmente soportados

- organization: acción sobre la organización validada o sobre un recurso Core de esa organización.
- department, team, site: acción únicamente sobre el propio registro activo cuyo UUID coincide con la asignación. La consulta incluye organización, UUID y active antes de devolver resultados. Esto no implementa gestión de sedes ni implica una relación con incidencias.
- personal: denegado. No hay una relación genérica de propiedad o asignación de recursos en el esquema actual.

Los recursos admitidos son referencias { kind: department | team | site, id }. No se aceptan objetos de negocio precargados como prueba de pertenencia ni nombres arbitrarios de tabla. Las incidencias siguen siendo demo/localStorage y no se autorizan por inferencia. Tampoco se infieren permisos por team_memberships, is_lead, visibilidad de equipo, propiedad o técnico asignado.

Los nombres de rol (incluido platform_admin) no tienen comportamiento especial. El espacio de permisos platform: se deniega en este módulo organizativo aunque figure en el catálogo; administración global queda fuera de alcance.

## Denegación y límites

Ausencia de sesión, usuario inactivo, pertenencia ausente/inactiva, estado no habilitado, permiso inexistente/retirado, rol inactivo, ámbito incompatible, recurso ajeno/inexistente/inactivo y errores de base de datos deniegan. No se registran errores con parámetros, tokens o credenciales. Los resultados denegados no distinguen recursos inexistentes de recursos de otra organización. No se emplea caché de autorización ni fallback a la demo.

Las consultas de autorización y la futura operación de negocio no son una única transacción. Una revocación posterior a la comprobación puede competir con dicha operación. El código de negocio deberá incorporar los filtros de organización y el protocolo de revalidación/transacción adecuado; un booleano anterior no elimina esa carrera. Este módulo no configura RLS ni acredita protección HTTP.

## Validación

npm run test:auth-authorization ejecuta pruebas con dependencias aisladas y PGlite en memoria, aplicando las migraciones existentes únicamente allí. Las pruebas inspeccionan también SQL y parámetros para comprobar filtros previos al resultado. La sesión real se valida en las pruebas de fase B; aquí se sustituye únicamente su resultado para aislar la política organizativa. No se accede a soporteflow_dev.

Antes de la fase D: definir el aprovisionamiento autorizado de pertenencias, roles y concesiones; asignar permisos de forma explícita y transaccional; decidir la política de trial y la semántica personal/asignación cuando existan recursos persistidos. No crear administradores globales implícitos, ni activar autenticación o endpoints como efecto de este módulo.

## Revalidación transaccional (5.4W-A, H1)

PostgreSQL real demostró un TOCTOU: las rutas administrativas autorizaban (sesión, membresía,
permisos y la instantánea `actorPermissions` para delegación) **antes** de la transacción del
servicio; una degradación confirmada mientras la petición esperaba el lock de la organización no se
veía y la mutación se aplicaba con autoridad caducada.

Regla desde 5.4W-A: toda mutación administrativa se ejecuta dentro de
`withActorAuthorization(db, { userId, organizationId, permissionIds, lock }, run)`:

1. bloquea primero la fila de la organización (`update` si el servicio la bloquea FOR UPDATE:
   roles, membresías, invitaciones, políticas SLA, reglas de automatización; `share` en el resto:
   categorías, sedes, webhooks). El modo coincide con el del servicio para no escalar locks dentro
   de la misma transacción;
2. revalida al actor en esa transacción con `authorizeActionInTransaction` (mismas reglas que
   `authorizeAction`: usuario, membresía y organización activos; grants de roles activos del
   tenant; ámbito organización; ids canónicos; lecturas FOR SHARE);
3. ejecuta la mutación en la misma transacción con las capacidades **actuales** del actor (las que
   usa la delegación monótona); falla cerrado con 403 `FORBIDDEN` sin escribir nada.

La comprobación previa de la ruta (401/403 rápidos) se mantiene, pero ya no es la decisión
autoritativa. Orden de locks: organización → filas del actor (FOR SHARE) → filas del recurso; es el
mismo orden que ya seguían los servicios, por lo que no introduce ciclos. Las mutaciones operativas
de incidencias se cerraron en 5.4W-B (sección siguiente).

## Incidencias: acceso, proyección y códigos HTTP (5.4W-B)

### Modelo de acceso

`resolveIncidentAccess` deriva el alcance de lectura de las capacidades efectivas
(`resolveEffectivePermissions`, recalculadas en cada petición, sin caché):

- `incidents:view_all` → todo el tenant (domina);
- `incidents:view_own` → incidencias con `assigned_to_user_id` = principal;
- `incidents:view_requested` → incidencias con `client_user_id` = principal;
- view_own + view_requested → OR de ambas ramas; ninguna → `null` (403). Fail-closed.

El alcance de **mutación** (`incidentMutationAccessFrom`) elimina la rama de solicitante: un
Customer ve su incidencia pero nunca la muta. `incidents:view_internal_notes` /
`add_internal_note` **no amplían** el alcance: exigen además view_all o view_own sobre una
incidencia asignada (B-1). `add_comment` exige también alcance de lectura.

### Revalidación transaccional de mutaciones

Toda mutación de incidencia (PATCH detalle, assign, site, category, support-level, sla,
comentario público, nota interna y creación) se ejecuta en
`withIncidentActor(db, { userId, organizationId, permissionIds }, run(tx, scope))`:
organización FOR SHARE → revalidación del actor (capacidad requerida) → alcance recalculado en la
transacción → incidencia FOR UPDATE (`lockIncidentForMutation`, que evalúa el alcance sobre la
fila bloqueada y confirmada). Una revocación, desactivación o reasignación confirmada mientras la
petición esperaba se observa y la mutación falla cerrada sin escribir. Guard estático en
`tests/security-bola-tenant.test.mjs`.

### Política 401 / 403 / 404

| Situación                                                                    | Código                   |
| ---------------------------------------------------------------------------- | ------------------------ |
| Sin sesión / sesión inválida / usuario inactivo                              | 401 `UNAUTHORIZED`       |
| Organización sin membresía activa, suspendida o no operativa                 | 403 `FORBIDDEN`          |
| Falta la capacidad de la operación (comprobación previa, igual para todo id) | 403 `FORBIDDEN`          |
| Incidencia visible pero no mutable por el actor (p. ej. Customer)            | 403 `FORBIDDEN`          |
| Autoridad perdida dentro de la transacción (`ACTOR_NOT_AUTHORIZED`)          | 403 `FORBIDDEN`          |
| Incidencia inexistente, de otro tenant o **fuera del alcance de lectura**    | 404 `INCIDENT_NOT_FOUND` |

La respuesta 404 es byte-idéntica a la de un id inexistente (sin oráculo de existencia) en
detalle, comentarios, historial, notas internas y mutaciones.

### Proyección de incidencias (DTO)

`toIncidentDto(incident, incidentAudience(access, incident))` es la única proyección HTTP:

- **staff** (view_all o asignada al principal): DTO operativo sin cambios;
- **requester** (solo visible por view_requested; también la respuesta de creación de quien no
  tiene alcance de personal): allowlist explícita con `audience: 'requester'` — id,
  organizationId, incidentNumber, title, description, status, priority, clientUserId, siteId,
  categoryId, slaOverallStatus, slaFirstResponseStatus, slaResolutionStatus, createdAt,
  updatedAt. Nunca: asignado/equipo, supportLevel, política/minutos/plazos/marcas SLA,
  createdByUserId, etiqueta `client`.

El historial del solicitante se filtra en SQL a tipos seguros (sin asignación, equipo, nivel ni
configuración SLA; los resultados SLA met/breached sí, decisión de producto 5.4T-C). Un
solicitante no puede filtrar el listado por `teamId` ni `supportLevel` (403: evita el oráculo).
El cliente (`src/lib/api/incidents.ts`) valida la proyección con una allowlist estricta.

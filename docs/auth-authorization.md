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

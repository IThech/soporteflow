# Fase D — aprovisionamiento interno

No hay endpoints, bootstrap de administrador, invitaciones ni activación de login. Las organizaciones admitidas siguen siendo exclusivamente `active`. La demo no participa en identidad, permisos ni persistencia real.

## Permisos nuevos, no sembrados

El repositorio no contiene una política sembrada de aprovisionamiento real. Este módulo define claves nuevas para el catálogo existente: `identities:create`, `memberships:create` y `roles:assign`, todas con ámbito `organization`. No son permisos de demostración ni se conceden por nombres de roles. Solo las pruebas insertan estos registros sintéticos. Su inserción y asignación reales requieren un procedimiento operativo posterior autorizado, incluido el primer administrador. Sin concesiones explícitas las operaciones deniegan.

## Operaciones

- `provisionIdentity(headers, organizationId, { name, email, password })`: exige `identities:create`. Crea conjuntamente identidad, correo principal sin verificar, perfil con el mismo UUID y una única cuenta credential. No crea pertenencias, sesiones ni permisos. Normaliza únicamente el correo nuevo; no modifica correos existentes. Un correo duplicado devuelve CONFLICT sin revelar la identidad existente.
- La creación de credencial es un paso privado dentro de esa alta, no una operación para adoptar perfiles existentes. Usa `hashPassword` público de Better Auth 1.7.5. Las pruebas comprueban compatibilidad con `verifyPassword`. Longitud admitida: 12–128 caracteres. Ningún hash ni contraseña se devuelve.
- `provisionMembership(headers, organizationId, userId, roleIds?)`: exige `memberships:create`, UUID de identidad activa y organización activa. No busca usuarios por correo, no cambia credenciales ni reactiva pertenencias. Si se solicitan roles, su asignación forma parte de la misma transacción y requiere autorización adicional.
- `assignMembershipRoles(headers, organizationId, membershipId, roleIds)`: exige `roles:assign` y pertenencia activa de la organización. Cada rol debe estar activo y pertenecer a ella. Todos sus permisos deben estar poseídos por el autorizante con ámbito organization. Se rechazan permisos platform:, roles vacíos, permisos sin ámbito organization, roles duplicados y más de 50 roles por operación. Esta fase solo crea asignaciones organization: no amplía concesiones de ámbito team/site/department, ni implementa personal.

No se implementan cambio de contraseña de identidades existentes, modificaciones o revocaciones de pertenencias, ni edición del catálogo. Conocer un correo nunca vincula una identidad existente. La identificación del destinatario por UUID y su aprobación administrativa corresponden al futuro flujo operativo; estas funciones no ofrecen búsqueda global por correo.

## Una sola transacción

La factoría transaccional recibe el objeto Drizzle `tx` y no usa ni reemplaza el singleton. El adaptador instalado utiliza ese objeto para sus consultas. `getSession` sigue siendo la única operación interna permitida y requiere disableCookieCache y disableRefresh. La resolución transaccional verifica cookie mediante Better Auth, sesión persistida, expiración y usuario activo. Las consultas de autorización y las inserciones utilizan ese mismo tx. Antes de terminar se revalida otra vez la sesión; no se promete vigencia indefinida después del commit.

Se usan bloqueos FOR SHARE en sesión, usuario, organización, pertenencia y filas de concesiones leídas. Impiden que esas filas se actualicen o eliminen antes de finalizar la transacción. El rol destinatario se bloquea FOR UPDATE: también coordina nuevas inserciones de permisos que referencian ese rol por FK. No se usa un bloqueo consultivo que otros escritores puedan ignorar. Los roles solicitados se recorren en orden UUID; esto no elimina todos los posibles interbloqueos. No hay reintentos automáticos: timeout, deadlock o fallo abortan la operación con error saneado.

Todas las inserciones del alta usan una única transacción exterior. No se confía en transaction:true para combinar llamadas independientes. La limpieza de sesiones caducadas que Better Auth puede efectuar durante getSession también está dentro del tx; la denegación del aprovisionamiento provoca rollback.

Restricciones UNIQUE existentes arbitran duplicados de correo, credencial, pertenencia y asignación. Las FKs conservan identidad y pertenencia organizativa. Estas restricciones por sí solas no impiden un usuario sin perfil: es la transacción del alta la que evita estados parciales.

## Resultados y límites

Éxito contiene solo userId o membershipId. Errores: INVALID_INPUT, DENIED, CONFLICT o FAILED. No se propagan mensajes del driver, SQL, parámetros ni secretos. Un FAILED durante confirmación puede tener resultado desconocido por desconexión; antes de reintentar debe reconciliarse el estado mediante un procedimiento autorizado. No se afirma entrega exactamente una vez.

La prueba previa sin modificar archivos verificó getSession sobre el objeto transaccional instrumentado, lectura de identidad/sesión sin confirmar y rollback exterior. Las pruebas permanentes usan PGlite, módulos reales de A/B/C y un cliente general que lanza error si se utiliza. Prueban bloqueos emitidos, lectura del estado transaccional, denegación, rollback y duplicados. Las solicitudes solapadas se serializan en PGlite: NO demuestran contención entre conexiones PostgreSQL independientes.

Pendiente antes de habilitar login: pruebas PostgreSQL independientes de revocación, desactivación, cambio de permisos, interbloqueos, expiración durante esperas y desconexión durante commit; procedimiento de primer administrador; carga aprobada de permisos; entrega y verificación de credenciales; política operativa de identificación del destinatario. No se ha accedido a soporteflow_dev ni cambiado el esquema. Recuperación, registro y autenticación HTTP siguen desactivados.

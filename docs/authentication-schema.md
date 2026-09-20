# Esquema de autenticación — migración 0001

Estado: esquema persistente preparado para Better Auth **1.7.5**. No implementa autenticación real ni habilita recuperación de contraseña, registro público o endpoints. No se ha aplicado a soporteflow_dev.

## Identidad y pertenencia

`users` continúa como identidad global y `memberships` como pertenencia propia a organizaciones. Un contacto puede existir sin acceso. `auth_users.id` es la misma UUID de `users.id`, sin generación automática; no crea identidades ni perfiles durante la migración.

Las cuatro tablas se exportan desde `schema/authentication.ts`. `schema/auth.ts` conserva los permisos y roles existentes. La futura configuración del adaptador debe mapear explícitamente `user: authUsers`, `account: authAccounts`, `session: authSessions` y `verification: authVerifications`. No se habilita el plugin de organizaciones de Better Auth.

## Tablas y restricciones

- `auth_users`: nombre, correo de acceso, indicador de verificación, imagen opcional y fechas. PK/FK a `users` con DELETE RESTRICT. El nombre es una copia de compatibilidad; el Core sigue siendo la fuente de identidad.
- `auth_accounts`: campos estándar de cuenta de Better Auth, incluyendo campos opcionales de OAuth, sin habilitar proveedores. FK al perfil con DELETE CASCADE. UNIQUE(provider_id, account_id). Si provider_id es credential, account_id debe ser user_id::text y password debe contener un hash no nulo ni vacío. La restricción no valida criptográficamente el contenido del hash.
- `auth_sessions`: token único, vencimiento, IP y agente opcionales; FK al perfil con DELETE CASCADE. Índices por usuario y vencimiento. Revocar significa eliminar la fila; no hay un revoked_at que Better Auth pueda ignorar.
- `auth_verifications`: identificador, valor genérico, vencimiento y fechas. Índices por identificador y vencimiento. El identificador no es UNIQUE y el valor no es FK: no siempre representa un usuario.

Las cuentas, sesiones y verificaciones generan su UUID con gen_random_uuid(). El perfil recibe el UUID explícito del Core. La futura integración usará advanced.database.generateId = 'uuid'. Todas las fechas usan timestamptz. DEFAULT now() no actualiza updated_at automáticamente: cada operación debe mantenerlo.

## Correo de acceso

Se añade UNIQUE(user_id, email) a user_emails para soportar la FK compuesta auth_users(id, email) → user_emails(user_id, email), con DELETE/UPDATE RESTRICT. Se conservan los índices existentes de correo global sin distinguir mayúsculas y de correo principal por usuario.

Solo auth_users.email exige un valor no vacío, en minúsculas y sin espacios exteriores ordinarios, mediante lower(btrim(email)). Esta restricción no sustituye la validación del formato de correo. No se normaliza ni cambia ningún correo preexistente. Un contacto existente con otra representación necesita un tratamiento explícito antes de habilitar acceso. El correo de acceso puede ser secundario.

La FK acredita pertenencia y coincidencia exacta. No sincroniza auth_users.email_verified con user_emails.verified_at: el futuro aprovisionamiento y los cambios de correo deben actualizar ambos de forma coordinada. Tampoco sincroniza los nombres.

## Eliminación, conservación y autorización

Eliminar el perfil elimina cuentas y sesiones, pero conserva identidad, contactos y memberships. Eliminar una identidad con perfil o su correo de acceso queda restringido. No se cambian las cascadas existentes del Core. La desactivación de users.active deberá comprobarse en servidor; estas tablas no implementan autorización multiempresa.

Las sesiones no son un historial de auditoría. El token se conserva según el modelo estándar de Better Auth; no se afirma almacenamiento mediante hash. Ningún token o hash debe devolverse como datos de negocio ni aparecer en registros. La integración necesitará cookies seguras y comprobaciones en servidor sin caché que mantenga sesiones revocadas.

La purga de sesiones/verificaciones expiradas y la limpieza de verificaciones asociadas a perfiles eliminados quedan pendientes de servicios específicos. No se introduce una retención histórica de secretos ni un plazo de conservación arbitrario. Auditoría, invitaciones, alta del primer administrador y selección de organización quedan fuera.

## Migración y validación

0000_regular_masque.sql y su snapshot permanecen intactos. 0001 solo añade las cuatro tablas, sus restricciones e índices y UNIQUE(user_id, email). Se ha reordenado el SQL generado para crear esta restricción antes de la FK que la necesita. No contiene DML, seeds, normalizaciones ni borrados de datos. La creación de la restricción puede adquirir bloqueos sobre user_emails; su futura aplicación real requiere planificación y no está autorizada por generar este archivo.

Ejecutar `npm run test:persistence`: aplica todas las migraciones en PGlite en memoria, comprueba relaciones, borrados, UUID, cuentas credential y conservación de datos previos; conserva además las pruebas de migraciones omitidas y aislamiento de variables de entorno. No se carga .env ni el cliente real de PostgreSQL.

### Instalación limpia y pruebas reproducibles

Better Auth está fijado exactamente a **1.7.5** como dependencia de ejecución. Se importa exclusivamente en módulos privados de servidor y pruebas; no habilita endpoints de autenticación. La integración usa importaciones locales obligatorias y comprueba la versión instalada: un paquete ausente o una versión incorrecta causa un fallo, nunca una omisión.

Desde una instalación limpia con Node 24 y npm 11, ejecutar:

```sh
npm ci
npm run test:persistence
npm run test:auth-compat
npm run test:auth
```

- `test:persistence`: 36 pruebas contabilizadas por Node, incluidas las contenedoras; no importa Better Auth ni depende de una instalación externa.
- `test:auth-compat`: una prueba de integración obligatoria con Better Auth 1.7.5.
- `test:auth`: ejecuta ambos grupos secuencialmente y se detiene si cualquiera falla (36 + 1).

La preparación compartida vive en tests/helpers/auth-fixture.mjs. Carga únicamente el esquema Drizzle y aplica migraciones en PGlite en memoria. No carga .env ni el cliente PostgreSQL. No necesita rutas locales del laboratorio ni variables de configuración externas.

La integración prueba aprovisionamiento de una credencial, rechazo del registro público y contraseña incorrecta, login, lectura de sesión, cambio autenticado de contraseña con la restricción credential, nuevo login y logout. Comprueba además el bloqueo de los endpoints HTTP de recuperación ensayados. No implementa rutas de producción.

### Entradas opcionales de Tailwind en el lockfile

npm ha completado seis entradas inBundle bajo @tailwindcss/oxide-wasm32-wasi@4.3.3. Ya figuraban en dependencies y bundleDependencies del paquete padre: @emnapi/core@1.11.1, @emnapi/runtime@1.11.1, @emnapi/wasi-threads@1.2.2, @napi-rs/wasm-runtime@1.1.4, @tybys/wasm-util@0.10.2 y tslib@2.8.1.

Se contrastaron las versiones con los manifiestos incluidos en el tarball del registro npm, cuyo SHA-512 coincide con la integridad fijada del paquete padre. Los paquetes incluidos no tienen integridad independiente en el lockfile: quedan cubiertos por la del archivo padre. No representan una actualización de Tailwind. Se conservan tal como los resuelve npm; no se eliminan manualmente para reducir el diff. La plataforma wasm32 no es necesaria para ejecutar las pruebas en Windows x64, pero el lockfile registra también ese árbol opcional.

La suite no repite la validación de concurrencia PostgreSQL del laboratorio ni acredita toda la seguridad de una integración futura. Esta deberá respetar el protocolo de bloqueo por identidad y mantener la recuperación deshabilitada. No se autoriza aplicar migraciones a una base real ni hacer commit o push.

## Fase A — configuración privada desactivada

Los módulos src/lib/server/auth/config.ts e instance.ts preparan Better Auth 1.7.5 con el cliente getDb existente y el mapeo explícito de las cuatro tablas. No hay hooks de SvelteKit, rutas HTTP ni formularios. La demo no importa estos módulos.

BETTER_AUTH_ENABLED está desactivado por defecto. Solo el valor exacto true permite construir una instancia al llamar a getAuth(); no habilita login: email/contraseña está desactivado y el middleware rechaza las operaciones salvo la consulta interna de sesión autorizada en la fase B descrita abajo. Registro, recuperación, cambio de correo y eliminación permanecen bloqueados. No retirar esta protección hasta una fase aprobada y validada.

Con la bandera activada se requieren DATABASE_URL de PostgreSQL, BETTER_AUTH_SECRET aleatorio de al menos 32 caracteres y BETTER_AUTH_URL con el origen HTTPS exacto. El secreto no tiene valor predeterminado; su longitud no demuestra entropía. Solo en desarrollo se admite HTTP en localhost, 127.0.0.1 o ::1. No se aceptan credenciales, rutas, query ni fragmentos en el origen. Ningún valor sensible se incluye en errores de configuración.

La importación no valida el entorno ni crea la instancia. Durante build, getAuth devuelve null incluso con la bandera activada. Fuera del build se valida antes de obtener el cliente; la instancia se conserva por proceso. Cambiar secretos u origen requiere reiniciar el proceso. No se usa memoria como alternativa a PostgreSQL.

Cookies HttpOnly y SameSite=Lax, Secure en HTTPS, origen permitido explícito, caché de sesión en cookie desactivada y comprobaciones CSRF/origen activas. Rate limiting habilitado; su almacenamiento distribuido, la política definitiva de duración de sesiones y los registros operativos saneados quedan pendientes antes de exponer endpoints. El logger de Better Auth está desactivado para no propagar errores de SQL o credenciales. No se configura un secreto sintético en ejecución.

Validar con npm run test:auth-config y npm run test:auth. Las pruebas de configuración aíslan el entorno y sustituyen el acceso PostgreSQL; la comprobación con Better Auth real utiliza exclusivamente PGlite en memoria. No se leen archivos .env en estas pruebas.

## Fase B — resolución interna de identidad

resolvePrincipal(headers), en src/lib/server/auth/principal.ts, acepta exclusivamente Headers de una petición de servidor. No acepta objetos demo, userId, roles ni organización como prueba de autenticación. Solo reenvía la cookie a Better Auth; esta librería verifica la firma y consulta la sesión persistida mediante getSession con disableCookieCache: true y disableRefresh: true. Después se comprueban identificadores UUID, coincidencia entre session.userId y user.id, expiración y existencia de users activo. La identidad resultante contiene únicamente userId, sin correo, nombre, token, sesión, organización ni permisos.

El middleware de instance.ts permite solamente /get-session sin Request HTTP y con ambas opciones booleanas exactas. La ruta también está en disabledPaths: incluso el handler de Better Auth rechaza la consulta HTTP. No se han añadido rutas ni hooks de SvelteKit. Login, registro, recuperación y todas las demás operaciones siguen bloqueadas; la bandera permanece desactivada por defecto.

App.Locals.principal es opcional: undefined significa que no se ha resuelto; null significa denegación. Ningún código lo rellena automáticamente. Ante configuración desactivada, sesión inválida, usuario ausente/inactivo o cualquier error de configuración, autenticación o base de datos, el resolver devuelve null sin registrar ni devolver detalles sensibles y sin recurrir a la demo. No hay caché de identidades.

Las pruebas auth-principal utilizan dobles para errores y casos imposibles por las FK y Better Auth 1.7.5 real sobre PGlite con las migraciones existentes y cookies firmadas sintéticas. Comprueban lectura válida sin renovación, firmas inválidas, revocación, inactividad, bloqueo HTTP y rechazo de las otras operaciones de la instancia. No usan PostgreSQL real ni credenciales reales. Comando: npm run test:auth-principal.

Límites: disableRefresh evita renovar una sesión; Better Auth puede limpiar una sesión ya caducada y emitir instrucciones para borrar cookies inválidas. La validación refleja el estado consultado, no bloquea una revocación o desactivación concurrente posterior. Antes de una operación de negocio, la fase C deberá validar autorización y pertenencia en el contexto de esa operación. No se afirma autenticación HTTP funcional ni aislamiento multiempresa por disponer de una identidad.

# UI-2D-C — Adjuntos de incidencia V1

Los archivos no son públicos: listado y descarga requieren sesión, organización activa,
pertenencia y acceso actual a la incidencia (`view_all`, `view_own` o `view_requested`).
El solicitante recibe el mismo listado permitido, sin datos internos del staff. No hay adjuntos
internos, borrado, previews ni URLs públicas. Los archivos se descargan, nunca se renderizan inline.

## API y permisos

- `GET /api/incidents/[id]/attachments?organizationId=<uuid>` → `{ items }`.
- `POST` en esa misma ruta: multipart con exactamente un campo `file` → 201 `{ item }`.
- `GET /api/incidents/[id]/attachments/[attachmentId]/download?organizationId=<uuid>`:
  bytes con `Content-Disposition: attachment`, `nosniff` y `private, no-store`.

Subir exige además `incidents:add_comment`, sin modificar los comentarios existentes ni conceder
permisos. Una incidencia cerrada no admite nuevas subidas (409). No hay endpoint DELETE.
La autorización se revalida con `withIncidentActor` dentro de la transacción. Las consultas
aplican tenant y alcance en SQL antes de obtener la incidencia. IDs ajenos/inaccesibles se ocultan
con 404, o 403 cuando no existe autoridad sobre la organización.

## Límites y validación

Máximo 5 archivos, 5 MiB (5 × 1024 × 1024 bytes) por archivo. PDF, JPEG/JPG, PNG y WebP.
El navegador valida nombre/extensión/MIME declarado/tamaño como ayuda. El servidor repite esa
validación y verifica firmas y estructura básica del contenido, incluyendo el final/framing.
No es un decodificador completo ni antivirus: aceptar el formato no garantiza contenido inocuo.
No se admite HTML/SVG ni renderizado inline. Nombres con controles, separadores o `..` se rechazan.
El nombre original nunca se usa como ruta; la clave física es un UUID generado en servidor.

La excepción multipart se limita al POST de la ruta SvelteKit exacta de adjuntos. Conserva Origin,
CSRF, rechazo de Content-Encoding y rate limiting existente. El stream completo se limita a
5 MiB + 16 KiB de overhead; las demás mutaciones conservan JSON y 64 KiB. Los proxies y el adapter
pueden necesitar límites operativos superiores al body de subida; no se han cambiado ni desplegado.
El control de floods/slow uploads en el perímetro sigue siendo necesario.

## Persistencia y concurrencia

`0030_incident_attachments` añade solo la tabla, sus constraints e índices. Tiene FK compuestas
a incidencia/organización y actor/pertenencia. Las migraciones anteriores permanecen intactas.
Drizzle no tenía snapshot 0029: al generar 0030 repetía cambios de clientes ya presentes en 0029.
Se retiraron exclusivamente esas operaciones del SQL nuevo; el snapshot 0030 refleja el esquema
acumulado de ambas migraciones. Las pruebas aplican toda la secuencia.

Cada subida bloquea la incidencia con `FOR UPDATE`, cuenta los adjuntos y escribe bajo el mismo
bloqueo. En PostgreSQL READ COMMITTED, las subidas por este servicio quedan serializadas y la sexta
se rechaza. Aislamientos superiores pueden abortar por serialización: no hay auto-retry.
Esta regla requiere que todos los escritores usen el servicio; no es un CHECK SQL entre filas.
PGlite valida restricciones/rollback/límites; no demuestra interleavings con conexiones PostgreSQL
independientes. No se ha conectado a PostgreSQL real.

## Storage DEV y recuperación

`AttachmentStorage` separa put/read/limpieza de una subida fallida. `ATTACHMENT_DEV_ROOT` debe ser
una ruta absoluta privada fuera del repositorio y de cualquier raíz servida por HTTP. En entorno
DEV (`DEPLOYMENT_ENV=dev`), se permite el storage local privado incluso con `NODE_ENV=production`.
En producción (`DEPLOYMENT_ENV=production`), o sin ruta configurada, subida/descarga responden 503.
No hay fallback a static ni almacenamiento externo. No se inicializa storage ni PostgreSQL durante
imports/build.

El adaptador local usa archivos exclusivos, permisos restrictivos donde el SO los soporta,
rechaza symlinks y valida las claves. La carpeta debe ser controlada exclusivamente por el proceso
del servidor; en Windows deben configurarse ACL equivalentes antes de uso compartido.

Filesystem y PostgreSQL NO son una única transacción: se escribe el archivo antes del commit.
Los fallos conocidos dentro del callback intentan limpiar la clave de esa subida. Si el callback
terminó y falla el commit, se conserva el archivo por posible outcome desconocido. Un crash o
fallo de limpieza puede dejar archivos sin metadata. Nunca se borra automáticamente una clave
potencialmente confirmada. Antes de producción hace falta backend persistente autorizado, backup
coordinado y procedimiento de reconciliación de huérfanos; esta V1 no ejecuta purgas.

## UI

Bloque independiente dentro del detalle, sin alterar historial, conversación, notas o acciones.
Lista nombres/tamaños y descarga autenticada. Selección de un archivo por subida, estado pending,
errores seguros, sin auto-retry. El máximo acumulado es cinco. No se muestra porcentaje ficticio.
Estado ligado a usuario + organización + generación + incidencia. Cambiar contexto borra selección
y datos; respuestas/401 obsoletos no se aplican. 403 conserva la sesión. Network/502/504 o 2xx
inválido al subir conserva la selección y exige comprobar el listado antes de repetir.

No se ha aplicado la migración, creado cuentas reales, configurado una carpeta DEV real ni desplegado.

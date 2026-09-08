# Soporte, asignación e historial

El rol controla permisos mediante la matriz existente. El nivel operativo
(N1/N2/N3) es independiente del equipo. Cada `SupportTeam` pertenece a una
organización. Técnicos y administradores de organización pueden tener perfil
operativo opcional; clientes y administradores de plataforma no lo tienen.

`Incident.assignedToUserId` es el responsable actual. `supportLevel` y `teamId`
son el destino operativo: una reasignación no modifica estos campos.
Los registros antiguos sin organización siguen vinculados provisionalmente a
Nodhouses mediante la regla de compatibilidad existente, sin migrarlos.

## Flujo implementado

`prepareAssignment` comprueba `incidents:assign`, acceso a la incidencia y un
candidato activo con rol `technician` en la organización de la incidencia.
Platform admin conserva exactamente el acceso definido en la matriz.
Asignar a un administrador de organización no está permitido como destino.

La primera asignación genera `assigned` (anterior `null`, nuevo identificador). Un técnico que asigna a otro técnico debe indicar motivo incluso en la asignación inicial. La autoasignación inicial y la asignación inicial por administrador no requieren motivo.
Cambiar responsable genera `reassigned` con ambos identificadores y motivo
obligatorio después de `trim()`. El mismo responsable no produce cambios ni evento.
La autoasignación sigue esas mismas reglas. El comentario es opcional.
El motivo «Escalado técnico» no cambia nivel/equipo ni genera `escalated`.

Cada evento utiliza `IncidentHistoryEntry`: id, incidencia, organización, actor,
fecha UTC con hora y milisegundos, valores anterior/nuevo y motivo/comentario.
Solo se generan `assigned` y `reassigned` en este bloque. Los otros tipos existentes
se validan y conservan, pero no se generan automáticamente. No se inventa historial
para los registros antiguos. Los eventos se añaden al final sin modificar anteriores.

## Persistencia y fallos

- `soporteflow-incidents`: conserva la lista y el responsable actual.
- `soporteflow-incident-history`: lista de eventos; ausencia equivale a lista vacía.
- `soporteflow-assignment-recovery`: copia temporal exacta de ambas claves antes
  de escribir. Se elimina únicamente después de guardar ambas listas.

Si falla una escritura, se restauran las dos claves. Si la restauración también
falla, la copia permanece para recuperarla al recargar, antes de habilitar edición.
La UI actualiza sus listas solo tras confirmar el guardado completo.
Los datos inválidos se conservan y bloquean edición; no se borran automáticamente.
Se comprueban las versiones leídas para rechazar cambios de otra pestaña.
LocalStorage no es una base de datos transaccional: no garantiza exclusión entre
escrituras simultáneas de varias pestañas ni seguridad frente a manipulación local.
Para esta demo se debe trabajar desde una pestaña y recargar ante un conflicto.

Las otras ediciones de incidencias comprueban también si hay recuperación pendiente
o versiones diferentes antes de guardar. Los identificadores nuevos tienen en cuenta
el historial para no reutilizar el id de una incidencia eliminada con eventos.

## Pendiente

Escalado real, historial de otras acciones, SLA, notificaciones y validación
en servidor. Usuarios y equipos siguen siendo datos demo estáticos. Al implementar
escalado habrá que validar el equipo de destino y guardar su instantánea anterior/nueva.

## Pruebas

Ejecutar `node --test tests/assignment.test.mjs` desde la raíz del proyecto.
Usa las funciones reales con almacenamiento simulado; no toca datos del navegador.
Incluye permisos, aislamiento, motivos, autoasignación, persistencia, claves ausentes,
conflictos, datos corruptos y fallos en cada fase del guardado y recuperación.

## Historial visual por incidencia

El componente IncidentTimeline aparece debajo del formulario de edición. Muestra los eventos existentes del más antiguo al más reciente, con fecha y hora local, actor, descripción, motivo y comentario. Filtra por incidencia, organización y acceso del usuario, y excluye clientes. Los nombres se resuelven dentro de la organización; los actores de plataforma son reconocidos como tales. Los usuarios ausentes se muestran como Usuario no disponible, sin identificadores internos. Se representan los ocho tipos existentes sin generar nuevos eventos ni duplicar almacenamiento.

## Cola personal del técnico

En `/app`, solo el técnico dispone de Todas / Mis incidencias / Sin asignar.
Las tres vistas filtran primero por el acceso existente a la organización y se
combinan con búsqueda normalizada y estado. Mis incidencias compara el responsable
con el usuario activo; Sin asignar acepta ausencia, null y cadena vacía.

Mis incidencias ordena abiertas y pendientes juntas antes de resueltas; dentro de
cada grupo, prioridad alta/media/baja y fecha de creación ascendente (ID como
último desempate). Las fechas no interpretables quedan al final de su prioridad.
Todas y Sin asignar conservan el orden de la lista original.
Los contadores de asignadas a mí y sin asignar ignoran búsqueda y estado, pero
siempre respetan organización y acceso. Se recalculan al asignar/reasignar.

Cambiar usuario demo reinicia la vista a Todas y limpia búsqueda y estado.
La vista no se guarda en localStorage: recargar conserva los datos de incidencias,
pero restablece la sesión demo y la vista inicial existentes.
La categoría se muestra en la fila, con nombre de la organización o un texto
seguro si falta. No cambia permisos, modelos de equipos ni reglas de asignación.

Pruebas: `node --test --test-concurrency=1 tests/queue.test.mjs tests/assignment.test.mjs`.

## Catálogo de motivos por organización

`ReassignmentReason` tiene id, organizationId, name, description opcional, active,
createdAt y updatedAt opcional. Es independiente de las categorías. Se guarda en
`soporteflow-reassignment-reasons`. Una clave ausente usa los motivos demo de
Nodhouses; una lista guardada vacía se respeta. No se escribe al cargar.

La administración reutiliza `organization:manage` y `canAccessOrganization`:
administradores de organización gestionan sus motivos y el administrador de
plataforma conserva su acceso existente. Técnicos y clientes no administran.
Se crea, edita y desactiva/reactiva, sin borrar. Los duplicados se comprueban en la
organización ignorando mayúsculas, acentos y espacios, incluyendo motivos inactivos.
«Otro» es una opción especial de texto libre, por lo que su nombre está reservado.

AssignmentDialog muestra solo los motivos activos de la organización de la
incidencia. Antes de asignar se vuelve a validar el catálogo y su versión guardada.
«Otro» exige texto después de trim y funciona sin motivos activos. Las reglas de
cuándo exigir motivo no cambian. El evento conserva el nombre efectivo como texto
en `reason`, nunca solo una referencia: renombrar/desactivar no modifica eventos.
La selección ya no depende de etiquetas técnicas fijas y no ejecuta escalados.

Un catálogo corrupto se conserva y bloquea su administración y las asignaciones
hasta resolver la carga; las demás funciones no se migran ni se reemplazan.
Si falla el guardado, la lista en memoria no se actualiza. Los conflictos detectados
con otra pestaña requieren recargar. Se mantienen las limitaciones de localStorage.

Pruebas del catálogo y regresión:
`node --test --test-concurrency=1 tests/reasons.test.mjs tests/queue.test.mjs tests/assignment.test.mjs`.

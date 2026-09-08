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

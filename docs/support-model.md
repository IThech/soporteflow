# Base de soporte e historial

El rol sigue controlando permisos mediante la matriz existente. El nivel operativo
(N1/N2/N3) es independiente del equipo. `SupportTeam` pertenece a una organización;
su nombre es configurable como dato, sin correspondencia fija entre nivel y área.
El perfil operativo es opcional para técnicos y administradores de organización.
Los clientes y administradores de plataforma no tienen perfil técnico.

`Incident.assignedToUserId` representa el responsable actual. `supportLevel` y
`teamId` representan el destino operativo de la incidencia: cambiar responsable
no implica cambiar nivel o equipo, y un escalado puede existir sin responsable.
Los tres campos son opcionales para mantener los registros antiguos.

`IncidentHistoryEntry` es una entrada independiente, enlazada a la incidencia y
organización. El actor es quien realiza la acción, no necesariamente el destinatario.
`eventType` determina los tipos de `previousValue` y `newValue`. En asignación y
reasignación son identificadores de usuario; en escalado son instantáneas de nivel,
equipo y responsable. `null` representa explícitamente un destino sin asignar;
un valor omitido indica información no registrada. No inferir actores ni destinos
históricos a partir de perfiles actuales.

Los eventos son: `created`, `assigned`, `reassigned`, `escalated`, `status_changed`,
`priority_changed`, `category_changed` y `resolved`. Las fechas de historial deben
ser ISO 8601 UTC con hora y milisegundos. Ordenar cronológicamente por timestamp,
con id como desempate estable. `reason` y `comment` son opcionales en esta fase.

## Contratos para el próximo bloque (aún no implementados)

- Comprobar permisos y organización de incidencia, actor, responsable y equipo.
- Comprobar que los destinos sean activos y que el responsable pueda actuar como técnico.
- Registrar responsable anterior y nuevo en reasignación; exigir motivo en esa acción.
- Registrar nivel/equipo anterior y nuevo en escalado, sin tratarlo como reasignación.
- Capturar valores antes de modificar la incidencia y conservar el historial sin editarlo.
- Al resolver, registrar un evento `resolved` con estado anterior, estado resuelto y
  solución; evitar duplicar la misma transición con `status_changed`.
- Coordinar persistencia de incidencia e historial para evitar cambios sin su evento.

Este bloque solo define modelos: no genera eventos, no escribe nuevas claves de
localStorage y no reconstruye historial ficticio para datos antiguos. El validador
actual admite los campos nuevos opcionales y rechaza niveles o equipos de tipo
incorrecto sin borrar el contenido guardado. No hay persistencia de usuarios ni de
equipos todavía; los equipos demo son datos estáticos. Los tipos no sustituyen la
validación en ejecución ni la futura autorización en servidor.

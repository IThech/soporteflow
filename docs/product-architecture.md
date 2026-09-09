# Arquitectura de producto de SoporteFlow

Documento conceptual. No activa módulos ni amplía el alcance funcional actual.

## Visión

**SoporteFlow = Core + módulos configurables por organización.**
La plataforma centraliza procesos operativos de una empresa, con identidad profesional B2B.
Cada organización podrá activar solo los módulos que necesite. La intención es mantener
límites claros y evitar un ERP monolítico o un producto limitado al ticketing.

## Core compartido

El Core contempla organizaciones y multi-tenancy, usuarios, roles y permisos,
equipos, configuración, actividad e historial/auditoría, y una futura infraestructura
común para módulos. Las entidades y operaciones deberán pertenecer explícitamente
a una organización. Activar un módulo no concederá automáticamente permisos a usuarios.

Hoy existen modelos de organización, roles, permisos, equipos e historial operativo,
con sesión demo y localStorage. La autenticación, el aislamiento en servidor y el
registro fiable de auditoría aún están pendientes. No debe confundirse este prototipo
con una plataforma multi-tenant preparada para producción.

## Módulos

| Módulo                    | Situación y responsabilidad conceptual                                           |
| ------------------------- | -------------------------------------------------------------------------------- |
| Incidencias               | Implementación demo actual: trabajo de soporte, asignación, escalado e historial |
| Solicitudes               | Futuro: recepción y clasificación de peticiones                                  |
| Agenda / Citas            | Futuro: compromisos y atención programada                                        |
| Tareas                    | Futuro: acciones operativas con responsable                                      |
| Clientes / Contactos      | Futuro: relaciones comunes; el texto cliente actual no equivale a este módulo    |
| Formularios configurables | Futuro: entrada estructurada según organización                                  |
| Inventario / Activos      | Futuro: activos, ubicación, responsables y mantenimiento                         |
| Documentos                | Futuro: documentación vinculada a procesos                                       |
| SLA                       | Futuro: compromisos y seguimiento de tiempos                                     |
| Informes                  | Futuro: análisis de los módulos habilitados                                      |
| Automatizaciones          | Futuro: reacción a eventos e integración con otros sistemas                      |

La configuración por organización y el registro de módulos son propuestas futuras.
No se implementan en esta pasada. Cada módulo deberá delimitar sus datos, permisos
y eventos, reutilizando el Core sin duplicar identidades o lógica de acceso.

## Relaciones conceptuales

- Formulario → Solicitud → Incidencia, Tarea o Cita, según el proceso configurado.
- Cliente/Contacto → Solicitudes, Incidencias y Citas.
- Activo → Responsable, Ubicación, Incidencias, Mantenimientos e Historial.
- Eventos de módulos → Automatizaciones → Email, WhatsApp, APIs, n8n o notificaciones.

Son relaciones posibles, no conversiones automáticas ya disponibles. Las futuras
integraciones deberán respetar organización, permisos, trazabilidad e idempotencia.
Desactivar un módulo no debería borrar su historial ni dejar referencias inválidas;
esa política deberá concretarse antes de implementar la configuración modular.

## Principios operativos y UX

**Rol ≠ Nivel ≠ Equipo ≠ Asignación.** El rol autoriza, el nivel expresa el nivel de
soporte, el equipo agrupa la operación y la asignación identifica al responsable.

- Panel = localizar, priorizar y coger trabajo.
- Detalle = gestionar/trabajar.
- Historial = trazabilidad.

Un técnico toma trabajo libre y gestiona reasignación/escalado únicamente cuando es
responsable. El administrador de organización coordina el trabajo accesible de su
organización. Reasignación cambia solo responsable; escalado cambia nivel y/o equipo
y puede incluir responsable, con un único evento.

Un escalado o una reasignación NO reiniciará el SLA original de la incidencia.
Esta regla es futura; no se incorporan temporizadores ni módulos adicionales ahora.

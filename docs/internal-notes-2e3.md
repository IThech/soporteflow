# Fase 2E.3: notas internas

Se conserva IncidentMessage con visibility internal, texto plano, saltos de línea y escritura append-only.
Permisos: incidents:view_internal_notes e incidents:add_internal_note. Técnicos activos de toda la
organización (no solo el asignado), administradores de organización y de plataforma mantienen acceso.
Clientes e inactivos no acceden. El administrador de plataforma mantiene acceso transversal.

Nuevas notas: trim, no vacías, máximo 4.000 unidades UTF-16 (String.length); estados open/pending/resolved.
En closed se leen pero no se crean. Las notas históricas largas se cargan y conservan sin truncar;
el límite se valida al crear y al añadir, nunca al cargar. No se cambia el límite de comentarios públicos.

El historial contiene únicamente internal_note_added con referencia al mensaje, autor y fecha, sin
contenido, motivo ni comentario. Su acceso se filtra por incidencia, organización y permiso explícito;
los clientes no reciben eventos, conteos ni autores internos. La conversación sigue separada del historial.
No se cambia SLA: notas y su evento no cumplen primera respuesta ni eliminan atención pendiente.

Persistencia simple: primero se guarda la nota. Después se registra el evento mínimo y se notifica al
asignado activo autorizado, excluyendo autor, clientes, otras organizaciones y ausencia de asignado.
Sin seguidores, correo ni avisos al equipo completo. El aviso conserva el extracto existente.
IDs estables permiten reintentar los efectos sin duplicar nota, evento o aviso. Si un efecto falla,
la UI informa que la nota está guardada, limpia su borrador y ofrece reintentar solo los efectos.
No hay nueva transacción, journal ni rollback de notas. Si se cierra/recarga el diálogo tras ese fallo,
el reintento pendiente no se conserva: revisar el historial y las notificaciones manualmente; el backend
deberá resolver entrega y auditoría duraderas. No se recrean eventos retroactivos de notas antiguas.

Cambios entre pestañas: aviso y actualización explícita sin perder borradores. Un conflicto de snapshot
no guarda ni elimina el texto. localStorage sigue sin proporcionar aislamiento real, atomicidad entre
pestañas ni auditoría fiable. Los datos pueden inspeccionarse desde el navegador. Antes de producción:
autorización y filtrado server-side, almacenamiento seguro y consistencia de eventos/notificaciones.
Rectificaciones: nota adicional; eliminación excepcional por privacidad administrativa y auditable
queda para backend. Sin edición, borrado ordinario, adjuntos, menciones o refactorizaciones ajenas.

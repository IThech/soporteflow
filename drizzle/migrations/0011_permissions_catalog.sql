-- 5.4Q-B: canonical permission catalog (mirror of src/lib/server/auth/permissions.ts).
-- Deterministic, idempotent and non-destructive: no DELETE/TRUNCATE, unknown permissions are
-- kept, and roles / role_permissions / role_assignments are untouched. Seeding grants nothing.
-- On conflict, metadata is refreshed and allowed_scope_types is only ever NARROWED to the
-- canonical scopes (intersection): an existing row can lose scopes (fail-closed) but never
-- gains one, so dormant role assignments cannot become effective through this migration.
INSERT INTO "permissions" ("id", "name", "description", "category", "allowed_scope_types") VALUES
	('incidents:create', 'Crear incidencias', 'Crear incidencias en la organización.', 'incidents', ARRAY['organization']::varchar(50)[]),
	('incidents:view_all', 'Ver todas las incidencias', 'Consultar cualquier incidencia de la organización.', 'incidents', ARRAY['organization']::varchar(50)[]),
	('incidents:view_own', 'Ver incidencias asignadas', 'Consultar solo las incidencias asignadas al propio usuario.', 'incidents', ARRAY['organization']::varchar(50)[]),
	('incidents:edit', 'Editar incidencias', 'Cambiar estado, prioridad, nivel de soporte, sede y categoría de incidencias accesibles.', 'incidents', ARRAY['organization']::varchar(50)[]),
	('incidents:assign', 'Asignar incidencias', 'Asignar o reasignar equipo y técnico de incidencias accesibles.', 'incidents', ARRAY['organization']::varchar(50)[]),
	('incidents:add_comment', 'Añadir comentarios', 'Publicar comentarios públicos en incidencias accesibles.', 'incidents', ARRAY['organization']::varchar(50)[]),
	('incidents:view_internal_notes', 'Ver notas internas', 'Consultar las notas internas de las incidencias.', 'incidents', ARRAY['organization']::varchar(50)[]),
	('incidents:add_internal_note', 'Añadir notas internas', 'Añadir notas internas a las incidencias.', 'incidents', ARRAY['organization']::varchar(50)[]),
	('sites:view', 'Ver sedes', 'Consultar el catálogo de sedes de la organización.', 'sites', ARRAY['organization']::varchar(50)[]),
	('sites:manage', 'Gestionar sedes', 'Crear, renombrar, activar y desactivar sedes.', 'sites', ARRAY['organization']::varchar(50)[]),
	('categories:view', 'Ver categorías', 'Consultar el catálogo de categorías de la organización.', 'categories', ARRAY['organization']::varchar(50)[]),
	('categories:manage', 'Gestionar categorías', 'Crear, editar, activar y desactivar categorías.', 'categories', ARRAY['organization']::varchar(50)[]),
	('teams:view', 'Ver equipos', 'Consultar los equipos activos de la organización.', 'teams', ARRAY['organization']::varchar(50)[]),
	('identities:create', 'Crear identidades', 'Aprovisionar nuevas identidades de usuario.', 'provisioning', ARRAY['organization']::varchar(50)[]),
	('memberships:create', 'Crear membresías', 'Vincular identidades existentes a la organización.', 'provisioning', ARRAY['organization']::varchar(50)[]),
	('roles:assign', 'Asignar roles', 'Asignar roles de la organización a membresías.', 'provisioning', ARRAY['organization']::varchar(50)[])
ON CONFLICT ("id") DO UPDATE SET
	"name" = EXCLUDED."name",
	"description" = EXCLUDED."description",
	"category" = EXCLUDED."category",
	"allowed_scope_types" = ARRAY(
		SELECT scope FROM unnest(EXCLUDED."allowed_scope_types") AS scope
		WHERE scope = ANY ("permissions"."allowed_scope_types")
	)::varchar(50)[];

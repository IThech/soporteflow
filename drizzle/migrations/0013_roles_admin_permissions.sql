-- 5.4R-A: role administration permissions (mirror of src/lib/server/auth/permissions.ts and
-- role-templates.ts). Idempotent and non-destructive: adds roles:view and roles:manage to the
-- catalog, to the organization_admin template and to existing organization_admin system roles.
-- Technician is untouched; nothing is deleted and no role_assignment is created.
-- Same conflict strategy as 0011: metadata refreshed, allowed_scope_types only ever narrowed.
INSERT INTO "permissions" ("id", "name", "description", "category", "allowed_scope_types") VALUES
	('roles:view', 'Ver roles', 'Consultar los roles de la organización y el catálogo de permisos.', 'roles', ARRAY['organization']::varchar(50)[]),
	('roles:manage', 'Gestionar roles', 'Crear y modificar roles personalizados de la organización (5.4R-B/C).', 'roles', ARRAY['organization']::varchar(50)[])
ON CONFLICT ("id") DO UPDATE SET
	"name" = EXCLUDED."name",
	"description" = EXCLUDED."description",
	"category" = EXCLUDED."category",
	"allowed_scope_types" = ARRAY(
		SELECT scope FROM unnest(EXCLUDED."allowed_scope_types") AS scope
		WHERE scope = ANY ("permissions"."allowed_scope_types")
	)::varchar(50)[];
--> statement-breakpoint
INSERT INTO "role_template_permissions" ("role_template_id", "permission_id")
SELECT t."id", v."permission_id"
FROM "role_templates" t
CROSS JOIN (VALUES ('roles:view'), ('roles:manage')) AS v("permission_id")
WHERE t."id" = 'tpl_organization_admin'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", v."permission_id"
FROM "roles" r
CROSS JOIN (VALUES ('roles:view'), ('roles:manage')) AS v("permission_id")
WHERE r."template_id" = 'tpl_organization_admin' AND r."is_custom" = false
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

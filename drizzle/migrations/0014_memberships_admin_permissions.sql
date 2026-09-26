-- 5.4R-C: membership administration read permission (mirror of src/lib/server/auth/permissions.ts
-- and role-templates.ts). Idempotent and non-destructive: adds memberships:view to the catalog, to
-- the organization_admin template and to existing organization_admin system roles.
-- Role assignment/revocation keeps using the existing roles:assign capability (no
-- memberships:manage until membership lifecycle exists). Technician is untouched; nothing is
-- deleted and no role_assignment is created.
-- Same conflict strategy as 0011/0013: metadata refreshed, allowed_scope_types only ever narrowed.
INSERT INTO "permissions" ("id", "name", "description", "category", "allowed_scope_types") VALUES
	('memberships:view', 'Ver membresías', 'Consultar los miembros de la organización y sus roles asignados.', 'memberships', ARRAY['organization']::varchar(50)[])
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
SELECT t."id", 'memberships:view'
FROM "role_templates" t
WHERE t."id" = 'tpl_organization_admin'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", 'memberships:view'
FROM "roles" r
WHERE r."template_id" = 'tpl_organization_admin' AND r."is_custom" = false
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

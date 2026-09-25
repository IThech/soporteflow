-- 5.4Q-C: canonical role templates and tenant-local base roles
-- (mirror of src/lib/server/auth/role-templates.ts). Deterministic, idempotent and
-- non-destructive for tenant data: it never deletes roles, role_permissions or
-- role_assignments, never assigns a role to anyone and never adopts a pre-existing role.
--
-- 1) Collision pre-check. Runs first so a conflict aborts before any write:
--    - a role_template with a canonical code but a different id;
--    - a tenant role using a canonical code that is custom or not derived from the matching
--      template. Such roles are never silently converted into system roles.
DO $$
DECLARE
	conflict record;
BEGIN
	SELECT t.id, t.code INTO conflict
	FROM role_templates t
	JOIN (VALUES ('tpl_organization_admin', 'organization_admin'), ('tpl_technician', 'technician')) AS c(id, code) ON c.code = t.code
	WHERE t.id <> c.id
	LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION 'role template code collision: template % already uses canonical code %', conflict.id, conflict.code;
	END IF;

	SELECT r.organization_id, r.code INTO conflict
	FROM roles r
	JOIN (VALUES ('tpl_organization_admin', 'organization_admin'), ('tpl_technician', 'technician')) AS c(id, code) ON c.code = r.code
	WHERE r.is_custom OR r.template_id IS DISTINCT FROM c.id
	LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION 'role code collision: organization % already has a non-canonical role with code %', conflict.organization_id, conflict.code;
	END IF;
END $$;
--> statement-breakpoint
-- 2) Canonical templates (metadata refreshed; unknown templates untouched).
INSERT INTO "role_templates" ("id", "code", "name", "description", "active") VALUES
	('tpl_organization_admin', 'organization_admin', 'Administrador de organización', 'Rol de administración operativa completa del tenant con las capabilities Core actualmente disponibles.', true),
	('tpl_technician', 'technician', 'Técnico de soporte', 'Rol operativo para atención y gestión de incidencias.', true)
ON CONFLICT ("id") DO UPDATE SET
	"code" = EXCLUDED."code",
	"name" = EXCLUDED."name",
	"description" = EXCLUDED."description",
	"active" = EXCLUDED."active",
	"updated_at" = now();
--> statement-breakpoint
-- 3) Exact permission mappings of the two canonical templates (blueprint only; tenant roles
--    are never touched here).
DELETE FROM "role_template_permissions"
WHERE "role_template_id" IN ('tpl_organization_admin', 'tpl_technician')
	AND ("role_template_id", "permission_id") NOT IN (VALUES
	('tpl_organization_admin', 'incidents:view_all'),
	('tpl_organization_admin', 'incidents:create'),
	('tpl_organization_admin', 'incidents:edit'),
	('tpl_organization_admin', 'incidents:assign'),
	('tpl_organization_admin', 'incidents:add_comment'),
	('tpl_organization_admin', 'incidents:view_internal_notes'),
	('tpl_organization_admin', 'incidents:add_internal_note'),
	('tpl_organization_admin', 'sites:view'),
	('tpl_organization_admin', 'sites:manage'),
	('tpl_organization_admin', 'categories:view'),
	('tpl_organization_admin', 'categories:manage'),
	('tpl_organization_admin', 'teams:view'),
	('tpl_organization_admin', 'identities:create'),
	('tpl_organization_admin', 'memberships:create'),
	('tpl_organization_admin', 'roles:assign'),
	('tpl_technician', 'incidents:view_all'),
	('tpl_technician', 'incidents:create'),
	('tpl_technician', 'incidents:edit'),
	('tpl_technician', 'incidents:assign'),
	('tpl_technician', 'incidents:add_comment'),
	('tpl_technician', 'incidents:view_internal_notes'),
	('tpl_technician', 'incidents:add_internal_note'),
	('tpl_technician', 'sites:view'),
	('tpl_technician', 'categories:view'),
	('tpl_technician', 'teams:view')
	);
--> statement-breakpoint
INSERT INTO "role_template_permissions" ("role_template_id", "permission_id") VALUES
	('tpl_organization_admin', 'incidents:view_all'),
	('tpl_organization_admin', 'incidents:create'),
	('tpl_organization_admin', 'incidents:edit'),
	('tpl_organization_admin', 'incidents:assign'),
	('tpl_organization_admin', 'incidents:add_comment'),
	('tpl_organization_admin', 'incidents:view_internal_notes'),
	('tpl_organization_admin', 'incidents:add_internal_note'),
	('tpl_organization_admin', 'sites:view'),
	('tpl_organization_admin', 'sites:manage'),
	('tpl_organization_admin', 'categories:view'),
	('tpl_organization_admin', 'categories:manage'),
	('tpl_organization_admin', 'teams:view'),
	('tpl_organization_admin', 'identities:create'),
	('tpl_organization_admin', 'memberships:create'),
	('tpl_organization_admin', 'roles:assign'),
	('tpl_technician', 'incidents:view_all'),
	('tpl_technician', 'incidents:create'),
	('tpl_technician', 'incidents:edit'),
	('tpl_technician', 'incidents:assign'),
	('tpl_technician', 'incidents:add_comment'),
	('tpl_technician', 'incidents:view_internal_notes'),
	('tpl_technician', 'incidents:add_internal_note'),
	('tpl_technician', 'sites:view'),
	('tpl_technician', 'categories:view'),
	('tpl_technician', 'teams:view')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- 4) Backfill: one role per canonical template in every existing organization.
INSERT INTO "roles" ("organization_id", "name", "code", "description", "template_id", "is_custom", "active")
SELECT o."id", t."name", t."code", t."description", t."id", false, true
FROM "organizations" o
CROSS JOIN "role_templates" t
WHERE t."id" IN ('tpl_organization_admin', 'tpl_technician') AND t."active"
ON CONFLICT ("organization_id", "code") DO NOTHING;
--> statement-breakpoint
-- 5) Copy missing template permissions into canonical tenant roles (never removes any).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", tp."permission_id"
FROM "roles" r
JOIN "role_template_permissions" tp ON tp."role_template_id" = r."template_id"
WHERE r."template_id" IN ('tpl_organization_admin', 'tpl_technician') AND r."is_custom" = false
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

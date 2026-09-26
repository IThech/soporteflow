-- 5.4S-A: invitations table, 5.4S canonical permissions and the Customer system role
-- (mirror of src/lib/server/db/schema/auth.ts, src/lib/server/auth/permissions.ts and
-- role-templates.ts). Additive, idempotent and non-destructive for tenant data: it never deletes
-- roles, role_permissions or role_assignments, never assigns a role to anyone and never adopts a
-- pre-existing role.
--
-- 1) Collision pre-check (same policy as 0012). Runs first so a conflict aborts before any write:
--    - a role_template already using code 'customer' with a different id;
--    - a tenant role with code 'customer' that is custom or not derived from tpl_customer.
--    Such roles are never silently converted into system roles: rename them before upgrading.
DO $$
DECLARE
	conflict record;
BEGIN
	SELECT t.id, t.code INTO conflict
	FROM role_templates t
	WHERE t.code = 'customer' AND t.id <> 'tpl_customer'
	LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION 'role template code collision: template % already uses canonical code %', conflict.id, conflict.code;
	END IF;

	SELECT r.organization_id, r.code INTO conflict
	FROM roles r
	WHERE r.code = 'customer' AND (r.is_custom OR r.template_id IS DISTINCT FROM 'tpl_customer')
	LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION 'role code collision: organization % already has a non-canonical role with code %', conflict.organization_id, conflict.code;
	END IF;
END $$;
--> statement-breakpoint
-- 2) invitations (persistence only). Guarded so a second run is a no-op.
CREATE TABLE IF NOT EXISTS "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"role_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitations_status_check" CHECK ("invitations"."status" IN ('pending', 'accepted', 'revoked', 'expired')),
	CONSTRAINT "invitations_email_normalized_check" CHECK ("invitations"."email" <> '' AND "invitations"."email" = lower(btrim("invitations"."email"))),
	CONSTRAINT "invitations_accepted_at_check" CHECK (("invitations"."status" = 'accepted') = ("invitations"."accepted_at" IS NOT NULL))
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invitations_organization_id_organizations_id_fk') THEN
		ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invitations_invited_by_user_id_users_id_fk') THEN
		ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
	END IF;
	-- Tenant-safe role reference: the role must belong to the invitation's organization.
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invitations_role_org_fk') THEN
		ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_org_fk" FOREIGN KEY ("role_id","organization_id") REFERENCES "public"."roles"("id","organization_id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_org_status_idx" ON "invitations" USING btree ("organization_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invitations_org_email_pending_unique_idx" ON "invitations" USING btree ("organization_id","email") WHERE status = 'pending';
--> statement-breakpoint
-- 3) 5.4S canonical permissions. Same conflict strategy as 0011: metadata refreshed,
--    allowed_scope_types only ever narrowed. Seeding grants nothing.
INSERT INTO "permissions" ("id", "name", "description", "category", "allowed_scope_types") VALUES
	('incidents:view_requested', 'Ver incidencias solicitadas', 'Consultar solo las incidencias en las que el propio usuario es el solicitante.', 'incidents', ARRAY['organization']::varchar(50)[]),
	('invitations:create', 'Crear invitaciones', 'Invitar a personas a unirse a la organización con un rol.', 'invitations', ARRAY['organization']::varchar(50)[]),
	('invitations:view', 'Ver invitaciones', 'Consultar las invitaciones de la organización.', 'invitations', ARRAY['organization']::varchar(50)[]),
	('invitations:revoke', 'Revocar invitaciones', 'Cancelar invitaciones pendientes de la organización.', 'invitations', ARRAY['organization']::varchar(50)[])
ON CONFLICT ("id") DO UPDATE SET
	"name" = EXCLUDED."name",
	"description" = EXCLUDED."description",
	"category" = EXCLUDED."category",
	"allowed_scope_types" = ARRAY(
		SELECT scope FROM unnest(EXCLUDED."allowed_scope_types") AS scope
		WHERE scope = ANY ("permissions"."allowed_scope_types")
	)::varchar(50)[];
--> statement-breakpoint
-- 4) Customer template (metadata refreshed on re-run).
INSERT INTO "role_templates" ("id", "code", "name", "description", "active") VALUES
	('tpl_customer', 'customer', 'Cliente', 'Rol para clientes externos y solicitantes de asistencia técnica.', true)
ON CONFLICT ("id") DO UPDATE SET
	"code" = EXCLUDED."code",
	"name" = EXCLUDED."name",
	"description" = EXCLUDED."description",
	"active" = EXCLUDED."active",
	"updated_at" = now();
--> statement-breakpoint
-- 5) Template mappings (blueprint only). Customer: exactly its 5 permissions.
--    organization_admin: + invitations:create/view/revoke + incidents:view_requested (needed so
--    monotonic delegation lets an admin grant the Customer role; view_all already covers
--    visibility). Technician: untouched.
DELETE FROM "role_template_permissions"
WHERE "role_template_id" = 'tpl_customer'
	AND "permission_id" NOT IN ('incidents:create', 'incidents:view_requested', 'incidents:add_comment', 'sites:view', 'categories:view');
--> statement-breakpoint
INSERT INTO "role_template_permissions" ("role_template_id", "permission_id") VALUES
	('tpl_customer', 'incidents:create'),
	('tpl_customer', 'incidents:view_requested'),
	('tpl_customer', 'incidents:add_comment'),
	('tpl_customer', 'sites:view'),
	('tpl_customer', 'categories:view'),
	('tpl_organization_admin', 'invitations:create'),
	('tpl_organization_admin', 'invitations:view'),
	('tpl_organization_admin', 'invitations:revoke'),
	('tpl_organization_admin', 'incidents:view_requested')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- 6) Backfill: a Customer system role in every existing organization (no assignment is created).
INSERT INTO "roles" ("organization_id", "name", "code", "description", "template_id", "is_custom", "active")
SELECT o."id", t."name", t."code", t."description", t."id", false, true
FROM "organizations" o
CROSS JOIN "role_templates" t
WHERE t."id" = 'tpl_customer' AND t."active"
ON CONFLICT ("organization_id", "code") DO NOTHING;
--> statement-breakpoint
-- 7) Copy the physical permissions into tenant roles (never removes any):
--    Customer roles get their template set; existing organization_admin system roles get the
--    0015 additions only (no full template re-sync).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", tp."permission_id"
FROM "roles" r
JOIN "role_template_permissions" tp ON tp."role_template_id" = r."template_id"
WHERE r."template_id" = 'tpl_customer' AND r."is_custom" = false
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", v."permission_id"
FROM "roles" r
CROSS JOIN (VALUES ('invitations:create'), ('invitations:view'), ('invitations:revoke'), ('incidents:view_requested')) AS v("permission_id")
WHERE r."template_id" = 'tpl_organization_admin' AND r."is_custom" = false
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

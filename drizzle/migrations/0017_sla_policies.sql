-- 5.4T-A: organization SLA policies (targets only, 24x7 elapsed minutes) and the sla:view /
-- sla:manage permissions (mirror of src/lib/server/db/schema/sla.ts, permissions.ts and
-- role-templates.ts). Additive, idempotent and non-destructive: no policy is created for any
-- organization, custom roles are untouched and no role_assignment is created.
CREATE TABLE IF NOT EXISTS "sla_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"first_response_minutes" integer NOT NULL,
	"resolution_minutes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sla_policies_org_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "sla_policies_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "sla_policies_code_check" CHECK (char_length("sla_policies"."code") BETWEEN 3 AND 50 AND "sla_policies"."code" ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'),
	CONSTRAINT "sla_policies_name_check" CHECK (btrim("sla_policies"."name") <> ''),
	CONSTRAINT "sla_policies_description_check" CHECK ("sla_policies"."description" IS NULL OR char_length("sla_policies"."description") <= 1000),
	CONSTRAINT "sla_policies_targets_check" CHECK ("sla_policies"."first_response_minutes" BETWEEN 1 AND 5256000 AND "sla_policies"."resolution_minutes" BETWEEN 1 AND 5256000 AND "sla_policies"."resolution_minutes" >= "sla_policies"."first_response_minutes"),
	CONSTRAINT "sla_policies_default_active_check" CHECK (NOT "sla_policies"."is_default" OR "sla_policies"."active")
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sla_policies_organization_id_organizations_id_fk') THEN
		ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sla_policies_org_default_unique_idx" ON "sla_policies" USING btree ("organization_id") WHERE is_default = true;
--> statement-breakpoint
-- Catalog (same conflict strategy as 0011: metadata refreshed, scopes only ever narrowed).
INSERT INTO "permissions" ("id", "name", "description", "category", "allowed_scope_types") VALUES
	('sla:view', 'Ver políticas SLA', 'Consultar las políticas SLA de la organización.', 'sla', ARRAY['organization']::varchar(50)[]),
	('sla:manage', 'Gestionar políticas SLA', 'Crear, modificar, activar y desactivar políticas SLA de la organización.', 'sla', ARRAY['organization']::varchar(50)[])
ON CONFLICT ("id") DO UPDATE SET
	"name" = EXCLUDED."name",
	"description" = EXCLUDED."description",
	"category" = EXCLUDED."category",
	"allowed_scope_types" = ARRAY(
		SELECT scope FROM unnest(EXCLUDED."allowed_scope_types") AS scope
		WHERE scope = ANY ("permissions"."allowed_scope_types")
	)::varchar(50)[];
--> statement-breakpoint
-- Templates: organization_admin + sla:view/sla:manage; technician + sla:view; customer none.
INSERT INTO "role_template_permissions" ("role_template_id", "permission_id") VALUES
	('tpl_organization_admin', 'sla:view'),
	('tpl_organization_admin', 'sla:manage'),
	('tpl_technician', 'sla:view')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Existing system roles only (custom roles are never modified).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", v."permission_id"
FROM "roles" r
JOIN (VALUES
	('tpl_organization_admin', 'sla:view'),
	('tpl_organization_admin', 'sla:manage'),
	('tpl_technician', 'sla:view')
) AS v("template_id", "permission_id") ON v."template_id" = r."template_id"
WHERE r."is_custom" = false
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

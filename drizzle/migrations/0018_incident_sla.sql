-- 5.4T-B: SLA applied to incidents (snapshot + 24x7 deadlines) and the sla:assign permission
-- (mirror of src/lib/server/db/schema/incidents.ts, permissions.ts and role-templates.ts).
-- Additive and idempotent. Existing incidents keep no SLA (all new columns NULL); no policy is
-- applied retroactively. Custom roles are untouched and no role_assignment is created.
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "sla_policy_id" uuid;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "sla_first_response_minutes" integer;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "sla_resolution_minutes" integer;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "sla_applied_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "first_response_due_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "resolution_due_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "first_response_at" timestamp with time zone;
--> statement-breakpoint
DO $$
BEGIN
	-- Tenant-safe policy reference: the policy must belong to the incident's organization.
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incidents_sla_policy_org_fk') THEN
		ALTER TABLE "incidents" ADD CONSTRAINT "incidents_sla_policy_org_fk" FOREIGN KEY ("sla_policy_id","organization_id") REFERENCES "public"."sla_policies"("id","organization_id") ON DELETE restrict ON UPDATE no action;
	END IF;
	-- All SLA snapshot/deadline fields together (deadlines = applied_at + minutes), or none.
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incidents_sla_snapshot_check') THEN
		ALTER TABLE "incidents" ADD CONSTRAINT "incidents_sla_snapshot_check" CHECK (("incidents"."sla_policy_id" IS NULL AND "incidents"."sla_first_response_minutes" IS NULL AND "incidents"."sla_resolution_minutes" IS NULL AND "incidents"."sla_applied_at" IS NULL AND "incidents"."first_response_due_at" IS NULL AND "incidents"."resolution_due_at" IS NULL) OR ("incidents"."sla_policy_id" IS NOT NULL AND "incidents"."sla_first_response_minutes" BETWEEN 1 AND 5256000 AND "incidents"."sla_resolution_minutes" BETWEEN "incidents"."sla_first_response_minutes" AND 5256000 AND "incidents"."sla_applied_at" IS NOT NULL AND "incidents"."first_response_due_at" = "incidents"."sla_applied_at" + "incidents"."sla_first_response_minutes" * interval '1 minute' AND "incidents"."resolution_due_at" = "incidents"."sla_applied_at" + "incidents"."sla_resolution_minutes" * interval '1 minute'));
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incidents_org_first_response_due_idx" ON "incidents" USING btree ("organization_id","first_response_due_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incidents_org_resolution_due_idx" ON "incidents" USING btree ("organization_id","resolution_due_at");
--> statement-breakpoint
INSERT INTO "permissions" ("id", "name", "description", "category", "allowed_scope_types") VALUES
	('sla:assign', 'Asignar SLA a incidencias', 'Elegir, cambiar o retirar la política SLA de incidencias accesibles.', 'sla', ARRAY['organization']::varchar(50)[])
ON CONFLICT ("id") DO UPDATE SET
	"name" = EXCLUDED."name",
	"description" = EXCLUDED."description",
	"category" = EXCLUDED."category",
	"allowed_scope_types" = ARRAY(
		SELECT scope FROM unnest(EXCLUDED."allowed_scope_types") AS scope
		WHERE scope = ANY ("permissions"."allowed_scope_types")
	)::varchar(50)[];
--> statement-breakpoint
INSERT INTO "role_template_permissions" ("role_template_id", "permission_id") VALUES
	('tpl_organization_admin', 'sla:assign'),
	('tpl_technician', 'sla:assign')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", 'sla:assign'
FROM "roles" r
WHERE r."template_id" IN ('tpl_organization_admin', 'tpl_technician') AND r."is_custom" = false
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

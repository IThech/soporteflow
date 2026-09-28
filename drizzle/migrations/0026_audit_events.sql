CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_type" varchar(20) NOT NULL,
	"actor_user_id" uuid,
	"action" varchar(80) NOT NULL,
	"entity_type" varchar(40) NOT NULL,
	"entity_id" uuid,
	"target_user_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_actor_check" CHECK (("audit_events"."actor_type" = 'user' AND "audit_events"."actor_user_id" IS NOT NULL) OR ("audit_events"."actor_type" IN ('system','automation','platform') AND "audit_events"."actor_user_id" IS NULL)),
	CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
	CONSTRAINT "audit_events_entity_type_check" CHECK ("audit_events"."entity_type" ~ '^[a-z][a-z_]*$'),
	CONSTRAINT "audit_events_metadata_check" CHECK (jsonb_typeof("audit_events"."metadata") = 'object' AND octet_length("audit_events"."metadata"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_org_created_idx" ON "audit_events" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_events_org_entity_idx" ON "audit_events" USING btree ("organization_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_org_actor_idx" ON "audit_events" USING btree ("organization_id","actor_user_id","created_at");
--> statement-breakpoint
-- 5.4X-A: administrative audit trail is append-only. UPDATE is always rejected; DELETE is not
-- exposed by the application (only the organization cascade reaches it; retention is 5.4X-D).
CREATE OR REPLACE FUNCTION "audit_events_append_only"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_events_append_only" ON "audit_events";
--> statement-breakpoint
CREATE TRIGGER "audit_events_append_only" BEFORE UPDATE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();
--> statement-breakpoint
-- Catalog (same conflict strategy as 0025: metadata refreshed, scopes only ever narrowed).
INSERT INTO "permissions" ("id", "name", "description", "category", "allowed_scope_types") VALUES
	('audit:view', 'Ver auditoría', 'Consultar el registro de auditoría administrativa de la organización.', 'audit', ARRAY['organization']::varchar(50)[])
ON CONFLICT ("id") DO UPDATE SET
	"name" = EXCLUDED."name",
	"description" = EXCLUDED."description",
	"category" = EXCLUDED."category",
	"allowed_scope_types" = ARRAY(
		SELECT scope FROM unnest(EXCLUDED."allowed_scope_types") AS scope
		WHERE scope = ANY ("permissions"."allowed_scope_types")
	)::varchar(50)[];
--> statement-breakpoint
-- Templates: organization_admin only (technician and customer get nothing).
INSERT INTO "role_template_permissions" ("role_template_id", "permission_id") VALUES
	('tpl_organization_admin', 'audit:view')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Existing system roles only (custom roles are never modified).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", 'audit:view'
FROM "roles" r
WHERE r."template_id" = 'tpl_organization_admin' AND r."is_custom" = false
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

CREATE TABLE "automation_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"rule_name" varchar(120) NOT NULL,
	"conditions" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"sort_order" integer NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error_code" varchar(64),
	"actions_completed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_executions_rule_event_unique" UNIQUE("rule_id","source_event_id"),
	CONSTRAINT "automation_executions_status_check" CHECK ("automation_executions"."status" IN ('pending','processing','succeeded','failed','skipped')),
	CONSTRAINT "automation_executions_lease_check" CHECK (("automation_executions"."status" = 'processing' AND "automation_executions"."lease_token" IS NOT NULL AND "automation_executions"."lease_until" IS NOT NULL) OR ("automation_executions"."status" <> 'processing' AND "automation_executions"."lease_token" IS NULL AND "automation_executions"."lease_until" IS NULL)),
	CONSTRAINT "automation_executions_counts_check" CHECK ("automation_executions"."attempt_count" >= 0 AND "automation_executions"."actions_completed" BETWEEN 0 AND 10)
);
--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"conditions" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_rules_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "automation_rules_name_check" CHECK (btrim("automation_rules"."name") <> ''),
	CONSTRAINT "automation_rules_conditions_check" CHECK (jsonb_typeof("automation_rules"."conditions") = 'object' AND octet_length("automation_rules"."conditions"::text) <= 16384),
	CONSTRAINT "automation_rules_actions_check" CHECK (jsonb_typeof("automation_rules"."actions") = 'array' AND jsonb_array_length("automation_rules"."actions") BETWEEN 1 AND 10 AND octet_length("automation_rules"."actions"::text) <= 24576)
);
--> statement-breakpoint
ALTER TABLE "incident_messages" ALTER COLUMN "author_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "incident_messages" ADD COLUMN "author_type" varchar(20) DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_events" ADD COLUMN "causation_event_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_events" ADD COLUMN "automation_execution_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_events" ADD COLUMN "automation_depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_rule_org_fk" FOREIGN KEY ("rule_id","organization_id") REFERENCES "public"."automation_rules"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_id_org_unique" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_event_org_fk" FOREIGN KEY ("source_event_id","organization_id") REFERENCES "public"."automation_events"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_executions_due_idx" ON "automation_executions" USING btree ("status","lease_until","created_at");--> statement-breakpoint
CREATE INDEX "automation_executions_history_idx" ON "automation_executions" USING btree ("organization_id","rule_id","created_at","id");--> statement-breakpoint
CREATE INDEX "automation_executions_event_idx" ON "automation_executions" USING btree ("source_event_id");--> statement-breakpoint
CREATE INDEX "automation_rules_fanout_idx" ON "automation_rules" USING btree ("organization_id","event_type","active");--> statement-breakpoint
ALTER TABLE "incident_messages" ADD CONSTRAINT "incident_messages_author_check" CHECK (("incident_messages"."author_type" = 'user' AND "incident_messages"."author_user_id" IS NOT NULL) OR ("incident_messages"."author_type" = 'system' AND "incident_messages"."author_user_id" IS NULL AND "incident_messages"."visibility" = 'internal'));--> statement-breakpoint
ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_depth_check" CHECK (("automation_events"."automation_depth" = 0 AND "automation_events"."causation_event_id" IS NULL AND "automation_events"."automation_execution_id" IS NULL) OR ("automation_events"."automation_depth" BETWEEN 1 AND 5 AND "automation_events"."causation_event_id" IS NOT NULL AND "automation_events"."automation_execution_id" IS NOT NULL AND "automation_events"."actor_user_id" IS NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "automation_events_append_only"() RETURNS trigger AS $$
BEGIN
	-- Only the FK action ON DELETE SET NULL of the actor may touch a stored event.
	IF NEW.actor_user_id IS NULL
		AND (NEW.id, NEW.position, NEW.organization_id, NEW.event_type, NEW.schema_version,
			NEW.aggregate_type, NEW.aggregate_id, NEW.payload, NEW.occurred_at, NEW.created_at, NEW.causation_event_id, NEW.automation_execution_id, NEW.automation_depth)
		IS NOT DISTINCT FROM
			(OLD.id, OLD.position, OLD.organization_id, OLD.event_type, OLD.schema_version,
			OLD.aggregate_type, OLD.aggregate_id, OLD.payload, OLD.occurred_at, OLD.created_at, OLD.causation_event_id, OLD.automation_execution_id, OLD.automation_depth)
	THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'automation_events is append-only' USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "automation_events_append_only" ON "automation_events";
--> statement-breakpoint
CREATE TRIGGER "automation_events_append_only" BEFORE UPDATE ON "automation_events" FOR EACH ROW EXECUTE FUNCTION "automation_events_append_only"();

--> statement-breakpoint
-- Catalog (same conflict strategy as 0017: metadata refreshed, scopes only ever narrowed).
INSERT INTO "permissions" ("id", "name", "description", "category", "allowed_scope_types") VALUES
	('automations:view', 'Ver automatizaciones', 'Consultar reglas y ejecuciones de la organización.', 'automations', ARRAY['organization']::varchar(50)[]),
	('automations:manage', 'Gestionar automatizaciones', 'Configurar acciones internas con autoridad de sistema en la organización.', 'automations', ARRAY['organization']::varchar(50)[])
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
	('tpl_organization_admin', 'automations:view'),
	('tpl_organization_admin', 'automations:manage')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Existing system roles only (custom roles are never modified).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", v."permission_id"
FROM "roles" r
JOIN (VALUES
	('tpl_organization_admin', 'automations:view'),
	('tpl_organization_admin', 'automations:manage')
) AS v("template_id", "permission_id") ON v."template_id" = r."template_id"
WHERE r."is_custom" = false
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

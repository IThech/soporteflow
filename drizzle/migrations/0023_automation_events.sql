-- 5.4V-A: canonical automation events (mirror of src/lib/server/db/schema/automation.ts).
-- Durable, tenant-scoped integration events written by domain mutations in their own transaction.
-- NOT event sourcing: domain tables stay the source of truth and incident_history stays the audit.
-- Append-only: the trigger below rejects UPDATE (except the FK-driven SET NULL of the actor when a
-- user row is deleted). No rows are created here. Additive and idempotent.
CREATE TABLE IF NOT EXISTS "automation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "automation_events_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"aggregate_type" varchar(40) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_events_position_unique" UNIQUE("position"),
	CONSTRAINT "automation_events_event_type_check" CHECK ("automation_events"."event_type" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
	CONSTRAINT "automation_events_aggregate_type_check" CHECK ("automation_events"."aggregate_type" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "automation_events_schema_version_check" CHECK ("automation_events"."schema_version" >= 1),
	CONSTRAINT "automation_events_payload_check" CHECK (jsonb_typeof("automation_events"."payload") = 'object' AND octet_length("automation_events"."payload"::text) <= 8192)
);
--> statement-breakpoint
DO $$
BEGIN
	-- Tenant owner of the fact; removing the organization removes its events.
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_events_organization_fk') THEN
		ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	-- Global user (not membership): the fact stays valid after the actor leaves the organization.
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_events_actor_fk') THEN
		ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_events_org_position_idx" ON "automation_events" USING btree ("organization_id","position");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_events_aggregate_idx" ON "automation_events" USING btree ("organization_id","aggregate_type","aggregate_id","position");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "automation_events_append_only"() RETURNS trigger AS $$
BEGIN
	-- Only the FK action ON DELETE SET NULL of the actor may touch a stored event.
	IF NEW.actor_user_id IS NULL
		AND (NEW.id, NEW.position, NEW.organization_id, NEW.event_type, NEW.schema_version,
			NEW.aggregate_type, NEW.aggregate_id, NEW.payload, NEW.occurred_at, NEW.created_at)
		IS NOT DISTINCT FROM
			(OLD.id, OLD.position, OLD.organization_id, OLD.event_type, OLD.schema_version,
			OLD.aggregate_type, OLD.aggregate_id, OLD.payload, OLD.occurred_at, OLD.created_at)
	THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'automation_events is append-only' USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "automation_events_append_only" ON "automation_events";
--> statement-breakpoint
CREATE TRIGGER "automation_events_append_only" BEFORE UPDATE ON "automation_events" FOR EACH ROW EXECUTE FUNCTION "automation_events_append_only"();

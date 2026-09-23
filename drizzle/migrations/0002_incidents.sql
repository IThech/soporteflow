CREATE TABLE "incident_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_type" varchar(50) NOT NULL,
	"actor_type" varchar(20) DEFAULT 'user' NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"comment" text,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_history_actor_check" CHECK (("incident_history"."actor_type" = 'system' AND "incident_history"."actor_user_id" IS NULL) OR ("incident_history"."actor_type" = 'user' AND "incident_history"."actor_user_id" IS NOT NULL)),
	CONSTRAINT "incident_history_actor_type_check" CHECK ("incident_history"."actor_type" IN ('user', 'system')),
	CONSTRAINT "incident_history_event_type_check" CHECK ("incident_history"."event_type" IN (
				'created', 'status_changed', 'priority_changed', 'assigned',
				'reassigned', 'escalated', 'site_changed', 'resolved',
				'resolution_accepted', 'resolution_rejected', 'closed',
				'reopened', 'reclassified', 'priority_override_applied',
				'priority_override_modified', 'priority_override_removed',
				'internal_note_added'
			))
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"incident_number" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"status" varchar(30) DEFAULT 'open' NOT NULL,
	"priority" varchar(30) DEFAULT 'medium' NOT NULL,
	"client" varchar(255) NOT NULL,
	"client_user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"site_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "incidents_org_number_unique" UNIQUE("organization_id","incident_number"),
	CONSTRAINT "incidents_title_check" CHECK (btrim("incidents"."title") <> ''),
	CONSTRAINT "incidents_client_check" CHECK (btrim("incidents"."client") <> ''),
	CONSTRAINT "incidents_description_check" CHECK (btrim("incidents"."description") <> ''),
	CONSTRAINT "incidents_status_check" CHECK ("incidents"."status" IN ('open', 'pending', 'resolved', 'closed')),
	CONSTRAINT "incidents_priority_check" CHECK ("incidents"."priority" IN ('low', 'medium', 'high', 'urgent'))
);
--> statement-breakpoint
CREATE TABLE "organization_counters" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"last_incident_number" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incident_history" ADD CONSTRAINT "incident_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_history" ADD CONSTRAINT "incident_history_incident_org_fk" FOREIGN KEY ("incident_id","organization_id") REFERENCES "public"."incidents"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_history" ADD CONSTRAINT "incident_history_actor_org_fk" FOREIGN KEY ("organization_id","actor_user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_creator_org_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_client_user_org_fk" FOREIGN KEY ("organization_id","client_user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_site_org_fk" FOREIGN KEY ("site_id","organization_id") REFERENCES "public"."sites"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_counters" ADD CONSTRAINT "organization_counters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_history_incident_created_idx" ON "incident_history" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "incidents_org_status_idx" ON "incidents" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "incidents_org_site_idx" ON "incidents" USING btree ("organization_id","site_id");
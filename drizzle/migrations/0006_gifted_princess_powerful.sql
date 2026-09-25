CREATE TABLE "incident_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"visibility" varchar(20) NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_messages_visibility_check" CHECK ("incident_messages"."visibility" IN ('public', 'internal')),
	CONSTRAINT "incident_messages_body_check" CHECK (btrim("incident_messages"."body") <> ''),
	CONSTRAINT "incident_messages_body_length_check" CHECK (char_length("incident_messages"."body") <= 4000)
);
--> statement-breakpoint
ALTER TABLE "incident_messages" ADD CONSTRAINT "incident_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_messages" ADD CONSTRAINT "incident_messages_incident_org_fk" FOREIGN KEY ("incident_id","organization_id") REFERENCES "public"."incidents"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_messages" ADD CONSTRAINT "incident_messages_author_org_fk" FOREIGN KEY ("organization_id","author_user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_messages_org_incident_visibility_created_idx" ON "incident_messages" USING btree ("organization_id","incident_id","visibility","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
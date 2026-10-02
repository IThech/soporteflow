CREATE TABLE "incident_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"original_name" varchar(180) NOT NULL,
	"storage_key" uuid NOT NULL,
	"mime_type" varchar(40) NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "attachments_size_check" CHECK ("incident_attachments"."size" > 0 AND "incident_attachments"."size" <= 5242880),
	CONSTRAINT "attachments_mime_check" CHECK ("incident_attachments"."mime_type" IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp'))
);
--> statement-breakpoint
ALTER TABLE "incident_attachments" ADD CONSTRAINT "attachments_incident_tenant_fk" FOREIGN KEY ("incident_id","organization_id") REFERENCES "public"."incidents"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "incident_attachments" ADD CONSTRAINT "attachments_actor_tenant_fk" FOREIGN KEY ("organization_id","actor_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "attachments_org_incident_idx" ON "incident_attachments" USING btree ("organization_id","incident_id");
--> statement-breakpoint
CREATE INDEX "attachments_incident_idx" ON "incident_attachments" USING btree ("incident_id");

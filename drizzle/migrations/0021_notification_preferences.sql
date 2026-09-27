-- 5.4U-B: personal notification preferences (mirror of src/lib/server/db/schema/notifications.ts).
-- Rows are overrides only: a missing row means the catalog default (every event enabled in-app).
-- No rows are created here. Additive and idempotent; the notifications table is untouched.
CREATE TABLE IF NOT EXISTS "notification_preferences" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"in_app_enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_pkey" PRIMARY KEY("organization_id","user_id","event_type"),
	CONSTRAINT "notification_preferences_event_type_check" CHECK ("notification_preferences"."event_type" ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$')
);
--> statement-breakpoint
DO $$
BEGIN
	-- Tenant-safe owner: the preference belongs to a membership of that organization.
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_preferences_member_org_fk') THEN
		ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_member_org_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

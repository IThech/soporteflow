-- 5.4U-D: email delivery (mirror of src/lib/server/db/schema/notifications.ts).
-- A. notification_preferences: per-channel overrides. in_app_enabled becomes nullable and
--    email_enabled is added (NULL = channel default: in-app ON, email OFF). Existing rows keep their
--    in-app override and get email NULL (default OFF): nobody starts receiving email.
-- B. notification_deliveries: notification-scoped outbox of external delivery intents (email only).
-- Additive and idempotent; no data rewrite.
CREATE TABLE IF NOT EXISTS "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"notification_id" uuid,
	"channel" varchar(20) NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"title" varchar(160) NOT NULL,
	"message" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"lease_token" uuid,
	"last_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error_code" varchar(40),
	"provider_message_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_channel_check" CHECK ("notification_deliveries"."channel" IN ('email')),
	CONSTRAINT "notification_deliveries_status_check" CHECK ("notification_deliveries"."status" IN ('pending', 'processing', 'sent', 'retry', 'failed')),
	CONSTRAINT "notification_deliveries_event_type_check" CHECK ("notification_deliveries"."event_type" ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'),
	CONSTRAINT "notification_deliveries_title_check" CHECK (length(btrim("notification_deliveries"."title")) BETWEEN 1 AND 160),
	CONSTRAINT "notification_deliveries_message_check" CHECK (length(btrim("notification_deliveries"."message")) BETWEEN 1 AND 2000),
	CONSTRAINT "notification_deliveries_attempt_count_check" CHECK ("notification_deliveries"."attempt_count" BETWEEN 0 AND 10),
	CONSTRAINT "notification_deliveries_error_code_check" CHECK ("notification_deliveries"."last_error_code" IS NULL OR "notification_deliveries"."last_error_code" IN ('PROVIDER_NOT_CONFIGURED', 'NETWORK_ERROR', 'RATE_LIMITED', 'RECIPIENT_INVALID', 'RECIPIENT_INACTIVE', 'PROVIDER_ERROR', 'MAX_ATTEMPTS')),
	CONSTRAINT "notification_deliveries_state_check" CHECK (("notification_deliveries"."status" IN ('pending', 'retry', 'processing')) = ("notification_deliveries"."next_attempt_at" IS NOT NULL) AND ("notification_deliveries"."status" = 'processing') = ("notification_deliveries"."lease_token" IS NOT NULL) AND ("notification_deliveries"."status" = 'sent') = ("notification_deliveries"."sent_at" IS NOT NULL) AND ("notification_deliveries"."status" = 'failed') = ("notification_deliveries"."failed_at" IS NOT NULL) AND ("notification_deliveries"."status" <> 'failed' OR "notification_deliveries"."last_error_code" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ALTER COLUMN "in_app_enabled" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "email_enabled" boolean;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_recipient_org_fk') THEN
		ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_recipient_org_fk" FOREIGN KEY ("organization_id","recipient_user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_notification_fk') THEN
		ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_deliveries_due_idx" ON "notification_deliveries" USING btree ("next_attempt_at","id") WHERE "notification_deliveries"."status" IN ('pending', 'retry', 'processing');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_deliveries_recipient_idx" ON "notification_deliveries" USING btree ("organization_id","recipient_user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_deliveries_terminal_idx" ON "notification_deliveries" USING btree ("updated_at") WHERE "notification_deliveries"."status" IN ('sent', 'failed');
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_preferences_override_check') THEN
		ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_override_check" CHECK ("notification_preferences"."in_app_enabled" IS NOT NULL OR "notification_preferences"."email_enabled" IS NOT NULL);
	END IF;
END $$;

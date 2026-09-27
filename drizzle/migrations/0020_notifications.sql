CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"type" varchar(80) NOT NULL,
	"title" varchar(160) NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'),
	CONSTRAINT "notifications_title_check" CHECK (length(btrim("notifications"."title")) BETWEEN 1 AND 160),
	CONSTRAINT "notifications_message_check" CHECK (length(btrim("notifications"."message")) BETWEEN 1 AND 2000),
	CONSTRAINT "notifications_payload_check" CHECK ("notifications"."payload" IS NULL OR (jsonb_typeof("notifications"."payload") = 'object' AND octet_length("notifications"."payload"::text) <= 8192))
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_org_fk" FOREIGN KEY ("organization_id","recipient_user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_idx" ON "notifications" USING btree ("organization_id","recipient_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_recipient_unread_idx" ON "notifications" USING btree ("organization_id","recipient_user_id") WHERE "notifications"."read_at" IS NULL;
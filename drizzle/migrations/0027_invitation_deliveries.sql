-- 5.4X-C: target of the tenant-bound FK from invitation_deliveries (must exist before the FK).
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_id_org_unique" UNIQUE("id","organization_id");--> statement-breakpoint
CREATE TABLE "invitation_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"lease_token" uuid,
	"last_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error_code" varchar(40),
	"provider_message_id" varchar(255),
	"token_ciphertext" text,
	"token_iv" text,
	"token_auth_tag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_deliveries_status_check" CHECK ("invitation_deliveries"."status" IN ('pending','processing','retry','sent','failed','cancelled')),
	CONSTRAINT "invitation_deliveries_lease_check" CHECK (("invitation_deliveries"."status" = 'processing') = ("invitation_deliveries"."lease_token" IS NOT NULL)),
	CONSTRAINT "invitation_deliveries_token_state_check" CHECK (("invitation_deliveries"."status" IN ('pending','processing','retry') AND "invitation_deliveries"."token_ciphertext" IS NOT NULL AND "invitation_deliveries"."token_iv" IS NOT NULL AND "invitation_deliveries"."token_auth_tag" IS NOT NULL AND "invitation_deliveries"."next_attempt_at" IS NOT NULL) OR ("invitation_deliveries"."status" IN ('sent','failed','cancelled') AND "invitation_deliveries"."token_ciphertext" IS NULL AND "invitation_deliveries"."token_iv" IS NULL AND "invitation_deliveries"."token_auth_tag" IS NULL AND "invitation_deliveries"."next_attempt_at" IS NULL)),
	CONSTRAINT "invitation_deliveries_attempts_check" CHECK ("invitation_deliveries"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "invitation_deliveries" ADD CONSTRAINT "invitation_deliveries_invitation_org_fk" FOREIGN KEY ("invitation_id","organization_id") REFERENCES "public"."invitations"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_deliveries_active_unique_idx" ON "invitation_deliveries" USING btree ("invitation_id") WHERE status IN ('pending','processing','retry');--> statement-breakpoint
CREATE INDEX "invitation_deliveries_due_idx" ON "invitation_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "invitation_deliveries_invitation_idx" ON "invitation_deliveries" USING btree ("invitation_id","created_at");
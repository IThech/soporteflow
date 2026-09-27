-- 5.4V-B: outbound webhooks (mirror of src/lib/server/db/schema/webhooks.ts, permissions.ts and
-- role-templates.ts). Subscriptions per organization, AES-256-GCM encrypted versioned signing
-- secrets (never plaintext), and delivery intents created in the domain transaction.
-- Permissions webhooks:view / webhooks:manage for organization_admin only.
-- Additive and idempotent; no subscription or delivery is created here.
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"target_url" text NOT NULL,
	"secret_version" integer NOT NULL,
	"body" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"lease_token" uuid,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_status_code" integer,
	"last_error_code" varchar(40),
	"response_time_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_subscription_event_unique" UNIQUE("subscription_id","event_id"),
	CONSTRAINT "webhook_deliveries_status_check" CHECK ("webhook_deliveries"."status" IN ('pending', 'processing', 'sent', 'retry', 'failed')),
	CONSTRAINT "webhook_deliveries_event_type_check" CHECK ("webhook_deliveries"."event_type" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
	CONSTRAINT "webhook_deliveries_target_url_check" CHECK (length("webhook_deliveries"."target_url") BETWEEN 9 AND 2048 AND "webhook_deliveries"."target_url" LIKE 'https://%'),
	CONSTRAINT "webhook_deliveries_body_check" CHECK (octet_length("webhook_deliveries"."body") BETWEEN 2 AND 32768),
	CONSTRAINT "webhook_deliveries_attempt_count_check" CHECK ("webhook_deliveries"."attempt_count" BETWEEN 0 AND 10),
	CONSTRAINT "webhook_deliveries_status_code_check" CHECK ("webhook_deliveries"."last_status_code" IS NULL OR "webhook_deliveries"."last_status_code" BETWEEN 100 AND 599),
	CONSTRAINT "webhook_deliveries_response_time_check" CHECK ("webhook_deliveries"."response_time_ms" IS NULL OR "webhook_deliveries"."response_time_ms" >= 0),
	CONSTRAINT "webhook_deliveries_error_code_check" CHECK ("webhook_deliveries"."last_error_code" IS NULL OR "webhook_deliveries"."last_error_code" IN ('DNS_RESOLUTION_FAILED', 'SSRF_BLOCKED', 'INVALID_TARGET', 'TIMEOUT', 'CONNECTION_FAILED', 'TLS_ERROR', 'REDIRECT_NOT_ALLOWED', 'HTTP_4XX', 'HTTP_5XX', 'RATE_LIMITED', 'INVALID_RESPONSE', 'CONFIGURATION_ERROR', 'SUBSCRIPTION_INACTIVE', 'MAX_ATTEMPTS')),
	CONSTRAINT "webhook_deliveries_state_check" CHECK (("webhook_deliveries"."status" IN ('pending', 'retry', 'processing')) = ("webhook_deliveries"."next_attempt_at" IS NOT NULL) AND ("webhook_deliveries"."status" = 'processing') = ("webhook_deliveries"."lease_token" IS NOT NULL) AND ("webhook_deliveries"."status" = 'sent') = ("webhook_deliveries"."delivered_at" IS NOT NULL) AND ("webhook_deliveries"."status" = 'failed') = ("webhook_deliveries"."failed_at" IS NOT NULL) AND ("webhook_deliveries"."status" <> 'failed' OR "webhook_deliveries"."last_error_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_secrets" (
	"subscription_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" varchar(32) NOT NULL,
	"auth_tag" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_secrets_pkey" PRIMARY KEY("subscription_id","version"),
	CONSTRAINT "webhook_secrets_version_check" CHECK ("webhook_secrets"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"target_url" text NOT NULL,
	"event_types" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"current_secret_version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_subscriptions_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "webhook_subscriptions_name_check" CHECK (length(btrim("webhook_subscriptions"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "webhook_subscriptions_target_url_check" CHECK (length("webhook_subscriptions"."target_url") BETWEEN 9 AND 2048 AND "webhook_subscriptions"."target_url" LIKE 'https://%'),
	CONSTRAINT "webhook_subscriptions_event_types_check" CHECK (jsonb_typeof("webhook_subscriptions"."event_types") = 'array' AND jsonb_array_length("webhook_subscriptions"."event_types") BETWEEN 1 AND 50),
	CONSTRAINT "webhook_subscriptions_secret_version_check" CHECK ("webhook_subscriptions"."current_secret_version" >= 1)
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_deliveries_subscription_fk') THEN
		ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_fk" FOREIGN KEY ("subscription_id","organization_id") REFERENCES "public"."webhook_subscriptions"("id","organization_id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_deliveries_secret_fk') THEN
		ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_secret_fk" FOREIGN KEY ("subscription_id","secret_version") REFERENCES "public"."webhook_secrets"("subscription_id","version") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_deliveries_event_fk') THEN
		ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_fk" FOREIGN KEY ("event_id") REFERENCES "public"."automation_events"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_secrets_subscription_fk') THEN
		ALTER TABLE "webhook_secrets" ADD CONSTRAINT "webhook_secrets_subscription_fk" FOREIGN KEY ("subscription_id","organization_id") REFERENCES "public"."webhook_subscriptions"("id","organization_id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_subscriptions_organization_fk') THEN
		ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_subscriptions_created_by_fk') THEN
		ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_created_by_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at","id") WHERE "webhook_deliveries"."status" IN ('pending', 'retry', 'processing');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_subscription_idx" ON "webhook_deliveries" USING btree ("organization_id","subscription_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_terminal_idx" ON "webhook_deliveries" USING btree ("updated_at") WHERE "webhook_deliveries"."status" IN ('sent', 'failed');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_subscriptions_org_idx" ON "webhook_subscriptions" USING btree ("organization_id","active");
--> statement-breakpoint
-- Catalog (same conflict strategy as 0017: metadata refreshed, scopes only ever narrowed).
INSERT INTO "permissions" ("id", "name", "description", "category", "allowed_scope_types") VALUES
	('webhooks:view', 'Ver webhooks', 'Consultar los webhooks salientes de la organización y su historial de entregas.', 'webhooks', ARRAY['organization']::varchar(50)[]),
	('webhooks:manage', 'Gestionar webhooks', 'Crear, modificar, desactivar webhooks salientes y rotar sus secretos de firma.', 'webhooks', ARRAY['organization']::varchar(50)[])
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
	('tpl_organization_admin', 'webhooks:view'),
	('tpl_organization_admin', 'webhooks:manage')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Existing system roles only (custom roles are never modified).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", v."permission_id"
FROM "roles" r
JOIN (VALUES
	('tpl_organization_admin', 'webhooks:view'),
	('tpl_organization_admin', 'webhooks:manage')
) AS v("template_id", "permission_id") ON v."template_id" = r."template_id"
WHERE r."is_custom" = false
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

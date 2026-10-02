ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "code" varchar(50);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "address" varchar(255);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "city" varchar(100);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "postal_code" varchar(20);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "country" varchar(100);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sites_org_code_idx" ON "sites" USING btree ("organization_id","code");

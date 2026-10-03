CREATE TABLE IF NOT EXISTS "subcategories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subcategories_cat_name_unique" UNIQUE("category_id","name"),
	CONSTRAINT "subcategories_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "subcategories_id_cat_org_unique" UNIQUE("id","category_id","organization_id"),
	CONSTRAINT "subcategories_name_check" CHECK (btrim("subcategories"."name") <> '')
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subcategories_organization_id_organizations_id_fk') THEN
		ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subcategories_category_org_fk') THEN
		ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_category_org_fk" FOREIGN KEY ("category_id","organization_id") REFERENCES "public"."categories"("id","organization_id") ON DELETE restrict ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subcategories_cat_normalized_name_unique_idx" ON "subcategories" USING btree ("category_id",lower(regexp_replace(btrim("name"), '\s+', ' ', 'g')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subcategories_org_cat_idx" ON "subcategories" USING btree ("organization_id","category_id");
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "subcategory_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incidents_subcategory_cat_org_fk') THEN
		ALTER TABLE "incidents" ADD CONSTRAINT "incidents_subcategory_cat_org_fk" FOREIGN KEY ("subcategory_id","category_id","organization_id") REFERENCES "public"."subcategories"("id","category_id","organization_id") ON DELETE restrict ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incidents_subcategory_requires_category_check') THEN
		ALTER TABLE "incidents" ADD CONSTRAINT "incidents_subcategory_requires_category_check" CHECK ("subcategory_id" IS NULL OR "category_id" IS NOT NULL);
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incidents_org_subcategory_id_idx" ON "incidents" USING btree ("organization_id","subcategory_id");

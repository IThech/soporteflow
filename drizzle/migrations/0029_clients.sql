CREATE TABLE IF NOT EXISTS "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_org_name_unique" UNIQUE("organization_id","name"),
	CONSTRAINT "clients_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "clients_name_check" CHECK (btrim("clients"."name") <> '')
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_organization_id_organizations_id_fk') THEN
		ALTER TABLE "clients" ADD CONSTRAINT "clients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "clients_org_normalized_name_unique_idx" ON "clients" USING btree ("organization_id",lower(regexp_replace(btrim("name"), '\s+', ' ', 'g')));
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "client_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incidents_client_org_fk') THEN
		ALTER TABLE "incidents" ADD CONSTRAINT "incidents_client_org_fk" FOREIGN KEY ("client_id","organization_id") REFERENCES "public"."clients"("id","organization_id") ON DELETE restrict ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incidents_org_client_id_idx" ON "incidents" USING btree ("organization_id","client_id");
--> statement-breakpoint
INSERT INTO "permissions" ("id", "name", "description", "category", "allowed_scope_types") VALUES
	('clients:view', 'Ver clientes', 'Consultar el catálogo de clientes de la organización.', 'clients', ARRAY['organization']::varchar(50)[]),
	('clients:manage', 'Gestionar clientes', 'Crear, editar, activar y desactivar clientes.', 'clients', ARRAY['organization']::varchar(50)[])
ON CONFLICT ("id") DO UPDATE SET
	"name" = EXCLUDED."name",
	"description" = EXCLUDED."description",
	"category" = EXCLUDED."category",
	"allowed_scope_types" = ARRAY(
		SELECT scope FROM unnest(EXCLUDED."allowed_scope_types") AS scope
		WHERE scope = ANY ("permissions"."allowed_scope_types")
	)::varchar(50)[];
--> statement-breakpoint
INSERT INTO "role_template_permissions" ("role_template_id", "permission_id") VALUES
	('tpl_organization_admin', 'clients:view'),
	('tpl_organization_admin', 'clients:manage'),
	('tpl_technician', 'clients:view')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", v."permission_id"
FROM "roles" r
JOIN (VALUES
	('tpl_organization_admin', 'clients:view'),
	('tpl_organization_admin', 'clients:manage'),
	('tpl_technician', 'clients:view')
) AS v("template_id", "permission_id") ON v."template_id" = r."template_id"
WHERE r."is_custom" = false
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

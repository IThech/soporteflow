ALTER TABLE "incidents" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_team_org_fk" FOREIGN KEY ("team_id","organization_id") REFERENCES "public"."teams"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incidents_org_team_idx" ON "incidents" USING btree ("organization_id","team_id");
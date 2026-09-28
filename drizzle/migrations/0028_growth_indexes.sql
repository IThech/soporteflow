CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "incidents_org_assignee_created_idx" ON "incidents" USING btree ("organization_id","assigned_to_user_id","created_at");--> statement-breakpoint
CREATE INDEX "incidents_org_client_created_idx" ON "incidents" USING btree ("organization_id","client_user_id","created_at");
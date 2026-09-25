ALTER TABLE "incident_history" DROP CONSTRAINT "incident_history_event_type_check";--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_category_org_fk" FOREIGN KEY ("category_id","organization_id") REFERENCES "public"."categories"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incidents_org_category_idx" ON "incidents" USING btree ("organization_id","category_id");--> statement-breakpoint
ALTER TABLE "incident_history" ADD CONSTRAINT "incident_history_event_type_check" CHECK ("incident_history"."event_type" IN (
				'created', 'status_changed', 'priority_changed', 'assigned',
				'reassigned', 'escalated', 'site_changed', 'resolved',
				'resolution_accepted', 'resolution_rejected', 'closed',
				'reopened', 'reclassified', 'priority_override_applied',
				'priority_override_modified', 'priority_override_removed',
				'internal_note_added', 'support_level_changed', 'category_changed'
			));
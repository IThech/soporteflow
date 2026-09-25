ALTER TABLE "incident_history" DROP CONSTRAINT "incident_history_event_type_check";--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "support_level" varchar(10) DEFAULT 'N1' NOT NULL;--> statement-breakpoint
CREATE INDEX "incidents_org_support_level_idx" ON "incidents" USING btree ("organization_id","support_level");--> statement-breakpoint
ALTER TABLE "incident_history" ADD CONSTRAINT "incident_history_event_type_check" CHECK ("incident_history"."event_type" IN (
				'created', 'status_changed', 'priority_changed', 'assigned',
				'reassigned', 'escalated', 'site_changed', 'resolved',
				'resolution_accepted', 'resolution_rejected', 'closed',
				'reopened', 'reclassified', 'priority_override_applied',
				'priority_override_modified', 'priority_override_removed',
				'internal_note_added', 'support_level_changed'
			));--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_support_level_check" CHECK ("incidents"."support_level" IN ('N1', 'N2', 'N3'));
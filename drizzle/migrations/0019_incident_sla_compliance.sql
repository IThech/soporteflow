-- 5.4T-C: SLA compliance core (mirror of src/lib/server/db/schema/incidents.ts).
-- Compliance/breach is DERIVED (deadlines + first_response_at + first_resolved_at + now); no
-- breach flags are stored and no worker exists. Additive and idempotent.
--
-- 1) first_resolved_at: first time the incident entered resolved (or closed). Existing incidents
--    are backfilled from their real audit trail (earliest 'resolved'/'closed' history event);
--    nothing is invented for incidents without such an event.
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "first_resolved_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "incidents" i
SET "first_resolved_at" = h."first_at"
FROM (
	SELECT "incident_id", "organization_id", min("created_at") AS "first_at"
	FROM "incident_history"
	WHERE "event_type" IN ('resolved', 'closed')
	GROUP BY "incident_id", "organization_id"
) h
WHERE h."incident_id" = i."id" AND h."organization_id" = i."organization_id" AND i."first_resolved_at" IS NULL;
--> statement-breakpoint
-- 2) SLA audit events (applied / changed / cleared / first response and resolution results).
ALTER TABLE "incident_history" DROP CONSTRAINT IF EXISTS "incident_history_event_type_check";
--> statement-breakpoint
ALTER TABLE "incident_history" ADD CONSTRAINT "incident_history_event_type_check" CHECK ("incident_history"."event_type" IN (
				'created', 'status_changed', 'priority_changed', 'assigned',
				'reassigned', 'escalated', 'site_changed', 'resolved',
				'resolution_accepted', 'resolution_rejected', 'closed',
				'reopened', 'reclassified', 'priority_override_applied',
				'priority_override_modified', 'priority_override_removed',
				'internal_note_added', 'support_level_changed', 'category_changed',
				'sla_applied', 'sla_changed', 'sla_cleared',
				'sla_first_response_met', 'sla_first_response_breached',
				'sla_resolution_met', 'sla_resolution_breached'
			));

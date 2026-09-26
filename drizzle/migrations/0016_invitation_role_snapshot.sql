-- 5.4S-D: permission snapshot of the invited role (mirror of src/lib/server/db/schema/auth.ts).
-- Acceptance requires the role's current permissions to be a subset of this snapshot, so a role
-- widened after the invitation was issued can never be granted through it (the admin must resend,
-- which re-checks delegation and re-snapshots). Additive and idempotent; the '{}' default is
-- fail-closed. Existing invitations are backfilled with their role's current permissions (the
-- state they were delegated against, or narrower).
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "role_permission_ids" varchar(100)[] DEFAULT '{}'::varchar(100)[] NOT NULL;
--> statement-breakpoint
UPDATE "invitations" i
SET "role_permission_ids" = COALESCE(
	(SELECT array_agg(rp."permission_id" ORDER BY rp."permission_id")::varchar(100)[]
	 FROM "role_permissions" rp WHERE rp."role_id" = i."role_id"),
	'{}'::varchar(100)[]
)
WHERE i."role_permission_ids" = '{}'::varchar(100)[];

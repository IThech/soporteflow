# Notification Core — 5.4U-A

## Scope and authorization

This is a personal inbox within an organization, not a domain audit log. Existing demo notifications
remain independent. No notifications:* capability, role-code authorization, automatic event
generation, preferences, UI, email delivery, outbox or scheduler is added.

HTTP identity is resolved from the authenticated session. recipientUserId is never accepted from
query/body. The service rechecks users.active, memberships.active and organizations.status=active
inside each transaction, locking those rows FOR SHARE. Every notification query and mutation
contains both organizationId and recipientUserId. The composite FK targets memberships(org,user).
Deleting a membership cascades only its ephemeral inbox rows, never the reverse.

These locks coordinate with ordinary updates to those rows; real independent-connection
PostgreSQL contention has not been tested in U-A. Session resolution precedes the transaction:
this does not claim atomic session revocation across an entire request.

## Storage and producer boundary

Migration 0020 adds notifications only: UUID PK, organization/recipient IDs, type (80), title (160),
message (2000), nullable JSONB payload, nullable readAt, createdAt and updatedAt. There are two
secondary indexes: recipient + createdAt/id DESC, and a partial unread index per recipient.
No actor/entity/dedupKey fields are added before actual event contracts need them.

createNotification(db,input) is server-only infrastructure with no public POST. Type is validated
lowercase segments separated by dot/underscore/hyphen, not a placeholder database enum/catalog.
Title/message are trimmed bounded plain text, never HTML. Future renderers must escape them.

Payload is private metadata, OMITTED from every DTO in U-A. It must be a plain JSON object or null,
with bounded nesting/nodes, no cycles/getters/nonfinite numbers/undefined or credential-like keys.
Producer serialization max 4096 UTF-8 bytes; DB canonical JSONB text max 8192 bytes. This validation
cannot detect secrets hidden inside innocent string values: trusted producers must not pass
credentials, tokens, internal exceptions or sensitive content in any field. U-C must define typed
allowlists before any payload metadata is exposed. No client creation endpoint exists.

## State and removal

PATCH {read:true} sets readAt only on unread rows; repeated marking preserves readAt and updatedAt.
PATCH {read:false} clears readAt; repeated unread marking preserves updatedAt.
Read-all updates only currently unread rows of that user/organization.
DELETE is physical removal, independent of read state. Delete-one returns 204, repeat/missing/foreign
resource returns 404. Bulk clear requires explicit scope=read or scope=all and returns 204.
Notifications are not incident_history; no audit events are changed or emitted.
Retention jobs and external delivery semantics remain U-D.

## HTTP contract

All organization IDs are UUID query parameters. Unknown/duplicate query parameters and unknown
body fields are rejected. Mutation requests require matching Origin; PATCH/read-all use strict
application/json with a body capped at 256 bytes. Responses are private, no-store.

- GET /api/notifications?organizationId=...&status=read|unread&limit=...&cursor=...
- GET /api/notifications/[id]?organizationId=...
- PATCH /api/notifications/[id]?organizationId=... body {read:boolean}
- DELETE /api/notifications/[id]?organizationId=...
- POST /api/notifications/read-all?organizationId=... body {}
- DELETE /api/notifications?organizationId=...&scope=read|all
- GET /api/notifications/unread-count?organizationId=...

List: {items,nextCursor}; item/read: {notification}; count: {unreadCount}; mutations without DTO: 204.
401 invalid session; 403 inactive/missing membership or nonoperational organization; 404 inaccessible
notification within an authorized tenant; 400 malformed input; 500 generic internal failure.
An unauthorized organization returns 403; a foreign notification ID under an authorized org returns 404.

DTO: id,type,title,message,readAt,createdAt,updatedAt. No organizationId, recipientUserId or payload.
Client helper parsers return explicit fields and discard extras; no storage, redirects or UI.

## Pagination and concurrency limits

Default 50, max100, min1. DESC(createdAt,id) keyset pagination, microsecond timestamps retained.
Cursor is canonical base64url of timestamp+notification id, treated as opaque by callers. It is not
a credential or authorization token. No arbitrary sort/type filter in U-A.
Stable ties do not cause duplicates or skips for unchanged data. Concurrent deletes, newly inserted
rows and read-filter changes naturally alter subsequent pages; this is not a snapshot export.
Count is a separate scoped query and need not match a list fetched at a different instant.

## Validation and follow-up

Migration execution is tested only in PGlite; generating 0020 does not apply it to soporteflow_dev.
Migration idempotence means journal-managed Drizzle re-run, not raw CREATE TABLE replay.
U-B: preferences. U-C: typed event producers and possible deduplication. U-D: delivery/outbox,
retries and configurable retention. None is implemented here.

# Notification preferences and recipient rules — 5.4U-B

## Event catalog

`src/lib/notifications/events.ts` (shared by server and client, no imports) defines the canonical
event types used by preferences and recipient rules. `notifications.type` in the database stays
extensible; this catalog does not become a DB enum.

| Event type                      | Recipients (before actor exclusion, activity and preferences)        |
| ------------------------------- | -------------------------------------------------------------------- |
| `incident.assigned`             | current assignee                                                     |
| `incident.unassigned`           | previous assignee (passed by the producer, must be an active member) |
| `incident.status_changed`       | requester (`client_user_id`) + assignee                              |
| `incident.reopened`             | requester + assignee                                                 |
| `incident.public_comment_added` | author is the requester: assignee; otherwise: requester              |
| `sla.first_response_breached`   | assignee only                                                        |
| `sla.resolution_breached`       | assignee only                                                        |

Deliberately not catalogued yet: `incident.created`, priority/category/site/support-level changes
(no clear audience or too noisy for Core v1).

## Preferences

Table `notification_preferences` (migration 0021): PK (organization_id, user_id, event_type),
`in_app_enabled boolean NOT NULL`, timestamps, composite FK (organization_id, user_id) →
memberships ON DELETE CASCADE. Rows are overrides: a missing row means the catalog default
(**every event enabled in-app**). Both `true` and `false` overrides are stored explicitly.
No email/push flags (U-D).

Personal resource like the inbox: no `notifications:*` capability, no role codes, no admin editing
of other users. Session + active user + active membership + active organization (rows FOR SHARE).
Preferences are per (organization, user): muting an event in one organization never affects another.

HTTP (responses `private, no-store`; mutations require matching Origin; JSON body ≤ 256 bytes):

- `GET /api/notification-preferences?organizationId=` → `{ preferences: [{ eventType, inAppEnabled, isDefault }] }`
  for every catalogued event, in catalog order (`isDefault: true` = no override stored).
- `PUT /api/notification-preferences/<eventType>?organizationId=` body exactly `{ inAppEnabled: boolean }`
  → upsert, idempotent (`updated_at` only moves when the value changes) → `{ preference }`.
- `DELETE /api/notification-preferences/<eventType>?organizationId=` (no body) → removes the override,
  idempotent 204.

Unknown event types, extra body/query fields or any user id are rejected with 400.

## Recipient rules

`src/lib/server/services/notification-recipients.ts`:

- `resolveCandidateRecipients(db, event)`: reads the incident by (incidentId, organizationId) —
  relationships are never trusted from the caller except the previous assignee of an unassignment —
  applies the rule, removes the actor, dedupes and sorts.
- `resolveNotificationRecipients(db, event)`: candidates → active user + active membership + active
  organization (one query) → enabled preference (one batched query,
  `filterUsersWithNotificationEnabled`) → sorted user ids. Constant query count.

Self-notification policy: the actor of an action is never notified (self-assignment, own comment,
own status change, own unassignment). Time-based SLA breaches have no actor. SLA breaches go only
to the assignee (no admin broadcast, no team/escalation fallback yet).

## Boundaries

U-B creates no notifications: nothing calls the resolver or `createNotification` from incidents,
comments, SLA, history or invitations. U-C will connect domain events → resolver → notification
producer (and decide deduplication). U-D: email/push, outbox, retries, digests, retention.

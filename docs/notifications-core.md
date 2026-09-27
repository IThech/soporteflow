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

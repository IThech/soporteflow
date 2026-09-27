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
No email/push flags in U-B (email added by U-D, see below).

Personal resource like the inbox: no `notifications:*` capability, no role codes, no admin editing
of other users. Session + active user + active membership + active organization (rows FOR SHARE).
Preferences are per (organization, user): muting an event in one organization never affects another.

HTTP as shipped in U-B (the body/DTO contract is superseded by the per-channel contract in U-D below;
responses `private, no-store`; mutations require matching Origin; JSON body ≤ 256 bytes):

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

U-B created no notifications (superseded by U-C below): nothing called the resolver or `createNotification` from incidents,
comments, SLA, history or invitations. U-C will connect domain events → resolver → notification
producer (and decide deduplication). U-D: email/push, outbox, retries, digests, retention.

# Domain notification generation — 5.4U-C

## Producer

`src/lib/server/services/notification-producer.ts` → `produceDomainNotification(tx, event)` is the
only bridge between domain services and the notification subsystem:

event → `resolveNotificationRecipients` (U-B rules) → centralized title/message/payload →
`createNotification` per recipient → `{ created }`.

- Runs on the caller's `dbOrTx` (the domain mutation's transaction). It never catches: if the
  recipient lookup or any insert fails, the whole domain mutation rolls back (incident row, history,
  message, first response, SLA events).
- `notification.type` is exactly the event type.
- Texts are fixed Spanish strings that only interpolate the incident number (`#<incidentNumber>`):
  never the incident title, comment bodies, names or emails.
- Invalid events, unknown or `sla.*` event types and incidents outside the tenant are rejected
  (`NotificationProducerError`) before anything is written.

| Event                           | Title                            | Payload                                             |
| ------------------------------- | -------------------------------- | --------------------------------------------------- |
| `incident.assigned`             | Incidencia asignada              | `{ incidentId }`                                    |
| `incident.unassigned`           | Incidencia desasignada           | `{ incidentId }`                                    |
| `incident.status_changed`       | Estado de incidencia actualizado | `{ incidentId, previousStatus, newStatus }`         |
| `incident.reopened`             | Incidencia reabierta             | `{ incidentId, previousStatus, newStatus: 'open' }` |
| `incident.public_comment_added` | Nuevo comentario                 | `{ incidentId, commentId }`                         |

The payload stays internal (never in the inbox DTO).

## Domain wiring

- `assignIncidentRecord`: after the update and its history row. The previous assignee comes from
  the locked incident row, never from the request. `null → B`: `assigned(B)`; `A → null`:
  `unassigned(A)`; `A → B`: `unassigned(A)` + `assigned(B)`. Team-only changes and no-ops emit nothing.
- `updateIncidentRecord`: `resolved|closed → open` emits only `incident.reopened`; every other
  status change emits `incident.status_changed`. Priority-only changes and no-ops emit nothing.
- Public comments (`appendMessage`, visibility `public`): after the comment, first response and SLA
  first-response history. Requester writes → assignee; anyone else → requester. Internal notes
  never notify.

The actor is always excluded; disabled preferences and inactive members simply yield
`created: 0` without affecting the mutation. No `notification_sent` history event and no
notification data in incident DTOs.

## Not produced / pending

- `sla.first_response_breached` and `sla.resolution_breached` are catalogued but not produced:
  breaches are time-based and there is no worker/cron/scheduler. Pending a later stage.
- No email in U-C (added by U-D below); no push, generic outbox or deduplication across events.
- Real multi-connection concurrency is validated in 5.4W (PGlite is single-connection).

Boundary tests enforce that domain services import only `./notification-producer` and never call
`createNotification` or the recipient resolver directly.

# Email delivery — 5.4U-D

## Architecture

```
domain transaction ─┬─ in-app row (createNotification)          ← in-app ON
                    └─ delivery intent (notification_deliveries) ← email ON
COMMIT
processDueNotificationDeliveries (later, outside the domain tx)
  claim (short tx) → send (no tx) → sent | retry | failed (lease-guarded update)
```

- In-app stays the primary, local channel. Email is sent only by the processor, never inside a
  domain transaction: no network call can roll back or block a domain mutation.
- The intent is persisted atomically with the domain change. If inserting it fails (DB error),
  the whole mutation rolls back, in-app notification included — the intent was part of the
  mutation. If the _send_ fails later, only the delivery row changes.
- `notification_deliveries` is a notification-scoped outbox, deliberately not a generic outbox or
  job system (automation/webhooks belong to 5.4V).

## Email preferences

- `notification_preferences.email_enabled` (migration 0022). `in_app_enabled` became nullable:
  each column is an independent per-channel override, `NULL` = catalog default.
- Defaults: in-app **ON**, email **OFF** for every event, so existing users never start receiving
  unexpected email. Existing rows keep their in-app override and get `email_enabled = NULL`.
- A row always overrides at least one channel (`notification_preferences_override_check`); when
  both become default the row is deleted, so "no row" = "all defaults".
- DTO: `{ eventType, inAppEnabled, emailEnabled, inAppIsDefault, emailIsDefault }` (the U-B global
  `isDefault` was ambiguous with two channels and was replaced).
- `PUT /api/notification-preferences/<eventType>` body: strict subset of
  `{ inAppEnabled: boolean | null, emailEnabled: boolean | null }`, at least one key. Only the
  channels present change; `null` resets that channel. `DELETE` resets both channels (204).

## Channel independence

Recipient rules (relationship, actor exclusion, active membership) run once, before channels
(`resolveNotificationRecipientChannels`). Then each channel applies its own preference:

| in-app | email | Result                                                        |
| ------ | ----- | ------------------------------------------------------------- |
| ON     | OFF   | inbox row only (default)                                      |
| ON     | ON    | inbox row + delivery (`notification_id` references the row)   |
| OFF    | ON    | delivery only, `notification_id = NULL` — no hidden inbox row |
| OFF    | OFF   | nothing; the domain mutation still completes                  |

## Delivery model

`notification_deliveries`: `organization_id`, `recipient_user_id` (composite FK to memberships,
cascade), `notification_id` (nullable, `ON DELETE SET NULL`), `channel` (`CHECK IN ('email')`),
snapshot `event_type` / `title` / `message`, `status`, `attempt_count`, `next_attempt_at`,
`lease_token`, `last_attempt_at`, `sent_at`, `failed_at`, `last_error_code` (CHECK-listed safe codes),
`provider_message_id`, timestamps.

- Self-contained snapshot: sending does not depend on the inbox row, so deleting an in-app
  notification never breaks a pending email and never erases delivery history.
- No recipient address snapshot and no raw provider response are stored. The address is read at
  send time from `auth_users.email` (the sign-in identity: unique, normalized); it never comes from
  a client or payload. `email_verified` is not required yet (provisioned accounts start
  unverified); tightening it is 5.4W debt.
- `notification_deliveries_state_check` ties status to its columns: `next_attempt_at` set exactly
  for pending/retry/processing, `lease_token` exactly for processing, `sent_at` for sent,
  `failed_at` + error code for failed.
- Indexes: due rows (`next_attempt_at, id` partial on pending/retry/processing), per recipient
  (`organization_id, recipient_user_id, created_at`), retention (`updated_at` partial on sent/failed).

Statuses: `pending → processing → sent | retry | failed`, `retry → processing → …`.

## Processor, claim and retries

- `processDueNotificationDeliveries(db, { limit = 25 (max 100), now, sender })` is the entry point
  for a future scheduler. No cron, interval or worker is created here.
- `claimDueDeliveries`: one short transaction, `FOR UPDATE SKIP LOCKED`, sets `processing`, a new
  `lease_token`, `attempt_count + 1` and `next_attempt_at = now + 5 min` (lease expiry). An
  abandoned claim becomes due again after the lease; one already at the attempt limit is closed
  as `MAX_ATTEMPTS`.
- Outcome updates (`markDeliverySent/Retry/Failed`) require the current lease token: a stale
  worker cannot overwrite a newer result, and a finished row cannot be marked twice.
- Retry policy (transient errors): 1 min, 5 min, 30 min, 2 h; the 5th failed attempt is final
  (`failed`, `MAX_ATTEMPTS`). Deterministic with the injected `now`.
- Error classification: transient `NETWORK_ERROR`, `RATE_LIMITED`, `PROVIDER_ERROR` (5xx or any
  unknown thrown value); permanent `PROVIDER_NOT_CONFIGURED`, `RECIPIENT_INVALID` (adapter
  rejection, missing or malformed address), `RECIPIENT_INACTIVE` (membership/user/organization
  inactive at send time). Only the code is persisted, never messages or stacks.
- Semantics are at-least-once: a crash after the provider accepted a message but before it was
  marked sent resends after the lease. Exactly-once needs provider idempotency keys (5.4W).
- Real multi-connection claim concurrency is not proven on PGlite (single connection) — 5.4W.

## Email adapter and content

`src/lib/server/email/notification-email.ts`, same pattern as invitations:
`NotificationEmailSender`, `UnconfiguredNotificationEmailSender` (default; fails with
`PROVIDER_NOT_CONFIGURED`), `MemoryNotificationEmailSender` (tests), `NotificationEmailError(code)`.
No provider is coupled. Messages are text/plain: subject = title with control characters (CR/LF)
collapsed, body = message. Both are the fixed producer texts (`#<incidentNumber>` only): no
comment bodies, incident titles, names or HTML. Nothing is logged.

## Retention

`deleteOldNotificationDeliveries(db, { before })` deletes `sent`/`failed` rows last updated before
the cutoff; pending/retry/processing rows are never deleted. No scheduler invokes it yet. Inbox
retention is separate (manual clear from U-A); U-D never deletes inbox notifications.

## Boundaries

- No public delivery API or UI; deliveries are internal (services and tests only).
- No webhooks, HMAC, target URLs, n8n or automation rules (5.4V). No push/SMS/chat channels.
- SLA breach events stay catalogued but not produced: they are time-based and need a scheduler,
  which belongs with 5.4V automation. The producer rejects `sla.*`.
- 5.4V: scheduler invoking the processor and retention, SLA breach producer, webhooks/automation.
- 5.4W: real two-connection claim concurrency, provider idempotency keys, `email_verified`
  policy, global event idempotency/deduplication.

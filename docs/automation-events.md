# Automation events — 5.4V-A

Canonical, durable, tenant-scoped record of **facts that happened in the domain**, written by the
domain mutation itself. It separates "something happened" from "who reacts to it": future
outbound webhooks (V-B), automation rules (V-C) and n8n (V-D) will consume these events; none of
them exists yet.

```
domain mutation (one transaction)
  ├─ domain state (incidents, messages …)
  ├─ incident_history (audit)
  ├─ automation_events (this layer)        ← automation-event-producer
  ├─ notifications / email intents         ← notification-producer (sibling, independent)
COMMIT
future consumers (V-B/V-C/V-D) read automation_events
```

## Not event sourcing

- `incidents` and the other domain tables remain the **source of truth**; nothing is rebuilt
  from events.
- `incident_history` remains the incident-specific audit trail (reasons, UI timeline).
- `automation_events` are **derived integration events**: a stable, versioned contract for
  integrations. They never replace either of the above.

## Table `automation_events` (migration 0023)

| Column                            | Notes                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `id` uuid PK                      | Generated once. Public event id for webhooks, idempotency and n8n dedup. Never a history id. |
| `position` bigint identity        | Global, strictly increasing order; cursor for consumers.                                     |
| `organization_id`                 | FK organizations (cascade). Always the incident's organization, read from the DB row.        |
| `event_type`                      | varchar + dotted-slug CHECK (no DB enum). Catalog validated server-side.                     |
| `schema_version`                  | integer ≥ 1, default 1.                                                                      |
| `aggregate_type` / `aggregate_id` | `incident` + incident id (no FK: the fact outlives the row).                                 |
| `actor_user_id`                   | FK **users** (global) ON DELETE SET NULL; null reserved for system/time events.              |
| `payload`                         | jsonb object, ≤ 8 KB (CHECK).                                                                |
| `occurred_at`                     | Mutation timestamp (shared by all events of one mutation).                                   |
| `created_at`                      | Insert time.                                                                                 |

Indexes: `(organization_id, position)`, `(organization_id, aggregate_type, aggregate_id, position)`.

**Append-only**: no update/delete service exists, and a `BEFORE UPDATE` trigger rejects any
change except the FK action that nulls `actor_user_id` when a user row is deleted. Rows are only
removed with their organization (cascade). Retention is out of scope for V-A.

## Envelope

`AutomationEventEnvelope` (`src/lib/automation/events.ts`):

```ts
{
	(id,
		organizationId,
		eventType,
		schemaVersion,
		aggregateType,
		aggregateId,
		actorUserId,
		occurredAt /* ISO */,
		payload);
}
```

V-B can send exactly this without reading the incident again.

## Catalog (schemaVersion 1)

Separate from the notification catalog: notifications are a user-facing, preference-filtered
selection; automation events are domain facts and are **never** affected by notification
preferences.

Every payload includes `incidentId` and `incidentNumber`.

| Event                                  | Extra payload                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `incident.created`                     | `status, priority, supportLevel, requesterUserId, categoryId, siteId, slaPolicyId` |
| `incident.assigned`                    | `previousAssigneeUserId (nullable), assignedToUserId`                              |
| `incident.unassigned`                  | `previousAssigneeUserId`                                                           |
| `incident.team_changed`                | `previousTeamId, newTeamId`                                                        |
| `incident.status_changed`              | `previousStatus, newStatus`                                                        |
| `incident.reopened`                    | `previousStatus ('resolved' \| 'closed'), newStatus: 'open'`                       |
| `incident.priority_changed`            | `previousPriority, newPriority`                                                    |
| `incident.category_changed`            | `previousCategoryId, newCategoryId`                                                |
| `incident.site_changed`                | `previousSiteId, newSiteId`                                                        |
| `incident.support_level_changed`       | `previousSupportLevel, newSupportLevel`                                            |
| `incident.public_comment_added`        | `messageId`                                                                        |
| `incident.internal_note_added`         | `messageId`                                                                        |
| `sla.first_response_met` / `_breached` | `slaPolicyId, dueAt, achievedAt, observedBy: 'action'`                             |
| `sla.resolution_met` / `_breached`     | `slaPolicyId, dueAt, achievedAt, observedBy: 'action'`                             |

Privacy: ids and enumerated values only. Never titles, descriptions, client names, message or
note bodies, emails or other free text. Consumers needing details use the incident id through an
authorized API.

Not emitted in V-A: SLA policy changes (`sla_applied/changed/cleared` stay in history only),
invitations/memberships/users/sites/teams aggregates, and anything time-based.

## Semantics

- **No-ops emit nothing** (same assignee, status, priority, category, site, support level; HTTP
  replays that become no-ops). Each new message is a new fact with its own event.
- **One semantic event per status change**: `resolved|closed → open` emits only
  `incident.reopened` (no extra `status_changed`).
- **Assignment order** (deterministic, same `occurredAt`): `incident.team_changed`,
  `incident.unassigned(A)`, `incident.assigned(B, previousAssigneeUserId = A)`. Team-only changes
  emit only `team_changed`. The previous assignee always comes from the locked row.
- Update order: status/reopen, then observed SLA resolution result, then priority. Messages:
  message fact, then observed first-response result.
- **SLA observed vs temporal**: `sla.*` events record the result determined when the objective is
  achieved by an action (first support reply, first resolution), first-write-wins, exactly once,
  mirroring `incident_history`. A breach found this way means "the response arrived late" — it
  is **not** an alert fired at the deadline. Time-based breaches (`observedBy: 'schedule'`) need a
  scheduler and remain pending.

## Transactions

`recordIncidentAutomationEvents(tx, …)` runs on the mutation's transaction, reads the incident by
`(id, organizationId)` (tenant safety, incident number from the DB), validates every fact before
writing, and never catches. If any event insert fails — including the second of a reassignment —
the whole mutation rolls back: domain row, history, earlier events, notifications and email
intents. Conversely a notification or intent failure rolls the events back. No new
`'transaction' in dbOrTx` checks and no nested transactions were added.

Dependency graph: `incidents / incident-messages → automation-event-producer → automation-events`.
`notification-producer` and `automation-event-producer` are siblings; neither imports the other.
Routes never call either producer.

## Internal reads

`listAutomationEventsInternal(db, { organizationId, afterPosition?, limit ≤ 200, aggregateId? })`
and `getAutomationEventInternal(db, { organizationId, id })`. Always scoped to one organization.
No HTTP endpoint.

## Versioning

All V-A events have `schemaVersion = 1`. Stored events are never rewritten; a future contract
change bumps the version for new events and consumers serialize per version.

## Boundaries

- V-A: store, catalog, producer, wiring, tests. Nothing else.
- V-B (done, see [webhooks.md](webhooks.md)): webhook delivery intents are fanned out inside the
  producing transaction (`webhook-fanout`), **not** by scanning `position`, which is not a commit
  order.
- V-C: automation rules, condition evaluation, actions.
- V-D: n8n integration.
- Scheduler: time-based SLA breach events and retention — not created here.
- 5.4W: real multi-connection concurrency (position is assigned at insert time; a consumer
  reading by `position` must tolerate commit-order gaps, to be designed with V-B).

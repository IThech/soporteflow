# Automation rules — 5.4V-C

## Architecture and scope

A domain mutation appends its event and fans out webhook delivery intents and rule execution intents
in the SAME transaction. Rule conditions/actions are never executed inline or from a route.
After commit, an explicit invocation of processAutomationExecutions claims a bounded batch.
There is no scheduler, daemon, interval, manual-run endpoint, external HTTP, email action, inbound
webhook, n8n integration, shell, SQL or JavaScript action. Existing webhook/email processors remain
separate consumers. Automation does not reuse their queues.

Rules apply only to future events. No global position cursor, retrospective scan, or replay is used.
One execution per (ruleId, sourceEventId) is enforced by SQL UNIQUE and conflict-safe fanout.
A rule has one canonical event type, no wildcard. Priority values are low/medium/high/urgent (NOT critical).

## Authority and system actor

automations:view permits reading; automations:manage permits configuring tenant-system actions.
Only organization_admin templates receive them by default. Technician/customer receive neither.
Custom role delegation still uses canonical permission checks: manage is a powerful capability,
not a check of role names, and does not imply global authority.
The creator is provenance only, never the effective execution actor; departure does not stop rules.
Deleted creators are SET NULL. No artificial technical user is created.

A server-only AsyncLocalStorage capability is minted from a processing execution and private lease
under a row lock on an actual Drizzle transaction. It binds that exact transaction object,
organizationId, ruleId, executionId, parent event and depth, and expires when the callback finishes.
HTTP inputs accept no system/actor/transaction fields. Null actor alone confers no authority.
Canonical domain paths accept a null actor ONLY with this capability. Human paths retain their
existing checks. Organization state, incident access/tenant, target activity/membership and normal
domain transition rules are retained. Public comments always require human authors.

incident_history uses actorType=system, actorUserId=NULL, with ruleId/executionId in private payload. Safe HTTP history projections remain unchanged.
incident_messages has explicit author_type (default user). SQL requires:
user => author_user_id NOT NULL; system => author_user_id NULL AND visibility=internal.
Existing rows become user without changing their author. DTO shape is unchanged: system notes
return author.name = Sistema, with no fabricated user. Message text stays literal.
Notifications do not suppress the rule creator as an actor; system actions have no human actor to exclude.
Internal notes never generate public-comment notifications.

## DSL and validation

Rule fields: name (1..120), active, eventType, conditions, actions, sortOrder (-10000..10000).
Strict JSON object; unknown fields rejected. HTTP JSON limit 16 KiB.
Conditions: { all: [{field, operator, value?}] }. Empty all is unconditional.
At most 20 conditions; no nesting or any in this version.
Operators: eq, neq, in, not_in, is_null, is_not_null. Lists contain 1..20 typed values.
Null operators are only valid for nullable fields and have no value member.
No coercion: missing or ill-typed event fields do not match, even for neq/not_in.
Rule targets schemaVersion 1; unknown event versions skip UNSUPPORTED_EVENT_VERSION.

All field paths start with payload. Only these fields exist:

- Every event: incidentId (UUID), incidentNumber (positive integer).
- incident.created: status, priority, supportLevel, requesterUserId?, categoryId?, siteId?, slaPolicyId?.
- incident.assigned: previousAssigneeUserId?, assignedToUserId.
- incident.unassigned: previousAssigneeUserId.
- incident.team_changed: previousTeamId?, newTeamId?.
- incident.status_changed: previousStatus, newStatus.
- incident.reopened: previousStatus resolved/closed, newStatus open.
- incident.priority_changed: previousPriority, newPriority.
- incident.category_changed: previousCategoryId?, newCategoryId?.
- incident.site_changed: previousSiteId?, newSiteId?.
- incident.support_level_changed: previousSupportLevel, newSupportLevel.
- incident.public_comment_added / internal_note_added: messageId.
- All four sla.* observations: slaPolicyId, dueAt, achievedAt, observedBy=action.
  Question marks above indicate nullable UUIDs. Enum and date values are validated by type.
  No arbitrary traversal, regex, templating or expression evaluator.

## Actions

Ordered array, 1..10 actions. Exact allowlist:

- incident.assign_user: userId UUID/null.
- incident.assign_team: teamId UUID/null.
- incident.set_priority: priority enum.
- incident.set_support_level: supportLevel N1/N2/N3.
- incident.set_status: status open/pending/resolved/closed.
- incident.set_category: categoryId UUID/null.
- incident.set_site: siteId UUID/null.
- incident.add_internal_note: text 1..1000 characters, literal, no HTML or template delimiters.

All call canonical services, not raw incident UPDATEs. Assignment retains the existing technician
eligibility/team policy. Invalid/inactive/foreign targets fail at execution. Rules are not promises
that a target will remain eligible. Status changes respect existing transitions/closed read-only rules.
Where a reason is required, the processor supplies the rule and execution IDs as audit provenance.
No-op mutations preserve canonical behavior and emit no events. Notes are append operations, not no-ops.
Normal incident history, notification recipients/preferences, delivery intents, SLA observations and
webhook fanout remain inside the domain transaction.

## Execution lifecycle and snapshots

Two tables: automation_rules and automation_executions; no separate action log.
Fanout copies ruleName, conditions, actions and sortOrder, avoiding pending-rule edit races.
Current active flag is checked under lock: disabling a queued rule skips RULE_INACTIVE.
DELETE means active=false; executions remain. Rule list and execution history are tenant scoped,
paginated by createdAt/id; execution DTO omits snapshots, internal note text and lease tokens.

Claim: FOR UPDATE SKIP LOCKED, random lease token, five minutes, default25/max100.
Claims commit before work. Each execution locks its claim, organization and current rule.
Every action, nested event, downstream intent and succeeded outcome commit in ONE transaction.
Failure rolls all these writes back; only then a separate conditional lease update records a safe failure.
No automatic retries of semantic or internal action failures. Expired abandoned claims can be recovered,
up to three claims. A stale token cannot overwrite a later owner's outcome. A lost commit acknowledgement
cannot turn a committed success into failed because the success clears the lease in the same transaction.
If storing failure itself fails, the processing lease remains recoverable.

Actions run in snapshot order. Claim batches are ordered by createdAt, sortOrder, id.
Multiple workers do not promise a global order of effects across separate executions.
PGlite tests verify rollback and sequential lease recovery, NOT independent PostgreSQL connections,
real deadlocks, connection loss or production exactly-once delivery. Those validations remain required.

## Loop bounds and event metadata

Human events: depth0, no causation/execution IDs.
System events: actor NULL; depth parent+1, causationEventId and automationExecutionId.
At depth >=5, matched intents remain observable but skip MAX_DEPTH_REACHED.
No-op stops simple self-triggering changes. Oscillations and repeated notes stop at depth5.
No per-chain same-rule ban is claimed. Max100 active rules per organization is serialized through
the organization row; max10 actions, max20 conditions, bounded batches limit each step.
These limits bound depth/fanout, not total operational queue volume: high branching can still create
a large backlog. Monitoring/backpressure is future operational work, not an implicit scheduler.

Causation/execution IDs in events deliberately have no FK: immutable provenance survives execution
retention without circular deletion dependencies. Processor derives them from the source row/capability,
never client input. The append-only trigger includes all new fields.
Public webhook schema v1/body is unchanged; metadata remains internal.

## Retention

deleteOldAutomationExecutions is an explicitly invoked bounded service, terminal rows only.
No scheduler. Pending/processing rows cannot be pruned.
Unique deduplication applies while execution rows exist. There is no replay/rescan API; after retention,
manually refanning old events would recreate intents and is unsupported. A future replay feature must
define a durable deduplication/retention policy first. No exactly-once claim across historical replay.

## Migration and operations

0025 creates rules/executions, adds immutable event causation/depth and explicit message author_type,
and seeds the two permissions plus the system admin template/roles. No earlier migration is modified.
SQL ordering creates the event composite UNIQUE before its referencing FK.
Generation and PGlite tests do not apply this migration to the real database.

## V-D / 5.4W boundary

V-D may invoke the processor using separately approved infrastructure; it must not bypass system
capability creation, locks, snapshots or tenant checks. No n8n URL/key/workflow settings are introduced.
Before production scheduling: validate concurrency with independent PostgreSQL connections, decide
monitoring/backpressure and retention windows, review delegation of automations:manage, and plan
deployment/migration and processor operational ownership. No frontend or generic scheduler in V-C.

# Outbound webhooks — 5.4V-B

Organization-scoped outbound webhooks that deliver [automation events](automation-events.md)
to external HTTPS endpoints, signed with HMAC-SHA256, persisted, retried with bounded backoff
and protected against SSRF. No automation rules (V-C), no n8n (V-D), no inbound webhooks, no
scheduler.

```
domain mutation (one transaction)
  ├─ automation_event                     (automation-event-producer)
  │    └─ webhook_deliveries intents      (webhook-fanout: DB only, same tx)
  ├─ notifications / email intents
COMMIT
processDueWebhookDeliveries (later; invoked by a future scheduler)
  claim (short tx, lease) → DNS + SSRF check → HMAC sign → HTTPS POST (pinned IP, 10 s)
  → sent | retry | failed (lease-guarded update)
```

## Fanout and the position/commit-order problem

`automation_events.position` is assigned at insert, not at commit: with concurrent
transactions, position 11 can commit before position 10, so a scanner using
`WHERE position > last_seen` can skip events forever. V-B therefore **does not use any position
cursor**. The fanout runs inside the producing transaction, right after each event is appended:
the event and its delivery intents commit or roll back together, so nothing has to be
"discovered" later. A test guards against position-cursor scanners.

- Only **active** subscriptions of the **event's organization** whose `eventTypes` contains the
  exact type receive an intent (no wildcard in v1).
- Idempotent: `UNIQUE (subscription_id, event_id)` + `ON CONFLICT DO NOTHING`.
- Cost with no subscriptions: one indexed query per event, no inserts.
- Atomicity: if an intent insert fails, the whole domain mutation rolls back (domain row,
  history, automation event, notifications, email intents). Subscriptions are validated when
  created/updated, so a stored subscription cannot make the fanout fail.
- The fanout needs no secret material: a missing encryption key never breaks domain mutations.

## Tables (migration 0024)

- `webhook_subscriptions`: `organization_id`, `name` (≤ 120), `target_url` (normalized https,
  ≤ 2048), `event_types` (JSON array, 1–50), `active`, `current_secret_version`,
  `created_by_user_id` (users, SET NULL), timestamps. `UNIQUE (id, organization_id)` for composite
  tenant FKs.
- `webhook_secrets`: `(subscription_id, version)` PK, AES-256-GCM `ciphertext`, `iv`, `auth_tag`.
  No plaintext column.
- `webhook_deliveries`: snapshot of `event_id` (FK automation_events), `event_type`,
  `target_url`, `secret_version` (FK to the secret row), exact serialized `body` (≤ 32 KB);
  `status`, `attempt_count`, `next_attempt_at`, `lease_token`, `last_attempt_at`,
  `delivered_at`, `failed_at`, `last_status_code`, `last_error_code` (CHECK-listed safe codes),
  `response_time_ms`. No response body, headers or raw errors are stored.

Permissions (seeded for `organization_admin` only): `webhooks:view`, `webhooks:manage`.
Technician and Customer get none.

## Admin API

All endpoints take `?organizationId=`, require a session and the capability, return
`Cache-Control: private, no-store`; mutations also require a same-origin `Origin` header and a
JSON body ≤ 8 KB with no unknown keys. Another tenant's id is 404.

| Endpoint                                | Capability | Notes                                                              |
| --------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `GET /api/webhooks`                     | view       | `{ webhooks: [dto] }`                                              |
| `POST /api/webhooks`                    | manage     | body `{ name, targetUrl, eventTypes }` → 201 `{ webhook, secret }` |
| `GET /api/webhooks/[id]`                | view       | `{ webhook }`                                                      |
| `PATCH /api/webhooks/[id]`              | manage     | subset of `{ name, targetUrl, eventTypes, active }`                |
| `DELETE /api/webhooks/[id]`             | manage     | deactivates (204, idempotent)                                      |
| `POST /api/webhooks/[id]/rotate-secret` | manage     | → `{ webhook, secret }`                                            |
| `GET /api/webhooks/[id]/deliveries`     | view       | read-only history, `limit ≤ 100`, `cursor`                         |

DTO: `{ id, name, targetUrl, active, eventTypes, hasSecret, createdAt, updatedAt }` — never the
secret or its ciphertext. Delivery DTO: `{ id, eventId, eventType, status, attemptCount,
lastStatusCode, lastErrorCode, responseTimeMs, nextAttemptAt, deliveredAt, failedAt, createdAt }`
— never the body. No manual retry and no "send test" endpoint in V-B.

## Secrets

- Generated server-side (`whsec_` + 32 random bytes, base64url) and returned **only** in the
  create or rotate response. Never logged, never in GET responses.
- Stored as AES-256-GCM ciphertext under `WEBHOOK_SECRET_ENCRYPTION_KEY` (32 bytes, hex or
  base64, from the environment; no default). The GCM associated data binds each ciphertext to
  its `(subscriptionId, version)`.
- Missing/invalid key: create and rotate answer 503 `WEBHOOKS_NOT_CONFIGURED` without writing;
  already queued deliveries retry with `CONFIGURATION_ERROR` (bounded) instead of failing the
  domain.
- Queued deliveries also keep the `target_url` snapshot: a PATCH of the URL applies to new events
  only. Deactivating the subscription stops queued deliveries (`SUBSCRIPTION_INACTIVE`) and
  reactivating it does not revive them.
- **Rotation** creates version `n + 1` and makes it current. Deliveries keep the
  `secret_version` recorded when they were created, so an intent created before a rotation is
  still signed with the previous secret (deterministic, no ambiguity). There is no dual-signature
  grace period: receivers should accept both secrets briefly after rotating. Rotating the
  master key requires re-encrypting `webhook_secrets` (not automated; 5.4W).
- Why not a derived secret (`HMAC(masterKey, subscriptionId)`)? It cannot be rotated per
  subscription and rotating the master key silently changes every secret.

## Request

```
POST <targetUrl>
Content-Type: application/json
User-Agent: SoporteFlow-Webhooks/1.0
X-SoporteFlow-Event-Id: <automation event id>
X-SoporteFlow-Event-Type: incident.assigned
X-SoporteFlow-Delivery-Id: <delivery id>
X-SoporteFlow-Timestamp: <unix seconds>
X-SoporteFlow-Signature: v1=<hex HMAC-SHA256>

{"id":"…","type":"incident.assigned","schemaVersion":1,"occurredAt":"…",
 "organizationId":"…","aggregate":{"type":"incident","id":"…"},"data":{…}}
```

`data` is the automation event payload (ids and enumerated values only; see the catalog). The
body is serialized once at fanout and sent byte-for-byte on every attempt.

### Verifying the signature

1. Read the raw request body (do not re-serialize JSON).
2. `expected = "v1=" + hex(HMAC_SHA256(secret, timestamp + "." + rawBody))`, where
   `timestamp` is the `X-SoporteFlow-Timestamp` header.
3. Compare with `X-SoporteFlow-Signature` using a constant-time comparison.
4. Reject timestamps outside ±5 minutes of your clock (replay protection).
5. Deduplicate by `X-SoporteFlow-Event-Id` (see delivery semantics).

## Delivery semantics

**At-least-once, never exactly-once.** A receiver that processes a request but whose response is
lost (timeout, connection reset, crash of the worker after the POST) receives it again on retry,
with the same event id and body (timestamp and signature are recomputed per attempt). Receivers
must be idempotent on the event id. Different subscriptions receive the same event id
independently.

### Retry policy and classification

- Max 5 attempts; delays after failed attempt 1–4: 1 min, 5 min, 30 min, 2 h. The 5th failure is
  final (`failed`, `MAX_ATTEMPTS`; `last_status_code` keeps the last HTTP status).
- `Retry-After` (seconds or HTTP-date) is honoured for 429 and 503, clamped to [1 min, 24 h].
- Total request timeout 10 s (AbortController-equivalent timer on the socket).

| Result                           | Status | Code                                                  |
| -------------------------------- | ------ | ----------------------------------------------------- |
| 2xx                              | sent   | —                                                     |
| 3xx                              | failed | `REDIRECT_NOT_ALLOWED` (redirects are never followed) |
| 408, 425                         | retry  | `HTTP_4XX`                                            |
| 429                              | retry  | `RATE_LIMITED`                                        |
| other 4xx                        | failed | `HTTP_4XX`                                            |
| 5xx                              | retry  | `HTTP_5XX`                                            |
| unparsable status                | failed | `INVALID_RESPONSE`                                    |
| timeout / connection / TLS error | retry  | `TIMEOUT` / `CONNECTION_FAILED` / `TLS_ERROR`         |
| DNS failure                      | retry  | `DNS_RESOLUTION_FAILED`                               |
| private/reserved target          | failed | `SSRF_BLOCKED`                                        |
| invalid stored URL               | failed | `INVALID_TARGET`                                      |
| subscription inactive at send    | failed | `SUBSCRIPTION_INACTIVE`                               |
| missing/wrong encryption key     | retry  | `CONFIGURATION_ERROR`                                 |

### Claim and lease

Same model as email delivery: one short transaction with `FOR UPDATE SKIP LOCKED` marks due rows
`processing`, assigns a new `lease_token`, increments `attempt_count` and sets the lease expiry
(5 min, stored in `next_attempt_at`). The HTTP call happens outside any transaction; outcome
updates require the current lease token, so a stale worker cannot overwrite a newer result and a
finished row cannot be marked twice. Expired leases are reclaimed; an expired lease at the attempt
limit is closed as `MAX_ATTEMPTS`. Real multi-connection concurrency is not proven on PGlite
(5.4W).

## SSRF protection

- **At configuration** (create/PATCH): only `https:`; no credentials, fragments or control
  characters; URL normalized (lowercase scheme/host, default port removed, path/query kept);
  IP literals must be public; `localhost`, `*.localhost`, `*.local`, `*.internal`,
  `*.localdomain`, `*.home.arpa`, cloud metadata names and single-label hosts are rejected.
  Custom ports are allowed (IP validation is the real control).
- **At every attempt**: the snapshot URL is re-validated and the host is resolved with
  `dns.lookup({ all: true })`; **every** answer must be public unicast, otherwise
  `SSRF_BLOCKED` (mixed public/private answers are blocked).
- Blocked ranges include 0/8, 10/8, 100.64/10, 127/8, 169.254/16 (metadata), 172.16/12,
  192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4,
  `::`, `::1`, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 2001:db8::/32, 2001::/32 and anything
  outside 2000::/3; IPv4-mapped/compatible, NAT64 and 6to4 addresses are classified by their
  embedded IPv4.
- **DNS rebinding**: the socket is **pinned** to a validated address (node:https `lookup`
  override); TLS still verifies the certificate for the original hostname. The remaining gap is
  the lifetime of that single validated answer (seconds). Only the first validated address is
  used (no happy-eyeballs fallback).
- Redirects are never followed (3xx = permanent failure), so a public endpoint cannot bounce the
  request to an internal one.
- Non-exhaustive by design: hostname rules are a convenience layer; the IP classification is the
  authoritative control. Egress firewalling remains recommended in production.

## Retention

`deleteOldWebhookDeliveries(db, { before })` deletes `sent`/`failed` rows last updated before
the cutoff; pending/retry/processing rows are kept. No scheduler invokes it yet. Old secret
versions are kept while any delivery references them (FK); pruning them is future work.

## Boundaries

- V-B: subscriptions, secrets, fanout, processor, admin API, docs.
- V-C: automation rules/actions. V-D: n8n. Not started.
- Scheduler: the processor and retention are plain functions; nothing calls them periodically.
- 5.4W: multi-connection claim concurrency, master-key rotation tooling, secret-version pruning,
  dual-secret rotation grace period.

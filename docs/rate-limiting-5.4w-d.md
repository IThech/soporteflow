# 5.4W-D — Rate limiting and abuse prevention

## Scope and order

The server hook runs W-C method, query, Origin, content-type and bounded-body validation, then the W-D guard, then the canonical handler. This is an additional layer, never authorization. Canonical transactional authentication, permissions, resource hiding and tenant SQL filters remain authoritative. Static assets and page routes are not assigned API quotas. Edge protection is still necessary for invalid-request floods, slow uploads and SSR page floods.

The guard resolves the real principal and validates active organization membership before assigning a tenant bucket. The requested UUID alone is insufficient. Full capability/resource checks remain in the handler; an exhausted budget can therefore return 429 before a later business 403/404. Below limits the existing 401/403/404 semantics remain unchanged. No demo identity or role participates.

## Surface inventory

All paths below are prefixed `/api`. Reads use the shared read family; writes use the indicated family. A user bucket is shared across their organizations; organization buckets are shared across valid members. All API requests first spend the IP flood budget.

| Paths                                                                                                                       | Methods/surface                      | Authentication and tenant                                          | Abuse / policy                                                   |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `/auth/[...all]`                                                                                                            | Public POST `sign-in/email`          | No session; normalized submitted email                             | Password hashing/brute force: login burst, IP and identity       |
| `/auth/[...all]`                                                                                                            | POST `sign-out`; other dynamic paths | Better Auth; closed operations remain closed                       | Flood only; get-session is not a login attempt                   |
| `/invitations/verify`, `/invitations/accept`                                                                                | Public POST                          | Submitted token; organization resolved by service                  | Token guessing/replay: separate token and IP windows plus flood  |
| `/invitations`, `/invitations/[id]`, `/invitations/[id]/resend`                                                             | GET, POST, DELETE as exported        | Real session, organization query, administrative permission        | Reads; invitation writes including email-producing create/resend |
| `/incidents`                                                                                                                | GET, POST                            | Real session; GET query / POST body organization                   | Read; incident creation and downstream events/notifications      |
| `/incidents/[id]`                                                                                                           | GET, PATCH                           | Session, organization query, resource authorization                | Read; general write                                              |
| `/incidents/[id]/comments`, `/incidents/[id]/internal-notes`                                                                | GET/POST as exported                 | Session, organization query, visibility permissions                | Read; message family, notification/event side effects            |
| `/incidents/[id]/history`                                                                                                   | GET                                  | Session, tenant/resource visibility                                | Paged read                                                       |
| `/incidents/[id]/assign`, `/category`, `/site`, `/sla`, `/support-level`                                                    | POST/PATCH as exported               | Session, organization query, capability/resource rules             | General write; indirect notifications/automation/webhooks        |
| `/incidents/assignees`, `/teams`                                                                                            | GET                                  | Session, authorized organization                                   | Bounded read                                                     |
| `/roles`, `/roles/[id]`, `/memberships`, `/memberships/[id]`, `/memberships/[id]/roles`, `/memberships/[id]/roles/[roleId]` | GET/POST/PATCH/DELETE as exported    | Session, organization and administrative permissions               | Read / administrative writes                                     |
| `/sites`, `/sites/[id]`, `/categories`, `/categories/[id]`, `/sla-policies`, `/sla-policies/[id]`                           | GET/POST/PATCH as exported           | Session, organization and permissions                              | Read / administrative writes                                     |
| `/webhooks`, `/webhooks/[id]`, `/webhooks/[id]/rotate-secret`, `/webhooks/[id]/deliveries`                                  | GET/POST/PATCH/DELETE as exported    | Session, organization and permissions                              | Read / administrative writes; no delivery transport bypass       |
| `/automations`, `/automations/[id]`, `/automations/[id]/executions`                                                         | GET/POST/PATCH/DELETE as exported    | Session, organization and permissions                              | Paged read / administrative writes                               |
| `/notifications`, `/notifications/[id]`, `/notifications/read-all`, `/notifications/unread-count`                           | GET/PATCH/DELETE/POST as exported    | Session, own-user and tenant scope                                 | Read / general writes                                            |
| `/notification-preferences`, `/notification-preferences/[eventType]`                                                        | GET/PUT/DELETE                       | Session, own-user scope                                            | Finite-catalog read / general writes                             |
| `/me`, `/permissions`                                                                                                       | GET                                  | Real session; optional/required organization per existing contract | Read; organization list bounded / permission catalog finite      |

Signup, password recovery, change-email and account deletion remain closed by Better Auth configuration. W-D does not create any public endpoint or enable these operations. Login and logout remain functional.

## Policies

| Family                    | User or identity limit             | Organization limit | Window     |
| ------------------------- | ---------------------------------- | ------------------ | ---------- |
| API flood                 | 600 per adapter IP                 | None               | 1 minute   |
| Login burst               | 5 per IP                           | None               | 10 seconds |
| Login sustained           | 20 per IP; 10 per normalized email | None               | 15 minutes |
| Reads                     | 120 per user                       | 600                | 1 minute   |
| General writes            | 60 per user                        | 300                | 1 minute   |
| Incident creation         | 20 per user                        | 100                | 1 minute   |
| Comments / internal notes | 30 per user                        | 200                | 1 minute   |
| Invitation administration | 10 per user                        | 50                 | 15 minutes |
| Administrative writes     | 30 per user                        | 120                | 1 minute   |
| Public invitation verify  | 60 per IP; 10 per submitted token  | None               | 1 minute   |
| Public invitation accept  | 20 per IP; 5 per submitted token   | None               | 15 minutes |

These are abuse controls, not commercial quotas. Requests count regardless of success; no refund is attempted. IP is checked before email/token, user before tenant. A rejected earlier scope does not spend a later scope. Windows expire automatically; denied attempts do not extend them. Email normalization is only for rate-limit keys and does not modify identities. Existing and nonexistent emails follow the same limiter path. A determined distributed attacker can still temporarily exhaust an email bucket; no permanent account lock is created. NAT users share IP limits.

## IP and proxy trust

Only `event.getClientAddress()` is used. W-D never reads X-Forwarded-For, X-Real-IP, Forwarded or Cloudflare headers. Invalid/unavailable addresses share `unknown`, rather than bypassing protection. The central guard canonicalizes mapped IPv4 and IPv6 addresses.

The project currently uses adapter-auto. In local development the adapter peer is used. Deployment must verify what the selected adapter returns. Behind a reverse proxy, an unconfigured peer may be the proxy and share a bucket across clients. Never enable forwarded-header trust without restricting origin access to trusted proxies and having that proxy remove and rewrite incoming address headers. Cloudflare deployment requires this explicit adapter/network review; adding a client-supplied header is not a solution. The application cannot repair an adapter that already trusts attacker-controlled headers.

The parallel Better Auth limiter is disabled, and its IP tracking is disabled, because W-D owns the HTTP boundary and must not use spoofable default headers or a second incompatible 429 contract. Do not expose Better Auth through another HTTP entry point without this guard. Internal session resolution is not a login operation.

## Storage, memory and failure behavior

Fixed windows use a synchronous per-process consume operation and an injectable clock. Backward clock movement is clamped. Each limiter holds at most 10,000 hashed keys; the central store has 16 finite policies, and invitations have four additional bounded maps. No timers are created. Expired entries are removed lazily on consume; dormant entries remain bounded until the next call. Live entries are never evicted: full capacity rejects new keys until expiry, preventing churn from resetting protection. Capacity saturation can temporarily reject new legitimate callers.

Keys use HMAC-SHA-256 with a process-random salt. Raw emails, tokens, IPs and identity UUIDs are not stored in limiter maps or logged. Restart clears windows and rotates the salt. In-process tests demonstrate atomic consumption of each individual window; multi-scope consumption is ordered, not a distributed transaction.

A normal denial (including capacity) is HTTP 429 with private/no-store, `Retry-After` in positive integer seconds, and exactly:

```json
{ "error": { "code": "RATE_LIMITED", "message": "Too many requests." } }
```

No key, counter, IP, email or tenant details are returned. A store exception fails closed for login/mutations with generic HTTP 503 `LIMITER_UNAVAILABLE`, Retry-After 30. Reads fail open only for store exceptions; normal read denials remain 429. Authentication/authorization failures are not treated as limiter-store failures.

## Read bounds

Existing paginated history/messages/notifications/automation/execution/delivery endpoints retain their validated page-size and cursor contracts. W-C rejects duplicate/oversized queries. Legacy unpaginated incidents, assignees, categories, sites, teams, roles, memberships and role expansion, invitations, SLA policies, webhook subscriptions and `/me` organizations now select at most 501 rows after their tenant/filter predicates. More than 500 returns explicit 422 `RESULT_LIMIT_EXCEEDED`; data is never silently truncated into a successful complete list. This changes the outcome for large legacy lists; where no narrowing filter exists, future pagination is necessary. Permission/preference catalogs are finite.

A result cap bounds materialization, not database scan/sort cost. Index/performance work and a full pagination UI are outside this change. Existing authorization-internal queries are not replaced with truncated data.

## Deployment and validation

This implementation is single-instance/dev/staging only. Multiple workers, serverless instances and replicas multiply budgets. Before horizontal production deployment, provide an atomic shared Redis/KV-style implementation of `AbuseStore`, shared stable secret/key strategy, TTL/capacity semantics, backend timeout and the documented fail policy. Public invitation counters must also move to shared storage; replacing only the central store is insufficient. No Redis dependency, SQL counters or migrations are introduced here.

The dedicated `tests/rate-limit-security.test.mjs` uses injected clocks, controlled stores and isolated PGlite fixtures. It covers spoofing, budgets, tenant isolation, invitation acceptance/resend, safe failures, bounded SQL, CSRF order, inactive sessions and process concurrency without sleeps. Existing auth HTTP tests exercise the central login limiter against Better Auth. The full regression command is `node --test --test-concurrency=1 tests/*.test.mjs`.

Deferred: W-E logging/secret/runbook overhaul; W-F final release gate/dependency review; X general performance/indexes, full pagination UX, plan quotas, health/readiness and invitation outbox. Shared-store and edge deployment controls remain prerequisites for horizontal operation, not claims already demonstrated by these tests.

# Real PostgreSQL concurrency lab — 5.4W-A

The unit suite (`tests/*.test.mjs`) runs on **PGlite**: a single-connection, in-process
PostgreSQL. It proves logic and atomicity, but it **cannot prove concurrency**: there is only one
session, so row locks, `SKIP LOCKED`, lock waits and races never happen. Nothing measured on PGlite
counts as concurrency evidence.

`tests/concurrency/` is a separate suite that runs the real SoporteFlow services (and one real
HTTP route) against a **real PostgreSQL server** with **several independent sessions**, and
coordinates them so that the competing operations really overlap inside the database.

## Requirements

- PostgreSQL ≥ 13 (uses `gen_random_uuid()`), reachable **over TCP** from the machine running
  the suite.
- Node.js ≥ 20.19 (Vite 8) and the repository dependencies (`npm ci`).
- A **dedicated, disposable lab database**, owned by the lab user.
- `DATABASE_URL` pointing to it **with a hostname**, e.g.
  `postgresql://soporteflow_lab_runner:PASSWORD@127.0.0.1:5432/soporteflow_concurrency_lab`.
  Socket-only URLs (`postgresql:///db` + `PGHOST`) are refused: the production auth
  configuration only accepts a `DATABASE_URL` with a hostname, so with a socket URL the
  route-level scenarios would run with authentication disabled (this invalidated #2 in the first
  CT 105 run).

## Safeguards

- `DATABASE_URL` is mandatory; every command refuses to start without it (exit code 2).
- The database name must be a lowercase identifier containing a `lab`, `test` or `concurrency`
  token (e.g. `soporteflow_concurrency_lab`). `soporteflow`, `production`, `prod`, `postgres`,
  `template0/1` and any name containing `prod` are always rejected.
- Every session re-checks `current_database()` against the URL before running anything.
- Each session sets `statement_timeout = 20 s`, `lock_timeout = 10 s` and
  `idle_in_transaction_session_timeout = 60 s`; every scenario has its own timeout (60 s) and every
  coordination signal times out — nothing can hang forever on a lock.
- Output shows `user@host:port/database` only: never the password, the full URL, tokens or secrets.
- The only destructive operation is the explicit reset (below), which drops the `public` and
  `drizzle` schemas **inside the verified lab database** — never `DROP DATABASE`, never another
  database. Scenarios only create uniquely named organizations/users (`wa-<run>-…`) and delete
  only their own lab rows (plus non-terminal queue rows left by an aborted earlier run).
- No external network: webhook HTTP and email senders are in-process stubs; DNS is stubbed.

## Commands

```bash
# 1. clean schema + all migrations (0000..HEAD) with the production drizzle migrator, then verify
DATABASE_URL=… npm run test:concurrency:reset

# (or, on an empty/partially migrated lab database, without dropping anything)
DATABASE_URL=… npm run test:concurrency:migrate

# 2. run every scenario (files run one after another; scenarios inside a file are sequential,
#    each one opens its own concurrent sessions)
DATABASE_URL=… npm run test:concurrency

# run a subset
DATABASE_URL=… npm run test:concurrency -- --test-name-pattern="#1"
```

The suite refuses to run if the number of applied migrations differs from the journal.

## How scenarios create real races

- Every worker uses its own PostgreSQL session (`postgres-js` client with `max: 1`, distinct
  backend pid and `application_name`).
- `pausingDb(db)` wraps a session so that the N-th `db.transaction()` opened by a real service
  **pauses before COMMIT (or right after BEGIN) while holding its locks**.
- The competing worker then runs the real service on another session; `waitForLockWait` polls
  `pg_stat_activity` until that session is actually blocked on a lock (`wait_event_type =
'Lock'`), so the race is proven, not assumed with sleeps.
- The paused transaction is released (or forced to roll back) and the final database state is
  asserted: row status, history, automation events, notifications, webhook/email intents, lease
  tokens and side-effect counts.
- Some scenarios also run uncoordinated `Promise.all` loops to catch ordering-dependent bugs.

## Isolation level

The server default and every drizzle transaction run at **READ COMMITTED** (asserted by the
preflight). The guarantees under test rely explicitly on:

- row locks (`SELECT … FOR UPDATE / FOR SHARE`) and the organization-row lock that serializes
  administrator changes;
- `FOR UPDATE SKIP LOCKED` for queue claims;
- `UNIQUE` constraints + `ON CONFLICT DO NOTHING` for fanout idempotency;
- conditional updates guarded by lease tokens;
- READ COMMITTED re-evaluation of `WHERE` clauses for updated rows (EvalPlanQual).

Nothing depends on SERIALIZABLE.

## Scenarios

| #   | File | Scenario                                                                                                                            |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| —   | 00   | real server (not PGlite), READ COMMITTED, independent backends, real row-lock conflict, append-only trigger                         |
| 20  | 00   | db Proxy regression: `'transaction' in db` and a real rollback through the production `db` module                                   |
| 21  | 00   | Date parameters on real PostgreSQL: every Date-taking processor/retention entry point (rolled back)                                 |
| 1   | 10   | last-admin: two concurrent revocations of the last two admins (coordinated + 10 uncoordinated runs); revoke + custom-role downgrade |
| 2   | 10   | authorization TOCTOU through the real `DELETE /api/memberships/[id]/roles/[roleId]` route (FOR UPDATE path)                         |
| 2b  | 10   | same race through `POST /api/webhooks` (FOR SHARE path): demoted actor gets 403, nothing written                                    |
| 3   | 20   | invitation double acceptance (onboarding, existing identity, uncoordinated x5), accept vs resend, accept vs revoke                  |
| 4   | 30   | automation double claim (`SKIP LOCKED` distribution, one side effect per execution)                                                 |
| 5   | 30   | automation stale worker (lease expired, reclaimed, late worker cannot write)                                                        |
| 6   | 30   | automation lease expiry during an open action transaction                                                                           |
| 7   | 30   | two executions mutating the same incident (serialization, coherent history/events)                                                  |
| 8   | 30   | rule disabled before vs during the action transaction                                                                               |
| 12  | 30   | concurrent rule+event fanout (UNIQUE), and FK errors are not masked by `ON CONFLICT`                                                |
| 9   | 40   | webhook double claim                                                                                                                |
| 10  | 40   | webhook stale worker (token guard; duplicate POST = documented at-least-once)                                                       |
| 10b | 40   | H2 (fixed): a batch item not yet sent is reclaimed by B; A must skip it (only the in-flight POST is duplicated)                     |
| 13  | 40   | concurrent webhook subscription+event fanout (UNIQUE)                                                                               |
| 11  | 40   | notification email double claim, stale worker, H2 batch (#11c) and atomic renewal vs concurrent claim (#11d)                        |
| 14  | 50   | concurrent status writes; invalid transition after the first commit                                                                 |
| 15  | 50   | assign/unassign race                                                                                                                |
| 16  | 50   | public comment (first response) + status change                                                                                     |
| 17  | 50   | reopen vs close on a resolved incident                                                                                              |
| 18  | 50   | SLA `firstResolvedAt` and `firstResponseAt` first-write-wins, one SLA event                                                         |
| 19  | 50   | rollback under contention releases locks, no partial effects (history, events, notifications, webhook intents)                      |
| 30  | 50   | tenant: own vs foreign site in a race; composite FK rejects cross-tenant links                                                      |
| 31  | 60   | W-B: technician loses `incidents:edit` while `PATCH /api/incidents/[id]` waits on the org lock → 403, nothing written               |
| 32  | 60   | W-B: membership deactivated while `POST …/comments` waits → 403, no message                                                         |
| 33  | 60   | W-B: view_own incident reassigned to someone else while the PATCH waits on the row lock → 404, nothing written                      |

## Findings of the first real run (CT 105, PostgreSQL 17.11)

- **Date binding bug (fixed).** `processAutomationExecutions` and `deleteOldAutomationExecutions`
  interpolated a JS `Date` in raw `sql` templates. drizzle's postgres-js driver installs
  pass-through serializers for timestamp types, so the Date reached postgres-js unconverted and the
  query failed with `ERR_INVALID_ARG_TYPE`; PGlite accepted it, so the unit suite never saw it. Fixed
  with typed operators (`lte`, `lt`, `inArray`). Regressions: `tests/sql-date-params.test.mjs`
  (static guard in the unit suite) and #21 (runtime, real PostgreSQL).
- **#2 was not conclusive.** The lab used a socket-only URL, which the production auth
  configuration rejects; the request was answered before reaching its transaction. The lab now
  requires a hostname URL and #2 starts with a control call that must return 404 (authenticated
  and authorized) before the race is attempted.
- **H2 confirmed (#10b: 2 duplicate POSTs) and fixed.** See below.

## Hypotheses from inspection (to confirm or refute on real PostgreSQL)

- **H1 — authorization TOCTOU (#2) — confirmed on the second run (204, victim lost its role) and
  fixed.** Admin routes resolved the actor's authorization and `actorPermissions` before the service
  transaction. Every administrative mutation now runs inside `withActorAuthorization`
  (`src/lib/server/auth/transactional-authorization.ts`): organization row lock first (FOR UPDATE
  when the service locks it that way, FOR SHARE otherwise), then the actor is re-validated on the
  same transaction and the mutation delegates with the capabilities read there. Expected now: #2 →
  403 FORBIDDEN, victim intact; #2b (FOR SHARE path, webhook creation) → 403, nothing written.
- **H2 — batch vs lease (#10b, #11c, #11d) — confirmed and fixed.** Webhook and email processors
  claimed up to `limit` rows with one 5-minute lease and sent them sequentially (100 × 10 s > 5 min)
  without re-checking ownership, so another processor could reclaim an unsent item and both sent
  it. Fix: right before each external send, the worker renews the item's lease with a
  token-guarded atomic UPDATE (`renewWebhookLease` / `renewDeliveryLease`) from its current
  logical time (invocation `now` + elapsed monotonic time); if the token changed it skips the item
  (`leaseLost`). The renewal and a concurrent claim serialize on the row: whichever commits first
  owns it (#11d). Email sends are bounded by `NOTIFICATION_EMAIL_SEND_TIMEOUT_MS` (30 s, transient
  `NETWORK_ERROR`). What remains is the inherent at-least-once case: a send already in flight when
  the worker stalls beyond its lease (> 5 min, impossible with the 10 s / 30 s bounds unless the
  process freezes) can be repeated by the reclaiming worker; receivers dedupe by event id.
- **H3 — automation is protected by row locks, not only by the lease (#6).** The action
  transaction locks the execution row, so an expired lease cannot be reclaimed while actions run;
  a worker that lost its lease before starting finds the token changed and does nothing (#5).
- **H4 — administrator-affecting paths.** Only role assignment/revocation and custom-role updates
  change who administers a tenant, and all of them lock the organization row. There is no service
  path deactivating memberships or users today; any future one must take the same lock.
- **H5 — deadlocks.** Lock order review (incident → rules FOR SHARE in fanout; execution → org
  SHARE → rule SHARE → incident in actions; org UPDATE → rule UPDATE in rule edits) found no
  cycle; no scenario is expected to deadlock. A deadlock (`40P01`) in any scenario is a finding.

## Interpreting results

- `[LAB SAFETY]` / exit code 2: wrong or missing `DATABASE_URL`; nothing was executed.
- `applied migrations … expected …`: run `test:concurrency:migrate` (or `:reset`).
- `[LOCK WAIT TIMEOUT]`: the competing operation never blocked — the expected lock is not taken
  (a real finding) or the scenario raced differently; read the scenario log line.
- `[TIMEOUT]` / `55P03` / `57014`: a lock or statement timeout fired — likely a deadlock-like wait
  or a missing index; report it with the scenario name.
- `40P01`: a real deadlock — report the scenario and the two operations involved.
- An assertion failure is a violated invariant: copy the scenario name, the `[#n]` log line and
  the assertion message.

Each scenario prints one line such as `[#1a] A=fulfilled B=rejected:LAST_ADMIN_REQUIRED`.

## Limitations

- Connection loss / ambiguous commit (success committed but not received) is not simulated;
  callers that need exactly-once must use idempotency keys at their boundary.
- Real SMTP/HTTP providers and DNS are not exercised (stubs); timeouts of real adapters are
  covered by the unit suite only.
- The suite validates behaviour under two or three concurrent sessions; it is not a load test.

## Pending after W-A

W-B (prepared): operational incident mutations re-validate inside their transaction
(`withIncidentActor`); scenarios #31-#33 must pass on CT 105. W-C/W-D runner/scheduler (heartbeat for very long single operations), W-E operational concerns
(ambiguous commits, observability, retention jobs), W-F load and soak testing.

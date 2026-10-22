# K5 durable same-node account admission — implementation plan (planning only)

**Status:** accepted bounded implementation plan; root review recorded below · **Updated:** 2026-10-22
**Exact base pin:** `92cee721baa2425a8b154b84b5fe11546b65fbee` (`codex/k5-durable-admission`,
clean). This is the merge of main `236a9669aa2d78903c898966f772c5f7bd3b78ac` with the reviewed
native baseline `53b1e76a01f8834f15338f7175396c015444a756`; it is not `53b1e76` itself.
**Scope of this document:** one new plan file only. No source, test, fixture, dependency,
contract, status, handoff, lockfile or central document is changed by this planning task.
Planning used the installed `implementation-planning`, `architecture-migration` and
`workstation-dev` skills; no tool or plugin was installed or updated.

Root reports `npm ci` completed as `check-mzj4mbzb`, and `@guanxi/contract` resolves inside this
clone. This planning session did not rerun installation, tests, typecheck, build, browser,
container, SSH, model, provider, auth or owner-data commands. Node observed locally is
`v26.9.0`; `require.resolve('@guanxi/contract')` returned
`/Users/yuzuru/Projects/Guanxi-lanes/k5-durable-admission/packages/contract/src/index.ts`.
The runtime remains the local Mac with the root-owned Colima stack; this slice needs no container
and no host-network change. Heavy checks use the existing shared state under
`/Users/yuzuru/.local/state/agent-dev` and are root-only.

## Decision

The next bounded K5 slice is **durable same-node account admission** in the existing private
append-only `external-agents.sqlite` sidecar, migration **v2**, with an honest effective-bare
fact. It removes the instance-local admission bypass without turning K5 into a distributed lease,
a vendor concurrency claim or a replacement for manual vendor clients.

The slice is an implementable prerequisite for distributed admission and full K5 closure. It is
not that closure. It does not add an automatic Claude quota producer, real release captures,
vendor-token handling, sandbox enforcement, networking or role routing.

Acceptance is met only when all of the following are proven by assertions that fail on violation:

1. Two K5 service instances, and two actual Node worker processes, sharing one sidecar cannot
   exceed the same account group's effective local ceiling. Different connection IDs do not
   create a second slot.
2. A `login` holder is exclusive with every run and every other login in the group. An occupied
   run group blocks login regardless of ceiling.
3. A holder is released by its exact opaque holder ID only after every owned child/process group
   has an acknowledged cleanup outcome. Cleanup uncertainty or a crash retains occupancy across
   restart. No wall-clock expiry, PID probe, inference resume or automatic replacement occurs.
4. A configured ceiling/policy-digest conflict is refused while any row for the group is held or
   `cleanup_unconfirmed`, including rows from another process. A safe configuration change works
   once the group is genuinely quiescent, with no permanent tombstone.
5. The v1 sidecar and its rows are preserved; the global `user_version` is not consumed or
   changed; v2 addition and reopen are idempotent; private file permissions remain.
6. `activeOnThisNode` keeps its instance-local meaning. Durable occupancy is a separate additive
   diagnostic, and no raw argv, environment, auth JSON, email, organization identity, secret or
   PID is persisted.
7. Existing K3 owner/payment checks still run before acquisition/launch, and all current K5
   adapter, credential-boundary and descendant-cleanup assertions remain green.

## Current behavior and root cause

`ExternalAgents.execute` currently checks an instance-local `active` Map and `authenticating`
Set (`packages/server/src/external-agents/service.ts:49-50,219-225`). `limits()` reports only the
in-memory count (`service.ts:133-137`). Two service instances sharing one sidecar therefore each
believe the account is free. The sidecar has project roles, grants, quota and concurrency
learning only (`packages/server/src/external-agents/store.ts:16-31`); it has no reservation,
holder or cleanup state.

The launch order is otherwise useful: role resolution and installation validation happen
before K3; `Connections.dispatchAgent` performs the original-author/payment checks and key
injection before invoking the launch callback (`packages/server/src/connections/service.ts:227-247`).
The durable acquire belongs inside that callback, after those checks and before any auth/vendor
spawn. A grant revoked before dispatch therefore yields zero rows and zero children. This slice
rechecks the abort signal across preflight; it does not add a second post-acquire K3 grant read
(that would be a K3 shared edit).

Cleanup is not an acknowledgment today:

- `AgentProcess` spawns one detached POSIX group (`process.ts:57-62`) and sends TERM/KILL to the
  group (`process.ts:118-124,140-155`), but `close()` returns `void` after `await this.closed`.
  It does not prove the group is empty with an `ESRCH` observation.
- `claudeAuthStatus` spawns a second detached group, kills it on abort/exit, and resolves/rejects
  on `close` (`process.ts:159-191`), but returns no cleanup outcome. Its caller can proceed
  without a group-empty acknowledgment.
- `execute` runs release logic in a nested `finally` even when `client.close()` rejects
  (`service.ts:306-312`), so a close error still releases the in-memory slot.
- `signInWithChatGPT` deletes its in-memory login state in `finally` (`service.ts:339`) without
  durable occupancy or a cleanup outcome.
- `prepareLogin` returns a descriptor only (`service.ts:120-132`); it does not own the manual
  interactive CLI and cannot claim exclusivity over it. `signInWithChatGPT` is the owned login
  path that must participate in durable admission.

### Actual ownership inventory

| Owner | Owns an OS process/group? | Current cleanup evidence | Required in this slice |
| --- | --- | --- | --- |
| `AgentProcess` for an ACP/Codex run | Yes, one primary child; one detached group on POSIX | `close` event, TERM/KILL sent, no group-empty proof | return a cached `ProcessCleanup` from `close()`; confirmed only after child close and group `ESRCH` |
| `claudeAuthStatus` probe | Yes, one status child; one detached group on POSIX | kills on abort/exit, result settles on close, no group-empty proof | probe object with `result` and `close()`; caller awaits `close()` before releasing or launching the primary |
| `CodexClient` app-server login | Yes, one primary child/group | `CodexClient.close` delegates to `AgentProcess.close`; same gap | same `ProcessCleanup`, applied to a `login` holder |
| `prepareLogin` | No | returns argv/environment descriptor; no child | no admission row; explicit no-exclusivity documentation |
| K2 session handle | No | `handle.close()` only | never allowed to skip admission release on error |
| API-key per-invocation config directory | No (filesystem only) | `rm(..., force).catch` currently ignores failure | keep process cleanup decisive; document directory cleanup separately |

## Scope

In scope:

- Append `k5_migrations` **v2** with one admission table and group index.
- A durable acquire transaction that checks the group's existing rows, policy digest and learned
  rejection ceiling under `BEGIN IMMEDIATE`, then inserts an opaque `held` holder.
- Exact-holder release after process cleanup acknowledgment; `cleanup_unconfirmed` marking when
  cleanup is not proven; stable failure propagation when the marking or release SQL fails.
- Login exclusivity for the owned `signInWithChatGPT` path.
- Abort rechecks across async preflight and before every spawn.
- A minimal `process.ts` cleanup acknowledgment used by the primary run process and the Claude
  auth-status probe.
- An additive `durableLocalOccupancy` diagnostic; `activeOnThisNode` semantics unchanged.
- An additive `effective_bare` connection fact that remains null/unknown until actually observed
  from a verified launch source. The existing `bare` fact remains explicit launch-policy metadata.
- Fixture-only tests, including two actual bounded Node worker processes, v1 upgrade and crash
  restart cases.
- K5 current-state README wording is updated by implementation; this planning task changes none
  of it. Evidence/handoff wording is written only after the implementation proves something.

Out of scope, explicitly:

- Distributed admission, F1/F2 grants, remote nodes, a designated account authority, fencing,
  signed leases, TTL renewal/expiry, quorum or partition behavior.
- Vendor concurrency caps, automatic quota producer/statusline integration, real release
  captures, live vendor CLI/account/model/network calls, installed inference or billing.
- Manual interactive CLI enforcement. `prepareLogin` cannot block or be blocked by an external
  vendor process; no claim of exclusivity is made for it.
- K4 `ExecutionOwner` sandboxing, vendor tool/network containment, new host networking,
  sandbox policy, ports, containers or SSH.
- REST/SSE/contract/web/CLI changes. If a future wire projection of `effective_bare` needs
  coordination, split it into a separate contract slice; the current `facts` record already
  accepts additive keys.
- Main `user_version`, global migration slots, K3/R2/R3/F2 source, central status files or
  `NEXT_AGENT_PROMPT`.

## Durable contract

### Group identity and policy digest

The group key is exactly:

```text
(ownerAccountId, adapter, billingAccount)
```

It deliberately excludes `connectionId`, executable, version and process instance. Two
connections for the same owner/adapter/billing account therefore share one slot set. A different
owner, adapter or billing account is isolated.

The policy digest is a SHA-256 over canonical JSON containing only trusted launch policy:

```ts
sha256(JSON.stringify({
  schema: 'k5-account-admission/v1',
  nodeId: install.nodeId,
  ownerAccountId: install.ownerAccountId,
  adapter: install.adapter,
  billingAccount: install.billingAccount,
  operatorCeiling: install.concurrency ?? 1,
}))
```

The digest does **not** include learned observations, connection IDs, timestamps, prompts,
credentials, executable paths, argv or environment. A held row stores the digest, never the raw
policy object.

The effective run ceiling is the existing semantics, evaluated inside the acquire transaction:

```text
operatorCeiling = install.concurrency ?? 1
learnedCeiling  = rejectedAt === null ? Infinity : max(1, rejectedAt - 1)
effectiveCeiling = min(operatorCeiling, learnedCeiling)
```

A learned rejection never raises the operator ceiling. A successful completion never raises it.
Rows in both `held` and `cleanup_unconfirmed` count as occupied. The ceiling is an explicit local
operator policy, not a vendor concurrency limit.

### Sidecar migration v2

Append after the unchanged v1 SQL, in the same `BEGIN IMMEDIATE` migration transaction:

```sql
CREATE TABLE k5_admission (
  holder_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  adapter TEXT NOT NULL,
  billing_account TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('run', 'login')),
  policy_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'held'
    CHECK (state IN ('held', 'cleanup_unconfirmed')),
  cleanup_reason TEXT
);
CREATE INDEX k5_admission_group
  ON k5_admission(owner, adapter, billing_account, state);
INSERT INTO k5_migrations VALUES (2);
```

There is no `released` state: confirmed release deletes the exact row. There is no `expires_at`,
`pid`, `pgid`, `argv`, `environment`, `auth_json`, `email` or `organization` column. `holder_id`
and `instance_id` are random UUIDs. `created_at` is diagnostic only and is never an expiry
predicate. `cleanup_reason` is a closed stable code, never a raw error or vendor output. `owner`
is the existing Guanxi account ID, `adapter` is the closed adapter ID and `billing_account` is
the operator's existing opaque grouping key; no vendor email, organization, argv, environment or
auth JSON is derived or added.

### Acquire transaction

Inside `BEGIN IMMEDIATE` (the store already sets `busy_timeout=5000`):

1. Read all rows for `(owner, adapter, billing_account)`.
2. If any row's `policy_digest` differs from the requested digest, throw
   `account_policy_conflict` and insert nothing. This includes `held` and
   `cleanup_unconfirmed` rows.
3. If the request is `login` and any row exists, throw `account_busy`.
4. If any row is `login`, throw `account_busy` for a `run` request.
5. Read the learned rejection row inside the same transaction and compute the effective ceiling.
6. If the request is `run`, count both `held` and `cleanup_unconfirmed` run rows. If the count is
   already at or above the effective ceiling, throw `account_busy`.
7. Insert one opaque `held` row with a new holder ID, this service instance ID, kind, digest and
   creation time. Return the exact holder plus the transaction's admitted run count (including
   this row), then commit.

A SQLite busy/timeout or SQL failure rolls back with `admission_unavailable`; there is no
in-memory fallback and no partial row. The transaction is the only admission decision point.
On success, the completion observation uses the transaction's admitted run count, not a
potentially stale in-memory counter.

### Release and cleanup states

| Transition | SQL/behavior | Result |
| --- | --- | --- |
| none → `held` | insert in acquire transaction | admitted |
| `held` → none | `DELETE ... WHERE holder_id=? AND instance_id=?` after confirmed cleanup | released exactly once |
| `held` → `cleanup_unconfirmed` | `UPDATE ... SET state='cleanup_unconfirmed', cleanup_reason=? WHERE holder_id=? AND instance_id=? AND state='held'` | retained, no replacement |
| `held` → `held` | process crash/restart; no boot sweep | retained |
| `cleanup_unconfirmed` → none | **not implemented**; requires a later separately reviewed audited admin break | retained |
| duplicate exact release | delete by exact holder, zero changes is idempotent | no effect on another holder |
| release SQL failure | propagate `admission_release_failed`; never catch as success | row retained |
| cleanup marking SQL failure | propagate `admission_release_failed`; never claim `cleanup_unconfirmed` was written | row remains `held` |
| closed DB during teardown | surface `admission_release_failed`; do not claim release | on reopen the on-disk row remains |

`DELETE` never uses the group, adapter, connection ID, instance ID alone or a numeric PID. A
stale holder cannot delete a different holder because IDs are unique and the delete is exact.
Boot never deletes rows, never compares wall time and never infers liveness from an empty task
set. `cleanup_unconfirmed` rows count against capacity and trigger `account_policy_conflict` if
the policy digest later differs.

### Cleanup acknowledgment

A run or owned login releases its holder only when every child it started has both:

1. a primary `close` event observed by the parent; and
2. on POSIX, no remaining member in the owned Process Group, proven by
   `process.kill(-pgid, 0)` throwing `ESRCH` after the termination campaign.

`confirmed` outcomes are `group_empty`, `no_child` (no PID was ever assigned) and
`spawn_failed` (spawn failed before ownership began). `group_timeout`, `permission_denied`,
`close_error` and `unsupported_platform` are unconfirmed. A timeout here is only a bounded
cleanup-verification deadline; it never expires a reservation and never creates a replacement.

The auth-status probe is a separate owned group but not a `kind='login'` reservation; it is a
status child of the run and is covered by that run's durable holder. The caller must settle both
its result and its `close()` acknowledgment before launching the primary ACP/Codex child or
releasing the holder.
If the probe is aborted, its Promise must not settle through the abort race before the group
acknowledgment. If its cleanup is unconfirmed, the run does not start the primary child and the
holder becomes `cleanup_unconfirmed`.

`prepareLogin` is not an owned child and creates no admission row. A manual vendor CLI started
by the owner is outside this ledger; it cannot be prevented or counted by Guanxi.

## Lifecycle extension (`process.ts`, root review required)

`packages/server/src/external-agents/process.ts` is shared lifecycle code. The minimal extension
is:

```ts
export type ProcessCleanup =
  | { confirmed: true; reason: 'group_empty' | 'no_child' | 'spawn_failed' }
  | { confirmed: false; reason: 'group_timeout' | 'permission_denied' | 'close_error' | 'unsupported_platform' }
```

- `AgentProcess.close(): Promise<ProcessCleanup>` becomes idempotent and returns a cached outcome.
  It preserves the existing abort-path protocol cancel and the TERM/KILL sequence; after the
  primary close it performs one group-empty verification for the PID captured from that child.
  It must resolve the `closed` promise in a `finally` so a throwing close callback cannot hang
  the parent. Synchronous or asynchronous teardown errors are captured as `close_error`; the
  method returns an outcome rather than rejecting and losing the cleanup state.
- A shared helper, for example `awaitOwnedGroupEmpty(pgid, closed, deadline)`, awaits close,
  sends no signals after verification starts, maps `ESRCH` to `group_empty`, `EPERM` to
  `permission_denied`, other probe errors to `close_error`, and a deadline to `group_timeout`.
  It takes the in-memory `pgid`; it never accepts an ID from SQLite, a row, a file or a request.
- Replace `claudeAuthStatus` with `startClaudeAuthStatus`, returning
  `{ result: Promise<{ ok: true; status } | { ok: false; error }>; close(): Promise<ProcessCleanup> }`.
  The result is a discriminated union rather than a rejected Promise that loses the cleanup
  outcome. `close()` settles that result (with a stable error if necessary), then waits for the
  group acknowledgment before resolving. The service awaits `close()` in a `finally` that cannot
  skip marking/release.
- `JsonRpcClient.close()`/`AcpClient.close()`/`CodexClient.close()` propagate the cleanup outcome
  after awaiting their reader. A close rejection is converted to an unconfirmed outcome rather
  than silently treated as success.
- Spawn failure before a PID exists is `no_child`/`spawn_failed`; it is not probed. A synchronous
  spawn throw means no owned group. If a child exists with a PID, even after an error event, it
  is treated as owned and must be cleaned.

Limits and boundaries:

- POSIX process-group cleanup is the only confirmed group boundary; it reaches ordinary
  same-UID descendants that remain in that group. On Windows, or where a descendant escaped with
  `setsid`/`setpgid`, the acknowledgment cannot prove all descendants are gone; document that
  explicitly. On Windows this slice returns `unsupported_platform` for group confirmation rather
  than falsely releasing. A later Job Object implementation is a separate design.
- Signals only target a group ID captured from an in-memory child. No recovery code probes or
  kills a row's numeric PID. No PID is stored.
- Signal operations are not retried after the verification deadline. A still-live or
  permission-denied group is `cleanup_unconfirmed`, not a reason to release.
- No new spawn flags, shell, network, sandbox, environment inheritance or stdio behavior.

## Service dataflow

```text
run(input)
  -> resolve role / validate installation / owner boundary
  -> K3 dispatchAgent: original-author + payment + key injection
  -> BEGIN IMMEDIATE: read rows, policy digest, learned ceiling, insert held
  -> optional abort rechecks after each async preflight await
  -> acquire API-key/isolated dirs and executable metadata (no child yet)
  -> optional claudeAuthStatus probe (owned group; await result + cleanup)
  -> pre-spawn abort recheck
  -> spawn primary ACP/Codex child
  -> run / prompt
  -> abort/timeout/failure or success
  -> protocol cancel + TERM/KILL + child close + group-empty acknowledgment
  -> confirmed: DELETE exact holder; unconfirmed: UPDATE cleanup_unconfirmed
  -> decrement activeOnThisNode; durableLocalOccupancy reflects the row
```

`signInWithChatGPT` uses the same acquire with `kind='login'`, the same preflight/abort checks,
and the same cleanup acknowledgment before releasing. It is exclusive with all runs/logins in
the group.

## Failure-state matrix

| Situation | Holder/child state | Surface | Recovery |
| --- | --- | --- | --- |
| Group at ceiling | no new row, no child | `account_busy` | retry after confirmed release |
| Login present, run requested | no new row, no child | `account_busy` | wait for login cleanup |
| Any run/login present, login requested | no new row, no child | `account_busy` | wait for quiescence |
| Digest/ceiling mismatch while occupied | no new row, no child | `account_policy_conflict` | quiesce group, then change policy |
| SQLite busy/SQL fault in acquire | rollback, no row, no child | `admission_unavailable` | retry; never fall back to memory |
| Preflight error before child | row held → exact delete/no_child | original stable error | no process cleanup needed |
| Abort during async preflight | no child; exact delete after recheck | `cancelled` | no dispatch |
| Auth probe abort/failure | probe group cleaned; no primary | `cancelled` or auth error | holder released only after probe ack |
| Auth probe cleanup unconfirmed | row `cleanup_unconfirmed`; no primary | `cleanup_unconfirmed` | operator review; no auto-retry |
| Spawn failure/no PID | no owned group; exact delete | `agent_failed`/stable spawn error | no process cleanup |
| Run abort/timeout/success | child/group acknowledged | `cancelled`/`timeout`/success | exact delete |
| Child close callback/probe error | row `cleanup_unconfirmed` | `cleanup_unconfirmed` | no replacement |
| Exact release SQL fault | row retained (`held`) | `admission_release_failed` | restart sees occupied row |
| Cleanup-mark SQL fault | row remains `held` | `admission_release_failed` | restart sees occupied row |
| Plugin close | abort all tasks and await them before store close | task errors settle individually | clean rows deleted, uncertain rows retained |
| Process crash/SIGKILL | rows remain `held` | new instance sees occupancy | no boot cleanup, no wall-time expiry |
| Old holder release after replacement | exact holder ID does not match | zero changes | another holder unaffected |
| Manual `prepareLogin` | no row, no owned child | descriptor only | outside ledger by design |

## Compatibility and safe policy change

- The v1 SQL, tables, rows and `k5_migrations` row `1` are preserved. v2 adds only the table,
  index and row `2`. Fresh v1 creation and v2 append may share one transaction; an existing v1
  sidecar appends v2 only. Reopening v2 is a no-op.
- The sidecar's `PRAGMA user_version` is never written; it stays at its prior value (normally 0).
  The main `guanxi.db` `user_version` (currently 33) and `MIGRATIONS` are untouched. This slice
  does not consume a global migration.
- Existing `activeOnThisNode` remains the number of live tasks this instance owns (including an
  owned login). It is never the admission gate. Add to the trusted `limits()` result:
  `durableLocalOccupancy: { held, cleanupUnconfirmed, total }`, derived from the sidecar.
- An old K5 binary ignores the v2 table and would bypass durable admission. Rolling back to it
  requires quiescing all K5 processes and stopping the plugin; never run old K5 concurrently with
  v2 holders. The sidecar and vendor directories are retained. A schema downgrade is not a
  supported way to clear holders.
- A safe operator policy change requires zero rows for the group, not merely zero live PIDs.
  Stop all K5 instances, verify the group has no `held`/`cleanup_unconfirmed` rows, then start
  with the new digest. If a row remains, do not delete it to force the change; a later audited
  administrative break is required. Once all rows are gone there is no permanent tombstone.
- `effective_bare` is additive to the existing open `facts` record. No REST/SSE schema is changed.
  If a wire projection later needs a new schema, that is a separate coordinated slice.

## Effective bare and diagnostics

Keep `bare` exactly as the explicit launch-policy fact:

- explicit `claudeBare: true` → `bare=true`, source `node_launch_policy`; subscription launch is
  refused before ACP spawn with `bare_subscription_unavailable`;
- explicit false → `bare=false`; omitted → `bare=null`;
- neither false nor omitted is evidence of the bridge/CLI's effective implicit bare state.

Add `effective_bare` with `{ value: null, source: 'not_observed', observedAt: null,
confidence: 'unknown' }` in this slice. Write the explicit fact object rather than the existing
helper that timestamps every null; there is no pseudo-observation time. A successful `auth status`
login, a stored login, a `--help` result, a false config or a missing flag must not promote it.
Only a future verified launch observation may write a known value; no producer or capture is
added here. Billing stays unknown for the same reason.

`durableLocalOccupancy` exposes counts only, not holder IDs, owner/account strings, vendor data,
raw errors or PIDs. An explicit orphan diagnostic with opaque IDs/state/age is a later design;
this slice's counts are enough to distinguish live instance occupancy from retained durable rows.

## Files and dependency order

| Order | Path | Change |
| --- | --- | --- |
| 1 | `packages/server/src/external-agents/types.ts` | admission kind/state, policy digest helper types, cleanup/diagnostic types, stable error names |
| 2 | `packages/server/src/external-agents/store.ts` | preserve v1 bytes; append v2 table/index; expose acquire/release/mark/occupancy methods; no `user_version` write |
| 3 | `packages/server/src/external-agents/admission.ts` (new) | canonical digest, effective ceiling, acquire/release state machine; optional if `store.ts` stays clearer, but one owner only |
| 4 | `packages/server/src/external-agents/process.ts` (root review required) | `ProcessCleanup`, idempotent close, group-empty verification, auth probe outcome |
| 5 | `packages/server/src/external-agents/service.ts` | replace in-memory gate with durable acquire; login/run rules; abort rechecks; cleanup-gated release; `durableLocalOccupancy`; `effective_bare` |
| 6 | `packages/server/src/external-agents/README.md` | current behavior, limits, crash/config-change/rollback/manual-login boundaries |
| 7 | `packages/server/test/external-agents/helpers.ts` | two-service/v1-sidecar/worker/DB-fault helpers; no production hooks |
| 8 | `packages/server/test/external-agents/admission-worker.ts` (new fixture) | bounded worker opening the same temp sidecar, acquiring, starting at most one fixture child, holding via IPC, releasing or crashing |
| 9 | `packages/server/test/external-agents/admission.test.ts` (new) | cross-process, ceiling, login, crash, SQL, v1, secret, release tests |
| 10 | `packages/server/test/external-agents/process-cleanup.test.ts` (new) | group-empty, auth descendant, no-child, close-error tests |
| 11 | `packages/server/test/external-agents/lifecycle.test.ts`, `policy.test.ts`, `adapters.test.ts` | abort/close hold, owner/K3 zero rows, effective bare, existing envelope |

No change is planned to `plugin.ts` except possibly passing the same store into the service; its
effect already closes the service before the store (`plugin.ts:28`). No `package.json`,
`package-lock.json`, contract, web, CLI, global migration, `PHASE_STATUS` or
`NEXT_AGENT_PROMPT` edit is in scope. If implementation needs a shared `plugin.ts` signature
change, list it as a shared edit in the handoff.

## Test matrix (fixture-only)

All tests use temporary data directories, fixture executables, no vendor CLI, no network, no
owner state and no model. The two-process tests use actual bounded Node child processes with a
temp sidecar; they are not mocks of the ledger. A `setsid`-escaped descendant is explicitly
outside the process-group proof; no test claims it is cleaned, and the docs keep that residual
visible.

| # | Assertion | Red on current behavior |
| --- | --- | --- |
| 1 | Two `ExternalAgents` instances with separate stores on one temp sidecar, same group, ceiling 1: exactly **1** fixture child starts; the second gets `account_busy` with **0** second `session/prompt`/`turn/start`; row count is 1. | Current each instance has its own `active` Map, so both can start. |
| 2 | Ceiling 2: exactly **2** concurrent same-group children; the third is refused with 0 launch; row count is 2. | Current per-instance cap can exceed 2 across services. |
| 3 | Ceiling 3: exactly **3**; the fourth is refused with 0 launch; row count is 3. | Same bypass. |
| 4 | Two actual Node worker processes (forked/spawned fixtures) open the same temp sidecar and acquire the same group, repeated at ceilings 1/2/3: exactly N workers acquire and each starts one bounded fixture child; the next worker reports busy and starts zero auth/model/fixture children. Kill one winner; a later worker/reopen still cannot take its slot until an explicit exact release. | No cross-process row exists; a reopened service sees a free slot. |
| 5 | Same owner/adapter/billing account with two different `connectionId`s: ceiling 1 admits exactly one; the second connection is refused. Same account different backend/adapter or different account is isolated. | Group is connection-blind only in memory; cross-instance bypass. |
| 6 | Login vs run in one group: one starts, the other gets `account_busy`; a held login blocks every run and every other login; a run blocks login. Count starts, not just outcomes. | Separate instance maps allow both; the current local check is not durable. |
| 7 | K3 owner/payment refusal (second actor, subscription editor, revoked grant) yields `0` fixture starts and `0` `k5_admission` rows; the refused promise never acquires. | Current K3 refusal already has no row; this is a regression guard for the new order. |
| 8 | Abort during a delayed directory/executable preflight (`mkdir`/`realpath` deferred by a mock): no child starts, exactly one holder existed then is released, and the run rejects `cancelled`; no second dispatch. | Current has no durable row and no explicit post-preflight recheck test. |
| 9 | Abort after auth-status preflight but before primary spawn: auth probe group is cleaned, primary starts **0** times, holder is released or marked unconfirmed exactly once. | Current can release through the abort race without a probe cleanup proof. |
| 10 | Hold a run until a controlled `AgentProcess.close` acknowledgment: while close is deferred, the run is unsettled, the child is alive and the durable row is `held`; after release, the row is gone and a new same-group run is admitted exactly once. | Current only has an in-memory count and releases in `finally`. |
| 11 | A same-group descendant survives the primary adapter's EOF: after abort and close, the descendant PID is `ESRCH` **before** the row is deleted; if it never disappears, the row becomes `cleanup_unconfirmed` and no replacement starts. | Current sends SIGKILL after `closed` but never proves group emptiness. |
| 12 | Claude `auth status` descendants: abort while the probe parent/descendant are alive; the run does not settle/release before both are gone; after cleanup the row is gone; a delayed write marker is absent. | Current auth probe returns without a group-empty acknowledgment. |
| 13 | Cleanup failure for a run or owned login: a close rejection, a throwing close callback after the child actually exits, or `ProcessCleanup{confirmed:false}` retains the row as `cleanup_unconfirmed`, surfaces `cleanup_unconfirmed`, starts **0** replacement children, and leaves `activeOnThisNode` at 0 while `durableLocalOccupancy.total` is 1. Reopen still shows `cleanup_unconfirmed`. | Current releases in the nested `finally` even when close rejects. |
| 14 | Crash/restart: a worker acquires a holder and is SIGKILLed. Reopen with a new instance and a clock advanced by at least a year; the row is still `held`, `account_busy` is returned at ceiling, **0** resumed inference and **0** second fixture child occur. No boot delete, TTL query or PID probe runs. | No durable row exists, so a new service would admit. |
| 15 | Exact release: release holder A, acquire holder B in the same group, then release A again. B remains and the row count is 1; duplicate exact release is idempotent; no group-wide delete exists. | No holder API; a naive group delete would fail the new assertion. |
| 16 | Open-DB SQL fault: a separate connection installs a `BEFORE DELETE`/`BEFORE UPDATE` trigger that aborts the release/mark. The promise rejects `admission_release_failed`; the row is retained; after dropping the trigger an exact release succeeds. A closed DB during teardown surfaces the same failure and reopening shows the on-disk row. | Current catches/hides close errors and has no release SQL path. |
| 17 | v1 upgrade: a hand-built v1 sidecar with roles, grants, quota and learning rows opens once, gains only v2, preserves every v1 row, keeps `k5_migrations` 1 and sidecar `user_version` unchanged, and reopens idempotently. DB/WAL/SHM stay `0600`; directory stays `0700`. | Current has no v2 table or upgrade test. |
| 18 | Global version isolation: capture the main test DB `PRAGMA user_version` before and after opening the K5 sidecar (currently 33); it is unchanged and `MIGRATIONS` is untouched. No migration 34+ is consumed. | No explicit guard today. |
| 19 | Concurrent migration/claim: two workers open a v1 sidecar and acquire simultaneously; migration succeeds once without `table already exists`, exactly the ceiling admits, and no occupancy row is lost. | No v2 migration or cross-process claim. |
| 20 | Policy conflict: process A holds with digest/ceiling 3; process B configured with ceiling 1 (different digest) is refused `account_policy_conflict` with 0 launch, even if current count is below both ceilings. The same applies to an old `held` or `cleanup_unconfirmed` row. With all rows gone, a new digest acquires successfully (no permanent lock). | Current has no digest and a looser process can bypass. |
| 21 | `prepareLogin` returns only the descriptor, creates **0** admission rows, starts no child and does not change `activeOnThisNode`; manual CLI execution remains outside the ledger. | Current has no row; regression guard. |
| 22 | `activeOnThisNode` remains instance-local while `durableLocalOccupancy` reports durable counts. A second instance sees 0 active but the correct durable total; a cleanup-unconfirmed row is visible only in durable counts. | Current `limits()` has only the in-memory count. |
| 23 | Explicit `claudeBare:true` refuses subscription before ACP spawn; `bare` is true, `effective_bare` stays null/unknown. False or omitted bare plus a successful logged-in fixture also leaves `effective_bare` null/unknown; login/help/status does not promote it. | `effective_bare` does not exist; no assertion prevents false inference. |
| 24 | Registered canary secret is absent from every `k5_admission` column, all sidecar tables, raw DB/WAL bytes, session events, errors and `durableLocalOccupancy` output. Schema whitelist has no argv/env/auth JSON/email/organization/PID column. | New table could accidentally store payload or debug context; no guard yet. |
| 25 | No arbitrary process recovery: the schema has no numeric PID/PGID; a source scan of admission/store/service shows no `process.kill`; `process.ts` signals only in-memory child handles. Stale rows are counted, not probed. | No durable rows today; guard for the new design. |
| 26 | Existing K5 envelope stays green: all six adapters, role precedence, owner/editor refusals, static and runtime credential traps, ACP/Codex cancellation/descendant cleanup, auth login/unload/timeout, private directories, quota and learning. No test is weakened or skipped. | Regression envelope, not new evidence. |
| 27 | Spawn failure/no child: a direct probe with a missing executable and an injected spawn error returns `no_child`/`spawn_failed` without probing a PID; a service preflight that removes the executable after resolution performs zero launches and releases the exact holder. | No cleanup outcome or durable row exists today. |

### Semantic red-before-code proof

Before production behavior lands, add the service-level behavioral tests that fail on the pinned
HEAD for semantic reasons, not compile errors:

- two services at ceiling 1/2/3 (both currently start);
- login/run competition across two instances (both currently can start);
- crash/reopen/time-advance (no row, so the new service currently admits);
- policy conflict between two instances with different ceilings (both currently admit);
- cleanup failure retaining occupancy (current `finally` releases in-memory state);
- `effective_bare` unknown after a successful logged-in fixture (fact currently absent).

Store/API tests for the v2 table, exact-holder release, SQL faults and migration are added after
the minimal interfaces exist, then the suite must be observed red with the admission gate
disabled before the final green run. Record each observed failure reason; a test that only fails
because an import is missing is not semantic red evidence.

### Mutation proof after implementation

Remove one guard at a time and require its named assertion to fail:

| Mutation | Must fail |
| --- | --- |
| Make `acquire` create no row / always return a token | tests 1–4, 6, 14 |
| Count only `held`, not `cleanup_unconfirmed` | tests 13, 14, 22 |
| Ignore policy digest | test 20 |
| Treat `login` like a run for counting | test 6 |
| Release by group/connection instead of exact holder | test 15 |
| Delete on close rejection or skip `cleanup_unconfirmed` | test 13 |
| Catch release/mark SQL failures as success | test 16 |
| Sweep rows at boot/on missing in-memory task or by wall time | test 14 |
| Skip group-empty verification after primary EOF | tests 11, 12 |
| Promote `effective_bare=false` from login/config | test 23 |
| Store a PID/payload/debug object in the row | tests 24, 25 |
| Let `prepareLogin` acquire a login holder | test 21 |

## Migration and rollback

- **Upgrade:** stop all K5 instances; take a consistent stopped sidecar (with WAL) backup for a
  real data directory; start the new binary, which appends v2 atomically. Fresh databases create
  v1 then v2 in one transaction; existing v1 appends v2 only; existing v2 is a no-op. A failed v2
  transaction rolls back, closes the DB and leaves v1 intact with no row `2`; reopening retries.
- **Rollback:** disable the K5 plugin and retain `external-agents.sqlite`, its WAL/SHM and vendor
  directories. Do not drop the v2 table as a cleanup shortcut and do not use a down migration.
  To return to an older K5 binary, quiesce all K5 processes and restore a stopped pre-upgrade
  backup if durable admission must be discarded. An old binary does not honor v2 rows; never run
  it concurrently with a v2 sidecar or claim that schema downgrade safely clears unresolved
  holders.
- **No automatic recovery:** `cleanup_unconfirmed` and crash `held` rows are intentionally
  retained. An audited administrative break is a later, separately reviewed contract; this slice
  provides no delete-all, PID probe, TTL, boot reconciliation or inference retry.
- **Unresolved data conflict owner:** the K5 implementation owner reports retained groups in the
  lane handoff; the root decides any future administrative break. No central status edit is part
  of this plan.

## Validation scope

### DSH scoped test scope (author)

The implementation author may run focused, fixture-only commands inside the clone under
`nice -n 10`, without `agent-dev`, installation, containers, browser, build, full suite or
network. DSH may use the process tests while developing, but its result is not a host-process
claim: only the root's unmodified rerun of the admission/cleanup tests at the clean pin, under
the shared heavy lock, counts as the real-process gate.

```bash
nice -n 10 node --test \
  packages/server/test/external-agents/admission.test.ts \
  packages/server/test/external-agents/process-cleanup.test.ts \
  packages/server/test/external-agents/lifecycle.test.ts \
  packages/server/test/external-agents/policy.test.ts \
  packages/server/test/external-agents/adapters.test.ts \
  packages/server/test/external-agents/codex-login.test.ts \
  packages/server/test/external-agents/boundaries.test.ts \
  packages/server/test/external-agents/host-tools.test.ts
nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json
node packages/server/scripts/check-vendor-credentials.ts
```

This is targeted evidence only. It does not prove the host process gate, full regression,
browser, build, licenses, Markdown or a real vendor release. The author must state the exact
new/envelope counts and any test that could not run.

### Root-only heavy and real-process gate

The root reruns the unchanged admission tests and the actual two-worker/crash/cleanup gate on
the host, then runs the project gates through the shared heavy lock:

```bash
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- \
  node --test packages/server/test/external-agents/admission.test.ts \
  packages/server/test/external-agents/process-cleanup.test.ts
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm test
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm run typecheck
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm run build
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm run lint:md
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm run check:licenses
node packages/server/scripts/check-vendor-credentials.ts
```

No browser gate is required because no web source changes. The root records receipts, confirms
the checkout is clean and unchanged at the tested pin, and distinguishes **new** tests from the
**regression envelope**; a headline total is not new-test evidence. The root-owned Colima
runtime is not used, no container is needed, and no SSH/remote is authorized.

### Independent review

After implementation and the author's red/green evidence, the root arranges a fresh-context,
read-only GPT review on the exact clean pin. The reviewer receives the diff, this plan, the
observed red failures and the mutation list, and checks at least:

- every claimed property has a failing assertion when its guard is removed;
- two actual processes share the sidecar and exact ceilings/login rules hold;
- cleanup ACK semantics, abort races, crash restart, no-TTL/no-PID-recovery and SQL error paths;
- v1/global-version compatibility and private permissions;
- owner/payment/K3 order, no secret/PID/vendor-data persistence and effective-bare honesty;
- tests are not weakened, skipped or only indirectly proving the property.

Findings are fixed in a separate commit; the author does not self-certify. The original K5
Claude cross-family review and full K5 closure remain separate open obligations.

## Assumptions and open engineering defaults

- `GROUP_ACK_MS` is an engineering cleanup-verification bound (suggested 2–5 seconds, not a
  reservation TTL). A deadline produces `group_timeout`/`cleanup_unconfirmed`, never a release.
- POSIX process groups are the confirmed boundary; Windows Job Objects and escaped `setsid`
  descendants are explicitly outside proof in this slice.
- Stable error codes are `account_busy`, `account_policy_conflict`, `admission_unavailable`,
  `admission_release_failed` and `cleanup_unconfirmed`. They are internal
  `ExternalAgentError` codes, not a new wire contract.
- `durableLocalOccupancy` is an additive trusted-kernel diagnostic; if a consumer needs a
  different shape, it is a separate contract decision.
- No new owner decision is required for this bounded local development. Root review is the
  authorization gate before source edits. No main, PHASE/NEXT, approval, push, merge or rebase
  operation is part of this slice.

## Plan pin and next action

This document is committed as a docs-only plan on `codex/k5-durable-admission`. The root reviews
the plan before authorizing source changes. The next action after approval is the red test phase,
then the minimal `process.ts`/store/service implementation, then the independent GPT review.

## Root review and bounded implementation authorization — 2026-10-22

The root reviewed the complete plan against the current K3/K5 call sites at planning commit
`361d4cb251858a544e57e91d8dd041dd727b576e`. Local implementation is authorized under the
owner's continuing development mandate, with these clarifications:

- The shared lifecycle edits listed above (`process.ts` and client cleanup propagation) are
  authorized only for this cleanup-acknowledgment boundary. Preserve existing spawn flags,
  authentication, protocol cancellation, environment isolation and transport behavior.
- `activeOnThisNode` already includes owned login because that path inserts into `active`.
  Preserve its exact instance-local count; add durable occupancy separately.
- Preserve the existing K3 authorization snapshot/order. This slice does not claim a new
  mid-flight grant-revocation guarantee or change `Connections.dispatchAgent`. Recheck the
  abort signal after each asynchronous preflight step and immediately before every owned spawn.
- `effective_bare` may be added as an unknown observation using the existing open facts record
  and nullable observation time. No wire-contract expansion is needed. Never derive it from
  configured bare, login success, version or help output.
- A cleanup-verification deadline yields an unconfirmed outcome and retained occupancy. It is
  never evidence that a process exited. Do not substitute `ps` state parsing for group `ESRCH`.
  A throwing close callback must not prevent physical close observation from settling.
- The v1 upgrade assertion preserves migration row 1 and appends row 2; it does not leave only
  row 1. Schema/global-version/permission assertions must be explicit.
- Record observed semantic red/green evidence without persisting prompts, secrets or reasoning.
  Targeted DSH fixture tests are author evidence; real two-process/cleanup and project gates
  remain root-coordinated checks at a clean frozen pin under the shared heavy lock.

After the focused source/test commits, write a lane handoff and stop for independent review.
Do not change central status, claim full K5/MS1 completion, merge other branches or push.

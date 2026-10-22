# K5 durable same-node admission — lane handoff

**Status:** implementation and author evidence complete; stopped for independent review ·
**Updated:** 2026-10-22
**Branch:** `codex/k5-durable-admission` (standalone clone, `.git` inside)
**Root-authorized base pin:** `eb5be7541a00af4319a7fff4acf73a600606773c`
**Implementation pin:** `e5780495c601db2ca4b0640eecd49c3470d8cab3`
**Bounded plan:** `docs/plans/lanes/K5-durable-admission.plan.md`, including the final Root
review authorization. This is one bounded slice, not full K5.

## Outcome

Two K5 service instances and two actual Node worker processes sharing one
`external-agents.sqlite` sidecar cannot exceed the same account group's effective local
ceiling. The group is exactly `(ownerAccountId, adapter, billingAccount)`; connection IDs do
not create a slot. A transaction (`BEGIN IMMEDIATE`) checks the held policy digest, reads the
learned rejection ceiling, counts `held` and `cleanup_unconfirmed` rows, and inserts one opaque
holder. Login is exclusive with every run and login; a run blocks login. A policy/ceiling
conflict is refused while any row exists and succeeds once the group is quiescent.

A holder is deleted exactly and only after every owned child/group acknowledges cleanup: the
primary `close` event plus, on POSIX, an in-memory process-group `ESRCH` observation. Cleanup
uncertainty, a crash, a close rejection or a verification deadline marks the row
`cleanup_unconfirmed` and keeps it occupied. There is no TTL, PID probe, boot sweep, retry or
automatic replacement. SQL release/mark failures surface `admission_release_failed`; they never
report success.

`activeOnThisNode` remains the instance-local live-task count, including an owned login.
`durableLocalOccupancy: { held, cleanupUnconfirmed, total }` is additive. `prepareLogin` owns no
child and takes no holder. `effective_bare` is an explicit
`{ value: null, source: 'not_observed', observedAt: null, confidence: 'unknown' }` fact; neither
a configured false, a stored login, a successful `auth status` nor help output promotes it.

## Changed files

Source:

- `packages/server/src/external-agents/types.ts` — admission kinds/states, request/grant,
  occupancy and cleanup-reason types.
- `packages/server/src/external-agents/admission.ts` (new) — canonical SHA-256 policy digest and
  effective ceiling. No raw policy object is stored.
- `packages/server/src/external-agents/store.ts` — untouched v1 SQL, append-only v2
  `k5_admission` table/index/row 2, transactional acquire, exact release, cleanup marking and
  counts. `PRAGMA user_version` is never written.
- `packages/server/src/external-agents/process.ts` — cached idempotent `ProcessCleanup`,
  bounded group-empty verification, transient-EPERM probing, robust close-event settlement,
  and `startClaudeAuthStatus` with a discriminated result and cleanup-gated `close()`.
- `packages/server/src/external-agents/rpc.ts` — client close propagates the cleanup outcome
  and converts a reader failure/deadline to `close_error`; `acp.ts` forwards it. `CodexClient`
  inherits the same path.
- `packages/server/src/external-agents/service.ts` — durable run/login acquisition after K3
  checks, abort rechecks after each async preflight and immediately before each spawn, login
  exclusivity, cleanup-gated release/marking, `durableLocalOccupancy`, `effective_bare`, and
  required auth-probe settlement before the primary child.
- `packages/server/src/external-agents/README.md` — current behavior, limits, POSIX/Windows
  boundary, migration/rollback and no-TTL/no-PID rules.

Tests/fixtures:

- `packages/server/test/external-agents/admission.test.ts` — 27 tests covering ceilings,
  cross-service and cross-process claims, login, connection-ID blindness, policy conflict,
  effective bare, K3 zero-row order, delayed preflight abort, auth-probe abort, deferred close,
  unconfirmed cleanup, exact release, SQL faults, closed DB, v1 upgrade, global version,
  concurrent migration, crash/restart, prepareLogin, occupancy, canary/schema/source scans.
- `packages/server/test/external-agents/admission-worker.ts` (new) — bounded fixture worker
  using the production store/service against a temp sidecar; starts at most one fixture child.
- `packages/server/test/external-agents/process-cleanup.test.ts` (new) — 6 direct tests for
  cached group-empty ACK, real descendant cleanup, auth-probe result+cleanup, missing executable,
  Windows `unsupported_platform` and ESRCH/EPERM/close-failure mapping.
- `packages/server/test/external-agents/fixture-process.mjs` — writes its own temp `adapter.pid`
  so a test can clean a crash fixture. Test-only metadata; production never persists a PID.
- `docs/plans/lanes/K5-durable-admission.handoff.md` — this handoff.

No edits to `plugin.ts`, `connections/service.ts`, contract, web, CLI, package manifests,
lockfile, global migrations, `PHASE_STATUS`, `NEXT_AGENT_PROMPT`, roadmap, approval or source
outside this clone. Shared lifecycle edits are limited to the root-authorized
`process.ts`/`rpc.ts`/`acp.ts` cleanup-acknowledgment boundary.

## New / regression envelope

- **New: 33 tests** — 27 in `admission.test.ts`, 6 in `process-cleanup.test.ts`. No skips.
- **Regression envelope: 66 tests** — the existing five K5 files plus codex-login, boundaries
  and host-tools. No existing test was weakened, skipped or removed.
- **Total targeted run: 99 tests, 99 passed, 0 failed, 0 skipped, 0 cancelled.**

These are author fixture tests. They do not replace the root's unmodified real-process/cleanup
and project gates under the shared heavy lock.

## Observed semantic red before implementation

The pinned implementation (`eb5be75`) failed these tests for semantic reasons, not missing
imports:

| Test | Observed failure at red |
| --- | --- |
| two K5 services sharing one sidecar cannot exceed the same account ceiling | second service started and hung; race returned `timeout`, expected `account_busy` |
| a login held by one service is exclusive with every run and login | peer run returned `ok` (started), expected `account_busy` |
| a different configured ceiling for an occupied group is refused | second service started and hung; race returned `timeout`, expected `account_policy_conflict` |
| effective_bare stays unknown after a successful logged-in Claude fixture | `facts.effective_bare` was `undefined`, expected explicit null/`not_observed` |

The red tests were committed first as `1fe9968`; the implementation follows. Store/API tests
for v2, exact release, SQL faults and migration were added after the minimal interfaces.

## Green evidence (author, DSH fixture scope)

All commands used `PATH=/opt/homebrew/opt/node@26/bin:$PATH` (Node **26.9.0**) and
`nice -n 10`; no `agent-dev`, install, build, browser, network, vendor CLI or owner data.

| Command | Result |
| --- | --- |
| `node --test admission.test.ts process-cleanup.test.ts lifecycle.test.ts policy.test.ts adapters.test.ts codex-login.test.ts boundaries.test.ts host-tools.test.ts` | 99 tests, 99 pass, 0 fail, 0 skipped, 0 cancelled |
| `npx tsc --noEmit -p packages/server/tsconfig.json` | exit 0, no output |
| `node packages/server/scripts/check-vendor-credentials.ts` | `Vendor credential boundary: passed` |
| `npx eslint` on changed source/test files | exit 0, no output |

## Mutation proof

Thirteen temporary guard removals were run under the same fixture scope; each produced a
nonzero test exit and its named assertion failed. Every mutated file was restored and
`git diff --quiet` confirmed a clean tree.

| # | Mutation | Assertion killed |
| --- | --- | --- |
| 1 | acquire inserts no row | ceilings 2 and 3 |
| 2 | count only `held`, not `cleanup_unconfirmed` | unconfirmed cleanup retains occupancy |
| 3 | ignore policy digest | different configured ceiling |
| 4 | login is not exclusive | login held by one service |
| 5 | group-wide release instead of exact holder | exact release cannot delete another holder |
| 6 | release despite unconfirmed cleanup | unconfirmed cleanup retains occupancy |
| 7 | hide release SQL failure as success | release and marking SQL faults |
| 8 | boot sweep deletes holders | crash-retained holder |
| 9 | skip group-empty proof | group acknowledgement mapping |
| 10 | promote `effective_bare` false | effective_bare stays unknown |
| 11 | add a numeric PID column | canary/schema whitelist |
| 12 | `prepareLogin` takes a login holder | prepareLogin owns no child |
| 13 | hide mark SQL failure as success | release and marking SQL faults |

Result: **13 / 13 mutations killed**.

## Migration and rollback

- v1 SQL, tables, rows and `k5_migrations` row `1` are preserved. v2 appends `k5_admission`,
  `k5_admission_group` and row `2` in the same `BEGIN IMMEDIATE` transaction. A fresh sidecar
  creates both; an existing v1 appends only v2; reopening v2 is a no-op.
- The sidecar `PRAGMA user_version` is never written (a v1 fixture with `7` stays `7`; a fresh
  sidecar stays `0`). The main database `MIGRATIONS` and `user_version` are untouched.
- DB/WAL/SHM are `0600` and the temp directory is `0700` in the upgrade test.
- Rollback disables the K5 plugin and retains the sidecar, WAL/SHM and vendor directories. An
  older K5 binary ignores v2: quiesce all K5 processes before rollback and never run old and
  new K5 concurrently on one sidecar. Do not drop v2 or downgrade the schema to clear holders.
- `cleanup_unconfirmed` and crash `held` rows are retained intentionally. This slice provides no
  delete-all, admin break, TTL, PID probe, boot reconciliation or inference retry. A retained
  group is reported here; the root decides any future audited administrative break.

## Decisions and boundaries

- Group identity excludes `connectionId`, executable, version, process and time. Two
  connections for one owner/adapter/billing account share one slot set.
- The digest contains only `schema`, `nodeId`, `ownerAccountId`, `adapter`, `billingAccount` and
  `operatorCeiling`. Learned observations, connection IDs, timestamps, prompts and credentials
  are excluded.
- `effectiveCeiling = min(operatorCeiling, rejectedAt === null ? Infinity : max(1, rejectedAt - 1))`.
  Success never raises it; a learned rejection never raises the operator ceiling.
- `held` and `cleanup_unconfirmed` both count as occupied. There is no `released` row.
- Release is `DELETE ... WHERE holder_id=? AND instance_id=? AND state='held'`; duplicate exact
  release is idempotent and cannot affect another holder.
- A confirmed cleanup reason is `group_empty`, `no_child` or `spawn_failed`. Unconfirmed reasons
  are `group_timeout`, `permission_denied`, `close_error` or `unsupported_platform`.
- The auth-status probe is a separate owned group under the same run holder; its result and
  cleanup settle before the primary spawn or holder release. `prepareLogin` remains outside the
  ledger because Guanxi cannot own or block the manually started vendor CLI.
- POSIX same-UID process groups are the only confirmed boundary. Escaped `setsid`/`setpgid`
  descendants and Windows are outside it; Windows returns `unsupported_platform` and retains
  the holder. A Job Object remains a separate future design.
- No timer turns an unknown cleanup into a confirmed release. The deadline is a cleanup
  verification bound, not an admission lease.
- `activeOnThisNode` is unchanged in meaning; `durableLocalOccupancy` is a counts-only additive
  diagnostic with no holder IDs, account strings, vendor data, errors or PIDs.
- No REST/SSE/contract/web/CLI change. No new dependency, copied code, spawn flag, environment,
  stdio, network, sandbox, host-tool or authentication behavior.

## Unresolved hazards and unverified scope

- Root must rerun the unchanged real-process/cleanup tests and the project gates at this clean
  pin under `/Users/yuzuru/.local/state/agent-dev` and the heavy lock. DSH fixture results are
  not a host-process or full-regression claim.
- This is same-node admission only. It is not distributed admission, a designated account
  authority, fencing, signed leases, a vendor concurrency cap, a quota producer, vendor release
  capture or certification. It does not coordinate other data directories, manual vendor
  clients or other nodes.
- POSIX group acknowledgment cannot prove that an escaped/detached descendant is gone; Windows
  confirmation is intentionally retained as unconfirmed.
- The SQLite sidecar is multi-writer only through `BEGIN IMMEDIATE`/busy handling; a process
  that cannot acquire the write lock surfaces `admission_unavailable` rather than queuing a
  second in-memory gate.
- `auth status` parsing remains a bounded official-CLI observation, not proof of billing,
  implicit bridge flags or future vendor defaults. `effective_bare` stays unknown.
- Crash retention is deliberate: an operator cannot clear `cleanup_unconfirmed` through this
  slice, so a retained group refuses new work until a separately reviewed administrative break.
- The author did not run `npm test`, browser, build, full lint/Markdown, licenses, installations,
  containers, SSH, provider/model calls or real vendor CLIs.

## Root gate commands (not run here)

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

No browser gate is required because no web source changed.

## Commit history

```text
1fe9968 test(k5): add semantic red tests for durable admission
a55df7d feat(k5): add durable same-node account admission
e578049 test(k5): cover durable admission, cleanup and crash recovery
```

This handoff is a separate docs commit. The tree is clean on `codex/k5-durable-admission` at the
implementation pin above. Stop here for the root-coordinated independent GPT review; do not
merge, push, rebase or claim full K5/MS1 completion.

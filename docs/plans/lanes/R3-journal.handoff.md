# R3 local judge observation journal hand-off

**Status:** implemented; independent review closed with no remaining blocking findings; focused
and build gates pass; the full test gate has 49 inherited sandbox/process failures (see below).
**Branch:** `deepseek/r3-observation-journal` · **Base:** `0ab58729`
**Updated:** 2026-10-23 · **Environment:** local clone, Node 26.9.0, ports 5234/4434,
`GUANXI_DATA_DIR=$PWD/.lane-data`; generated fixtures only. No live model, SSH, remote network,
owner data or push.

## What was built

D-199 local sidecar in the relay plugin's SQLite. One row per actually evaluated judge request
(J1.5 checker, J2, J3), written at the cascade's single `request()` point through a small
`JudgeJournal` interface (the cascade imports no SQLite). A row contains run/session/attempt ids,
cycle, phase, layer, reason, request key, the exact scrubbed judge-visible packet (paths
included), the detached host `JudgeObservation`/policy/signals when the executor supplied them,
terminal state and result (sample verdicts, checker result or fixed unavailable/invalid/canceled
code), and start/finish timestamps. A duplicate request that reuses a stored result adds no row;
`UPDATE` is refused by a trigger. A synchronous or asynchronous local journal failure is
contained after the fenced verdict is persisted and never rewrites it.

Additive independent ledger **42** (`relay_journal_migrations`); `user_version` (33), ledgers
35/38 and every existing table are untouched. The plugin creates the journal lazily on the first
cascaded execution (a node with no judge creates no journal table) and purges expired rows every
10 minutes. An executor given a cascade defaults to the journal; `journal: null` turns it off; a
bare `RelayJudgeCascade` without a journal creates no table.

**Retention/egress.** Rows use the implemented D-113 reasoning window
(`DEFAULT_REASONING_RETENTION_MS`, 7 days), shortened by a parent Thread TTL, never extended.
`purgeExpired`, `purgeRun` and `purgeSession` are the explicit paths; `ON DELETE CASCADE` from
`durable_runs` removes rows with the owning run. Expiry is enforced on read as well as by the
timer. The scrubber must be ready before an insert or a read; every
packet/observation/result/signal is scrubbed at insert and again on read, so a registered secret
never enters a row or comes back out of one, while paths intentionally remain (D-199). Identity
fields are refused if they contain a registered secret. No route, contract, event, wake packet,
handoff, federation message or log reads the journal. There is deliberately no REST reader.

**Replay reader.** `readJournalReplay`/`readJournalCorpus` turn a finished run's J2 rows into the
strict R3-b v1 `ReplayRun`/`ReplayCorpus` (`origin: 'recorded'`). The reader uses the recorded
observation and policy, refuses unfinished runs and expired rows, refuses rows whose recorded
signals disagree with the observation re-evaluated under that policy, and derives
`claimsDone`/`acceptancePassed` conservatively from the packet's item statuses and current-head
gates. Labels stay empty unless the caller supplies owner ground truth; a reader never invents a
fault class.

## New tests (13)

`packages/server/test/relay/judge-journal.test.ts`:

1. A bare cascade with no journal and an executor with `journal: null` create no journal table.
2. Default executor wiring writes exactly one completed J2 row per boundary with packet,
   observation, policy, signals, result and timestamps; duplicate insert is a no-op; `UPDATE` is
   refused; ledger 42 is present and `user_version`/ledgers 35/38 stay unchanged.
3. `purgeSession`, `purgeRun` and `purgeExpired` delete; a parent Thread TTL and a custom
   `retentionMs` shorten expiry; run deletion cascades; a secret is absent from the row.
4. Cascade → journal → reader → `parseReplayCorpus` → `score`: every replayed step re-evaluates
   to exactly the recorded signals, the expected detector outcome is reproduced, a tampered
   signal row and an unfinished run are refused.
5. A path canary stored only in the journal observation (and a registered secret) appears in no
   wake packet, relay handoff, signed F2 dispatch grant, real session-export route or captured
   console output; the path is present in the row and the secret is not. Source guards fail if
   leads, handoff, dispatch, federation or export producers start reading the journal.
6. A synchronous journal failure leaves the completed judge request/verdict unchanged.
7. Checker, J2 and J3 evaluations produce J1.5/J2/J3 rows with their result shapes; a repeated
   request adds no row.
8. Expired rows are unreadable without the purge timer, a secret registered after the write is
   re-scrubbed on read, and an unready secret source refuses the insert.
9. Reader done-claim derivation covers current-head pass, fail, missing evidence and partial
   plans.
10. Plugin injection defaults to the journal, preserves explicit/null settings and does not
    construct a journal without a cascade.
11. Unavailable, invalid and abandoned evaluations are journaled with fixed result codes.
12. An asynchronous journal rejection is contained like a synchronous failure.
13. An existing journal table is found and purged without a cascade, and an identity field
    containing a registered secret is refused on write and withheld on read.

**New:** 13 tests in the one new file. **Regression envelope:** the full relay test directory
(255 tests) and the repository `npm run test` / `npm run build` gates below.

## Gates and receipts

| Gate | Result |
| --- | --- |
| `npm run typecheck` | pass (all workspaces, no diagnostics) |
| `npm run lint:md` | pass, 276 files, 742 links, 0 problems (re-run after final docs) |
| `npm run check:licenses` | pass, 675 packages, 0 not allowed |
| `agent-dev ... npm run test` | **exit 1**, receipt `check-a7f7yvz8`: server stage 2660 pass / 49 fail / 2 skipped; UI checks 6/6 and UI gates pass; the remaining stages are split out below because the aggregate stops at the server failure |
| `agent-dev ... npm run test:kernel` | **pass**, exit 0, receipt `check-2_rg1ym6` |
| `agent-dev ... npm run test:web` | **pass**, 649 tests, receipt `check-ro3rk4cv` |
| `agent-dev ... npm run test:ui` | **pass**, 49 tests, receipt `check-vs5t96g9` |
| `agent-dev ... npm run test:bench` | **pass**, exit 0, receipt `check-g0zi2lof` |
| `agent-dev ... npm run build` | **pass**, exit 0, receipt `check-oyzy8sms` |
| Focused journal/cascade/replay/host tests | 56/56 pass after review fixes |

The full test failures are environment-bound, not journal-bound:
`ms1/rehearsal` 18, `indexing/service` 10, `indexing/index` 8,
`external-agents/admission-reconcile` 4, `native-agent/agent` 3, `indexing/tools-lsp` 3,
`relay/operational-relay` 1, `native-agent/sandbox` 1, `indexing/process` 1. They are process
start-time/`ps`, Unix-socket, nested-sandbox and worker tests; the same failures reproduce on
main `0ab58729` (spot-checked `admission-reconcile`, `native-agent/sandbox`, `indexing/process`,
and `operational-relay`). No failure mentions the journal or cascade. This sandbox denies
`ps`/nested-sandbox operations, so these tests could not be made green here.

The shared `agent-dev` state directory is not writable from this sandbox (`~/.local/state`), so
the heavy commands ran through `agent-dev` with `--state-dir /tmp/agent-dev-r3journal`, lane
ports 5234/4434 and `GUANXI_DATA_DIR=$PWD/.lane-data`; this is not the shared lock. The other lanes' heavy suites were allowed to finish before the
final run; the 49 failures reproduce on main. Receipt paths:
`/private/tmp/agent-dev-r3journal/check-a7f7yvz8/result.json`,
`check-2_rg1ym6/result.json`, `check-ro3rk4cv/result.json`, `check-vs5t96g9/result.json`,
`check-g0zi2lof/result.json` and `check-oyzy8sms/result.json`.

## Independent verification

A separate read-only reviewer examined `fe33893f^..HEAD` (HEAD `fb688d3b` at review time) and
ran the focused journal test plus the existing judge/replay/host tests and server typecheck; it
did not run heavy gates. Findings fixed in `0b9f4e6d`:

- **Read-path retention:** `readRun` now filters `expires_at > now`, so an expired row is not
  readable before the timer purge. Test 8.
- **Egress readiness / late secrets:** insert refuses while the scrubber is not ready, identity
  fields are refused if registered, and reads re-scrub stored JSON so a late registration is
  redacted. Test 8.
- **Vacuous egress surfaces:** the session export now goes through the real `sessionLogRoutes`
  handler; console capture no longer patches process stdout (which also swallowed concurrent
  test reports); `console.info/debug/trace` are covered; source guards cover leads, handoff,
  dispatch, federation and export producers. Test 5.
- **Production wiring:** plugin injection is a tested `cascadeWithJournal` helper and the store
  is lazy, so no table exists without a cascade. Test 10.
- **Unproven derivations/states:** done-claim pass/fail/unknown/partial cases and
  unavailable/invalid/abandoned rows are now tested. Tests 9 and 11.
- **Mutation/async boundary:** the journal receives cloned values, and an async `record`
  rejection is consumed. Test 12.

A narrow re-check of `0b9f4e6d` found two remaining blockers, fixed in `1a452096`; a second
narrow re-check of `1a452096` closed both with no remaining blocking findings:

- **Lazy purge of an existing table:** `journalIfPresent` constructs a store when the table
  already exists, so the load/periodic purge removes old rows even when no cascade executes on
  this start. Test 13.
- **Package-directory guard:** source guards resolve from `import.meta.url`, not
  `process.cwd()`; the file passes 13/13 from both the repo root and `packages/server`.
- **Identity read guard:** a stored identity containing a late-registered secret now makes the
  read fail closed; the parent Thread cap always uses the fixed D-113 7-day window. Test 13.

The reviewer also noted that a crash between `store.finish` and the journal insert can leave a
missing row; this remains a residual risk (below).

## Residual risk and next work

- Journal writing is best-effort after the verdict commits; a crash or disk failure between
  `store.finish` and the journal insert can leave a missing row. No marker currently proves a
  run's journal is complete, so `readJournalReplay` cannot distinguish a short corpus from an
  interrupted one.
- `purgeSession` is an explicit path and is not called by the existing native-session deletion
  flow; rows without a run deletion remain bounded by the 7-day/TTL purge. Any future session
  deletion coordinator should call it (or rely on run cascade).
- The actual `relayPlugin.execute`/timer path is not end-to-end integration-tested; the
  injection helper, lazy table detection and purge method are unit-tested separately.
- The source guards are a selective structural check, not an exhaustive proof over every
  future egress producer.
- The reader covers deterministic J0/J1 signal replay only. J2/J3 model verdicts are recorded
  but not scored; labels, calibration and the R3 precision/recall/night/ETA/B3/MS1 gates remain
  owner data, not this slice.
- Recorded observations must have strictly increasing `observedAt`; a host clock that returns
  the same millisecond at two boundaries makes the reader refuse rather than fabricate a time.
- No live relay run, real judge model, remote judge or Fedora run was exercised. The journal is
  not merged or pushed.
- Inherited baseline failure: `operational-relay.test.ts` "the checkout the executor works in
  is the exact base commit" fails identically on main `0ab58729` in this environment
  (`tool_denied_or_failed` for the first `file_read`); it is not caused by this slice and is
  outside its envelope.

## Shared edits

- `packages/server/src/relay/executor.ts`: optional journal default and passing the already
  collected observation/policy/signals into the existing cascade boundaries.
- `packages/server/src/relay/judge-cascade.ts`: optional `journal`, explicit per-request
  observation context and one record hook.
- `packages/server/src/relay/plugin.ts`: lazy journal construction/purge and the tested
  `cascadeWithJournal` injection helper.
- No edits to `relay/start.ts`, `relay/judge-model.ts` or `relay/judge-host.ts` (the
  `claude/remote-relay-judge` lane owns those).

## Next slice

Integrator merge through the shared lock, then run one local real relay with a judge to collect
a first journal, add owner labels and use the reader on a non-Mac node; only a fully recorded,
labelled corpus may evaluate the R3 gate.

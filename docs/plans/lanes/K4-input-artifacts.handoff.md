# K4 input artifacts — implementation handoff

**Status:** bounded vertical slice implemented and locally tested; root independent GPT review and
full/browser/native gates pending. **Does not close `K4-INPUT-ARTIFACTS`.**
**Branch:** `codex/k4-input-artifacts` · **Implementation base:** `b08805c`
**Updated:** 2026-10-22

## Commits

| Commit | Scope |
| --- | --- |
| `cf1b6e2` | docs-only binding of the four implementation-contract corrections |
| `870b834` | contract v2, migration 33, pinned-directory extraction, session input store, fenced log append |
| `081dde1` | native append FIFO, awaited tool-call gate, async replay, deletion path |
| `2f23813` | REST/export/SSE negotiation and inspector excerpt/incompatible states |
| `d28faef` | self-review: R1 fence rechecked before each input artifact write |
| `7a9d617` | self-review: quarantine removal bound to the captured identity |
| `750471b` | self-review: `0400` input files and a malformed-migration-33 rollback guard |
| `8b85fe9` | self-review: minimal incompatible-trace copy (no internal code) |
| `bc7596e` | self-review: queued appends overtaken by a failure cannot follow the terminal |
| `297cf00` | self-review: artifact-root identity pinned across ancestor swaps |
| `983d58e` | self-review: typed pre-open 406 on the live tail |
| `6fb7d23` | handoff evidence update |
| this commit | handoff table hashes only |

No source file from another lane, no `PHASE_STATUS`/`NEXT_AGENT_PROMPT`, package manifest/lock,
approval record/token, user data or infrastructure was edited.

## Implemented

- **Contract.** Event v2 for native `prompt`/`tool.call` with a scrubbed excerpt (≤ 8 KiB) and a
  session-owned SHA-256 reference; no full `text`/`arguments` field exists in v2. v1 bytes and
  schemas are unchanged. `eventVersion` (1–2, default 1) on `/events` and `/stream`;
  `exportVersion` (1–2, default 1) on `/export`; typed
  `session_event_version_unsupported` 406. v1-only export bodies are unchanged; a v2 session
  exports at `exportVersion: 2` only to a max-2 client.
- **Migration 33.** Main ledger appends `session_input_artifacts` (session-owned, unique
  `(session_id, checksum)`, cascade), verifies a pre-existing table's shape (an incompatible
  table fails and rolls back) and replaces only `session_events_policy_insert`: v2 is
  limited to prompt/tool.call, requires an `artifact` object, forbids inline `text`/`arguments`,
  and requires the referenced row to exist for the same session with matching checksum, size
  and media type. Migrations 1–32 are byte-identical; independent ledgers 34–37 are untouched.
- **Store.** New session CAS under `<dataDir>/session-artifacts/<sha256(sessionId)>/`, directory
  `0700`, file `0400` (asserted). The repository-owned pinned helper is extracted to
  `store/pinned-directory.ts` and retains the legacy `ArtifactStore` behavior and its full
  security regression suite. The helper reports its `cwd`/`dev`/`ino`; the parent compares them
  with the trusted identity **before any payload byte**, creates its own random temporary name,
  writes/hashes/`fsync`s/publishes by relative link, verifies the digest, `fsync`s the directory
  and unlinks only the temporary file. Content travels only over the private stdio pipe; no
  absolute-path content operation or fallback exists. A post-operation identity mismatch fails
  closed after the bytes reached the original pinned directory. A failing writer never unlinks a
  published digest.
- **Log.** The metadata row is resolved/inserted in the same fenced SQLite transaction as its
  event, reusing the `(session_id, checksum)` row and ID. FTS, title, search, projection and the
  query tool use the scrubbed excerpt only. A secret registered after the write is re-scrubbed on
  read, and the projection recomputes `excerptBytes` without mutating stored payload.
- **Native producer.** One FIFO per attempt serializes all service/tool-owned appends; `seq` and
  idempotency are computed when an operation executes. Listeners return their promises, and
  `tools.ts` additionally awaits the exact `toolCallId` durable `tool.call` acknowledgment
  before guard, path resolution or any body effect. A missing/failed acknowledgment aborts the
  turn with zero actual tool bodies. The initial prompt append acknowledgment precedes the first
  model dispatch. A queue failure is latched once and writes at most one content-free `error`
  plus failed terminal; R1 completes after the drain. `stop()` enqueues `intervention` then
  aborts without awaiting artifact I/O; `close()` seals/drains before handles close.
- **Replay and cleanup.** Replay resolves v2 references through the session store, verifies
  session/size/SHA-256, decodes, parses JSON arguments and re-scrubs the full bytes; the excerpt
  is never execution input. Missing/corrupt/foreign artifacts fail with a content-free
  `input_artifact_unavailable` before any partial replay. Native deletion removes the session
  artifact directory beside scratch/attachments/output; maintenance reaps a directory whose
  `sessions` row is absent by home-fenced quarantine rename with a post-rename row/live recheck.
- **Wire/client/UI.** A max-1 REST page/export containing v2 returns 406 with zero events/body
  and no cursor; an already-open max-1 stream emits `guanxi-error` with no `id:` at the boundary,
  and the current client throws a typed non-retryable `SseServerError` without `onInvalidFrame`
  or reconnect. The inspector requests 2, shows the scrubbed excerpt with an explicit
  local-only/full-input note, and preserves a typed incompatible state with EN/RU keys. Only
  existing primitives (`Callout`, `Link`, `Badge`, `Button`) are used; no new component, token,
  colour or ceiling.

## New / regression evidence

**New tests: 43.**

- `packages/server/test/session-log-input-artifacts.test.ts` — 18.
- `packages/server/test/session-log-version-negotiation.test.ts` — 6.
- `packages/server/test/native-agent/input-artifacts.test.ts` — 12 (fake provider and injected
  command runner; no sandbox, container, network or live model).
- `packages/web/test/component/inspector-input-artifacts.test.tsx` — 6.
- `packages/web/test/component/sse-terminal.test.tsx` — 1 new typed-error case.

**Regression envelope actually run: 83 server tests in 9 files (47 regression) and 33 web tests
in 4 files (27 regression).**

```bash
nice -n 10 node --test \
  packages/server/test/session-log-input-artifacts.test.ts \
  packages/server/test/session-log-version-negotiation.test.ts \
  packages/server/test/session-log-routes.test.ts \
  packages/server/test/session-log.test.ts \
  packages/server/test/native-agent/input-artifacts.test.ts \
  packages/server/test/artifacts.test.ts \
  packages/server/test/migration.test.ts \
  packages/server/test/durable-run-migration.test.ts \
  packages/server/test/relay/schema.test.ts
# 83 pass / 0 fail
nice -n 10 npx tsc --noEmit -p packages/contract/tsconfig.json
nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json
nice -n 10 npx tsc --noEmit -p packages/web/tsconfig.json
# all clean
cd packages/web && nice -n 10 npx vitest run \
  test/component/inspector-input-artifacts.test.tsx \
  test/component/sse-terminal.test.tsx \
  test/component/inspector.test.tsx \
  test/component/localization.test.tsx
# 4 files, 33 tests pass
```

Not run here (root owns them): full `npm test`, browser gate, build, Storybook/snapshots,
`npm run check:licenses`, eslint/stylelint, `agent-dev`, nested sandbox/containers, live models,
SSH/external services/owner data. `packages/server/test/native-agent/agent.test.ts` was not run in
this harness because its nested-sandbox scope is not proven; it was adapted for async
prompt/queue and `promptTextOf`, and the root should run the native envelope outside this sandbox.

## Migration, rollback, storage, GC, queue and memory limits

- **Migration 33** is append-only. Independent F1 34, R2 35 and F2 36–37 ledgers stay
  independent and untouched. If main consumes 33 before merge, stop and take a new
  root-assigned global slot; never renumber into 34–37.
- **Rollback** restores a stopped, consistent pre-upgrade SQLite/WAL backup; there is no down
  migration or table drop under a running node. An older binary does not understand v2 events
  or exports and must not reuse a v2-bearing database. The supported old-client path is the new
  server's explicit v1 negotiation (406 or an `id`-less SSE error), not old-server compatibility.
- **Storage/GC.** A published digest is never unlinked by a failed append; it remains an orphan
  until the whole session is deleted or maintenance reaps a directory with no session row. There
  is no per-blob GC in this slice. A future per-blob GC must hold the K2 writer fence and
  re-check the `(session_id, checksum)` row after acquiring it. A quarantined directory is kept
  if a session row or live owner appears before removal.
- **Queue.** `agent.queue.items[].text` is still the full immutable inline text, including after
  consumption. A consumed queued prompt may produce a v2 `prompt` event, but the prior queue
  event remains inline. No new queue cap or reference representation exists. Chat, K5,
  delegated/remote prompts, assistant output, reasoning, tool results, image bytes and model
  outputs stay on their current paths.
- **Memory.** Full input bytes are buffered for replay and re-scrubbing; the excerpt is at most
  8 KiB. The 16 KiB threshold controls representation only, not acceptance: there is no new
  total input cap, and acceptance remains bounded by existing transport and model/runtime
  context. Output paging still reads and scrubs a whole artifact in memory; command tails past
  the explicit 64 KiB bound stay discarded.

## Deferred and not claimed

- Whole canonical `K4-INPUT-ARTIFACTS` closure; bounded-memory streaming; per-blob GC; queued
  prompt reference representation; output-tail recovery.
- Chat/K5/reasoning/results/image path changes; any new content audience or REST route returning
  full input bytes; provider/export of reasoning.
- Live/model/browser/build/full-suite validation. `ADR-0023 §4` remains **proposed**, not
  accepted; this slice's authorization is the root's bounded K4 migration scope.

## Shared edits

- `packages/contract`: event union, version/export schemas and 406 error code.
- `packages/server/src/store/db.ts` and `session-log/schema.ts`: main migration ledger 33.
- `packages/server/src/store/artifacts.ts` + new `store/pinned-directory.ts`: extracted
  repository-owned primitive; legacy behavior and `artifacts.test.ts` assertions preserved.
- `packages/server/src/session-log/routes.ts`: explicit negotiation on the existing K2 routes.
- `packages/web/src/lib/sse.ts` + locale/API error map: typed server-error frame handling.
- `packages/web/test/component/inspector.test.tsx`: export href now carries
  `exportVersion=2` (contract adaptation, no assertion removed).
- Existing migration/fixture tests: current-version markers moved from 32 to 33, the session-log
  downgrade fixture drops `session_input_artifacts`, and v2-safe `promptTextOf` /
  async `prompt`/`queue` adaptations were applied in session-log, federation-persistence and
  native tests. No assertion was removed or weakened.

## Review-fix

No root review findings yet. Any later findings will be fixed in separate commits and appended
here without rewriting this section.

## Independent review fix (2026-10-22)

Independent report `../../../../reviews/codex-k4-input-code-20261022.md` reviewed candidate
`419a9972bfe956a9dc72e69a55990514198a81e0` and confirmed three P2 findings. This section appends
the fixes and current evidence; the historical sections above are unchanged. The independent
three-probe fixture
`../../../../reviews/k4-input-review-probes-20261022.ts` now passes **3/3** against this
worktree. `K4-INPUT-ARTIFACTS` remains open, and the queue-artifactization, old-server rollback
and calibration claims remain open as recorded above.

### Fix commits

| Commit | Finding | Change and failing-first evidence |
| --- | --- | --- |
| `fd2936c` | P2 queue overwrite | `queue()` and `removeQueued()` now read the accepted projection and call the existing internal synchronous `appendNow()` inside the same `NativeAppendQueue.enqueue()` operation. There is no reentrant `append`, no snapshot before enqueue and no second FIFO. The new test concurrently queues two prompts and then queues a third while removing the first; it asserts exact IDs/order and every intermediate `agent.queue` snapshot. Before the fix the two concurrent calls resolved successfully but retained only `['second accepted']`. |
| `87deb44` | P2 stop intent lost | `NativeAppendQueue.requestIntervention()` retains exactly one stop intent and `fail()` writes it through the direct append path before `onFailure()` writes the single terminal; a queued intervention that already committed marks the intent committed, so the failure path cannot duplicate it. `stop()` still requests the intervention and aborts synchronously, without waiting for artifact I/O. The existing blocked-write cancellation test is strengthened to assert exactly one `intervention` before exactly one `turn.done`, cancelled state and only R1 `run.lifecycle` after the terminal; no delay, pending-model stop test or count was weakened. Before the fix the blocked artifact write rejected first, the queued intervention was rejected by the failure guard, and the event count was `intervention = 0`. |
| `f6be3ea` | P2 orphan reaper detaches live bytes | `SessionInputReapOptions.criticalSection()` runs the fresh membership check and the local `renameSync()` in one synchronous body. Production supplies `runs.homeFence().transaction(...)`, whose `BEGIN IMMEDIATE` is the same SQLite critical section that serializes session/reference commits; the fallback asserts home and runs the body with no await. The fresh check re-reads sessions, unreleased `session_writers`, `session_input_artifacts` and `liveSessionIds` immediately before the rename. A session row appearing after the rename still keeps the quarantine; there is no restore and no unlink of published bytes. The new test writes an orphan CAS entry, commits a live session plus a v2 reference from `assertHome` before the final fence, asserts `{removedDirectories:0, quarantinedKept:0}`, and successfully reads the canonical exact bytes; it also covers a live-only pre-admission id and a failing fence retaining the canonical directory. Before the fix the reaper renamed first, returned `quarantinedKept:1`, and the canonical read failed. |
| `358ee23` | Probe teardown, not a reviewed P2 | The independent reaper probe registers `db.close()` before the handle close. `SessionLog.releaseHandle()` now skips a closed database and never throws from close, matching the existing system-writer close behavior. A focused test covers handle and log close after `db.close()`. Without this, the corrected reaper probe passed its assertions but failed in the teardown hook. |

### Test arithmetic

The previous handoff's web regression count was wrong; the corrected arithmetic at the reviewed
candidate is:

- new: **36 server + 7 web = 43**;
- selected: **83 server + 33 web = 116**;
- regression: **47 server + 26 web = 73** (not 27 web).

This fix round adds **3 new server tests**: concurrent queue mutation in
`native-agent/input-artifacts.test.ts`, the pre-rename reaper race in
`session-log-input-artifacts.test.ts`, and close-after-database-close in the
`session-log.test.ts` regression file. The blocked-write stop test is strengthened in place and
does not add a new test count. Current honest arithmetic:

- new: **39 server + 7 web = 46**;
- current server selected: **86 tests, 86 pass, 0 fail, 0 skipped** (9 files);
- server regression: **86 - 39 = 47**;
- web selected envelope: **33 tests, 7 new / 26 regression**, unchanged from the independent
  review at `419a997` and not rerun here because no web source or web test changed;
- if that unchanged web envelope is combined, the selected total is **119**, with **73**
  regression. The 86-server run is current; the 33-web number is the independent reviewer's
  result, not a run performed in this fix round.

### Commands and evidence

```bash
nice -n 10 node --test \
  packages/server/test/session-log-input-artifacts.test.ts \
  packages/server/test/session-log-version-negotiation.test.ts \
  packages/server/test/session-log-routes.test.ts \
  packages/server/test/session-log.test.ts \
  packages/server/test/native-agent/input-artifacts.test.ts \
  packages/server/test/artifacts.test.ts \
  packages/server/test/migration.test.ts \
  packages/server/test/durable-run-migration.test.ts \
  packages/server/test/relay/schema.test.ts
# tests 86 / suites 19 / pass 86 / fail 0 / cancelled 0 / skipped 0
nice -n 10 node --test /Users/yuzuru/Projects/Guanxi-lanes/reviews/k4-input-review-probes-20261022.ts
# tests 3 / pass 3 / fail 0
# queue actual ["first accepted","second accepted"]
# reap {"removedDirectories":0,"quarantinedKept":0,"removedTemps":0} readable true sessionPresent true
# stop intervention 11 < terminal 13; only run.lifecycle follows turn.done
nice -n 10 npx tsc --noEmit -p packages/contract/tsconfig.json
nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json
# both clean, no output
```

The fail-first runs before each production change were: queue `['second accepted']` instead of
both accepted prompts; stop `intervention` count `0` instead of `1`; reaper
`quarantinedKept:1` with an unreadable canonical artifact instead of `0` and a successful exact
read.

### Residuals and not claimed

- No web component, browser, build, Storybook, license, lint, `npm test`, native `agent.test.ts`
  or `agent-dev` gate ran in this fix round. The root still owns the full/browser/native gates.
- The reaper's final membership check and rename share one synchronous home-fenced SQLite write
  transaction, so a session/reference that commits before the rename is observed and retained.
  A row that appears only after the rename keeps quarantined bytes and is not restored; there is
  still no per-blob GC and no unsafe rename-back path.
- The stop guarantee is exactly one durable intervention before one terminal when the terminal
  can be written. If the intervention append itself loses the writer/home fence, the terminal
  append cannot commit either; no retry or duplicate is invented.
- The close-after-database fix is probe-teardown robustness, not a fourth reviewed P2 or a
  broader lifecycle guarantee.
- Queue text remains inline in `agent.queue`; full queued-input artifactization, K4 closure,
  old-server v2 compatibility and calibration remain unearned as recorded above.

**Handoff pin:** the four fix commits are `fd2936c`, `87deb44`, `f6be3ea`, `358ee23`; this
handoff is the final docs commit on `codex/k4-input-artifacts`. The exact `git rev-parse HEAD`
and empty `git status --porcelain` are reported to the coordinator after this commit; no source
edit follows it.

## Independent review fix 2 (2026-10-22): release-failure propagation

Independent re-review of `d0aec89` (`reviews/codex-k4-input-code-20261022.md`, section
"Independent fix re-review — d0aec89") confirmed one new unrelated P2 in `358ee23`: the broad
catch in `SessionLog.releaseHandle()` swallowed an open-database `UPDATE session_writers` refusal
after the in-memory writer entry was already removed. `handle.close()` then looked successful
while the durable row stayed held and a second live `SessionLog` got `writer_busy`. This section
appends the narrow fix. All earlier sections and claims are unchanged.

### Fix commit

| Commit | Finding | Change and failing-first evidence |
| --- | --- | --- |
| `4f7359c` | P2 open-DB release failure hidden | `releaseHandle()` keeps the synchronous `if (!this.dbOpen()) return` guard for an externally closed database and no longer catches `prepare()`/`run()` errors. The open-DB update failure now propagates exactly as at `419a997`; there is no `await` between the `dbOpen()` check and the UPDATE in one isolate. The new test installs a SQLite `BEFORE UPDATE OF released_at` trigger that aborts the release, asserts `handle.close()` throws `fixture_release_failed`, asserts `session_writers.released_at IS NULL`, and asserts a second `SessionLog` still gets `writer_busy`. The closed-DB regression is strengthened in place with `handle.closed === true` and an idempotent second close; it was not weakened. Before the fix the new test failed with "Missing expected exception", and the independent fixture reported `closeReportedError:false, durableWriterStillHeld:true, otherWriterBusy:true`. |

### Test arithmetic

This round adds **1 new server test** and strengthens the existing closed-DB regression in place
(no new count). Honest current arithmetic:

- new: **40 server + 7 web = 47** (previous 39 server + 7 web plus this release-failure test);
- current server selected: **87 tests, 87 pass, 0 fail, 0 skipped** (same 9 files);
- server regression: **87 - 40 = 47**;
- web selected envelope: **33 tests, 7 new / 26 regression**, unchanged from the independent
  review at `419a997` and not rerun here because no web source or web test changed;
- combined selected total if the unchanged web envelope is included: **120**, with **73**
  regression (47 server + 26 web);
- external reviewer fixtures: new release probe **1/1**, the three prior probes **3/3**. These
  are not repository tests and are not added to the 87/120 counts.

### Commands and evidence

```bash
nice -n 10 node --test \
  packages/server/test/session-log-input-artifacts.test.ts \
  packages/server/test/session-log-version-negotiation.test.ts \
  packages/server/test/session-log-routes.test.ts \
  packages/server/test/session-log.test.ts \
  packages/server/test/native-agent/input-artifacts.test.ts \
  packages/server/test/artifacts.test.ts \
  packages/server/test/migration.test.ts \
  packages/server/test/durable-run-migration.test.ts \
  packages/server/test/relay/schema.test.ts
# tests 87 / suites 19 / pass 87 / fail 0 / cancelled 0 / skipped 0
nice -n 10 node --test packages/server/test/session-log.test.ts
# red first:  tests 27 / pass 26 / fail 1 — "Missing expected exception"
# after fix:  tests 27 / pass 27 / fail 0
nice -n 10 node /Users/yuzuru/Projects/Guanxi-lanes/reviews/k4-release-failure-probe-20261022.ts
# red:   {"closeReportedError":false,"durableWriterStillHeld":true,"otherWriterBusy":true}
# green: {"closeReportedError":true,"durableWriterStillHeld":true,"otherWriterBusy":true}
nice -n 10 node /Users/yuzuru/Projects/Guanxi-lanes/reviews/k4-input-review-probes-20261022.ts
# tests 3 / pass 3 / fail 0
nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json
# clean, no output
```

### Residuals and not claimed

- `handle.close()` marks the handle closed before the UPDATE, so a thrown release leaves the
  durable row held until expiry or a later `SessionLog.close()` bulk release by this writer id.
  This matches the original `419a997` ordering; no lease release is claimed when the UPDATE fails.
- The legacy system-writer `releaseSystemWriter()` catch is unchanged; this fix is limited to
  normal handle close.
- No full `npm test`, browser, build, Storybook, license, lint, `agent-dev`, native
  `agent.test.ts` or sandbox/container check ran in this round. The root still owns those gates
  and its independent rerun of the new probe plus the three prior probes.
- `K4-INPUT-ARTIFACTS` remains open; queue artifactization, old-server rollback and calibration
  claims stay open as recorded above.

**Handoff pin:** this fix is `4f7359c` plus this docs commit on `codex/k4-input-artifacts`.
The exact `git rev-parse HEAD` and empty `git status --porcelain` are reported to the
coordinator after this commit; no production edit follows it.

## Full-gate follow-up (2026-10-22): two web failures

Root full `npm test` receipt `check-6q052w2n` ended server/core **ALL PASS** and web
**323/325**. `localized-copy-inventory.test.tsx` flagged `features/inspector/api.ts:59`
(`dynamic-return "?exportVersion=2"`), and `context-checkpoint.test.tsx:165` asserted
`document.activeElement` immediately after `findByRole('alert')`; the full run observed
`activeElement === document.body` while the alert already existed because `ContextPanel`
moves focus in an asynchronous effect. This section appends only those two bounded web
fixes. Every earlier section, count and claim is unchanged.

### Fix commits

| Commit | Finding | Change and failing-first evidence |
| --- | --- | --- |
| `05861ab` | `localized-copy-inventory` dynamic return | `inspectorApi.exportUrl()` now serializes the protocol query with `new URLSearchParams({ exportVersion: '2' })`, the same pattern as `search()`, instead of a literal protocol string. The relative `SESSION_ROUTES.export(id)` path, encoded session id, exact `exportVersion=2`, and the unchanged `allEvents`/`live` `eventVersion=2` calls are preserved. The existing inspector fixture keeps its exact href assertion, and a new client assertion calls the real `inspectorApi.exportUrl()` with a URL-sensitive session id and checks the exact wire URI plus the sole query entry. No scanner, exemption, cast, alias or locale key changed. Before the fix the inventory test failed with `features/inspector/api.ts:59`, `kind: "dynamic-return"`, `value: "?exportVersion=2"`. |
| `43728c8` | `context-checkpoint` observed focus before the effect | The same existing test now awaits `waitFor(() => expect(alert).toBe(document.activeElement))` after `findByRole('alert')`, matching the adjacent post-effect focus check at line 145. The focus requirement and target are unchanged; no product code, sleep, deadline or known-flake label was added. To prove the assertion is tied to the product effect, the local unstaged `ContextPanel` focus call was temporarily replaced with `void compactErrorRef.current`; the updated test then failed at line 165 with the `waitFor` timeout, and the call was restored before the commit. |

### Test arithmetic

- new: **+1 web** (`inspector-input-artifacts` encoded export URI case). No server test changed.
  Cumulative lane new is **40 server + 8 web = 48** (previous 40 server + 7 web).
- updated in place, not new: the `context-checkpoint` focus assertion; its test count is
  unchanged.
- selected envelope actually run: **30 web tests in 5 files, 30 pass, 0 fail, 0 skipped**:
  `context-checkpoint` 4, `localized-copy-inventory` 5, `inspector-input-artifacts` 7,
  `inspector` 11, `sse-terminal` 3. The envelope contains **8 lane-new web tests** (7
  `inspector-input-artifacts` + 1 `sse-terminal` typed-error case) and **22 regression**
  tests; this round itself adds one new test and updates one existing assertion in place.
- not rerun here: the earlier 33-test web envelope, the full 325-test web gate, all server
  tests, browser/build/Storybook, `ui:check` and `check:licenses`. The root owns those.

### Commands and evidence

```bash
# red before the production edit
cd packages/web
nice -n 10 npx vitest run test/component/localized-copy-inventory.test.tsx \
  test/component/context-checkpoint.test.tsx
# Test Files 1 failed | 1 passed; Tests 1 failed | 8 passed
# features/inspector/api.ts:59 dynamic-return "?exportVersion=2"

# focus-sensitivity proof (temporary unstaged product no-op, restored before commit)
nice -n 10 npx vitest run test/component/context-checkpoint.test.tsx
# Test Files 1 failed; Tests 1 failed | 3 passed at context-checkpoint.test.tsx:165

# green scope after restoration
nice -n 10 npx vitest run \
  test/component/context-checkpoint.test.tsx \
  test/component/localized-copy-inventory.test.tsx \
  test/component/inspector-input-artifacts.test.tsx \
  test/component/inspector.test.tsx \
  test/component/sse-terminal.test.tsx
# Test Files 5 passed (5); Tests 30 passed (30)
nice -n 10 npx tsc --noEmit -p packages/web/tsconfig.json
# clean, no output
nice -n 10 npx eslint \
  packages/web/src/features/inspector/api.ts \
  packages/web/test/component/context-checkpoint.test.tsx \
  packages/web/test/component/inspector-input-artifacts.test.tsx
# clean, no output
```

### Residuals and not claimed

- No `ContextPanel` production behavior changed: the focus effect is untouched and still
  required by the test; only the observation now waits for that effect.
- The export URL remains a relative URL built from `SESSION_ROUTES`; the session id is still
  encoded there, and `URLSearchParams` emits exactly `exportVersion=2`. `allEvents` and `live`
  still request `eventVersion=2`; no other query parameter was added.
- No server, store, fence, artifact-data, package/lock, token, manifest, status, approval or
  snapshot file changed. No locale key or scanner exception was added.
- The full 325-test web rerun and the other root gates remain unverified here; this section
  claims only the 30-test scoped envelope above and the two fix commits.

**Handoff pin:** fix commits `05861ab` and `43728c8` precede this docs commit on
`codex/k4-input-artifacts`; no production edit follows it.

## Truncated-excerpt privacy repair (2026-10-22)

**Base:** `622addc`. **Initial fix:** `4818b92`. **Independent-review follow-up:** `c2ae12f`.
This is a bounded local repair, not closure of all K4 scope. The coordinator owns current-main
integration, the moved evidence path and all final combined gates.

### Behavior and boundaries

A value registered after a v2 input append could be longer than its stored 8-KiB excerpt.
Exact matching could not see the complete value, so its visible prefix survived into titles,
reads, exports and search. The new long-title regression failed on the original base before
implementation. The original outside U1-page probe remains unchanged; this older checkout
has no page endpoint, so a separately named copy adapts only imports, old list route/schema
and its pagination-only assertion. Both its ordinary and long-secret assertions pass here.
The exact new-page probe still belongs to root's combined integration.

The optional synchronous `egress.scrubber.scrubTruncatedPrefix` capability uses private cached
KMP prefix tables for the actual registered raw, JSON-escaped and URI-encoded forms. It
protects complete matches and every nonempty terminal proper prefix, including one character,
using the existing overlap/marker renderer. It exposes no registry and leaves ordinary exact
`scrub` semantics unchanged. The existing facade test was expanded in place for the new
method and closed-instance refusal; no fake production implementation needed an update.

`session-log/excerpt.ts` centralizes v2 projection before title cuts, UTF-8 clipping or search
snippets. It establishes truncation from stored byte metadata before new redaction and
recomputes excerptBytes within the existing 8-KiB bound without splitting an expanding marker.
Old list/summary, direct events, export and each current-registry outward SSE reread share it.
FTS only nominates candidates; v2 surviving terms/snippets are rebuilt from the safe event.
No full artifact is rehydrated. Stored payload/hash/FTS/ID/version/sequence remain unchanged;
explicit `total_changes()` assertions also prove zero writes during the read envelope.

Independent review found a second valid case: append-time redaction of an early value can
expand a short descriptor's stored excerpt past the full artifact byteSize. That erases the
byte comparison's proof of an original cut. Two new prompt/tool regressions failed first at
`4818b92`. Separate fix `c2ae12f` conservatively protects a boundary when an existing stored
marker makes its original completeness ambiguous. It adds no wire/DB field, API rejection
or artifact IO. This can redact an otherwise ordinary matching suffix in that affected
excerpt; the module docs name this tradeoff. Complete v1 and complete v2 text without that
ambiguity retain ordinary exact matching. Missing optional capability withholds only the
affected truncated/ambiguous excerpt, retaining other useful session metadata.

### New / regression evidence

**19 new repository tests:** 6 in `egress-truncated-prefix.test.ts` and 13 in
`session-log-truncated-egress.test.ts`. They assert raw/JSON/URI prefix lengths, one-character
and overlapping matches, repetitive forms/cache rotation, UTF-8 and whole markers, protection
before titles, direct read/export, zero protected search hits with useful ordinary controls,
current-registry resumed/live SSE after an earlier page read, exact event identity, unchanged
DB/FTS, zero artifact reads/writes, optional-capability refusal and append-time expansion.
The existing egress facade test is modified in place, not counted as new.

- Author final selected envelope at clean `c2ae12f`: **170/170, zero failures/skips**,
  `check-02wk2z86`, source unchanged, 10.74 seconds. This is **167 repository tests
  (19 new / 148 prior selected)** plus **3 external probes**; external cases are not counted
  as repository additions. Selected files: both egress tests, all `session-log*.test.ts`,
  `native-agent/input-artifacts.test.ts`, the adapted outside metadata probe (2) and the
  reviewer's unchanged append-expansion probe (1).
- Earlier selected `check-bi5gnz1s` passed 167 at `4818b92` before independent review found
  the short-descriptor gap; it does not validate that follow-up. The reviewer's original
  append-expansion probe failed at `4818b92` (`check-nkub4xkx`) and passed after the fix.
- Final independent recheck **CLOSED** at clean `c2ae12f`: **40/40, zero skips**,
  `check-p106mvgt`, source unchanged: 19 new privacy + 20 compatibility + the unchanged
  original external append-expansion probe. It read the complete follow-up diff and found
  no remaining bounded source finding. Report outside Git:
  `Guanxi-lanes/reviews/codex-k4-truncated-egress-20261022.md`.
- Local Node 26.9.0 resolves `@guanxi/contract` inside this clone. Server TypeScript, scoped
  ESLint, touched module/plan Markdown and diff whitespace checks passed at the source pins.
  Final handoff is docs-only; no additional full checks are claimed for it.

Heavy selected checks used shared `~/.local/state/agent-dev` resource `heavy`, ports 5210/4410
and this clone's `.lane-data`. The inherited external skill symlink prevents reusable source
attestation; these are observed results at the named clean Git pins. No lock was bypassed.

### Scope and residuals

Owned edits are egress types/scrubber/README, session-log log/new excerpt helper/README, the
existing facade assertion, the two new test files and this lane's plan/handoff. No contract,
REST schema, migration, dependency, UI, central status, owner data, live model/provider,
container or remote host was changed or used. No new secret fields or plaintext logs exist.

The protection covers registered raw/JSON/URI forms and known or marker-ambiguous excerpt
boundaries. Unregistered secrets, other encodings, arbitrary unknown message cuts and forensic
erasure of the original stored excerpt are not claimed. Root still must integrate the new
U1 page consumer, rerun its original probe and final combined candidate/main gates, preserving
its current metadata/cursor behavior and the additive egress facade from other lanes. Other
K4 input/native lifecycle residuals recorded above remain open.

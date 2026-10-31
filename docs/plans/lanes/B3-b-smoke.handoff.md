# B3-b hand-off — smoke cohort producer

**Status:** implemented and fixture-validated offline; **no real run was possible from this lane** (the Fedora node is
not reachable). B3 stays `proposed`, no criterion is evaluated, `realEvidenceCredit` stays 0. Independent review has
not been done (the lead runs it) · **Updated:** 2026-10-31 · **Branch:** `lane/b3b-smoke` · **Base:** `lead/wave7`
`14b1d569` · **Decision:** D-219 · **Plan:** [B3-b plan](B3-b-smoke.plan.md) · **Runbook:**
[RELAY_SMOKE.md](../../../packages/bench/RELAY_SMOKE.md)

## What exists

New files, all under `packages/bench`:

| File | Role |
| --- | --- |
| `src/relay-smoke-corpus.ts` | five tasks × five `ledger-lite` items, relay plans, acceptance argv, pinned protected-test blob ids, three digests |
| `src/relay-smoke-facts.ts` | event → content-free facts, fixed outcome table, the relay's canonical form |
| `src/relay-smoke-build.ts` | pure trial builder, evidence book, envelope assembler |
| `src/relay-smoke-source.ts` | `RelaySource` port; `HttpRelaySource` (owner API, loopback only); `SqliteLedgerReader` (read-only home database) |
| `src/relay-smoke-fake.ts` | deterministic fake relay writing events in the real shapes (both arms) |
| `src/relay-smoke-run.ts` | strict configuration, plan assembly, orchestration, resume, abort, deadline |
| `src/relay-smoke-cli.ts` | `plan`, `preflight`, `run`, `report`, `fixture`; JSON stdout, exit codes `0/1/2/3` |
| `RELAY_SMOKE.md`, `README.md` section | operator runbook |
| `test/relay-smoke-*.test.ts` (+ three helpers) | 61 tests |

Shared edits: `src/index.ts` (additive exports of the pure modules, not the CLI), `tools/mutations.ts` (28 `b3b-*`
cases), `README.md` (section). `relay-protocol.ts`, `relay-measurement.ts`, B1 schemas and thresholds, server,
contract and web are untouched. `PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` are not edited.

B3-a respected: the validator and reducer have no CLI mode and no IO; the runner is a separate entry point that calls
them as libraries. The report keeps `gate: measurement_only`; the runner prints no verdict wording.

## Gates (Mac, Node 26.9.0, worktree-local `npm ci`; `@guanxi/contract` resolves inside the worktree)

| Command | Result |
| --- | --- |
| `node --test test/relay-smoke-*.test.ts` (in `packages/bench`) | 61 tests, 61 pass, 0 fail, 0 skipped (before review; 83 after, see below) |
| bench envelope, all other test files (B3-a relay tests included) | 169 tests, 169 pass |
| `node --test 'test/*.test.ts'` | 230 tests, 230 pass |
| `npx tsc --noEmit -p packages/bench` | exit 0 |
| `npx eslint packages/bench` | exit 0 |
| `node packages/bench/tools/mutations.ts` | exit 0; 73 cases, every one killed by an `AssertionError`, including the 28 new `b3b-*` ones |
| `npm run lint:md` | 0 errors, 317 files, 830 links, 0 link problems |
| `node packages/bench/src/relay-smoke-cli.ts fixture --out DIR` | exit 0, 10 trials, document valid, origin `synthetic_fixture` |
| `... preflight --config C --repo ~/Projects/Guanxi-Test-Repo` | fixture base commit and all 15 pinned blobs `ok` on this Mac; endpoint check failed as expected (nothing listens on the port used) |

Not run: the full `npm test`, browser gates, builds, CI (the lead owns them).

**Counts (WORKFLOW 4b):** B3-b 61 new / 169 envelope (bench total 230). By file: corpus 6, facts 6, builder 17, orchestration
12, HTTP source 3, home database 4, drift 3, CLI 10.

## Guards and what fails without them

Mutation sanity (each removal fails an assertion): origin lock (a fake source is never `recorded_observation`),
`caps.cycles = horizon`, per-seed idempotent start key, resume skip, failed start not stored, abort starts nothing
more, `not_reached` tail, truncation attached to the last counted call, integrity requires re-hash + bundle +
artifact agreement, first-touch item opportunity (no duplicate opportunity ids), a judge that did not observe dead ends
leaves guards unknown, no ledger leaves groups unknown (no imputation), non-commit head is unknown, deadline is
`cancelled`, truncation is never an infra error, relay-job filter, event text is not kept, loopback only, redirects
refused, response bodies not echoed, home database opened read-only, ledger hash re-computed (not copied), gate output
never read, costs scoped to the run, exit code 3 for incomplete, private file modes, manifest hashes bind the files,
corpus dependencies closed. Drift tests (not mutation-run, they import the server): the fixture tables equal the
server's migration text, `canonicalText`/`sha256Hex` equal the relay's `canonical`/`hash`, the stop codes the outcome
table classifies exist in `executor.ts`.

## Does the naive-compaction arm need server work? Yes

*Superseded in part: the server side was built in lane B3-c; see "B3-c integration" below for how the runner now uses it.*

There is no compaction policy in the relay (`rg -i naive packages/server` finds nothing) and the strict wire schema has
no field to pick one. The smallest honest switch is a trusted-host, node-wide, default-off `RelayLimits.compaction`
(`packages/server/src/relay/types.ts`), read in three places of `executor.ts` (work context without `strip` and
`work.query`/`notes.search`; seal only a summary; probes recorded but non-fatal), set by a new ms1-live key, with the naive
arm served by a second home process. That is beyond a small flagged option, so **it is designed in the plan and not
implemented**. The runner is ready for it: a per-arm `url`/`homeDb`, `enabled: true`, and the arm profile. Until then the
real smoke runs the ledger-relay arm and the report states `arm_unsupported:naive_compaction` and
`pairedRelayVsNaive: unresolved`. The fake relay implements both arms so the paired path is tested.

## What the lead must do to run the real smoke cohort

Full steps are in [RELAY_SMOKE.md](../../../packages/bench/RELAY_SMOKE.md). In short:

1. Merge or check out this branch on the Mac **and** the Fedora node at the same commit (federation requires it), `npm ci`.
2. Bring the MS1 pair up as in `docs/operations/ms1-live-run.md` sections 1 to 4 (no lead, `home.alwaysOn`, run-A7 reserves),
   register `~/Projects/Guanxi-Test-Repo` as workspace and project (section 5), note `projectId` and the `connectionId` of the
   `started` event.
3. Write the configuration (example in the runbook; `harnessRevision` is `git rev-parse HEAD` of the home checkout; `endpoint.homeDb`
   is `~/ms1/home/data/guanxi.db`), outside the repository.
4. `node packages/bench/src/relay-smoke-cli.ts preflight --config cfg.json --repo ~/Projects/Guanxi-Test-Repo` (exit 0).
5. Pilot: `... run --config cfg.json --out ~/ms1/b3-smoke/pilot --tasks ll-money-text` (about 75 minutes for the ledger arm).
6. Full ledger-arm cohort: `... run --config cfg.json --out ~/ms1/b3-smoke/full` (about 6.5 hours); a Ctrl-C leaves a valid partial document, a rerun with
   the same `--out` resumes.
7. Give `summary.json`, `report.json`, `measurement.json`, `manifest.json` and the commit id to the independent reviewer. Report it as a
   descriptive smoke reading, never as a gate.

## Residual risk and not done

- **Never exercised against a real relay.** Event and table shapes were taken from the source (`store.ts`, `executor.ts`, the
  session-log contract) and the drift tests pin the table text, but a real run may expose a difference (event ordering, a
  `step` that is not the cycle, a status that stays `wrapping_up`, missing `runtime` on a terminal status). The runner degrades
  to `unknown` rather than guessing; the first pilot should be read against `summary.json` notes before the full run.
- **Operationalisation choices to review:** an item opportunity is the first cycle in which the item has gate evidence, result =
  last gate of that item in that cycle (single opportunity per item per trial, as B3-a requires; a later pass does not change it);
  a cycle past the first with no probe note is `unknown`; cycle 1 has an empty probe manifest; truncation attaches to the last
  call with a recorded count; the context sample count is every recorded call, probes included. These are descriptive
  conventions for the smoke, not the gate estimand.
- **Critical-field probe accuracy cannot be measured**: the relay records only whole-answer probe correctness. A tiny additive
  server change (per-field booleans in the `probe` note) would fix it; not done (bench-only lane).
- **Guards will be unknown in the real run**: the stock start judge collector (`relay/judge-start.ts`) declares `deadEnds` unobserved, so no guard fact is recorded; guarded repeats need a collector that observes dead ends. The builder keeps this as `unknown`, never as zero repeats.
- **ETA forecasts and `E` calibration are absent** (public start has no trusted ETA history); both stay `unknown`.
- Evidence is metadata derived by the runner; no authenticated seal. Observation files hold facts only (no event text, no tool
  arguments, no gate output), but run ids and times are in them: keep outputs private and uncommitted.
- Home database access assumes the runner runs on the home machine and the schema of migrations 35/R1; a schema change breaks the
  reader loudly (`home_database_unreadable`), and the drift test fails first.
- Throughput: one executor slot, trials strictly sequential; a cohort of five tasks and one arm is a working day, both arms two.
- Independent review of this lane (read-only, separate agent) is the lead's.

## Review findings and fixes

Independent review of `lane/b3b-smoke` (read-only, separate agent); fixes are in the `fix(bench): review fixes` commit that
follows `9a1b4d26`. Corrections to the original wording above: after the review fixes the test count was **83 new / 169 envelope (bench total
252)** and the mutation tool ran **94 cases**; the final figures after the B3-c integration below are 91 / 169 / 260 and 101.

| Finding | Fix | Proof |
| --- | --- | --- |
| H1 start POST blocks until `prepare()`; 30 s timeout left a relay running while the next trial started | start deadline `timing.startTimeoutMs` (20 min), stop `stopTimeoutMs` (5 min), ordinary 30 s; a start failure without a relay answer is reconciled by key (`status`, then `stop`); only a fixed relay refusal (`isDefinitiveStartRefusal`) or an unknown key is a failed start; an unaccounted-for relay halts the run (`halted: relay_state_unknown`, exit 3) and is re-attached by a rerun | `hangStart` fake: admitted-but-silent start is observed, not duplicated; status failing then stop; stop failing halts and starts nothing more; never-admitted start is missing and retried; HTTP slow-start test; mutations `b3b-start-deadline`, `-stop-deadline`, `-reconcile-ambiguous-start`, `-halt-on-unsettled` |
| M1 status failures left the relay running and stored the trial as final | `stop` is attempted (long, non-aborted signal) before the trial is given up; an observation is stored only when the relay is terminal or confirmed stopped, otherwise it is unsettled, unstored, and halts | **The old test "an endpoint that keeps failing ends the trial as aborted…" pinned the wrong behaviour (it only counted status calls and `endedBy`). It was replaced, not weakened:** it still asserts 3 status calls and `endedBy: aborted`, and now also asserts the stop, the stopped state, and (second test) that an unstoppable relay is not stored and a rerun re-attaches. Mutations `b3b-stop-on-status-failures`, `-unsettled-not-stored` |
| M2 reader read-only open not pinned; WAL side effects with the node down | `open()` is public and is the only path; a test writes through it and fails; WAL-mode database without `-shm` is refused (`home_node_not_running`) and leaves no files; documented in the runbook | `relay-smoke-db.test.ts`; mutations `b3b-reader-open-read-only`, `b3b-live-node-only` |
| M3 nothing asserted `stop` on SIGINT or deadline | `FakeRelay.stopped`; both tests assert the exact key | mutations `b3b-stop-on-sigint`, `b3b-stop-on-deadline` |
| M4 `isMain` failed through a symlink (silent exit 0) | real-path comparison | spawn test through a symlink asserts non-empty JSON; mutation `b3b-main-through-symlink` |
| M5 an enabled naive arm without its own endpoint labelled ledger data as naive | two selected arms behind one endpoint and database are refused (`smoke_config_arm_endpoint`); one arm per pass is supported (`--arms`, same `--out`, merged document); `summary.json` carries `armIdentity: operator_asserted`, a hash of each arm's endpoint and its harness revision; arm entries may set their own `harnessRevision` | run, CLI and pass tests; mutation `b3b-shared-endpoint` |
| M6 cached observations reused after config changes | every observation stores a fingerprint (stratum, horizon, start, caps, arm kind/profile/endpoint/database/harness revision, task plan, seed); mismatch is `smoke_config_observation_mismatch` (exit 2); timing and task/seed selection are not part of it | run and CLI tests per field; mutations `b3b-fingerprint-checked`, `-fingerprint-start`, `-fingerprint-harness` |
| L1 request conformance | the real `relayStartRoutes` are mounted on a loopback socket with a stub service and driven by `HttpRelaySource` (JSON content type, strict stop body, 404 mapping); the events query is parsed with the contract's `sessionEventsQuery` (`limit` 500) | drift and HTTP tests |
| L2 codes and timeout | all codes of `relayStartCode` plus the route guards are kept; a deadline is `timeout`, not `endpoint_unreachable` | HTTP tests; mutations `b3b-timeout-code`, `b3b-refusal-codes` |
| L3 shapes pinned, silent `continue` | text pins of the ledger evidence row, handoff hashes, note and event shapes and the cost key against the server source (not a type check: the shapes are TypeScript types); an unreadable seal is kept with `unreadable: true`, so its cycle and the next are `unknown` instead of shifting items | drift test; builder and database tests; mutations `b3b-unreadable-seal-visible`, `-unreadable-seal-unknown` |
| L4 exit codes | runbook table matches the code (`report` non-JSON = 2, invalid = 1; `run` on a dead endpoint = 3) | CLI tests (existing) |
| L5 item-result convention | stated in the runbook | docs |
| L6 `deadEndGuard` default | derived and commented: only the ledger arm's sealed handoff carries live dead-end notes (`selectNotes`); explicit override stays | runbook |
| L7 `fileStore.load` validation, transient `ledgerError` | strict zod schema, refusal `smoke_config_observation_invalid` (exit 2); a stored `ledgerError` is re-read on the next run without starting anything | CLI and run tests; mutations `b3b-observation-schema`, `b3b-reread-transient` |
| `--arms` in the plan but not the CLI | implemented | CLI pass test |

One existing assertion changed for a reason other than the above: the CLI preflight test expected a failing database check for
both arms because both inherited the endpoint's database; the naive arm of the shared test configuration now has its own
`url` (required by M5), so only the ledger arm's check is expected to fail.

Gates after the fixes (same environment): `node --test test/relay-smoke-*.test.ts` 83/83; whole bench 252/252 (169 envelope
unchanged); `npx tsc --noEmit -p packages/bench` exit 0; `npx eslint packages/bench` exit 0; `node packages/bench/tools/mutations.ts`
exit 0 with 94 cases killed; `npm run lint:md` 0 errors.

Remaining residuals from the review: the pass-per-arm flow and the long start/stop deadlines have only been exercised against
fakes and a loopback server; a configuration change of the endpoint port invalidates stored observations (intended, use a
new `--out`); the shape pins are text pins of the server source, so a refactor that keeps the shape but changes the spelling
fails them loudly rather than silently.

## B3-c integration (naive arm as a second pass of the same home)

*Superseded in part by [B3-integration](B3-integration.handoff.md): the marker-only rule and the note shapes described here are the
first version. The arm rule that is now applied (marker on every sealing attempt, `arm_mode_mixed`, the probe-call rule, the database
vouching for the run) and the shapes the runner reads (`attempt`, `epoch`, `summaryLimitBytes`, `outputLimitTokens`, `degradedReason`)
are in that hand-off and in the runbook.*

Read from `lane/b3c-naive-arm` (at that time not merged, not edited): home config `home.relayCompaction: 'naive'` is node-wide; a naive run writes
`{relay:'compaction',mode:'naive'}` before its first model call, `probe_not_applicable` per cycle after the first and
`compaction_summary` after each seal; a ledger run writes none of them. Runner changes (commit `feat(bench): naive arm as a
second pass`):

- **Both arms may share one endpoint** in separate passes (`--arms`, same `--out`, merged measurement; the earlier distinct-url
  rule of M5 is superseded). Two arms behind one endpoint in one pass remain refused, since a node has one mode at a time.
- **The arm is confirmed from the run's own events** (`armModeOf`; first version, a single marker: see the note above for the rule
  now applied): a naive trial must show the `naive` statement, a ledger trial no
  naive marker; no readable events, an unknown mode, or naive markers without the statement are `unconfirmed`. A disagreement is
  never relabelled: the trial is not stored and not in the document, nothing else starts, `summary.json` has
  `halted: arm_mode_mismatch | arm_mode_unconfirmed`, exit `1`. A mismatched run exists on the node under its key, so the
  operator changes `keySalt` after fixing the mode (runbook).
- **`probe_not_applicable`** is a non-result fact: the probe group of that cycle is `unknown{unsupported}` (not a pass, not a fail,
  excluded from probe accuracy; a cycle with no probe note of either kind stays `unknown{unavailable}`).
- **`compaction_summary`** losses (`truncated`, `degraded`, `inputDropped`, `inputCut`) are per-trial `notes` in `summary.json`,
  deliberately not added to the runtime truncation count (a cut summary is a harness event).
- The fake relay emits the same notes (`FakeRelay.homeMode`, settable between passes) and an `initialized` note; the fake's default
  naive scenario no longer simulates probe escalation, since the real arm asks no probes.
- Runbook: the two-pass procedure replaces the second-endpoint example.

Tests: 91 new (8 more than after review), 169 envelope, bench 260/260; tsc, eslint, `lint:md` clean; mutations 101 cases killed
(7 new: `b3b-arm-mode-confirmed`, `-arm-mode-halts`, `-arm-mode-exit`, `-arm-needs-events`, `-arm-naive-without-statement`,
`-arm-unknown-mode`, `-probe-not-applicable`). Two mutation sites moved with the code and were re-pointed
(`b3b-exit-incomplete`, `b3b-halt-on-unsettled`).

**Post-merge residual - closed by B3-integration:** the three note shapes are no longer pinned by source text. B3-integration drives the
merged server's real `RelayExecutor` with its own test fixture and feeds the result through the runner
(`test/relay-smoke-server-shapes.test.ts`), which also caught that the shapes had changed after this section was written.

## Next slice

Superseded: B3-c is merged and B3-integration is done. The next slice is the pilot in both passes on the Fedora node (see
[B3-integration](B3-integration.handoff.md)), then per-field probe results if the relay records them.

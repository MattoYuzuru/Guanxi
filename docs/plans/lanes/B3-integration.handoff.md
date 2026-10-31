# B3-integration hand-off — runner reads the shipped naive-arm notes

**Status:** implemented and tested offline; **never run against a real model or the Fedora node**. B3 stays `proposed`, no
criterion is evaluated, `realEvidenceCredit` stays 0. Independent review has not been done (the lead runs it) ·
**Updated:** 2026-10-31 · **Branch:** `lane/b3-integration` · **Base:** `lead/wave7` `8923b8ac` · **Decision:** D-219 ·
**Inputs:** [B3-b hand-off](B3-b-smoke.handoff.md), [B3-c hand-off](B3-c-naive-arm.handoff.md) · **Runbook:**
[RELAY_SMOKE.md](../../../packages/bench/RELAY_SMOKE.md)

## What was wrong

B3-b's runner confirmed each trial's arm from one `compaction` marker, written against the first B3-c shape. After B3-c's review the
notes changed (marker and `compaction_summary` carry `attempt`, the marker also `epoch`; `compaction_summary` reports
`summaryLimitBytes` instead of `handoffLimitBytes`, plus `outputLimitTokens` and `degradedReason`; a mixed-mode run shows as a
sealing attempt in `relay_seals` with no marker). Nothing failed, because the fake relay still emitted the old shapes and the
runner ignored the new fields. The consequences were: a naive run whose second attempt ran in ledger mode (a node restarted in the other
mode) was accepted as naive, and the summary limits and degraded reasons were not recorded.

## What changed (all in `packages/bench`; server, contract, web untouched)

| Area | Change |
| --- | --- |
| `src/relay-smoke-facts.ts` | `compaction` fact carries `attempt` and `epoch`; `compaction_summary` carries `attempt`, `summaryBytes`, `summaryLimitBytes`, `outputLimitTokens`, `degradedReason` (each `null` when absent or malformed, never coerced). `armModeOf(facts, sealingAttempts)` returns `ledger`, `naive`, `mixed` or `unconfirmed`. |
| `src/relay-smoke-source.ts`, `relay-smoke-build.ts`, `relay-smoke-run.ts` | the home-database reader selects `relay_seals.attempt_id` into `SealObservation.attemptId` (also for an unreadable seal); the stored observation schema requires it; `runTrial` passes the sealing attempts to `armModeOf`. A new fixed code `arm_mode_mixed` (halt, exit `1`) joins `arm_mode_mismatch` and `arm_mode_unconfirmed`. |
| per-trial `notes` in `summary.json` | `compaction_summary_degraded_reasons:<code>=N,…`, `compaction_summary_limit_bytes:min=…,max=…`, `compaction_output_limit_tokens:min=…,max=…` added to the existing `compaction_summaries`, `_truncated`, `_degraded`, `compaction_input_loss`. `probe_not_applicable` is unchanged: the probe group of that cycle is `unknown{unsupported}`, never a result. |
| `src/relay-smoke-cli.ts` | preflight fails a planned naive arm with no `homeDb` (`naive_arm_needs_home_database`): it cannot be attributed without the sealing attempts. |
| `src/relay-smoke-fake.ts` | emits the current shapes (per-attempt marker with `attempt`/`epoch`, new summary fields). A cycle can name its `attempt`, its `mode` (a restart in the other mode between attempts) and a `summaryDegraded` reason. |
| `RELAY_SMOKE.md` | the arm-confirmation rules, the three halt codes, the new notes, the home-database requirement. |

## The arm rule now applied

- **naive trial:** every attempt in `relay_seals` has its own marker (else `mixed`); every `compaction_summary` names a marked attempt;
  marker epoch equals seal epoch; no marker states itself twice with a different epoch; a marker has a known mode (`naive`), an attempt
  id and an epoch; **no `probe` or `probe_degraded` note** (only a ledger attempt writes them: this catches a ledger attempt that
  probed and was stopped before it sealed, which leaves neither a marker nor a seal) and no `probe` model call (review M2); the home database was read, holds the run's row and every sealed cycle's seal (`unconfirmed` otherwise, review M1).
- **ledger trial:** no marker; `compaction_summary` or `probe_not_applicable` without a marker is `unconfirmed`; a marker with
  anything else is `naive`/`mixed`, i.e. a mismatch.
- A mismatch, a mixed run or an unconfirmed one is not stored, not in the document, halts the cohort and exits `1`; a run is never relabelled.

## Tests

| Command (Mac, Node 26, worktree-local `npm ci`; `@guanxi/contract` resolves inside the worktree) | Result |
| --- | --- |
| `node --test 'test/*.test.ts'` in `packages/bench` | first round: 270 tests, 270 pass (260 before); final figures after the review fixes: 281 / 281 |
| `npx tsc --noEmit -p packages/bench` | exit 0 |
| `npx eslint .` in `packages/bench` | 0 problems |
| `node packages/bench/tools/mutations.ts` | first round: exit 0, 118 cases killed (101 before); final: 128 (see Review findings and fixes) |
| `node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test packages/server/test/relay/naive-compaction.test.ts` | 17 tests, 17 pass (server untouched) |

**New:** `test/relay-smoke-server-shapes.test.ts` (5 tests) drives the server's real `RelayExecutor` with the server's own fixture
(`server/test/relay/fixture.ts`, the fake model of `naive-compaction.test.ts`) over a **file database**, in ledger and naive mode, and reads
it back the way the runner reads a node: session events through `HttpRelaySource.events` (so the contract's `sessionEventsResponse` parse),
seals through `SqliteLedgerReader` (the real `relay_seals` columns), then `projectEvents`, `armModeOf` and `buildTrialSlot` into a document
that `checkRelayMeasurement` accepts. It covers a pure naive run (marker attempt equals the sealing attempt, summary fields,
`probe_not_applicable` as a non-result, the note text), a pure ledger run (no naive notes, a counted probe), a degraded summary
(`model_failed`), two real attempts in each mode order (naive then ledger and ledger then naive are `mixed`, naive twice is `naive`) and
a stopped ledger attempt that only probed (`mixed` through the probe). This file imports the server like the older drift test, so
the mutation tool, which copies the bench package alone, does not run it. Its guards are checked by
`packages/bench/tools/server-shape-mutations.ts` (see "Review findings and fixes": 19 one-line mutants, server and runner side,
edited in place and restored; every one must fail the file).

The unit-level guards (facts, run, build, db, cli) are in the mutation tool. Existing assertions are unchanged except in place:
the facts test's note literals gained the new fields (the old `handoffLimitBytes` literal is gone) and the `armModeOf` calls gained their
second argument; the preflight test's "reachable endpoint without a database is fine" case uses a ledger-only configuration, and its
failing-database case now also lists the naive arm's new code; one assertion about the notes of an arm whose probes do not apply gained the
two limit notes. The run test for a halted mixed trial asserts the cohort stops and nothing is stored.

## Why behavioural and not text pins

The older drift test pins shapes as source-text matches because those shapes are TypeScript types. Here the real executor can be
driven offline with the existing server fixture, so a rename, a retype or a changed attempt id fails by behaviour rather than by spelling,
and the pin covers the reader (`attempt_id`) and the contract parse as well. No text pin was added for the three notes.

## Residual risk and not done

- **No real run.** Event ordering, a `step` that is not the cycle, real attempt ids under a restart, and the timing of the stop between
  attempts are exercised only through the server fixture and the fake. The pilot should be read against `summary.json` notes first.
- **A ledger attempt killed before it seals anything and before it starts its first probe call leaves no trace** in either source (a first
  cycle, or a stop between a seal and the next probe); the relay's README states the same limit. Any ledger attempt that reached a
  probe leaves the `call_started` of purpose `probe`, even when hard-killed during the call (review M2).
- **A naive trial now needs the home database to be readable at confirmation time.** A transient read failure halts the cohort with
  `arm_mode_unconfirmed`, unstored; the rerun re-attaches to the same key. This is stricter than before by design.
- **An observation stored by the earlier runner lacks `seals[].attemptId`** and fails the strict schema (`smoke_config_observation_invalid`,
  exit 2). No real observation exists, so use a new `--out`.
- **Semantics unchanged and still defaults, not owner answers:** the definition of "naive", the per-field probe results (not recorded by
  the relay), a judge set the same way in both passes, a naive home also serving a lead's relay.
- Independent review is the lead's.

## Review findings and fixes

Independent review of this lane (and `dc57cdc3`): no Critical or High. Fixes are in separate commits after `57625a2a`.

| Finding | Fix | Proof |
| --- | --- | --- |
| **M1** a wrong or stale `homeDb` (right schema, no rows for the run) returns empty seals, so the sealing-attempt check was vacuous: naive A1 + ledger A2 read as naive | `armModeOf` takes `SealEvidence {seals (with cycle), snapshot}`; a naive trial is `unconfirmed` unless the run's `relay_runs` row exists (`ledger.final !== null`) and every `sealed` event has its `relay_seals` row. `sealEvidenceOf(ledger)` is the one conversion, used by the runner and by the shapes test | facts test (no row, missing seals, one missing seal, early naive run needs only the row); run test (stale reader on a ledger-then-naive run: `arm_mode_unconfirmed`, right reader: `arm_mode_mixed`); shapes test reads a real mixed run through a seeded empty file |
| **M2** a ledger attempt killed in the middle of its probe call leaves `call_started` `probe` but no `probe` note | any `call_started` of purpose `probe` in a naive trial is `mixed`, whatever the database says (checked before the database evidence). The residual wording in the runbook and above is corrected | facts test (work/narrative calls stay naive, probe call mixed, with a null database); shapes tests: the executor announces the call, a naive run never makes one, a real stopped ledger attempt is mixed by the note alone and by the call alone |
| **M3** the start key omitted `harnessRevision` | `trialKey(…, salt, harnessRevision)`; the fingerprint keeps its own harness field (now redundant: the mutation `b3b-fingerprint-harness` is equivalent and was removed, the test that triggered it now asserts a new key and a new run). RELAY_SMOKE.md step 6 says the full run uses the pilot's `--out`, and what a new `--out` does | run test (keys differ by revision, a changed arm revision starts a new relay and stores a new record); mutation `b3int-key-revision` |
| **M4** `probe_not_applicable.damaged` was parsed and not reported | per-trial note `naive_handoff_damaged:N` | run test with a fake `damagedSeal`; shapes test with a real damaged stored seal; mutation `b3int-damaged-note` |
| **L1** the refresh path re-saved without the arm rule | one `modeProblemOf` serves both paths; a refresh that shows the other arm returns the problem and leaves the stored record untouched | run test (ledger trial with a transient failure, then a re-read that carries a naive marker); mutation `b3int-refresh-arm-rule` |
| **L2** `run` output lacked `halted`; exit table lacked the halts | `halted` on stdout; exit `1` row lists the three halts | CLI test; mutation `b3int-cli-halted` |
| **L3** pre-pass mode check; per-arm salt | the node exposes no compaction mode (nothing in the contract or the start status), so there is no cheap check: the runbook states that the mode is known only after the first trial (about 75 minutes) and tells the operator to start each pass with the pilot task. `keySalt` is now settable per arm (default: the configuration's), so fixing one arm does not orphan the other | run test (naive salt changes only the naive key); mutation `b3int-key-arm-salt` |
| **L4** docs | `B3-b-smoke.handoff.md` marks its marker-only rule and text-pin residual as superseded and points here; RELAY_SMOKE.md says B3-c is merged | docs |
| **L5** manifest; window | manifest lists only observations whose key is in the summary; `window_tokens_differ_between_trials:A/B` is a note on every observed trial when the loaded windows differ | CLI and run tests; mutations `b3int-manifest-included-only`, `b3int-window-note` |
| **L6** sealed cycle without a `compaction_summary` | a note, not a mode failure: `compaction_summary_missing:<cycles>` (the summary note is written after the seal, so a death in between is legitimate and the loss must be visible) | run test with a fake `summaryMissing`; mutation `b3int-summary-missing-note` |
| hand mutants not committed | `packages/bench/tools/server-shape-mutations.ts`: 19 mutants (10 server-side note changes, 9 runner-side rules), edited in place, restored in a `finally` and on SIGINT/SIGTERM. Run: `node packages/bench/tools/server-shape-mutations.ts` from the repository root | exit 0, "19 mutants, all killed" |

Tests were added, not weakened: the facts-test calls of `armModeOf` pass the new evidence shape through a helper, and the one test that
asserted `smoke_config_observation_mismatch` for a changed per-arm harness revision no longer can (the key changes first; see M3). One
mutation case (`b3b-fingerprint-harness`) was removed as equivalent; `b3b-arm-mode-confirmed` and `b3b-key-per-seed` and four
`b3int-*` sites were re-pointed to the moved code.

Gates (same environment): bench `node --test 'test/*.test.ts'` 281 tests, 281 pass; `npx tsc --noEmit -p packages/bench` exit 0;
`npx eslint .` in `packages/bench` exit 0; `node packages/bench/tools/mutations.ts` exit 0, 128 cases killed;
`node packages/bench/tools/server-shape-mutations.ts` 19 of 19 killed; `naive-compaction.test.ts` 17 of 17; `npm run lint:md` 0 errors.

## Next slice

Run the pilot (`ll-money-text`) in both passes on the Fedora node with the restart-per-arm procedure, read `summary.json` notes
(`compaction_summary_degraded_reasons`, the limits) before the full cohort, and give the independent reviewer `summary.json`,
`report.json`, `measurement.json`, `manifest.json` and the commit ids.

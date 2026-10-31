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
  probed and was stopped before it sealed, which leaves neither a marker nor a seal); the home database was read (`unconfirmed`
  otherwise).
- **ledger trial:** no marker; `compaction_summary` or `probe_not_applicable` without a marker is `unconfirmed`; a marker with
  anything else is `naive`/`mixed`, i.e. a mismatch.
- A mismatch, a mixed run or an unconfirmed one is not stored, not in the document, halts the cohort and exits `1`; a run is never relabelled.

## Tests

| Command (Mac, Node 26, worktree-local `npm ci`; `@guanxi/contract` resolves inside the worktree) | Result |
| --- | --- |
| `node --test 'test/*.test.ts'` in `packages/bench` | 270 tests, 270 pass (260 before; 10 new, 2 changed in place) |
| `npx tsc --noEmit -p packages/bench` | exit 0 |
| `npx eslint .` in `packages/bench` | 0 problems |
| `node packages/bench/tools/mutations.ts` | exit 0, 118 cases killed (101 before; 17 new `b3int-*`; three `b3b-arm-*` sites re-pointed to the new code) |
| `node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test packages/server/test/relay/naive-compaction.test.ts` | 17 tests, 17 pass (server untouched) |

**New:** `test/relay-smoke-server-shapes.test.ts` (5 tests) drives the server's real `RelayExecutor` with the server's own fixture
(`server/test/relay/fixture.ts`, the fake model of `naive-compaction.test.ts`) over a **file database**, in ledger and naive mode, and reads
it back the way the runner reads a node: session events through `HttpRelaySource.events` (so the contract's `sessionEventsResponse` parse),
seals through `SqliteLedgerReader` (the real `relay_seals` columns), then `projectEvents`, `armModeOf` and `buildTrialSlot` into a document
that `checkRelayMeasurement` accepts. It covers a pure naive run (marker attempt equals the sealing attempt, summary fields,
`probe_not_applicable` as a non-result, the note text), a pure ledger run (no naive notes, a counted probe), a degraded summary
(`model_failed`), two real attempts in each mode order (naive then ledger and ledger then naive are `mixed`, naive twice is `naive`) and
a stopped ledger attempt that only probed (`mixed` through the probe). This file imports the server like the older drift test, so
the mutation tool, which copies the bench package alone, does not run it. Instead each guard was checked by hand with 14 one-line
mutants, server and runner side, and every one fails the file: marker `attempt`/`epoch` renamed or dropped, summary `attempt`,
`summaryLimitBytes`, `outputLimitTokens`, `degradedReason` renamed, `probe_not_applicable` renamed, the marker switched off, the
`attempt_id` column replaced, the sealing-attempt rule, the ledger-probe rule, the reasons parse and note, the `unsupported` probe
group. The script is not committed.

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
- **A ledger attempt interrupted before it probes or seals anything leaves no trace** in either source; the relay's README states the same
  limit. The probe rule covers a ledger attempt that reached its cycle-2-or-later orientation.
- **A naive trial now needs the home database to be readable at confirmation time.** A transient read failure halts the cohort with
  `arm_mode_unconfirmed`, unstored; the rerun re-attaches to the same key. This is stricter than before by design.
- **An observation stored by the earlier runner lacks `seals[].attemptId`** and fails the strict schema (`smoke_config_observation_invalid`,
  exit 2). No real observation exists, so use a new `--out`.
- **Semantics unchanged and still defaults, not owner answers:** the definition of "naive", the per-field probe results (not recorded by
  the relay), a judge set the same way in both passes, a naive home also serving a lead's relay.
- Independent review is the lead's.

## Next slice

Run the pilot (`ll-money-text`) in both passes on the Fedora node with the restart-per-arm procedure, read `summary.json` notes
(`compaction_summary_degraded_reasons`, the limits) before the full cohort, and give the independent reviewer `summary.json`,
`report.json`, `measurement.json`, `manifest.json` and the commit ids.

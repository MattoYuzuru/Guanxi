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
| `node --test test/relay-smoke-*.test.ts` (in `packages/bench`) | 61 tests, 61 pass, 0 fail, 0 skipped |
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

## Next slice

B3-c (server, suggested): the naive-compaction relay mode and per-field probe results, then run the two-arm smoke.

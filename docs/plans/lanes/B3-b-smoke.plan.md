# B3-b — relay-benchmark smoke cohort producer: plan

**Status:** implemented and fixture-validated offline (see the [hand-off](B3-b-smoke.handoff.md)); B3 stays `proposed` and this lane evaluates no B3 gate ·
**Updated:** 2026-10-31 · **Branch:** `lane/b3b-smoke` · **Base:** `lead/wave7` `14b1d569` ·
**Ports:** 5233 / 4433 · **Decision:** D-219 (smoke cohort now, full cohort is an MS2 exit condition)

## Goal

Build the **producer** that B3-a lacks: something a lead can run against a real relay endpoint
(the owner API of a home node, as in the MS1 runs) that executes a small task × arm cohort,
records what was observed into a `guanxi.b3.measurement/v1` document accepted by
`validateRelayMeasurement`, and reduces it with `reduceRelayMeasurement`. The result is a
first **descriptive** reading (counts, `null` fractions where a denominator is unknown). It is
not a gate verdict, and every B3 criterion stays `unevaluated`; `realEvidenceCredit` stays 0.
Everything is testable offline with a deterministic fake relay. The Fedora node is not
reachable from this lane.

## What exists (read from source, not assumed)

| Piece | Where | Relevance |
| --- | --- | --- |
| Strict envelope, digests, validator | `packages/bench/src/relay-protocol.ts` | the target format; unknown facts are legal (`unknown{reason}`) |
| Descriptive reducer | `packages/bench/src/relay-measurement.ts` | consumes the validated document |
| Public relay start | `POST /api/relay`, `GET /api/relay/starts/:key` (+ `/stop`), `relayStartInputSchema`/`relayStartStatusSchema` in `@guanxi/contract` | the endpoint MS1 run A7 used (`relay exec`, the lead's `guanxi_delegate`); identical start keys are idempotent, so a re-POST resumes observation |
| Relay trace over HTTP | `GET /api/sessions/:sessionId/events?after&limit` (person audience, `agent.note` events with `{relay: …}` JSON text, `assistant.started/message`, `error`) | cycle boundaries, seals, probes, context drops, errors, per-call message ids and `step` (cycle) |
| Ledger, seals, call costs | home node SQLite: `relay_seals(run_id, cycle, attempt_id, epoch, ledger, handoff, artifact_hash, bundle)`, `relay_runs`, `run_costs(entry_key, input_tokens, …)` | per-cycle item status and gate evidence, ledger/handoff integrity, per-call rendered tokens. MS1's own `~/ms1/ops/status.sh` already reads this database read-only with `sqlite3` |
| Real target and plan shape | `Guanxi-Test-Repo` (`ledger-lite`, 20 items I01–I20, `SPEC.md`, protected `test/`), base `51c44bfd10f4f756d0efbab050555dec9a9e8fea`; MS1 plan I01–I10, acceptance argv `["node","--test","test/NN-….test.mjs"]`, `protectedPaths: ["test"]` | the smoke corpus is drawn from it; nothing from `SPEC.md` is copied into this repository |
| Operator procedure | `docs/operations/ms1-live-run.md` (two nodes, forwards, `preflight`, project registration, `relay exec`) | unchanged; the smoke runner is another client of the same home owner API |

## The gap

1. No task corpus for B3 and no digests for it.
2. Nothing turns a relay run into cycle/item/probe/context/guard/integrity rows or evidence
   metadata.
3. No orchestration (sequence, resume, deadlines, cancel, partial documents).
4. **No naive-compaction mode exists** (`rg naive packages/server` finds nothing). See
   "The naive-compaction arm".
5. No runbook for the cohort.

## Boundaries (respect B3-a)

The B3-a plan and review forbid a CLI mode **of the validator/reducer**, and any wiring of the
validator into a runner/plugin/REST/UI. This lane leaves `relay-protocol.ts` and
`relay-measurement.ts` untouched. The runner is a separate entry point
(`packages/bench/src/relay-smoke-cli.ts`) that imports `validateRelayMeasurement` and
`reduceRelayMeasurement` as ordinary library calls. No B1 `Plan`/`Trial` schema or threshold
changes; no slope, bootstrap, non-inferiority or `conclusion()` call; no gate wording in any
output. The document is labelled `recorded_observation` only when the source is a real HTTP
endpoint; the fake relay can only produce `synthetic_fixture` (asserted). The reducer still
grants credit 0 for both labels.

## Design

### Pure core, thin IO

```text
corpus ─┐
config ─┼─► plan (digests) ─┐
        │                   ├─► runner ─► per-trial observation (projected facts, sidecar JSON)
RelaySource (port) ─────────┘                │
  ├ HttpRelaySource   (owner API: start/status/events/stop)
  ├ SqliteLedgerReader (optional, read-only home DB)
  └ FakeRelay          (tests, `fixture` command)
                                              ▼
                       buildTrialSlot (pure) ─► assemble envelope ─► validate ─► reduce
```

Only `relay-smoke-source.ts` (HTTP, SQLite) and the CLI do IO. Builders take an injected
`now()` and never read a wall clock or the file system.

### Corpus (`relay-smoke-corpus.ts`)

Five tasks, each a relay plan of five `ledger-lite` items whose dependencies are all inside the
plan, so one item usually needs about one cycle and a task needs five or more:

| Task | Items |
| --- | --- |
| `ll-money-text` | I01, I02, I03, I04, I05 |
| `ll-order-balance` | I03, I04, I08, I09, I10 |
| `ll-budget-dups` | I03, I04, I09, I11, I13 |
| `ll-rules-fx` | I01, I02, I04, I07, I14 |
| `ll-query-log` | I01, I03, I16, I17, I18 |

Each item: id, title naming its `SPEC.md` section, `dependsOn`, acceptance argv
(`["node","--test","test/NN-name.test.mjs"]`), `protectedPaths: ["test"]`. Plan `base` is the
pinned base commit; goal is a fixed short sentence. The 20 acceptance test blob ids at the base
commit are pinned; `preflight --repo` verifies them against a checkout, so the verifier set
digest binds real file identities, not only names. Digests (documented fixed-field tuples,
`guanxi.b3.smoke.*/v1`): `taskManifestSha256` (tasks, items, deps, base, goal),
`acceptanceSha256` (every task×item argv, sorted), `verifierSetSha256` (base + blob ids of the
used tests). Whether the relay really needs five cycles is an observation, not a promise: the
document records the cycles that happened and the horizon slots beyond are `not_reached`.

### Configuration (`relay-smoke-run.ts`, strict zod, JSON file)

Endpoint URL (loopback only), `projectId`, `connectionId`, `model`, `domains`, `harnessRevision`
(git commit of the home checkout), stratum descriptors (provider, model, revision, quantization,
and free-text descriptors for runtime, adapter and resource profile that are **hashed** into the
plan; the text itself never enters the document), `windowTokens` (32768), `horizon` (also sent
as `caps.cycles`, so a run cannot exceed the slots the document has), other caps, seeds, task
subset, per-arm entries, polling and deadline timings, optional `homeDb`. Per-arm entries carry
`kind`, `id`, `enabled`, an optional own endpoint/project/connection/`homeDb`, optional opaque
`startFields` merged into the POST body, and two honest booleans that describe the arm:
`ledgerHandoff` (integrity group applies) and `deadEndGuard` (a repeated dead end counts as
guarded). A planned arm needs an enabled entry; otherwise the plan marks it `unsupported`
with an `arm_declaration` evidence record, which the validator already supports.

### Mapping a relay run into the document (`relay-smoke-facts.ts`, `relay-smoke-build.ts`)

Events are first **projected** to content-free facts (`cycle_begin`, `sealed`, `probe`,
`probe_degraded`, `context_dropped`, `call_retry`, `judge_signals`, `assistant started/message`
ids and steps, `error` codes). Event text, tool arguments and assistant messages are not kept;
the sidecar observation file holds only facts (AGENTS: no private workspace contents in logs).
Both note shapes are parsed (store events `{data, relay}`, executor events flat).

| Document element | HTTP events only | With the home database |
| --- | --- | --- |
| trial slot, run id, outcome | status → fixed outcome table (completed → `passed`; `input_required` after `probe_failed_twice`/`no_progress` → `escalated`; `interrupted` and infrastructure codes → `infra_error`; canceled/deadline → `cancelled`; other failures → `failed`) | same |
| cycles 1..N | `cycle_begin`/`sealed` event times; slots after N are `not_reached`; N > horizon cannot happen (cap) | same, attempt/epoch from seals |
| items | `unknown{not_collected}` | opportunity = an item whose first gate evidence appears in cycle k (diff of consecutive sealed ledgers); result = last gate evidence of that item in k (`passed`/`failed`); unassessed items are listed in the sidecar summary, not invented |
| probes | `whole_answer` occasion from `probe` events (attempt = retry + 1; `damaged` is incorrect); cycle 1 has no probe (empty manifest) | same |
| critical-field probes | **not collected**: the relay records only whole-answer correctness, so the reducer's critical-field denominators stay empty/incomplete | same |
| context | `unknown{not_collected}` | one sample per relay call: window = observed `runtime.contextTokens`, rendered = recorded input tokens (join of `run_costs.entry_key` with the call message id), truncation event = a `truncation_protocol` error attached to the last call of its cycle |
| guards | `judge_signals` facts when the observer did not mark `deadEnds` unknown; otherwise `unknown{not_collected}` | same |
| integrity | `unknown{not_collected}` | seal ledger re-hashed by the runner, the handoff's own ledger hash, the bundle blob hash; `reportedValidation` passed only if all three agree; `unknown{unsupported}` for an arm without ledger handoff |
| forecasts | none (ETA needs trusted-host history; criterion stays unevaluated) | none |

The runner never imputes: a fact that cannot be read is `unknown` with a fixed reason, a
failed or missing trial is `missing`, and the whole thing still validates. Evidence records are
metadata only (the schema takes no content); each bears a deterministic id, and the sidecar
observation files plus a manifest of their SHA-256 values are the audit trail. Structure is not
authenticity and this lane does not change that.

### Orchestration and the command

Sequence per task, per seed, per arm (arms interleaved for paired comparison). Start key =
`b3s-` + 16 hex of a digest of experiment, task, arm and seed, so a rerun re-attaches to a run
that is still active or finished (idempotent start). Observations are written per trial, so a
re-run skips trials already observed (resume) and a SIGINT stops the active relay and writes a
document with `missing{not_collected}` for what did not run. A trial deadline stops the relay
(`cancelled`). Output directory contents: `observations/*.json` (facts), `measurement.json`,
`report.json`, `summary.json`.

`packages/bench/src/relay-smoke-cli.ts`, JSON on stdout, nothing else on stdout:

| Command | Purpose |
| --- | --- |
| `plan` | print corpus, digests, expected trial count and the unsupported-arm list |
| `preflight --config F [--repo PATH]` | config parse; fixture repo base/blobs; endpoint reachable; home database tables |
| `run --config F --out DIR [--tasks a,b] [--arms x,y] [--seeds 0]` | execute, assemble, validate, reduce |
| `report --measurement F` | validate and reduce a saved document |
| `fixture --out DIR` | the same pipeline against the built-in fake relay (offline self-test) |

Exit codes: `0` every planned trial reached a terminal observation and the document validates;
`3` the document validates but some planned trials are missing/cancelled; `1` failure (invalid
document, unreachable endpoint, preflight failure); `2` usage or configuration.

### The naive-compaction arm (flagged, not implemented here)

**Finding:** the relay has exactly one handoff mechanism (the ledger strip plus sealed handoff
with probes, ADR-0020). There is no compaction policy, and the public wire schema
(`relayStartInputSchema`, strict) has no field to select one. A naive arm therefore needs
server work, and it is **not small**:

- *Where it would live:* a trusted-host, node-wide, default-off setting, not a wire field:
  `RelayLimits.compaction?: 'ledger' | 'naive'` in `packages/server/src/relay/types.ts`
  (beside `structuredOutput`), read by `executor.ts`, set by the `ms1-live` home config
  (`home.relayCompaction`). A second home process (own data directory and port) runs the
  naive arm, which is why the runner's per-arm entry may name its own endpoint. No contract,
  migration or route change.
- *What it must change in `executor.ts`:* (1) the work context uses a model-written running
  summary of the previous cycle instead of `strip(l)` and omits the `work.query`/`notes.search`
  tools, so the ledger cannot be re-read; (2) `handoff()` seals only that summary (no strip,
  notes or handoff validation as a gate); (3) `orient()` still asks the five probes but a
  failure is recorded, not fatal (no `probe_failed_twice` escalation); (4) the harness keeps
  verifying and checkpointing exactly as before, so item outcomes stay comparable.
  That is roughly 3 sites in `executor.ts`, a ms1-live config key, and tests for default-off,
  summary-only context and non-fatal probes. It is beyond a small flagged option and also
  needs an owner-level decision about what "naive" means (summary of the whole transcript vs
  last-cycle summary), so it is **left as a design** for a server lane (suggested id
  `B3-c`, owner: server relay author, Sonnet 5.5 per D-220).
- *What this lane does instead:* the runner and the builders are arm-agnostic. The naive arm
  is declared `unsupported` unless the config enables it with its own endpoint, and the fake
  relay implements both arms so the whole two-arm path (pairing, exclusion, reducer rows) is
  tested offline. With no server work the real smoke runs the ledger-relay arm and the report
  says the naive arm is unsupported.
- *Additive server wish-list found on the way (not done):* per-field probe results in the
  `probe` event (so critical-field accuracy becomes measurable), and a per-call record that
  carries the cycle (today the cycle is recovered from the message `step`).

## File ownership

New, all under `packages/bench`: `src/relay-smoke-corpus.ts`, `relay-smoke-facts.ts`,
`relay-smoke-build.ts`, `relay-smoke-source.ts`, `relay-smoke-fake.ts`, `relay-smoke-run.ts`,
`relay-smoke-cli.ts`; tests `test/relay-smoke-*.test.ts`; this plan and the hand-off.
Shared edits (minimal): `src/index.ts` (exports of the pure modules, not the CLI),
`tools/mutations.ts` (new cases), `README.md` (section and runbook). No server, contract,
web or lock-file change. `PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` are not touched.

## Test plan (every guard has a failing assertion)

1. Corpus: five tasks, five items each, dependencies closed inside each plan, argv shape, blob
   ids for every used test, stable digests, plan accepted by `relayPlanSchema`, key
   uniqueness; changing a dependency/argv/blob changes the matching digest.
2. Facts: both note shapes parse, unknown and malformed notes are dropped, no event text
   survives projection.
3. Builder with synthetic observations: output passes `validateRelayMeasurement` for the
   full, HTTP-only, interrupted, escalated and truncated cases; hand-counted reducer numbers;
   cycle slots beyond the last are `not_reached`; opportunity ids unique across cycles;
   integrity `reported_mismatch` when a ledger or bundle hash differs; context truncation
   attaches to the last call; outcome table.
4. Orchestration with the fake relay: both arms, resume skips finished trials, SIGINT/abort
   leaves `missing` and exit `3`, deadline cancels, `caps.cycles` equals the horizon, the key
   is idempotent, an unsupported arm needs no trials, a fake-sourced document cannot be
   labelled `recorded_observation`, paired relay-versus-naive rows appear in the reducer.
5. HTTP source against a local fake server: request shapes parsed with the contract schemas,
   loopback-only URL, paging of events, non-2xx and malformed bodies fail closed without
   echoing the body.
6. SQLite reader against a database created from the server's own migration text: seals,
   costs and the final ledger read back; read-only (a write attempt fails).
7. CLI: JSON on stdout only, exit codes `0/1/2/3`, `plan`, `fixture`, `report`.
8. Mutations in `tools/mutations.ts`: remove each important guard (fake-origin lock, cycle-cap,
   idempotent key, not_reached tail, resume skip, truncation attachment, integrity agreement,
   unknown-instead-of-impute) and require an `AssertionError`.

## Gates

`node --test` on the new and the B3-a relay test files, then the whole bench test directory,
`npx tsc --noEmit -p packages/bench`, `node packages/bench/tools/mutations.ts` for the new
cases, `npx eslint packages/bench`, `npx markdownlint-cli2` on this lane's markdown. No full
`npm test`, browser gate or build. Final hosted CI belongs to the lead.

## Residuals this lane cannot close

The real cohort (Fedora node, hidden verifiers beyond the protected tests, five seeds), the
naive arm (server design above), critical-field probe accuracy, ETA forecasts, `E`
calibration, authenticated collection (evidence is metadata; a self-consistent forged
document gets no credit), and every statistical gate evaluation.

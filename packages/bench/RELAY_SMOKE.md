# B3 smoke cohort runner (B3-b)

**Status:** implemented and fixture-validated offline (fake relay, local loopback server, a database built from
the server's own table text); never run against the Fedora node or any real model · **Updated:** 2026-10-31 ·
**Decision:** D-219 · **Plan:** [B3-b plan](../../docs/plans/lanes/B3-b-smoke.plan.md)

This is the producer that [B3-a](../../docs/plans/lanes/B3-a.plan.md) lacks. It drives a small task × arm cohort
through the owner API of a home node, records what it can observe into a `guanxi.b3.measurement/v1` document,
validates it with `validateRelayMeasurement` and reduces it with `reduceRelayMeasurement`. The result is a
**descriptive reading**: counts, with `null` wherever a denominator is unknown. It is not a B3 gate verdict, every
criterion stays `unevaluated`, and `realEvidenceCredit` stays 0 (a recorded run earns no credit from this tool).
It is a separate entry point; the B3-a validator and reducer are unchanged libraries with no CLI mode.

## What is measured and what stays unknown

| Document element | Source | Without the home database |
| --- | --- | --- |
| trial outcome, cycle times, attempts | start status, session events (`GET /api/sessions/:id/events`) | same |
| whole-answer probe results and retries | `probe` notes | same |
| items (first gate per item per cycle, passed/failed) | sealed ledgers of the home database | unknown (`not_collected`) |
| context: window, rendered tokens, truncation | `run_costs` joined to call message ids, `truncation_protocol` stop | unknown |
| ledger/handoff/bundle integrity | the runner re-hashes the stored seal, handoff and bundle | unknown |
| guarded dead-end repeats | `judge_signals` notes when the judge observed dead ends | unknown; the stock judge collector declares dead ends unobserved, so expect unknown on the real run |
| critical-field probe accuracy | **not recorded by the relay** (only whole-answer correctness is) | not collected |
| ETA forecasts, `E` calibration | not available through the public start | not collected |

Structure is not authenticity: evidence records are metadata the runner derives, not signed receipts. A report
always says `authenticity: not_verified_offline`.

## Corpus

Five tasks of five `ledger-lite` items each (the private `Guanxi-Test-Repo`, base
`51c44bfd10f4f756d0efbab050555dec9a9e8fea`, protected `test/`): `ll-money-text` (I01–I05), `ll-order-balance`
(I03, I04, I08, I09, I10), `ll-budget-dups` (I03, I04, I09, I11, I13), `ll-rules-fx` (I01, I02, I04, I07, I14),
`ll-query-log` (I01, I03, I16, I17, I18). Acceptance is `["node","--test","test/NN-….test.mjs"]`, the same shape
as MS1 run A7. About one item per cycle was observed in A7, so a task needs about five cycles; the document records
the cycles that really happen. No `SPEC.md` text is stored in this repository.

## Commands

```bash
RS="node packages/bench/src/relay-smoke-cli.ts"
$RS plan [--config cfg.json]            # tasks, digests, planned/unsupported arms, expected trials
$RS preflight --config cfg.json [--repo ~/Projects/Guanxi-Test-Repo]
$RS run --config cfg.json --out DIR [--tasks a,b] [--seeds 0,1] [--arms ledger-relay]
$RS report --measurement DIR/measurement.json
$RS fixture --out DIR                    # the same pipeline on the built-in fake relay; offline self-test
```

stdout is exactly one JSON document; progress is JSON lines on stderr. Errors are fixed codes, never echoed input.

| Exit | Meaning |
| --- | --- |
| `0` | every planned trial reached a terminal observation and the document validates |
| `3` | the document validates but some planned trials are missing or were cancelled (interrupt, deadline, failed start, a relay that could not be accounted for). A `run` against a dead endpoint ends here: every start fails, every slot is `missing`, the document is still valid |
| `1` | `run`: the assembled document does not validate; `preflight`: a check failed; `report`: the document does not validate |
| `2` | usage or configuration: bad arguments, an unreadable or unparsable file (including a `report` input that is not JSON), a non-loopback URL, a stale (`smoke_config_observation_mismatch`) or malformed (`smoke_config_observation_invalid`) observation directory, two arms behind one endpoint in one pass (`smoke_config_arm_endpoint`) |

## How a trial is accounted for

- **Start.** `POST /api/relay` answers only after the relay is prepared, and the first observation of a model hashes the
  whole GGUF (minutes; the MS1 runbook allows 15). The start deadline is `timing.startTimeoutMs` (default 20 minutes) and
  the stop deadline `timing.stopTimeoutMs` (5 minutes); ordinary requests use 30 seconds.
- **A start that fails without a relay answer** (timeout, dropped connection, unreadable reply) is **not** treated as "not
  started": the runner asks for the status of the key (the relay registers a key while it prepares), and if that cannot be
  answered it stops the key. Only a relay that answered with a fixed refusal, or a key the relay does not know, counts as a
  failed start. If a relay cannot be shown to be terminal or stopped, the trial is not stored, **no further trial starts**
  (`halted: relay_state_unknown` in `summary.json`, exit `3`), and a rerun with the same `--out` re-attaches to the same key.
- **Stored means settled.** An observation is written only when the relay for its key is terminal or confirmed stopped.
  Interrupt, deadline and repeated status failures all try to stop the relay first.
- **Fingerprints.** Each stored observation carries a fingerprint of what it measured (stratum, horizon, project and
  connection, caps, the arm's kind, profile, endpoint, database and harness revision, the task plan, the seed). A changed
  configuration over an old `--out` is refused with `smoke_config_observation_mismatch`; use a new directory (or
  `keySalt` to redo a cancelled trial).
- **Transient read failures** (events, home database) are recorded and retried on the next run without starting anything.

## Item results are first-attempt-biased by construction

For each item the opportunity is the first cycle in which the item has gate evidence, and its result is the last gate of
that item in **that** cycle. An item that fails in its first cycle and passes in the next is recorded `failed` once and is
never counted again (B3-a allows one opportunity per item per trial). A later pass therefore does not appear in the
per-cycle numbers, and an early failure is not hidden by a later success, but a failure *within* a cycle followed by a pass
*in the same cycle* shows only the pass. These are descriptive conventions for the smoke, not the gate estimand.

## Running it for real (the lead, against the Fedora node)

1. **Bring the MS1 pair up** exactly as in [MS1 live run](../../docs/operations/ms1-live-run.md) sections 1 to 4
   (Fedora `llama-server` attached, executor node, ssh forwards, home node on the Mac under `caffeinate`, Colima
   running, `preflight` green on both). The home needs `home.alwaysOn`, `home.reserves` as in run A7, and **no lead**:
   the runner is a client of the public relay start. `home.judge.signals` is optional and only adds the dead-end
   facts if its collector observes them. Both nodes must run this checkout's commit.
2. **Register the fixture repository** once (workspace and project), as in section 5 of that runbook, and note
   the project id. The connection id is `connectionId` in the `started` event of `ms1-live start --json` (the
   connection named `ms1-executor`).
3. **Write a configuration** (no secrets; paths and ids only). Put it and the output outside the repository:

   ```json
   {
     "version": 1,
     "experimentId": "b3-smoke-2026-11-01",
     "harnessRevision": "<git rev-parse HEAD of the home checkout, 40 hex>",
     "endpoint": { "url": "http://127.0.0.1:4551", "homeDb": "/Users/<you>/ms1/home/data/guanxi.db" },
     "start": { "projectId": "<project id>", "connectionId": "<connection id>", "model": "qwen3.8-27b-iq3s", "domains": [] },
     "stratum": {
       "provider": "llama.cpp", "model": "qwen3.8-27b-iq3s", "revision": "b11496", "quantization": { "kind": "quantized", "id": "iq3_s" },
       "runtime": "llama.cpp b11496, CUDA, -c 32768 -np 1 --flash-attn on, q8_0 KV cache",
       "adapter": "ms1-live attach, structured output on",
       "resourceProfile": "RTX 3060 12 GB, 8 CPU threads of 12",
       "windowTokens": 32768, "tokenCountConvention": "llama-server-apply-template-tokenize-v1"
     },
     "horizon": 10,
     "caps": { "tokens": 6000000, "moneyMicros": 0, "wallMs": 14400000 },
     "seeds": [0],
     "timing": { "pollMs": 10000, "trialDeadlineMs": 18000000 }
   }
   ```

   `runtime`, `adapter` and `resourceProfile` are free text that is **hashed** into the plan; the text itself never
   enters the document. `horizon` is also sent as the relay's `caps.cycles`, so a run cannot exceed the document's
   cycle slots. Omit `arms` for the default: `ledger-relay` planned and `naive-compaction` **unsupported**
   (see below). Omit `tasks` for all five.
4. **Preflight:** `$RS preflight --config cfg.json --repo ~/Projects/Guanxi-Test-Repo`. Every check must be `ok`: the
   fixture base commit and the 15 pinned test blobs, the endpoint (an unknown key answering `relay_not_found` proves the
   route is live), and the home database tables. Without `homeDb` the check warns that items, context and integrity
   will be unknown. **The home node must be running**: its database is in WAL mode, and opening it with the node down
   would make the reader create `-wal`/`-shm` files next to it, so the reader refuses with `home_node_not_running`.
5. **Pilot one task:** `$RS run --config cfg.json --out ~/ms1/b3-smoke/pilot --tasks ll-money-text`. Budget from A7
   (10 items in 2 h 29 min): about 75 minutes per task per arm. A full ledger-arm cohort is about 6.5 hours; both arms
   about 13 hours. The executor has a single slot: do not run `preflight --completion`, a lead or any other relay
   meanwhile. Keep `caffeinate` on the home.
6. **Run:** the same command without `--tasks`, a new `--out`. Ctrl-C (SIGINT) stops the active relay and writes a valid
   document with what exists (exit `3`). Running the same command again with the same `--out` re-attaches: stored
   trials are final (even cancelled ones), unstarted ones run. To redo a cancelled trial, change `keySalt` in the
   configuration and use a new `--out`.
7. **Read the result:** `summary.json` (per trial: ended-by, status, cycles, whether the database was read, notes such as
   `items_never_assessed:I05`), `report.json` (the reducer output; start with `coverage`, `arms[].trials.outcomes`,
   `arms[].totals.items`, `.probes.wholeAnswer`, `.context.truncationEvents`, `.integrity`, `.guards`, and
   `unresolved`), `measurement.json` (the validated document), `manifest.json` (SHA-256 of every file, including the
   per-trial fact files under `observations/`). Keep the directory private (files are 0600); do not commit it.
8. **Hand the directory and the commit id to the independent reviewer.** Do not describe it as a B3 result.

If the outcome of a trial is `infra_error` or `cancelled`, the paired relay-versus-naive comparison drops the whole
task from both arms; that is intended.

## One arm per pass (restarting the home between arms)

A second home process needs its own federation pairing, so the realistic shape is one arm per pass against the same
`--out`: run all ledger trials, restart the home in the naive mode (once the server lane exists), run the naive trials.
Declare both arms in the configuration (they may share the endpoint and database), then:

```bash
$RS run --config cfg.json --out DIR --arms ledger-relay        # exit 3: the naive trials are still to do
# stop the home, restart it in naive mode, same data directory or another one named in the arm entry
$RS run --config cfg.json --out DIR --arms naive-compaction    # exit 0 once every trial is stored
```

Stored observations of the arm that is not run in this pass are read from `DIR/observations` (under the same fingerprint
rule) and the second pass writes one measurement with both arms. Two selected arms behind one endpoint and database in a
single pass are refused (`smoke_config_arm_endpoint`): they would label one node's data with two names. **Which mode a node
runs in is the operator's assertion**; `summary.json` says `armIdentity: operator_asserted` and lists a short hash of each
arm's endpoint and its harness revision (an arm entry may carry its own `harnessRevision`, so a node restarted on another
commit is told apart in the plan digest).

## The naive-compaction arm needs server work

The relay has one handoff mechanism and the public start has no field to select another. The arm is therefore
declared `unsupported` unless the configuration enables it with its own endpoint (a second home process whose relay
implements naive compaction). The design, its code locations (`RelayLimits.compaction`, three sites in
`executor.ts`, one ms1-live key) and why it is not small are in the
[plan](../../docs/plans/lanes/B3-b-smoke.plan.md#the-naive-compaction-arm-flagged-not-implemented-here). With such a
second node:

```json
"arms": [
  { "kind": "ledger_relay", "id": "ledger-relay" },
  { "kind": "naive_compaction", "id": "naive-compaction", "enabled": true, "url": "http://127.0.0.1:4651", "homeDb": "/Users/<you>/ms1/home-naive/data/guanxi.db" }
]
```

A naive arm is described as having no ledger handoff and no dead-end guard (`ledgerHandoff` and `deadEndGuard`
default to false; the ledger arm defaults to true because only its sealed handoff carries the live dead-end notes, `selectNotes`), so its integrity facts are `unknown{unsupported}` and a repeated dead end counts as unguarded.

## Failure codes

`endpoint_invalid` (not loopback http), `endpoint_unreachable`, `timeout`, `home_node_not_running`, `relay_http_failed`, `response_invalid`,
`runtime_meter_unavailable` / `relay_workspace_unavailable` / `relay_idempotency_conflict` /
`relay_local_connection_required` (the relay's own refusals, see the relay README), `home_database_unreadable`,
`smoke_config_invalid`, `smoke_config_tasks`, `smoke_config_arms`, `smoke_config_eta`, `file_unreadable`,
`file_invalid`. A trial whose start failed is not stored and is retried by the next run; its slot reads `missing`.

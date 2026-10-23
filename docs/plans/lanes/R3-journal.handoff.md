# R3 local judge observation journal hand-off

**Status:** implemented; all R3-journal review findings (P2-1…P2-4, P3-1…P3-5) fixed with
regression tests; merge with main (relay judge + stale-pin reaping) resolved; focused gates pass;
the full repository suite was not run in this sandbox.
**Branch:** `deepseek/r3-observation-journal` · **Base:** main `ee23dfa9`
**Updated:** 2026-10-23 · **Environment:** local clone, Node 26.9.0, ports 5234/4434,
`GUANXI_DATA_DIR=$PWD/.lane-data`; generated fixtures only. No live model, SSH, remote network,
owner data or push.

## Merge with main

`14d4b5cc` merges `origin/main` (`ee23dfa9`: the remote-relay judge lane and F2 stale-pin
reaping). The only conflict was `plugin.ts`; it keeps both lanes: the journal injection/purge
helpers and the `judge` start source with `startHostWithJudge`. Main's ledger 42 (F2-reap) and
the journal's additive ledger are independent.

## What was built

D-199 local sidecar in the relay plugin's SQLite. One row per actually evaluated judge request
(J1.5 checker, J2, J3), written at the cascade's single `request()` point through a small
`JudgeJournal` interface (the cascade imports no SQLite). A row contains run/session/attempt ids,
cycle, phase, layer, reason, request key, the exact scrubbed judge-visible packet (paths
included), the detached host `JudgeObservation`/policy/signals and both
`summary.unknownFacts`/`judge.unobserved`, terminal state and result, and start/finish
timestamps. A duplicate request that reuses a stored result adds no row; `UPDATE` is refused by
a trigger. A synchronous or asynchronous local journal failure is contained after the fenced
verdict is persisted and never rewrites it; the failure increments a per-run counter.

Additive independent ledger **43** (`relay_journal_migrations`); `user_version` (33), ledger 42
(F2-reap), ledgers 35/38 and every existing table are untouched. The plugin creates the journal
lazily on the first cascaded execution (a node with no judge creates no journal table) and
purges expired rows every 10 minutes. An executor given a cascade defaults to the journal;
`journal: null` turns it off; a bare `RelayJudgeCascade` without a journal creates no table.
The executor and plugin defaults are lazy sinks: `BEGIN IMMEDIATE`, DDL and the version check
run on the first `record()`, so a foreign ledger value, an open transaction or `SQLITE_BUSY`
cannot fail a public start or a judged relay before a verdict exists.

**Retention/egress.** Rows use the implemented D-113 reasoning window
(`DEFAULT_REASONING_RETENTION_MS`, 7 days), shortened by a parent Thread TTL, never extended.
`purgeExpired`, `purgeRun` and `purgeSession` are the explicit paths; `ON DELETE CASCADE` from
`durable_runs` removes rows with the owning run, and the native session delete calls the
non-migrating session purge inside its home-fenced transaction. Expiry is enforced on read as
well as by the timer. The scrubber must be ready before an insert or a read; every
packet/observation/result/signal is scrubbed at insert and again on read, so a registered secret
never enters a row or comes back out of one, while paths intentionally remain (D-199). Identity
fields are refused if they contain a registered secret. No route, contract, event, wake packet,
handoff, federation message or log reads the journal. There is deliberately no REST reader.

**Replay reader.** `readJournalReplay`/`readJournalCorpus` turn a finished run's J2 rows into the
strict R3-b v1 `ReplayRun`/`ReplayCorpus` (`origin: 'recorded'`). A real store leaves an
unverified done claim at `verification_requested` and only moves an item to `done` after a
passing gate, so both statuses are a claim; acceptance is the newest gate at the packet's
current head. Steps are keyed by attempt and ordered by (attempt ordinal, cycle, phase,
insertion id), so a recovery attempt is never stitched onto the previous attempt. Equal
`observedAt` values from a same-millisecond clock are valid; decreasing time is refused.
`unknownFacts` is carried into the step and a detector whose source fact was unobserved reports
an unknown step rather than replaying the zero as healthy. Labels stay empty unless the caller
supplies owner ground truth; a reader never invents a fault class. A counted failed row write
marks the run incomplete; the reader carries `incomplete: true` and the R3 gate refuses the
corpus as `incomplete_corpus`.

## Review fixes

Each item is a separate commit after the merge.

| Item | Commit | Fix |
| --- | --- | --- |
| P2-1 | `1e137040` | Done claims per item are derived from `verification_requested` as well as `done`, with the newest current-head gate; test uses a packet produced by a real `RelayStore` and scores it as `premature_done`. |
| P2-2 | `3c46ae18` | Replay selection keys include `attempt_id`; steps/read rows order by the run's attempt ordinal, so a recovery attempt's rows survive and boundaries are not stitched. |
| P2-3 | `52cb449e` | `lazyJournal` defers the store constructor to the first `record()` in both the executor default and plugin injection; construction failure is a null journal and the judged relay/verdict completes. Test sets a foreign ledger version 99. |
| P2-4 | `e68f69c7` | The plugin default is tested through a real public start; rows store `summary.unknownFacts` and `judge.unobserved`, and the reader carries the marker; equal-millisecond `observedAt` is valid and ordered by attempt/cycle/phase/insertion id. |
| P3-1 | `70055ea6` | The native session delete transaction purges journal rows by session (defence in depth); test uses a row whose run belongs to another session so the run cascade alone would leave it. |
| P3-2 | `ecc89c93` | Journal ledger renumbered from 42 to 43 after checking main (F2-reap owns 42; main's previous highest is 41). Nothing has shipped. |
| P3-3 | `2ef6eeb5` | Wake is built through `relayStartsChildReporter` from a finished run whose `ledger.files` contains the canary; the F2 grant is built through `AttemptDispatch.prepare`/`grant` with a real reservation receipt and signed job. |
| P3-4 | `7915e1dc` | Failed row writes increment `relay_journal_runs`; the reader carries `incomplete` and the gate refuses the corpus. Purges remove the marker. |
| P3-5 | `804d9399` | `sample()` assigns `this.observed` only after the fence check and summary validation, so an aborted/deposed sample cannot replace the observation used by a later J3 review row. |

Docs: `87f24466` updates the relay README.

## New tests

`packages/server/test/relay/judge-journal.test.ts` now has 23 tests (10 new):

1. A real `RelayStore` `verification_requested` claim replays as `premature_done` (P2-1).
2. A recovery attempt keeps its own steps and is not stitched into attempt 1 (P2-2).
3. `readRun` orders rows by attempt ordinal before cycle/phase (P2-2).
4. The plugin executor default journals a public-start execution (P2-4a).
5. A foreign journal migration value disables the sidecar without failing the judged relay
   (P2-3), including a completed judge request.
6. An aborted sample does not overwrite the observation used by a later J3 review row (P3-5).
7. Unobserved judge facts are stored in the row and carried as unknown replay evidence (P2-4b).
8. A failed journal write marks the run incomplete and the reader refuses gate evidence (P3-4).
9. Journal replay accepts equal `observedAt` values from a same-millisecond collector (P2-4c).
10. Native session deletion purges journal rows by session inside the delete transaction (P3-1).

`packages/server/test/relay/judge-replay.test.ts` adds two tests: equal timestamps plus
declared unknown facts parse and produce an unknown detector step, and an incomplete recorded
corpus cannot evaluate the gate (`incomplete_corpus`). The parser now rejects a false
`incomplete` value.

`packages/server/test/relay/judge-start-local.test.ts` asserts the executor default journal on
a real local public start (J2 rows at `cycle_start` and `pre_seal`), with no caller injection.

The canary test now drives the real child reporter over a finished run whose ledger files carry
the canary path and drives `AttemptDispatch` for F2; source guards still fail if those egress
producers start reading the journal.

**Regression envelope:** the focused suites below, plus the complete relay journal/cascade/
replay/host/signals/executor/schema/sealing/integration files and the native-session review
suite (125 tests).

## Gates and receipts

| Gate | Result |
| --- | --- |
| `npm run typecheck` | pass, all workspaces, no diagnostics |
| `npm run lint:md` | pass, 285 files, 756 links, 0 problems |
| `npm run check:licenses` | pass, 675 packages, 0 not allowed |
| Targeted relay/native tests | 125 pass / 0 fail (`judge-journal`, `judge-replay`, `judge-cascade`, `judge-host`, `judge-signals`, `executor`, `schema`, `sealing`, `integration`, `native-agent/review`) |
| Real local public-start judge test | 1 pass (`judge-start-local`, first test) |
| `npm run test` | not run in this sandbox; the integrator runs the full suite |
| `npm run build` | not run in this round |

The full-suite baseline recorded before the merge had 49 inherited sandbox/process failures
(`ms1/rehearsal`, `indexing/service`, `indexing/index`,
`external-agents/admission-reconcile`, `native-agent/agent`, `indexing/tools-lsp`,
`relay/operational-relay`, `native-agent/sandbox`, `indexing/process`). They are process
start-time/`ps`, Unix-socket, nested-sandbox and worker tests and reproduce on main; none
mentions the journal or cascade. This round did not re-run those heavy suites; the integrator's
full run is the authority.

## Residual risk and next work

- Journal writing is best-effort after the verdict commits. A crash (not an exception) between
  `store.finish` and the journal insert still leaves no marker; only a caught insert failure
  increments `relay_journal_runs`.
- If the lazy constructor itself cannot open SQLite, no marker can be written because no store
  exists. An empty corpus is still refused; the residual case is a corpus that somehow had rows
  before the same database became unwritable.
- `runIncomplete` orders by attempt ordinal from `run_attempts`. A run whose attempt row was
  deleted or manually inserted without an ordinal falls back to insertion order.
- The native session purge is deliberately best-effort inside the delete transaction; the
  `durable_runs` cascade remains authoritative if the journal table is unreadable.
- The public-start assertion uses the stock local fixture; remote judge starts are covered by
  the merged R3-remote lane, not re-exercised here.
- The source guards remain a selective structural check, not a proof over every future egress
  producer.
- The reader covers deterministic J0/J1 signal replay only. J2/J3 model verdicts are recorded
  but not scored; labels, calibration and the R3 precision/recall/night/ETA/B3/MS1 gates remain
  owner data.
- No live relay run, real judge model, remote judge or Fedora run was exercised. Journal,
  merge and review fixes are local; nothing was pushed.

## Shared edits

- `packages/server/src/relay/executor.ts`: optional lazy journal default, observation/unknown
  fact plumbing.
- `packages/server/src/relay/judge-cascade.ts`: optional `journal`, per-request observation
  context, completeness marking and fence-before-observation assignment.
- `packages/server/src/relay/plugin.ts`: lazy journal construction/purge and the tested
  `cascadeWithJournal` injection helper, keeping the merged judge source.
- `packages/server/src/relay/judge-journal.ts`, `judge-replay.ts`: ledger 43, unknown facts,
  attempt ordering, equal timestamps and incomplete-corpus handling.
- `packages/server/src/native-agent/sessions.ts`: best-effort session purge inside the delete
  transaction.
- No edits to `PHASE_STATUS.md` or `NEXT_AGENT_PROMPT.md`.

## Next slice

Integrator merge through the shared lock, then one local real relay with a judge to collect a
first journal, add owner labels and use the reader on a non-Mac node; only a fully recorded,
labelled corpus may evaluate the R3 gate.

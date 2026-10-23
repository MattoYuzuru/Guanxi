# R3 local judge observation journal (D-199)

**Status:** authorized bounded implementation · **Date:** 2026-10-23
**Owner:** `deepseek/r3-observation-journal` · **Base:** main `0ab58729`
**Environment:** local clone, Node 26, ports 5234/4434, `GUANXI_DATA_DIR=$PWD/.lane-data`,
generated fixtures only. No live model, network beyond loopback, SSH, secrets or owner data.

## Outcome

Record the observations the R3 judge actually saw, locally, so a real relay run can become a
`recorded` R3-b replay corpus without relaxing D-113/D-199. The journal is a sidecar in the
same node SQLite as the relay plugin. It is off when no cascade/journal is configured, on by
default when a relay executor is given a cascade, and never reaches a wire, export, wake
packet, handoff, federation message, event, or log.

Non-goals: no REST/UI reader, no remote/exported journal, no J2/J3 model replay claim, no live
run or real corpus, no calibration/night/ETA/B3/MS1 gate claim, no change to the judge verdict
rules, no new dependency or copied third-party code.

## What is recorded

One row per actually evaluated `JudgeRequest` (J1.5 checker, J2, J3), written at the existing
single cascade evaluation point. The row carries: run/session/attempt ids, cycle, phase, layer,
reason, request key, the exact scrubbed judge-visible packet (paths included), the host
`JudgeObservation` and signal policy when the executor supplied them, the J0/J1 signals, the
terminal state and result payload (J2/J3 sample verdicts or a fixed unavailable/invalid code),
and start/finish timestamps. Duplicate requests that reuse a stored result add no second row.
The table is append-only for normal operation: `UPDATE` is refused; deletion exists only in the
retention path.

## Retention and egress

- Expiry uses the same implemented reasoning rule: 7 days from creation, shortened by a parent
  Thread TTL (`DEFAULT_REASONING_RETENTION_MS` / `REASONING_RETENTION_DAYS`).
- `purgeExpired(now)` deletes due rows. `purgeRun(runId)` and `purgeSession(sessionId)` are the
  explicit session/run paths; `ON DELETE CASCADE` from `durable_runs` also removes rows when the
  owning run is deleted. `secure_delete = ON` already zeroes freed pages.
- Every stored packet/observation/result/signal is passed through the existing egress scrubber
  again at insert. A registered secret never enters the journal; paths do (D-199).
- No module reads the journal except the local replay reader and purge path. No log call is
  added, no event carries a row, and no export/wake/handoff/federation code is touched.

## Components and boundaries

- New `packages/server/src/relay/judge-journal.ts`: `JudgeJournal` interface, SQLite
  `JudgeJournalStore` (independent ledger 42), purge methods, strict replay reader that turns a
  finished run's rows into a R3-b `ReplayRun`/`ReplayCorpus` (`origin: 'recorded'`).
- `judge-cascade.ts`: optional `journal` in `RelayCascadeInput`; one post-outcome record call at
  `request()`; no SQLite import. The cascade receives an optional detached host observation,
  policy and signals from the executor and never adds them to the judge prompt.
- `executor.ts`: pass the already-collected observation/policy/signals to the cascade at the two
  existing boundaries; default a cascade to `JudgeJournalStore` unless `journal: null`. This is
  the only production wiring change.
- `judge-replay.ts` is unchanged; the reader emits its v1 shape and validates through
  `parseReplayCorpus`. No contract, route, plugin manifest or native-session edit.
- Migration 42 is additive and independent (`relay_journal_migrations`); ledgers 34–41,
  `user_version` and every existing table stay unchanged. Rollback: stop supplying a cascade or
  pass `journal: null`; the additive table remains readable by the local reader.

## Test matrix (new)

1. Off by default for a cascade without a journal; `journal: null` writes no table/rows.
2. Default executor wiring writes exactly one row per evaluated J2 boundary with packet,
   observation, policy, signals, result and timestamps; an `UPDATE` is refused.
3. Session/run/expiry purge paths; run deletion cascades; secure deletion leaves no row.
4. Reader round-trip: cascade on a fixture run → reader → `parseReplayCorpus` → `score`; the
   journal signals equal `evaluateJudgeSignals` on every replayed step and the expected
   per-class detector outcome is reproduced. Unfinished runs are refused.
5. D-199 canary: a path present only in a journal observation appears in the stored row but not
   in a rendered wake packet, relay handoff, signed F2 dispatch grant, session export or
   captured stdout/stderr/console during the run. A registered secret appears in none of those
   and not in the journal.
6. Egress scrubber is ready before any judge row; off/absent journal never changes execution.

## Validation

- Focused: `node --test packages/server/test/relay/judge-journal.test.ts` and the existing
  `judge-cascade.test.ts`, `judge-replay.test.ts`, `judge-host.test.ts`.
- `npm run typecheck`; `npm run lint:md`; `npm run check:licenses`.
- Heavy, through the shared lock exactly as the lane README requires:
  `agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm run test`
  and the same with `npm run build`.
- If the nested sandbox/agent-dev lock is unavailable, name every test not run instead of
  skipping silently.

## Commits and review

Plan; implementation; tests; relay README + handoff docs. `docs/plans/PHASE_STATUS.md` and
`NEXT_AGENT_PROMPT.md` are not edited. Another family reviews the finished diff independently;
findings are fixed in a separate commit. No push, merge, live run, or owner-data access.

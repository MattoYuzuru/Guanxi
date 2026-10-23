# R3-remote — a judge for relays whose inference runs on another node: plan

**Status:** accepted slice plan (lane author) · **Date:** 2026-10-23 · Base `0ab58729`, branch
`claude/remote-relay-judge`, ports 5232/4432, Node 26, Mac only. No SSH, live model, paid call, owner data,
`~/.guanxi` or secret. Closes the MS1 blocker recorded in `MS1-rehearsal.handoff.md` ("The R3 judge gap").

## Outcome and non-goals

A relay started through the public `RelayStarts`, local or remote, can carry the R3 judge: the J0/J1 signals layer
(needs no model) and the J2/J3 cascade. On a remote or llama-server meter the judge **model** runs on the same
runtime that counts. Non-goals: a production boot wiring (lane `ms1-live-host`), reaping stale pins, the journal
hook (lane `r3-observation-journal`), real calibration, a checker supervisor, B3/MS1 claims, any wire contract change.

## Design

1. **Host option, not wire input.** `RelayStartHost.judge?: RelayStartJudgeSource` (new `relay/judge-start.ts`) is a
   T0 factory called once per start with the start's input, policy, the guarded meter and the admitted runtime facts.
   It returns `{ signals?, cascade? }` (the existing `RelayJudgeInput` / `RelayCascadeInput`). The judge brief binds
   the plan and caps, so it is per start; nothing of it can arrive over HTTP. `RelayConfig.judge` is the plugin-level
   default used when the start host has none.
2. **Fail closed before anything exists.** The factory runs in `prepare()` after `runtime.validate()` and before the
   signed pin, the checkout-bound run or any remote write. The signals policy, the brief (`copyBrief` against the
   start's plan, caps hash equal to the start's caps) and the model shape are validated there, and the executor is
   constructed there too (it opens the additive judge ledger 38). Any failure refuses the start with
   `judge_config_invalid` (now a public start code): no run, no pin, no checkout. A host that returns nothing opts
   that start out.
3. **Signals for every relay.** The collector is host supplied (T0). `ledgerJudgeInput(policy, clock)` is a default that
   reports only what the ledger really holds (cycle, no-progress streak, wall deadline, token budget unknown) and leaves
   heartbeat, lease, disk unknown; streaks the ledger does not track are zero and documented as such.
4. **Judge model on a transport meter.** `ConnectionJudgeModel` takes an optional `runtime` binding
   `{ connectionId, model }`. A meter with a `transport` is accepted only with that binding; a meter with `countAsync`
   but no transport (counted by A, dispatched on B), a transport without a binding, an inexact meter, or a role whose
   connection or normalised model differs from the binding is `judge_config_invalid` (construction or admission).
   The dispatch goes through `meter.transport` itself and uses the meter's own counter, so count and dispatch cannot
   diverge: the prompt is pre-counted with `countAsync` when present, `onPrepared` re-checks request shape (`think:false`,
   model, exact options) and the lookup count, `meter.authorizeDispatch` re-observes the runtime, and the result must
   echo the counted input tokens. `meter.validatePrepared` is not used: it pins `num_predict` to the relay turn, and the
   judge has its own output ceiling.
5. **Billing, as F2-c.** A remote judge sample is one more per-call child run on the same session, so the executor-
   reported tokens land on that child's R1 ledger atomically with its terminal. The relay run's own `run_costs` are
   untouched by judge calls; the relay ledger holds only the cascade's existing pre-debit (`tokenReserve` per sample,
   counted against the relay caps, never settled to actuals). Nothing is summed across the two views.
6. **Degradation.** Unchanged cascade rules: a model that is unavailable, invalid or inconsistent gives an
   `unavailable`/`invalid` verdict row, never an item done, never a stopped run. A collector failure keeps its existing
   fail-closed rule (fixed code, run `input_required`); the built-in collector cannot fail.

## Affected files

`relay/judge-start.ts` (new), `relay/start.ts` (option, `judge_config_invalid` code, meter built earlier, executor
built before the run exists), `relay/plugin.ts` (default), `relay/judge-model.ts` (transport), `relay/README.md`.
Tests: `test/relay/judge-start.test.ts` (new), `judge-model.test.ts`, `test/ms1/*` (the judge on, the tripwire flipped).

## Test matrix

Option reaches the executor through the public start (local stock and remote); refusal before pin/run/checkout for a
bad brief, bad policy, throwing factory, inconsistent meter; remote meter accepted when bound, refused when countAsync
without transport, no binding, other connection or model; judge calls dispatched on the meter's transport with
`think:false`, counted by the executor, one child ledger row each, relay `run_costs` unchanged, relay ledger grown by
the reserve only; local relay unchanged; model failure degrades without touching the run; signals on a relay without a
cascade; replay of the same start does not double-dispatch. MS1 rehearsal: judge on, signal and verdict events on the
remote relay, kill case with the judge on.

## Gates

`typecheck`, `lint:md`, `check:licenses`, targeted `node --test`, then `agent-dev ... npm run test` and `npm run build`
through the shared lock. Mutation checks recorded in the hand-off. Independent read-only review of the diff.

## Risks

Merge overlap with `ms1-live-host` (`start.ts` runtime injection) and `stale-pin-reaping` / the journal hook (rehearsal
tripwire and cascade evaluation point): edits are narrow and additive. The remote judge adds many signed round trips
per cycle (two phases times two or three samples); this is real cost on the executor, set by the brief.

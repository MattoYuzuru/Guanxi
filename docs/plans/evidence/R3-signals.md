# R3 signals handoff — trusted judge observation wiring

**Status:** implemented; targeted local validation complete; root independent review and
integration gates pending.
**Date:** 2026-10-22 · **Branch:** `codex/r3-watchdog` · **Base:** `5919d0b`.
**Production:** `7556d43`; **self-review fix:** `1d7eb37`.
**Checkout:** `/Users/yuzuru/Projects/Guanxi-lanes/coord-r3-watchdog`.
**Predecessor:** [`R3-eta.md`](R3-eta.md) records the reviewed ETA slice at `bf6a222`;
this follow-up leaves its historical claims and `relay/eta.ts` untouched.

## Scope and plan

Close the unused `judge-signals.ts` gap by wiring the already-reviewed deterministic J0/J1 pure
module into actual relay execution as an optional trusted host observation. The host supplies an
explicit policy and a collector; the executor samples at two synchronous cycle boundaries,
evaluates with the pure module, and publishes one bounded K2 note. This is wiring only: no J2/J3,
verdict, action, routing, wake or threshold default, and no claim that R3's replay, calibration,
night-wake or six-hour gates passed.

The implementation was test-first: the current executor ignored an eighth constructor argument
(probe: zero collector calls, zero judge notes, normal finish), and the new test file failed on
the missing module before production code changed. Production, tests and the README are the
`feat` commit; `1d7eb37` is a small self-review fix; this handoff is a separate documentation
commit.

## Contract and boundaries

- New internal `relay/judge-host.ts` defines `RelayJudgeInput` with `policy: JudgeSignalPolicy`
  and `collect({ attempt: { id, runId, epoch, token }, ledger: Readonly<Ledger>, signal })`.
  This is T0 host data like `RuntimeMeter`/`RelayWorkspace`; it is never parsed from model JSON
  or HTTP and is not added to the public package export or wire contract.
- `RelayInput.judgeSignals` is optional and is passed as the constructor argument after the
  existing optional `eta`. Absence is a no-op with the prior behavior.
- Admission copies and freezes the flat policy, rejects invalid policy fields or a non-function
  collector with the fixed `judge_config_invalid` code, and never invokes the collector during
  validation. No policy defaults are introduced.
- `cycle_start` samples immediately after `store.begin` and the ETA update, before orient or any
  model call. `pre_seal` samples after the serial final gate/count-progress work and the ETA
  update, before the fresh narrative and handoff construction.
- The collector receives a `structuredClone` ledger, a detached attempt identity and the actual
  run `AbortSignal`. It cannot mutate the authoritative ledger or the frozen policy. The note
  uses the captured ledger cycle, not a mutable copy field.
- Before the await, the executor uses R1's existing fenced extension transaction as the
  execution-fence check and calls `signal.throwIfAborted()`. After the await it checks the
  signal again, then evaluates with `evaluateJudgeSignals`; only after success does it publish
  exactly one `agent.note` through `store.emit` (the same R1-fenced transaction).
- The note text is canonical `{relay:'judge_signals', phase, cycle, signals, unknownFacts}`.
  `unknownFacts` is exactly `heartbeat`, `lease`, `deadline`, `disk`, `tokenBudget` for each
  null observation field, so an empty signal list is not a health claim. No observation object,
  private path or collector exception text is persisted or logged.
- A collector rejection or invalid observation fails the cycle closed with
  `judge_observation_unavailable` or `judge_observation_invalid`; no judge note or follow-up
  model call is made. Cancellation and stale/revoked fences rethrow the existing abort/`RunError`
  semantics instead of becoming observer errors. Signals never change control flow.

R1 currently exposes no separate read-only `checkExecution` method; the existing fenced
`RunStore.mutate` transaction is the check. That adaptation is localized in the executor. No R1
source, ETA, types, store, runs, federation, K3, UI or existing judge-signals file was changed.

## Assertions — new / regression envelope

**8 new / 23 existing, 31 pass, zero skips.** The new file exercises the real `RelayExecutor` and
the existing temp-DB fixture; it constructs the executor directly from `f.relay`, `f.model`,
`f.workspace`, fixture `reserves`, `f.scrubber`, default limits, `undefined` ETA and the judge
input. No live model, K3 network, sandbox, workspace cleanup, paid route or SSH is used.

| Command | Result |
| --- | --- |
| `nice -n 10 node --test packages/server/test/relay/judge-signals.test.ts packages/server/test/relay/judge-host.test.ts packages/server/test/relay/eta.test.ts packages/server/test/relay/integration.test.ts` | 31 pass, 0 fail, 0 canceled, 0 skipped, 0 todo; 8 new / 23 existing |
| `nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json` | Passed, exit 0, no diagnostics |

The eight new cases assert:

1. absent configuration finishes normally with zero judge events;
2. real `cycle_start`/`pre_seal` states, prompt counts (0 and 2), frozen unknown metadata,
   one note per phase, and no canary path in events, ledger or seals;
3. admission freezes/detaches policy, rejects invalid policy and non-function collectors with a
   fixed code, does not call the collector at admission, and resists later policy/ledger mutation;
4. cancellation across a pending collector yields zero judge events and zero model calls;
5. a fence lost during collection yields zero stale judge events and zero model calls;
6. a pre-seal collector rejection yields one fixed error, one prior valid cycle-start note, no
   narrative model call and no seal;
7. an invalid observation yields one fixed error with no exception/path payload;
8. three cycles produce six notes (one per phase per cycle), three sealed snapshots whose
   `ledgerHash` still equals `hash(snapshot)`, and two correct orient probes.

Pre-change evidence: the inline probe constructed the old executor with an eighth argument and
printed `{"collectorCalls":0,"judgeNotes":0,"state":"finish","prompts":3}`; the new test file
then failed with `ERR_MODULE_NOT_FOUND` for `relay/judge-host.ts` before implementation.

## Shared edits and residuals

Modified files are only owned paths: `relay/executor.ts`, `relay/plugin.ts`, `relay/README.md`,
new `relay/judge-host.ts`, new `test/relay/judge-host.test.ts`, and this handoff. No status file,
ETA file, store, type, run, federation, K3, UI or existing judge-signals source/test was edited.

Residuals:

- Fixture observations are synthetic. This is not a real host observation, a calibrated
  classifier, or evidence for R3 replay precision/recall, P80 coverage, night wake rates or the
  six-hour MS1 envelope.
- A collector that ignores the abort signal and never settles can hold a cycle open. This slice
  deliberately adds no timer; the host owns that failure boundary.
- `unknownFacts` covers the five nullable observation fields used here. Other observation
  fields are not reported as unknown; consumers must not infer health from an empty signal list.
- `judge_config_invalid` is a new admission-only error code, not a wire contract. Runtime
  failures use only the two fixed observation codes.
- J2/J3 execution, verdicts, signal-driven actions, routing, wake policy and delegation remain
  future R3 work. This follow-up only closes the unused pure-module gap.
- Root GPT independent review and global/integration gates are still pending.

## Review fixes

Self-review before hand-off: the collector attempt identity is deliberately mutable because it
is a detached snapshot; the task contract declares only the ledger as `Readonly`. `1d7eb37`
removes the extra freeze and has the fixture mutate its attempt copy, proving the authoritative
attempt is not used for publication. The targeted suite remains 31/31 and `tsc` remains clean.

Root independent review is pending. No root review-fix commit has been made yet. Append findings,
their separate fix commits and the re-run command results here; do not rewrite the historical
sections above.

### Independent review P2 fix — collector stop/wall liveness (`e01998d`)

The independent review found that `judgeSample` awaited the trusted collector directly. Aborting
the existing run signal did not release that await when the collector was slow or never settled,
so explicit stop, the existing wall cap and plugin disposal could remain blocked in
working/orient with renewal installed. The previous cancellation test released the collector
before awaiting `run` and therefore did not prove liveness.

`RelayExecutor.collectJudge` now races the collector against the existing composite run signal
(controller, wall and optional external). There is no new timeout, policy default, routing,
background writer or cancellation authority. The abort listener is removed when either side
settles, including a synchronous collector throw; both late resolution and late rejection stay
observed and are discarded after the race, so they cannot publish a note or resume work.
`judgeSample` keeps `signal.throwIfAborted()` and now rechecks the existing R1 execution fence
after the host await and before evaluation/publication; publication still uses the same fenced
`store.emit`. Explicit stop still ends at `input_required`, and the wall cap still ends at
`wrapping_up`. Plugin disposal uses the same `stop()` path and now settles with it.

Test-first evidence: the two new tests were added before production changed. With
`packages/server/src/relay/executor.ts` temporarily restored to clean `a8d5997`, both failed at
the 1000 ms test-only guard with `explicit stop did not settle while the collector was pending`
and `wall cap did not settle while the collector was pending`, while the collector was still
unreleased. Both pass at `e01998d`; the file was restored before committing.

The two new tests use the real `RelayExecutor` and existing temp-DB fixture, with no model,
network, sandbox or workspace cleanup:

- explicit stop waits for run completion before releasing the pending collector, asserts
  `input_required`, zero judge notes/events and zero prompts, then proves a late resolution leaves
  the ledger, run state and event count unchanged;
- wall cap advances the authoritative fixture clock while the collector is pending, waits for run
  completion before rejecting it, asserts `wrapping_up`, zero judge notes/events and zero prompts,
  then proves the late rejection produces no `unhandledRejection` and leaves the ledger, run
  state and event count unchanged.

| Command (at `e01998d`) | Result |
| --- | --- |
| `nice -n 10 node --test packages/server/test/relay/judge-signals.test.ts packages/server/test/relay/judge-host.test.ts packages/server/test/relay/eta.test.ts packages/server/test/relay/integration.test.ts` | **2 new / 31 regression envelope**, 33 pass, zero skips, zero failures |
| `nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json` | Passed, exit 0, no diagnostics |

Residual: the race releases the executor, renewal and plugin disposal, but it cannot cancel a
collector that ignores the signal; that collector's read-only underlying work may continue until
the host cooperatively cleans it up. Late outcomes are consumed but not awaited. Only
`relay/executor.ts`, `test/relay/judge-host.test.ts` and this handoff changed; `relay/judge-host.ts`
needed no helper change. No full suite, browser, build, nested sandbox, actual model or `agent-dev`
run was performed.

The targeted rerun was executed after this documentation edit and the resulting tree was clean
before handoff; the fix commit remains `e01998d`.

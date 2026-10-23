# R3-remote — a judge for relays whose inference runs on another node: hand-off

**Status:** implemented and independently reviewed candidate; fixture-validated only (in-process nodes, fake
llama-server, the MS1 rehearsal's real home process). **Date:** 2026-10-23 · **Branch:**
`claude/remote-relay-judge`, lane clone `/Users/yuzuru/Projects/Guanxi-lanes/rjudge`, base `0ab58729`. Ports
5232/4432, Node 26, Mac only. No SSH, live model, paid call, owner data, `~/.guanxi` or secret. No migration
(the judge ledger 38 is the existing additive one), no dependency, no wire-contract change, no third-party code.
`PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` are untouched. The plan is [R3-remote.plan.md](R3-remote.plan.md).

## What was built

- **The seam.** `RelayStartHost.judge` (new `relay/judge-start.ts`) is a T0 source function called once per public
  start with that start's input, policy, the guarded meter and the admitted runtime facts; it returns
  `{ signals?, cascade? }`. `RelayConfig.judge` is the plugin default (`startHostWithJudge`). `RelayStarts` builds
  its `RelayExecutor` with `judgeSignals` and `cascade`. The source runs after the runtime is admitted and before the
  signed pin, the run and the session; any inadmissible judge (throwing or asynchronous source, bad signals policy,
  brief for another plan or other caps, model without `admit`/`sample`, a judge role that is not the relay's own
  connection and model on a transport runtime, an inconsistent meter) refuses the start with `judge_config_invalid`
  and leaves no run, session or pin.
- **The signals layer for every relay.** `ledgerJudgeInput(policy, clock)`: a collector that reports only what the
  ledger holds and declares the rest unobserved (`RelayJudgeInput.unobserved`, published as `unknownFacts` and shown
  to the judge). Needs no model; works on local and remote relays.
- **The judge model on a transport meter: implemented, not refused.** `ConnectionJudgeModel` takes a `runtime`
  binding. A meter with a `transport` (llama-server, F2-d remote) is accepted only with it; the judge then counts with
  the meter's own counter (`countAsync` pre-count, then the lookup) and dispatches through `meter.transport` itself,
  with `think:false`, `authorizeDispatch` re-observation and a pinned `onPrepared`, so count and dispatch cannot
  diverge. Inconsistent meters (`countAsync` without a transport, a transport without a binding, inexact), and any
  role that is not exactly the bound connection and model, stay `judge_config_invalid`.
- **Billing as F2-c.** A remote judge sample is another per-call child run: the executor-reported tokens are one
  `remote-dispatch:` row on that child, atomically with its terminal. The relay run's `run_costs` never include the
  judge; the relay caps see the cascade's existing pre-debit only (13000 tokens per sample in the fixtures). Nothing
  is summed across the views.
- **Rehearsal.** The MS1 rehearsal's home runs with the judge on: signals at both boundaries of the six cycles, 24
  J2 samples evaluated by the executor, 12 completed verdict rows, 24 child ledger rows apart from the relay's own.
  The two judge tripwires are replaced by assertions; the 15 original kill points keep their call-by-call arithmetic with the judge off, and
  three judged kill points are added.

## What each test proves

`test/relay/judge-start.test.ts` (26, remote relay through the public start): the option reaches the executor
(signals at both boundaries; 4 judge calls in the one cycle, each a rendering the executor counted and was granted,
output limit the judge's own); the cost view (one child row per call equal to the counted tokens, relay rows only its
own, relay ledger = own tokens + samples x reserve, `sessionCosts` keeps children apart); signals alone (no model
call, no judge ledger); no source (no event, no call, no ledger); concurrent and later replay dispatch nothing twice;
the plugin default reaches the start and a host's own source wins; 13 refusal rows, each leaving no run, session,
pin, completion, checkout or judge ledger and leaking no source text; a judge answering in prose is `invalid` and the
run completes on its own gate; an input over the judge ceiling is `unavailable` before any judge call; an executor
evaluating another count gives no verdict; stop during a judge call waits for the executor's ACK and leaves the request
`dispatched`, never a verdict; a failing collector keeps its fixed fail-closed rule; the default collector's facts.
`judge-start-local.test.ts` (4, stock Ollama): the relay's own requests are byte for byte those of a relay without a
judge, judge requests carry no transport-only field, R1 rows are unchanged, `ledger.tokens` grew by exactly the
reserves, K3 recorded the judge's usage; signals alone; prose verdict; refusal. `judge-model.test.ts` (+9): binding
rules for transport, stock and inconsistent meters; role refusal before attestation; on real K3, the judge goes
through the meter's transport (local and remote shape) with count, authorization, dispatch in that order and never
Ollama; other evaluated tokens give no result; an over-ceiling count dispatches nothing; a scrubber that rewrites the
request is stopped by the pin. `test/ms1/rehearsal.test.ts` (23, +3): see above, including that a judged crash never
replays a call and invents no verdict.

## Mutation checks (applied, named test run, source restored)

All caught: executor built without the judge (8 tests); without `signals` (3); judge dispatch without the transport
(4); judge admitted after the signed pin (the 13 refusal rows); role binding unchecked / relaxed (2 and 3); no async
pre-count (3); `countAsync` without transport allowed (1); no `think:false` (3); no `authorizeDispatch` (2); the
`onPrepared` pin removed (1); `judge_config_invalid` not a public code (every refusal row); plugin default dropped (1);
unobserved facts not published (1); start-time role check removed (2); thenable source allowed (1); collector
deadline wrong (1); in the rehearsal, the judge not wired into the home, and signals without the cascade (the happy
path fails both).

## Independent verification

`sde-agent:implementation-reviewer` (read-only) reviewed `0ab58729..` the first six commits. No P1. Five P2, all fixed
in `8714f44f` (production) and `fb971c57` (tests): a flaky "unchanged" local test (the commit date entered the prompt:
dates pinned); an asynchronous or empty source silently opted out (a promise is now refused); a role not served by the
relay's runtime degraded at every boundary instead of refusing the start (now refused at start); the default collector
reported unobserved facts as zero (now declared unobserved and published as unknown, three small edits in
`judge-host.ts`, `executor.ts` and the `summarySchema` enum of `judge-cascade.ts`); claims without a failing assertion
(request pin, plugin default, concurrent replay, stock-meter binding, lost-call state: tests added and mutation-checked).
P3 taken: the exact model string is the binding (another spelling is refused), README now states the executor-side
effects (pre-debit reaches `caps.tokens` earlier, `temperature` is not sent to llama-server, `maxAgeMs` must exceed a
sample's wall time, the judge ledger tables may remain after a later refusal, local llama-server judge has no child
row). Docs: a superseded note in `MS1-rehearsal.handoff.md` and `F2-d.handoff.md`.

## Gates (Mac, Node 26.9.0, shared lock resource `heavy`)

Clean tree at `9fb99f05` (the only later change is this gate table).

| Gate | Result |
| --- | --- |
| `npm run typecheck` (all workspaces) | pass |
| ESLint on every changed `.ts` | pass, no output |
| `npm run lint:md` | pass, 276 files, 746 links |
| `npm run check:licenses` | pass, 675 packages, 0 not allowed |
| `agent-dev … npm run test`, receipt `check-f4787n_g` | exit 0: core 2740 tests, 2738 pass, 0 fail, 2 skipped (the two pre-existing Linux-only opt-ins); kernel, web, ui, ui-gates, bench and codemod suites 0 fail; `source_changed` false |
| `agent-dev … npm run build`, receipt `check-1tmxdfn_` | exit 0 |
| `node --test test/ms1/rehearsal.test.ts`, before the review fixes and again with the relay suites after them | 23/23 (about 3.6 minutes); relay directory plus rehearsal 312 tests, 311 pass (the one failure is `sealing.test.ts` run from `packages/server`, see residual 7; it passes from the repository root) |

An earlier full run (receipt `check-charojky`, head `fb971c57`) failed once: `trusted-start.test.ts` "public start runs the
real K3 plus K4 tool/clean-gate path", the 5 s `until` in its container-gate wait, while two other lanes held the machine (7.5 s
for a test that takes 1.7 to 4.5 s in other full runs). It passed alone (three reruns) and the wait was made a 30 s ceiling in
`554b71f2`; the green run above is after that fix.

**New: 42** = `judge-start.test.ts` 26, `judge-start-local.test.ts` 4, `judge-model.test.ts` 9 (5 to 14), `rehearsal.test.ts` 3
judged kill points (the judge-blocker test was replaced one for one, so the file is 20 to 23). **Regression envelope:** the other
2698 core cases and the non-core suites; the whole relay test directory and the rehearsal were also run directly.

## Residual risk (named, not closed)

1. **No production judge source exists.** The seam is wired and tested, but the live host (lane `ms1-live-host`) must
   provide `RelayStartHost.judge` / `RelayConfig.judge`. The brief the cascade needs (`RelayDelegationBrief`:
   account, wake policy, estimates, roles, caps) is built by the test helper `startBrief`; mapping the lead's
   delegation to it is not done. `relayJudgeModel` and `relayRuntimeAttestor` are the intended building blocks.
2. **Attestation of a remote judge** is the relay runtime's own fresh observation (`placement: 'installed-local'`
   on the executor), not an independent inventory; it only attests the relay's own connection and model.
3. **Cost on the executor.** The judge is real inference: in the rehearsal 24 of 74 calls, a signed offer, count,
   dispatch and terminal each. Two samples at two boundaries per cycle is the default; the brief sets it.
4. **A lost run keeps its judge request `dispatched`** until a judge ledger is next opened (a later judged start
   abandons it). No judge call is ever replayed, no verdict invented (asserted at the judged kill points).
5. **The default collector** can raise only `no_progress` and `deadline`. Heartbeat, lease, disk, failure and edit
   streaks, dead ends and path edits need a host collector; a collector that fails keeps the existing fail-closed rule
   (`input_required`), not a degrade.
6. **Not exercised:** J3 and J1.5 on a remote relay (same `model()` path, J3 disabled in the fixtures), the 15 original
   kill points with the judge on (their arithmetic is call-by-call), a real llama-server judge, real latencies,
   `maxAgeMs` against a slow sample, `temperature` (not sent to llama-server, so "agreement" is server sampling).
7. **Pre-existing, observed:** `sealing.test.ts` resolves its child script from the repository root and fails when run
   from `packages/server`; the full run passes it. The first full run failed once on a 5 s wait in
   `trusted-start.test.ts` (container gate, machine shared with other lanes); the wait is now a 30 s ceiling.
8. **Merge overlap.** `start.ts` (meter and executor are built before the pin, `entry.executor` assigned where it was),
   `rehearsal.test.ts` / `home-process.ts` / `world.ts` / `llama-script.ts` with `claude/ms1-live-host` and
   `claude/stale-pin-reaping`; only judge parts were touched. The cascade evaluation point is untouched.

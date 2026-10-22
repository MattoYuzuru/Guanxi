# R3-a handoff — optional ETA projection

**Status:** implemented, targeted locally validated and independently reviewed; integration
gates remain with the root integrator.
**Date:** 2026-10-22 · **Branch:** `codex/ms1-r3` · **Base:** `1067a04`.
**Production:** `e4d92ee` · **Additional assertions:** `34f18a8`.
**Checkout:** `/Users/yuzuru/Projects/Guanxi-lanes/ms1-r3`.

## Scope and plan

Autonomous bounded implementation under the owner's current MS1 mandate. Use the existing
relay ledger's empty ETA seam to expose a reproducible, source-labelled empirical forecast
without implying that R3 or MS1 gates passed. The trusted execution host owns all estimates,
historical observations, runtime-counter observations and cohort identity. No live model,
SSH, paid launch, owner data or security-testing envelope was used.

The new internal `RelayInput.eta` configuration is optional and copied at admission. It scopes
history by model × host × repository; drops stale, future and infrastructure-tainted samples;
bootstraps estimate/actual ratios for unfinished serial plan items; and publishes P50/P80,
timestamps, low confidence and unvalidated calibration. Missing history/estimates are unknown.
Runtime throughput contradictions are reported without rewriting the forecast. The same R1
fence and scrubber protect persistence; sampling happens at synchronous cycle/pre-seal
boundaries so it cannot race handoff construction. Older null-valued ledgers remain valid.

No new database schema, dependency, wire API or copied third-party code. Rollback removes the
optional projection producer; pre-existing consumers accept JSON snapshots and the old null
default remains. ETA snapshots already written are ordinary retained ledger evidence.

## MS1 dependency contract and remaining gates

R3 depends on R2, whose current implementation is an internal single-node service with fixture
meters. There is still no universal live K3 meter or user entry flow. The next bounded R3
contract should connect existing `judge_requested` events to a durable J0/J1/J1.5/J2/J3
observation/verdict flow, enforce `judge_unavailable` after three cycles and delegation brief
caps, and route lead wakes through R1. Its replay corpus must directly assert recall ≥0.9
and precision ≥0.8 for injected loops, protected-path edits and premature completion.
Night policy must retain D-159's immediate failure/input-required wake, 08:00 completion
batch and at most three strong reviews, unless overridden by explicit run policy.

F2 can proceed independently from F1: a versioned owned-node offer/accept envelope bound to
target governor admission, `run:<id>/exec` fencing, durable granter time and clock grace,
holder self-fencing, namespaced attempt results and one terminal result. Simulation must
assert at most one active token, strictly increasing tokens, no stale accepted mutations and
governor admission before execution. Cross-node artifact transport and restored-home epoch
reconciliation are still required before claiming remote completion. No paid adapter is
needed; D-188 puts owned nodes first.

This ETA slice does not close R3's ≥20-run P80 coverage gate (0.7–0.9), replay precision/recall
or night-wake gate. B1 real corpus/executor/billing and B3 32k multi-cycle quality remain
separate dependencies. K5's real lead suspension, F2's other-node local inference, a ≥6-hour
run, unchanged lead token ledger, green clean-checkout plan gates and exactly one wake must
be observed together for MS1. Fixture statistics are never that integration evidence.

## Assertions — new / regression envelope

Eleven new tests in `relay/eta.test.ts` directly check empirical quantiles and timestamps,
sampling reproducibility under history reordering, cohort/freshness/taint exclusion, unknown
cold state, dependency-aware burn-down, runtime-counter contradictions, duplicate/invalid
input and overflow rejection, stale-fence zero mutations/events, persisted reconstruction,
copied input, multi-cycle sealed ledger/hash/probe consistency and provenance scrubbing.
The existing real-K3 fixture integration
test additionally asserts mismatch refusal before dispatch and final zero ETA through
`RelayService.execute`.

`npm ci` completed first under Node 26.9.0; contract resolution points to
`/Users/yuzuru/Projects/Guanxi-lanes/ms1-r3/packages/contract/src/index.ts`. All commands use
ports 5201/4401 and this checkout's `.lane-data`. The runtime target is this Mac only.

| Command | New / regression envelope and result |
| --- | --- |
| `node --test packages/server/test/relay/eta.test.ts packages/server/test/relay/integration.test.ts` | **11 new / 2 existing**, 13 pass, zero skips, at `34f18a8`; log `/Users/yuzuru/.local/state/agent-dev/r3-20261021/eta-integration.log` |
| `node --test 'packages/server/test/relay/*.test.ts'` | 9 new / 61 existing, 70 pass, zero skips, before the final two assertion-only tests and stable lexicographic observation ordering change |
| `npx tsc --noEmit -p packages/server` | Passed after the final tests; `r3-20261021/typecheck.log` |
| `npm run lint:md` | Passed: zero Markdown/link errors; `r3-20261021/markdown.log` |

These direct checks have no reusable source attestation: the inherited
`.claude/skills/guanxi-ui` symlink makes the agent-dev source fingerprint unverifiable.
No heavy gate was run by this lane. Heavy integration gates, status documents and main
merges belong to the root integrator.

Independent B1-lane GPT read-only review covered `1067a04..34f18a8`: **no blocking findings**.
Its separate ETA/integration command passed 13/13, zero skips, with unchanged source under
the shared heavy lock; receipt `/Users/yuzuru/.local/state/agent-dev/check-qleyaads/result.json`.
The reviewer requested a nonblocking wording clarification: observed runtime throughput is a
constant-throughput baseline, not a proven maximum speed. The service README now states that
assumption explicitly in a separate documentation commit. A reciprocal read-only B1 review
found and reproduced a lock-wait quote-expiry race; the B1 author owns its separate fix.

## Shared edits and residuals

Minimal existing R2 seams: `relay/types.ts` (typed non-null projection), `store.ts` (fenced
projection mutation), `plugin.ts` (optional input and model binding), `executor.ts` (safe
sampling boundaries), fixture plumbing and the existing K3 integration test. Service README
and ADR-0020's implementation boundary are reconciled in this slice. No B1/U1/F1 source or
status file was edited.

The forecast assumes serial items and independent historical ratios; model/host/repository
identity and remaining estimates are host assertions. Automatic measurement collection,
calibration, UI, night scheduling, judges, delegation, remote orchestration and a real
six-hour run are unfinished. Observations can become stale while a long cycle is running;
the projection's timestamp remains visible. Current opt-in metadata can appear in
`work.query`; fixture checks do not establish benchmark non-inferiority.

# R3 opt-in cascade foundation

**Status:** authorized bounded implementation · **Date:** 2026-10-22
**Owner:** `codex/r3-cascade` · **Base:** reviewed `cd00a82`, merged reviewed main `6da2058`
**Environment:** local Mac, Node26, ports 5211/4411, `.lane-data`; generated fixtures only.

## Behavior and boundaries

Feature absence preserves existing relay behavior and initializes no new ledger. An optional
ninth executor argument after `judgeSignals` supplies a T0-owned cascade. Before the first cycle,
validate and persist an immutable delegation brief bound to the actual plan/run/attempt. The
brief carries constraints, model roles/selection, caps, checker, judge and requested wake policy;
it grants no filesystem/network/model authority. Trusted host adapters enforce those effects.

At actual cycle-start and pre-seal boundaries, persist distinct fenced J1.5/J2 requests and
outcomes. Probe/no-progress/final requests may admit J3 according to explicit policy. Snapshot
judge-visible evidence before awaits; return strict taxonomy/verdict/evidence references and
non-authoritative diagnosis only. A judge never marks an item done or overrides acceptance.
Every external await has pre/post R1 fence checks. Pure observations/admission may race abort
with late outcomes consumed. Resourceful checker/LLM calls receive abort but remain owned and
await actual adapter settlement before the executor returns/releases ownership: timeout alone
is not cleanup. Real K3 public localChat is used through a separate explicit-account adapter;
existing relay/model.ts and Connections remain owned by R2.

New independent R3 ledger **38**, same database as R1/K2, stores brief hashes, idempotent request
keys/results, once-per-cycle availability and account/night J3 reservations. Main user_version,
K4 33 and F2 37 stay unchanged. Duplicate keys share results; payload changes conflict. Crash
reconciliation abandons prepared/dispatched requests without replay/refund. J3 reserves worst-
case calls/tokens/money before dispatch, default maximum three across an account/local night;
explicit override remains recorded. No automatic retry after unknown/failed inference.

J2 has exactly two or three fresh tool-free samples. Missing/invalid host/model facts yield
unavailable, not success. Once-per-cycle unavailable streak increments once; the third cycle
requests one fenced escalation. Valid J2 resets it. Existing hard failures/probe/no-progress
signals remain binding. Select session then project then explicit policy candidates; local-only,
consent and exact installation facts are hard filters. Automatic selection requires host-owned
fresh calibrated history, never fixture-derived p_success. Wake policy only records a requested
wake decision; no RunStore scheduling changes or claim of actual deferred 08:00 delivery.

## Implementation and checks

Own new `relay/delegation-brief.ts`, `judge-store.ts`, `judge-cascade.ts`, `judge-model.ts` and
focused tests. Minimal shared seams: executor ninth optional argument and synchronous safe-boundary
calls; optional type/input forwarding in plugin coordinated with R2. No new kernel plugin/API/UI.
Reuse repository canonical hashing, scrubber, R1 mutate/home fence and K3 services; no copied
third-party code or dependencies.

Tests cover brief/hash replay conflict and exact plan binding, role precedence/unknown calibration,
independent38 compatibility, crash abandonment, duplicate debit, cross-run/night J3 limits,
checker pin mismatch, strict evidence refs/schema, fresh samples/disagreement, no judgment passing
failed gates, three distinct unavailable cycles/reset, stale/cancel/wall/fence late outcomes,
resource settlement acknowledgment and actual executor seal/hash consistency. K3 uses fake local
transports and explicit non-local account fixtures; zero cloud/provider/live calls. Focused pure
fixtures may run directly; filesystem/process regression through shared agent-dev heavy. Root owns
broader gates and separate GPT review; author fixes in separate commits before handoff.

Rollback disables opt-in configuration and retains additive records; no down migration or automatic
checker/inference replay. Real calibration/night behavior/B3/toolful F2 bridge/MS1 remain unearned.
No default routing/prompt policy activation before the real ADR0025 bench gate. No SSH, other hosts,
paid calls, installed live models, owner data, main/status edits or pushes.

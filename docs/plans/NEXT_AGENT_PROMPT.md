# Next agent prompt — compose MS1 locally, then the owner-present runs; MS2 UI in parallel

**Status:** active continuation · **Updated:** 2026-10-23

Read [AGENTS](../../AGENTS.md), [WORKFLOW](WORKFLOW.md), [lanes/README](lanes/README.md),
[PHASE_STATUS](PHASE_STATUS.md) and the [2026-10-23 record](evidence/coordination-2026-10-23.md).
Inspect live workers, branch/HEAD/dirty state and the latest hand-offs before reopening work; do
not repeat closed author/reviewer rounds. Each slice: own clone, plan first, separate commits,
independent review (a different model family or a separate Opus reviewer), fixes as separate
commits, then integration with the full gate sequence through the shared heavy lock.

## Scope and boundaries now

- The owner reported `ssh fedora` **unavailable** for tests on 2026-10-22; work stays on this Mac
  until the owner restores it. D-195's Fedora rules apply again once it is back.
- No live model, paid call, owner workspace or vendor account in ordinary tests. D-194 still
  excludes real benchmarks on this Mac. A first smoke run against a real llama-server or a real
  Claude Code lead needs an explicit owner-approved integration envelope.
- Local `main` is pushed to GitHub after each integration checkpoint (owner, 2026-10-22).

## Where things stand

Overnight (2026-10-22/23) 29 reviewed lanes were integrated, including the MS1 local rehearsal; see the record for the list and the
per-lane hand-offs. For MS1 the code path now has: K4 queue Q0; R2-op (opt-in llama-server runtime
with exact counting and owned checkouts); F2-c (remote token costs in the R1 ledger); F2-d (relay
inference on another node over signed, fenced F2 messages with an executor-side exact counter and a
signed pin before each run); LW (external lead `guanxi_delegate`, zero-token hibernation, exactly
one crash-safe wake, owner ceilings on delegated caps, K5 boot reconciliation of stale admission
holders); R3-b/R3-c replay and ETA scorers; B3-a evidence validator. MS2 has backend cores and REST
for notifications, voice and work, authorization, plugin manager, MCP client, browser policy, and
the U1 session features (new session, finished-unseen, ephemeral side chat).

## First unfinished slice: a judge for a remote relay (MS1 blocker)

The [MS1 local rehearsal](lanes/MS1-rehearsal.handoff.md) now composes the whole MS1 path on
loopback fixtures (fixture external lead → `guanxi_delegate` → hibernation → relay on the home node
with inference on a second node via F2-d → exactly one wake, lead ledger unchanged, 6.25 simulated
hours, 15 real SIGKILL boundaries). It records two blockers, both asserted so they cannot close
silently:

1. **No judge on a remote relay.** `RelayStarts` builds its executor without a judge, and the judge
   model refuses a remote meter (`judge_config_invalid`). Design and implement the seam so the R3
   cascade (signals at least; model layers if feasible) observes a relay whose inference runs on
   another node, without weakening the fail-closed meter rules. Plan first; independent review.
2. **Stale executor pins after a home crash.** 8 of 15 kill points leave one pin on the executor
   for a run that died with the home (bounded by the per-peer cap of 16). Reap pins whose relay run
   is terminal or unknown to the home, through a signed, fenced message.

## Then

1. **Owner-present (blocked on the owner):** restore `ssh fedora`; approve an integration envelope
   for a first real llama-server smoke run and a real Claude Code lead; then the ≥ 6-hour 30B run on
   the Fedora node for MS1, with R3/B3 recorded evidence. DS2 owner key creation and Touch ID
   signing; signatures for the six `review` components; V1 eval recordings (100–150 phrases).
2. **R3 recording:** a privacy-reviewed observation journal is needed before real runs can become
   `recorded` replay corpora (the relay persists only judge signals, not observations). Design
   decision for the owner.
3. **MS2 UI lanes** on the U1 shell (guanxi-ui skill): the notification center and glossary editor
   are integrated; the work board remains; real action ports (`wake_leads` needs a run-to-connection index — check whether LW's
   lead bindings provide it), `switch_connection`, `pause_runs`.
4. **MS2 platform:** U2 Electron shell, C1 playwright-core browser host, C4 Bridge extension, U3
   Better Auth and `can()` on routes, MCP servers under the K4 sandbox, kernel wiring for the
   plugin manager.
5. **K4 queue v3** Q1 restricted reader and Q2 producer, sequential reviewed rounds.

Residual risks to keep visible are in each hand-off; notably resident llama-server memory is
invisible to the governor (R2-op), the unauthenticated loopback `human_decision` route (MS2), K3
under-accounting on cancel after billing (U1 side chat), and orphaned agent groups after a node
crash until the next start (LW/K5).

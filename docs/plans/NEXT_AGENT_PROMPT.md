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

Overnight (2026-10-22/23) 26 reviewed lanes were integrated; see the record for the list and the
per-lane hand-offs. For MS1 the code path now has: K4 queue Q0; R2-op (opt-in llama-server runtime
with exact counting and owned checkouts); F2-c (remote token costs in the R1 ledger); F2-d (relay
inference on another node over signed, fenced F2 messages with an executor-side exact counter and a
signed pin before each run); LW (external lead `guanxi_delegate`, zero-token hibernation, exactly
one crash-safe wake, owner ceilings on delegated caps, K5 boot reconciliation of stale admission
holders); R3-b/R3-c replay and ETA scorers; B3-a evidence validator. MS2 has backend cores and REST
for notifications, voice and work, authorization, plugin manager, MCP client, browser policy, and
the U1 session features (new session, finished-unseen, ephemeral side chat).

## First unfinished slice: MS1 local rehearsal

Compose the MS1 path end to end on loopback fixtures in one test suite: a fixture external lead
(K5 ACP fixture) calls `guanxi_delegate`; the plan runs through `RelayStarts` on the home node with
inference on a second local node via F2-d and a fake llama-server; costs land per F2-c; the lead
wakes exactly once; acceptance gates run in the owned checkout. Assert the MS1 gate *shape*: lead
token totals unchanged between delegate and wake, exactly one wake, all items green in a clean
checkout, simulated ≥ 6 h with an injected clock, and a crash at each composition boundary.
Known gap to close first or record: the R3 judge cascade refuses a remote meter, so a remote relay
has no judge yet (`docs/plans/lanes/F2-d.handoff.md`).

## Then

1. **Owner-present (blocked on the owner):** restore `ssh fedora`; approve an integration envelope
   for a first real llama-server smoke run and a real Claude Code lead; then the ≥ 6-hour 30B run on
   the Fedora node for MS1, with R3/B3 recorded evidence. DS2 owner key creation and Touch ID
   signing; signatures for the six `review` components; V1 eval recordings (100–150 phrases).
2. **R3 recording:** a privacy-reviewed observation journal is needed before real runs can become
   `recorded` replay corpora (the relay persists only judge signals, not observations). Design
   decision for the owner.
3. **MS2 UI lanes** on the U1 shell (guanxi-ui skill): notification center, glossary editor, work
   board; real action ports (`wake_leads` needs a run-to-connection index — check whether LW's
   lead bindings provide it), `switch_connection`, `pause_runs`.
4. **MS2 platform:** U2 Electron shell, C1 playwright-core browser host, C4 Bridge extension, U3
   Better Auth and `can()` on routes, MCP servers under the K4 sandbox, kernel wiring for the
   plugin manager.
5. **K4 queue v3** Q1 restricted reader and Q2 producer, sequential reviewed rounds.

Residual risks to keep visible are in each hand-off; notably resident llama-server memory is
invisible to the governor (R2-op), the unauthenticated loopback `human_decision` route (MS2), K3
under-accounting on cancel after billing (U1 side chat), and orphaned agent groups after a node
crash until the next start (LW/K5).

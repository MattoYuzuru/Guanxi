# Next agent prompt — close MS1 (all items green) and decide B3

**Status:** active continuation · **Updated:** 2026-10-24

Read [AGENTS](../../AGENTS.md), the [CI protocol](../operations/ci.md), [WORKFLOW](WORKFLOW.md), the newest owner decisions
([2026-10-24](../decisions/2026-10-24-owner-decisions.md), D-214–D-218) and [PHASE_STATUS](PHASE_STATUS.md). The previous
lead session's work is on `lead/ms1-close` (integration PR, see its description for the hosted run and tested revision).
Evidence of the real runs: [MS1 fault runs](evidence/ms1-fault-runs-2026-10-24.md). Operator scripts live outside the repo in
`~/ms1/ops/` (tunnel with a hold file for link-drop injection, `status.sh`, `faults-run.sh`).

## MS1 under D-214

Met on real hardware: delegation by the official Claude Code lead (Sonnet 5.5 medium, owner's `sk-ant-usr` API key), survival
of a dropped link (E1), executor restart (E2) and runtime restart (E3), one honest wake after a home restart (E4), zero lead
tokens while asleep, exactly one wake per run. Still open:

1. **All plan items green in one run.** Read the outcome of run A6 in the evidence file. If it did not close all ten items,
   inspect the relay session log (`~/ms1/home/data/guanxi.db`, `session_events` of the newest `relay_public_starts` row) for
   the stop reason, fix product defects (not the model), and rerun with `~/ms1/ops/faults-run.sh`. Reproduce green items in a
   clean clone from the sealed bundle (`relay_seals.bundle`), as in the evidence file.
2. **B3 relay benchmark gate.** No measurement exists. Ask the owner whether MS1 waits for a B3 cohort on the Fedora node
   (days of GPU time at the observed ~13 min per item) or whether B3 moves to MS2 with a smaller smoke cohort now. Do not decide
   this by default.
3. Product residuals found on the runs: a node-served read-only project view for the lead (its plan facts now come from the
   prompt); probe/strip compatibility for runs sealed before `dcd108ef` (one forced degraded probe on resume); `cd X || exit
   125` instead of `cd X &&` for the relay shell.

## UI and connections (MS2 track)

UI round 4 and the connections centre are integrated; see `docs/plans/lanes/UI-round4.handoff.md` and
`docs/plans/lanes/K3-connections-ui.handoff.md` for residuals (key hints not localised, workspace side panels are
placeholders, the fleet map D-209 not started, palette approval pending). The owner's verbatim UI feedback is in
`/Users/yuzuru/Projects/Guanxi-lanes/prompts/ui-r4-refs/`.

## Working agreement (D-216)

Code by DeepSeek Harness workers (`~/Projects/Guanxi-lanes/infra/dsh-run.sh`, at most four at once, standalone clones with
`npm ci`; their sandbox cannot run containers or Chromium-heavy MS1 paths, so verify their claims yourself); independent
reviews by Opus 5.5 at medium effort (at most two at once); the frontend author is one Opus 5.5 agent. Watch for workers
rewriting existing assertions to match new behaviour; restore them and narrow the change instead.

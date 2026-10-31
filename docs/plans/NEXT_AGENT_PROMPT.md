# Next agent prompt — wave 7: MS1 residuals, B3 smoke cohort, MS2

**Status:** active continuation · **Updated:** 2026-10-31

Read [AGENTS](../../AGENTS.md), the [CI protocol](../operations/ci.md), [WORKFLOW](WORKFLOW.md), the newest owner decisions
([2026-10-31](../decisions/2026-10-31-owner-decisions.md), D-219–D-220) and [PHASE_STATUS](PHASE_STATUS.md). Work is on
`lead/wave7`, cut from `main` after wave 6 merged (`c2f9a5d4`, PR MattoYuzuru/Guanxi#2). The merged lane clones are gone;
`~/Projects/Guanxi-lanes` keeps `infra`, `prompts`, `logs`, review folders, `ledger-ref` (the MS1 reference) and
`integ-trial`. Operator scripts for the Fedora node live in `~/ms1/ops/` (`tunnel.sh`, `status.sh`, `faults-run.sh`).

## Decided on 2026-10-31

- MS1 is closed on the D-214 evidence ([MS1 fault runs](evidence/ms1-fault-runs-2026-10-24.md)); the full B3 cohort is an
  MS2 exit condition; a smoke cohort (at most five tasks, `ledger-relay` and `naive-compaction` arms, one seed) runs now
  and is descriptive only (D-219).
- Every delegated author and reviewer is a Sonnet 5.5 agent in its own worktree (D-220); the lead integrates, verifies and
  owns the PR.

## In flight on `lead/wave7` (lane branches in `.claude/worktrees/`)

1. `lane/ms1-relay-residuals`: `cd <checkout> || exit 125` for composed relay commands; a non-zero exit on the relay's
   fixed-command path returns code and scrubbed output instead of `tool_failed`.
2. `lane/lead-project-view`: a node-served, read-only, bounded project view (`mcp__guanxi` tools) so the lead can read the
   delegated checkout instead of relying on prompt-carried facts.
3. `lane/b3b-smoke`: the B3 smoke-cohort corpus and runner that emits `guanxi.b3.measurement/v1` for the B3-a validator.
   After review and merge, the lead runs the real smoke cohort on the Fedora node and records it under `evidence/`.

Each lane gets a separate Sonnet review (`sde-agent:implementation-reviewer`), fixes in separate commits, then one ready PR
for `lead/wave7` and `npm run ci:finish -- <PR> --wait`.

## Next (MS2 track, in this order unless the owner reorders)

1. K4 queue-v3 Q1/Q2 (restricted reader, producer) — unblocks native-agent work in P1 and C1.
2. U3: wire `can()` into routes and the remote bind at boot (Better Auth after that).
3. P1: kernel boot wiring and the K4 sandbox wrapper for MCP.
4. U2 macOS desktop shell (not started) and the UI residuals of round 4 (key hints not localised, workspace side panels,
   fleet map D-209, palette approval) — see `lanes/UI-round4.handoff.md` and `lanes/K3-connections-ui.handoff.md`.
5. WG1 board UI and `work.query`, WG2 plugin packaging and credentials UI, C1 browser host, V1 owner eval recordings.

Accepted residual: runs sealed before the strip changes resume once through the degraded probe path. A `sk-ant-usr` lead's
own spend is outside `moneyMicros` (runbook section 7).

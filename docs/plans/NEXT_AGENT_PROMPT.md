# Next agent prompt — wave 7: MS1 residuals, B3 smoke cohort, MS2

**Status:** active continuation · **Updated:** 2026-10-31 (wave 7 lanes merged)

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

## Done on `lead/wave7` (see PHASE_STATUS, wave 7)

MS1 relay residuals, the opt-in lead project view, the B3-b smoke runner, the B3-c naive arm and their integration — all
independently reviewed with fixes in separate commits. Hosted CI for the wave 7 PR is the lead's to finish
(`npm run ci:finish -- <PR> --wait`); check the PR description for the run URL.

## Real B3 smoke cohort (needs the Fedora pair)

Follow [RELAY_SMOKE](../../packages/bench/RELAY_SMOKE.md) and [ms1-live-run](../operations/ms1-live-run.md): both nodes on the
same commit; pilot `ll-money-text` in the ledger pass (~75 min), then the full ledger pass (~6.5 h); restart home with
`home.relayCompaction: "naive"` (no `home.lead`), pilot, then the naive pass with the same `--out`. Record the result under
`evidence/` as a descriptive reading (no gate verdict), with an independent review. Optionally re-run MS1 with
`home.lead.projectView: true` to see whether the real lead uses the view.

## Next (MS2 track, in this order unless the owner reorders)

1. K4 queue-v3 Q1/Q2 (restricted reader, producer) — unblocks native-agent work in P1 and C1.
2. U3: wire `can()` into routes and the remote bind at boot (Better Auth after that).
3. P1: kernel boot wiring and the K4 sandbox wrapper for MCP.
4. U2 macOS desktop shell (not started) and the UI residuals of round 4 (key hints not localised, workspace side panels,
   fleet map D-209, palette approval) — see `lanes/UI-round4.handoff.md` and `lanes/K3-connections-ui.handoff.md`.
5. WG1 board UI and `work.query`, WG2 plugin packaging and credentials UI, C1 browser host, V1 owner eval recordings.

Accepted residual: runs sealed before the strip changes resume once through the degraded probe path. A `sk-ant-usr` lead's
own spend is outside `moneyMicros` (runbook section 7).

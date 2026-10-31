# Next agent prompt — wave 8: MS2 track, B3 smoke cohort

**Status:** active continuation · **Updated:** 2026-11-01 (wave 8 lanes merged)

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

## Done

Wave 7 is on `main` (PR MattoYuzuru/Guanxi#3). Wave 8 on `lead/wave8`: U2 macOS shell (first slice), U3 route authorization
and boot bind gate, K4 queue-v3 Q1 — see PHASE_STATUS. Desktop order: macOS, then Linux/Fedora, Windows last (D-221).
Owner questions open: Q-246 (local-owner secret), Q-247 (bundled LGPL `libffmpeg` and Node), Q-248 (WTFPL build tool); a
signed macOS release also needs the Apple Developer Program (D-156).

## Real B3 smoke cohort (needs the Fedora pair)

Follow [RELAY_SMOKE](../../packages/bench/RELAY_SMOKE.md) and [ms1-live-run](../operations/ms1-live-run.md): both nodes on the
same commit; pilot `ll-money-text` in the ledger pass (~75 min), then the full ledger pass (~6.5 h); restart home with
`home.relayCompaction: "naive"` (no `home.lead`), pilot, then the naive pass with the same `--out`. Record the result under
`evidence/` as a descriptive reading (no gate verdict), with an independent review. Optionally re-run MS1 with
`home.lead.projectView: true` to see whether the real lead uses the view.

## Next (MS2 track, in this order unless the owner reorders)

1. K4 queue-v3 Q2 (v3 producer, lift the restriction) — a separate author/reviewer round per the queue-v3 plan.
2. U2-b: launchd agent and login item, tray, a real signed and notarized build once Q-247 and the Apple account are settled,
   auto-update; then U6 Linux with a Fedora rpm (D-221).
3. U3-b: Better Auth accounts adapter, grants in resource lookups, per-account stores; Q-246.
4. P1: kernel boot wiring and the K4 sandbox wrapper for MCP.
5. UI round 4 residuals (key hints, side panels, fleet map D-209, palette approval), WG1 board and `work.query`, WG2
   packaging, C1 browser host, V1 owner eval recordings.

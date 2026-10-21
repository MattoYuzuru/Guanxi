# Next agent prompt — wave 3 (DS1-b, F1, K4 follow-up)

**Status:** ready · **Updated:** 2026-10-21 (K1, DS1-a, K2, K3, R1 with its follow-up, and K4
merged into `main`)

Work runs as parallel lanes. Start from [lanes/README](lanes/README.md), which lists every lane,
its runner, branch and ports, and the rules every lane follows. Phone access remains planned
for U4 under D-187 and ADR-0038; no relay is deployed.

Open lanes:

- **DS1-b — `@guanxi/ui`, catalog, approvals:** review closed; the lane is merging current
  `main` before the integrator merge. Then DS1-c starts in Codex ([lanes/DS1-c](lanes/DS1-c.md)).
- **F1 — federation base:** [lanes/F1](lanes/F1.md). Claude review 1 returned "merge after
  fixes" with four High findings (revoke versus grant causality, request audience binding,
  non-admin revocation, per-op admission); the fix round runs in Codex.
- **K4 follow-up:** `lane/k4-followup` closes the final-check residuals R1, R3 and R4 listed in
  [evidence/K4](evidence/K4.md).

After DS1 and K4: K5, B1, X1, F2, R2 (after K4 and R1), DS2 and U1 open. See
[PHASE_STATUS](PHASE_STATUS.md) and the [roadmap graph](roadmap.mmd).

Any session without a lane: pick the first `ready` lane in [PHASE_STATUS](PHASE_STATUS.md)
that nobody runs, and follow its lane file.

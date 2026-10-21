# Next agent prompt — wave 3 (DS1-c, F1)

**Status:** ready · **Updated:** 2026-10-21 (K1, DS1-a, DS1-b, K2, K3, R1 with its follow-up,
and K4 merged into `main`)

Work runs as parallel lanes. Start from [lanes/README](lanes/README.md), which lists every lane,
its runner, branch and ports, and the rules every lane follows. Phone access remains planned
for U4 under D-187 and ADR-0038; no relay is deployed.

Open lanes:

- **DS1-c — lint ratchet and codemod:** [lanes/DS1-c](lanes/DS1-c.md), running in Codex.
  DS2 and U1 open when it merges.
- **F1 — federation base:** [lanes/F1](lanes/F1.md). Claude review 1 returned "merge after
  fixes" with four High findings (revoke versus grant causality, request audience binding,
  non-admin revocation, per-op admission); the fix round runs in Codex.

K4 is merged with its follow-up, so K5, B1, X1 and R2 are open now; F2 opens after F1, and DS2
and U1 after DS1-c. See
[PHASE_STATUS](PHASE_STATUS.md) and the [roadmap graph](roadmap.mmd).

Any session without a lane: pick the first `ready` lane in [PHASE_STATUS](PHASE_STATUS.md)
that nobody runs, and follow its lane file.

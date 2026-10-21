# Next agent prompt — wave 3 (DS1-c, DS2, F1, R2, K5, X1, B1)

**Status:** ready · **Updated:** 2026-10-21 (K1, DS1-a, DS1-b, K2, K3, R1 with its follow-up,
and K4 merged into `main`)

Work runs as parallel lanes. Start from [lanes/README](lanes/README.md), which lists every lane,
its runner, branch and ports, and the rules every lane follows. Phone access remains planned
for U4 under D-187 and ADR-0038; no relay is deployed.

Open lanes:

- **DS1-c — lint ratchet and codemod:** [lanes/DS1-c](lanes/DS1-c.md). Claude review 1:
  merge after fixes (contrast regression, untested guards, mixed palette); fix round running.
  DS2 and U1 open when it merges.
- **R2 — relay executor v1:** [lanes/R2](lanes/R2.md). Claude review 1: merge
  after fixes (token-vs-byte boundary, narrative truncation, whole-history seals); fixes queued.
- **DS2 — approval signing helper:** [lanes/DS2](lanes/DS2.md), running in DeepSeek Harness.
- **K5 — external agents and role routing:** [lanes/K5](lanes/K5.md), partial. Claude review 1:
  merge after fixes (default autonomous tools in two adapters, bypassable token gate); fixes queued.
- **X1 — repository map and full-text index:** [lanes/X1](lanes/X1.md), handed off;
  Claude cross-family review running.
- **F1 — federation base:** merged; see [evidence/F1](evidence/F1.md). F2 (remote attempts) is open.

K4 is merged with its follow-up, so R2, K5 and X1 are in review and B1 ([lanes/B1](lanes/B1.md)) runs on its
provisioned benchmark host (D-194); F2 opens after F1, and DS2
and U1 after DS1-c. See
[PHASE_STATUS](PHASE_STATUS.md) and the [roadmap graph](roadmap.mmd).

Any session without a lane: pick the first `ready` lane in [PHASE_STATUS](PHASE_STATUS.md)
that nobody runs, and follow its lane file.

# Owner decisions — 2026-10-23 (Fedora runs, MS1 lead, R3 journal)

**Status:** accepted · **Date:** 2026-10-23 · **Decisions:** D-196–D-199
**Extends:** [2026-10-22](2026-10-22-owner-decisions.md).
**Source:** the owner's messages in the Guanxi development chat after the overnight run.

| ID | Topic | Decision | Source |
| --- | --- | --- | --- |
| D-196 | Fedora access and real runs | `ssh fedora` is available again. The owner authorizes full testing on the Fedora node: the full regression as the dedicated `guanxi-bench` user, a first real llama-server run with the installed Qwen3.8-27B GGUF and llama.cpp b11496 on the RTX 3060, the two-host run (Mac home node, Fedora executor) and the full MS1 run. D-194's rule against real benchmarks on the Mac still applies; the model runs on Fedora. | owner message 2026-10-23 |
| D-197 | MS1 lead | The owner's own Claude Code on the Mac may act as the MS1 lead through K5 (official unmodified CLI, D-190), spending the owner's subscription quota for planning and the final review only. | owner answer 2026-10-23 |
| D-198 | MS1 target repository | The first six-hour MS1 run uses the owner's private repository `MattoYuzuru/Guanxi-Test-Repo` (local clone `~/Projects/Guanxi-Test-Repo`, empty at decision time). Agents may seed it with a small project and a plan, and push to it. | owner answer 2026-10-23 |
| D-199 | R3 observation journal | For judge calibration, full judge observations **including file paths** may be stored **locally** with a bounded retention, like reasoning under D-113: never exported, never sent to a remote model or a remote auditor, removed with the session's retention. This answers the open design question recorded by R3-b/R3-d. | owner answer 2026-10-23 |

D-199 does not relax the egress rules: the journal stays on the node that owns the run, the egress
scrubber still applies to anything that leaves it, and a later export or bench submission needs a
separate decision.

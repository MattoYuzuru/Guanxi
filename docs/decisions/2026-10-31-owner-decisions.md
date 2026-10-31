# Owner decisions — B3 moves to MS2, Sonnet-only workers, desktop platform order

**Status:** accepted · **Date:** 2026-10-31, addendum 2026-11-01 · **Decisions:** D-219–D-221

Given by the owner in Russian (voice-dictated) to the wave 7 lead session on 2026-10-31,
answering the B3 question left open by the wave 6 lead.

| ID | Decision |
| --- | --- |
| D-219 | **The B3 gate leaves the MS1 exit and joins MS2; a smoke cohort runs now.** MS1 is closed on the D-214 evidence of run A7 and the fault runs ([record](../plans/evidence/ms1-fault-runs-2026-10-24.md)). The full B3 cohort (days of GPU time on the Fedora node at about 15 minutes per item) is an MS2 exit condition. A small smoke cohort runs now on the Fedora node to prove the benchmark path end to end and give a first descriptive reading; it does not evaluate the B3 gate. Default used for "small" (the owner did not size it): at most five tasks, the ledger-relay and naive-compaction arms, one seed. |
| D-220 | **Worker allocation for the wave 7 lead session: Sonnet 5.5 only.** Every delegated author, reviewer and the frontend author are Sonnet 5.5 agents; the lead integrates and verifies. This supersedes the D-216 allocation (DeepSeek Harness authors, Opus reviewers, Opus frontend author) for this session. Independent verification stays a separate agent and action (WORKFLOW); the MS1 lead model of D-210/D-215 is unchanged. |
| D-221 | **Desktop app platform order (2026-11-01): macOS first, then Linux with Fedora as the reference distribution, Windows last.** U2 (macOS desktop) is the first app stage; U6 delivers Linux (Fedora rpm first, then AppImage/Flatpak and the headless node package) before Windows (NSIS), and a Windows build never blocks a Linux release. Owner on whether apps are needed at all: "continue development" — the desktop shell stays in the MS2 path as planned. |

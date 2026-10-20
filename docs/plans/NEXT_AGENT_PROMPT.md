# Next agent prompt — wave 2 (K2 and K3)

**Status:** ready · **Updated:** 2026-10-20 (K1 and DS1-a merged into `main`)

Work now runs as parallel lanes. Start from [lanes/README](lanes/README.md), which lists every
lane, its runner, branch and ports, and the rules every lane follows.

- **K2 — session log, inspector, egress scrubber core:** [lanes/K2](lanes/K2.md). Start a Claude
  session in its own worktree with this prompt:

  ```text
  You are lane K2 of Guanxi. Run `npm ci` in your worktree first and confirm @guanxi/contract
  resolves inside it. Then read AGENTS.md, docs/plans/lanes/README.md, docs/plans/lanes/K2.md
  and docs/plans/WORKFLOW.md, and do the task in K2.md exactly. Write status only to
  docs/plans/lanes/K2.handoff.md; commit on your branch; never push or merge.
  ```

- **K3 — model access:** [lanes/K3](lanes/K3.md). Paste the prompt in that file into a GPT
  (Codex) session in its own worktree.
- **DS1:** DS1-a is merged; DS1-b is finishing review fixes; DS1-c starts after DS1-b merges;
  DS2 and U1 open after DS1.

Any session without a lane: pick the first `ready` lane in [PHASE_STATUS](PHASE_STATUS.md)
that nobody runs, and follow its lane file.

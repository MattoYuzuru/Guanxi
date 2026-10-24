# Next agent prompt — resume the paused lanes with final hosted CI

**Status:** active continuation · **Updated:** 2026-10-24

Start with [the Claude lead restart prompt](CLAUDE_LEAD_RESTART.md), then
[AGENTS](../../AGENTS.md), [CI protocol](../operations/ci.md), [WORKFLOW](WORKFLOW.md),
[lanes](lanes/README.md) and [PHASE_STATUS](PHASE_STATUS.md). D-213 replaces repeated full
local gates with focused local iteration and one reviewed ready candidate in parallel CI.

The owner paused the agents for this migration. Do not infer that previous subprocesses,
SSH forwards or runtime units remain alive. Reuse the existing clones/branches and preserve
all dirty work. The local resume inventory identifies checkout HEADs and paths; inspect the
latest handoffs and actual state before choosing the next unfinished slice.

## Product continuation

The prior [continuation snapshot](NEXT_AGENT_PROMPT.pre-ci-2026-10-24.md) is historical, not a
list of still-open tasks. Local main at migration start was `4644f353`, including the K5
API-key/setup-token lead credential work (D-211/D-212). The UI redesign remains a priority
(D-200–D-207); its author/fix clones contain work newer than older status summaries. Identify
which review findings and gates remain before resuming or integrating them.

For MS1, reconcile [the Fedora record](evidence/fedora-real-runtime-2026-10-23.md),
[the live runbook](../operations/ms1-live-run.md) and current handoffs. R2-json, pin reaping,
remote judge/journal and K4 pipe/image work have implementations and review history: do not
restart them from the old prompt. A real Claude Code lead, multi-item/judge evidence and the
six-hour exit require their existing explicit integration envelope; hosted offline CI does
not close them. Do not probe another host merely to repair local CI.

## Completion

Workers hand off focused evidence and reviewed commits. The lead batches a coherent
integration candidate, publishes/updates one PR and marks it ready. End with
`npm run ci:finish -- <PR-number> --wait`, fix required failures, and record the exact run and
revision. Do not reinstall dependencies, reclone, push after each commit, run all local gates
or repeatedly poll through model turns. Keep the prompt on the current slice if CI or review
is unfinished. Preserve live-model, owner-present signing and hardware residuals.

# Owner decision — hosted final CI and scoped local iteration

**Status:** accepted · **Date:** 2026-10-24 · **Decision:** D-213

The owner paused agent sessions and authorized parallel GitHub Actions for the complete
final gate, focused local checks, cache research, updated agent documentation and a restart
prompt that reuses existing clones and unfinished work. This supersedes earlier requirements
to run full local gates per lane/merge and reinstall/reclone at handoff.

The lead owns one reviewed integration candidate and its final hosted evidence. Workers
commit coherent checkpoints and hand off focused evidence; they are not required to push
after each edit or commit. Draft PRs run quick checks, ready PRs run the full matrix. One or
two complete runs is the normal target, never a limit that permits unfinished validation.

Follow [the CI protocol](../operations/ci.md). Independent review, meaningful assertions,
platform-specific/live validation and all existing secret/data boundaries remain required.

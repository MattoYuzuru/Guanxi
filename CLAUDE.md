# Guanxi agent entrypoint

@AGENTS.md

Use the canonical [CI protocol](docs/operations/ci.md): scoped local tests while editing,
one reviewed ready candidate for parallel hosted checks, then `npm run ci:finish -- PR --wait`.
The lead owns publication and integration; workers hand off commits and focused evidence.
Keep the current clone, branch and dependency install. Read the
[restart prompt](docs/plans/NEXT_AGENT_PROMPT.md) before resuming paused work.

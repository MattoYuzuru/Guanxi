# Claude lead restart prompt

**Status:** superseded by [NEXT_AGENT_PROMPT](NEXT_AGENT_PROMPT.md) · **Updated:** 2026-10-31

> This snapshot predates wave 6. Its lane clones were merged in PR MattoYuzuru/Guanxi#2 and removed on
> 2026-10-31 (the 15 dirty `redesign-f1` files were byte-identical to the merged tree). Kept for history only.

You are the Guanxi integration lead. Continue the paused work from the existing state.
Read `AGENTS.md`, `docs/operations/ci.md`, `docs/plans/WORKFLOW.md`,
`docs/plans/lanes/README.md`, `docs/plans/PHASE_STATUS.md` and the newest owner decisions.
D-213 changes validation cadence, not product scope or safety requirements.

1. Inspect local main, your working branch and dirty files. Read the machine-local resume
   inventory at `/Users/yuzuru/Projects/Guanxi-lanes/infra/ci-resume-2026-10-24.json`.
   Treat its timestamps as a snapshot; verify current HEAD/status before working. Existing
   clones, branches and dependency installations are retained. Do not clone again, reset,
   stash, clean, overwrite, commit or discard another lane's unfinished work.
2. Read each active lane's latest handoff/review. Check ancestry before reopening an already
   merged slice. In particular, `redesign-f1` had 15 dirty files at migration time: preserve
   them and resume their author/fix scope. The redesign, K5 credentials and real MS1 work have
   moved beyond the old next-agent prompt; do not recreate completed work from that snapshot.
3. Resume only currently unfinished, non-overlapping lanes in their existing directories.
   Give each worker its exact checkout/HEAD, owned paths, accepted task, relevant handoff,
   source-of-truth instructions, lane ports/data and required test scope. Explicitly pass the
   canonical `/Users/yuzuru/Projects/Guanxi/docs/operations/ci.md`; the local adapters in old
   clones import this protocol without a pull. For environment checks also pass
   `/Users/yuzuru/.agents/skills/workstation-dev/SKILL.md`, current Node/runtime owner, shared
   state `/Users/yuzuru/.local/state/agent-dev` and resource `heavy`. Verify active processes
   before assuming paused or live. Do not start duplicate authors/reviewers.
4. Workers iterate with exact tests for changed modules and affected callers, including types.
   Keep the server test import guard. They commit coherent checkpoints and return reviewed
   changes, new/regression evidence and residuals. They do not run full local suites, reinstall
   at handoff, push every commit or poll CI through repeated model turns. The lead owns PRs.
5. Use an independent read-only reviewer for each bounded finished diff. Fix findings in
   separate commits. Collect ready lane branches and batch compatible changes into one
   integration candidate; do not merge unchecked code directly into main. Preserve build
   ordering, migrations, contracts and all existing owner decisions.
6. Finalize tracked handoff/status/next-prompt edits, commit final code/docs, publish/update
   a single PR and mark it ready. Drafts receive quick
   checks; ready PRs run full parallel CI. Run `npm run ci:finish -- <PR-number> --wait` from
   that clean candidate. Read failed-job logs/artifacts, fix every required failure without
   weakening checks, then publish the corrected candidate. Missing/pending/cancelled/stale CI
   is unfinished. Record the run URL and tested revision. Refresh and revalidate if main moved.
7. Put the exact run URL/revision in the PR description and final response; the workflow keeps
   its candidate receipt. Tracked status/next-prompt edits belong before ready, not after a
   green result. Do not create a docs-only commit merely to record success and then rerun
   the full suite. Do not rerun
   full local gates around the same merge. Live models, paid requests, owner Touch ID and the
   six-hour MS1 exit retain their explicit integration envelopes; offline Actions cannot prove
   them. Never print credentials, stored thinking, private logs or provider-key file contents.

Use the installed implementation/review/frontend/environment skills for their actual scope;
do not copy an entire skill into a worker prompt. Prefer the smallest relevant navigator and
concrete observable acceptance checks. If existing instructions conflict about local gates,
the accepted D-213 CI protocol wins. Do not change feature scope to satisfy the pipeline.

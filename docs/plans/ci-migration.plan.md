# Parallel CI migration plan

**Status:** owner-authorized implementation · **Date:** 2026-10-24

## Outcome

Keep local iteration scoped; validate one ready integration candidate in parallel GitHub
Actions; let the lead finish by checking the exact candidate's CI. Preserve independent
review, platform boundaries, all existing check leaves and existing lane checkouts.

## Scope and acceptance

- Secret-free PR workflow, full history, pinned actions/Node, isolated parallel jobs,
  bounded concurrency, failure artifacts and a fail-closed aggregate gate.
- Draft PRs run quick checks; ready PRs run the full matrix. Local commits and branch-only
  pushes do not each launch the expensive matrix. Newer PR candidates supersede older runs.
- npm download and native Docker layer caches survive ordinary source/document edits;
  no cached test success, node_modules, generated tracked files or cross-run dist.
- A tested task inventory rejects unclassified future workspaces/test/build entrypoints.
- A read-only finish command binds PR, head, tested merge/base and completed jobs; a failed,
  missing, skipped, cancelled or stale full gate cannot finish a slice.
- Root instructions and the lane protocol have one canonical validation procedure. A compact
  Claude adapter and lead restart prompt route to it. Existing dirty work is preserved.

## Verification

Run focused Node tests for inventory, shard arguments, completion decisions and affected
routing; actionlint/shellcheck; Markdown links/lint; licenses. Obtain an independent read-only
review, fix findings in a separate commit, then run the hosted full matrix on a PR and inspect
its actual jobs/artifacts. Hosted portability failures are diagnosed rather than bypassed.

## Boundaries and rollback

No feature work, database migration, live model, paid provider, deployment or remote machine
changes. The first hosted run exposed bench child-supervision defects; the bounded fixes and
regression evidence are recorded in the research. Hosted tests do not prove owner
hardware/Secure Enclave/live runtime behavior.
Keep baseline snapshots unchanged. Revert this workflow/protocol change to restore previous
commands; retained data, lane branches and dependency installations are not removed.

## Sources

The implementation evidence records the official GitHub, npm/Node, Docker, Playwright,
Anthropic and OpenAI documentation reviewed, observed command behavior and cache decisions.

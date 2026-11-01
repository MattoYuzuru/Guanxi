# Prewarm browser gate: deterministic selection debounce

**Status:** diagnosis / bounded test fix · **Date:** 2026-11-01
**Base:** `71087caf` · **Branch:** `codex/prewarm-gate`

CI run `41338610542`, job `124943696443`, failed the exact-selection browser assertion:
it observed a model-b prewarm before the expected model-c request. The production hook uses
a 600 ms timer and cancels it on selection cleanup. The test installs a Playwright clock
but leaves it running; 400 ms plus a 20 ms passive-effect flush leaves real selector work
able to cross model-b's deadline. This source explanation must be checked against timing
evidence before declaring the cause.

Inspect the failed trace if available and use a bounded clock/fixture diagnostic when needed.
If confirmed, pause the browser clock before the tested selection window, advance only
known Select/passive-effect timers, and assert zero requests before the final debounce
boundary followed by exactly one request for the final selection. Preserve cleanup-before-
Chat ordering, counts, reduced motion and overflow assertions. Do not edit production code,
increase timeouts, add sleeps, remove assertions or retry unchanged failures until green.

Validation: this worktree's `npm ci`, Node 26.9.0, own contract resolution; headless existing
Playwright runner with web 5281 / API 4481 / `.lane-data`, under the shared heavy lock.
Run the changed prewarm spec once per meaningful candidate, changed-file lint/types as
appropriate, and record CI red/targeted evidence and an author commit for independent review.
No Electron, native GUI, Keychain, live model, owner data or other host. Root integrates
reviewed fixes and owns a fresh full hosted gate; this lane does not rerun the failed CI job.

No persistence/public API/dependency change or migration is expected. Rollback is reverting
the test change. No third-party code is copied. Parent owns central status and release docs.

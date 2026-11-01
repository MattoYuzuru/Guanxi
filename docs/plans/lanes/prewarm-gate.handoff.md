# Prewarm selection browser gate repair — handoff

**Status:** test fix locally validated and independently reviewed; fresh hosted CI pending
**Date:** 2026-11-01 · **Base:** `71087caf` · **Branch:** `codex/prewarm-gate`

Plan commit `4b7c5d27`; test fix `4e63c408b0d816d24e0719c9b6850486a9d23d4a`.
Only the first prewarm browser test changes. Production debounce, cancellation and request
contracts remain the source of truth; no production source, dependency or timeout changed.

## Red evidence and cause

[CI run 41338610542](https://github.com/MattoYuzuru/Guanxi/actions/runs/41338610542), job
`124943696443`, failed `prewarm.spec.ts:313`: it expected exactly one model-c request and
observed model-b followed by model-c. The job completed 135 other tests successfully; this
lane did not rerun that unchanged job.

The downloaded failed trace is at
`/tmp/guanxi-wave11/ci/web-browser-1/packages/web/test-results/prewarm-stable-exact-selec-abcea--precedes-one-Chat-dispatch/trace.zip`.
Its monotonic timing records show:

| Event | Trace time (ms) |
| --- | ---: |
| model-b pointer action completed (`call@11313`) | 356083.775 |
| explicit 20 ms fast-forward | 356138.060 |
| explicit 400 ms fast-forward | 356145.409 |
| input snapshot already displays the warming status (`input@call@11331`) | 356275.242 |
| model-c pointer action begins (`call@11331`) | 356276.232 |

The final fixture snapshot records `prewarm-request → prewarm-abort → prewarm-release →
prewarm-request`, with digests model-1 then model-2. Warming was already visible before the
model-c click committed. The test had installed the clock without pausing it, so real
actionability/selector time also advanced the application's 600 ms debounce. Its explicit
420 ms was not the whole elapsed window. This is evidence of an uncontrolled test clock,
not a production cancellation failure. The source hook correctly aborts the earlier request
when selection changes, as the trace's abort/release events confirm.

A compact extraction of the clock/action/snapshot records is saved at
`/tmp/guanxi-wave11/ci/prewarm-timing-evidence.json`. No synthetic local red run or retries
were needed: the failed hosted execution and its trace supply the red evidence.

## Fix and retained assertions

Pause the installed clock on about:blank before application timers exist. Explicitly drive
Select's existing paused-clock helper with its 20 ms popup steps; retain the existing
passive-effect frame flush and final 600 ms advance. This follows the established paused
clock pattern in `localization.spec.ts` and the [Playwright clock contract](https://playwright.dev/docs/api/class-clock#clock-pause-at).

Two additional zero-call checkpoints prove no request was dispatched during model-b's short
window or immediately after changing to model-c. The original exact request body, digest,
context/fit, one prewarm call, one abort, one release, one Chat dispatch, cleanup-before-Chat,
mobile overflow and reduced-motion assertions are unchanged. No sleep, assertion removal,
larger timeout, retry setting or production behavior change was added.

## Local evidence and remaining gate

This worktree ran `npm ci`; Node is 26.9.0 and `@guanxi/contract` resolved inside this checkout.
The existing Playwright runner launched headless Chromium under the shared heavy lock with
web 5281 / API 4481 / worktree `.lane-data`. Fixture fetches supply synthetic API responses.
No Electron, native GUI, OS Keychain, live model, owner data or other host was used.

- **New tests: 0; strengthened existing tests: 1** with two zero-call assertions.
- **Regression envelope: both prewarm browser tests, 2/2 passed, 0 skipped**, on the first
  local candidate execution. Command: `npm run test:browser --workspace @guanxi/web -- test/browser/prewarm.spec.ts`;
  receipt/log `/Users/yuzuru/.local/state/agent-dev/check-cm7eixg6/`.
- Web typecheck (application and browser-test configurations) passed, exit 0:
  `/Users/yuzuru/.local/state/agent-dev/check-7el75nw1/`.
- Changed-file ESLint, both lane Markdown files and `git diff --check` passed. Documentation
  links passed across 348 files / 965 links with zero problems.

Both recorded checks reported no source drift. The tested test contents became `4e63c408`;
the plan status/handoff were written afterward. Runner receipts are non-reusable because its
source verifier does not support the tracked `.claude/skills/guanxi-ui` directory symlink;
this is direct local execution evidence, not reusable source attestation or hosted completion.

Independent reviewer `local_inventory` read the exact `4e63c408` diff and failed trace clock,
click and warming records. Review passed: the cause is consistent with the trace; the fix
preserves exact model-C body/count, abort/release counts and ordering, one Chat dispatch,
viewport and reduced-motion assertions. The reviewer performed no rerun or native GUI test.
Root integrates this and the separate license fix, then runs one fresh full hosted gate on
the resulting candidate. This handoff does not certify full-browser coverage, alpha readiness
or any live-model behavior. Rollback reverts the test
fix; no data migration is involved. No push, publication or external mutation occurred here.

# NC1-a handoff — deterministic quota alert rules

**Status:** bounded slice implemented and locally validated; independent review recorded below.
NC1 remains **in progress** and the stage is not complete. No status file was edited.
**Date:** 2026-10-22 · **Branch:** `codex/nc1a-quota-alert-rules` · **Base:** `069eeb24`

## What exists

`packages/server/src/notifications/` is a pure module with no database, HTTP route, UI, timer,
`Date.now()` or other I/O. The caller passes `now` and persists `WindowState` as JSON.

- `types.ts` — quota facts, alert config and defaults (20/10/5, hysteresis 2), window state,
  alerts, dependent runs and the idempotency-key shape.
- `rules.ts` — `evaluateQuota({ fact, previous, config?, dependentRuns?, refusal?, now })`.
  It handles reset-aware instance keys, the more-than-50-point synthetic reset, descending
  thresholds with generalised severities, once-per-instance firing and no re-arm, unknown
  percent, per-instance exhausted alerts, one forecast per instance with reset/dependent-ETA
  preference, stale-observation rejection, TypeError validation, provenance and stable keys.
- `README.md` — current scope and the later NC1 slices.

## Evidence

```bash
nice -n 10 node --test packages/server/test/notifications/quota-alert-rules.test.ts
```

```text
ℹ tests 11
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

```bash
nice -n 10 npx tsc --noEmit -p packages/server
```

Result: exit 0, no diagnostics.

```bash
npx markdownlint-cli2 packages/server/src/notifications/README.md docs/plans/lanes/NC1-a.handoff.md
```

Result: `Summary: 0 error(s)`.

### New / regression envelope

- **New:** 11 tests in `packages/server/test/notifications/quota-alert-rules.test.ts`; 11
  executed, 11 passed, zero skipped. They cover the ADR-0033 validation scenario, multi-cross
  order and severities, the +60/+40 reset boundary, unknown percent, exhausted once per
  instance, forecast before reset/dependent ETA and once per instance, stale delivery,
  determinism/purity, validation, idempotency keys and a custom `[50, 25]` config.
- **Regression envelope:** 0 existing test files and 0 existing tests were executed in this
  sandbox. `tsc --noEmit -p packages/server` typechecked the whole server source and test
  tree; markdownlint checked the two owned Markdown files. Per lane instructions, `npm test`,
  browser tests, builds and servers were not run.

## Independent verification

A separate read-only reviewer sub-agent found cross-reset stale regression, host-dependent
offsetless timestamp parsing, equivalent-`resetsAt` idempotency and hysteresis/exact-50 test
gaps. All findings were fixed before the three slice commits, and the final tests pass under
UTC, `Asia/Tokyo` and `America/New_York`. No blocking findings remain.

## Residuals (all later NC1 slices)

- Durable per-account notification inbox and append-only migration.
- Typed idempotent actions, including `wake_leads`, `switch_connection`, pause/resume and snooze.
- Deterministic recommendations and run-policy automatic reactions.
- OS notifications and content-free PWA push payloads, with quiet hours and channel settings.
- In-app notification center on desktop and web.

## Stage status

NC1 stays **in progress**. This slice does not close the stage: the durable inbox, actions,
automatic-reaction policy and delivery/UI surfaces above remain unfinished. `PHASE_STATUS.md`
and `NEXT_AGENT_PROMPT.md` were not edited; the integrator folds this handoff in.

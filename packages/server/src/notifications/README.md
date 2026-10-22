# Quota alert rules

**Status:** implemented · **Updated:** 2026-10-22 · **Scope:** pure rule engine for NC1-a

This module implements the deterministic part of ADR-0033 decision 2: quota facts, thresholds,
once-per-window-instance firing, forecasts and exhausted alerts. Hysteresis points are validated
and reserved; because a fired threshold never re-arms within an instance, they do not change
firing decisions in this slice. It has no I/O: no database, HTTP routes, UI, timers or
`Date.now()`. The caller supplies `now` and persists `WindowState` between evaluations.
Timestamps are parsed deterministically: offsetless ISO values are treated as UTC.

## What exists

- `types.ts`: `QuotaFact`, `AlertConfig`, `WindowState`, `Alert`, `DependentRun` and the
  ADR-0033 defaults (`20`, `10`, `5` percent remaining; `2` points of hysteresis).
- `rules.ts`: `evaluateQuota({ fact, previous, config?, dependentRuns?, refusal?, now })`
  returns `{ state, alerts }` without mutating its input.
- Thresholds fire once per window instance and are emitted highest-first. The highest
  configured threshold is `info`, the lowest `critical`, the others `warning`; a single
  threshold is `warning`.
- A new `resetsAt` starts a fresh instance. A rise of more than 50 points without a new reset
  timestamp starts a synthetic instance keyed by the observation time. Equivalent reset
  instants keep one instance even when the caller spells the timestamp differently.
- Unknown percent (`null`) fires no threshold and no forecast and preserves already-fired
  thresholds. Out-of-order observations are ignored.
- Forecast requires a previous known observation in the same instance. It fires at most once
  when the projected exhaustion is strictly before `resetsAt` or before the earliest
  dependent-run P80 ETA, preferring the dependent run when both apply.
- A refusal fires one `critical` exhausted alert per instance.
- Every alert carries source, observation time and confidence, plus a stable idempotency key.

## What is later work (not in this module)

- The durable per-account notification inbox and its append-only migration.
- Typed idempotent actions, including `wake_leads`, `switch_connection` and snoozing.
- Deterministic recommendations and run-policy automatic reactions.
- OS notifications and PWA push payloads, including quiet hours and channel settings.
- The in-app notification center and its desktop/web surfaces.

Those slices integrate this engine with storage, routes, run policy and UI. NC1 is not
complete.

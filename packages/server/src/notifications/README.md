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

## NC1-b: durable inbox, typed actions, recommendations and OS payloads

**Status:** implemented · **Updated:** 2026-10-23 · **Scope:** NC1-b

This section supersedes the NC1-a later-work list above for the items it names. The rule
engine, `types.ts` and `rules.ts` are unchanged.

### Store and quota ingestion

`store.ts` owns a separate `<dataDir>/notifications.sqlite` sidecar with WAL, foreign keys and
its own append-only `nc1_migrations` table. Version 1 creates `quota_window_state`,
`notifications` and `notification_actions`; later changes add versions, never rewrite v1.
`windowState` returns the persisted NC1-a `WindowState`. `recordEvaluation` upserts that state
and inserts one notification per alert in one transaction, so an insert failure leaves the old
window state in place. Notification ids are derived from account and idempotency key, and
`ON CONFLICT(idempotency_key) DO NOTHING` makes fact re-ingestion a no-op.

`list` returns newest-first rows for one account with optional `states`, `limit` (1..500) and
a `before` cursor. The cursor may be a notification id or a `{ createdAt, id }` object, which
compares `(created_at, rowid)` and therefore does not lose rows that share one millisecond; a
plain number means strictly older timestamps. `get`, `markRead`, `snooze`, `windowState` (with
its optional account) and the action paths are account-scoped; a notification id from another
account raises `NotificationStoreError` with code `account_mismatch`. `snooze` stores
milliseconds and `expireSnoozed(nowMs)` returns only rows whose deadline passed to `unread`.
Quota alerts offer `open`, `wake_leads`, `switch_connection`, `pause_runs`, `snooze` and
`accept_recommendation`; `exhausted` also offers `resume_runs`. Connection ids are treated as
globally unique and account-owned: v1 uses the requested `(connection_id, window)` window key
and a global notification idempotency key, so two accounts cannot reuse one connection id.

`service.ts` joins the rules to the store. `ingestQuotaFact` loads the previous window state,
calls `evaluateQuota` with the caller clock and writes the evaluation and its alerts through
`recordEvaluation`. The write includes an optimistic `lastObservedAt` check; a concurrent
writer that won first raises `state_conflict`, and the service re-reads and re-evaluates (three
attempts). Re-ingesting an identical fact therefore inserts nothing.

### Typed actions and the at-most-once contract

`actions.ts` defines one typed command per ADR-0033 action and an `ActionPorts` interface with
one async method per command (`open`, `addPrompt`, `acceptRecommendation`, `chooseAction`,
`wakeLeads`, `switchConnection`, `pauseRuns`, `resumeRuns`, `snooze`, `raiseBudget`).
`executeAction` validates that the notification offers the action, reserves the idempotency
key with `beginAction`, calls the matching port and stores the terminal result with
`finishAction`. A notification that is already `acted` rejects a new key, and a `started` row
for another key rejects the command as `action_in_progress`, so one notification cannot run two
actions at once. `finishAction` marks the notification `acted` on success, except for the typed
`snooze` command, which enters `snoozed` with its deadline. A terminal duplicate returns the
stored result without touching a port; a failed port stores only `{ "code": "port_failed" }`
and rethrows `NotificationActionError`, never the port message.

The reservation plus the process-local in-flight map makes effects at-most-once within one
process. Same-process calls with one key share a single in-flight promise, so a racing retry
cannot probe a live `started` row and call the port again. `hasCompleted` covers a process
restart:

- a terminal `done` or `failed` row is immutable and is never replayed;
- a `started` row with no in-flight caller in this process is treated as a crashed attempt;
- the effect is replayed only when `ports.hasCompleted(key)` explicitly returns `false`;
- `true` means the effect already happened, so the row is completed as
  `{ "recovered": true }` without another port call;
- no probe, or a probe that throws, raises `action_outcome_unknown` and leaves the row
  `started` for reconciliation rather than risking a second effect.

`wakeLeads(connectionId)` therefore runs at most once per notification and exactly once when
the probe says no wake happened. Across processes a live `started` row is indistinguishable
from a crash without a lease, so ports must implement `hasCompleted` truthfully or be
idempotent; a cross-process lease remains later work. `raiseBudget` is only an
intent-recording port; this module has no wallet or money path. Ports should still use the
supplied key as their own idempotency key where the downstream system supports it.

### Recommendations and OS payloads

`recommend.ts` is deterministic and uses no clock, model or randomness. It recommends
deferring lead wakes (as `snooze`) when at least one lead depends on the connection and the
reset is sooner than the forecast projected exhaustion, recommends `switch_connection` to the
first fallback, and offers `snooze` until the reset whenever a reset is known. Equal input
returns an equal ordered list.

`payload.ts` emits only `{ title, tag }`. Titles come from a fixed kind/window template such as
`Quota 10% left`, `Quota running out` or `Balance running out`; the tag is derived from the
window enum only. The alert threshold and window family are the only fact-derived fields and
are intentional. Subject ids, remaining values, source, observation time, reset time, forecast
run ids, prompts and session content never enter the payload.

### NC1-b test evidence

```bash
nice -n 10 node --test packages/server/test/notifications/*.test.ts
```

The command runs 40 tests: 29 new NC1-b tests and the 11 existing NC1-a rule tests as the
regression envelope. `nice -n 10 npx tsc --noEmit -p packages/server` typechecks the server
source and test trees.

### Still later

Plugin/boot wiring, HTTP routes and the `packages/contract` schema, the web/desktop
notification center, real ports for R1 wakes and run pause/resume and K3 role rebinding,
run-policy automatic reactions with undo, quiet hours, OS/push delivery and the other
attention kinds remain later NC1 work. NC1 is not complete.

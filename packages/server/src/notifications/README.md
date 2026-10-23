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
compares `(created_at, id)` and therefore does not lose rows that share one millisecond; a
plain number means strictly older timestamps. `get`, `markRead`, `snooze`, `windowState` (with
its optional account) and the action paths are account-scoped; a notification id from another
account raises `NotificationStoreError` with code `account_mismatch`, and an id from another
account is not a valid pagination cursor (`notification_not_found`). `snooze` stores
milliseconds and `expireSnoozed(nowMs)` returns only rows whose deadline passed to `unread`;
`snooze` and `markRead` refuse an `acted` row with `notification_acted` so it cannot be
revived. Quota alerts offer `open`, `wake_leads`, `switch_connection`, `pause_runs`, `snooze`
and `accept_recommendation`; `exhausted` also offers `resume_runs`. Connection ids are treated
as globally unique and account-owned: v1 uses the requested `(connection_id, window)` window
key and a global notification idempotency key, so two accounts cannot reuse one connection id.
A failed open (for example a pre-existing non-database file) closes its `DatabaseSync` before
rethrowing.

`service.ts` joins the rules to the store. `ingestQuotaFact` loads the previous window state,
calls `evaluateQuota` with the caller clock and writes the evaluation and its alerts through
`recordEvaluation`. The write includes an optimistic `lastObservedAt` check; a concurrent
writer that won first raises `state_conflict`, and the service re-reads and re-evaluates (three
attempts). Re-ingesting an identical fact therefore inserts nothing.

### Typed actions and the at-most-once contract

`actions.ts` defines one typed command per ADR-0033 action and an `ActionPorts` interface with
one async method per command (`open`, `addPrompt`, `acceptRecommendation`, `chooseAction`,
`wakeLeads`, `switchConnection`, `pauseRuns`, `resumeRuns`, `snooze`, `raiseBudget`). Every
port receives an `ActionPortContext` (`accountId`, `notificationId`, `subject`, `action`,
`args`, `idempotencyKey`); `wakeLeads(connectionId, context)` also receives the connection id
as its first argument. `executeAction` validates that the notification offers the action,
reserves the idempotency key with `beginAction`, calls the matching port and stores the
terminal result with `finishAction`. A notification that is already `acted` rejects a new key,
and a `started` row for another key rejects the command as `action_in_progress`, so one
notification cannot run two actions at once. `finishAction` marks the notification `acted` on
success only for state-changing actions (`wake_leads`, `switch_connection`, `pause_runs`,
`resume_runs`, `choose_action`, `add_prompt`, `raise_budget`); `open` and
`accept_recommendation` mark it `read` and leave later actions available, and the typed
`snooze` command enters `snoozed` with its deadline. A terminal duplicate returns the stored
result without touching a port; a failed port stores only `{ "code": "port_failed" }` and
rethrows `NotificationActionError`, never the port message.

The reservation plus the process-local in-flight map makes effects at-most-once within one
process. Same-process calls with one key share a single in-flight promise, so a racing retry
cannot probe a live `started` row and call the port again. `hasCompleted` covers a process
restart:

- every port must record the `context.idempotencyKey` of each effect it applies and answer
  `hasCompleted(key)` from that durable record; a scripted constant is not a probe;
- a terminal `done` or `failed` row is immutable and is never replayed;
- a `started` row with no in-flight caller in this process is treated as a crashed attempt;
- the effect is replayed only when `ports.hasCompleted(key)` explicitly returns `false`;
- `true` means the effect already happened, so the row is completed as
  `{ "recovered": true }` without another port call;
- no probe, or a probe that throws, raises `action_outcome_unknown` and leaves the row
  `started` for reconciliation rather than risking a second effect.

`wakeLeads(connectionId, context)` therefore runs at most once per notification and exactly
once when the probe says no wake happened. Across processes a live `started` row is
indistinguishable from a crash without a lease, so ports must implement `hasCompleted`
truthfully from the keys they received or be idempotent by `context.idempotencyKey`; a
cross-process lease remains later work. `raiseBudget` is only an intent-recording port; this
module has no wallet or money path. Ports should still use the supplied key as their own
idempotency key where the downstream system supports it.

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

The command runs 48 tests: 35 NC1-b tests (29 slice tests plus 6 independent-review tests) and
the 13 existing NC1-a rule tests as the regression envelope.
`nice -n 10 npx tsc --noEmit -p packages/server` typechecks the server source and test trees.

### Still later

Plugin/boot wiring, HTTP routes and the `packages/contract` schema landed in MS2 (below). The
web/desktop notification center, real ports for R1 wakes and run pause/resume and K3 role
rebinding, run-policy automatic reactions with undo, quiet hours, OS/push delivery and the other
attention kinds remain later NC1 work. NC1 is not complete.

## NC1-c: delivery planning, quiet hours and channel settings

**Status:** implemented · **Updated:** 2026-10-23 · **Scope:** NC1-c

This section supersedes the delivery bullet in "Still later" above for planning only; the
real adapters, settings persistence and settings UI remain later work.

`delivery.ts` is a pure planner for ADR-0033 decision 8. The caller supplies the notification,
the user's settings and `now`; there is no clock, timer, I/O or process state.

- `Channel` is `'in_app' | 'os' | 'push'`.
- `planDelivery({ kind, severity, createdAt }, settings, now)` returns decisions in the
  canonical order `in_app`, `os`, `push`. `in_app` is always present and immediate at `now`;
  muting and quiet hours never remove the inbox row. A muted kind suppresses only `os` and
  `push`. Channels come from `channelsByKind[kind] ?? defaults`, de-duplicated.
- Quiet hours are local `HH:MM`; exactly `start` is quiet and exactly `end` is not. A wrapping
  range such as `22:00–07:00` spans midnight. `start === end` disables quiet hours. `os` and
  `push` inside quiet hours are deferred to the next local end, computed from
  `Intl.DateTimeFormat` parts without a dependency. Across a DST overlap the next occurrence
  is chosen; a nonexistent wall time in a spring gap resolves to the first local time after it.
  The resolved end is checked against quiet hours and advanced to the next local end while it
  is still quiet, so a DST gap or skipped day cannot return a quiet `deliverAt`, including for
  a window of 23 hours or more; the scan is bounded and throws if no non-quiet end is found.
- Fall-back repeats a local hour. With a window such as `00:30–01:30`, a notification deferred
  during the first `01:00–01:30` occurrence releases at `01:30` EDT, but the repeated
  `01:00–01:30` EST hour is quiet again, so one deferred during the second occurrence releases
  at `01:30` EST. Equal local wall times therefore do not imply equal quiet state.
- `critical` bypasses quiet hours only when `criticalBypassesQuietHours` is true, and only for
  `os`/`push`; `in_app` stays `immediate`. Outside quiet hours a critical notification is also
  `immediate`, not `critical_bypass`.
- `createdAt` is validated as part of the notification record; decisions are anchored to
  `now`, so equal input returns an equal array. This module does not compose or alter
  `payload.ts`; OS payload content remains NC1-b's content-free `osPayload`.
- `validateDeliverySettings(unknown)` throws `TypeError` with a path for a malformed object,
  an invalid IANA zone (including `+03:00`, `-03:00` and the U+2212 `−03:00` spelling), a
  non-`HH:MM` clock, an unknown channel or a non-boolean bypass. `timeZone` and `defaults` are
  required; missing `channelsByKind`, `quietHours`, `mutedKinds` and
  `criticalBypassesQuietHours` take `{}`, `null`, `[]` and `false`. An explicit `undefined`
  value inside `channelsByKind` is dropped, so that kind uses `defaults`.

## NC1-d: vendor quota and balance fact producers

**Status:** implemented · **Updated:** 2026-10-23 · **Scope:** NC1-d

`producers.ts` maps K5 quota observations and K3 connection balances into the NC1-a
`QuotaFact` vocabulary. Both entry points are pure and return `{ facts, skipped }` instead
of a bare fact or `null`: a reported value that cannot be represented is never silently
dropped. A skip is `{ window, reason }`, where `window` is the reported name and is `null`
for a balance. The reasons are:

- `unknown_window_kind` — the window name does not identify an NC1-a window.
- `missing_observed_at` — a balance has no observation time.
- `unknown_confidence` — a balance has `unknown` confidence.

### Window mapping

`five_hour` and `seven_day` map to the facts of the same name. Codex
`<id>.primary` / `<id>.secondary` names are relative: the period is reported separately by
the vendor. The current `QuotaWindow` contract carries only `name`, `usedPercent` and
`resetsAt`, and K5's `codexRateLimits` drops the raw `windowDurationMins`, so the producer
does not guess those names into `five_hour` or `seven_day`. They are skipped with
`unknown_window_kind`; the same applies to every other unrecognised name. Supporting them
requires carrying the reported window length through K5 first.

### Percent, provenance and unknown values

`remainingPercent` is `100 - usedPercent`, clamped to `[0, 100]`. A provider that reports
`usedPercent` above 100 (an overrun) therefore produces `0`, not a negative percentage; an
unused window produces `100`. A `null` `usedPercent` produces a `null` `remainingPercent`,
never `0` or `100`. Quota windows carry no absolute amount, so `remainingAbsolute` is
`null` and values are not rounded.

`source`, `observedAt` and `resetsAt` are copied from the observation (a balance always has
`resetsAt: null`). A `high` vendor confidence becomes `observed`; `medium` and `low` become
`estimated`.

### Balances

A balance becomes one `window: 'balance'` fact. `remainingAbsolute` is the provider's
decimal `amount` kept as-is: `ConnectionBalance` carries a currency, `QuotaFact` does not,
and this producer neither converts minor units nor invents a currency.
`remainingPercent` is `amount / initialAmount * 100` (clamped to `[0, 100]`) only when
`initialAmount` is a positive finite number; otherwise it stays `null`. Balance facts
always have `resetsAt: null`.

A `scope: 'key_allowance'` balance is not an account balance, so `#key_allowance` is
appended to `source` (once; an already-suffixed source is unchanged). `account_balance` or
an absent scope adds nothing. A balance with a missing `observedAt`, or with confidence
`unknown`, produces no fact and one skip reason; when both are missing, the observation
time is reported first. A known-provenance balance whose amount is `null` remains a fact
with unknown values.

Both functions parse their input with the existing `quotaObservationSchema` or
`connectionBalanceSchema`; malformed values throw instead of becoming facts.

## Test evidence (NC1-a to NC1-d)

```bash
nice -n 10 node --test packages/server/test/notifications/*.test.ts
nice -n 10 npx tsc --noEmit -p packages/server
```

On integrated main the command runs 86 tests: 48 NC1-a/b, 25 NC1-c delivery and 13 NC1-d
producer tests. Each slice's hand-off records its own new / regression split.

## Still later

- Settings persistence and the notification-settings UI; per-platform OS adapters; Web Push.
- Delivery planning has no route or contract yet (the inbox routes landed in MS2, below).
- Wiring the producers to K5 quota events and K3 balance probe results; Codex window-length
  evidence; local metering for providers without quota APIs; an automatic Claude producer.

NC1 is not complete.

## MS2: plugin, REST routes and wire contract

**Status:** implemented, locally validated · **Updated:** 2026-10-23 · **Scope:** MS2 backend wiring

`plugin.ts` provides `guanxi.notifications` (T0, service `notifications.inbox`). It opens
`<dataDir>/notifications.sqlite` on load, registers one close effect and starts no timer, interval
or ingestion. `start()` loads it with the other T0 plugins and mounts `routes.ts` at
`/api/notifications`. `inbox.ts` (`NotificationInbox`) is the facade routes and kernel callers
share; `inbox.ingest` is the NC1-b `NotificationService`, so a quota producer feeds facts through
the kernel service, never over HTTP. `wire.ts` maps stored rows to `@guanxi/contract`
(`packages/contract/src/notifications.ts`) and drops the account id, idempotency key and window
instance key.

| Method and path | Purpose |
| --- | --- |
| `GET /api/notifications?state=&limit=&before=` | Newest first. `state` is a comma list, `limit` 1..200 (default 50), `before` a `nextCursor`. |
| `GET /api/notifications/actions` | Per action: `available`, `not_configured` or `not_exposed`. |
| `GET /api/notifications/:id` | One notification. |
| `POST /api/notifications/:id/read` | Body `{}`. Idempotent; an acted row stays acted. |
| `POST /api/notifications/:id/snooze` | `{ untilMs }`, strictly in the future. |
| `POST /api/notifications/:id/actions` | `{ action, args }` with a required `Idempotency-Key` header. |

Boundary rules, each pinned by a test in `packages/server/test/ms2-*.test.ts`:

- **Content-free arguments.** The executable actions are `open`, `accept_recommendation`,
  `wake_leads`, `switch_connection`, `pause_runs`, `resume_runs` and `snooze`. Arguments are
  identifiers (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`), small enums and integers; unknown keys are
  refused. `add_prompt`, `choose_action` and `raise_budget` carry prompts, free text or money
  intent, so they are `not_exposed` on the wire and `inbox.execute` refuses them even when a host
  port exists.
- **Honest ports.** `open` and `snooze` are built in: their only effect is the inbox state the
  store commits. Every other action answers `501 not_configured` before any reservation row is
  written, so the notification stays actionable and nothing is faked. Kernel-level embedders may
  pass `ports` to the plugin and those actions then become `available`; `start()` exposes none,
  so in the shipped node every action except `open` and `snooze` answers 501 until a later slice
  supplies its port.
- **`wake_leads` is not wired.** R1 `RunStore.signal(attempt, key, 'quota')` needs a fenced child
  `Attempt` and wakes that child's parent. The run store keeps no index from a connection to the
  runs that depend on it, so no exact, safe seam exists for ADR-0033's "wake the leads that depend
  on this connection". It stays `not_configured` until a run-to-connection dependency exists.
  `switch_connection`, `pause_runs` and `resume_runs` wait for K3 role rebinding and run policy.
- **Crash recovery.** Built-in ports have no effect outside the store, so a key left `started` is
  replayed. Any other action needs the host's `hasCompleted` probe; without one the answer is
  `409 action_outcome_unknown` and nothing is replayed.
- **Snooze without a timer.** `list`, `get`, `read` and `actions` first move snoozed rows whose
  deadline passed back to `unread`. A read takes the write lock only when a row is actually due.
  Replaying a finished `snooze` key answers `duplicate` even after its time has passed.
- **Results are flat.** A port result reaches the wire as flat scalars only (strings cut at 200
  characters); nested values are dropped.

Every failure is `{ "code": ... }` only: `validation_failed` 400, `json_required` 415,
`origin_denied` and `loopback_only` 403, `body_too_large` 413, `idempotency_key_required` 400,
`notification_not_found` 404 (also for another account's id), `action_not_offered`,
`notification_acted`, `action_in_progress`, `idempotency_conflict` and `action_outcome_unknown`
409, `invalid_snooze_time` 422, `port_failed` 502, `not_configured` 501,
`notifications_unavailable` 503, `internal_error` 500. No message, id or argument is echoed.
These routes never emit another body shape; the catch-all for unknown `/api/*` paths in `start()`
keeps its older `{ code, message, details }` shape. The shared guard (`http/local-guard.ts`) requires a loopback peer, a same-origin or configured dev
`Origin`, `application/json` on mutations and a 2 MiB body budget.

`accountId` is the fixed local owner (`'local'`) and is passed explicitly to every store call, so
a U3 `can()` check is one call per handler. U3 is not wired.

Evidence: `ms2-notifications-routes.test.ts` (24 tests), the notification parts of
`ms2-plugins.test.ts`, `ms2-contract.test.ts` and `ms2-guard.test.ts`.

Still later: OS and push delivery beyond NC1-f (the web notification center landed in NC1-ui, see `docs/design/LAYOUT_AND_SCREENS.md` §8), quota producers calling `ingest`,
the `wake_leads`, `switch_connection`, `pause_runs` and `resume_runs` ports, run-policy reactions.

## NC1-e: OS notification adapters

**Status:** implemented · **Updated:** 2026-10-23 · **Scope:** NC1-e

This section supersedes the per-platform OS adapter item in "Still later" for macOS and Linux;
Windows toast and Web Push remain later work.

`os-adapter.ts` delivers the content-free NC1-b `osPayload` through a desktop notification.
`createOsNotifier({ platform, runner, appName, resolveBinary })` returns an `OsNotifier` with
`notify({ title, tag })`, or `{ unavailable }`. Results are
`{ delivered: true, code: 'delivered' }`, `{ delivered: false, code: 'payload_invalid' }` or
`{ delivered: false, code: 'os_notify_failed' }`. The tag is never displayed or passed to a
process; callers use it for de-duplication.

### Payload boundary

Validation accepts exactly the two own keys `title` and `tag`; any other own key (enumerable,
non-enumerable or symbol) is refused before a value is read, while inherited properties are
ignored and never read. `title` is trimmed, must be 1–120 characters after trimming and may not
contain C0/C1 controls or U+2028/U+2029; `tag` must be a string with the same control-character
restriction and has no display-length cap. A malformed payload never reaches a runner, and no
payload text is logged.

### Platform commands

- macOS: `/usr/bin/osascript` receives three constant `-e` lines (`on run argv`,
  `display notification (item 1 of argv) with title (item 2 of argv)`, `end run`) followed by
  `--`, the payload title and the app name. The message is the payload title, the notification
  title is the app name, and no payload text is interpolated into AppleScript.
- Linux: `resolveBinary('notify-send')` must return a non-empty absolute path, otherwise the
  notifier is `{ unavailable: 'notify_send_missing' }` (null, empty or a throwing lookup) or
  `{ unavailable: 'notify_send_path_invalid' }` (relative or NUL-containing). The command is
  `notify-send --app-name <appName> -- <title>`; there is no body.
- Windows and every other platform return `{ unavailable: 'platform_unsupported' }`; Windows
  toast is later work. An empty, control-bearing or overlong app name returns
  `{ unavailable: 'app_name_invalid' }`.

### Runner

The default runner is `execFile` with no shell, a 64 KiB output buffer and the adapter's 5 s
timeout, enforced with SIGKILL so a child that ignores SIGTERM cannot outlive the limit and
later report success. Success requires exit code 0 with no signal; a non-zero exit, any signal,
a timeout, a spawn error or a thrown runner maps to `os_notify_failed`, and the runner's
message is never returned or logged. Tests inject a fake runner except for one darwin-only
`/usr/bin/true` smoke that proves the default runner can execute an absolute binary without
opening a notification.

### NC1-e test evidence

```bash
nice -n 10 node --test packages/server/test/notifications/*.test.ts
nice -n 10 npx tsc --noEmit -p packages/server
```

The command runs 99 tests: 13 NC1-e tests and the 86 NC1-a…d tests as the regression envelope.
`tsc` reports no diagnostics.

## NC1-f: delivery dispatch and opt-in OS delivery at boot

**Status:** implemented · **Updated:** 2026-10-23 · **Scope:** NC1-f

This section supersedes the NC1-e plug-in wiring residual for the OS channel. Settings
persistence and the settings UI, Web Push, Windows toast and the host scheduler remain later
work.

### Opt-in configuration

`NotificationsConfig.delivery` is optional. When it is absent, ingestion behaves as before: no
`notification_deliveries` rows and no adapter call. When it is present, `settings(accountId)`
supplies the NC1-c `DeliverySettings`; `os` is an `OsNotifier` or `{ unavailable }`.

`start()` exposes `StartOptions.notificationDelivery`. With `{ os: true }` it builds
`createOsNotifier` for the current platform with the central brand product name; without the
option the plugin loads with no delivery. The boot default settings use the system IANA zone,
`['in_app', 'os']`, no quiet hours, no critical bypass and no muted kinds. `runner`, `platform`
and `resolveBinary` are optional host/test seams; production uses
`createDefaultCommandRunner` and a PATH lookup.

### Migration and dispatch

v2 creates `notification_deliveries(notification_id, channel, deliver_at, status, code,
attempted_at)` with primary key `(notification_id, channel)`, a status check
`pending|delivered|failed|unavailable` and a `(status, deliver_at)` index. v1 is untouched.

After `inbox.ingest.ingestQuotaFact` commits, `dispatcher.ts` plans each returned inserted row
with the account settings and writes one row per planned channel in a separate transaction.
`in_app` is recorded `delivered` with code `in_app` (the notification row is the delivery).
`push` is recorded `unavailable` with code `push_not_configured`. `os` is `pending`, or
`unavailable` with the adapter's reason when no adapter exists. A due `os` row is attempted
immediately with `osPayload(notification)`: `delivered` or `failed` with the adapter's code; a
thrown adapter becomes `failed`/`os_notify_failed`. Terminal rows are never retried.

The primary key makes planning idempotent; the terminal update is guarded by
`WHERE status='pending'`, and due passes are serialised in process. A second dispatch,
`deliverDue` or re-ingest therefore cannot call the adapter twice for one row in normal
operation. Deferred quiet-hours rows keep `attempted_at` null until the host calls
`inbox.deliverDue(now)`. That call delivers every `pending` row with `deliver_at <= now`, is
idempotent and returns `{ delivered, failed, unavailable, pending }`. The plugin starts no
timer; the host owns the scheduler that calls `deliverDue`.

No payload text or adapter message is logged or stored: rows keep a status and a code. The
per-row primary key and the guarded terminal transition make repeated planning safe, but a
crash between the notifier returning and the terminal update can still repeat one OS
notification; a delivery claim/lease is later work.

### NC1-f test evidence

```bash
nice -n 10 node --test packages/server/test/notifications/*.test.ts packages/server/test/ms2-*.test.ts
nice -n 10 npx tsc --noEmit -p packages/server
npx markdownlint-cli2 packages/server/src/notifications/README.md docs/plans/lanes/NC1-f.handoff.md
```

The required command runs 186 tests: 11 new dispatcher tests, the 99 existing notification
tests and the 76 MS2 tests. `tsc` reports no diagnostics.

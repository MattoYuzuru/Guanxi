# NC1-f handoff — delivery dispatch and opt-in OS delivery

**Status:** bounded slice implemented and locally validated; verification below.
**Date:** 2026-10-23 · **Branch:** `codex/nc1f-delivery-wiring` · **Base:** `23e91ee4` · NC1 remains **in progress**; no status file was edited.

## What exists

- `dispatcher.ts` — `DeliveryDispatcher` plans each freshly inserted notification with the
  account's `DeliverySettings` and records one `notification_deliveries` row per planned
  channel. `in_app` is immediately `delivered` (code `in_app`); `push` is `unavailable`
  (`push_not_configured`); a missing/unavailable OS adapter is `unavailable` with its reason;
  an OS row is `pending`. Due OS rows are attempted with `osPayload(notification)`.
- `deliverDue(now)` (also `inbox.deliverDue(now)`) delivers every pending row with
  `deliver_at <= now`, is idempotent, and returns `{ delivered, failed, unavailable, pending }`.
  No timer exists in the plugin; the host owns the scheduler.
- Exactly-once in one process: the `(notification_id, channel)` primary key and the guarded
  `status='pending'` terminal update make planning and delivery idempotent; due passes are
  serialised and terminal rows are never retried.
- `store.ts` — append-only migration v2 creates `notification_deliveries(notification_id,
  channel, deliver_at, status CHECK IN (...), code, attempted_at)` and the due index; v1 unchanged.
- `plugin.ts` / `inbox.ts` — optional `NotificationsConfig.delivery = { settings, os? }`;
  absent means no rows/calls; ingestion dispatches only newly inserted rows after commit.
- `index.ts` — `StartOptions.notificationDelivery` is off by default; `{ os: true }` builds
  `createOsNotifier` with `PRODUCT_NAME` and boot defaults (system zone, `['in_app','os']`);
  `runner`, `platform`, `resolveBinary` are host/test seams.
- `dispatcher.test.ts` — 11 tests: opt-out, one OS delivery per insert, re-ingest dedupe,
  muting, push not-configured, quiet-hours deferral/release, critical bypass, failure/throw
  terminal rows, unavailable adapter, v1→v2 preservation and boot injection.
- `README.md` — appended NC1-f section. Shared regression edits: the two existing migration
  count assertions now expect v2.

## Commands and evidence

```bash
nice -n 10 node --test packages/server/test/notifications/*.test.ts packages/server/test/ms2-*.test.ts
nice -n 10 npx tsc --noEmit -p packages/server
npx markdownlint-cli2 packages/server/src/notifications/README.md docs/plans/lanes/NC1-f.handoff.md
```

- Required command: `tests 186`, `pass 186`, `fail 0`, `skipped 0`; notification suite 110 (11 new + 99 regression); `tsc` and markdownlint clean.

## New / regression envelope

- **New:** the 10 dispatcher tests above.
- **Regression:** all 99 NC1-a…e notification tests, all 76 MS2 route/plugin/guard/contract
  tests and the full server `tsc` source+test tree. Existing assertions changed only where the
  migration version count now includes append-only v2.

## Verification

The required suites pass. A mutation check removed the due-pass serialisation and the
concurrent assertions failed, then the file was restored. No independent reviewer completed.

## Residuals (later NC1 work)

- Settings persistence and the notification-settings UI; boot settings are the fixed defaults.
- Web Push and Windows toast; push rows are honestly `unavailable` for now.
- Host scheduler calling `deliverDue`; nothing in the plugin wakes it.
- Cross-process claim/lease: a crash after the notifier returns and before the guarded terminal
  update can repeat one OS notification. The row itself remains exactly-once.

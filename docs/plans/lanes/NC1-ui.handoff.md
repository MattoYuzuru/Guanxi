# NC1 notification center UI hand-off

**Status:** implemented, locally validated; independently reviewed, findings fixed. Not merged to `main`, never pushed.
**Date:** 2026-10-23 · **Checkout:** `/Users/yuzuru/Projects/Guanxi-lanes/nc1ui`, branch
`codex/nc1-notification-center-ui` · **Base:** `97fdc965`, then `main` `64d02458` merged without conflicts.
Runtime: local Mac, Node 26.9.0, ports 5218/4418, checkout `.lane-data`, shared `agent-dev` heavy lock.

## What exists

A notification center in the U1 shell, all in `packages/web/src/features/notifications/`, no server change and no new
route or contract field:

- `inbox-store.ts`: one framework-free store shared by the bell and the page, so the badge and the Unread list are derived
  from the same rows. Newest `updatedAt` wins per row, loaded older pages are kept across head re-reads, one coalesced read
  per list (plus one re-read when a change lands during a read), a 15 s read timeout that reports an unreachable node, and
  the idempotency-intent map.
- `NotificationBell.tsx`: the status strip's Inbox item (link to `/notifications`, unread count, "at least N" above the
  node's 200-row page cap, unknown never 0, last-known marker, a polite live region that announces arrivals only).
- `NotificationsPage.tsx`, `NotificationRow.tsx`, `model.ts`: the center at `/notifications` (also a palette command):
  Unread, All, Read, Snoozed and Acted-on filters; severity as text plus a distinct glyph; facts with source, observation
  time and confidence; Mark read; snooze (presets, until the window resets, or a chosen time); typed actions;
  loading skeleton, empty (per filter), error, offline (last known data with its age) and paging ("Load older").
- Actions: a button is enabled only when `GET /api/notifications/actions` says `available` and the row allows it;
  `not_configured` and `not_exposed` actions are shown disabled with the reason wired by `aria-describedby`. The
  `Idempotency-Key` belongs to the intent and is reused only when the outcome was unknown (lost answer, 500, 503, 409
  `action_in_progress` or `action_outcome_unknown`, unparseable answer); after 501, 502 `port_failed`, a stored `failed`
  result and every other definite answer a new attempt is a new intent. Switch connection offers the other connections.
- `messages.ts`: 173 English keys and a curated Russian record of the same keys (plural forms from `Intl.PluralRules`).
- Shell edits (shared): `ShellStatus.tsx` takes an optional `inbox` node, `MountedShell.tsx` mounts
  `NotificationsProvider` and the bell, `useShellController.ts` adds the palette command, `lib/router.tsx` and `App.tsx` add
  the route, `lib/locale.ts` registers the messages, `docs/design/LAYOUT_AND_SCREENS.md` section 8, the MS2 line in
  `packages/server/src/notifications/README.md`, `packages/ui/catalog/manifest.json` (regenerated: usage counts only).

## Components and catalog

No `@guanxi/ui` component was added or changed, so nothing is `draft` and no status changed. The feature uses `Button`,
`Input`, `EmptyState` and `ErrorState` (all `review`; G11 warns, listed here) and the legacy `Select` for the connection
choice. Draft primitives (Badge, Tabs, Popover, StatusPill, Toast) were not used. A catalog `NotificationRow` pattern
(COMPONENTS_AND_CATALOG section 1) is not built: it would start `draft` and G11 blocks draft components in product code.
No literal colours, no new lint or CSS suppressions (suppression file unchanged); the only `✖ 4 warnings` are inherited.

## Gates (final head, after merging `main` `64d02458`)

| Gate | Result | Receipt |
| --- | --- | --- |
| typecheck, lint (0 errors, 4 inherited warnings), lint:md (0 errors, 270 files), check:licenses (675, 0 not allowed), ui:check | pass | direct runs |
| `npm test` | pass: web 553 in 54 files, ui 49 in 7 files, other suites unchanged | `check-_xxzn_7h` |
| `npm run test:web:browser` | pass 215/215, 3.9 min | `check-u7j03yva` |
| `npm run ui:check:browser` | pass (G13, G14, G15-clipping, G16, G17 seeds) | `check-6hp47bgy` |
| `npm run build` | pass | `check-1cgw7suy` |

The `agent-dev` log masks the digit 1 inside numbers (`2[REDACTED]5`); counts are reconstructed. Receipts report
`source_verifiable=false` because of the inherited `.claude/skills/guanxi-ui` symlink: direct observations, not certificates.
Targeted specs during development ran directly on the lane ports (small, outside the lock); every gate above ran through it.

## Tests: new / regression envelope

- **New:** 58 component cases (`test/component/notifications.test.tsx`), 19 store cases (`test/unit/inbox-store.test.ts`),
  1 case in `shell-status.test.tsx`, 21 browser cases (`test/browser/notifications.spec.ts`: bell to center, palette,
  keyboard path with exact tab order and focus ring, live region, disabled actions with reasons, lost-answer retry with one
  key and one effect, Open navigation, offline both ways, reduced motion, and axe at 320 px with 200% text in light, dark,
  English and Russian for the populated list, an open snooze form, empty, error and offline states, plus desktop).
  Shared fixtures: `test/fixtures/notifications-server.ts` (an in-memory MS2 node), `test/helpers/notifications-fetch.ts`,
  `test/browser/fixtures/notifications-api.ts`.
- **Regression envelope:** web vitest 475 in 52 files and browser 194 (the prior U1 baselines), all unchanged and green.
  One envelope edit: `localization.spec.ts` now lets the shell's `GET /api/notifications` pass its request guard (an
  empty list answer); every other request is still forbidden there.
- Mutation checks: six mutations (always dropping the key, newest-fetched wins, badge off by one, enabling not_configured
  actions, one shape for all severities, no busy guard) each failed at least one assertion; reverted.

## Independent verification

Two read-only reviewers (`frontend-agent:accessibility-reviewer`, `sde-agent:implementation-reviewer`) read the diff at
`7d54bbc7`: no P1. Fixed in `ae42006a`: offline derived from the node's answer not `navigator.onLine` (the node is on
loopback); a retry in flight no longer clears the shown failure (no banner flicker or re-announcement); lists the user
returns to, and every loaded list after a change, are re-read, including a read that was in flight when the change landed;
a 15 s timeout so a hung read cannot freeze refresh and mutations (mutations no longer await the re-read); a head read
that moved the cursor drops a stale older page; arrivals count only rows newer than anything held or back from snooze;
Mark read on an acted row (node answers 200 unchanged) is a failure not "read"; re-read after a refusal that says the row
changed; `not_exposed` for any action outside the wire set; client-side validation errors keep no key; a throwing key
generator cannot leave a row pending; availability gets an observation time and is re-read with the page and after a 501;
row titles are h2; background polls no longer swap the Refresh label. Test-fidelity fixes: the fake node now answers read
on an acted row with a 200 no-op and validates `limit` and `state`; two weak assertions were strengthened, one filler removed.

## Residual risk and deferred

- The shared `trimZeros` defect I found was fixed on `main` (`bbcb6baf`); the center keeps its own `percentText`, now
  `Intl.NumberFormat` with `style: 'percent'`.
- **Server-side gaps, documented not changed:** no unread-count endpoint (the badge is the loaded Unread rows, "at least
  200" above the cap); no push or stream (a 30 s poll, plus focus, online and offline events, while the document is
  visible); no filter by kind, project or "waiting for you"; no mark-all-read; no recommendation list on the wire, so
  Accept recommendation sends `{}`; the shipped node answers 501 `not_configured` for every action except Open and Snooze
  (real ports for `wake_leads`, `pause_runs`, `resume_runs`, `switch_connection`, R1 wakes and K3 rebinding remain later).
- **Not built:** toasts for `input_required` and the 10% and 5% thresholds, phone push, channel and quiet-hours settings UI
  (NC1-c planner has no settings route), a floating panel, the glossary editor and work board lanes.
- **UI limits:** a failed row loses its Retry button if the row remounts (the action button reuses the stored key
  anyway); a row entering a filter older than a loaded page boundary shows on the next head read; after a successful snooze
  focus lands on the row, not the Snooze button; Chromium only, no physical assistive technology; the in-memory node proves
  the UI against the contract, the real node's behaviour is proven by the server tests; no real ports exist to exercise
  `wake_leads` end to end.
- Never pushed; no owner approval; NC1 and U1 exits remain open.

## Next

Integrator merges, runs the gates on `main`, folds this file into `PHASE_STATUS.md`, and decides on the `format.ts` fix.
Follow-ups: real action ports (R1 and K3 seams), an unread-count or event stream on the node, notification settings UI,
toasts and the glossary editor and work board lanes.

## Fix-forward round (Opus cross-check, after the merge as `e2b3a50c`)

Merged `main` (`bbcb6baf` included) first; separate commits `c2ed2d5b`, `c67fc8cd`, `871734fb`, each with tests written
failing first (10 of the new cases failed before the fix; the unmount cases already held and stay as guards).

- **P2-1 polling:** `NotificationsProvider` now chains timeouts: base 30 s, doubling per consecutive failed read up to
  `NOTIFICATIONS_POLL_MAX_MS` (300 s, prop `maxPollMs`), reset on a successful read, ticks while hidden read nothing
  (`visibilitychange` to visible reads at once), one timer at most, cleared on unmount, and an in-flight read after unmount
  schedules nothing. Fake-timer tests: backoff schedule and cap, reset, hidden, unmount, unmount during a read.
- **P2-2 dead node behind a proxy:** a 5xx whose body has no parseable `{ code }` is classified offline. Deviation from the
  message: 502 or 503 with a parseable code stay server answers (`notifications_unavailable` and `port_failed` are the node
  talking, and a test pins both); only an unparseable 5xx, which is what a dead upstream produces, is offline.
- **P3-1** `dispose` sets a flag; follow-up reads and re-reads after a mutation start nothing after it; `resume()` for a
  remount. **P3-2** the action POST has a 30 s timeout (`ACTION_TIMEOUT_MS`) reported as `timeout`, outcome unknown, key
  kept; `api.execute` takes an optional `AbortSignal`. **P3-3** kept keys of a notification are dropped once it reads back
  `acted`. **P3-4** percent through `Intl.NumberFormat`; the joined strings in the bell, the page header line and the row
  moved into single locale templates (`notifications.bell.arrival`, `bell.staleSummary`, `provenance`,
  `provenance.actions`, `failed.at`), guarded by a source scan test. **P3-5** zero loaded unread with more on the node
  reads "more unread on the node".
- Gates after the round: typecheck, lint (inherited 4 warnings), lint:md, ui:check pass; targeted vitest 144 in 12 files
  (web unit and notification component files); heavy `test:web:browser` pass 215/215 (`check-51t5k9ub`, head `871734fb`).

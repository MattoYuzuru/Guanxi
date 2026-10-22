# NC1-c handoff — delivery channels, quiet hours and critical bypass

**Status:** bounded slice implemented and locally validated; independent review below.
**Date:** 2026-10-23 · **Branch:** `codex/nc1c-delivery-rules` · **Base:** `38ff464c` · NC1 remains **in progress**; no status file was edited.

## What exists

- `packages/server/src/notifications/delivery.ts` — pure `planDelivery(notification,
  settings, now)` and `validateDeliverySettings(unknown)` for ADR-0033 decision 8, with
  `Channel`, `DeliverySettings`, `DeliveryDecision` and `DeliveryReason` types.
- Rules: `in_app` is always immediate at `now`; muted kinds keep only `in_app`; channels are
  `channelsByKind[kind] ?? defaults`, de-duplicated in `in_app, os, push` order; quiet hours
  defer `os`/`push` to the next local end; exactly `start` is quiet and exactly `end` is not;
  `start === end` disables quiet hours; `critical` bypasses only with opt-in and inside quiet
  hours (reason `critical_bypass`; `in_app` stays `immediate`).
- DST/zone handling uses `Intl.DateTimeFormat` parts with no dependency: overlaps pick the next
  occurrence, spring-forward gaps resolve at the transition instant. `createdAt` is validated
  but decisions are anchored to `now`; no `Date.now()`, I/O, timer or global state.
- `packages/server/test/notifications/delivery.test.ts` — 22 new tests; `README.md` has an
  appended NC1-c section.

## Evidence

```bash
nice -n 10 node --test packages/server/test/notifications/*.test.ts
```

```text
ℹ tests 70
ℹ pass 70
ℹ fail 0
```

`nice -n 10 npx tsc --noEmit -p packages/server` — exit 0, no diagnostics.
`npx markdownlint-cli2 packages/server/src/notifications/README.md docs/plans/lanes/NC1-c.handoff.md`
— `Summary: 0 error(s)`.

### New / regression envelope

- **New:** 22 tests in `delivery.test.ts`: in-app immediacy; muting; overrides/defaults and
  de-duplication; prototype-name lookup; createdAt anchoring; non-wrapping and wrapping boundaries; `start === end`; Moscow deferral; New
  York spring/fall DST (dates confirmed with Intl, expected end found by an independent scan);
  spring-gap and overlap resolution; critical bypass opt-in/severity/outside-hours; validation
  paths; malformed inputs; determinism/no mutation/no wall clock.
- **Regression envelope:** all 48 existing NC1-a/b notification tests in the same run; `tsc`
  over the whole server source and test tree; markdownlint on the two owned Markdown files.
  Per lane rules, `npm test`, browser tests, builds and servers were not run.

## Independent verification

A separate read-only reviewer found one P2 (prototype-chain fallback for `Object.prototype` kind names), fixed with `Object.hasOwn` and a regression test; it confirmed the DST gap/overlap policy and found no other blocking issue. It also noted two P3s (createdAt anchoring not asserted, offset-style zones accepted), both now covered.

## Residuals (later NC1 work)

- Settings persistence and the notification-settings UI; no storage or route in this slice.
- Actual per-platform OS notification adapters; `delivery.ts` only plans.
- Web Push registration/delivery; no service worker or push subscription.
- Plugin/boot wiring, HTTP routes and `packages/contract` schemas for delivery settings.

NC1 stays **in progress**; delivery adapters, settings persistence/UI and plugin wiring remain unfinished. `PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` were not edited.

## Independent review fixes

A second independent review found no P1/P2 and three P3s. Each code fix is a separate commit
with a failing-first regression test; the README update is a separate docs commit.

- `7a3a0dec` — a deferred end could resolve into a DST gap or a skipped local day and land on a
  transition instant that was quiet again. `nextQuietEnd` now keeps advancing (bounded to 8
  advances, then throws) until the candidate is after `now` and outside quiet hours. Tests cover
  Europe/London `02:00–01:30` across the 2026-03-29 gap and Pacific/Apia's skipped 2011-12-30;
  each asserts the result is not quiet and equals an independent minute-scan's first non-quiet
  instant.
- `3c602d7d` — Node's `Intl` accepts the U+2212 spelling `−03:00` as a zone. Validation now
  rejects offset-shaped input and `resolvedOptions().timeZone`; the unknown-zone test includes
  the Unicode-minus form.
- `451e496c` — `channelsByKind: { threshold: undefined }` was valid per the TypeScript type but
  the validator rejected it. The validator now drops undefined values, so planning uses
  `defaults`; the test covers both validation and planning.
- README documents fall-back (a `00:30–01:30` window is quiet again during the repeated hour)
  and the ≥23 h window behaviour.

Final evidence: the notification suite runs 73 tests, all passing; `tsc --noEmit` exits 0;
markdownlint reports 0 errors on the README and this hand-off.

# NC1-d handoff — quota fact producers

**Status:** bounded slice implemented and locally validated; NC1 remains **in progress**.
**Date:** 2026-10-23 · **Branch:** `codex/nc1d-quota-producers` · **Base:** `4b0cc079`

## What exists

- `producers.ts` — pure `factsFromQuotaObservation` and `factFromBalance`, both returning
  `{ facts, skipped }`. Maps Claude `five_hour`/`seven_day`; skips unrecognised windows
  (including Codex `primary`/`secondary`, because `QuotaWindow` carries no reported length)
  with `unknown_window_kind`; clamps `100 - usedPercent`; keeps null unknown; maps high
  confidence to `observed`, medium/low to `estimated`.
- Balances — `window: 'balance'`; `remainingAbsolute` is the provider's decimal amount with
  no currency invention; `remainingPercent` only from a positive finite `initialAmount`;
  `resetsAt: null`; `#key_allowance` source suffix. Missing `observedAt` or `unknown`
  confidence yields no fact with `missing_observed_at` / `unknown_confidence`.
- `producers.test.ts` — 13 tests including the `evaluateQuota` 20% threshold end-to-end.
- `README.md` — appended NC1-d mapping, provenance, balance and test evidence.

## Commands and evidence

```bash
nice -n 10 node --test packages/server/test/notifications/*.test.ts
```

`tests 61`, `pass 61`, `fail 0`, `skipped 0` — **13 new / 48 regression**.

```bash
nice -n 10 npx tsc --noEmit -p packages/server
npx markdownlint-cli2 packages/server/src/notifications/README.md docs/plans/lanes/NC1-d.handoff.md
```

tsc exit 0, no diagnostics; markdownlint 0 errors.

## Independent verification

A separate read-only reviewer found one defect: inherited names such as `toString` were not
skipped by an object-literal lookup. The map lookup now uses `Map.get`; `__proto__` and
`toString` are regression-tested. No blocking findings remain.

## Residuals (later NC1/K5 slices)

- Wire producers to K5 quota events and K3 balance probe results in the plugin.
- Carry Codex `windowDurationMins` through K5 as evidence, then map `primary`/`secondary`.
- Local metering marked `estimated` where no quota API exists.
- An automatic Claude producer (owner-installed statusline path), not just ingestion.

## Independent review fixes (Opus, 2026-10-23)

No P1/P2. Integrator fixed P3s: `remainingAbsolute` comment now says balances keep the provider's
decimal amount; scope and currency travel in `source` (`#account_balance#USD`,
`#key_allowance#USD`, `#scope_unknown#currency_unknown` for legacy rows), so a CNY balance is
never shown as USD. Tests updated and extended.

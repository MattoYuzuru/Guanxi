# C1-a / C4-a handoff — browser origin policy and site grants

**Status:** implemented pure core, locally validated; C1 and C4 remain in progress.
**Date:** 2026-10-22 · **Branch:** `codex/c1a-browser-policy` · **Base:** `4b0cc079` · standalone clone; no push, no other repository file changed.

## What exists

- `packages/server/src/browser/types.ts` — `RunBrowserPolicy`, `BrowserAction` and decision types. Origins are canonical `scheme://host[:port]` values; only `addReadable` can propose a policy mutation, and it never adds a writable origin.
- `packages/server/src/browser/origin-policy.ts` — pure `normalizeOrigin` and `decide`.
  Normalization lowercases, converts IDN to punycode through URL, removes trailing dots, drops
  default ports and throws `TypeError` for non-http(s). Implementation covers navigate rules
  1–4, Read-only/full interaction rules and the always-refused schemes. The clean-link and
  model-URL data heuristics are documented exactly in the file and README.
- `packages/server/src/browser/site-grants.ts` — `SiteGrantStore` over
  `<dataDir>/browser.sqlite`: WAL, foreign keys, mode 0600, `c1_migrations` v1 and the
  `site_grants` + `site_contexts` schema. UI-only grants derive account/creator from the
  principal; wildcard and secret-shaped fields are refused; domains normalize to the
  registrable host with a documented PSL approximation; `revoke` returns exactly the open
  contexts; `grantsFor` scopes by account/project/role and hides expired/revoked rows;
  `openContext`, `closeContext` and `touch` are implemented.
- `packages/server/test/browser/origin-policy.test.ts` and `site-grants.test.ts` — 30 new
  cases: 17 origin-policy and 13 site-grant.
- `packages/server/src/browser/README.md` — boundary, exact heuristics, store contract, error
  codes, commands and residuals.
- `docs/plans/lanes/C1-a.handoff.md` — this file. No Chromium, `playwright-core`, route, contract, web, vault or Bridge code is added.

## Commands and evidence

- `nice -n 10 node --test packages/server/test/browser/*.test.ts` — 30 tests, 30 pass,
  0 fail, 0 skipped.
- `nice -n 10 npx tsc --noEmit -p packages/server` — exit 0, no diagnostics.
- `npx markdownlint-cli2 packages/server/src/browser/README.md docs/plans/lanes/C1-a.handoff.md`
  — 0 errors (2 files).
- `npx eslint packages/server/src/browser packages/server/test/browser` — exit 0;
  `node scripts/check-doc-links.mjs` — 244 files, 710 links, 0 problems.
- `git diff --check` — clean; no dependency or third-party source added.

## New / regression envelope

**New:** 30 Node cases in two new files. They cover normalization (case, default ports, IDN,
trailing dots, credentials, TypeError), each navigate rule, clean-link query/fragment/userinfo/
path/entropy refusals, model data boundaries, the explicit Read-only form-submission block,
full-mode writable checks, refused schemes and determinism; plus migration reopen, UI channel,
wildcards, domain forms, project/role/account scoping, expiry, revocation context lists,
context lifecycle, secret-field rejection and `touch`.

**Regression:** no existing source or test file was modified. The server-wide `tsc` project and
the two targeted test files are the envelope. No full `npm test`, browser gate, live server,
model, network or owner data was used.

## Verification

- A separate read-only reviewer was started; it did not return a report in this session, so no
  independent finding is claimed. The author re-read the six files against the contract and
  reran all checks; cross-family review remains an integrator duty.

## Residuals

- `playwright-core` browser host, per-run ephemeral contexts, personal-profile encryption and
  `browser-context` / `browser-profile` / `browser-live` leases.
- Streamed pane, takeover/pop-out UI and Connections → Browser grant page.
- Guanxi Bridge extension, per-site host permissions, live-Chrome delegation and bookmark/
  history import.
- Cookie scrubber rules, encrypted session bundles in the account vault, and the ADR-0035
  planted-cookie and injection-page validation.
- Routes, contract types, server wiring and the MCP-shaped agent tool surface.
- The registrable-host suffix table is a deterministic approximation, not a complete PSL.

C1 and C4 stay not started in status terms; this slice moves them only to in progress at
integrator merge. It is not the C1 or C4 exit gate.

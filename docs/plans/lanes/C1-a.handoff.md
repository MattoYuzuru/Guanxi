# C1-a / C4-a handoff — browser origin policy and site grants

**Status:** implemented pure core, locally validated; C1 and C4 remain in progress.
**Date:** 2026-10-22 · **Branch:** `codex/c1a-browser-policy` · **Base:** `4b0cc079` · standalone clone; no push, no other repository file changed.

## What exists

- `packages/server/src/browser/types.ts` — `RunBrowserPolicy`, `BrowserAction` and decision types. Origins are canonical `scheme://host[:port]` values; only `addReadable` can propose a policy mutation, and it never adds a writable origin.
- `packages/server/src/browser/origin-policy.ts` — pure `normalizeOrigin` and `decide`.
  Normalization lowercases, converts IDN to punycode through URL, removes trailing dots, drops
  default ports and throws `TypeError` for non-http(s). Implementation covers navigate rules
  1–4, interaction rules and refused schemes; the clean-link/models heuristics are exact in the
  file and README.
- `packages/server/src/browser/site-grants.ts` — `SiteGrantStore` over
  `<dataDir>/browser.sqlite`: WAL, foreign keys, mode 0600, `c1_migrations` v1 and the
  `site_grants` + `site_contexts` schema. UI-only grants derive account/creator from the
  principal; wildcard and secret-shaped fields are refused; domains store the exact normalized
  host with no registrable-domain widening; `revoke` returns exactly the open contexts;
  `grantsFor` scopes by account/project/role and hides expired/revoked rows; `openContext` and
  `touch` require the full account/project/role scope; `contextsToClose` lists open contexts on
  revoked or expired grants.
- `packages/server/test/browser/origin-policy.test.ts` and `site-grants.test.ts` — 39 cases:
  23 origin-policy and 16 site-grant.
- `packages/server/src/browser/README.md` — boundary, exact heuristics, store contract, error
  codes, commands and residuals.
- `docs/plans/lanes/C1-a.handoff.md` — this file. No Chromium, `playwright-core`, route, contract, web, vault or Bridge code is added.

## Commands and evidence

- `nice -n 10 node --test packages/server/test/browser/*.test.ts` — 39 tests, 39 pass,
  0 fail, 0 skipped.
- `nice -n 10 npx tsc --noEmit -p packages/server` — exit 0, no diagnostics.
- `npx markdownlint-cli2 packages/server/src/browser/README.md docs/plans/lanes/C1-a.handoff.md`
  — 0 errors (2 files).
- `npx eslint packages/server/src/browser packages/server/test/browser` — exit 0;
  `node scripts/check-doc-links.mjs` — 245 files, 710 links, 0 problems.
- `git diff --check` — clean; no dependency or third-party source added.

## New / regression envelope

**New:** 39 Node cases in two new files (23 origin-policy, 16 site-grant). They cover
normalization (case, default ports, IDN, trailing dots, credentials, TypeError), each navigate
rule, clean-link query/fragment/userinfo/path/entropy/host-label refusals, model data
boundaries including the aggregate budget and repeated parameters, the explicit Read-only
form-submission block, full-mode writable checks, refused schemes, missing/unknown `via`/`mode`,
unknown action kinds and other fail-closed paths and determinism; plus migration reopen and file
modes, UI channel, wildcards, exact-host domain forms including the reviewer's suffix examples,
project/role/account scoping, expiry, revocation context lists, `contextsToClose`, context
lifecycle, the required account/project/role guard, secret-field rejection and `touch`.

**Regression:** the lane modifies only `packages/server/src/browser/*` and its two test files.
The server-wide `tsc` project and the two targeted test files are the envelope. No full
`npm test`, browser gate, live server, model, network or owner data was used.

## Verification

- The first independent static reviewer returned no P1, two P2 and several P3 findings; those
  were fixed in `e41bd0c2` and covered by the updated tests.
- A second independent security review returned three P2 bypasses and four P3 items; they are
  fixed in the six commits listed at the end of this file, each with a failing-first test. No
  cross-family GPT review is claimed.

## Residuals

- `playwright-core` browser host, per-run ephemeral contexts, personal-profile encryption and
  `browser-context` / `browser-profile` / `browser-live` leases.
- Streamed pane, takeover/pop-out UI and Connections → Browser grant page.
- Guanxi Bridge extension, per-site host permissions, live-Chrome delegation and bookmark/
  history import.
- Cookie scrubber rules, encrypted session bundles in the account vault, and the ADR-0035
  planted-cookie and injection-page validation.
- Routes, contract types, server wiring and the MCP-shaped agent tool surface.
- The per-segment entropy rule now has an aggregate 200-character budget and a host-label check,
  but it remains a heuristic; `via`/`fromOrigin` remain host assertions rather than
  authenticated facts.
- Subdomain grouping is deliberately absent: a grant matches only its exact normalized host.
  Grouping needs the real Public Suffix List (later).
- `click` on a readable origin in `read_only` may hit a submit button; the pure policy cannot
  distinguish a link from a form submission. The future browser host must block form-submitting
  clicks.

C1 and C4 stay not started in status terms; this slice moves them only to in progress at
integrator merge. It is not the C1 or C4 exit gate.

## Independent review fixes

A second independent security review found three P2 bypasses and four P3 items. Each code fix is
a separate commit on `codex/c1a-browser-policy`, and each began with a test that failed against
the previous commit. Nothing was pushed.

- **P2-1 — model URLs carried unlimited data to a readable origin** (`56ccbf7e`).
  `hasModelData` now refuses any non-empty fragment, a decoded path-plus-query total over 200
  characters, more than eight query parameters, and entropy hidden after a `.`, `-` or `_` in a
  path segment (each split part and the whole segment are tested). Failing-first tests cover the
  reviewer's examples: 50 segments of 32 base64 characters, `?a=<32>` repeated 50 times,
  `ab.<60 characters>`, a 5000-character fragment, plus a normal
  `https://docs.example.com/guide/install` model URL that stays allowed.
- **P2-2 — `openContext` ignored project/role and made the account optional** (`0363b392`).
  `openContext` and `touch` now require `accountId`, `projectId` and `role`; the grant lookup
  adds all three predicates. A grant in another scope is `context_foreign`, while a genuinely
  unknown grant stays `grant_not_found`. Tests open a `pA/researcher` grant as `pB`, as another
  role and as another account, for both methods.
- **P2-3 — registrable-domain fallback broadened grants to whole suffixes** (`da92e9c3`).
  `normalizeSiteDomain` stores the exact normalized host the user entered; there is no widening.
  `shop.com.ua`, `x.spb.ru`, `bob.s3.amazonaws.com`, `me.ngrok.io` and `a.blogspot.co.uk` keep
  their full host. A grant for `github.com` and one for `gist.github.com` stay distinct, and
  matching a context origin to a grant is exact host equality. The README records that
  subdomain grouping needs the real Public Suffix List later; the small suffix set only refuses
  a grant for the suffix itself.
- **P3.1 — unknown interaction kinds reached the writable branch** (`c6b21fdc`).
  `decideInteraction` whitelists exactly `type`, `submit`, `upload`, `download` and `click`
  before parsing the origin; `evaluate`, `scroll` and anything else return `invalid_action`.
  Tests cover both kinds in `read_only` and `full`.
- **P3.2 — clean links did not entropy-check host labels** (`dc5d5491`). The clean-link rule now
  applies the length/base64-entropy test to every hostname label, so a target with two
  63-character labels is refused as `data_url_refused`.
- **P3.3 — hand-off residual, no code.** `click` on a readable origin in `read_only` can still
  hit a submit button; the pure policy cannot tell a link from a form submission. The future
  browser host must block form-submitting clicks. This is recorded in the residuals above.
- **P3.4 — no recovery list for contexts on lost grants** (`2817d629`).
  `contextsToClose(now)` returns still-open contexts whose grant is revoked or expired at
  `now`, in open order. Closing stays with the browser host. Tests cover expiry at the exact
  boundary, revocation, a closed context and a live context.

Final evidence after the fixes: `node --test packages/server/test/browser/*.test.ts` — 39 tests,
39 pass, 0 fail; `npx tsc --noEmit -p packages/server` — exit 0; `markdownlint-cli2` on the
browser README and this hand-off — 0 errors.

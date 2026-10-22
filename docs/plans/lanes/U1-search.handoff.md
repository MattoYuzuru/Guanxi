# U1 explicit complete session search

**Status:** implemented unmounted continuation; separate independent review and integration
pending · **Date:** 2026-10-22 · **Branch:** `codex/u1-search` · **Base:** `b79639d`.

The palette now distinguishes loaded-only search from loading, failed coverage and exhausted
available pages. An explicit action loads remaining scrubbed metadata pages sequentially with
no item ceiling. The query stays open, Search/Cancel return focus to its input, and progress
shows a loaded count rather than an invented total. After exhaustion, omitted sessions remain
explicitly unavailable; this is not a consistent snapshot or a claim about inaccessible data.

Cancel and palette close abort active scanning synchronously; navigation, refresh and unmount
also abort it. An epoch fence excludes late responses, including an old response arriving while
a retry is active. Completed pages are retained on failure/cancel; retry starts at the failed
cursor. Cursor cycles are rejected, duplicate IDs are merged in original order, and concurrent
scan/load-more calls cannot dispatch another request. An initial read failure still exposes
retry without a next cursor. There is no new endpoint, raw-title filtering, private payload,
schema change, model use or default session write.

## Verification

- Final focused component/unit check `check-fiviyyci`: **30/30**, zero skips, **8 new / 22 inherited**
  (existing shell hook/controller/palette plus 13 localization cases). Assertions cover exact
  237-session order/no duplicates, sequential cursors, initial/mid-scan failure and retry,
  cancel/route/unmount late-response exclusion, cursor cycles, and EN/RU coverage wording.
- Actual Chromium `check-3ycs764r`: **4/4**, zero skips, **2 new / 2 inherited** palette cases.
  The real controller-to-palette fixture finds a matching session beyond 200, keeps the query
  and actual input focus, navigates to the explicit inspector target, and has zero serious/
  critical axe findings. The Russian 320px fixture verifies failed coverage, exact retry
  cursors, actual request abort, no false completion, retained query, bounds and Escape return.
- Final web types `check-ghpciwwj`, scoped ESLint `check-w1go5hsn` and Markdown/links
  `check-8fb70k9o` passed. The earlier component `check-cdf03hq1`, browser `check-y_ri3vqj`
  and type `check-dsvza7rd` checks predate the final focus assertion and are not counted again.

All checks use Node26 and the shared heavy lock on the current Mac; ports5201/4401 were free
before use, with disposable `.lane-data`. Source remained unchanged during each check. The
inherited external guanxi-ui symlink prevents reusable source attestation; receipts are scoped
local observations. Full combined browser/UI/build/integration gates remain root-owned.

## Review and remaining U1 scope

The base shell preparation `b79639d` has separate independent source/32-case acceptance in
`reviews/codex-u1-shell-prep-20261022.md` outside the checkouts. This follow-up needs its own
independent review. `App.tsx` is unchanged; the draft AppShellChrome is not imported or mounted,
and manifests/review records/snapshots/suppressions are untouched. Root must first accept the
shell pattern readiness and compose the actual host, then verify the mounted palette/dialog
handoffs and real route layout. New-session, finished-unseen, ephemeral side chat, remaining
token migration, owner approval and full U1 stage exits remain open.

## Separate independent review fix

Independent review of `437e5d5` reproduced a P2: when refreshing a cached partial list failed
at its first page, Retry followed the old tail and could falsely announce exhaustion. The
outside report is `reviews/codex-u1-search-20261022.md` and its failing regression receipt is
`check-fktavosi`. This finding is retained rather than treating the original checks as complete.

The separate fix gives pagination an explicit ready basis. Refresh immediately aborts prior
work and invalidates its cursor; cached rows remain visibly labelled previously loaded after
failure. Retry requests FIRST, and only a successful FIRST replaces rows and admits its new
tail. Direct scan/load-more calls cannot use the old tail while the basis is unavailable.

Final component check `check-_yzxgu_w` passes **31/31**, zero skips: **1 new review regression /
30 prior**, cumulatively **9 new / 22 inherited**. The exact assertion requires requests
`FIRST,FIRST,FIRST,new-tail` and only new-head/new-tail IDs, including immediate scan attempts
when refresh is requested. Existing EN/RU tests also assert the cached-data failure copy and
the named refresh retry. Actual Chromium `check-zeuufvlg` passes **5/5**, zero skips: **1 new /
4 prior**, cumulatively **3 new / 2 inherited**. Its actual controller/palette reproduces
refresh failure, requires FIRST retry, checks the same exact request sequence and proves no
old-head/old-tail options remain. The original external reviewer fixture also passes in the
author recheck `check-3fmb_x2i`; this is not independent acceptance. Final web types
`check-vngsagfk`, scoped ESLint `check-ce05b8nn` and Markdown/links `check-hk1lt7vk` pass.
Separate independent recheck and integrated gates remain open.

## Localized-copy inventory review fix

Root's combined `npm test` at `985dfed` (including search source `15b962f`) failed web 351/352
only in `test/component/localized-copy-inventory.test.tsx` (`check-5y575x_n`). A scoped replay
against the unfixed source failed the guard `1 failed | 4 passed` with 16 diagnostics: the
hardcoded `PRODUCT_NAME` at `ShellStatus.tsx:22`, eight session-status returns and three
date-group returns in `sessionPresentation.ts`, and four save-scope returns in `scopes.ts`. The
red log is `.lane-data/u1-search-inventory-red.log`.

The fix commit localizes the brand and makes machine discriminants explicit typed references:

- `ShellStatus.tsx` renders `t('shell.brand', { product: PRODUCT_NAME })`. `shell.brand` is
  `'{product}'` in both English and Russian catalogs, so the actual label remains the central
  `PRODUCT_NAME` and no second brand literal exists.
- `sessionPresentation.ts` defines `SESSION_STATUS` and `SESSION_DATE_GROUP` as typed const
  maps; `SessionStatus` and `SessionDateGroup` derive from their values. The exact values remain
  `unknown`, `queued`, `running`, `waiting`, `sleeping`, `finished`, `error`, `stopped` and
  `today`, `yesterday`, `earlier`. Visible labels remain `shell.status.*` and
  `shell.sessions.*` locale lookups.
- `workspace/scopes.ts` defines `LAYOUT_SAVE_SCOPE` with the unchanged values `account`,
  `project`, `device`, `project-device`; `LayoutSaveScope` derives from it. Scope resolution,
  routing and wire/storage meaning are unchanged.
- `shell-status.test.tsx` adds one actual render assertion for the centralized brand through
  both EN and RU locale lookup.

**New / regression:** 1 new component test (EN/RU brand render) / 41 prior component cases in
the regression envelope. The scoped component run passed **42/42** across inventory, shell
status, sidebar, controller, palette, sessions and localization. The inventory guard was red
before the fix and green after it. Web `tsc`, scoped ESLint on the five changed files and
`git diff --check` passed. No scanner exception, suppressions, component record, snapshot or
generated file changed. No browser, build, full `npm test`, Storybook, container or model
operation ran in this fix.

**Delivery constraint:** the worktree gitdir
`/Users/yuzuru/Projects/Guanxi/.git/worktrees/u1-search` is outside this session's
workspace-write sandbox, so its index lock and branch ref cannot be written here. The source
fix is the sandbox-local commit `cf65d81cfff2c636024e5748d40b4a965da48071`; this documentation
is a separate local commit. The corresponding patch series and bundle are under
`.lane-data/u1-search-review-fix/`. Root should apply the patches or fetch the local
repository, then update `codex/u1-search`; the shared worktree metadata still reports the base
commit until that step. Because this worktree still shows the same edits as uncommitted
changes, root must first return it to the base or use a clean checkout; verify there are no
other changes before resetting. This is the only unresolved delivery action, not a test
failure. The patch series was checked against a temporary base index and reproduces the
delivered tree.

Independent GPT recheck and root merge remain pending. The existing browser/workspace scope
cases and all integrated gates remain root-owned.

### Coordinator delivery and independent closure

The external-gitdir restriction above was a delivery limitation, not an unresolved code issue.
The coordinator recovered the exact delivered commit/tree after verifying that the dirty
worktree and index matched it; no reset or unrelated-file deletion was used. Source `cf65d81`
and docs `ff6768b` are now integrated. Independent scoped recheck `check-dyhk5z_i` passes
42/42 with no remaining bounded finding. The failed full receipt `check-5y575x_n` belongs to
combined `985dfed`, not the earlier isolated search source `15b962f`.

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

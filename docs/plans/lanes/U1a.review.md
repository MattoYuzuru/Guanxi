# U1-a fresh-context self-review

**Status:** findings fixed; final verification recorded in handoff · **Date:** 2026-10-21

A separate same-family reviewer read the complete `494c8b0..243f0f3` implementation diff
with a fresh context, then rechecked the integrated main diff and subsequent fixes.
It was read-only, ran no checks and changed no source. Its application inspection at `e1daee2`
reported no substantive findings. Storage correction `2a26b04` introduced no correctness
defect; its two assertion gaps were closed in `7dc0496`, confirmed by a read-only recheck.
The integrator arranges the Claude cross-family review.

## Findings and fixes

| Finding | Fix commit and direct assertion |
| --- | --- |
| Losing save changes metadata but leaves the losing engine alive | `42f2bd6`: reconcile the server winner; browser asserts a different block map and a second save. |
| Geometry loads after mode/named activation; saved popout bounds unused | `42f2bd6`: await geometry, preserve IDs, consume reopen bounds; browser asserts actual float/popout dimensions. |
| Geometry keys omit document scope | `42f2bd6`: full scope identity; Node asserts project/mode/device isolation for the same layout ID. |
| Named selection bypasses engine-major fallback | `42f2bd6`: compatibility on every activation; browser selects a future-major named document. |
| Phone menu exposes an ineffective Move action | `42f2bd6`: disabled on phones; browser asserts disabled state at 390 px. |
| Existing tab titles do not follow locale changes | `42f2bd6`: update panel titles; browser asserts Russian title and absence of the old English title. |
| Reset discards the saved revision and loses a subsequent save | `e6549f9`: retain identity/scope/clock; browser asserts revision 8, default placement and reload. |
| Detached multi-tab groups do not restore their active tab | `8695df2`: reapply saved active pane; named/mode float tests assert Terminal remains active. |
| Native popup headers lack keyboard handlers | `8695df2`: window listener with cleanup; popup-native tab tests assert F6 and Alt+Shift+M. |
| Right/bottom-anchored floats lose their saved geometry | `b4a52b6`: normalize anchors; browser compares actual dragged/restored bounds and saved geometry count. |
| Detached nested split grids cannot round-trip | `b4a52b6`: reject edge splits; browser asserts one float, exact pane membership and eleven total tabs after the attempted drop. |
| Popup shortcuts capture the pane that originally opened the window | `8580ae2`: resolve current active pane in the event window; browser merges Browser, returns Terminal, then asserts Browser command identity and F6 origin. |
| Global migration 32 collides with K4’s reserved range | `2a26b04`: use component-owned ledger v1 and restore global migrations/tests to main; `7dc0496`: assert deterministic competing initialization and nonempty setting preservation through rollback, success and future rejection. |
| Choice-menu completion steals outside/Tab focus | `e1daee2`: restore only for item activation/Escape; browser asserts Tab-away and outside-field focus. |

The reviewer also identified evidence gaps. Assertions now exercise Home/ArrowDown/Tab/Enter,
exact live text, restore through two animation frames, an actual reduced-motion preview,
rendered colors in both themes, focus after move/cancel/hide, distinct losing content and Left.
The upstream MIT notice uses the verified copyright, 2021 mathuo.

## Integration findings

Author checks additionally caught and fixed StrictMode handle/subscription replay (`6b0ccce`),
layer ordering and duplicate portal keyboard dispatch (`844af8c`, `3908ab9`), textarea accessible
label stability and split-zone tracking (`a3b9442`, `0ff867e`), closing popout backdrop cleanup
(`1b11b6a`), catalog lazy loading/font duplication/static modal previews (`0ff867e`), and eager
DB access while serving the database-free feature-flags endpoint (`e1daee2`). These fixes are
separate from the implementation commit. Regression assertions were retained; global
slot-count expectations include eleven core blocks.
The unreleased global layout migration was withdrawn before handoff; global migrations and
unrelated server tests are unchanged from main. No live data migration was performed.

Residuals remain explicit: sandboxed Electron popouts wait for U2; Terminal/Browser retain
non-executing drafts rather than live services; real screen-reader speech is not inferred from
DOM assertions; T2 MCP App hosting waits for P1. Catalog `review` status is not owner approval.
Executed gates, their scope and receipts are in [U1a.handoff](U1a.handoff.md).

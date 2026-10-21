# U1-a fresh-context self-review

**Status:** findings being fixed · **Date:** 2026-10-21

A separate same-family reviewer read the complete `494c8b0..243f0f3` diff with a fresh context,
read-only. It ran no checks and did not edit files. The integrator arranges the Claude
cross-family review after handoff. This record describes findings, not successful validation.

| Finding | Required fix and assertion |
| --- | --- |
| P1: a losing save updates document metadata but leaves the losing engine alive | Reconcile the winning document and geometry; assert a winner with a different block map and a second save. |
| P2: mode/named selection mounts before geometry loads; popout bounds never consumed | Await scoped geometry before replacement; preserve group identity and pass saved position when reopening; assert actual bounds. |
| P2: geometry keyed without full document scope | Include the scope identity; assert two projects and modes sharing one layout ID remain isolated. |
| P2: named selection bypasses engine-major fallback | Apply compatibility on every activation path; assert selection of a future-major named document. |
| P2: phone pane menu exposes an ineffective Move action | Disable pane movement on phones; assert the disabled menu item at 390 px. |
| P2: tab titles do not follow locale changes | Update existing panel titles; assert in-place locale change. |

The reviewer also identified evidence gaps: fully keyboard-operated move choices; restore time
through rendering; an actual reduced-motion drag preview; rendered theme colours; focus after
move/cancel/hide; distinct losing content; and moving into Left. These receive direct assertions.
The upstream MIT copyright is 2021 mathuo; the notice is corrected without copying source.

The author additionally found an old adapter cleanup could clear a newly mounted adapter's
shared handle. Cleanup now checks handle ownership. The mode-switch test must move again after
returning to Developer, which fails if the new handle was lost.

Residuals are explicit: Electron sandbox popout behavior waits for U2; Terminal and Browser
have retained, non-executing drafts, not live process/browser services; real screen-reader
speech is not inferred from live-region DOM assertions. Catalogue review status is not approval.

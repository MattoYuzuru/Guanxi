# U1 transitive primitive readiness — author handoff

**Status:** bounded implementation and author checks complete; independent review pending.
**Updated:** 2026-10-22
**Branch/checkout:** `codex/u1-primitive-readiness`, standalone
`/Users/yuzuru/Projects/Guanxi-lanes/u1-primitive-readiness`.
**Assigned base:** `bfef83cda9bffdcef788a59966833371c5e7e978` (reviewed U1 mount plus root plan).
**Last executable/test pin:** `437f50428101ec98fd64bc700d537c67b3addf6c`.
**Plan committed first:** `dd9a5fd0`, [bounded plan](U1-primitive-readiness.plan.md).

This is primitive readiness evidence, not independent author approval, component promotion,
whole U1, MS1 or product integration. Root reserved `encoding_review2` for separate review.
All review records remain unchanged (`draft` for IconButton/Menu/Tooltip, approval null).

## Implemented changes

1. Added one actual-browser fixture and 23 maintainable cases using public `@guanxi/ui`
   components and the existing web Playwright runner. The fixture has uncontrolled Menu and
   Tooltip compositions, a real default Dialog close control, locale messages and the same
   theme/density/material attributes as the catalog. No mocked interaction engine or API is
   needed. Its counters expose exact activation counts and forbidden disabled activation.
2. Reconciled Menu's draft documentation: disabled commands can receive focus and expose
   `aria-disabled`, but cannot activate. Actual browser arrows/Home/End/typeahead, Enter,
   Space and pointer checks support this. Accepted design/vision/decision search found no
   specific disabled-skipping requirement; root explicitly chose the supported Base UI
   behavior over custom focus hacks. No Menu keyboard implementation changed.
3. Fixed a demonstrated Tooltip semantics defect in separate `f50e42e2`: Base UI 1.8 supplies
   interaction/dismissal but the wrapper previously supplied neither tooltip role nor trigger
   description relationship. The wrapper now supplies a stable popup ID and role, associates
   the open description, preserves existing description IDs and accessible names, and respects
   custom content IDs, controlled/default-open state and canceled open callbacks. Tests cover
   these compatibility boundaries plus IconButton and Dialog compositions.
4. Fixed a demonstrated forced-colors Menu rendering defect in separate `e06cc202`: Chromium's
   Canvas text backplate obscured white HighlightText over Highlight. The existing highlighted
   item selector now uses `forced-color-adjust: none` while retaining explicit system
   Highlight/HighlightText. It still honors the user's system palette; no ordinary-theme
   style, token, keyboard behavior or layout changed.

Only Tooltip TSX, Menu CSS and their docs changed in component folders. IconButton source
is unchanged. Required manifest generation changed seven transitive `sourceHash` fields
(app-shell-chrome, dialog, icon-button, menu, toast, tooltip, workspace-chrome), with no status,
usage or snapshot-hash changes. This generated manifest is the sole shared source-metadata edit.
No source in the other U1 host/G11 repair lanes was edited.

## Assertions and visual observations

- Menu: four exact items; arrow/Home/End/typeahead focus; disabled focus and aria state;
  zero disabled Enter/Space/pointer activation; enabled Enter/Space/pointer actions exactly
  once; Escape removes the popup and returns focus. A fresh open clears the typeahead buffer
  before testing Space activation; no arbitrary waiting masks the interaction.
- IconButton: actual small targets at least 24 by 24; accessible name and hidden glyph;
  pointer/Enter/Space activation counts, disabled zero activation, stable toggle name/state;
  pointer-active fill differs without inventing `aria-pressed` on a non-toggle.
- Tooltip: actual hover then actual Tab entry opens exactly one named popup; its ID is in the
  trigger description relation; Escape removes the popup without action/focus loss, including
  the Dialog default close control. Dialog itself remains open until its close action.
- Compatibility: custom IDs, caller-provided descriptions and names survive; default/controlled
  open close correctly; canceled opening produces no popup or added reference.
- Forced colors: actual media query active, focus outline at least 2 px/3:1 contrast, highlighted
  text at least 4.5:1, visible Tooltip border. The explicit no-backplate guard complements
  manual image inspection; parent computed colors alone had missed the real text backplate.
- Twelve light/dark × compact/comfortable × glass/tinted/solid cases each exercise Russian
  and expanded pseudo text (24 regimes). They assert actual row heights/fonts/material blur,
  exact localized trigger text, four menu items, focus, disabled semantics, popup/row viewport
  and horizontal overflow bounds, small target geometry and zero serious/critical scoped axe
  findings. Reduced transparency checks actual opaque fill/no backdrop, not only a host flag.

Inspected all 48 phone Menu/Tooltip captures through four matrices, plus forced-focus,
forced-Menu, forced-Tooltip and reduced-transparency images. The forced-Menu image exposed the
backplate defect; the final separately captured image shows the repaired readable label.
Artifacts are outside Git at
`/Users/yuzuru/Projects/Guanxi-lanes/reviews/u1-primitives-e7de5075/`:
`{ru,pseudo}-{menu,tooltip}-matrix.png`, `forced-{focus,menu,tooltip}.png`,
`reduced-transparency.png`, and `forced-menu-after-437f5042.png`.
No committed baseline or screenshot hash was updated. The synthetic glyph uses currentColor.

## New / regression evidence

**New repository cases: 23** in `primitive-readiness.spec.ts`. Parameterized locales and
48 screenshots do not add test credit. **Inherited regression envelope: 25** = 23 existing
UI cases in three files plus two existing shell-palette browser cases. Repeated diagnostics,
selected red/green and later runs are not additional new cases.

All runs used local Mac Node26.9.0, own dependencies, ports 5203/4403, checkout `.lane-data`,
and workstation-dev shared `heavy` under `/Users/yuzuru/.local/state/agent-dev`, with quiet
clean source. Unless named red below, commands exited 0 with no skips/failures/cancellations.

| Scope | Actual pin | Result | Receipt |
| --- | --- | --- | --- |
| New browser file | `cb1cabf3` | 23/23 | `check-zolbjenj` |
| Strengthened regime/contrast file | `990ac275` | 23/23 | `check-2trboin9` |
| New file + inherited shell-palette browser file | `e7de5075` | 25/25 = 23 new / 2 earlier | `check-jr036hc3` |
| UI components, AppShellChrome, catalog Vitest files | `990ac275` | 23/23 earlier | `check-2ipx3otd` |
| UI TypeScript | `990ac275` | passed | `check-h_oby1dz` |
| Explicit browser spec/fixture strict TypeScript | `990ac275` | passed | `check-vv38dp1z` |
| Final explicit browser spec/fixture strict TypeScript | `437f5042` | passed | `check-c2343g56` |
| Scoped TSX/spec/Menu CSS ESLint | `437f5042` | passed | `check-45gqjtga` |
| Final affected forced-colors browser case | `437f5042` | 1/1, repeat of one new case | `check-pintnsv1` |

The final forced-colors-only CSS/guard delta did not trigger another blanket 23-case run.
The earlier complete25 and UI23 observations retain their actual pins; Tooltip production
code is unchanged since those runs. Final Menu media-scoped behavior has the separate1/1
actual check/image. Neither old nor new scoped commands substitute for root's full union gates.

### Actual reds and test assumptions

- Tooltip role/association: `check-o65p7xku` at `1d903f07`, 0/1. The visible popup was generic
  text, so the exact tooltip-role assertion failed. Same selected case passes1/1 after the
  separate source fix at `f50e42e2`, `check-04pflwop`.
- Forced-colors: inspected pre-fix image at `e7de5075`; separate guard commit `236834eb`
  fails0/1 (`check-y7im4r37`, actual auto versus expected none). Separate source fix plus
  generated metadata `437f5042` passes the unchanged selected case and image check above.
- `check-he6nta3k` failed typeahead after Space started a search buffer; the fresh-open
  typeahead control passes (`check-j4kpicls`). No Menu source fix was inferred from that sequence.
- `check-rltei6_h` matched no test because of an incorrectly anchored grep. It is not a
  behavior red. `check-dxcb1yus` used the wrong Dialog close label; `check-02w1sh9a` used
  programmatic focus after pointer modality rather than keyboard Tab. Both test assumptions
  were corrected before the complete23 pass; they are not product defects.
- `check-o4oujakk` failed an added test expectation that Solid serialized as none. The
  generated zero-effect value is blur(0px) saturate(1); the corrected assertion permits exactly
  those two equivalent zero-effect forms. No material token or production deadline changed.

## Fast UI gate limitation and local metadata recovery

`npm run ui:check` is **not green** in this mounted-U1 clone. Initial `check-5t0dptvl` at
`e7de5075` failed the missing trusted-main G12 comparison and inherited unused App.tsx class
allowances. A local fetch from the root checkout supplied main; its package tree matches
trusted executable `1b6f495`, and main was set exactly to that ancestor after root confirmation.
`git merge-base --is-ancestor 1b6f495 HEAD` succeeds. This changed only clone Git refs, no keys,
review records, source, status or approval. G12 then passes in `check-ui8q056f` at `437f5042`.

That final fast run still fails G5/G6/G7 on the same six unused App.tsx allowances:
backdrop-blur-md, font-medium, font-semibold, rounded-md, text-xs, tracking-tight. App.tsx and
ratchet files are identical to assigned base; root routes the shrink to the U1 integration
owner. They were not edited or waived here. Other fast results, including G10/G12/G15/G17,
pass. G11's direct-import pass does not prove transitive closure; its independent repair is
another lane. Existing review/stale warnings name Button, AppShellChrome, Dialog, Input and
WorkspaceChrome. No new draft product use is introduced by a browser-only fixture.

## Limits, rollback and next action

Root still owns full union/main browser, npm/build/lint and pinned catalog G13–G16 checks.
Their earlier `1b6f495` observations remain inherited, not a fresh catalog pass for this repair.
No baseline update or full suite duplicate was run. Tests configure reduced motion and await
settled popups; they do not independently prove that no finite animation ever occurred.
High-contrast themes rely on earlier catalog evidence; actual forced colors here is Chromium
emulation with its system palette, not a physical OS/screen-reader/device walkthrough.
This fixture cannot prove every product route, long localized string or arbitrary custom icon.

No token/suppression/dependency, App/host source, G11/tooling, review/status/approval, owner
key, model/provider, owner data, SSH/remote, push or shared checkout change. No public/data
migration is needed. Revert the focused tests/docs/source commits to roll back this slice;
retain signed history, keys and snapshots. The inherited external skill symlink prevents
reusable source certificates; receipts are direct pinned outcomes, not portable attestations.

Freeze the clean final handoff pin for independent `encoding_review2`; it must inspect both
demonstrated fixes, controls, compatibility and claimed assertions. Root then integrates
other U1 fixes and shrinks the stale allowances, runs union gates, and separately decides any
unsigned draft-to-review transition. Approval remains null, and whole U1/MS1 stay open.

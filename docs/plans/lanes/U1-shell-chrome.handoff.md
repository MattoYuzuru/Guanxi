# U1 shell chrome — controlled AppShellChrome pattern

**Status:** implementation and focused tests ready; independent review and root gates pending ·
**Date:** 2026-10-22 · **Branch:** `codex/u1-shell-chrome` · **Base:** `e5f8e0a`
(reviewed U1) · **Commit:** `f72e17c`. No push, merge, rebase or status-file edits.

## Delivered

A new host-composed `AppShellChrome` pattern in
`packages/ui/src/components/app-shell-chrome/`:

- Controlled `side: 'left' | 'right'` and
  `visibility: 'expanded' | 'rail' | 'hidden'`, with `sidebar`, `status`, `children`,
  `sidebarLabel`, the required `labels` strings and `onSide`, `onVisibility`,
  `onOpenPalette` callbacks.
- Glass status strip and sidebar; opaque main reading surface. The status strip always owns the
  Palette action and, while hidden, the Show action. The sidebar menu offers Move,
  Collapse/Expand and Hide as appropriate to the controlled state.
- `side` changes the actual DOM/focus order, not just a CSS order property. The sidebar and main
  keep stable keys, so moving the sidebar does not remount either subtree.
- The sidebar and main stay mounted through rail and hidden states. A hidden sidebar carries
  `hidden` and `inert`. Hiding a focused sidebar returns focus to the persistent Show control;
  showing it again moves focus back to the sidebar menu trigger.
- No viewport JavaScript. The narrow flow reuses the existing workspace phone breakpoint
  (639 px in `packages/web/src/features/workspace/Workspace.tsx` and `workspace.css`) as a
  container query, so the shell stacks for a phone viewport and a narrow host frame while
  controlled state survives resizing.
- Nine catalog stories: `default`, `rail`, `hidden`, `right`, `phone`, `loading`, `error`,
  `offline`, `unknown`; docs, a `draft` review record and the generated catalog manifest entry.
  The rail story uses host-like compact icon content; the chrome itself invents no rail content.
- Focused Vitest coverage was written first and failed against the absent component before the
  scaffold. The implementation changed only after that red run.

## New / regression evidence

**New:** 6 Vitest cases in `packages/ui/test/app-shell-chrome.test.tsx` (189 lines). No existing
test file changed.

**Regression envelope:** none beyond the new focused file. The lane's scoped check permission
covers only the exact new test path and the UI typecheck; the full `npm test`, UI gates, browser
gate and build are root-owned and were not run.

| Claimed property | Assertion that fails on violation |
| --- | --- |
| Status, Show and Palette survive hiding | Hidden sidebar is `hidden` + `inert`; status text is present; Show and Palette are queryable; Show carries `aria-controls` to the sidebar id. |
| Exact controlled callback values | Menu clicks assert `right`, `rail`, `expanded`, `left`, `hidden`; Show asserts `expanded`; Palette asserts its callback exactly once. |
| Side changes DOM/focus order | `compareDocumentPosition` changes from sidebar-before-main to main-before-sidebar; both stateful children keep count 1 across the move. |
| Children stay mounted through collapse/hide | Sidebar and main increment counters remain 1 after rail and after hidden; hidden sidebar still contains its child. |
| Focus return from hidden sidebar | After Hide, `document.activeElement` is the persistent Show button and is outside the sidebar; after Show, focus is inside the visible sidebar. |
| Keyboard operation | ArrowDown on the named menu trigger opens the menu, focuses the first item, and Enter invokes the exact `onSide('right')` callback. |
| Visibility and accessible naming | Hidden state is queryable with the hidden flag; after Show the visible complementary landmark has the translated `sidebarLabel` name and Show is removed. |

## Executed checks

All commands ran from this standalone clone. Ports and heavy locking were not needed for these
scoped checks.

| Command | Result |
| --- | --- |
| `nice -n 10 npx vitest run test/app-shell-chrome.test.tsx` from `packages/ui`, before scaffolding | RED: 6 failed / 6 because `AppShellChrome` was not exported yet. |
| Same focused command after implementation and final assertions | PASS: 6 passed / 6; 1 test file passed. |
| `nice -n 10 npx tsc --noEmit -p packages/ui/tsconfig.json` from the clone root | PASS, exit 0, no diagnostics. |
| `nice -n 10 node catalog/scripts/build-manifest.ts` from `packages/ui` | Wrote `packages/ui/catalog/manifest.json`. |
| `nice -n 10 node catalog/scripts/build-manifest.ts --check` | `catalog/manifest.json is fresh`. |

Not run in this lane: `npm test`, `npm run ui:check`, `npm run ui:check:browser`,
`npm run test:web:browser`, `npm run build`, Storybook, browser/axe checks and snapshot
generation. The focused Vitest run is not responsive-layout, screen-reader or browser proof.

## Catalog handoff

`app-shell-chrome` is a new `draft` pattern. Its review record has `approval: null` and no
requests. The generated manifest has the real source hash, an empty generated
`snapshotHashes` object (no snapshots exist yet), `signature: "absent"`, `status: "draft"` and
usage count 0. No owner approval, signature, snapshot or product host usage is claimed or
fabricated.

Catalog route: `/settings/developer/components?component=app-shell-chrome`.
Story IDs: `app-shell-chrome--default`, `app-shell-chrome--rail`,
`app-shell-chrome--hidden`, `app-shell-chrome--right`, `app-shell-chrome--phone`,
`app-shell-chrome--loading`, `app-shell-chrome--error`, `app-shell-chrome--offline`,
`app-shell-chrome--unknown`.

The generated manifest also normalises the existing IconButton `tooltipSide` union order
(`"top" | "bottom" | "left" | "right"` to `"left" | "right" | "top" | "bottom"`). This is a
checker-order artifact of the canonical builder with the new component in the program, not a
source, status, approval or snapshot change. The manifest is deterministic across repeated runs.

## Ownership and shared edits

Only these paths changed in `f72e17c`:

- new `packages/ui/src/components/app-shell-chrome/`;
- new `packages/ui/test/app-shell-chrome.test.tsx` (required by the existing Vitest `test/`
  include pattern);
- the public re-export in `packages/ui/src/index.ts`;
- the regenerated `packages/ui/catalog/manifest.json`.

No existing component implementation, reviewed component, approval record, `App.tsx`,
workspace, layout, federation, token, generated style, ESLint baseline or snapshot changed. No
dependency was added and no third-party code was copied. Product `messages.ts` was not edited
because host labels are props and that file is outside this lane's ownership; the host must
supply the EN/RU product strings.

## Independent review

Pending. The root GPT reviewer should inspect `e5f8e0a..f72e17c` and append findings and
separate fix commits here. This author cannot close its own review or approve the catalog
record. Historical U1-a/U1-completion claims were not edited.

## Residuals and next steps

- Actual 390 px Chromium stacking, overflow, axe, reduced motion and pinned-Docker G13 baselines
  remain for the root. jsdom only proves DOM/state/focus contracts, not CSS layout.
- The breakpoint value is the existing 639 px workspace breakpoint, applied as a container query
  so the reusable shell and its phone story share one rule without a JS width listener. A real
  browser check should confirm that the host's normal page scroll and the shell's stacking agree.
- Screen-reader speech is not inferred from DOM roles, labels and focus assertions.
- The rail intentionally renders the host's `sidebar` node at 48 px; compact rail content is a
  host responsibility, and no model/status facts are invented.
- With a right sidebar, the phone stack follows DOM/focus order (main before sidebar); this is
  documented in the component docs.
- The component is a `draft`. It has no product host usage approval; G11 would block direct
  product imports until the owner reviews and approves the catalog record. Host integration
  belongs to the separate GPT design-review/u1-shell work, not this lane.
- Full typecheck, UI gates, browser gate, build, snapshots and owner catalog review remain
  pending before this pattern can be considered for product use.

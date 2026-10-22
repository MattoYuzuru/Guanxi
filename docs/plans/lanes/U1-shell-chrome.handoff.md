# U1 shell chrome — controlled AppShellChrome pattern

**Status:** implementation and focused tests ready; independent review and root gates pending ·
**Date:** 2026-10-22 · **Branch:** `codex/u1-shell-chrome` · **Base:** `e5f8e0a`
(reviewed U1) · **Commits:** `f72e17c` feature, `165e546` pre-paint focus fix. No push, merge,
rebase or status-file edits.

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
- Manifests and controls reuse the existing Button, IconButton and Menu public primitives. The
  sidebar trigger uses the standard Lucide `PanelLeft` glyph through IconButton's tooltip/name
  contract; no public Icon primitive existed and no new icon semantics were invented.
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
| Same focused Vitest and typecheck after fix `165e546`; manifest regenerated and checked | PASS: 6 passed / 6, tsc exit 0, manifest fresh. |

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

Only these paths changed in `f72e17c` and `165e546`:

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

Root review pending. The root GPT reviewer should inspect `e5f8e0a..165e546` and append findings
and separate fix commits here. This author cannot close the root review or approve the catalog
record. Historical U1-a/U1-completion claims were not edited.

### Author self-review fix

**Finding:** the hide/show focus hand-off used `useEffect`, which runs after paint. A focused
hidden sidebar could therefore remain the active element for a painted frame before the Show
control received focus, which is weaker than the "no focus stranded hidden" claim.

**Fix:** `165e546` moves the same hand-off logic to `useLayoutEffect` and refreshes the generated
manifest source hash. No copy, callback, layout or test assertion changed.

**Verification:** the existing focus-return test still passes (6/6 focused Vitest), the UI
typecheck is clean and the manifest is fresh. A real browser focus check remains part of the
pending root gate.

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

## Review fix — P2 phone sidebar border width

**Status:** fix and focused regression cases ready; actual Chromium/G14 green and the full root
envelope remain pending. This section is appended evidence; it does not change the original
slice's claims above.

**Finding (root P2, confirmed).** Public `@guanxi/ui` does not guarantee a global `border-box`
reset. At an actual 390 px host, the expanded `.gx-app-shell-sidebar` measured 392 px because its
390 px content width sat inside a 1 px glass border on each side; the shell and main stayed at
390 px. The root fixture is
`/Users/yuzuru/Projects/Guanxi-lanes/reviews/app-shell-chrome-browser-review.mjs`; the pre-fix
red receipts are `check-3r5r4gi6` and diagnostic `check-irc421g3` (sidebar 392, root/main 390).

**Fix.** `box-sizing: border-box` is now scoped to `.gx-app-shell-sidebar`. The expanded 18 rem
and rail 48 px widths therefore include the 1 px glass border instead of adding 2 px outside
them. The shell frame is unchanged because it has no border or padding that would need the same
box model. There is no global or descendant reset, so approved primitives keep their own box
model. The 639 px container breakpoint, layout tokens, glass/opaque material split and DOM/focus
order are unchanged.

**New regression coverage.** Two Chromium cases were appended to
`packages/ui/gates/catalog/browser/g14-axe.spec.ts`, one each for light and dark. They are guarded
only when `gateStories()` contains `app-shell-chrome--phone`, open that story through the existing
`openStory` helper at a 390 × 844 viewport, and set only the story's synthetic host wrapper width
to the available phone width: `390 − 16 px left gutter − 16 px right reserve = 358 px`. After
layout they assert a positive host width, the shell width, exact sidebar fit to the shell's left
and right edges, sidebar and main inside the shell's right edge, and the phone-stacked column
with sidebar before main. With the pre-fix content-box sidebar these assertions fail by the 2 px
border overflow; no CSS-text, computed-style or jsdom assertion substitutes for the Chromium
layout check. The existing axe loops and `ACCEPTED` exceptions were not changed.

**Regression envelope.** The existing 6 Vitest cases in
`packages/ui/test/app-shell-chrome.test.tsx` were run unchanged and pass. No Vitest implementation
mirror was added for this CSS-only fix; actual browser geometry is the regression proof.

| Command | Result |
| --- | --- |
| `nice -n 10 npx tsc --noEmit -p packages/ui/tsconfig.json` from the clone root, after adding the cases and after the fix | PASS, exit 0, no diagnostics. |
| `nice -n 10 npx vitest run test/app-shell-chrome.test.tsx` from `packages/ui` | PASS: 6 passed / 6; 1 test file passed. |
| `nice -n 10 npx stylelint packages/ui/src/components/app-shell-chrome/app-shell-chrome.css` from the clone root | PASS, exit 0. |
| `nice -n 10 npx eslint packages/ui/gates/catalog/browser/g14-axe.spec.ts` from the clone root | PASS, exit 0. |
| `nice -n 10 node catalog/scripts/build-manifest.ts` from `packages/ui` | Wrote the manifest. |
| `nice -n 10 node catalog/scripts/build-manifest.ts --check` from `packages/ui` | `catalog/manifest.json is fresh`. |

The new manifest source hash is
`sha256:dd5af389b392d0096beff752de3a2ad64a63cd3fc62422035a730d8f485dfc92`. The review record is
still `draft` with `approval: null`, `snapshotHashes` is still empty, and usage is still 0. No
approval, signature, snapshot, status or product usage was fabricated.

**Not run here / residual risk.** Actual Chromium G14 execution, the root fixture's post-fix run,
G13 baselines, browser gates, build and the full gate envelope were not run inside this sandbox.
The worker added and typechecked the two cases but did not execute a browser; the pre-fix red
geometry comes from the root receipt above, and the fixed green must be re-run by the root from
the final pin. The harness case uses a synthetic host wrapper at 358 px, not the full product
viewport; the root's external actual-390 fixture supplies that coverage. The first pinned-Docker
G13 baselines for this component must be generated from the fixed CSS. Host-provided sidebar
content can still scroll inside its own area if it is wider than the sidebar; the shell border
geometry no longer overflows. The component remains a draft with no product host usage approval.

**Commit:** the `fix(ui)` commit that carries this section; no push, merge, rebase or status-file
edit.

## Review fix — P2 app-shell story labels bypass localization

**Status:** fix and focused locale regressions ready; root G15/G13 comparison and the full browser
envelope remain pending. This section is appended evidence; it does not change the original
slice's claims above.

**Finding (root relay of the GPT design review, P2 #1; binding).**
`packages/ui/src/components/app-shell-chrome/app-shell-chrome.stories.tsx` hardcoded seven English
strings in the nested `labels` object. G15 passed only because the Russian and pseudo regimes
rendered the same English text, so real localized clipping was never exercised.

**Fix.** Added seven `story.appShell.*` message keys to `packages/ui/src/i18n/messages.ts`:
English source wording is byte-for-byte the previous control copy, with curated Russian:

| Field | English (source) | Russian |
| --- | --- | --- |
| `show` | Show sidebar | Показать боковую панель |
| `collapse` | Collapse to rail | Свернуть в панель значков |
| `expand` | Expand sidebar | Развернуть боковую панель |
| `hide` | Hide sidebar | Скрыть боковую панель |
| `moveLeft` | Move sidebar left | Переместить панель влево |
| `moveRight` | Move sidebar right | Переместить панель вправо |
| `palette` | Command palette | Палитра команд |

The story `labels` object now uses `msg(...)` for all seven fields; `resolveMessages` recurses
through the nested plain object in both the in-app catalog interpreter and Storybook's default
render. No portable-story type or helper change was needed because `msg()` already returns the
`string` the `AppShellLabels` props require. The component docs exception that allowed synthetic
English control copy was replaced with the actual `story.appShell.*` contract.

No product component behavior, public props, CSS, layout, callbacks, approval record, snapshot or
dependency changed. The generated manifest was rebuilt with `npm run ui:manifest`; only the
component `sourceHash` moved. All 18 `snapshotHashes` remain byte-for-byte unchanged, the review
record is still `draft` with `approval: null`, and signature/status remain `absent`/`draft`.

**New coverage.** One new file, `packages/ui/test/app-shell-story-locales.test.tsx`, with 4 `it`
declarations and 10 runtime cases after the locale/state loops:

- exact English source wording for all seven fields (the negative control against silent copy
  edits that would move the 18 English PNGs);
- RU differs from EN for every field; pseudo is at least +40% longer by the real `pseudoLocalize`
  rule and is recognisably bracketed;
- the actual story module's merged args are rendered through `StoryView` in RU and pseudo for
  `default`, `rail`, `right` and `hidden`; Show/Palette and the menu Move, Collapse/Expand and
  Hide controls are queried by their translated visible/accessible names, not by a key
  dictionary;
- the keyboard path opens the menu from the named trigger, focuses the first item and asserts the
  actual menuitem accessible names and count;
- every raw English label is absent as text and as button/menuitem accessible names in RU and
  pseudo (explicit zero counts), while the translated labels are present in the same tree;
- the hidden story proves Show and Palette remain available while the sidebar is `hidden`/`inert`;
- sensitivity check: restoring only the `hide` literal temporarily produced **7 failed / 3 passed**
  with the English-name assertion; the file was restored before the green run.

**Regression envelope.** The existing `packages/ui/test/app-shell-chrome.test.tsx` (6 runtime
cases) and `packages/ui/test/input-readiness.test.tsx` (1 declaration, EN/RU = 2 runtime cases)
were run unchanged. Combined focused result: **18 passed / 3 files** (10 new + 8 existing). No
Vitest implementation mirror of the story behavior was added; interaction behavior still belongs
to the existing component test.

| Command | Result |
| --- | --- |
| `nice -n 10 npx vitest run test/app-shell-story-locales.test.tsx` in `packages/ui`, before the production edit | RED: 9 failed / 1 passed. The sole pass was the exact-English control; RU/pseudo failed because the literals did not differ. |
| Same file after adding keys and `msg()` refs | PASS: 10 passed / 1 file. |
| `nice -n 10 npx vitest run test/app-shell-story-locales.test.tsx test/app-shell-chrome.test.tsx test/input-readiness.test.tsx` in `packages/ui` | PASS: 18 passed / 3 files. |
| `nice -n 10 npx tsc --noEmit -p packages/ui/tsconfig.json` from the clone root | PASS, exit 0, no diagnostics. |
| `nice -n 10 npx eslint packages/ui/src/components/app-shell-chrome/app-shell-chrome.stories.tsx packages/ui/src/i18n/messages.ts packages/ui/test/app-shell-story-locales.test.tsx` | PASS, exit 0. |
| `nice -n 10 npx markdownlint-cli2 packages/ui/src/components/app-shell-chrome/app-shell-chrome.docs.md docs/plans/lanes/U1-shell-chrome.handoff.md` | PASS, 0 errors. |
| `nice -n 10 npm run ui:manifest` | Wrote the generated manifest. |
| `nice -n 10 node packages/ui/catalog/scripts/build-manifest.ts --check` | `catalog/manifest.json is fresh`, exit 0. |
| `git diff --check` | Clean, exit 0. |

**Not run here / residual risk.** This sandbox did not run `npm run ui:check`,
`npm run ui:check:browser`, G13, G14, G15 browser clipping, G16, `npm test`, `npm run build` or
Storybook. The English images are expected to stay unchanged because the seven source strings are
identical and no CSS/component markup moved, but the root must confirm all 18 G13 PNGs and run
G15 with the now-expanded RU/pseudo labels in a real browser. The pseudo/RU menu labels are
rendered and named in jsdom only; actual menu width, overflow and clipping remain browser proof.
The component is still a `draft` with `approval: null`; no signature, snapshot, status or product
usage was fabricated. P2 #2 (loading/offline semantics) is not part of this fix and remains for a
separate root-owned round.

**Ownership.** The four coordinator-listed paths changed: the story file, `messages.ts`, the new
focused test and the generated manifest. One additional minimal doc line changed in
`packages/ui/src/components/app-shell-chrome/app-shell-chrome.docs.md` because the binding finding
explicitly required removing the "synthetic English" story exception and the file otherwise
belongs to this component folder. No other checkout, PHASE/NEXT/status file, approval record,
snapshot, PNG or lockfile was touched.

**Commits.** `8e79db64b7e064c9f8718315dbadef9ce577874f` is the single coherent fix commit for
this finding; the handoff section is the follow-up docs commit on top of it. The branch is clean
at the handoff commit; root review runs from
`63aa885194676d43a42cc8e4f25f304d1e995626..HEAD`.

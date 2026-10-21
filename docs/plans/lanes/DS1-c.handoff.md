# DS1-c hand-off — lint ratchet and semantic colour migration

**Status:** Review 1 fixes implemented and locally validated; awaiting integrator re-check.
**Date:** 2026-10-21. **Branch:** `lane/ds1-c-ratchet`. **Code:** `fdd0044` (final behaviour revision).
Original base: `2ab9c41`; initial main `9c08e0e` merge: `0c770de`. Review 1 main
`6f3879c` was merged without conflicts by `51043b7`.
No push, rebase, merge into main, signed component edit or central status-file edit was made.
Central tracker changes inherited from main belong to K4/R2, not this lane.

## Delivered

- Repository ESLint flat config, native `eslint-suppressions.json`, and CSS stylelint.
  New dependencies are exact pins: ESLint 10.13.0, TypeScript ESLint parser 8.72.0,
  stylelint 17.16.0. `npm run lint` runs both linters and the history growth audit.
- G8 and G9 are appended as `extensions/lint.gate.mjs`, with independent seeded violations.
  Existing registry entries are unchanged. G17 rejects both seeds through the real checkers.
- G8 checks static imports/exports, constant templates and bound import paths, TypeScript
  external references, dynamic imports and CommonJS requires. Public package exports remain
  usable; UI internals and direct underlying-library imports fail in feature/plugin code.
- G9 checks raw controls, element factories and aliases, inline colour properties, same-file
  style objects, known props spreads, and unresolved style objects. Runtime geometry is allowed.
  The legacy `components/ui.tsx` inline debt is frozen in native suppressions, with no G6
  ratchet correction. Its 7 literal-style suppressions cover Select/Switch/Chevron geometry;
  its 7 inline-colour suppressions include Spinner's border colour, dynamic colours and the
  embedded SVG image. Spinner's computed border width and size-derived dimensions remain
  runtime geometry; the lint does not evaluate their arithmetic.
- Supplemental lint covers N5's arbitrary/numbered-palette literals in exported class maps and
  joined arrays; N8's stop/mask/WebKit/text-decoration/column-rule colours and transition
  precision; D2's bound same-file styles and SVG/HTML `style=` and paint attributes.
- The suppression audit checks every actual Git parent edge and the working tree. It rejects
  new/increased entries, removed/recreated ledgers, restored merge budgets and shallow history.
  Native pruning and exact current error counts prevent unused budget. A CLI mutation test
  adds a suppression and asserts exit 1. No exception or correction list was added.
- The app imports `@guanxi/ui/tokens.css` and `@guanxi/ui/theme.css`. All ten aliases actually
  present in the temporary bridge, including radius/type aliases, are gone. Assertions reject
  the bridge and every copied bridge alias, and compile the real imported stylesheets.
- An app-only default-priority Tailwind theme import preserves frozen legacy type/radius/material
  utilities until U1. It does not override explicit generated mappings. Regression assertions
  check legacy CSS equality, every retained compilable class, generated mappings and grid
  spacing, and rejection of new legacy/palette uses by the generated-only G5 theme.

## Initial delivery: codemod and remaining debt

Command: `npm run codemod:semantic -- --write`. Omit `--write` to preview.
The codemod derives utility names from generated theme aliases and uses documented legacy
roles; it preserves variants, opacity, important markers, quoting and template branches.
One-variable classes without a role-equivalent alias are reported, never guessed. Compound
values/fallbacks are left alone. Unit tests cover determinism, idempotence and unsupported forms.

The ADR's 683 counts **all** `[var(--` classes at base `2ab9c41`, rather than
backgrounds alone. The original pass removed 591, leaving 92:

| Measurement | Before | After |
| --- | ---: | ---: |
| `bg-[var(--` occurrences in web source | 133 | 31 |
| All `[var(--` occurrences (initial migration) | 683 | 92 |
| Total mapped bg/text/border/ring occurrences | 591 | 0 remaining mapped uses |
| Files touched by the codemod | 37 | 0 on the second write run |
| DS1-a G5 allowance occurrences | 1,543 | 952 |
| DS1-a G6 / G7 occurrences | 152 / 17 | 152 / 17 |
| DS1-a total occurrences | 1,712 | 1,121 |

The final repeat run reports 31 backgrounds before/after, zero replacements and zero changed
files; `git diff --exit-code` stays clean. The committed
[`semantic-colours.report.json`](../../../scripts/codemods/semantic-colours.report.json)
records the first run, every touched path, and all 92 residual occurrences (including the nine outline/accent/shadow uses
omitted from the initial report) with file/line.
These include fit colours, subtle accent fills, accent text/borders, status backgrounds/borders,
and text/background uses of border or tertiary-text variables without corresponding aliases.
Some runtime tokens already exist; extending the utility aliases still needs an explicit mapping.

| ESLint native suppression rule | Initial | Remaining |
| --- | ---: | ---: |
| `semantic-classes` | 733 | 142 |
| `no-inline-colours` | 32 | 28 |
| `no-literal-styles` | 8 | 8 |
| `no-literal-css` | 152 | 152 |
| `reuse-primitives` | 38 | 38 |
| `import-boundaries` | 3 | 1 |
| Total | 966 | 369 |

**U1 colour exit is not ready.** G9 reports `u1ColourExitReady: false` and lists all 330
counts across the conservative colour-related rules. These overlap and include some geometry;
they are not 330 distinct colour sites. Full per-file counts live in
[`eslint-suppressions.json`](../../../eslint-suppressions.json). The remaining G8 import is
`features/projects/ProjectIcon.tsx` using the underlying icon library.

## Review findings and fixes

A separate read-only reviewer inspected the implementation and independently replayed all
591 edits against the baseline. Review fixes are separate commits:

| Finding | Resolution |
| --- | --- |
| Generated theme removed still-used legacy defaults | `e5b8887`: app-only compatibility import and compiler regression assertions. |
| G8 template/bound/TS external imports bypassed lint | `e5b8887`: resolve these forms; regression cases fail. |
| G9 known props spreads, factories, aliases and destructuring bypassed lint | `e5b8887`: reject them; also cover template geometry and additional colour shorthands. |
| Public package exports were classified as internal | `e5b8887`: allow declared public exports, retiring two unnecessary suppressions. |
| Vite's broad root alias broke public CSS imports | `32893de`: anchored root/catalog aliases; actual Vite resolver assertion and broad-alias mutation. |
| Migrated history metadata had 4.35:1 contrast on inset | `5a001d5`: one class uses `text-secondary`, giving 6.90:1; markup and behaviour stay unchanged. |
| Font/spacing test compared `.25rem` with `4px` as text | `5a001d5`: compare the resolved length and explicitly assert 4 px; fonts/padding/gap assertions remain. |

The reviewer independently verified every fix and reported no remaining blocker in the
reviewed changes. No reviewer edited files or ran heavy checks. The integrator subsequently ran cross-family Review 1; its fixes and final results are below.

At initial delivery, fresh author diff review confirmed all 37 files are exact codemod output except the single
documented `ChatPage.tsx` metadata colour correction. No JSX structure or component behaviour
changed. The axe flow test and its known-violation allowance are byte-unchanged. No class
selectors needed edits. The font comparison fixture's stylesheet import selectors were updated
to remove both public design-system imports; it now rejects a missing selector rather than
silently building an identical baseline. Spacing is normalized to a resolved length.

## Initial delivery: new / regression envelope and commands

**New:** 19 Node tests: 13 lint/ratchet, 2 foundation integration, 4 codemod.
**Regression envelope:** 51 existing fast gate tests, plus all existing server/CLI/kernel,
web component and UI catalog/component suites. The existing K1 bridge assertion was strengthened.
Browser: 0 new / 65 existing mocked Chromium tests, with one existing font fixture maintained.
The catalog browser checks retain their existing visual/accessibility/i18n/motion scope.
No live model, GPU inference, production, manual screen-reader or complete device matrix is claimed.

`npm ci` ran first. Contract resolution printed this worktree's
`packages/contract/src/index.ts`, also reconfirmed after dependency installation.
All checks target the current Mac, Node 26.9.0, with:

```bash
export GUANXI_WEB_PORT=5184 GUANXI_API_PORT=4384 GUANXI_DATA_DIR="$PWD/.lane-data"
```

Direct logs are under `.lane-data/`. Heavy commands each use:

```bash
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- <command>
```

| Command | Final result / evidence |
| --- | --- |
| `npm run typecheck` | Passed all workspaces; `typecheck.log`. |
| `npm run lint` | Passed ESLint, stylelint and growth audit; `lint.log`. Four pre-existing disabled-directive warnings have no effect under `noInlineConfig`. |
| `npm run ui:check` | Fast registered gates and their G17 seeds pass; G9 explicitly reports U1 not ready; `ui-check.log`. |
| `npm run check:licenses` | 657 packages, zero not allowed; `licenses.log`. |
| `npm run lint:md` | Passed, including this final hand-off; `markdown.log`. |
| Locked `npm test` | All root suites pass, including 66 fast gate and 4 codemod tests; `check-bw5zc7_u/result.json`. |
| Locked `npm run test:web:browser` | 65 passed; `check-oq31wqxj/result.json`. |
| Locked `npm run ui:check:browser` | G13, G14, G15-clipping, G16 and G17 pass without warnings/skips; `check-utoqrbyi/result.json`. |
| Locked `npm run build` | Web, server and CLI builds pass; `check-hz682kbx/result.json`. |

Receipt paths above are under `/Users/yuzuru/.local/state/agent-dev/`. Final receipts have
exit 0 and no capture errors. The existing `.claude/skills/guanxi-ui` symlink prevents reusable
source certification; receipts are local execution evidence, not source-bound certification.
Only hand-off documentation changes after the final source checks.

Earlier failures are resolved, not classified as flakes: the first browser run was interrupted
after the Vite import error (`check-uemv5htl`, exit 130); the next finished 63/65
(`check-zfasqkmm`, exit 1) with the two documented failures. Final Chromium rerun passed 65/65.
No later heavy command ran after an unresolved failure; fixes preceded the next check.

## Every codemod-touched file

```text
packages/web/src/App.tsx
packages/web/src/components/ErrorBoundary.tsx
packages/web/src/components/ui.tsx
packages/web/src/features/agent/ApprovalPrompt.tsx
packages/web/src/features/agent/DiffViewer.tsx
packages/web/src/features/agent/ToolCallCard.tsx
packages/web/src/features/agent/WorkspacePicker.tsx
packages/web/src/features/attachments/AttachmentsPage.tsx
packages/web/src/features/chat/ChatPage.tsx
packages/web/src/features/chat/ChatReasoningArtifacts.tsx
packages/web/src/features/chat/ChatRetentionInfo.tsx
packages/web/src/features/chat/ChatTrashList.tsx
packages/web/src/features/chat/ResourceConflictDecision.tsx
packages/web/src/features/context/ContextPanel.tsx
packages/web/src/features/health/HealthGate.tsx
packages/web/src/features/health/RuntimeStatus.tsx
packages/web/src/features/launcher/LauncherPage.tsx
packages/web/src/features/models/AddFromOllama.tsx
packages/web/src/features/models/CapabilityOverrides.tsx
packages/web/src/features/models/CatalogCompare.tsx
packages/web/src/features/models/CatalogFilters.tsx
packages/web/src/features/models/CatalogVariantInstall.tsx
packages/web/src/features/models/CompletionProbe.tsx
packages/web/src/features/models/FitIndicator.tsx
packages/web/src/features/models/HuggingFaceDiscovery.tsx
packages/web/src/features/models/HuggingFaceImportControl.tsx
packages/web/src/features/models/InstalledEvidence.tsx
packages/web/src/features/models/ModelCard.tsx
packages/web/src/features/models/ModelCarousel.tsx
packages/web/src/features/models/ModelPage.tsx
packages/web/src/features/models/PullControl.tsx
packages/web/src/features/projects/ProjectPresentationPicker.tsx
packages/web/src/features/projects/ProjectsPage.tsx
packages/web/src/features/quick-runs/QuickRunsPage.tsx
packages/web/src/features/recipes/RecipesPage.tsx
packages/web/src/features/settings/Glossary.tsx
packages/web/src/features/settings/SettingsPage.tsx
```

## Shared edits, residuals and next step

Shared edits outside the strict owned list: root `package.json`/generated `package-lock.json`
for pinned tools and test commands; the existing foundation test and shrinking DS1-a ledger;
`packages/ui/tokens/README.md` for bridge reconciliation; `packages/ui/gates/README.md`
for the lint/gate usage contract; `packages/web/vite.config.ts` for
public stylesheet resolution; and the existing `local-fonts.spec.ts` fixture/normalization.
`index.css` is the explicitly requested bridge follow-up. The one manual history class
correction is within the already migrated source. No `packages/ui/src` file changed.

Residual static limits: runtime-built class/module fragments, imported or computed style-value
contents, unknown whole-props spreads, DOM style mutations, colour-concealing custom property
names, and cross-module unknown/non-colour utility validation still need review/migration.
The lexical fallback covers arbitrary and numbered-palette literals, while full compiled-class
and spacing validation remains in the existing per-file G5 scanner. Native suppression
budgets track counts per file/rule, not statement identity. The legacy font and runtime-colour
definitions and default-priority compatibility import remain U1 work. No new token values,
component design, approval records or ratchet correction were introduced.

Original next step was the integrator review; Review 1 is now addressed below. The integrator
merges in lane order without squashing the ratchet history and reruns its gates. Fold this evidence
into the central tracker at integration. U1 must resolve the reported aliases and remaining
colour debt, migrate raw primitives and other frozen utilities, then retire compatibility CSS.

## Visible changes (L7)

The generated theme changes the legacy blue accent (264° OKLCH hue) to verdigris
(about 178°), neutral surfaces to Glacier/brand ink, and control borders to step 9.
Review 1 aligns the body, default borders, focus ring and scrollbars with that palette,
strengthens inset metadata/placeholders to secondary text, and restores ToolCallCard's
inset-to-surface hover. Subtle blue fills now use the semantic accent at 10% opacity;
previous extra 50%/55% opacity becomes 5%/5.5% respectively. These are visible changes.

Theme import also replaces Tailwind's default transition easing with
`motion.easing.standard` and makes its duration zero under reduced motion. Previously
uncompiled InspectorPage classes now render: `text-13`, `text-14`, `font-label`,
`bg-success` and `bg-muted`; NativeAgentPage's `text-18` now renders too. This is an
intentional consequence of loading the existing generated theme, not a component redesign.

## Review 1 fixes

The cross-family review covered `0def92c`. The following supersedes the initial-delivery
status and counts above. Current main `6f3879c` was merged by `51043b7` (two parents, no
rebase). Fresh author review then added the separate fixes listed below. Shared UI
component sources and token values are unchanged.

| Finding | Status and evidence |
| --- | --- |
| H1 | Fixed in `f313989`: contextual codemod promotion, 43 JSX text sites and the input placeholder; G9 and source assertion reject static muted-on-inset. Original probe now returns zero. Secondary/inset is 6.90:1 light and 9.09:1 dark. |
| M1 | Fixed in `f9ea8a0`: overlaid raw buttons with matching added/grown ledger counts fail both G8 and G9 with `grew`, through the same gates run by `npm test`. |
| M2 | Fixed in `d12c47a`: every discovered feature/plugin JS/TS source must be unignored and enable all five rules at severity 2. Seeded global ignores and each severity downgrade fail both gates. |
| M3 | Fixed in `f50c73e`: capitalised literal tag bindings, alias chains, polymorphic defaults and raw style elements fail G9. `922f98f` scopes default resolution to JSX so runtime geometry does not create new debt. |
| M4 | Fixed in `95b2e31`: semantic base palette, retained aliases, focus/badge/control mappings, distinct ToolCallCard hover, mapping provenance and full residual report. Further contrast fixes are recorded below. |
| L1 | Fixed in `475504d`: parse-error counts use the normalized id and fail both gates. |
| L2 | Listed static forms fixed in `6e7fbd5`: node_modules paths, web alias traversal, concatenated imports, aliased require/createRequire and literal glob paths/arrays. Runtime fragments remain the named L2 residual below. |
| L3 | Fixed in `3439ced`: mauve/olive/mist/taupe and black/white literals in exported maps are rejected. |
| L4 | Fixed in `54493d7`: source test/spec names retain every G8/G9 rule; Vitest still collects only its test tree. |
| L5 | Fixed in `95b73ba`: six independently seeded survivor tests; the opt-in mutation runner kills all six. M1 separately kills removal of the gate audit. |
| L6 | Fixed in `8a05038` and `794d4cc`: baseline 683 counts all variable classes, including 133 backgrounds; initial pass removes 591, leaving 92 residuals. Nine omitted outline/accent/shadow cases are restored to the initial report and the scanner now inventories those prefixes. Canonical wording reconciled. |
| L7 | Visible changes disclosed above and below; generated size/weight/status utilities have explicit compilation assertions (`794d4cc`). |
| L8 | Fixed in `8cfb138`: shared gate README listed, Vitest aliases anchored, both native and DS1-a history audits use `GIT_NO_REPLACE_OBJECTS=1`; graft and resolver tests fail when protections are removed. |

### Fresh self-review and failures resolved

- `4bc57de`: existing M4 tests did not protect retained alias definitions in both themes.
  Restoring the old blue accent now fails an explicit alias assertion.
- `c32aa49`: stricter L3 exposed three existing black/white uses. The switch thumb now uses
  on-accent text when checked and primary text otherwise. Two modal shells use a pseudo-layer
  with the existing ink/32% scrim tokens; only the background is dimmed. This visibly replaces
  the old 55%/45% black overlays. No suppression was added.
- `fdd0044`: soft accent text measured 4.48:1 over the 10% accent fill on light canvas;
  secondary labels now pass on canvas, surface and inset in both themes. The first Chromium
  run also caught checkpoint-cost metadata over the old 8% fit-yellow fill after the body
  palette changed. That text now uses secondary. The existing axe flow and its exact cache-bar
  allowance remain unchanged; the new regression checks both themes and all three surfaces.

### Mutation evidence

Each row was run with the named production guard removed (or the bad source value restored),
then restored before the passing regression run. Every mutation exited 1 with AssertionError;
none was a syntax/import failure. Logs are in `.lane-data/review1/` (untracked).

| Removed protection / mutation | Failing assertion |
| --- | --- |
| H1 codemod inset promotion | Expected descendant and placeholder `text-secondary`, got `text-muted`. |
| H1 input placeholder restored | Source assertion reports `ui.tsx:283` instead of an empty hit list. |
| H1 G9 contrast errors omitted | Seeded contrast result `ok` becomes true; expected false. |
| M1 gate audit removed | G8 must reject ledger growth 1: true instead of false. |
| M2 config errors omitted | Seeded ignored-file G8 result becomes true. |
| M3 capitalised tag resolution removed | `const Tag = 'button'; <Tag/>` has no reuse-primitives error. |
| M3 style removed from raw regex | Style-element fixture has no reuse-primitives error. |
| M4 body reverted to legacy variable | Body background must be `var(--color-background-primary)`. |
| M4 ToolCallCard hover reverted | Inset rest state must have surface hover. |
| L1 normalized parse id removed | G8 must reject malformed JSX: true instead of false. |
| L2 loader resolver removed | Aliased require has no import-boundaries error. |
| L3 new palette names removed | Exported `bg-mauve-500` has no semantic-classes error. |
| L4 source test-name exemption restored | a.spec.tsx has no import-boundaries error. |
| L5 SVG paint loop removed | Standalone `fill` fixture has no svg-styles error. |
| L5 custom-property colour guard removed | `--paint-colour` has no no-inline-colours error. |
| L5 require.resolve guard removed | require.resolve fixture has no import-boundaries error. |
| L5 brand traversal guard removed | brand/logo/../../src fixture has no import-boundaries error. |
| L5 ledger path restriction removed | Plugin ledger path no longer reports invalid legacy path. |
| L5 plugin disk discovery removed | G8 must discover the disk plugin: true instead of false. |
| L6 prefix inventory narrowed | Expected three residual classes, got an empty list. |
| L7 generated theme import removed | Retained generated utilities disappear. |
| L8 Git replacement protection removed | Committed growth hidden by graft is no longer reported. |
| L8 broad Vitest root alias restored | theme.css resolves under src/index.ts instead of generated/theme.css. |
| Self-review legacy blue alias restored | Both theme aliases must resolve to the semantic palette. |
| Self-review black overlay restored | Source must contain no black/white palette utility. |
| Self-review soft accent label restored | Badge must use secondary text. |
| Self-review checkpoint muted label restored | Checkpoint cost must retain secondary text on its fit fill. |

Reproduce the six original survivors with
`node packages/ui/gates/review1-mutations.mjs`. Focused assertions live in
`lint.test.mjs`, `inset-contrast.test.mjs`, `foundations.test.mjs`, `ratchet.test.mjs` and
`scripts/codemods/semantic-colours.test.mjs`.

### Before/after palette

The first fifteen rows are the original codemod role pairs; the rest are Review 1's mechanical
extensions. Values are rendered hex values from base `2ab9c41` and current generated tokens.
D means FOUNDATIONS; K1 means SidebarSlot and its foundation integration assertion. K1
establishes four pairs. The other legacy-to-role choices are DS1-c interpretations of usage in
`web/src/index.css`; FOUNDATIONS supplies target roles/values, not a legacy-variable table.
The generated theme supplies every utility alias.

| Legacy variable / role | New utility | Light before → after | Dark before → after | Mapping source |
| --- | --- | --- | --- | --- |
| `--bg` / bg | `bg-canvas` | #F9FAFB → #EBF4F5 | #0E0F13 → #182322 | D §1.1 |
| `--bg-raised` / bg | `bg-surface` | #FFF → #F3FCFE | #1B1D22 → #0F1A19 | D §1.1 |
| `--bg-inset` / bg | `bg-inset` | #E9EBEE → #E2EBED | #08090C → #1F2A29 | K1 + D §1.1 |
| `--bg-subtle` / bg | `bg-inset` | #F0F2F4 → #E2EBED | #14161A → #1F2A29 | D §1.1 (collapsed fill) |
| `--accent` / bg | `bg-accent` | #3266E4 → #187363 | #6594FA → #78CAB7 | D §1.2 |
| `--fg` / text | `text-foreground` | #1C1F24 → #182322 | #E6E8EC → #EEF5F6 | K1 + D §1.1 |
| `--fg-muted` / text | `text-secondary` | #5F636A → #445051 | #9B9EA6 → #C3CDCC | K1 + D §1.1 |
| `--fg-subtle` / text | `text-muted` | #66696F → #626E70 | #83868E → #A3ADAC | D §1.1; H1 uses secondary on inset |
| `--accent-fg` / text | `text-accent-foreground` | #FCFCFC → #F3FCFE | #0B0D12 → #182322 | D §1.2 |
| `--danger` / text | `text-danger` | #D01C29 → #BA362E | #F75D59 → #FD8C7E | D §1.2 |
| `--warning` / text | `text-warning` | #925B0C → #925B0C | #F0BA59 → #F0BA59 | D §1.2 (already semantic) |
| `--border` / border | `border-divider` | #D9DBDE → #B3C1C3 | #2B2E34 → #414D4C | K1 + D §1.1 |
| `--border-strong` / border | `border-control` | #BBBEC3 → #768385 | #444850 → #798281 | D §1.1 |
| `--focus` / ring | `ring-focus` | #187363 → #187363 | #78CAB7 → #78CAB7 | D §1.3 (already semantic) |
| `--accent` / ring | `ring-focus` | #3266E4 → #187363 | #6594FA → #78CAB7 | D §1.3 |
| `--danger` / bg | `bg-danger` | #D01C29 → #BA362E | #F75D59 → #FD8C7E | Role equality test + D §1.2 |
| `--fg-subtle` / bg | `bg-muted` | #66696F → #626E70 | #83868E → #A3ADAC | Existing progress fills + D §1.1 |
| `--border-strong` / bg | `bg-control` | #BBBEC3 → #768385 | #444850 → #798281 | Existing carousel marker + D §1.1 |
| `--accent` / text | `text-accent` | #3266E4 → #187363 | #6594FA → #78CAB7 | Role equality test + D §1.2 |
| `--border-strong` / text | `text-control` | #BBBEC3 → #768385 | #444850 → #798281 | Existing separator dots + D §1.1 |
| `--accent` / border | `border-accent` | #3266E4 → #187363 | #6594FA → #78CAB7 | Role equality test + D §1.2 |
| `--danger` / border | `border-danger` | #D01C29 → #BA362E | #F75D59 → #FD8C7E | Role equality test + D §1.2 |
| `--warning` / border | `border-warning` | #925B0C → #925B0C | #F0BA59 → #F0BA59 | Role equality test + D §1.2 |
| `--accent` / outline | `outline-focus` | #3266E4 → #187363 | #6594FA → #78CAB7 | D §1.3 focus role |
| `--focus` / outline | `outline-focus` | #187363 → #187363 | #78CAB7 → #78CAB7 | D §1.3 focus role |
| `--accent` / accent | `accent-accent` | #3266E4 → #187363 | #6594FA → #78CAB7 | Native control accent + D §1.2 |

H1 uses `text-secondary` instead of `text-muted` on inset: light #66696F → #445051,
dark #83868E → #C3CDCC. Retained CSS `--fg-subtle` consumers also use secondary for safe
code-comment/scrollbar contrast. Soft accent labels use secondary after the self-review.
`--accent-subtle` fills become `bg-accent/10`; old extra opacity 50%/55% multiplies to 5%/5.5%.
No new token values or shared UI component changes were made.

### Current counts and named U1 residuals

At the final source revision, all variable arbitrary classes fell 683 → 41, backgrounds
133 → 15. Repeat codemod write: 0 replacements, 0 files, backgrounds 15 → 15. The initial
report preserves 591 replacements and the corrected 92 residuals; the Review 1 report records
41 additional replacements, with ten subtle-fill rewrites performed separately. H1's 44
foreground promotions do not change the variable-class count. Both report files list paths.

Native suppressions fell 369 → 293: semantic classes 91, inline colours 28, literal styles 8,
literal CSS 127, raw primitives 38, import boundaries 1. Colour-related counts total 254,
not distinct sites. G9 still reports `u1ColourExitReady: false`. DS1-a allowances are now
G5 898 / G6 127 / G7 17 (1,042 total), down from the initial delivery's 1,121.

- **U1-fit-palette:** 37 remaining fit-green/yellow/red variable classes and the legacy fit
  definitions/inline consumers. These are explicit residual palette debt, not semantic migration.
- **U1-syntax-and-effects:** twelve highlight syntax literals, sheen white and four legacy
  `shadow-card` classes plus its black shadow definitions still use old colours. The unused
  `--accent-subtle` blue definitions remain inert compatibility debt; no source references them.
- **U1-legacy-style-and-components:** frozen inline colours/raw primitives, Select's embedded
  SVG, geometry/type/radius defaults and the app-only Tailwind compatibility import remain.
  Retained old variable names now resolve to the semantic palette; they are migration debt.
- **L2-runtime-import-fragments:** interpolated/dynamic module fragments, reassigned bindings,
  custom loaders and runtime-computed globs are outside the literal resolver. Listed static
  concatenation, loader aliases and literal globs are covered. L3 has no listed residual.
- **U1-static-style-boundaries:** JSX ancestry and named class constants are checked, with
  conservative conditional handling. Computed/imported class fragments, component-boundary
  inheritance, DOM style mutation, unknown whole-props spreads and colour-concealing custom
  property names require runtime/manual review. Native budgets count file/rule errors, not sites.
- **U1-known-cache-bar:** the pre-existing two dimmed inactive cache-bar contrast targets remain
  the exact allowance in the unchanged axe flow; no new axe allowance was introduced.

### New / regression envelope and final commands

**New relative to Review 1:** 25 Node tests: 14 lint, 3 contrast, 5 foundations,
1 legacy-audit graft and 2 codemod. **Regression envelope:** the 70 pre-existing Node fast
checker/codemod tests (89 gate tests + 6 codemod tests now pass in total), plus the existing
server/CLI/kernel, 35 web component/unit files and UI component/catalog suites. The existing
suppression/native-equivalence and theme-compilation assertions were strengthened. The sole
core skip is the existing opt-in throwaway macOS keychain round trip. Browser scope stays
0 new / 65 mocked Chromium regressions, including both app axe flows and their seeds.
Catalog browser checks retain their visual/accessibility/i18n/reduced-motion scope.

All commands use Node 26.9.0 on the current Mac with ports 5184/4384 and
`GUANXI_DATA_DIR="$PWD/.lane-data"`. Direct checks: typecheck, lint, lint:md,
check:licenses (657 packages, 0 disallowed) and ui:check passed. Four existing noInlineConfig
warnings remain; no lint errors. Heavy commands use exactly:

```bash
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- <command>
```

| Heavy command | Result | Local receipt |
| --- | --- | --- |
| `npm test` | pass; 89 fast gate tests + 6 codemod tests, existing suites pass | `check-f69mgu9y/result.json` |
| `npm run test:web:browser` | 65/65 pass; app axe flows and seeds pass | `check-f2m_o96r/result.json` |
| `npm run ui:check:browser` | G13/G14/G15-clipping/G16 and G17 pass; no skips | `check-tvhhxqmq/result.json` |
| `npm run build` | pass | `check-4twbo0qd/result.json` |

Receipt directories are under `/Users/yuzuru/.local/state/agent-dev/`.

Heavy receipts target code `fdd0044`; they record locks and successful child exits. The
existing external `.claude/skills/guanxi-ui` symlink makes agent-dev source attestation
non-reusable (`source_verifiable: false`), so these are local command results, not portable
source-bound receipts. The final commit changes this hand-off only.

The first browser receipt `check-61z86cjo` was 64/65 (checkpoint contrast), not a flake;
`fdd0044` fixes it and the final full rerun is 65/65. Earlier direct lint failures exposed
the three now-retired palette literals; a later Markdown lint attempt also saw generated
failure-artifact Markdown, which was moved outside the checkout. Final direct reruns pass.
No later heavy stage ran while an earlier failure remained unresolved.

Additional shared edits in this fix round: `packages/web/vitest.config.ts` (public exports),
`packages/ui/gates/ratchet.mjs` and its test (Git replacement guard), and the ADR-0034 / component
catalog count corrections. `packages/ui/gates/README.md` remains part of the original shared
edit list. No component review records, shared UI sources, token sources or generated token
outputs were edited.

### Web source paths changed by Review 1

```text
packages/web/src/App.tsx
packages/web/src/components/ui.tsx
packages/web/src/features/agent/DiffViewer.tsx
packages/web/src/features/agent/ToolCallCard.tsx
packages/web/src/features/agent/WorkspacePicker.tsx
packages/web/src/features/attachments/AttachmentsPage.tsx
packages/web/src/features/chat/ChatPage.tsx
packages/web/src/features/chat/ChatRetentionInfo.tsx
packages/web/src/features/context/ContextPanel.tsx
packages/web/src/features/health/HealthGate.tsx
packages/web/src/features/health/RuntimeStatus.tsx
packages/web/src/features/inspector/InspectorPage.tsx
packages/web/src/features/models/AddFromOllama.tsx
packages/web/src/features/models/CapabilityOverrides.tsx
packages/web/src/features/models/CatalogFilters.tsx
packages/web/src/features/models/CatalogVariantInstall.tsx
packages/web/src/features/models/FitIndicator.tsx
packages/web/src/features/models/HuggingFaceDiscovery.tsx
packages/web/src/features/models/HuggingFaceImportControl.tsx
packages/web/src/features/models/InstalledEvidence.tsx
packages/web/src/features/models/ModelCard.tsx
packages/web/src/features/models/ModelCarousel.tsx
packages/web/src/features/models/ModelPage.tsx
packages/web/src/features/projects/ProjectPresentationPicker.tsx
packages/web/src/features/projects/ProjectsPage.tsx
packages/web/src/features/recipes/RecipesPage.tsx
packages/web/src/index.css
```

Next: integrator re-checks Review 1 fixes and merges the lane without squashing the ratchet
history, then folds this evidence into the central trackers. U1 owns the named palette,
primitive, compatibility and runtime-analysis residuals. No push or merge into main was made.

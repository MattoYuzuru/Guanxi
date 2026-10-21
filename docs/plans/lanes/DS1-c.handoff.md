# DS1-c hand-off — lint ratchet and semantic colour migration

**Status:** implemented and locally validated; ready for the integrator's Claude review.
**Date:** 2026-10-21. **Branch:** `lane/ds1-c-ratchet`. **Code:** `5a001d5`.
Original base: `2ab9c41`. Current main `9c08e0e` was merged without conflicts by `0c770de`.
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

## Codemod and remaining debt

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
reviewed changes. No reviewer edited files or ran heavy checks. The integrator's Claude
cross-family review remains the next step.

Fresh author diff review confirms all 37 files are exact codemod output except the single
documented `ChatPage.tsx` metadata colour correction. No JSX structure or component behaviour
changed. The axe flow test and its known-violation allowance are byte-unchanged. No class
selectors needed edits. The font comparison fixture's stylesheet import selectors were updated
to remove both public design-system imports; it now rejects a missing selector rather than
silently building an identical baseline. Spacing is normalized to a resolved length.

## New / regression envelope and commands

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

Next: integrator arranges the Claude review, merges in lane order without squashing the
ratchet history, regenerates the lockfile if needed and reruns its gates. Fold this evidence
into the central tracker at integration. U1 must resolve the reported aliases and remaining
colour debt, migrate raw primitives and other frozen utilities, then retire compatibility CSS.

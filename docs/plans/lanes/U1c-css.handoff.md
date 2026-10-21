# U1-c CSS typography, focus and motion migration

**Status:** locally checked; independent root review pending · **Date:** 2026-10-22

Branch `codex/u1c-css`, base `af6f7fb`. The behavior, test and suppression changes are in
`4a20756`; this handoff is a separate documentation commit. No push, merge, rebase, generated
asset or approval record was written.

## Delivered

The legacy root stylesheet now consumes the already-generated U1 tokens. No token value was
invented or edited.

| Location | Change |
| --- | --- |
| `@theme` | `--font-sans` → `var(--font-family-sans)`; `--font-mono` → `var(--font-family-mono)` |
| `body` | `13px` → `var(--font-text-size)`; `1.5` → `var(--font-line-height-ui)` |
| `:focus-visible` | offset `2px` → `var(--focus-ring-offset)`; radius `3px` → `var(--border-radius-inline)` (the intended standard 6 px) |
| `.anim-spin` | `0.7s linear` → `var(--motion-duration-loop) var(--motion-easing-linear)` |
| `.anim-pulse-soft` | `1.6s ease-in-out` → `var(--motion-duration-loop) var(--motion-easing-standard)` |
| `.anim-fade-up` | `0.16s ease-out` → `var(--motion-duration-moderate) var(--motion-easing-enter)` |
| `guanxi-fade-up` from | `translateY(4px)` → `translateY(var(--motion-distance-sm))` |
| `.stream-caret::after` | `1.05s` → `var(--motion-duration-loop)`; `step-end` is preserved because no step timing token exists |
| `.sheen::after` | `1.4s ease-in-out` → `var(--motion-duration-loop) var(--motion-easing-standard)` |
| Reduced motion | durations/counts replaced with `animation: none !important` and `transition: none !important` |

The touched root comment is now English and states that body text comes from
`--font-text-size`. Unrelated Russian comments, fit colours, syntax colours, legacy aliases,
project-chip colours, markdown sizing and all other CSS are unchanged.

Files changed against the base:

- `packages/web/src/index.css`
- new `packages/ui/gates/u1c-css.test.mjs`
- the exact `packages/web/src/index.css` `guanxi/no-literal-css` count in
  `eslint-suppressions.json`
- this handoff

No UI component, story, review status, approval record, layout, federation or `App` file changed.

## New tests / regression envelope

**New:** 4 focused Node cases in `packages/ui/gates/u1c-css.test.mjs`. They parse the real
stylesheet with the already-declared `postcss` dependency and assert the exact token mappings,
the fade distance, the preserved caret step timing, absence of stale raw font/motion values in
the migrated declarations, and reduced motion as `animation: none !important` plus
`transition: none !important`. The file is picked up by
`npm run test:gates --workspace @guanxi/ui` (`node --test gates/*.test.mjs`).

**Regression envelope:** none was run by this sandboxed worker. Per lane policy the root
coordinator owns full `npm test`, browser, build, Storybook, UI and Chromium computed-style
checks. This handoff does not claim them.

Sensitivity check: a temporary copy of the same test pointed at the pre-change
`af6f7fb` stylesheet failed all 4 cases. The temporary files were removed; the checkout was not
modified by that check.

## Executed checks

All commands ran in this standalone clone under `nice -n 10`.

| Command | Result |
| --- | --- |
| `node -e "console.log(require.resolve('@guanxi/contract'))"` | local `packages/contract/src/index.ts` in this clone |
| `node --test packages/ui/gates/u1c-css.test.mjs` | 4 pass, 0 fail |
| `npx eslint packages/web/src/index.css` | exit 0 |
| `npx stylelint packages/web/src/index.css` | exit 0 |
| `npx tsc --noEmit -p packages/web/tsconfig.json` | exit 0 |

The suppression count was checked without editing unrelated entries: a temporary copy of
`eslint-suppressions.json` was passed via `--suppressions-location` with
`--prune-suppressions`, and the file entry stayed at exactly 117. The committed file still has
only the one assigned hunk (`127` → `117`); 117 literal-CSS findings remain. This is not zero
suppression and does not claim it.

## Residuals

- Root GPT independently reviews this diff and runs the full gates and real Chromium
  computed-font/reduced-motion checks; this worker does not claim those results.
- The focus radius change from 3 px to the standard inline radius of 6 px is intentional and
  visible.
- The caret keeps `step-end` until a step timing token exists; only its duration is tokenized.
- The remaining 117 literal-CSS findings and all untouched legacy CSS are outside this slice.
- No browser, visual, screen-reader or performance verification was performed here.

## Review-fix (2026-10-22)

The previous same-policy attempt exited after reporting a red test, but the actual checkout was
clean: `git status --porcelain` was empty and HEAD was `4a20756` on `codex/u1c-css`, with exactly
the three intended paths changed against `af6f7fb`. No untracked edits were assumed or recovered.

Fresh verification could not reproduce the reported red test at `4a20756`: the focused file
passed 4/4. The test was then shown to fail 4/4 against the `af6f7fb` CSS, so it is not vacuous.
The exact pruned suppression count is 117, and scoped ESLint, stylelint and web `tsc` all pass.
No production or test defect was found in this round, so there is no additional behavior/test
fix commit: `4a20756` already carries the behavior, test and suppression changes. This handoff
commit records the evidence. No historical handoff existed, and no historical claim was
rewritten.

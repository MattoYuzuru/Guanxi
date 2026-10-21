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

## Independent-review fixes (2026-10-22)

Two confirmed U1c integration findings from the independent root review were fixed in separate
commits on `codex/u1c-css` after `08b8b70`. The original three mapping cases in the Node gate
are unchanged; the fourth reduced-motion case is strengthened. No other product CSS, generated
file, snapshot or approval record was touched.

### P2a — obsolete legacy font freeze (`4d37ab6`)

`packages/web/test/browser/local-fonts.spec.ts`:

- Replaced `H2: importing runtime tokens preserves legacy computed fonts and spacing` with
  `H2: built app applies IBM Plex typography, density type size and spacing`. The old case
  asserted `Inter`/`SF Mono` against a synthetic legacy build, which contradicts the approved
  IBM Plex migration.
- The replacement runs against the ordinary built app for light and dark and for compact and
  comfortable density. It asserts IBM Plex Sans on `body`, IBM Plex Mono on `font-mono`,
  13 px/19.5 px compact, 14 px/21 px comfortable, and the preserved `p-2` 8 px, `gap-3` 12 px
  and `--spacing` 4 px checks.
- Removed the now-unused `baselineDirectory`/`__legacy__` Vite build and static-server path
  after `rg` confirmed H2 was its only user. The ordinary built-app Vite build, loopback
  server, path jail, M1 32-local-face test and external-font-request test are unchanged.

### P2b — explicit motion setting (`6ddf6bd`)

`packages/web/src/index.css`:

- Added the explicit reduced branch for `:root[data-motion="reduced"]`, its before/after
  pseudo-elements, descendants and descendant pseudo-elements with
  `animation: none !important` and `transition: none !important`.
- Changed the OS media branch so every selector is rooted at
  `:root:not([data-motion="full"])` (root, root pseudo-elements, descendants and descendant
  pseudo-elements). An explicit full setting is therefore not blocked by OS reduce.
- No token, raw duration, palette rule or other CSS changed.

`packages/ui/gates/u1c-css.test.mjs`:

- The fourth case now requires the explicit non-media-gated rule and exact six-selector
  coverage, and requires every OS selector to carry the full-override predicate. Both branches
  are asserted to contain only `animation: none !important` and `transition: none !important`,
  with no raw duration, infinite iteration or longhand regression.
- Before the CSS fix the same case failed first with `expected exactly one explicit
  reduced-motion rule` and then, with only the explicit branch added, with the bare
  `*, *::before, *::after` OS selectors. This is the recorded red evidence.

`packages/web/test/browser/local-fonts.spec.ts`:

- Added one built-app Chromium case covering light/dark × OS no-preference/reduce × setting
  system/reduced/full (12 combinations). It inserts temporary `.anim-spin`, `.stream-caret`,
  `.sheen` and transition probes, asserts `animationName: none`, `transitionProperty: none`
  and an empty `getAnimations({ subtree: true })` result when the setting resolves to reduced,
  and removes the probes in `finally`. It also asserts the animation names, `opacity`
  transition property and at least three running animations otherwise, with an explicit-full
  under OS-reduce positive control for both themes so the reduced checks cannot pass
  vacuously.
- This browser case has not been executed by this worker; root's Chromium run is pending.

## New tests / regression envelope

**New:** 1 Chromium test case (the 12-combination explicit/full motion matrix). The H2 browser
case was replaced and the fourth Node case was expanded; neither increases the case count. The
Node gate remains 4 cases.

**Regression envelope (executed here):** `packages/ui/gates/u1c-css.test.mjs` 4/4,
`packages/web/tsconfig.json` typecheck, and scoped ESLint/stylelint on
`packages/web/src/index.css`.

**Browser pending:** root must run the full browser gate in actual Chromium, including the
rewritten H2 and the new motion matrix. This worker did not run Playwright and does not claim a
browser pass.

## Commands (this round)

| Command | Result |
| --- | --- |
| `node -e "console.log(require.resolve('@guanxi/contract'))"` | this clone's `packages/contract/src/index.ts` |
| `nice -n 10 node --test packages/ui/gates/u1c-css.test.mjs` | 4 pass, 0 fail after the fix; the old CSS failed 1/4 as recorded above |
| `nice -n 10 npx eslint packages/web/src/index.css` | exit 0 |
| `nice -n 10 npx stylelint packages/web/src/index.css` | exit 0 |
| `nice -n 10 npx tsc --noEmit -p packages/web/tsconfig.json` | exit 0 |
| temporary-copy `eslint ... --prune-suppressions` | `packages/web/src/index.css` stays at 117 |

The committed `eslint-suppressions.json` is unchanged: the new rules use `none` keywords and
add no literal-CSS findings, so the count is verified unchanged at 117. No other allowance was
touched.

## Residuals (this round)

- Root must run the full browser gate, including the rewritten H2 and the new motion matrix,
  in actual Chromium; no browser/visual result is claimed here.
- `packages/web/src/features/workspace/WorkspaceLayout/workspace-layout.css` has a separate
  OS-only reduced-motion rule outside this finding's owned files. Inside `.workspace-layout`
  that rule can still override an explicit full setting; it was not changed.
- The prior residuals remain: 117 literal-CSS findings, the intentional 3→6 px inline focus
  radius, and `step-end` on the caret until a step timing token exists.

At handoff the fix commits are `4d37ab6` and `6ddf6bd` on top of `08b8b70`.

## Browser gate compatibility fix (2026-10-22)

The root coordinator ran the full actual-Chromium browser gate at clean `dfe5a2e`; it failed
6/86 with 80 passed. Receipt:
`/Users/yuzuru/.local/state/agent-dev/check-6m67kodz/result.json`; log:
`/Users/yuzuru/.local/state/agent-dev/check-6m67kodz/output.log`. All six failures were the same
obsolete predicate, `Number.parseFloat(...transitionDuration).toBeCloseTo(0.00001, 8)`, with
`Expected: 0.00001` and `Received: 0`. The accepted reduced-motion policy removes motion
(`transition: none !important`), so Chromium computes `transitionDuration: 0s`; these six
assertions establish no production bug and no production CSS was changed.

Updated in `092930e` (one coherent test commit):

| File | Case / observed focused control | Old line |
| --- | --- | --- |
| `packages/web/test/browser/attachments.spec.ts` | attachment flow; focused Download button | 232 |
| `packages/web/test/browser/chat-trash.spec.ts` | Trash flow; focused "Обновить статус удаления" button | 209 |
| `packages/web/test/browser/localization.spec.ts` | locale flow; focused persisted-language combobox; both schedules (`native timing`, `abort before interception`) | 234 |
| `packages/web/test/browser/quick-runs.spec.ts` | Quick Run flow; focused "Сессия" button | 255 |
| `packages/web/test/browser/recipes.spec.ts` | Recipe flow; focused snapshot-result heading | 270 |

At each control the existing probe now also captures `transitionProperty` and
`getAnimations({ subtree: true }).length`. The legacy 0.01 ms tolerance is replaced by three
stronger assertions:

- `transitionProperty` is exactly `none`;
- every comma-separated `transitionDuration` component parsed with `Number.parseFloat` is
  exactly `0`;
- `relevantAnimationCount` is exactly `0`, where the count is
  `getAnimations({ subtree: true }).length`: all relevant animations, not a
  `playState === 'running'` filter. Zero over that superset implies zero running animations.

Every forced-colour, outline, keyboard, scope, error/reload and other assertion is unchanged.
Reduced-motion coverage is not deleted and the obsolete 0.01 ms allowance is not retained.

### New tests / regression envelope

**New:** 0. Six existing cases in the five files were updated; the localization source case runs
under two schedules, which is why one source assertion produced two failures. No new test case
is claimed.

**Browser regression envelope:** 86 pending the root coordinator's actual-Chromium rerun
(6 updated, 80 unchanged). This worker cannot run Playwright and does not claim a browser pass.

### Commands (this round)

| Command | Result |
| --- | --- |
| `node -e "console.log(require.resolve('@guanxi/contract'))"` | this clone's `packages/contract/src/index.ts` |
| `nice -n 10 npx eslint packages/web/test/browser/attachments.spec.ts packages/web/test/browser/chat-trash.spec.ts packages/web/test/browser/localization.spec.ts packages/web/test/browser/quick-runs.spec.ts packages/web/test/browser/recipes.spec.ts` | exit 0 |
| `nice -n 10 npx tsc --noEmit -p packages/web/tsconfig.json` | exit 0 |

`packages/web/tsconfig.json` includes `src`, `vite.config.ts`, `dev-ports.ts` and `test/unit`,
not `test/browser`; the scoped tsc is a package regression check, and the root Chromium gate
remains the authority for these specs.

### Residuals (this round)

- Root must rerun the 86-test actual-Chromium gate; no browser, visual or performance result is
  claimed here.
- No other legacy `<= 0.00001` duration assertion was changed or newly credited. The remaining
  occurrences in `projects`, `project-presentation`, `runtime-bar`, `context-limits`,
  `capability-override`, `model-evidence`, `catalog-*`, `add-from-ollama` and
  `hugging-face-discovery` specs are outside this fix.
- The prior residuals remain unchanged: the OS-only `workspace-layout` reduced-motion rule, 117
  literal-CSS findings, the intentional 3→6 px inline focus radius and caret `step-end`.

At this handoff the test fix is `092930e` on top of `dfe5a2e`; this handoff update is the next
documentation commit. No push, merge or rebase was performed.

## Review-fix: Projects StrictMode fixture (2026-10-22)

**Source pin:** `codex/u1c-css` at `2c4a02f` before this fix; test commit `c8d509e`.
**Root red:** U1 candidate `a613f7a` in the `u1-completion` clone, full gate
`check-qj5p8r40`: 1/85 failed, 84 passed. `projects.spec.ts:105`
`expect(errorHeading).toBeFocused()` found no heading; the failure context showed the empty
Projects state instead. Receipt:
`/Users/yuzuru/.local/state/agent-dev/check-qj5p8r40/result.json`, log:
`/Users/yuzuru/.local/state/agent-dev/check-qj5p8r40/output.log`. No production file was
changed.

### Root cause and fix

The old spec read `projectMode` when each `/api/projects` GET reached the route and set
`projectMode = 'empty'` before releasing the held first response. React StrictMode can abort
the first project request before Playwright intercepts it. The surviving second request then
reached the route after the mode had already become `empty`, returned an empty list and never
produced the intended failure.

`packages/web/test/browser/projects.spec.ts` now runs the full existing scenario twice:
`native timing` and `abort before interception`, driven by
`installFetchLifecycle(page, deferNetworkStart)` as in `localization.spec.ts`. The shared
fixture observes health/runtime/models only, so the second schedule also installs a local
one-microtask deferral for `/api/projects`; this lets StrictMode cleanup cancel the first
project read before the network without changing the shared fixture.

The fixture now:

- fails every initial project GET until the explicit keyboard retry;
- releases the initial gate while the failure mode is still active;
- waits for the focused `Не удалось загрузить проекты` heading;
- switches to the empty projection immediately before `Повторить` + `Enter`;
- records the observed initial read count and asserts the retry issued exactly one read;
- separately asserts the expected one post-create reload, so the whole flow has no hidden
  project reads.

All previous scoping, keyboard, create, no-filesystem-root, 200% zoom and side-effect
assertions are preserved. The reduced-motion duration assertion is unchanged.

### New tests / regression envelope

**New:** 1 additional schedule. The existing Projects case is now two cases (native timing and
abort before interception); this is one strengthened existing scenario, not two new feature
tests.

**Browser regression envelope:** 87 pending the root coordinator's actual-Chromium run. This
worker did not run Playwright, the browser gate, build or Storybook.

### Commands (this round)

| Command | Result |
| --- | --- |
| `node -e "console.log(require.resolve('@guanxi/contract'))"` | this clone's `packages/contract/src/index.ts` |
| `nice -n 10 npx eslint packages/web/test/browser/projects.spec.ts` | exit 0 |
| `nice -n 10 npx tsc --noEmit -p packages/web/tsconfig.json` | exit 0 |
| `git diff --check` | exit 0 |

The scoped tsc does not include `test/browser`; the root Chromium gate remains the authority
for this spec.

### Residuals (this round)

- Root must run the full actual-Chromium gate; the two-schedule Projects pass is not claimed
  here.
- The shared `fetch-lifecycle.ts` fixture is intentionally unchanged and still observes only
  health/runtime/models. The project microtask deferral is local to `projects.spec.ts`.
- Route counters observe only intercepted requests; an initial read aborted before
  interception is not counted. The assertion is relative to the observed initial count, not a
  fixed StrictMode attempt count.
- The post-create reload count (+1) is asserted separately from the retry read (+1); the final
  count is initial + 2. This is the intended create-and-refresh flow, not a retry duplicate.
- The legacy `0s`/`1e-05s` reduced-motion allowance in this spec remains unchanged; it is
  outside this fixture finding.
- No production CSS/TSX, other tests, status files or approvals were edited.

The test fix is `c8d509e` on top of `2c4a02f`; this handoff update is the next documentation
commit. No push, merge or rebase was performed. Final clean pin: the HEAD documentation commit
containing this section, with `git status --porcelain` empty.
